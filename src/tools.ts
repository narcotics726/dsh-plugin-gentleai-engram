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

/** One ToolDefinition per engram-declared tool, named `mcp__engram__<name>`. */
export function buildToolDefinitions(
  declarations: readonly McpToolDeclaration[],
  wiring: ToolWiring,
): ToolDefinition[] {
  return declarations.map((declaration) => ({
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
