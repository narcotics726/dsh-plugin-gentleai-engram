import z from '@deepseek-ai/schemastery';

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
});
