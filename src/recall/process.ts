import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { errorMessage, type Logger } from '../log.js';
import { assertExpectedIdentity, missingModelParts, ModelUnavailableError } from './model-dir.js';
import type { ExpectedIdentity } from './model-expected.js';
import {
  COMMAND_NAME,
  ONESHOT_BACKLOG_EXIT,
  ONESHOT_RUNTIME_MISSING_EXIT,
  type OneShotSummary,
  type RecallDeferral,
  type RecallErrorKind,
  type RecallPayload,
  type RecallQuery,
  type WorkerErrorInfo,
  type WorkerFrame,
} from './protocol.js';
import { RECALL_SYNC_TOOL_NAME } from '../recall-tool.js';
import type { CoverageVariant } from './scoring.js';

/**
 * Host-side manager for the recall worker and for the one-shot children.
 *
 * The rule this file implements (design D1/D4/D7):
 *
 *   Δ = source − derived index  →  resident does it if Δ fits `residentCapacity`
 *                              →  otherwise REFUSE, naming the model-facing
 *                                 entry, its per-call limit and an estimate
 *                              →  the operator request is the only uncapped path
 *
 * There used to be an automatic hand-off to a one-shot child. It is gone on
 * purpose: it silently spent 8–51 s inside a turn and restarted two processes,
 * which is exactly the latency the budget exists to avoid. Waiting is now an
 * explicit choice, and the refusal carries everything the chooser needs.
 *
 * Concurrency (design D6/D7): every writer takes the index lock in its own
 * process; the host only decides WHO writes. Before a one-shot runs, the
 * resident is stopped and `start()` is gated, so no query can open an index
 * that is being rewritten.
 *
 * The embedding runtime is reached only through children, never imported here:
 * `scripts/check-recall-boundary.mjs` walks the host entry's import closure and
 * fails if `onnxruntime-web` or the worker/embed/lock modules become reachable.
 */

