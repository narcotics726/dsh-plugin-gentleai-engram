import type { SyncMode } from './index-db.js';

/**
 * Wire contract between the host process and the resident recall worker.
 *
 * Deliberately tiny and JSON-only: the host never imports the embedding runtime
 * (hard rule 7), so everything the worker needs and everything it produces
 * crosses this boundary as plain data.
 */

export type RecallErrorKind =
  | 'runtime-missing'
  /** This call declined the work: over the caller's cap. Carries `deferral`. */
  | 'sync-needed'
  /** Another writer holds the index right now. */
  | 'busy'
  /** The caller cancelled. */
  | 'cancelled'
  /** Host-side refusal: the work exceeds what any path may do in one call. */
  | 'backlog'
  | 'source-missing'
  | 'disabled'
  | 'project-unknown'
  | 'timeout'
  | 'internal';

/** Which path should do the work this call declined. */
export type RecallDeferralMode = 'incremental' | 'full';

export interface RecallDeferral {
  mode: RecallDeferralMode;
  /** Documents the decliner would have touched (or the whole corpus, for full). */
  pendingDocs: number;
}

export interface RecallQuery {
  query: string;
  limit: number;
  /** Resolved project restriction. Absent means "no restriction" (allProjects). */
  project?: string;
  allProjects?: boolean;
  type?: string;
  scope?: string;
}

export interface RecallHit {
  id: number;
  title: string;
  type: string;
  project: string;
  scope: string;
  score: number;
  excerpt: string;
}

export interface RecallMetering {
  sourceChanged: boolean;
  rowsScanned: number;
  docsTouched: number;
  hashMs: number;
  syncMs: number;
  embedDocs: number;
  embedLoadMs: number;
  embedQueryMs: number;
  scoreMs: number;
  totalMs: number;
  mode: SyncMode;
  docCount: number;
  indexBytes: number;
}

export interface RecallPayload {
  hits: RecallHit[];
  limit: number;
  /** True iff a matching document exists beyond the returned prefix. */
  truncated: boolean;
  /** Documents excluded by the filters, over the whole ranking. */
  filteredOut: number;
  poolSize: number;
  candidates: number;
  /** Domain values present in the index, filled in only when a type filter matched nothing. */
  availableTypes: string[];
  metering: RecallMetering;
}

export interface WorkerRequest {
  id: number;
  cmd: 'query' | 'rebuild' | 'stats' | 'shutdown';
  query?: RecallQuery;
}

/** One settled one-shot run, reported by the `--sync`/`--rebuild` child. */
export interface OneShotSummary {
  mode: SyncMode;
  docs: number;
  embedDocs: number;
  ms: number;
  docCount: number;
}

export interface WorkerErrorInfo {
  kind: RecallErrorKind;
  message: string;
  /** Present when `kind === 'sync-needed'`: what the resident declined. */
  deferral?: RecallDeferral;
}

export type WorkerResponse =
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: WorkerErrorInfo };

export type WorkerLog = { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };
export type WorkerReady = { type: 'ready'; pid: number; threads: number; modelDir: string };
export type WorkerFrame = WorkerResponse | WorkerLog | WorkerReady;

/**
 * Exit code a one-shot child uses when it could not build because the model
 * or runtime is not the declared one.
 *
 * The host sees only an exit code from a one-shot child, and the spec keeps
 * 「运行时或模型缺失」 apart from 「重建失败」. A dedicated code is how the host
 * tells them apart without widening the wire protocol (design D7); every other
 * failure keeps the generic code 1.
 */
export const ONESHOT_RUNTIME_MISSING_EXIT = 3;

/**
 * Exit code a one-shot child uses when the work exceeded the cap it was given.
 *
 * The cap is not the host's to trust blindly: the corpus can grow between the
 * resident's diff and the child's own diff, so the child re-checks under the
 * lock and reports this instead of starting a run that would be killed
 * (design D7).
 */
export const ONESHOT_BACKLOG_EXIT = 4;

/**
 * The operator command's name. It is externally visible (discovery UI) AND it is
 * named by the refusal message that tells a caller what to do when even the
 * model-facing entry cannot finish the work — so it lives here, in a module that
 * both `process.ts` and the command module may import without a cycle.
 */
export const COMMAND_NAME = 'engram-sync';

/** How long a refusal's holder has been idle is the only thing worth reporting. */
export const COMMAND_DESCRIPTION = '把记忆检索的派生索引追到最新（可能耗时数分钟，可取消）';
