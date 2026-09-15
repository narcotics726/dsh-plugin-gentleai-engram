import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { errorMessage, type Logger } from '../log.js';
import { assertExpectedIdentity, missingModelParts, ModelUnavailableError } from './model-dir.js';
import type { ExpectedIdentity } from './model-expected.js';
import {
  REBUILD_RUNTIME_MISSING_EXIT,
  type RecallErrorKind,
  type RecallPayload,
  type RecallQuery,
  type WorkerFrame,
} from './protocol.js';
import type { CoverageVariant } from './scoring.js';

/**
 * Host-side manager for the resident recall worker.
 *
 * Lifecycle (design D4): lazily started on the first query, reused for the life
 * of the plugin instance, reclaimed when idle. Reclaim is plugin-driven — this
 * repository has already shipped a `sweep()` with no caller once, so the timer
 * lives in `index.ts` next to the connection pool's, and `ctx.effect` guarantees
 * teardown.
 *
 * The embedding runtime is reached only through this child, never imported here:
 * `scripts/check-recall-boundary.mjs` walks the host entry's import closure and
 * fails if `onnxruntime-web` or the worker/embed modules become reachable.
 *
 * The worker is spawned detached so it becomes a process-group leader; teardown
 * kills the whole group. That is what makes "unload leaves no child behind" true
 * even while a full rebuild is running underneath.
 */

export class RecallUnavailableError extends Error {
  readonly kind: RecallErrorKind;
  constructor(kind: RecallErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'RecallUnavailableError';
  }
}

export interface RecallWorkerOptions {
  dbPath: string;
  indexPath: string;
  modelDir: string;
  threads: number;
  w: number;
  topK: number;
  coverage: CoverageVariant;
  /** Reclaim the worker after this much idle time; 0 disables reclaim. */
  idleMs: number;
  /** Per-call budget; on expiry the worker is killed and the call fails. */
  timeoutMs: number;
  log: Logger;
  /**
   * The declared identity each spawn is judged against. Defaults to the
   * repository's declaration; tests inject a matching one because their fixtures
   * are synthetic bytes. Deliberately NOT a config key: the judgement must not
   * become "whatever the user declared" (design D11).
   */
  expected?: ExpectedIdentity;
  /** Overrides for tests / diagnostics. */
  workerPath?: string;
  execPath?: string;
  rebuildThreads?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Threads for the one-shot full build: a temporary burst, not a resident cost. */
export function defaultRebuildThreads(): number {
  return Math.max(1, Math.min(16, availableParallelism()));
}

export class RecallProcessManager {
  private readonly options: RecallWorkerOptions;
  private child?: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private lastUsedAt = 0;
  private closed = false;

  constructor(options: RecallWorkerOptions) {
    this.options = options;
  }

  running(): boolean {
    return this.child !== undefined;
  }

  inFlight(): number {
    return this.pending.size;
  }

  private get workerPath(): string {
    return this.options.workerPath ?? fileURLToPath(new URL('./worker.js', import.meta.url));
  }

  private childEnv(threads: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ENGRAM_BRIDGE_DB_PATH: this.options.dbPath,
      ENGRAM_BRIDGE_INDEX_PATH: this.options.indexPath,
      ENGRAM_BRIDGE_MODEL_DIR: this.options.modelDir,
      ENGRAM_BRIDGE_THREADS: String(threads),
      ENGRAM_BRIDGE_W: String(this.options.w),
      ENGRAM_BRIDGE_TOP_K: String(this.options.topK),
      ENGRAM_BRIDGE_COVERAGE: this.options.coverage,
    };
  }

