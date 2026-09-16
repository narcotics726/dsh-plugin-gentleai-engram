import assert from 'node:assert/strict';
import { fstatSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  acquireIndexLock,
  LockBusyError,
  STALE_MARGIN_MS,
  STALE_WINDOW_MS,
} from '../dist/recall/index-lock.js';
import { removeDir, tempDir } from './recall-support.ts';

/**
 * The cross-process write lock (design D6).
 *
 * The cases below are the ones that make the difference between a lock and a
 * decoration: a takeover that races, a holder that was killed, a lock file that
 * was deleted out from under the holder, and a live long run that must NOT be
 * mistaken for a dead one.
 */

function lockPathOf(dir: string): string {
  return join(dir, 'index.db.lock');
}

function recordOf(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(lockPathOf(dir), 'utf8')) as Record<string, unknown>;
}

function writeRecord(dir: string, record: Record<string, unknown>): void {
  writeFileSync(lockPathOf(dir), JSON.stringify(record));
}

const FRESH = { pollMs: 5 };

test('并发获取只有一个成功，另一个在等待窗口耗尽后报 busy', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    const first = await acquireIndexLock(indexPath, { waitMs: 50, ...FRESH });
    await assert.rejects(
      () => acquireIndexLock(indexPath, { waitMs: 60, ...FRESH }),
      (error: unknown) => error instanceof LockBusyError && error.kind === 'busy',
      '第二个获取者在窗口内等不到，必须以 busy 失败而不是拿到锁',
    );
    first.release();
    const second = await acquireIndexLock(indexPath, { waitMs: 50, ...FRESH });
    second.release();
  } finally {
    removeDir(dir);
  }
});

test('持有者已死（pid 不存在）时立即可接管，不必等窗口', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    writeRecord(dir, {
      pid: 2 ** 30, // certainly not a live pid
      host: hostname(),
      lastProgressAt: Date.now(),
      staleAfterMs: STALE_WINDOW_MS,
      token: 'dead-holder',
    });
    const lock = await acquireIndexLock(indexPath, { waitMs: 50, ...FRESH });
    assert.equal(recordOf(dir).token !== 'dead-holder', true, '接管后锁的主人是新持有者');
    lock.release();
  } finally {
    removeDir(dir);
  }
});

test('活着但太久没有进展证明的持有者会被接管；恰好超窗口但在余量内则不会', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    const base = { pid: process.pid, host: hostname(), staleAfterMs: STALE_WINDOW_MS, token: 'slow' };
    // An ADVANCING clock: a constant one would never reach the wait deadline
    // (the lock polls until `now() >= deadline`).
    let t = 1_000_000;
    const now = (): number => (t += 5);

    // Within the margin: still considered alive-and-working.
    t = 1_000_000;
    writeRecord(dir, { ...base, lastProgressAt: t - STALE_WINDOW_MS + STALE_MARGIN_MS / 2 });
    await assert.rejects(
      () => acquireIndexLock(indexPath, { waitMs: 30, pollMs: 1, now }),
      (error: unknown) => error instanceof LockBusyError,
      '超窗口但仍在余量内不得被偷',
    );

    // Beyond the margin: take over (the holder never proves progress again).
    t = 1_000_000;
    writeRecord(dir, { ...base, lastProgressAt: t - STALE_WINDOW_MS - STALE_MARGIN_MS - 1 });
    const lock = await acquireIndexLock(indexPath, { waitMs: 30, pollMs: 1, now });
    lock.release();
  } finally {
    removeDir(dir);
  }
});

test('记录时间在未来（时钟回拨）时按陈旧接管，但 host 不一致时不得因钟表判陈旧', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    let t = 1_000_000;
    const now = (): number => (t += 5);

    writeRecord(dir, {
      pid: process.pid,
      host: hostname(),
      lastProgressAt: t + 60_000,
      staleAfterMs: STALE_WINDOW_MS,
      token: 'future',
    });
    const lock = await acquireIndexLock(indexPath, { waitMs: 50, pollMs: 1, now });
    lock.release();

    // A different host: wall clocks are not comparable, so no clock-based steal.
    writeRecord(dir, {
      pid: process.pid,
      host: 'another-host',
      lastProgressAt: t + 60_000,
      staleAfterMs: STALE_WINDOW_MS,
      token: 'cross-host',
    });
    await assert.rejects(
      () => acquireIndexLock(indexPath, { waitMs: 30, pollMs: 1, now }),
      (error: unknown) => error instanceof LockBusyError,
      '跨机时不得因钟表差偷锁',
    );
  } finally {
    removeDir(dir);
  }
});

test('读不出的锁文件只有比下限更老才算陈旧（刚建好/正在心跳不算）', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    writeFileSync(lockPathOf(dir), '');
    await assert.rejects(
      () => acquireIndexLock(indexPath, { waitMs: 30, pollMs: 5 }),
      (error: unknown) => error instanceof LockBusyError,
      '刚建好还没写完的锁不得被判陈旧',
    );
  } finally {
    removeDir(dir);
  }
});

