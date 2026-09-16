import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply } from '../dist/index.js';

/**
 * Wiring tests against a STUB engram (test/engram-stub.mjs) and the HOST's real session
 * store. The two seams the P0 delivery left dead — passive capture and compaction recovery —
 * plus the sub-agent isolation halves are asserted here, in the default gate.
 */

const repo = process.cwd();
const stubPath = join(repo, 'test', 'engram-stub.mjs');

interface HostLog {
  info: string[];
  warn: string[];
  error: string[];
}

interface FakeHost {
  ctx: never;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  registrations: string[];
  logs: HostLog;
  disposeAll(): void;
}

function fakeHost(): FakeHost {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registrations: string[] = [];
  const logs: HostLog = { info: [], warn: [], error: [] };
  const disposers: Array<() => void> = [];
  const ctx = {
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
      return () => {
        const index = disposers.indexOf(run);
        if (index >= 0) disposers.splice(index, 1);
        run();
      };
    },
    tools: {
      register(definition: { name: string }): () => void {
        registrations.push(definition.name);
        return () => {};
      },
    },
  };
  return {
    ctx: ctx as never,
    handlers,
    registrations,
    logs,
    disposeAll(): void {
      for (const dispose of [...disposers].reverse()) dispose();
      disposers.length = 0;
    },
  };
}

/** An agent-scoped tool runtime: records the restrictions and guards a sub-agent receives. */
function fakeAgentContext(): {
  ctx: never;
  restricts: string[][];
  guards: Array<(execution: { name?: unknown }) => string | undefined>;
} {
  const restricts: string[][] = [];
  const guards: Array<(execution: { name?: unknown }) => string | undefined> = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    effect(callback: () => (() => void) | void): () => void {
      const dispose = callback();
      const run = (): void => {
        dispose?.();
      };
      disposers.push(run);
      return run;
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
  return { ctx: ctx as never, restricts, guards };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = check();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface StubCall {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
}

function readCalls(path: string): StubCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { name?: unknown; args?: unknown; cwd?: unknown })
    .filter((entry) => typeof entry.name === 'string')
    .map((entry) => ({
      name: entry.name as string,
      args: (entry.args ?? {}) as Record<string, unknown>,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    }));
}

/** Child exits recorded by the stub, as `cwd` values. */
function readExits(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { event?: string; cwd?: string })
    .filter((entry) => entry.event === 'exit')
    .map((entry) => entry.cwd ?? '');
}

function configFor(callsPath: string): Parameters<typeof apply>[1] {
  return {
    command: process.execPath,
    args: [stubPath],
    env: { ENGRAM_STUB_LOG: callsPath },
    toolCallTimeoutMs: 10000,
    poolMaxConnections: 2,
    poolMaxIdleMs: 60000,
    poolSweepIntervalMs: 60000,
    projectOverrides: {},
    injectSessionProject: true,
    injectSessionId: true,
    capturePassive: true,
    compactionRecovery: true,
    recoveryTokenBudget: 800,
    recallWakeup: true,
  };
}

