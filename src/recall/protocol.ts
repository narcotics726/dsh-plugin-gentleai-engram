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

/**
 * Candidate query: "which memories in this project resemble the text I am about
 * to write".
 *
 * Deliberately NOT a retrieval: the contract is the opposite of `RecallQuery`
 * in four places (design D4). It answers from the derived state as it stands
 * (no catch-up, never a rebuild); missing derived data or a missing runtime
 * means "no candidates", never a refusal; and it carries its own short budget.
 */
export interface CandidateQuery {
  /** Title of the observation about to be written. */
  title: string;
  /** Content of the observation about to be written. */
  content: string;
  /** Type of the observation about to be written (already defaulted by the caller). */
  type: string;
  /** Topic key of the observation about to be written; empty when none was given. */
  topicKey: string;
  /** Session the write is attributed to; empty when unknown. */
  sessionId: string;
  /** The project the write belongs to. Candidates are restricted to it. */
  project: string;
  /** How many to show (M). */
  limit: number;
}

/**
 * One candidate's mechanical evidence.
 *
 * This struct IS the canonical value; the model sees a projection of it
 * (design D12). Every field is a mechanical predicate over comparable facts —
 * no field names a verdict, and none depends on the new row already existing
 * (`will_update` is decided by the host AFTER the write, from the returned id).
 */
export interface CandidateEvidence {
  id: number;
  title: string;
  type: string;
  updated_at: string;
  /**
   * The shared topic key itself, or `''` when the two do not share one.
   *
   * It carries the value rather than a bare flag because the projection has to
   * name the key ("a number must be traceable to a concrete thing"), and the
   * empty string is the sentinel because the host enforces a JSON-schema subset
   * that allows exactly ONE scalar `type` — `['string','null']` rejects the whole
   * plugin tree at load.
   */
  same_topic_key: string;
  same_session: boolean;
  same_type_and_title: boolean;
  identical_content: boolean;
  /** Shared rare terms, rarest first, spelled out. `count === terms.length`. */
  shared_rare_terms: { count: number; terms: string[] };
  /** Mechanical rank in the read layer's own ordering (never a raw score). */
  semantic_rank: number;
  corpus_size: number;
}

export interface CandidateMetering {
  /** Whether the source changed since the index was last synced (same hash as the read layer). */
  sourceChanged: boolean;
  /** Active rows in the source minus documents in the index; can be negative. */
  lagDocs: number;
  docCount: number;
  /** Documents sharing at least one token with the query text (pool eligibility). */
  candidates: number;
  /** Coverage-boost pool size actually used. */
  poolSize: number;
  /** Documents ruled out by the project restriction while walking the ranking. */
  filteredOut: number;
  hashMs: number;
  embedMs: number;
  scoreMs: number;
  totalMs: number;
}

export interface CandidatePayload {
  candidates: CandidateEvidence[];
  /** Ranks BEFORE the project filter, so the pool composition stays observable. */
  poolIds: number[];
  metering: CandidateMetering;
}

export interface WorkerRequest {
  id: number;
  cmd: 'query' | 'candidates' | 'rebuild' | 'stats' | 'shutdown';
  query?: RecallQuery;
  candidateQuery?: CandidateQuery;
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