export class RecallUnavailableError extends Error {
  readonly kind: RecallErrorKind;
  /** Present when `kind === 'sync-needed'` (a refusal that names the work). */
  readonly deferral?: RecallDeferral;
  constructor(kind: RecallErrorKind, message: string, deferral?: RecallDeferral) {
    super(message);
    this.kind = kind;
    this.deferral = deferral;
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
  /** Per-call budget for the resident; on expiry the worker is killed. */
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
  /** Tests only: replace the per-thread cost used to derive the capacities. */
  embedMsPerDocPerThread?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Conservative per-thread embedding cost, in milliseconds per document.
 *
 * Worst measured point over four (platform × parallelism) readings, rounded up
 * to 100, times a safety factor that covers model load, index build, snapshot
 * and jitter (design D4). One constant for every path: a constant that is not
 * optimistic anywhere does not need to know which machine it is on — which is
 * exactly the lesson `MAX_INLINE_SYNC_DOCS` taught.
 */
export const MS_PER_DOC_PER_THREAD = 1300;

/** Declared budget of the model-facing explicit entry (design D7). */
export const ONESHOT_TIMEOUT_MS = 600_000;
/** Slack on that budget, covering identity judgement, spawn and teardown. */
export const ONESHOT_MARGIN_MS = 15_000;
/** How long a resident call waits for the index lock before refusing. */
export const LOCK_WAIT_AUTO_MS = 2_000;
/** How long the operator request waits before reporting a collision. */
export const LOCK_WAIT_OPERATOR_MS = 5_000;
/** A resident call's whole budget is ~60 s: never wait that long on SQLite. */
export const BUSY_TIMEOUT_RESIDENT_MS = 3_000;
export const BUSY_TIMEOUT_ONESHOT_MS = 60_000;

/**
 * Documents a path may embed inside `budgetMs`.
 *
 * The thread term is clamped to the measured range: parallelism is sub-linear
 * (16 threads buy 8.6×), so extrapolating beyond 16 is optimistic — the one
 * direction that would bring the livelock back (design D4).
 */
export function embedCapacity(budgetMs: number, threads: number, msPerDocPerThread = MS_PER_DOC_PER_THREAD): number {
  const clamped = Math.max(1, Math.min(16, Math.floor(threads)));
  return Math.max(0, Math.floor((budgetMs * clamped) / msPerDocPerThread));
}

/** Threads for a one-shot child: a temporary burst, not a resident cost. */
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
  /**
   * One-shot children, tracked as a SET: with two concurrent entries a single
   * field would be overwritten by the later one and cleared by the earlier
   * one's `finally`, leaving a running child unreachable from stop()/dispose().
   */
  private readonly oneShotChildren = new Set<ChildProcess>();
  /** >0 while a one-shot runs: `start()` must not bring the resident back. */
  private oneShotDepth = 0;
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

  /** Documents a resident call may handle on its own (design D4). */
  residentCapacity(): number {
    return embedCapacity(this.options.timeoutMs, this.options.threads, this.msPerDoc());
  }

  /** Documents the model-facing explicit entry may handle in one call. */
  childCapacity(): number {
    return embedCapacity(
      ONESHOT_TIMEOUT_MS - ONESHOT_MARGIN_MS,
      this.oneShotThreads(),
      this.msPerDoc(),
    );
  }

  private msPerDoc(): number {
    return this.options.embedMsPerDocPerThread ?? MS_PER_DOC_PER_THREAD;
  }

  private oneShotThreads(): number {
    return this.options.rebuildThreads ?? defaultRebuildThreads();
  }

  private get workerPath(): string {
    return this.options.workerPath ?? fileURLToPath(new URL('./worker.js', import.meta.url));
  }

  private childEnv(
    threads: number,
    maxDocs: number | 'unlimited',
    lockWaitMs: number,
    busyTimeoutMs: number,
  ): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ENGRAM_BRIDGE_DB_PATH: this.options.dbPath,
      ENGRAM_BRIDGE_INDEX_PATH: this.options.indexPath,
      ENGRAM_BRIDGE_MODEL_DIR: this.options.modelDir,
      ENGRAM_BRIDGE_THREADS: String(threads),
      ENGRAM_BRIDGE_W: String(this.options.w),
      ENGRAM_BRIDGE_TOP_K: String(this.options.topK),
      ENGRAM_BRIDGE_COVERAGE: this.options.coverage,
      ENGRAM_BRIDGE_MAX_DOCS: String(maxDocs),
      ENGRAM_BRIDGE_LOCK_WAIT_MS: String(lockWaitMs),
      ENGRAM_BRIDGE_BUSY_TIMEOUT_MS: String(busyTimeoutMs),
    };
  }

  private residentEnv(): NodeJS.ProcessEnv {
    return this.childEnv(
      this.options.threads,
      this.residentCapacity(),
      LOCK_WAIT_AUTO_MS,
      BUSY_TIMEOUT_RESIDENT_MS,
    );
  }

  private async start(): Promise<void> {
    if (this.closed) throw new RecallUnavailableError('internal', 'engram-bridge: 检索进程已卸载');
    // A one-shot is rewriting the index: bringing the resident back now would
    // open a file that is being replaced. Checked in the SYNCHRONOUS section on
    // purpose — a throw inside the async body below would land on a derived
    // promise nobody awaits, and the host's fail-loud unhandledRejection hook
    // would exit(1) (the same trap `assertUsable()` is placed to avoid).
    if (this.oneShotDepth > 0) {
      throw new RecallUnavailableError(
        'busy',
        `engram-bridge: 索引正在被另一个进程更新（等待 ${LOCK_WAIT_AUTO_MS}ms 后仍被占用）。` +
          '本次调用没有改动任何派生数据。',
      );
    }
    if (this.child !== undefined) return;
    if (this.starting !== undefined) return await this.starting;
    this.assertUsable();
    const starting = (async (): Promise<void> => {
      const child = spawn(this.options.execPath ?? process.execPath, [this.workerPath], {
        env: this.residentEnv(),
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
    else pending.reject(this.fromWorkerError(frame.error));
  }

  private fromWorkerError(error: WorkerErrorInfo): RecallUnavailableError {
    return new RecallUnavailableError(error.kind, error.message, error.deferral);
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
              '可提高 searchTimeoutMs。',
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
      if (error instanceof RecallUnavailableError && error.kind === 'sync-needed') {
        throw this.refusal(error.deferral);
      }
      throw error;
    }
  }

  /**
   * The model-facing explicit entry: one capped catch-up, in a short-lived
   * high-thread child. Callers decide to spend the wait; the cap is the tool's
   * own declared budget (design D7). Returns the child's own summary line.
   */
  async catchUp(): Promise<string> {
    this.assertInstalled();
    return await this.runOneShot({
      mode: 'sync',
      threads: this.oneShotThreads(),
      maxDocs: this.childCapacity(),
      timeoutMs: ONESHOT_TIMEOUT_MS,
      lockWaitMs: Math.floor((ONESHOT_TIMEOUT_MS - ONESHOT_MARGIN_MS) / 2),
      busyTimeoutMs: BUSY_TIMEOUT_ONESHOT_MS,
    });
  }

  /**
   * The operator request: same manager, same one-shot path, but genuinely
   * uncapped — no kill timer and an explicit `unlimited` cap, so the only stops
   * are the caller's cancellation and plugin teardown (design D8).
   */
  async syncUnbounded(signal?: AbortSignal): Promise<string> {
    this.assertInstalled();
    return await this.runOneShot({
      mode: 'sync',
      threads: this.oneShotThreads(),
      maxDocs: 'unlimited',
      timeoutMs: undefined,
      lockWaitMs: LOCK_WAIT_OPERATOR_MS,
      busyTimeoutMs: BUSY_TIMEOUT_ONESHOT_MS,
      signal,
    });
  }

  /** Forced full rebuild through the same governed path (diagnostics). */
  async rebuild(): Promise<string> {
    this.assertInstalled();
    return await this.runOneShot({
      mode: 'rebuild',
      threads: this.oneShotThreads(),
      maxDocs: this.childCapacity(),
      timeoutMs: ONESHOT_TIMEOUT_MS,
      lockWaitMs: LOCK_WAIT_AUTO_MS,
      busyTimeoutMs: BUSY_TIMEOUT_ONESHOT_MS,
    });
  }

  /**
   * The refusal for work this call declined. Two shapes, because there are two
   * remaining answers: the model-facing entry can still do it, or only the
   * operator can.
   */
  private refusal(deferral: RecallDeferral | undefined): RecallUnavailableError {
    const inline = this.residentCapacity();
    if (deferral === undefined) {
      return new RecallUnavailableError(
        'backlog',
        `engram-bridge: 本次检索超出常规检索能自动处理的工作量（上限 ${inline} 条），` +
          '派生数据没有被改动，已完成的部分没有写回。请重发本次检索，或先调用显式入口。',
      );
    }
    const estimate = this.estimateSeconds(deferral.pendingDocs, this.oneShotThreads());
    if (deferral.pendingDocs > this.childCapacity()) {
      return new RecallUnavailableError(
        'backlog',
        `engram-bridge: 待处理 ${deferral.pendingDocs} 条，超常规检索的自动上限（${inline} 条），` +
          `也超出显式入口单次能完成的量（${this.childCapacity()} 条）。` +
          `派生数据没有被改动。剩下的办法是让操作者运行 /${COMMAND_NAME}（不受单次预算约束），` +
          '或提高 searchTimeoutMs 后重新加载插件。',
        deferral,
      );
    }
    return new RecallUnavailableError(
      'backlog',
      `engram-bridge: 待处理 ${deferral.pendingDocs} 条，超常规检索的自动上限（${inline} 条）。` +
        `派生数据没有被改动。可调用 ${RECALL_SYNC_TOOL_NAME} 一次完成（预计约 ${estimate} 秒），` +
        '完成后请重发本次检索；提高 searchTimeoutMs 只会改变自动处理量。',
      deferral,
    );
  }

  /** Conservative wall-clock estimate for `docs` on `threads`. */
  private estimateSeconds(docs: number, threads: number): number {
    const capped = Math.max(1, Math.min(16, Math.floor(threads)));
    return Math.ceil((docs * this.msPerDoc()) / capped / 1000);
  }

  /**
   * Run one one-shot child: gated resident, tracked process group, optional
   * kill timer, optional cancellation. Returns whatever the child printed.
   */
  private async runOneShot(options: {
    mode: 'sync' | 'rebuild';
    threads: number;
    maxDocs: number | 'unlimited';
    timeoutMs: number | undefined;
    lockWaitMs: number;
    busyTimeoutMs: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const signal = options.signal;
    // A closure, not a narrowed property read: `aborted` is declared readonly,
    // so TypeScript would otherwise keep the first check's narrowing across the
    // awaits below (the signal can abort at any point in between).
    const cancelled = (): boolean => signal?.aborted === true;
    if (cancelled()) {
      throw new RecallUnavailableError('cancelled', 'engram-bridge: 本次更新已被发起者取消');
    }
    // The gate goes up BEFORE stopping the resident, and the counter lets two
    // concurrent entries wait for each other instead of dropping the gate early.
    this.oneShotDepth++;
    try {
      await this.stop('one-shot', 'busy');
      this.assertUsable();
      let output = '';
      const code = await new Promise<number>((resolve, reject) => {
        const args = [this.workerPath, options.mode === 'rebuild' ? '--rebuild' : '--sync'];
        const child = spawn(this.options.execPath ?? process.execPath, args, {
          env: this.childEnv(options.threads, options.maxDocs, options.lockWaitMs, options.busyTimeoutMs),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        this.oneShotChildren.add(child);
        const collect = (chunk: Buffer): void => {
          output += chunk.toString('utf8');
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        const kill = (): void => {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }
        };
        const onAbort = (): void => {
          kill();
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(kill, options.timeoutMs);
        child.on('error', (error) => {
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          this.oneShotChildren.delete(child);
          reject(
            new RecallUnavailableError('internal', `engram-bridge: 一次性检索进程启动失败：${errorMessage(error)}`),
          );
        });
        child.on('exit', (exitCode) => {
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          this.oneShotChildren.delete(child);
          resolve(exitCode ?? 1);
        });
      });
      const summary = output.trim().split('\n').filter((line) => line !== '').join(' | ');
      if (code === 0) {
        this.options.log.info(`一次性检索完成：${summary}`);
        return summary;
      }
      if (cancelled()) {
        throw new RecallUnavailableError(
          'cancelled',
          `engram-bridge: 本次更新已被发起者取消（派生数据与取消之前一致，或已是该次更新的完整结果）。${summary}`,
        );
      }
      if (code === ONESHOT_RUNTIME_MISSING_EXIT) {
        throw new RecallUnavailableError(
          'runtime-missing',
          `engram-bridge: 一次性检索因运行时或模型不可用而失败。${summary}`,
        );
      }
      if (code === ONESHOT_BACKLOG_EXIT) {
        throw new RecallUnavailableError(
          'backlog',
          `engram-bridge: 要处理的工作量超过一次性检索单次的上限，已当场拒绝（派生数据未被改动）。${summary}` +
            `可让操作者运行 /${COMMAND_NAME}（不受单次预算约束）。`,
        );
      }
      this.options.log.error(`一次性检索失败（exit=${code}）：${summary}`);
      throw new RecallUnavailableError('internal', `engram-bridge: 一次性检索失败。${summary}`);
    } finally {
      this.oneShotDepth--;
    }
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

  /**
   * Stop the resident worker. Deliberately does NOT touch one-shot children:
   * an idle sweep or a resident timeout must never kill a long operator run,
   * and a second concurrent entry must not kill the first one's child (that
   * collision is the lock's business). Teardown uses `killOneShots()`.
   */
  async stop(reason: string, kind: RecallErrorKind = 'internal'): Promise<void> {
    if (this.stopping !== undefined) return await this.stopping;
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    const stopping = (async (): Promise<void> => {
      this.failAll(new RecallUnavailableError(kind, `检索子进程已停止（${reason}）`));
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

  /** Kill every tracked one-shot child and its process group. */
  killOneShots(): void {
    for (const child of [...this.oneShotChildren]) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      this.oneShotChildren.delete(child);
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.killOneShots();
    await this.stop('dispose');
  }
}