test('stub wiring: capture and compaction recovery react to real host envelopes', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'engram-stub-'));
  const dshHome = join(temp, 'dsh-home');
  const callsPath = join(temp, 'calls.jsonl');
  const realToolsJson = join(homedir(), '.dsh', 'storages', 'engram-bridge', 'tools.json');
  const realToolsBefore = existsSync(realToolsJson) ? readFileSync(realToolsJson, 'utf8') : undefined;
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  const host = fakeHost();
  try {
    apply(host.ctx, configFor(callsPath));

    const ctx = new Context();
    const store = new SessionStore(ctx);
    // `meta.cwd` is how the host stamps the working directory onto the session header.
    const session = store.create('stub-1', { meta: { cwd: repo } });
    const injected: string[] = [];
    const sent: Array<{ text: string; target: string; wakeup: boolean }> = [];
    const agent = {
      session,
      inject(message: { content?: Array<{ text?: string }> }): void {
        injected.push(message.content?.[0]?.text ?? '');
      },
      send(message: { content?: Array<{ text?: string }> }, target: string, wakeup: boolean): void {
        sent.push({ text: message.content?.[0]?.text ?? '', target, wakeup });
      },
    };

    await host.handlers.get('agent/session-start')?.({ agent });
    await waitFor(() => host.registrations.includes('mcp__engram__mem_save'));
    assert.ok(
      !host.registrations.includes('mcp__engram__mem_capture_passive'),
      'passive capture must not be registered (single writer)',
    );
    assert.ok(
      !host.registrations.includes('mcp__engram__mem_save_prompt'),
      'prompt capture must not be registered (session log is the source of truth)',
    );

    session.append('turn/start', { turn: 1 });
    const learnings = '## Key Learnings:\n1. stub wiring item with enough characters to extract';
    session.append(
      'assistant/message',
      { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: learnings }] } },
      { surfaceOp: 'append' },
    );
    const seqAfterTurn = session.seq;
    await host.handlers.get('agent/turn-stopping')?.({ agent, turn: 1, signal: new AbortController().signal });
    assert.equal(session.seq, seqAfterTurn, 'the capture hook must not append session events');

    await waitFor(() => readCalls(callsPath).some((call) => call.name === 'mem_capture_passive'));
    const capture = readCalls(callsPath).find((call) => call.name === 'mem_capture_passive');
    assert.equal(capture?.args.content, learnings);
    assert.equal(capture?.args.source, 'dsh-turn-stopping');
    assert.equal(capture?.args.session_id, 'stub-1');

    session.append('compaction/start', { compactionId: 'c1', turn: null });
    session.append('compaction/summary', {
      compactionId: 'c1',
      turn: null,
      summary: [{ type: 'text', text: 'compaction narrative from the host' }],
      shadowedRange: { start: 0, end: 1 },
      shadowedSeqs: [0, 1],
      shadowedTokenCount: 42,
      provider: 'stub-provider',
      model: 'stub-model',
      rawOutput: [{ type: 'text', text: 'compaction narrative from the host' }],
      llmStreamCall: true,
    });
    session.append('compaction/end', { compactionId: 'c1', turn: null });

    const events = session.snapshotEvents();
    const seqBeforeRecovery = session.seq;
    await host.handlers.get('session/event')?.(session, events.find((event) => event.type === 'compaction/summary'));
    await waitFor(() => readCalls(callsPath).some((call) => call.name === 'mem_session_summary'));
    const summaryCall = readCalls(callsPath).find((call) => call.name === 'mem_session_summary');
    assert.equal(summaryCall?.args.content, 'compaction narrative from the host');
    assert.equal(summaryCall?.args.session_id, 'stub-1');

    await host.handlers.get('session/event')?.(session, events.find((event) => event.type === 'compaction/end'));
    await waitFor(() => sent.length === 1);
    assert.match(sent[0]?.text ?? '', /STUB RECALL/);
    // The host payload carries turn: null — a standalone transaction between turns. Nothing is
    // running that could claim the recall, so the bridge wakes the driver and the recall opens a
    // self-recovery turn of its own instead of waiting for the user's next message.
    assert.equal(sent[0]?.target, 'next-step');
    assert.equal(sent[0]?.wakeup, true, 'a turn-less compaction must wake the driver');
    assert.match(sent[0]?.text ?? '', /post-compaction self-recovery/, 'the recall explains itself');
    assert.deepEqual(injected, [], 'the wakeup-less seam must not be used');

    assert.equal(session.seq, seqBeforeRecovery, 'the compaction listeners must not append session events');
    assert.deepEqual(host.logs.warn, [], 'no shape warnings expected against the real envelope');
    assert.deepEqual(host.logs.error, []);

    // A host without `send` must be reported, not silently downgraded to the wakeup-less seam:

    // that fallback is exactly the parked-recall defect this path exists to fix.
    const legacySession = store.create('stub-2', { meta: { cwd: repo } });
    const legacyInjected: string[] = [];
    const legacyAgent = {
      session: legacySession,
      inject(message: { content?: Array<{ text?: string }> }): void {
        legacyInjected.push(message.content?.[0]?.text ?? '');
      },
    };
    await host.handlers.get('agent/session-start')?.({ agent: legacyAgent });
    legacySession.append('compaction/end', { compactionId: 'c2', turn: null });
    const legacyEvents = legacySession.snapshotEvents();
    await host.handlers.get('session/event')?.(legacySession, legacyEvents.find((event) => event.type === 'compaction/end'));
    await waitFor(() => host.logs.warn.some((message) => /no live agent with send\(\)/.test(message)));
    assert.deepEqual(legacyInjected, [], 'a send-less host must not receive a wakeup-less fallback');

    assert.ok(existsSync(join(dshHome, 'storages', 'engram-bridge', 'tools.json')), 'cache written to the temp home');
    if (realToolsBefore !== undefined) {
      assert.equal(readFileSync(realToolsJson, 'utf8'), realToolsBefore, 'the real tools cache must stay untouched');
    }
  } finally {
    host.disposeAll();
    rmSync(temp, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('the plugin reclaims an idle connection on its own timer', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'engram-idle-'));
  const callsPath = join(temp, 'calls.jsonl');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(temp, 'dsh-home');
  const host = fakeHost();
  try {
    apply(host.ctx, { ...configFor(callsPath), poolMaxIdleMs: 50, poolSweepIntervalMs: 1000 });

    const ctx = new Context();
    const store = new SessionStore(ctx);
    const session = store.create('idle-1', { meta: { cwd: repo } });
    await host.handlers.get('agent/session-start')?.({ agent: { session, inject(): void {} } });
    await waitFor(() => readCalls(callsPath).some((call) => call.cwd === repo));

    // Nothing calls the workspace again — only the plugin's own timer can reclaim it.
    await waitFor(() => readExits(callsPath).includes(repo), 5000);
  } finally {
    host.disposeAll();
    rmSync(temp, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('a config that omits poolSweepIntervalMs falls back to the default, not a busy poll', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'engram-nokey-'));
  const callsPath = join(temp, 'calls.jsonl');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(temp, 'dsh-home');
  const host = fakeHost();
  try {
    const config = configFor(callsPath) as Record<string, unknown>;
    delete config.poolSweepIntervalMs; // a directly-constructed config bypasses the schema
    apply(host.ctx, { ...config, poolMaxIdleMs: 50 } as never);

    const ctx = new Context();
    const store = new SessionStore(ctx);
    const session = store.create('nokey-1', { meta: { cwd: repo } });
    await host.handlers.get('agent/session-start')?.({ agent: { session, inject(): void {} } });
    await waitFor(() => readCalls(callsPath).some((call) => call.cwd === repo));

    // With the default 60s interval the child is still alive well past the 50ms idle mark;
    // a ~1ms busy poll (the undefined-interval trap) would have closed it already.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(readExits(callsPath).filter((cwd) => cwd === repo), []);
  } finally {
    host.disposeAll();
    // The engram stub appends its exit record from its own process; give it a
    // moment to settle, otherwise the removal below races with that write
    // (ENOTEMPTY, reproduced before this wait existed).
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(temp, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('sub-agent isolation covers a sub-agent created BEFORE the tool surface is registered', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'engram-sub-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(temp, 'dsh-home');
  const host = fakeHost();
  try {
    apply(host.ctx, configFor(join(temp, 'calls.jsonl')));

    const ctx = new Context();
    const store = new SessionStore(ctx);
    const session = store.create('sub-1', { meta: { cwd: repo, origin: 'subagent', delegationDepth: 1 } });
    const agentCtx = fakeAgentContext();
    const agent = { session, ctx: agentCtx.ctx, inject(): void {} };

    // created while nothing is registered yet — the exact window the old code missed
    await host.handlers.get('agent/created')?.({ agent });

    assert.equal(agentCtx.guards.length, 1, 'the execution guard must be installed at creation');
    const guard = agentCtx.guards[0];
    assert.equal(typeof guard?.({ name: 'mcp__engram__mem_save' }), 'string', 'engram tools are denied');
    assert.equal(guard?.({ name: 'bash' }), undefined, 'unrelated tools stay allowed');
    assert.deepEqual(agentCtx.restricts, [], 'no names were known yet, so nothing to hide');

    // ... and once registration completes, the visibility restriction is re-applied
    await waitFor(() => host.registrations.includes('mcp__engram__mem_save'));
    await host.handlers.get('agent/created')?.({ agent });
    const denied = agentCtx.restricts.at(-1) ?? [];
    assert.ok(denied.includes('mcp__engram__mem_save'), 'the late restriction names the registered tools');
    assert.ok(denied.includes('mcp__engram__mem_context'), 'every registered engram tool is denied to the sub-agent');
  } finally {
    host.disposeAll();
    rmSync(temp, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});
