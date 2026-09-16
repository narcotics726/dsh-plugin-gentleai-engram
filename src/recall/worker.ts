import { createInterface } from 'node:readline';
import { Embedder } from './embed.js';
import { RecallEngine, SyncNeededError, type RecallWritePolicy } from './engine.js';
import { SourceMissingError, type EmbedderLike } from './index-db.js';
import { LockBusyError } from './index-lock.js';
import { ModelUnavailableError } from './model-dir.js';
import { expectedIdentityDigest } from './model-expected.js';
import type { CoverageVariant } from './scoring.js';
import {
  ONESHOT_BACKLOG_EXIT,
  ONESHOT_RUNTIME_MISSING_EXIT,
  type RecallDeferral,
  type RecallErrorKind,
  type RecallPayload,
  type RecallQuery,
  type WorkerErrorInfo,
  type WorkerFrame,
  type WorkerRequest,
} from './protocol.js';

/**
 * Recall worker: the ONLY process that loads the embedding runtime.
 *
 * The host entry must never reach this file (hard rule 7); it talks to it over
 * JSON lines on stdio. Three modes:
 *
 *   (default)   JSON-lines server: lazy model load, one query at a time, logs as
 *               frames, exits on stdin EOF.
 *   --sync      one-shot catch-up: rebuild if the index is untrusted, else the
 *               delta, capped by ENGRAM_BRIDGE_MAX_DOCS. Used by the explicit
 *               entry and by the operator request.
 *   --rebuild   one-shot forced full build. Kept because scripts/mem-profile.mjs
 *               and the README's Node-baseline note use it; capped the same way.
 *
 * Configuration arrives as environment variables, set by the host process
 * manager. Nothing here reads the plugin config directly.
 */

function envStr(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`engram-bridge: 缺少环境变量 ${name}`);
    return fallback;
  }
  return raw;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`engram-bridge: 环境变量 ${name} 不是数字：${raw}`);
  return value;
}

/**
 * The one cap carrier. REQUIRED, with no implicit default: "absent means
 * unlimited" must never be reachable from a product path, so a missing key is a
 * loud failure (hard rule 4). The literal `unlimited` is the operator request's
 * explicit value (design D2/D8); anything else must be a non-negative number.
 */
function envMaxDocs(): number | undefined {
  const raw = process.env.ENGRAM_BRIDGE_MAX_DOCS;
  if (raw === undefined || raw === '') {
    throw new Error('engram-bridge: 缺少环境变量 ENGRAM_BRIDGE_MAX_DOCS（实现不得走隐式缺省）');
  }
  if (raw === 'unlimited') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`engram-bridge: ENGRAM_BRIDGE_MAX_DOCS 不是合法值：${raw}`);
  }
  return Math.floor(value);
}

export interface WorkerConfig {
  dbPath: string;
  indexPath: string;
  modelDir: string;
  threads: number;
  w: number;
  topK: number;
  coverage: CoverageVariant;
  /** `undefined` = unlimited; only the operator request passes that. */
  maxDocs: number | undefined;
  lockWaitMs: number;
  busyTimeoutMs: number;
}

export function workerConfigFromEnv(): WorkerConfig {
  const coverage = envStr('ENGRAM_BRIDGE_COVERAGE', 'field_cov');
  if (coverage !== 'field_cov' && coverage !== 'cov_n' && coverage !== 'idf_cov') {
    throw new Error(`engram-bridge: 未知的 coverage 变体：${coverage}`);
  }
  return {
    dbPath: envStr('ENGRAM_BRIDGE_DB_PATH'),
    indexPath: envStr('ENGRAM_BRIDGE_INDEX_PATH'),
    modelDir: envStr('ENGRAM_BRIDGE_MODEL_DIR'),
    threads: Math.max(1, Math.floor(envNum('ENGRAM_BRIDGE_THREADS', 1))),
    w: envNum('ENGRAM_BRIDGE_W', 0.2),
    topK: Math.max(0, Math.floor(envNum('ENGRAM_BRIDGE_TOP_K', 50))),
    coverage,
    maxDocs: envMaxDocs(),
    lockWaitMs: Math.max(0, Math.floor(envNum('ENGRAM_BRIDGE_LOCK_WAIT_MS', 2_000))),
    busyTimeoutMs: Math.max(0, Math.floor(envNum('ENGRAM_BRIDGE_BUSY_TIMEOUT_MS', 60_000))),
  };
}

/**
 * Map an error to a wire kind. The explicit branches are load-bearing: the
 * fallback below collapses every unknown string kind to `internal`, so a new
 * error class that is only "an object with a kind" would silently lose its
 * identity (and with it both new refusals).
 */
