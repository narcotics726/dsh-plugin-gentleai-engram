import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply } from '../dist/index.js';
import { injectionForTool } from '../dist/injection.js';
import { expectedOf, fakeModelDir, removeDir, tempDir, writeSource } from './recall-support.ts';

/**
 * Wiring tests for the retrieval entry point.
 *
 * The read layer is exercised end to end through the REAL plugin entry: the tool
 * is registered alongside the engram surface, the session project reaches the
 * search even though the model is a stub, and the refusal path (project
 * injection off) never starts a search at all.
 *
 * The embedding runtime is the synthetic stub from test/ort-stub.mjs, so no
 * model is needed; `dim` is inferred from the index, which is why a 4-wide stub
 * vector is enough.
 */

const repo = process.cwd();
const stubPath = join(repo, 'test', 'engram-stub.mjs');
const ortStub = readFileSync(join(repo, 'test', 'ort-stub.mjs'), 'utf8');

interface HostLog {
  info: string[];
  warn: string[];
  error: string[];
}

interface FakeHost {
  ctx: never;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  registrations: Map<string, { parameters?: unknown; execute?: unknown; output?: unknown; timeoutMs?: number }>;
  /** Definitions the plugin registered through the host's command registry. */
  commands: Array<{ name: string; description: string; recordInput?: boolean }>;
  logs: HostLog;
  disposeAll(): void;
}

