import { homedir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { SessionBindings, type Binding } from './bindings.js';
import { PassiveCapture } from './capture.js';
import { CompactionRecovery } from './compaction.js';
import {
  Config,
  defaultSearchDbPath,
  defaultSearchIndexDir,
  defaultSearchModelDir,
  type Config as EngramConfig,
} from './config.js';
import { applyInjection, chooseProject, type InjectionInputs } from './injection.js';
import { blocksToText, EventShapeWarnings, readEventPayload, turnFinalText, type SessionEventLike } from './host-events.js';
import { errorMessage, loggerFrom, type Logger } from './log.js';
import { McpClient, type McpCallResult, type McpToolDeclaration } from './mcp-client.js';
import { ConnectionPool } from './pool.js';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { RecallProcessManager, RecallUnavailableError, ONESHOT_TIMEOUT_MS } from './recall/process.js';
import type { ExpectedIdentity } from './recall/model-expected.js';
import type { RecallPayload, RecallQuery } from './recall/protocol.js';
import { buildRecallCommandDefinition } from './recall-command.js';
import {
  buildRecallSyncToolDefinition,
  buildRecallToolDefinition,
  RECALL_INPUT_SCHEMA,
  RECALL_SYNC_TOOL_NAME,
  RECALL_SYNC_INPUT_SCHEMA,
  RECALL_TOOL_NAME,
} from './recall-tool.js';
import { guardEngramTools, isSubagentSession, shadowEngramTools, TOOL_PREFIX } from './subagent.js';
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

export { turnFinalText };

interface AgentLike {
  session?: { header?: { id?: unknown; cwd?: string; origin?: unknown; delegationDepth?: unknown }; snapshotEvents?: () => readonly unknown[] };
  inject?: (message: unknown) => void;
  send?: (message: unknown, target: string, wakeup: boolean) => void;
  ctx?: Parameters<typeof shadowEngramTools>[0] extends infer T ? T : never;
}

interface PluginContext {
  logger?: HostLogger;
  on(event: string, listener: (...args: never[]) => unknown): unknown;
  effect(callback: () => (() => void) | void, label?: string): unknown;
  tools: { register(definition: ToolDefinition): () => void };
  /**
   * Cordis service injection. Optional on purpose: the operator command is a
   * repair tool, so a host without the commands service must still load the
   * bridge — it simply has no such command. Putting `commands` in the plugin's
   * own `inject` would make the WHOLE plugin inactive in such a profile.
   */
  inject?(deps: readonly string[], callback: (ctx: PluginContext) => void): unknown;
  commands?: { register(definition: CommandDefinition): () => void };
}

/**
 * Injectable seams, for tests only.
 *
 * Cordis calls a plugin as `(ctx, config)` — there is no third argument on the
 * production path — so nothing here can be reached from a user's configuration.
 * That is the point: the read layer's fixtures are synthetic bytes, so tests
 * must be able to inject a matching expected identity, while the judgement
 * itself must stay "the repository's declaration", never "what the user said"
 * (design D11). Hence a dependency, not a `Config` key.
 */
export interface PluginDeps {
  expectedModel?: ExpectedIdentity;
}

export function apply(ctx: PluginContext, config: EngramConfig, deps: PluginDeps = {}): void {
  const log: Logger = loggerFrom(ctx);
  const shapeWarnings = new EventShapeWarnings((message) => log.warn(message));
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

  // Idle reclaim is plugin-driven: nothing else calls sweep(), so before this timer existed a
  // quiet process kept every child alive (spec: 空闲回收由插件自主驱动).
  ctx.effect(
    () => {
      if (config.poolMaxIdleMs <= 0) return; // 0 disables idle reclaim entirely
      // A directly-constructed config (tests, embedders) can omit the key; never hand
      // `undefined` to setInterval, which degrades into a ~1ms busy poll.
      const intervalMs = Math.max(1000, config.poolSweepIntervalMs ?? 60000);
      const timer = setInterval(() => {
        const closed = pool.sweep();
        if (closed.length > 0) log.debug(`closed ${closed.length} idle engram connection(s)`);
      }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    'engram-bridge.pool-sweep',
  );

  // ---- read layer (derived, read-only, outside the engram connection pool) ---
  // The resident recall worker is a SEPARATE lifecycle from the engram pool: it
  // serves a derived local index, needs its own threads/memory budget, and is
  // reclaimed on its own clock. Sharing `poolMaxIdleMs`/`poolSweepIntervalMs`
  // would put two unrelated resources behind one knob.
  const recallDeclaration: McpToolDeclaration = {
    name: 'mem_bridge_recall',
    inputSchema: RECALL_INPUT_SCHEMA as McpToolDeclaration['inputSchema'],
  };
  const recallManager = new RecallProcessManager({
    dbPath: config.searchDbPath ?? defaultSearchDbPath(),
    indexPath: join(config.searchIndexDir ?? defaultSearchIndexDir(), 'index.db'),
    modelDir: config.searchModelDir ?? defaultSearchModelDir(),
    threads: config.embedThreads ?? 1,
    w: config.searchW ?? 0.2,
    topK: config.searchTopK ?? 50,
    coverage: config.searchCoverage ?? 'field_cov',
    idleMs: config.searchIdleMs ?? 600000,
    timeoutMs: config.searchTimeoutMs ?? 60000,
    log,
    expected: deps.expectedModel,
  });
  ctx.effect(() => () => void recallManager.dispose(), 'engram-bridge.recall-process');
  ctx.effect(
    () => {
      if ((config.searchIdleMs ?? 600000) <= 0) return; // 0 disables idle reclaim
      const intervalMs = Math.max(1000, config.searchSweepIntervalMs ?? 60000);
      const timer = setInterval(() => {
        if (recallManager.sweep() > 0) log.debug('reclaimed the idle recall worker');
      }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    'engram-bridge.recall-sweep',
  );

  // The operator path (design D8): a human command, registered through an
  // OPTIONAL injection of the host's command registry. Two things are load
  // bearing here. It must not live inside `registerTools()` — that function
  // returns early when the engram tool surface is empty (cold tool cache), and
  // the repair path is exactly what is needed in that state. And it must not be
  // registered on a ctx that did not inject `commands`: cordis's ctx proxy
  // throws when reading a service it was not given, which would take the whole
  // plugin down in a profile without that service.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (commandCtx) => {
      const commands = commandCtx.commands;
      if (commands === undefined) return;
      commandCtx.effect(
        () =>
          commands.register(
            buildRecallCommandDefinition({
              run: (exec) => recallManager.syncUnbounded(exec.signal),
            }),
          ),
        'engram-bridge.command',
      );
    });
  } else {
    // Optional capability absent: the bridge is fully functional, it just has no
    // operator command. Not a warning — a host without the registry is legal.
    log.debug('宿主没有 commands 注入点：操作者命令未注册（其余能力不受影响）');
  }

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
    // The plugin's own retrieval entry point joins the same registration pass, so
    // the surface has exactly one lifecycle: registered together, removed
    // together. Its name shares the `mcp__engram__` prefix, so the sub-agent
    // visibility restriction already covers it.
    const recallDefinition = buildRecallToolDefinition({
      // Slightly larger than the worker's own budget so our clearer timeout
      // message wins the race against the host's generic one.
      timeoutMs: config.searchTimeoutMs + 10000,
      run: runRecall,
    });
    registeredNames.add(recallDefinition.name);
    disposers.push(ctx.tools.register(recallDefinition));
    // The explicit entry lives beside retrieval and shares its lifecycle. Its
    // declared timeout IS its capacity: one number, one meaning (design D7).
    const syncDefinition = buildRecallSyncToolDefinition({
      timeoutMs: ONESHOT_TIMEOUT_MS,
      run: runRecallSync,
    });
    registeredNames.add(syncDefinition.name);
    disposers.push(ctx.tools.register(syncDefinition));
    log.info(`registered ${registeredNames.size} engram tools (${origin})`);
    // Registration can finish after a sub-agent was created: at creation time there were no
    // names to deny, so the visibility restriction has to be re-applied now.
    for (const agent of agents.values()) {
      if (isSubagentSession(agent.session?.header)) shadowEngramTools(agent as never, [...registeredNames], log);
    }
  };

  const callOnWorkspace = async (
    workspace: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> => {
    try {
      return await pool.withConnection(workspace, async (entry) => {
        registerTools(entry.tools, `workspace ${workspace}`);
        return await entry.client.callTool(toolName, args, signal);
      });
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

  /**
   * Retrieval entry point. Three things are decided here rather than deeper,
   * because they are policy and the worker only knows mechanics:
   *
   *  1. the engine switch is checked at the CALL SITE, so flipping it never
   *     changes the tool surface and never silently substitutes another
   *     retriever;
   *  2. when project injection is off, or the project simply cannot be resolved,
   *     the call is REJECTED instead of running unrestricted — a default that
   *     silently stops isolating is worse than a loud refusal (design D3);
   *  3. `project` goes through the same injection path as the engram tools, so an
   *     explicit caller value always wins.
   */
  /**
   * Retrieval's engine switch, checked at the call site for the MODEL-FACING
   * entries (retrieval and the explicit catch-up tool). The operator command
   * deliberately does not use it: it is the repair path, and a disabled
   * retriever is exactly when it may be needed (design D8).
   */
  function assertModelFacingEnabled(): void {
    if (config.searchEnabled === false) {
      throw new RecallUnavailableError(
        'disabled',
        'engram-bridge: 检索能力已关闭（searchEnabled=false）。本次调用没有执行任何检索，' +
          '也不会静默改用别的检索实现。',
      );
    }
  }

  async function runRecall(
    request: RecallQuery,
    exec: { agent?: unknown; signal?: AbortSignal },
  ): Promise<RecallPayload> {
    assertModelFacingEnabled();
    const wantsAll = request.allProjects === true;
    if (!wantsAll && request.project === undefined && config.injectSessionProject === false) {
      throw new RecallUnavailableError(
        'project-unknown',
        'engram-bridge: 项目注入已关闭（injectSessionProject=false），且本次调用没有显式指定 project，' +
          '无法把检索限定在某个项目上。为保持"默认只返回当前项目"，本次检索被拒绝。' +
          '两条出路：显式传 project，或打开 injectSessionProject；也可以传 all_projects: true 明确要求跨项目。',
      );
    }
    const site = siteOf(exec as { agent?: unknown });
    let sessionProject: string | undefined = bindings.peek(site.sessionId)?.project;
    if (sessionProject === undefined && config.injectSessionProject !== false) {
      try {
        sessionProject = (await bindings.ensure(site.sessionId, site.workspace)).project;
      } catch {
        // Left undefined on purpose: the call below then fails loudly with a
        // "cannot determine the project" reason rather than running unrestricted.
      }
    }
    const injected = applyInjection(
      recallDeclaration,
      { ...request, ...(request.project === undefined ? {} : { project: request.project }) },
      injectionInputs(site, sessionProject),
    );
    const project = typeof injected.project === 'string' && injected.project !== '' ? injected.project : undefined;
    if (!wantsAll && project === undefined) {
      throw new RecallUnavailableError(
        'project-unknown',
        'engram-bridge: 项目限定无从判定（会话项目尚未解析出，也没有 projectOverrides / ENGRAM_PROJECT）。' +
          '为保持"默认只返回当前项目"，本次检索被拒绝。两条出路：显式传 project，或传 all_projects: true 明确跨项目。',
      );
    }
    return await recallManager.query({
      ...request,
      project,
      ...(wantsAll ? { allProjects: true } : {}),
    });
  }

  /**
   * The model-facing explicit entry: one capped catch-up. It is bounded by the
   * tool's own static timeout, which is also where its capacity comes from.
   */
  async function runRecallSync(_exec: { agent?: unknown; signal?: AbortSignal }): Promise<string> {
    assertModelFacingEnabled();
    return await recallManager.catchUp();
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
    // Directly-constructed configs (tests, embedders) can omit the key; fall back to the schema
    // default rather than letting `undefined` decide whether the driver gets woken.
    recallWakeup: config.recallWakeup ?? true,
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
    deliver: (sessionId, text, target, wakeup) => {
      const agent = agents.get(sessionId);
      if (typeof agent?.send !== 'function') {
        // Falling back to `agent.inject()` (send with wakeup=false) would silently reproduce the
        // parked-recall bug this path exists to fix, so a host without `send` is reported instead.
        log.warn(`no live agent with send() for session ${sessionId}; post-compaction recall was not delivered`);
        return;
      }
      try {
        agent.send(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: name },
          }),
          target,
          wakeup,
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
    // Two independent halves: the guard holds no matter when registration happens, the
    // restriction hides the tools once their names are known.
    guardEngramTools(agent as never, log);
    shadowEngramTools(agent as never, [...registeredNames], log);
  });

  ctx.on('agent/turn-stopping', (...args: never[]) => {
    const payload = args[0] as { agent?: AgentLike; turn?: unknown; signal?: AbortSignal } | undefined;
    const agent = payload?.agent;
    const header = agent?.session?.header;
    const sessionId = typeof header?.id === 'string' ? header.id : undefined;
    if (sessionId === undefined || isSubagentSession(header)) return;
    const turn = typeof payload?.turn === 'number' ? payload.turn : -1;
    const text = turnFinalText(agent?.session, turn, shapeWarnings);
    if (text === undefined) return;
    void capture.capture(sessionId, turn, text, payload?.signal);
  });

  ctx.on('session/event', (...args: never[]) => {
    const session = args[0] as { header?: { id?: unknown } } | undefined;
    const event = args[1] as SessionEventLike | undefined;
    const sessionId = typeof session?.header?.id === 'string' ? session.header.id : undefined;
    if (sessionId === undefined || event === undefined) return;
    if (event.type === 'compaction/summary') {
      const data = readEventPayload(event, 'compaction/summary', (detail) =>
        shapeWarnings.report(sessionId, 'compaction/summary', detail),
      );
      if (data === undefined) return;
      void compaction.onSummary(sessionId, data.compactionId, blocksToText(data.summary));
      return;
    }
    if (event.type === 'compaction/end') {
      const data = readEventPayload(event, 'compaction/end', (detail) =>
        shapeWarnings.report(sessionId, 'compaction/end', detail),
      );
      if (data === undefined) return;
      void compaction.onEnd(sessionId, data.compactionId, data.error !== undefined, data.turn);
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
