import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Cross-process lock for one derived index.
 *
 * WHY THIS EXISTS: every writer of the derived index (the resident worker's
 * inline sync and each one-shot child) must be the only writer at a time, and
 * the judgement has to survive a holder that is killed rather than released.
 * The protocol is `design.md` D6; the parts that are easy to get wrong are
 * called out at their implementation site:
 *
 *  * the fd stays open for the heartbeat (closing it would leave the heartbeat
 *    with only "write by path", which clobbers a lock that has been stolen);
 *  * the heartbeat writes at position 0 explicitly (`ftruncate` does NOT reset
 *    the offset, so a naive ftruncate+write leaves `"\0…" + JSON` behind, which
 *    is permanently unparseable and would make every reader judge the live
 *    holder stale);
 *  * ownership is confirmed by re-reading the PATH, never the fd (an fd keeps
 *    matching its own inode after the lock was renamed away);
 *  * staleness by clock is only meaningful on one host, so those criteria are
 *    host-gated (a network-mounted index directory is out of scope).
 */

/** How long a holder may show no progress before another writer may take over. */
export const STALE_WINDOW_MS = 5 * 60_000;
/** Slack on top of the window: heartbeat latency and reader scheduling jitter. */
export const STALE_MARGIN_MS = 30_000;
/** A lock file that cannot be parsed is only stale once it is this old. */
const UNREADABLE_FLOOR_MS = 2_000;
/** Clock skew smaller than this is not treated as a backwards jump. */
const CLOCK_SKEW_EPSILON_MS = 5_000;

export interface IndexLockOptions {
  /** How long this caller waits for the lock before giving up. */
  waitMs: number;
  /** Tests only: clock. */
  now?: () => number;
  /** Tests only: host identity. */
  host?: string;
  /** Tests only: poll interval. */
  pollMs?: number;
}

export interface HeldIndexLock {
  /** Prove progress and keep the lock; throws `LockBusyError` if it is gone. */
  heartbeat(): void;
  /** Whether this process still owns the file at the path right now. */
  stillHeld(): boolean;
  release(): void;
}

/** The lock is held by somebody else (or was taken away from us). */
export class LockBusyError extends Error {
  readonly kind = 'busy';
  constructor(message: string) {
    super(message);
    this.name = 'LockBusyError';
  }
}

interface LockRecord {
  pid: number;
  host: string;
  lastProgressAt: number;
  staleAfterMs: number;
  token: string;
}

export function indexPathLockPath(indexPath: string): string {
  return `${indexPath}.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists, owned by somebody else" — alive for our purposes.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readRecord(path: string): LockRecord | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.lastProgressAt === 'number' &&
      typeof parsed.staleAfterMs === 'number' &&
      typeof parsed.token === 'string'
    ) {
      return parsed as LockRecord;
    }
  } catch {
    /* fall through: unparseable */
  }
  return null;
}

/** True when the record (or an unreadable file) may be taken over. */
function isStale(path: string, record: LockRecord | null, now: number, host: string): boolean {
  if (record === null) {
    try {
      return now - statSync(path).mtimeMs > UNREADABLE_FLOOR_MS;
    } catch {
      return true; // it vanished: retry
    }
  }
  // Cross-host: neither pid nor wall clock is comparable, so we never steal on
  // those grounds (the index directory is local derived state; see design D6).
  if (record.host !== host) return false;
  if (!pidAlive(record.pid)) return true;
  if (now < record.lastProgressAt - CLOCK_SKEW_EPSILON_MS) return true;
  return now - record.lastProgressAt > record.staleAfterMs + STALE_MARGIN_MS;
}

/** Atomic takeover: rename first (only one racer can win), then drop it. */
function steal(path: string, token: string): void {
  const parked = `${path}.stale.${token}`;
  try {
    renameSync(path, parked);
  } catch {
    return; // somebody else already took it; the caller retries
  }
  try {
    unlinkSync(parked);
  } catch {
    /* best effort */
  }
}

function heldLock(path: string, fd: number, token: string, now: () => number, host: string, staleAfterMs: number): HeldIndexLock {
  let released = false;
  return {
    heartbeat(): void {
      if (released) return;
      const json = JSON.stringify({
        pid: process.pid,
        host,
        lastProgressAt: now(),
        staleAfterMs,
        token,
      } satisfies LockRecord);
      ftruncateSync(fd, 0);
      // Position 0 explicitly: ftruncate does not move the offset.
      writeSync(fd, json, 0, 'utf8');
      ftruncateSync(fd, Buffer.byteLength(json, 'utf8'));
      const back = readRecord(path);
      if (back === null || back.token !== token) {
        throw new LockBusyError('engram-bridge: 索引锁已被别人接管，本次写入放弃');
      }
    },
    stillHeld(): boolean {
      try {
        const mine = fstatSync(fd);
        const current = statSync(path);
        if (mine.dev !== current.dev || mine.ino !== current.ino) return false;
        return readRecord(path)?.token === token;
      } catch {
        return false;
      }
    },
    release(): void {
      if (released) return;
      released = true;
      try {
        if (readRecord(path)?.token === token) unlinkSync(path);
      } catch {
        /* the lock may already be gone */
      }
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Acquire the lock for `indexPath`, waiting at most `options.waitMs`.
 * Throws `LockBusyError` when somebody else holds it for the whole wait.
 */
export async function acquireIndexLock(indexPath: string, options: IndexLockOptions): Promise<HeldIndexLock> {
  const path = indexPathLockPath(indexPath);
  // The index directory may not exist yet (first run), and the lock lives next
  // to the index it guards.
  mkdirSync(dirname(path), { recursive: true });
  const now = options.now ?? Date.now;
  const host = options.host ?? hostname();
  const pollMs = options.pollMs ?? 200;
  const deadline = now() + Math.max(0, options.waitMs);
  const token = randomUUID();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      const json = JSON.stringify({
        pid: process.pid,
        host,
        lastProgressAt: now(),
        staleAfterMs: STALE_WINDOW_MS,
        token,
      } satisfies LockRecord);
      writeSync(fd, json, 0, 'utf8');
      // Confirm by PATH: an fd keeps matching its own inode after a rename.
      if (readRecord(path)?.token === token) {
        return heldLock(path, fd, token, now, host, STALE_WINDOW_MS);
      }
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already gone */
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const record = readRecord(path);
    if (isStale(path, record, now(), host)) {
      steal(path, token);
      continue;
    }
    if (now() >= deadline) {
      const progress = record === null ? '未知' : new Date(record.lastProgressAt).toISOString();
      throw new LockBusyError(
        `engram-bridge: 索引正在被另一个进程更新（等待 ${options.waitMs}ms 后仍被占用，` +
          `持有者最近进展 ${progress}）。本次调用没有改动任何派生数据。`,
      );
    }
    await delay(pollMs);
  }
}