function errorKind(error: unknown): RecallErrorKind {
  if (error instanceof ModelUnavailableError) return 'runtime-missing';
  if (error instanceof SyncNeededError) return 'sync-needed';
  if (error instanceof LockBusyError) return 'busy';
  if (error instanceof SourceMissingError) return 'source-missing';
  const kind = (error as { kind?: unknown } | undefined)?.kind;
  if (kind === 'busy') return 'busy';
  if (kind === 'source-missing') return 'source-missing';
  return 'internal';
}

function deferralOf(error: unknown): RecallDeferral | undefined {
  if (!(error instanceof SyncNeededError)) return undefined;
  return { mode: error.mode, pendingDocs: error.pendingDocs };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Worker {
  private readonly config: WorkerConfig;
  private embedderPromise?: Promise<Embedder>;
  private engine?: RecallEngine;
  private readonly totals = {
    calls: 0,
    totalMs: 0,
    hashMs: 0,
    syncMs: 0,
    embedDocs: 0,
    rowsScanned: 0,
    docCount: 0,
    indexBytes: 0,
    sinceLogMs: 0,
  };

  constructor(config: WorkerConfig) {
    this.config = config;
  }

  private policy(): RecallWritePolicy {
    return {
      maxDocs: this.config.maxDocs,
      lockWaitMs: this.config.lockWaitMs,
      busyTimeoutMs: this.config.busyTimeoutMs,
    };
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const frame: WorkerFrame = { type: 'log', level, message };
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private async embedder(): Promise<EmbedderLike> {
    let pending = this.embedderPromise;
    if (pending === undefined) {
      pending = Embedder.create({
        modelDir: this.config.modelDir,
        threads: this.config.threads,
      }).then((embedder) => {
        this.log(
          'info',
          `嵌入运行时已加载：线程=${embedder.threads} 加载=${embedder.loadMs.toFixed(0)}ms 模型=${(
            embedder.modelBytes /
            1048576
          ).toFixed(1)}MB`,
        );
        return embedder;
      });
      this.embedderPromise = pending;
    }
    try {
      return await pending;
    } catch (error) {
      // A failed load must not be remembered. `??=` alone caches the rejection
      // for the life of the worker, so a cause that goes away leaves retrieval
      // failing with the same stale error (design D6). Resetting is chosen over
      // stopping the worker because the worker→host frame carries only
      // `{kind, message}`: "internal, from the modelling stage" cannot be told
      // apart on the wire, and distinguishing it would mean changing protocol.
      if (this.embedderPromise === pending) this.embedderPromise = undefined;
      throw error;
    }
  }

  private getEngine(): RecallEngine {
    this.engine ??= new RecallEngine({
      dbPath: this.config.dbPath,
      indexPath: this.config.indexPath,
      w: this.config.w,
      topK: this.config.topK,
      coverage: this.config.coverage,
      // The worker is the process that loads the model, so it is where the index
      // generation is stamped from — and it is stamped from the DECLARATION, not
      // from whatever bytes happened to load (design D10).
      identityDigest: expectedIdentityDigest(),
      embedder: () => this.embedder(),
    });
    return this.engine;
  }

  async handle(request: WorkerRequest): Promise<unknown> {
    switch (request.cmd) {
      case 'query':
        return await this.query(request.query as RecallQuery);
      case 'rebuild': {
        // Residual command with no sender, but it is a product path all the
        // same: it goes through the same cap and the same lock.
        const result = await this.getEngine().rebuild(this.policy());
        this.log('info', `全量重建完成：${result.docs} 条 / ${result.ms.toFixed(0)}ms`);
        return result;
      }
      case 'stats':
        return { ...this.totals, threads: this.config.threads, modelDir: this.config.modelDir };
      case 'shutdown':
        return { ok: true };
      default:
        throw new Error(`engram-bridge: 未知命令 ${String((request as { cmd?: unknown }).cmd)}`);
    }
  }

  private async query(request: RecallQuery): Promise<RecallPayload> {
    const payload = await this.getEngine().query(request, this.policy());
    this.accumulate(payload);
    return payload;
  }

  private accumulate(payload: RecallPayload): void {
    const m = payload.metering;
    this.totals.calls++;
    this.totals.totalMs += m.totalMs;
    this.totals.hashMs += m.hashMs;
    this.totals.syncMs += m.syncMs;
    this.totals.embedDocs += m.embedDocs;
    this.totals.rowsScanned += m.rowsScanned;
    this.totals.docCount = m.docCount;
    this.totals.indexBytes = m.indexBytes;
    this.totals.sinceLogMs += m.totalMs;
    // A rolling summary, not one line per call: the per-call numbers are still
    // in the canonical result, but the log must not grow with traffic.
    if (this.totals.calls % 20 === 0 || this.totals.sinceLogMs >= 60000) {
      const calls = this.totals.calls;
      this.log(
        'info',
        `检索计量（累计 ${calls} 次：平均 total=${(this.totals.totalMs / calls).toFixed(1)}ms ` +
          `hash=${(this.totals.hashMs / calls).toFixed(1)}ms sync=${(this.totals.syncMs / calls).toFixed(1)}ms ` +
          `embed_docs=${(this.totals.embedDocs / calls).toFixed(2)}）` +
          `当前语料 ${this.totals.docCount} 条 / 索引 ${(this.totals.indexBytes / 1024).toFixed(0)}KB` +
          `（每查询成本随语料线性增长）`,
      );
      this.totals.sinceLogMs = 0;
    }
  }
}

function workerError(error: unknown): WorkerErrorInfo {
  const info: WorkerErrorInfo = { kind: errorKind(error), message: errorText(error) };
  const deferral = deferralOf(error);
  if (deferral !== undefined) info.deferral = deferral;
  return info;
}

async function serve(): Promise<void> {
  const worker = new Worker(workerConfigFromEnv());
  const ready: WorkerFrame = {
    type: 'ready',
    pid: process.pid,
    threads: workerConfigFromEnv().threads,
    modelDir: process.env.ENGRAM_BRIDGE_MODEL_DIR ?? '',
  };
  process.stdout.write(`${JSON.stringify(ready)}\n`);

  // One request at a time: the engine holds one open index and one model
  // session, and interleaving two queries would let one see a half-updated
  // scorer. Queries are milliseconds; the queue is not a bottleneck.
  let chain: Promise<void> = Promise.resolve();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;
    let request: WorkerRequest;
    try {
      request = JSON.parse(text) as WorkerRequest;
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ type: 'log', level: 'warn', message: `无法解析的请求：${errorText(error)}` })}\n`,
      );
      return;
    }
    chain = chain.then(async () => {
      try {
        const result = await worker.handle(request);
        const frame: WorkerFrame = { type: 'response', id: request.id, ok: true, result };
        process.stdout.write(`${JSON.stringify(frame)}\n`);
        if (request.cmd === 'shutdown') {
          setImmediate(() => process.exit(0));
        }
      } catch (error) {
        const frame: WorkerFrame = {
          type: 'response',
          id: request.id,
          ok: false,
          error: workerError(error),
        };
        process.stdout.write(`${JSON.stringify(frame)}\n`);
      }
    });
  });
  rl.on('close', () => {
    setImmediate(() => process.exit(0));
  });
}

async function oneShot(mode: 'sync' | 'rebuild'): Promise<void> {
  const config = workerConfigFromEnv();
  const engine = new RecallEngine({
    dbPath: config.dbPath,
    indexPath: config.indexPath,
    w: config.w,
    topK: config.topK,
    coverage: config.coverage,
    identityDigest: expectedIdentityDigest(),
    embedder: () =>
      Embedder.create({ modelDir: config.modelDir, threads: config.threads }).then((e) => {
        process.stdout.write(`嵌入运行时：线程=${e.threads} 加载=${e.loadMs.toFixed(0)}ms\n`);
        return e;
      }),
  });
  const policy: RecallWritePolicy = {
    maxDocs: config.maxDocs,
    lockWaitMs: config.lockWaitMs,
    busyTimeoutMs: config.busyTimeoutMs,
  };
  try {
    const result = mode === 'rebuild' ? await engine.rebuild(policy) : await engine.syncOnce(policy);
    if (result.mode === 'noop') {
      process.stdout.write(`派生索引已是最新：${result.docs} 条文档\n`);
    } else {
      const verb = result.mode === 'full' ? '全量重建' : '增量同步';
      process.stdout.write(
        `${verb}完成：${result.docs} 条文档，嵌入 ${result.embedDocs} 条，${result.ms.toFixed(0)}ms\n`,
      );
    }
  } finally {
    engine.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (isMain) {
  const mode = process.argv.includes('--rebuild') ? 'rebuild' : process.argv.includes('--sync') ? 'sync' : 'serve';
  const run = mode === 'serve' ? serve() : oneShot(mode);
  run.catch((error: unknown) => {
    process.stderr.write(`${errorText(error)}\n`);
    // The host only sees an exit code here. A wrong model/runtime must not look
    // like a generic build failure, and "this was more work than my cap allows"
    // must not look like a crash (design D7).
    process.exit(
      error instanceof ModelUnavailableError
        ? ONESHOT_RUNTIME_MISSING_EXIT
        : error instanceof SyncNeededError
          ? ONESHOT_BACKLOG_EXIT
          : 1,
    );
  });
}
