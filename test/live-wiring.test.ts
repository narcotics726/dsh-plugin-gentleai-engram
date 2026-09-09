import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { apply } from '../dist/index.js';

/**
 * Live wiring test: drives the real plugin entry with a fake host context and a
 * real engram binary on an isolated ENGRAM_DATA_DIR.
 * Run with: ENGRAM_LIVE=1 pnpm test
 */
const live = process.env.ENGRAM_LIVE === '1';
const engramBin = process.env.ENGRAM_BIN ?? '/opt/homebrew/bin/engram';
const repo = process.cwd();
const dataDir = join(repo, 'test', '.tmp-wiring-data');

interface WireEvent {
  type?: string;
  turn?: number;
  interrupted?: boolean;
  message?: { content?: Array<{ type: string; text?: string }> };
  summary?: Array<{ type: string; text?: string }>;
  compactionId?: string;
  error?: string;
}

function fakeHost() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registrations: string[] = [];
  const logs: string[] = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    logger: {
      debug(): void {},
      info: (message: string) => { logs.push(`info:${message}`); },
      warn: (message: string) => { logs.push(`warn:${message}`); },
      error: (message: string) => { logs.push(`error:${message}`); },
    },
    on(event: string, listener: (...args: unknown[]) => unknown): () => void {
      handlers.set(event, listener);
      return () => handlers.delete(event);
    },
    effect(callback: () => (() => void) | void): () => void {
      const dispose = callback();
      const run = (): void => { dispose?.(); };
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
    ctx,
    handlers,
    registrations,
    logs,
    disposeAll(): void {
      for (const dispose of [...disposers].reverse()) dispose();
      disposers.length = 0;
    },
  };
}

function fakeAgent(sessionId: string, events: WireEvent[]) {
  const injected: string[] = [];
  const session = {
    header: { id: sessionId, cwd: repo },
    snapshotEvents: (): readonly WireEvent[] => events,
  };
  return {
    session,
    injected,
    inject(message: { content?: Array<{ text?: string }> }): void {
      injected.push(message.content?.[0]?.text ?? '');
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('live wiring: session start, capture and compaction recovery', { skip: !live }, async () => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const host = fakeHost();
  const { ctx, handlers, registrations, logs } = host;
  apply(ctx as never, {
    command: engramBin,
    args: ['mcp'],
    env: { ENGRAM_DATA_DIR: dataDir, ENGRAM_NO_UPDATE_CHECK: '1' },
    toolCallTimeoutMs: 20000,
    poolMaxConnections: 2,
    poolMaxIdleMs: 60000,
    projectOverrides: {},
    injectSessionProject: true,
    injectSessionId: true,
    capturePassive: true,
    compactionRecovery: true,
    recoveryTokenBudget: 800,
  });

  const events: WireEvent[] = [];
  const agent = fakeAgent('wire-1', events);
  await handlers.get('agent/session-start')?.({ agent });
  await waitFor(() => registrations.length > 0);
  assert.ok(registrations.includes('mcp__engram__mem_save'), 'tools registered after binding');
  assert.ok(registrations.includes('mcp__engram__mem_capture_passive'));

  const db = new DatabaseSync(join(dataDir, 'engram.db'));
  await waitFor(() => {
    const row = db.prepare('select id, directory from sessions where id = ?').get('wire-1') as
      | { directory?: string }
      | undefined;
    return row?.directory === repo;
  });

  // Turn-final capture: the hook reads the last non-interrupted assistant message.
  events.push({
    type: 'assistant/message',
    turn: 1,
    message: {
      content: [
        {
          type: 'text',
          text: '## Key Learnings:\n1. wiring probe item with enough words to be extracted',
        },
      ],
    },
  });
  await handlers.get('agent/turn-stopping')?.({ agent, turn: 1 });
  await waitFor(() => {
    const row = db
      .prepare("select count(*) as n from observations where session_id = 'wire-1' and title like '%wiring probe%'")
      .get() as { n: number };
    return row.n >= 1;
  });

  // A repeated turn-stopping (a listener steered) must not capture twice.
  await handlers.get('agent/turn-stopping')?.({ agent, turn: 1 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const captured = db
    .prepare("select count(*) as n from observations where session_id = 'wire-1'")
    .get() as { n: number };
  assert.equal(captured.n, 1, 'exactly one capture for the turn');

  // Compaction: summary persisted, recall injected once.
  await handlers.get('session/event')?.(agent.session, {
    type: 'compaction/summary',
    compactionId: 'c1',
    summary: [{ type: 'text', text: 'compaction narrative' }],
  });
  await waitFor(() => {
    const row = db
      .prepare("select count(*) as n from observations where session_id = 'wire-1' and title like 'Session summary%'")
      .get() as { n: number };
    return row.n === 1;
  });
  await handlers.get('session/event')?.(agent.session, { type: 'compaction/end', compactionId: 'c1' });
  await waitFor(() => agent.injected.length === 1);
  assert.ok((agent.injected[0] ?? '').length > 0);

  db.close();
  host.disposeAll();
  rmSync(dataDir, { recursive: true, force: true });
  assert.ok(!logs.some((line) => line.startsWith('error:')), `no degradation logs: ${logs.join(' | ')}`);
});

test('live wiring: engram unavailable degrades with zero tools and one log', { skip: !live }, async () => {
  const host = fakeHost();
  const { ctx, handlers, registrations, logs } = host;
  apply(ctx as never, {
    command: '/nonexistent/engram-binary',
    args: ['mcp'],
    env: {},
    toolCallTimeoutMs: 2000,
    poolMaxConnections: 1,
    poolMaxIdleMs: 1000,
    projectOverrides: {},
    injectSessionProject: true,
    injectSessionId: true,
    capturePassive: true,
    compactionRecovery: true,
    recoveryTokenBudget: 800,
  });
  const agent = fakeAgent('wire-2', []);
  await handlers.get('agent/session-start')?.({ agent });
  await waitFor(() => logs.some((line) => line.startsWith('error:')));
  assert.equal(registrations.length, 0, 'no tools registered when engram is unavailable');
  assert.equal(logs.filter((line) => line.startsWith('error:')).length, 1, 'exactly one degradation log');
  host.disposeAll();
});