test('心跳之后锁文件仍可解析、token 仍是自己的、(dev, ino) 不变', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    const lock = await acquireIndexLock(indexPath, { waitMs: 50, ...FRESH });
    const before = statSync(lockPathOf(dir));
    const token = recordOf(dir).token;
    for (let i = 0; i < 3; i++) lock.heartbeat();
    const after = statSync(lockPathOf(dir));
    // The POSIX trap: ftruncate does not reset the offset, so a naive
    // truncate+write leaves "\0…" + JSON behind and JSON.parse fails forever.
    const parsed = recordOf(dir);
    assert.equal(parsed.token, token);
    assert.equal(typeof parsed.lastProgressAt, 'number');
    assert.equal(before.ino, after.ino, '心跳不得换 inode（否则持有者会判自己丢了锁）');
    assert.equal(after.size, JSON.stringify(parsed).length, '心跳后文件里不得留下垃圾字节');
    lock.release();
  } finally {
    removeDir(dir);
  }
});

test('持续心跳的持有者跨过多个窗口仍不被接管', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    let clock = 1_000_000;
    const now = (): number => clock;
    const lock = await acquireIndexLock(indexPath, { waitMs: 30, pollMs: 1, now });
    for (let i = 0; i < 4; i++) {
      clock += STALE_WINDOW_MS + STALE_MARGIN_MS - 1;
      lock.heartbeat();
      // The probe uses an advancing clock so its wait can expire.
      let probe = clock;
      const probeNow = (): number => (probe += 5);
      await assert.rejects(
        () => acquireIndexLock(indexPath, { waitMs: 20, pollMs: 1, now: probeNow }),
        (error: unknown) => error instanceof LockBusyError,
        `第 ${i + 1} 次心跳之后仍应被视为活着`,
      );
    }
    lock.release();
  } finally {
    removeDir(dir);
  }
});

test('锁文件被删掉或换成别人的 token 后，复核必须判自己不再持有', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    const lock = await acquireIndexLock(indexPath, { waitMs: 50, ...FRESH });
    assert.equal(lock.stillHeld(), true);

    // Replaced by somebody else: fstat(fd) would still match its own inode, so
    // the check has to go through the PATH.
    writeRecord(dir, {
      pid: process.pid,
      host: hostname(),
      lastProgressAt: Date.now(),
      staleAfterMs: STALE_WINDOW_MS,
      token: 'someone-else',
    });
    assert.equal(lock.stillHeld(), false, '换成别人的 token 后必须判自己不持有');

    unlinkSync(lockPathOf(dir));
    assert.equal(lock.stillHeld(), false, '锁文件被删后必须判自己不持有');

    // Releasing must not delete a lock that is no longer ours.
    writeRecord(dir, {
      pid: process.pid,
      host: hostname(),
      lastProgressAt: Date.now(),
      staleAfterMs: STALE_WINDOW_MS,
      token: 'third-party',
    });
    lock.release();
    assert.equal(recordOf(dir).token, 'third-party', '释放不得删掉别人的锁');
  } finally {
    removeDir(dir);
  }
});

test('心跳时锁已被偷走：不得按路径覆盖偷锁者的文件，且自检要报错', async () => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    const lock = await acquireIndexLock(indexPath, { waitMs: 50, ...FRESH });
    unlinkSync(lockPathOf(dir));
    writeRecord(dir, {
      pid: process.pid,
      host: hostname(),
      lastProgressAt: Date.now(),
      staleAfterMs: STALE_WINDOW_MS,
      token: 'thief',
    });
    assert.throws(
      () => lock.heartbeat(),
      (error: unknown) => error instanceof LockBusyError,
      '自检发现 token 不是自己时必须报错，而不是把偷锁者的文件截断',
    );
    assert.equal(recordOf(dir).token, 'thief', '偷锁者的记录必须原样活着');
    lock.release();
  } finally {
    removeDir(dir);
  }
});

test('释放之后不泄漏 fd（常驻每次同步拿一次锁）', async (t) => {
  const dir = tempDir('recall-lock-');
  try {
    const indexPath = join(dir, 'index.db');
    const fdDir = '/proc/self/fd';
    let count = (): number => {
      try {
        return readdirSync(fdDir).length;
      } catch {
        return -1;
      }
    };
    if (count() < 0) {
      t.skip('没有 /proc/self/fd，跳过 fd 泄漏检查');
      return;
    }
    const before = count();
    for (let i = 0; i < 5; i++) {
      const lock = await acquireIndexLock(indexPath, { waitMs: 50, ...FRESH });
      lock.heartbeat();
      lock.release();
    }
    assert.equal(count(), before, '获取/释放一轮不得留下 fd');
    // Sanity: the path is clean, so the next acquire still works.
    const again = await acquireIndexLock(indexPath, { waitMs: 50, ...FRESH });
    again.release();
  } finally {
    removeDir(dir);
  }
});
