import { createInterface } from 'node:readline';
import { Embedder } from './embed.js';
import { RecallEngine, RebuildNeededError } from './engine.js';
import { BacklogError, SourceMissingError, type EmbedderLike } from './index-db.js';
import { ModelUnavailableError } from './model-dir.js';
import type { CoverageVariant } from './scoring.js';
import type { RecallErrorKind, RecallPayload, RecallQuery, WorkerFrame, WorkerRequest } from './protocol.js';

/**
 * Resident recall worker: the ONLY process that loads the embedding runtime.
 *
 * The host entry must never reach this file (hard rule 7); it talks to it over
 * JSON lines on stdio. Two modes:
 *
 *   (default)   JSON-lines server: lazy model load, one query at a time, logs as
 *               frames, exits on stdin EOF.
 *   --rebuild   one-shot full index build, human-readable output, then exit.
 *               This mode is run by the host with a temporary high thread count,
 *               because a full build at the resident thread count does not fit in
 *               a tool-call budget (measured: 11.96 s at 16 threads vs 115.6 s at
 *               1).
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

export interface WorkerConfig {
  dbPath: string;
  indexPath: string;
  modelDir: string;
  threads: number;
  w: number;
  topK: number;
  coverage: CoverageVariant;
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
  };
}

function errorKind(error: unknown): RecallErrorKind {
  if (error instanceof ModelUnavailableError) return 'runtime-missing';
  if (error instanceof RebuildNeededError) return 'rebuild-needed';
  if (error instanceof BacklogError) return 'backlog';
  if (error instanceof SourceMissingError) return 'source-missing';
  const kind = (error as { kind?: unknown } | undefined)?.kind;
  if (typeof kind === 'string') return kind === 'source-missing' ? 'source-missing' : 'internal';
  return 'internal';
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

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const frame: WorkerFrame = { type: 'log', level, message };
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private async embedder(): Promise<EmbedderLike> {
    this.embedderPromise ??= Embedder.create({
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
    return this.embedderPromise;
  }

  private getEngine(): RecallEngine {
    this.engine ??= new RecallEngine({
      dbPath: this.config.dbPath,
      indexPath: this.config.indexPath,
      w: this.config.w,
      topK: this.config.topK,
      coverage: this.config.coverage,
      embedder: () => this.embedder(),
    });
    return this.engine;
  }

  async handle(request: WorkerRequest): Promise<unknown> {
    switch (request.cmd) {
      case 'query':
        return await this.query(request.query as RecallQuery);
      case 'rebuild': {
        const result = await this.getEngine().rebuild();
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
    const payload = await this.getEngine().query(request);
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
          error: { kind: errorKind(error), message: errorText(error) },
        };
        process.stdout.write(`${JSON.stringify(frame)}\n`);
      }
    });
  });
  rl.on('close', () => {
    setImmediate(() => process.exit(0));
  });
}

async function rebuild(): Promise<void> {
  const config = workerConfigFromEnv();
  const engine = new RecallEngine({
    dbPath: config.dbPath,
    indexPath: config.indexPath,
    w: config.w,
    topK: config.topK,
    coverage: config.coverage,
    embedder: () =>
      Embedder.create({ modelDir: config.modelDir, threads: config.threads }).then((e) => {
        process.stdout.write(
          `嵌入运行时：线程=${e.threads} 加载=${e.loadMs.toFixed(0)}ms\n`,
        );
        return e;
      }),
  });
  try {
    const result = await engine.rebuild();
    process.stdout.write(`全量重建完成：${result.docs} 条文档，${result.ms.toFixed(0)}ms\n`);
  } finally {
    engine.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (isMain) {
  const mode = process.argv.includes('--rebuild') ? 'rebuild' : 'serve';
  const run = mode === 'rebuild' ? rebuild() : serve();
  run.catch((error: unknown) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exit(1);
  });
}