function fakeHost(options: { withCommands?: boolean } = {}): FakeHost {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registrations = new Map<string, { parameters?: unknown; execute?: unknown; output?: unknown; timeoutMs?: number }>();
  const commands: Array<{ name: string; description: string; recordInput?: boolean }> = [];
  const logs: HostLog = { info: [], warn: [], error: [] };
  const disposers: Array<() => void> = [];
  const ctx: Record<string, unknown> = {
    logger: {
      debug(): void {},
      info: (message: string) => logs.info.push(message),
      warn: (message: string) => logs.warn.push(message),
      error: (message: string) => logs.error.push(message),
    },
    on(event: string, listener: (...args: unknown[]) => unknown): () => void {
      handlers.set(event, listener);
      return () => handlers.delete(event);
    },
    effect(callback: () => (() => void) | void): () => void {
      const dispose = callback();
      const run = (): void => {
        dispose?.();
      };
      disposers.push(run);
      return run;
    },
    tools: {
      register(definition: { name: string }): () => void {
        registrations.set(definition.name, definition as never);
        return () => {};
      },
    },
  };
  if (options.withCommands === true) {
    // Optional service injection, as cordis does it: the child context only
    // exists when the service does. The optional services this plugin uses are
    // a CLOSED SET; `commands` is the one this rig provides, and the protocol
    // services stay absent so their registrations take the no-service path.
    const OPTIONAL_SERVICES = ['commands', 'skills', 'systemPrompt'];
    ctx.inject = (deps: readonly string[], callback: (ctx: unknown) => void): void => {
      for (const dep of deps) {
        assert.ok(OPTIONAL_SERVICES.includes(dep), `unexpected optional injection: ${dep}`);
      }
      const child: Record<string, unknown> = { ...ctx };
      if (deps.includes('commands')) {
        child.commands = {
          register(definition: { name: string; description: string; recordInput?: boolean }): () => void {
            commands.push(definition);
            return () => {};
          },
        };
      }
      callback(child);
    };
  }
  return {
    ctx: ctx as never,
    handlers,
    registrations,
    commands,
    logs,
    disposeAll(): void {
      for (const dispose of [...disposers].reverse()) dispose();
      disposers.length = 0;
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor 超时');
}

interface Rig {
  host: FakeHost;
  temp: string;
  cleanup(): Promise<void>;
}

async function rig(
  options: {
    injectSessionProject?: boolean;
    searchEnabled?: boolean;
    withCommands?: boolean;
    rows?: Parameters<typeof writeSource>[1];
  } = {},
): Promise<Rig> {
  const temp = mkdtempSync(join(tmpdir(), 'recall-wiring-'));
  const dshHome = join(temp, 'dsh-home');
  const callsPath = join(temp, 'calls.jsonl');
  const dbPath = join(temp, 'engram.db');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  writeSource(
    dbPath,
    options.rows ?? [
      // The stub engram resolves the session project to `stub-project`, so the
      // default-isolation assertion has to be about THAT project.
      { id: 1, title: '读层', content: '派生索引只读。', type: 'decision', project: 'stub-project' },
      { id: 2, title: 'other', content: 'another project row', type: 'discovery', project: 'beta' },
    ],
  );
  const host = fakeHost({ withCommands: options.withCommands });
  const config = {
    command: process.execPath,
    args: [stubPath],
    env: { ENGRAM_STUB_LOG: callsPath },
    toolCallTimeoutMs: 10000,
    poolMaxConnections: 2,
    poolMaxIdleMs: 60000,
    poolSweepIntervalMs: 60000,
    projectOverrides: {} as Record<string, string>,
    injectSessionProject: options.injectSessionProject ?? true,
    injectSessionId: true,
    capturePassive: true,
    compactionRecovery: true,
    recoveryTokenBudget: 800,
    recallWakeup: true,
    searchEnabled: options.searchEnabled ?? true,
    searchDbPath: dbPath,
    searchIndexDir: join(temp, 'index'),
    searchModelDir: fakeModelDir(temp, { ortEntrySource: ortStub }),
    embedThreads: 1,
    searchIdleMs: 60000,
    searchSweepIntervalMs: 60000,
    searchTimeoutMs: 30000,
    searchW: 0.2,
    searchTopK: 50,
    searchCoverage: 'field_cov' as const,
  };
  const modelDir = config.searchModelDir;
  // The plugin's read layer judges each spawn against the declared identity;
  // this wiring test runs on a synthetic fixture, so it injects the matching
  // one through the test-only dependency seam (design D11).
  apply(host.ctx, config, { expectedModel: expectedOf(modelDir) });
  return {
    host,
    temp,
    cleanup: async () => {
      host.disposeAll();
      // The worker is spawned by the plugin; give teardown a moment to finish.
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

/** Drive a session through the host so the plugin binds the session project. */
async function startSession(host: FakeHost, sessionId: string): Promise<void> {
  const ctx = new Context();
  const store = new SessionStore(ctx);
  const session = store.create(sessionId, { meta: { cwd: repo } });
  const agent = { session };
  await host.handlers.get('agent/session-start')?.({ agent });
  await waitFor(() => host.registrations.has('mcp__engram__mem_bridge_recall'));
}

async function callRecall(
  host: FakeHost,
  args: Record<string, unknown>,
): Promise<unknown> {
  const definition = host.registrations.get('mcp__engram__mem_bridge_recall')!;
  const execute = definition.execute as (args: unknown, exec: unknown) => Promise<unknown>;
  const ctx = new Context();
  const store = new SessionStore(ctx);
  const session = store.create('stub-recall', { meta: { cwd: repo } });
  return await execute(args, { agent: { session }, signal: undefined });
}

test('wiring: 读层工具与 engram 工具面一起注册，注册面 = 声明面 − 不注册 + 1', async () => {
  const r = await rig();
  try {
    await startSession(r.host, 'stub-recall');
    const names = [...r.host.registrations.keys()];
    assert.ok(names.includes('mcp__engram__mem_bridge_recall'), '必须注册插件自有的检索入口');
    assert.ok(!names.includes('mcp__engram__mem_search'), '被取代的检索工具不得注册');
    assert.ok(!names.includes('mcp__engram__mem_capture_passive'));
    assert.ok(!names.includes('mcp__engram__mem_save_prompt'));
    // 绝对计数由**真实** engram 工具面的活宿主验收（tasks 8.1）判定；这里断言的是关系：
    // 注册面 = 声明面 − 刻意不注册 + 2 个插件自有工具（检索 + 显式入口）。
    assert.equal(
      names.filter((name) => name.startsWith('mcp__engram__')).length,
      6,
      `本 stub 声明 7 个工具、刻意不注册 3 个，加上两个自有工具应为 6，实际 ${names.length}：${names.join(',')}`,
    );
    assert.ok(
      names.includes('mcp__engram__mem_bridge_recall_sync'),
      '显式入口必须与检索工具一起注册',
    );
    const syncDefinition = r.host.registrations.get('mcp__engram__mem_bridge_recall_sync')!;
    assert.equal(syncDefinition.timeoutMs, 600_000, '显式入口的静态超时就是它的容量来源');
    assert.deepEqual(
      (syncDefinition.parameters as { required?: string[] }).required,
      [],
      '显式入口没有参数：调用方唯一的决定是要不要等',
    );
    // 自己的规范化值 + 自己的 output.schema，而不是伪装成 MCP 结果。
    const definition = r.host.registrations.get('mcp__engram__mem_bridge_recall')!;
    assert.ok(definition.output !== undefined);
    const schema = (definition.output as { schema: { properties: Record<string, unknown> } }).schema;
    assert.ok(Object.hasOwn(schema.properties, 'hits'));
    assert.ok(!Object.hasOwn(schema.properties, 'content'), '读层不得复用 MCP 结果形状');
  } finally {
    await r.cleanup();
  }
});

test('wiring: 会话项目经注入进入检索，默认只返回当前项目', async () => {
  const r = await rig();
  try {
    await startSession(r.host, 'stub-recall');
    const payload = (await callRecall(r.host, { query: '派生索引', limit: 5 })) as {
      hits: Array<{ id: number; project: string }>;
    };
    assert.ok(payload.hits.length > 0, '应有结果');
    assert.ok(
      payload.hits.every((hit) => hit.project === 'stub-project'),
      `默认隔离必须生效，实际：${JSON.stringify(payload.hits)}`,
    );

    const across = (await callRecall(r.host, { query: '派生索引', limit: 5, all_projects: true })) as {
      hits: Array<{ id: number; project: string }>;
    };
    assert.ok(across.hits.some((hit) => hit.project === 'beta'), '显式跨项目应能看到其他项目');
  } finally {
    await r.cleanup();
  }
});

test('wiring: 项目注入关闭且未显式指定项目时拒绝检索（D3），不跨项目运行', async () => {
  const r = await rig({ injectSessionProject: false });
  try {
    await startSession(r.host, 'stub-recall');
    await assert.rejects(
      () => callRecall(r.host, { query: '派生索引', limit: 5 }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /injectSessionProject/);
        assert.match(message, /显式传 project/);
        assert.match(message, /all_projects/);
        return true;
      },
    );
    // 显式传值仍然可用（两条出路之一）。
    const payload = (await callRecall(r.host, { query: '派生索引', limit: 5, project: 'stub-project' })) as {
      hits: Array<{ id: number }>;
    };
    assert.equal(payload.hits[0]!.id, 1);
  } finally {
    await r.cleanup();
  }
});

test('wiring: 引擎开关关闭时在调用点拒绝，且没有发生任何检索工作', async () => {
  const r = await rig({ searchEnabled: false });
  try {
    await startSession(r.host, 'stub-recall');
    // 工具面不受开关影响：注册仍然发生。
    assert.ok(r.host.registrations.has('mcp__engram__mem_bridge_recall'));
    await assert.rejects(
      () => callRecall(r.host, { query: '派生索引', limit: 5 }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /searchEnabled/);
        assert.match(message, /没有执行任何检索/);
        assert.match(message, /不会静默改用/);
        return true;
      },
    );
    assert.ok(
      !existsSync(join(r.temp, 'index')),
      '被拒绝的调用不得建立派生索引：没有发生任何检索工作',
    );
  } finally {
    await r.cleanup();
  }
});

test('wiring: 子 agent 的可见性限制覆盖插件自有工具', async () => {
  const r = await rig();
  try {
    await startSession(r.host, 'stub-recall');
    const restricts: string[][] = [];
    const guards: Array<(execution: { name?: unknown }) => string | undefined> = [];
    const agentCtx = {
      effect(callback: () => (() => void) | void): () => void {
        callback();
        return () => {};
      },
      tools: {
        restrict(filter: { deny?: readonly string[] }): () => void {
          restricts.push([...(filter.deny ?? [])]);
          return () => {};
        },
        guard(guard: (execution: { name?: unknown }) => string | undefined): () => void {
          guards.push(guard);
          return () => {};
        },
      },
    };
    const subagent = { session: { header: { origin: 'subagent' } }, ctx: agentCtx };
    await r.host.handlers.get('agent/created')?.({ agent: subagent });
    const denied = restricts.flat();
    assert.ok(denied.includes('mcp__engram__mem_bridge_recall'), '子 agent 的拒绝清单应包含自有检索工具');
    assert.ok(
      denied.includes('mcp__engram__mem_bridge_recall_sync'),
      '子 agent 的拒绝清单也应包含显式入口',
    );
    assert.ok(guards.length > 0);
    assert.match(
      guards[0]!({ name: 'mcp__engram__mem_bridge_recall' }) ?? '',
      /not available to sub-agents/,
    );
  } finally {
    await r.cleanup();
  }
});

test('[6.3] 操作者命令：在 apply 时就注册（独立于工具声明），元数据可被宿主校验', async () => {
  const r = await rig({ withCommands: true });
  try {
    // No session has run, so the engram tool surface may not exist — the repair
    // path must already be there regardless.
    assert.equal(r.host.commands.length, 1, '命令必须在 apply 时注册，不能等工具面');
    const definition = r.host.commands[0]!;
    assert.equal(definition.name, 'engram-sync');
    assert.equal(definition.recordInput, false);
    assert.ok(definition.description.length > 0);
  } finally {
    await r.cleanup();
  }
});

test('[6.3] 宿主没有 commands 服务：桥照常加载，只是没有这条命令', async () => {
  const r = await rig();
  try {
    await startSession(r.host, 'stub-recall');
    assert.equal(r.host.commands.length, 0, '没有服务就没有命令');
    assert.ok(r.host.registrations.has('mcp__engram__mem_bridge_recall'), '其余能力不受影响');
    assert.ok(r.host.registrations.has('mcp__engram__mem_bridge_recall_sync'));
    assert.deepEqual(r.host.logs.error, []);
  } finally {
    await r.cleanup();
  }
});

test('wiring: 注入判定只看工具自己声明的参数', () => {  assert.deepEqual(
    injectionForTool({ name: 'mem_bridge_recall', inputSchema: { type: 'object', properties: { query: {}, project: {} } } as never }),
    { project: true, sessionId: false, directory: false },
  );
  assert.deepEqual(
    injectionForTool({ name: 'own_tool_without_project', inputSchema: { type: 'object', properties: { query: {} } } as never }),
    { project: false, sessionId: false, directory: false },
  );
});

test('wiring: 派生状态目录可配置，索引落在配置的位置', async () => {
  const dir = tempDir('recall-index-dir-');
  try {
    const { RecallEngine } = await import('../dist/recall/engine.js');
    const { fakeEmbedder } = await import('./recall-support.ts');
    const dbPath = join(dir, 'engram.db');
    writeSource(dbPath, [{ id: 1, title: 't', content: 'c', project: 'alpha' }]);
    const engine = new RecallEngine({
      dbPath,
      indexPath: join(dir, 'custom', 'index.db'),
      w: 0.2,
      topK: 50,
      coverage: 'field_cov',
      embedder: async () => fakeEmbedder({ dim: 4 }),
    });
    await engine.rebuild();
    assert.ok(existsSync(join(dir, 'custom', 'index.db')), '索引必须落在 searchIndexDir 指定的位置');
    engine.close();
  } finally {
    removeDir(dir);
  }
});
