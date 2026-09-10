import { errorMessage, type Logger } from './log.js';

export const TOOL_PREFIX = 'mcp__engram__';

interface HeaderLike {
  origin?: unknown;
  delegationDepth?: unknown;
}

export function isSubagentSession(header: HeaderLike | undefined): boolean {
  if (header === undefined) return false;
  if (header.origin === 'subagent') return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

interface AgentLike {
  ctx?: {
    effect?: (callback: () => unknown, label?: string) => unknown;
    tools?: {
      restrict?: (filter: { deny?: readonly string[] }) => unknown;
      guard?: (guard: (execution: { name?: unknown }) => string | undefined) => unknown;
    };
  };
}

/**
 * Remove engram tools from one sub-agent's model-facing catalog.
 *
 * One restriction is enough: dsh applies it to the child's inherited tool
 * surface AND to dispatch, so a hidden tool also fails with `UNKNOWN_TOOL`.
 * Folding tools such as `mcp_call` resolve their target with the CALLING
 * agent's identity (verified in @aiwayds/dsh-mcp-adapter: `resolve(name,
 * exec.agent)`), so the same restriction closes that path too — no extra guard.
 */
/**
 * Deny engram tool execution for one sub-agent at DISPATCH time.
 *
 * This is the timing-independent half of sub-agent isolation: a `restrict()` needs the tool
 * names to be known (it throws on names that are not registered yet), so it cannot cover a
 * sub-agent created before the tool surface was registered. A guard is evaluated per call
 * (dsh-tools runs the scope's guard chain on every execution), so it holds regardless of
 * when registration happened.
 */
export function guardEngramTools(agent: AgentLike | undefined, log: Logger): void {
  const ctx = agent?.ctx;
  if (ctx?.effect === undefined || ctx.tools === undefined) {
    log.warn('cannot guard engram tools for sub-agent: agent context has no tools/effect');
    return;
  }
  if (typeof ctx.tools.guard !== 'function') {
    log.warn('cannot guard engram tools for sub-agent: tool runtime has no guard()');
    return;
  }
  try {
    ctx.effect(
      () =>
        ctx.tools?.guard?.((execution) =>
          typeof execution?.name === 'string' && execution.name.startsWith(TOOL_PREFIX)
            ? 'engram memory tools are not available to sub-agents'
            : undefined,
        ),
      'engram-bridge.subagent-guard',
    );
  } catch (error) {
    log.warn(`could not guard engram tools for sub-agent: ${errorMessage(error)}`);
  }
}

export function shadowEngramTools(agent: AgentLike | undefined, toolNames: readonly string[], log: Logger): void {
  const ctx = agent?.ctx;
  if (ctx?.effect === undefined || ctx.tools === undefined) {
    log.warn('cannot shadow engram tools for sub-agent: agent context has no tools/effect');
    return;
  }
  if (toolNames.length === 0) return;
  if (typeof ctx.tools.restrict !== 'function') {
    log.warn('cannot shadow engram tools for sub-agent: tool runtime has no restrict()');
    return;
  }
  try {
    ctx.effect(() => ctx.tools?.restrict?.({ deny: [...toolNames] }), 'engram-bridge.subagent-restrict');
  } catch (error) {
    log.warn(`could not restrict engram tools for sub-agent: ${errorMessage(error)}`);
  }
}
