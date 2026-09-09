import { homedir } from 'node:os';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { SessionBindings, type Binding } from './bindings.js';
import { PassiveCapture } from './capture.js';
import { CompactionRecovery } from './compaction.js';
import { Config, type Config as EngramConfig } from './config.js';
import { applyInjection, chooseProject, type InjectionInputs } from './injection.js';
import { errorMessage, loggerFrom, type Logger } from './log.js';
import { McpClient, type McpCallResult, type McpToolDeclaration } from './mcp-client.js';
import { ConnectionPool } from './pool.js';
import { isSubagentSession, shadowEngramTools, TOOL_PREFIX } from './subagent.js';
import { readToolCache, sameToolSurface, toolCacheFingerprint, toolCachePath, writeToolCache } from './tool-cache.js';
import { buildToolDefinitions, siteOf, type ToolCallSite } from './tools.js';

export { Config };
export type { EngramConfig };

export const name = 'engram-bridge';
export const inject = ['tools'];

interface HostLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

interface AgentLike {
  session?: { header?: { id?: unknown; cwd?: string; origin?: unknown; delegationDepth?: unknown }; snapshotEvents?: () => readonly SessionEventLike[] };
  inject?: (message: unknown) => void;
  ctx?: Parameters<typeof shadowEngramTools>[0] extends infer T ? T : never;
}

interface SessionEventLike {
  type?: unknown;
  turn?: unknown;
  interrupted?: unknown;
  message?: { content?: Array<{ type?: unknown; text?: unknown }> };
  summary?: Array<{ type?: unknown; text?: unknown }>;
  compactionId?: unknown;
  error?: unknown;
}

interface PluginContext {
  logger?: HostLogger;
  on(event: string, listener: (...args: never[]) => unknown): unknown;
  effect(callback: () => (() => void) | void, label?: string): unknown;
  tools: { register(definition: ToolDefinition): () => void };
}

function blocksToText(blocks: readonly { type?: unknown; text?: unknown }[] | undefined): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined))
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

/** Final assistant text of one turn, skipping interrupted (partial) messages. */
export function turnFinalText(session: AgentLike['session'], turn: unknown): string | undefined {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  let found: string | undefined;
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue;
    if (turn !== undefined && event.turn !== turn) continue;
    if (event.interrupted === true) continue;
    found = blocksToText(event.message?.content);
  }
  return found;
}

