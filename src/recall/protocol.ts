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
  | 'rebuild-needed'
  | 'backlog'
  | 'source-missing'
  | 'disabled'
  | 'project-unknown'
  | 'timeout'
  | 'internal';

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

export type WorkerResponse =
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: { kind: RecallErrorKind; message: string } };

export type WorkerLog = { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };
export type WorkerReady = { type: 'ready'; pid: number; threads: number; modelDir: string };
export type WorkerFrame = WorkerResponse | WorkerLog | WorkerReady;
