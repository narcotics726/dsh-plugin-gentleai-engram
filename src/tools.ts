import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { extractText, type McpCallResult, type McpToolDeclaration } from './mcp-client.js';
import { TOOL_PREFIX } from './subagent.js';

/** Canonical output contract for every bridged tool. */
export const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    structuredContent: {},
  },
  required: ['content'],
  additionalProperties: false,
};

export interface ToolCallSite {
  sessionId: string;
  workspace: string;
}

export interface ToolWiring {
  /** Per-call timeout budget forwarded to the host's timeout policy. */
  timeoutMs: number;
  /**
   * Bind the session, apply implicit arguments, and call engram. Implemented by
   * the plugin entry so tools stay free of session/binding state.
   */
  run(
    site: ToolCallSite,
    declaration: McpToolDeclaration,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<McpCallResult>;
}

/** Read the calling session's identity from the execution context. */
export function siteOf(exec: { agent?: unknown }): ToolCallSite {
  const agent = exec.agent as { session?: { header?: { id?: unknown; cwd?: unknown } } } | undefined;
  const header = agent?.session?.header;
  const sessionId = typeof header?.id === 'string' ? header.id : undefined;
  const workspace = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
  if (sessionId === undefined || workspace === undefined) {
    throw new Error('engram-bridge: engram tools need a session workspace');
  }
  return { sessionId, workspace };
}

/**
 * engram-declared tools the bridge deliberately does NOT register.
 *
 * `mem_capture_passive` is the bridge's own turn-final write: registering it would let the
 * model submit the same text a second time (engram's dedupe only matches identical
 * normalized content, so near-duplicates survive). Unregistered names are rejected by the
 * host with an unknown-tool error, which also closes the folding-tool bypass.
 *
 * `mem_save_prompt` is redundant under the dsh topology: dsh already keeps the complete
 * session log under `~/.dsh/sessions/`, so a model-issued prompt write duplicates what the
 * host records, while `mem_context`'s Recent Prompts block would inject that stale copy back
 * into later sessions.
 *
 * `mem_search` is replaced by this plugin's own retrieval entry point. Its engram-side
 * retrieval tokenizes CJK as whole punctuation-delimited runs with a default AND, which
 * measured R@10 = 0.0000 / 0.0520 on the two frozen proxies; keeping it registered would
 * leave a second, broken retrieval path behind the same tool list.
 *
 * `mem_save` is replaced by this plugin's own save entry point. Its handler unconditionally
 * runs a conflict-candidate scan whose matching is title-only FTS with a tokenizer that
 * cannot split Chinese, and it inserts one `pending` relation row per "candidate" it finds;
 * there is no switch for it (the `BM25Floor` override has no CLI/env entry point in the
 * backend version in use). Filtering that at the exit is the shape the read layer already
 * rejected, so the entry itself is removed and the bridge computes its own candidates.
 */
export const UNREGISTERED_ENGRAM_TOOLS: readonly string[] = [
  'mem_capture_passive',
  'mem_save_prompt',
  'mem_search',
  'mem_save',
];

/** One ToolDefinition per engram-declared tool, named `mcp__engram__<name>`. */
export function buildToolDefinitions(
  declarations: readonly McpToolDeclaration[],
  wiring: ToolWiring,
): ToolDefinition[] {
  return declarations
    .filter((declaration) => !UNREGISTERED_ENGRAM_TOOLS.includes(declaration.name))
    .map((declaration) => ({
    name: `${TOOL_PREFIX}${declaration.name}`,
    description: declaration.description ?? `engram tool ${declaration.name}`,
    parameters: declaration.inputSchema ?? { type: 'object', properties: {} },
    timeoutMs: wiring.timeoutMs,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => [
        {
          type: 'text' as const,
          text: extractText((value as { content?: McpCallResult['content'] }).content),
        },
      ],
    },
    execute: async (args: unknown, exec): Promise<unknown> => {
      const site = siteOf(exec as { agent?: unknown });
      const result = await wiring.run(
        site,
        declaration,
        (args ?? {}) as Record<string, unknown>,
        exec.signal,
      );
      const value: { content: unknown[]; structuredContent?: unknown } = { content: result.content };
      if (result.structuredContent !== undefined) value.structuredContent = result.structuredContent;
      return value;
    },
    }));
}
