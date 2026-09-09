import { errorMessage, type Logger } from './log.js';

export const TOOL_PREFIX = 'mcp__engram__';

/** Tools that can reach another tool indirectly and therefore need a guard too. */
const FOLDING_TOOLS = new Set(['mcp_call', 'mcp_batch_call', 'mcp_list']);

interface HeaderLike {
  origin?: unknown;
  delegationDepth?: unknown;
}

export function isSubagentSession(header: HeaderLike | undefined): boolean {
  if (header === undefined) return false;
  if (header.origin === 'subagent') return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

interface ExecutionLike {
  name?: unknown;
  arguments?: unknown;
}

/** Why an engram call must be refused inside a sub-agent, if it must. */
export function subagentDenialReason(execution: ExecutionLike): string | undefined {
  const name = typeof execution.name === 'string' ? execution.name : '';
  if (name.startsWith(TOOL_PREFIX)) {
    return 'engram tools are shadowed in sub-agents; record the memory from the parent agent instead';
  }
  if (FOLDING_TOOLS.has(name)) {
    const args = (execution.arguments ?? {}) as Record<string, unknown>;
    const inner = typeof args.tool === 'string' ? args.tool : undefined;
    if (inner !== undefined && inner.startsWith(TOOL_PREFIX)) {
      return 'engram tools are shadowed in sub-agents; record the memory from the parent agent instead';
    }
  }
  return undefined;
}

interface AgentLike {
  ctx?: {
    effect?: (callback: () => unknown, label?: string) => unknown;
    tools?: {
      restrict?: (filter: { deny?: readonly string[] }) => unknown;
      guard?: (guard: (execution: ExecutionLike) => string | undefined) => unknown;
    };
  };
}

/**
 * Remove engram tools from one sub-agent's model-facing catalog and refuse any
 * remaining path (including MCP folding tools). Both registrations are scoped
 * to the child through its own context, so the parent is untouched.
 */
export function shadowEngramTools(agent: AgentLike | undefined, toolNames: readonly string[], log: Logger): void {
  const ctx = agent?.ctx;
  if (ctx?.effect === undefined || ctx.tools === undefined) {
    log.warn('cannot shadow engram tools for sub-agent: agent context has no tools/effect');
    return;
  }
  if (toolNames.length > 0 && typeof ctx.tools.restrict === 'function') {
    try {
      ctx.effect(() => ctx.tools?.restrict?.({ deny: [...toolNames] }), 'engram-bridge.subagent-restrict');
    } catch (error) {
      log.warn(`could not restrict engram tools for sub-agent: ${errorMessage(error)}`);
    }
  }
  if (typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools?.guard?.(subagentDenialReason), 'engram-bridge.subagent-guard');
  }
}