  private async start(): Promise<void> {
    if (this.closed) throw new RecallUnavailableError('internal', 'engram-bridge: 检索进程已卸载');
    if (this.child !== undefined) return;
    if (this.starting !== undefined) return await this.starting;
    this.assertUsable();
    const starting = (async (): Promise<void> => {
      const child = spawn(this.options.execPath ?? process.execPath, [this.workerPath], {
        env: this.childEnv(this.options.threads),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // process-group leader: teardown kills the whole subtree
      });
      this.child = child;
      child.on('error', (error) => {
        this.options.log.error(`检索子进程启动失败：${errorMessage(error)}`);
        this.failAll(new RecallUnavailableError('internal', `检索子进程启动失败：${errorMessage(error)}`));
        this.child = undefined;
      });
      child.on('exit', (code, signal) => {
        this.child = undefined;
        const reason = `检索子进程退出（code=${String(code)} signal=${String(signal)}）`;
        if (this.pending.size > 0) {
          this.options.log.warn(reason);
          this.failAll(new RecallUnavailableError('internal', reason));
        }
      });
      const stdout = createInterface({ input: child.stdout! });
      stdout.on('line', (line) => this.onFrame(line));
      createInterface({ input: child.stderr! }).on('line', (line) => {
        if (line.trim() !== '') this.options.log.warn(`检索子进程：${line}`);
      });
      // Do not wait for the `ready` frame: the first request is already queued on
      // stdin, and the worker reads stdin only after it announces itself.
      await new Promise<void>((resolve) => {
        child.once('spawn', () => resolve());
      });
    })();
    this.starting = starting.finally(() => {
      this.starting = undefined;
    });
    return await starting;
  }