export function apply(ctx: PluginContext, config: EngramConfig): void {
  const log: Logger = loggerFrom(ctx);
  const envProject = typeof process.env.ENGRAM_PROJECT === 'string' ? process.env.ENGRAM_PROJECT : undefined;
  const registeredNames = new Set<string>();
  const agents = new Map<string, AgentLike>();
  let toolsRegistered = false;
  let degradedLogged = false;

  const pool = new ConnectionPool({
    maxConnections: config.poolMaxConnections,
    maxIdleMs: config.poolMaxIdleMs,
    log,
    connect: (workspace) =>
      McpClient.connect({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: workspace,
        requestTimeoutMs: config.toolCallTimeoutMs,
        clientName: name,
        logger: log,
      }),
  });
  ctx.effect(() => () => pool.dispose(), 'engram-bridge.pool');

  let disposers: Array<() => void> = [];
  let registeredSurface: readonly McpToolDeclaration[] = [];
  const registerTools = (declarations: readonly McpToolDeclaration[], origin: string): void => {
    if (declarations.length === 0) return;
    if (toolsRegistered) {
      if (!sameToolSurface(registeredSurface, declarations)) {
        log.warn(
          `engram tool surface changed after registration (${registeredSurface.length} -> ${declarations.length}); keeping the first set`,
        );
      }
      return;
    }
    toolsRegistered = true;
    registeredSurface = declarations;
    disposers = buildToolDefinitions(declarations, { timeoutMs: config.toolCallTimeoutMs, run }).map((definition) => {
      registeredNames.add(definition.name);
      return ctx.tools.register(definition);
    });
    log.info(`registered ${registeredNames.size} engram tools (${origin})`);
  };

  const callOnWorkspace = async (
    workspace: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> => {
    try {
      const entry = await pool.acquire(workspace);
      registerTools(entry.tools, `workspace ${workspace}`);
      return await entry.client.callTool(toolName, args, signal);
    } catch (error) {
      if (!degradedLogged) {
        degradedLogged = true;
        log.error(`engram unavailable for workspace ${workspace}: ${errorMessage(error)}`);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  };

  const bindings = new SessionBindings({
    pool,
    log,
    call: (workspace, tool, args, signal) => callOnWorkspace(workspace, tool, args, signal),
  });

  const injectionInputs = (site: ToolCallSite, sessionProject: string | undefined): InjectionInputs => ({
    workspace: site.workspace,
    sessionId: site.sessionId,
    sessionProject,
    overrides: config.projectOverrides,
    envProject,
    injectProject: config.injectSessionProject,
    injectSessionId: config.injectSessionId,
  });

  async function run(
    site: ToolCallSite,
    declaration: McpToolDeclaration,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<McpCallResult> {
    // Binding is a barrier: engram hard-fails writes naming an unknown session.
    const binding: Binding = await bindings.ensure(site.sessionId, site.workspace);
    const finalArgs = applyInjection(declaration, args, injectionInputs(site, binding.project));
    if (declaration.name === 'mem_session_start') {
      // The bridge owns session identity; never let the model rebind it.
      finalArgs.id = site.sessionId;
    }
    return await callOnWorkspace(site.workspace, declaration.name, finalArgs, signal);
  }

  const capture = new PassiveCapture({
    enabled: config.capturePassive,
    log,
    call: (sessionId, tool, args, signal) => {
      const agent = agents.get(sessionId);
      const workspace = agent?.session?.header?.cwd;
      if (typeof workspace !== 'string' || workspace === '') {
        return Promise.reject(new Error(`no workspace for session ${sessionId}`));
      }
      return callOnWorkspace(workspace, tool, args, signal);
    },
  });

  const compaction = new CompactionRecovery({
    enabled: config.compactionRecovery,
    tokenBudget: config.recoveryTokenBudget,
    log,
    resolveProject: (sessionId) => bindings.peek(sessionId)?.project,
    call: (sessionId, tool, args, signal) => {
      const agent = agents.get(sessionId);
      const workspace = agent?.session?.header?.cwd;
      if (typeof workspace !== 'string' || workspace === '') {
        return Promise.reject(new Error(`no workspace for session ${sessionId}`));
      }
      return callOnWorkspace(workspace, tool, args, signal);
    },
    inject: (sessionId, text) => {
      const agent = agents.get(sessionId);
      if (typeof agent?.inject !== 'function') {
        log.warn(`no live agent for session ${sessionId}; skipping post-compaction recall`);
        return;
      }
      try {
        agent.inject(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: name },
          }),
        );
      } catch (error) {
        log.warn(`post-compaction recall injection failed for session ${sessionId}: ${errorMessage(error)}`);
      }
    },
  });

  ctx.on('agent/session-start', (...args: never[]) => {
    const payload = args[0] as { agent?: AgentLike } | undefined;
    const agent = payload?.agent;
    const header = agent?.session?.header;
    const sessionId = typeof header?.id === 'string' ? header.id : undefined;
    const workspace = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
    if (sessionId === undefined || workspace === undefined) return;
    agents.set(sessionId, agent as AgentLike);
    if (isSubagentSession(header)) return;
    void bindings
      .ensure(sessionId, workspace)
      .then(() => {
        const entry = pool.peek(workspace);
        if (entry !== undefined) registerTools(entry.tools, `workspace ${workspace}`);
      })
      .catch((error: unknown) => {
        if (!degradedLogged) {
          degradedLogged = true;
          log.error(`engram unavailable for workspace ${workspace}: ${errorMessage(error)}`);
        }
      });
  });

  ctx.on('agent/created', (...args: never[]) => {
    const payload = args[0] as { agent?: AgentLike } | undefined;
    const agent = payload?.agent;
    if (agent === undefined || !isSubagentSession(agent.session?.header)) return;
    shadowEngramTools(agent as never, [...registeredNames], log);
  });

  ctx.on('agent/turn-stopping', (...args: never[]) => {
    const payload = args[0] as { agent?: AgentLike; turn?: unknown; signal?: AbortSignal } | undefined;
    const agent = payload?.agent;
    const header = agent?.session?.header;
    const sessionId = typeof header?.id === 'string' ? header.id : undefined;
    if (sessionId === undefined || isSubagentSession(header)) return;
    const turn = typeof payload?.turn === 'number' ? payload.turn : -1;
    const text = turnFinalText(agent?.session, turn);
    if (text === undefined) return;
    void capture.capture(sessionId, turn, text, payload?.signal);
  });

  ctx.on('session/event', (...args: never[]) => {
    const session = args[0] as { header?: { id?: unknown } } | undefined;
    const event = args[1] as SessionEventLike | undefined;
    const sessionId = typeof session?.header?.id === 'string' ? session.header.id : undefined;
    if (sessionId === undefined || event === undefined) return;
    if (event.type === 'compaction/summary') {
      const compactionId = String(event.compactionId ?? '');
      if (compactionId === '') return;
      void compaction.onSummary(sessionId, compactionId, blocksToText(event.summary));
      return;
    }
    if (event.type === 'compaction/end') {
      const compactionId = String(event.compactionId ?? '');
      if (compactionId === '') return;
      void compaction.onEnd(sessionId, compactionId, event.error !== undefined);
    }
  });

  ctx.effect(
    () => () => {
      bindings.dispose();
      agents.clear();
      for (const dispose of disposers) dispose();
      disposers = [];
      toolsRegistered = false;
      registeredNames.clear();
    },
    'engram-bridge.state',
  );

  // Capability discovery at load: engram's tool list does not depend on the
  // workspace, and a per-workspace connection cannot be established before a
  // session's FIRST model request (acceptance probe: session-start 67.8ms,
  // first request 137.4ms; a spawn+handshake costs ~100-300ms). One
  // short-lived child with a neutral cwd registers the tool surface early; it
  // binds no session and calls no tool. Workspace connections stay lazy, and a
  // later successful connection self-heals a failed discovery.
  // Synchronous cache warm-up: a previous successful discovery lets the very
  // first request of a cold run already carry the tool surface (see tool-cache).
  const fingerprint = toolCacheFingerprint(config.command, config.args);
  const cachePath = toolCachePath();
  const cached = readToolCache(cachePath, fingerprint);
  if (cached !== undefined) registerTools(cached, 'cache');

  let discoverySettled = false;
  const discovery = (async (): Promise<void> => {
    let client: McpClient | undefined;
    try {
      client = await pool.runExclusive(() =>
        McpClient.connect({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: homedir(),
          requestTimeoutMs: config.toolCallTimeoutMs,
          clientName: name,
          logger: log,
        }),
      );
      registerTools(client.tools, 'discovery');
      writeToolCache(cachePath, fingerprint, client.tools);
    } catch (error) {
      if (!degradedLogged) {
        degradedLogged = true;
        log.error(`engram unavailable at load: ${errorMessage(error)}`);
      }
    } finally {
      client?.close();
      discoverySettled = true;
    }
  })();

  // No hook can influence a step's tool list: it is frozen when that step's
  // system prompt is assembled, before any listener runs (dsh-agent-loop:
  // preStep assembles at :502, the pre-step waterfall at :506, and
  // `buildRequest(..., assembly.tools, ...)` at :619). Gating `agent/request`
  // or `agent/pre-step` on discovery was measured to have no effect on the
  // first request's tool list. What makes the first request deterministic is
  // the synchronous cache warm-up above; discovery then refreshes it.

  // Fail loud on unusable configuration, never at call time.
  if (config.command.trim() === '') throw new Error('engram-bridge: config.command is required');
  chooseProject(injectionInputs({ sessionId: '', workspace: '' }, undefined));
}
