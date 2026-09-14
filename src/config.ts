import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import type { CoverageVariant } from './recall/scoring.js';

/** `$DSH_HOME` when set, else `~/.dsh` — the same rule as the tool-surface cache. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
}

/** engram's own data directory; the bridge never sets it, but must read the DB. */
export function engramDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGRAM_DATA_DIR !== undefined && env.ENGRAM_DATA_DIR !== ''
    ? env.ENGRAM_DATA_DIR
    : join(homedir(), '.engram');
}

/**
 * Default locations, derived at call time for a directly-constructed config
 * (tests, embedders) that omits the keys. `$DSH_HOME/storages/engram-bridge/`
 * is where the tool-surface cache already lives, so the derived index and the
 * explicitly installed model sit next to established plugin state.
 */
export function defaultSearchIndexDir(): string {
  return join(dshHome(), 'storages', 'engram-bridge', 'index');
}

export function defaultSearchModelDir(): string {
  return join(dshHome(), 'storages', 'engram-bridge', 'model');
}

export function defaultSearchDbPath(): string {
  return join(engramDataDir(), 'engram.db');
}

/** Resolved plugin configuration; defaults live in the schema below. */
export interface Config {
  /** engram executable. */
  command: string;
  /** Arguments passed to the executable, without shell interpolation. */
  args: string[];
  /** Extra environment variables merged on top of the minimal inherited env. */
  env: Record<string, string>;
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number;
  /** Maximum number of live engram child processes (one per workspace). */
  poolMaxConnections: number;
  /** Close a workspace connection after this much idle time; 0 disables idle reclaim. */
  poolMaxIdleMs: number;
  /** How often the plugin sweeps idle connections itself (>= 1000). */
  poolSweepIntervalMs: number;
  /** Workspace absolute path -> engram project name. Highest injection precedence. */
  projectOverrides: Record<string, string>;
  /** Inject project/directory arguments. */
  injectSessionProject: boolean;
  /** Inject session_id arguments. */
  injectSessionId: boolean;
  /** Capture turn-final "## Key Learnings:" sections into engram. */
  capturePassive: boolean;
  /** Persist compaction summaries and inject bounded recall after compaction. */
  compactionRecovery: boolean;
  /** Token budget for the post-compaction recall injection. */
  recoveryTokenBudget: number;
  /**
   * Whether a standalone (between-turns) compaction wakes the driver so the recall opens its own
   * self-recovery turn. `false` is a cost opt-out: the recall still gets delivered, but it waits
   * for the next user message - a known-degraded mode, since pending input can be discarded by
   * cancellation or disposal.
   */
  recallWakeup: boolean;
  /**
   * Read layer: whether the plugin's own retrieval tool is usable. Checked at
   * the call site, not at registration, so flipping it never changes the tool
   * surface. Unrelated to `recallWakeup`, which is about post-compaction recall.
   */
  searchEnabled: boolean;
  /** engram's SQLite database (the source of truth the derived index follows). */
  searchDbPath: string;
  /** Derived state: the read index (rebuildable, deletable, outside sync/backup). */
  searchIndexDir: string;
  /** Model + pruned runtime directory; installed explicitly, never downloaded. */
  searchModelDir: string;
  /** `ort.env.wasm.numThreads`. Resident memory is almost entirely this number. */
  embedThreads: number;
  /** Reclaim the resident recall worker after this much idle time; 0 disables it. */
  searchIdleMs: number;
  /** How often the plugin sweeps the idle recall worker itself (>= 1000). */
  searchSweepIntervalMs: number;
  /** Per-retrieval budget; on expiry the worker is killed and the call fails. */
  searchTimeoutMs: number;
  /** Coverage-boost weight. Tuned on P2 and confirmed held out on P3. */
  searchW: number;  /** How far down the lexical ordering the coverage boost reaches. */
  searchTopK: number;
  /** Coverage variant. `field_cov` is the validated default. */
  searchCoverage: CoverageVariant;
}

export const Config: z<Config> = z.object({
  command: z.string().required(),
  args: z.array(String).default(['mcp']),
  env: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().default(60000),
  poolMaxConnections: z.number().default(8),
  poolMaxIdleMs: z.number().default(600000),
  poolSweepIntervalMs: z.number().min(1000).default(60000),
  projectOverrides: z.dict(String).default({}),
  injectSessionProject: z.boolean().default(true),
  injectSessionId: z.boolean().default(true),
  capturePassive: z.boolean().default(true),
  compactionRecovery: z.boolean().default(true),
  recoveryTokenBudget: z.number().default(800),
  recallWakeup: z.boolean().default(true),
  // Read layer. New keys use the `search*` prefix on purpose: `recallWakeup`
  // above already means "post-compaction recall", an unrelated feature, so
  // reusing `recall*` here would make two different things look like one.
  searchEnabled: z.boolean().default(true),
  searchDbPath: z.string().default(defaultSearchDbPath()),
  searchIndexDir: z.string().default(defaultSearchIndexDir()),
  searchModelDir: z.string().default(defaultSearchModelDir()),
  embedThreads: z.number().min(1).default(1),
  searchIdleMs: z.number().default(600000),
  searchSweepIntervalMs: z.number().min(1000).default(60000),
  searchTimeoutMs: z.number().default(60000),
  // Written with the trailing zero the reference's `DEFAULT_W` uses; the change's
  // verification greps this literal and requires exactly one hit, and this schema
  // default is the only place `w` may be declared (see index-db.ts's SCORING for
  // the constants that belong to the index instead).
  searchW: z.number().default(0.20),
  searchTopK: z.number().default(50),
  searchCoverage: z.union([z.const('field_cov'), z.const('cov_n'), z.const('idf_cov')]).default('field_cov'),
});