  private onFrame(line: string): void {
    const text = line.trim();
    if (text === '') return;
    let frame: WorkerFrame;
    try {
      frame = JSON.parse(text) as WorkerFrame;
    } catch {
      this.options.log.warn(`检索子进程输出了无法解析的一行：${text.slice(0, 200)}`);
      return;
    }
    if (frame.type === 'log') {
      const write = this.options.log[frame.level] ?? this.options.log.info;
      write.call(this.options.log, frame.message);
      return;
    }
    if (frame.type === 'ready') {
      this.options.log.debug(
        `检索子进程就绪 pid=${frame.pid} 线程=${frame.threads} 模型目录=${frame.modelDir}`,
      );
      return;
    }
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new RecallUnavailableError(frame.error.kind, frame.error.message));
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private async request<T>(payload: Record<string, unknown>): Promise<T> {
    await this.start();
    const child = this.child;
    if (child?.stdin === null || child?.stdin === undefined) {
      throw new RecallUnavailableError('internal', 'engram-bridge: 检索子进程没有可写的 stdin');
    }
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RecallUnavailableError(
            'timeout',
            `engram-bridge: 检索调用超过 ${this.options.timeoutMs}ms 未返回，已终止检索子进程。` +
              '首次检索可能需要建立索引；可提高 searchTimeoutMs。',
          ),
        );
        void this.stop('timeout');
      }, this.options.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    this.lastUsedAt = Date.now();
    try {
      return (await result) as T;
    } finally {
      this.lastUsedAt = Date.now();
    }
  }

  /**
   * The loud, early check for an incomplete installation.
   *
   * It runs BEFORE anything is spawned, so a missing runtime fails at the call
   * point with an actionable message instead of surfacing as a mysterious child
   * exit. It also fixes the precedence the spec asks for: when the derived data
   * is missing AND the runtime is missing, the reported failure is the runtime.
   * `model-dir.ts` is pure `node:fs`/`node:path`, so importing it here does not
   * weaken the host-entry boundary.
   *
   * Presence only, and on purpose (design D1): this runs on EVERY call — it is
   * the cheap guard that keeps a swept-away installation from becoming a
   * confusing child exit — so it must never hash anything. The identity
   * judgement is a different check with a different frequency
   * (`assertUsable`, before each spawn).
   */
  assertInstalled(): void {
    const missing = missingModelParts(this.options.modelDir);
    if (missing.length > 0) {
      throw new RecallUnavailableError(
        'runtime-missing',
        new ModelUnavailableError(
          this.options.modelDir,
          missing.map((part) => ({ kind: 'missing' as const, path: part.path, what: part.what })),
        ).message,
      );
    }
  }

  /**
   * Judge the installation against the declared identity, before spawning.
   *
   * Placement is load-bearing (design D1). It sits after `start()`'s three
   * early-return guards and before the async body on purpose:
   *
   * - before the guards it would re-hash ~110 MB on every `query()`;
   * - inside the async body the rejection would land on the derived
   *   `starting` promise, which no caller handles, and the host's fail-loud
   *   `unhandledRejection` hook would exit(1) — turning "a 110 MB artifact is
   *   wrong" into "dsh is dead" (design D4).
   *
   * Failing here spawns nothing and caches nothing, which is what makes the
   * next call recover once the cause is gone.
   */
  private assertUsable(): void {
    try {
      assertExpectedIdentity(this.options.modelDir, this.options.expected);
    } catch (error) {
      throw new RecallUnavailableError('runtime-missing', errorMessage(error));
    }
  }

  /** One retrieval. Throws `RecallUnavailableError` with a stable `kind`. */
  async query(query: RecallQuery): Promise<RecallPayload> {
    this.assertInstalled();
    try {
      return await this.request<RecallPayload>({ cmd: 'query', query });
    } catch (error) {
      // The index cannot be trusted: build it once in a temporary high-thread
      // process, restart the worker onto the fresh index, and retry once. Losing
      // the model to a missing installation surfaces from the rebuild instead.
      if (error instanceof RecallUnavailableError && error.kind === 'rebuild-needed') {
        await this.rebuild();
        return await this.request<RecallPayload>({ cmd: 'query', query });
      }
      throw error;
    }
  }

  /** One-shot full build in a separate, short-lived, high-thread process. */
  async rebuild(): Promise<void> {
    const threads = this.options.rebuildThreads ?? defaultRebuildThreads();
    this.options.log.info(`开始全量重建派生索引（${threads} 线程，用后即退）`);
    await this.stop('rebuild');
    this.assertUsable();
    let output = '';
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        this.options.execPath ?? process.execPath,
        [this.workerPath, '--rebuild'],
        { env: this.childEnv(threads), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (exitCode) => resolve(exitCode ?? 1));
      // A full build is bounded by the same per-call budget; the caller sees it.
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, this.options.timeoutMs);
      child.on('exit', () => clearTimeout(timer));
    });
    const summary = output.trim().split('\n').filter((line: string) => line !== '').join(' | ');
    if (code !== 0) {
      this.options.log.error(`全量重建失败（exit=${code}）：${summary}`);
      // A model/runtime failure is reported as such, not as a generic rebuild
      // failure: the spec keeps the two apart, and only the child can tell
      // (design D7).
      throw new RecallUnavailableError(
        code === REBUILD_RUNTIME_MISSING_EXIT ? 'runtime-missing' : 'internal',
        `engram-bridge: 全量重建派生索引失败。${summary}`,
      );
    }
    this.options.log.info(`全量重建完成：${summary}`);
  }

  /**
   * Reclaim the worker when it has been idle. Never reclaims while a call is in
   * flight: those callers are waiting on this exact process.
   */
  sweep(now = Date.now()): number {
    if (this.child === undefined) return 0;
    if (this.pending.size > 0) return 0;
    if (this.options.idleMs <= 0) return 0;
    if (now - this.lastUsedAt < this.options.idleMs) return 0;
    void this.stop('idle');
    return 1;
  }

  /** Stop the worker and everything it spawned. Safe to call repeatedly. */
  async stop(reason: string): Promise<void> {
    if (this.stopping !== undefined) return await this.stopping;
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    const stopping = (async (): Promise<void> => {
      this.failAll(new RecallUnavailableError('internal', `检索子进程已停止（${reason}）`));
      try {
        child.stdin?.end();
      } catch {
        /* the pipe may already be closed */
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.once('exit', finish);
        const timer = setTimeout(() => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
          finish();
        }, 2000);
        // Deliberately NOT unref'd: we are awaiting this timer, so unref'ing it
        // would let the process exit with the teardown promise still pending —
        // and a child that ignores the closed stdin would then survive us.
      });
      this.options.log.debug(`检索子进程已停止（${reason}）`);
    })();
    this.stopping = stopping.finally(() => {
      this.stopping = undefined;
    });
    return await stopping;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.stop('dispose');
  }
}
