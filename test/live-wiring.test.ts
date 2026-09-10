import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply } from '../dist/index.js';

/**
 * Live wiring test: drives the real plugin entry with a fake host context, the HOST's real
 * session store (so the envelopes are the real ones), and a real engram binary on an
 * isolated ENGRAM_DATA_DIR. This is the cross-check on the stub used by the default gate.
 * Run with: ENGRAM_LIVE=1 pnpm test
 */
const live = process.env.ENGRAM_LIVE === '1';
const engramBin = process.env.ENGRAM_BIN ?? '/opt/homebrew/bin/engram';
const repo = process.cwd();
const dataDir = join(repo, 'test', '.tmp-wiring-data');

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

function makeSession(id: string, cwd: string) {
  const ctx = new Context();
  const store = new SessionStore(ctx);
  return store.create(id, { meta: { cwd } });
}

async function waitFor(check: () => boolean, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = check();
    } catch {
      ok = false; // e.g. the engram DB file does not exist yet
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('live wiring: session start, capture and compaction recovery', { skip: !live }, async () => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  // Isolate the tool-surface cache too: the plugin reads it from $DSH_HOME.
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dataDir, 'dsh-home');
  const host = fakeHost();
  const { ctx, handlers, registrations, logs } = host;
  try {
    apply(ctx as never, {
      command: engramBin,
      args: ['mcp'],
      env: { ENGRAM_DATA_DIR: dataDir, ENGRAM_NO_UPDATE_CHECK: '1' },
      toolCallTimeoutMs: 20000,
      poolMaxConnections: 2,
      poolMaxIdleMs: 60000,
      poolSweepIntervalMs: 60000,
      projectOverrides: {},
      injectSessionProject: true,
      injectSessionId: true,
      capturePassive: true,
      compactionRecovery: true,
      recoveryTokenBudget: 800,
    });

    const session = makeSession('wire-1', repo);
    const sent: Array<{ text: string; target: string; wakeup: boolean }> = [];
    const agent = {
      session,
      sent,
      send(message: { content?: Array<{ text?: string }> }, target: string, wakeup: boolean): void {
        sent.push({ text: message.content?.[0]?.text ?? '', target, wakeup });
      },
    };
    await handlers.get('agent/session-start')?.({ agent });
    await waitFor(() => registrations.length > 0);
    assert.ok(registrations.includes('mcp__engram__mem_save'), 'tools registered after binding');
    assert.ok(
      !registrations.includes('mcp__engram__mem_capture_passive'),
      'the passive-capture tool stays unregistered (single writer)',
    );

    const db = new DatabaseSync(join(dataDir, 'engram.db'));
    await waitFor(() => {
      const row = db.prepare('select id, directory from sessions where id = ?').get('wire-1') as
        | { directory?: string }
        | undefined;
      return row?.directory === repo;
    });

    // Turn-final capture, driven by a REAL assistant/message envelope.
    session.append('turn/start', { turn: 1 });
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '## Key Learnings:\n1. wiring probe item with enough words to be extracted' },
          ],
        },
      },
      { surfaceOp: 'append' },
    );
    await handlers.get('agent/turn-stopping')?.({ agent, turn: 1 });
    await waitFor(() => {
      const row = db
        .prepare("select count(*) as n from observations where session_id = 'wire-1' and title like '%wiring probe%'")
        .get() as { n: number };
      return row.n >= 1;
    });

    // A repeated turn-stopping (a listener steered) must not capture twice.
    await handlers.get('agent/turn-stopping')?.({ agent, turn: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const captured = db
      .prepare("select count(*) as n from observations where session_id = 'wire-1'")
      .get() as { n: number };
    assert.equal(captured.n, 1, 'exactly one capture for the turn');

    // Compaction: real envelopes for compaction/summary and compaction/end.
    session.append('compaction/start', { compactionId: 'c1', turn: null });
    session.append('compaction/summary', {
      compactionId: 'c1',
      turn: null,
      summary: [{ type: 'text', text: 'compaction narrative' }],
      shadowedRange: { start: 0, end: 1 },
      shadowedSeqs: [0, 1],
      shadowedTokenCount: 7,
      provider: 'wiring',
      model: 'wiring',
      rawOutput: [{ type: 'text', text: 'compaction narrative' }],
      llmStreamCall: true,
    });
    session.append('compaction/end', { compactionId: 'c1', turn: null });
    const events = session.snapshotEvents();

    await handlers.get('session/event')?.(session, events.find((event) => event.type === 'compaction/summary'));
    await waitFor(() => {
      const row = db
        .prepare("select count(*) as n from observations where session_id = 'wire-1' and title like 'Session summary%'")
        .get() as { n: number };
      return row.n === 1;
    });
    await handlers.get('session/event')?.(session, events.find((event) => event.type === 'compaction/end'));
    await waitFor(() => sent.length === 1);
    assert.ok((sent[0]?.text ?? '').length > 0);
    // A real turn-less compaction (turn: null) must wake the driver so the recall becomes a
    // turn of its own; the delivery boundary stays uniform across both compaction owners.
    assert.equal(sent[0]?.target, 'next-step');
    assert.equal(sent[0]?.wakeup, true, 'a turn-less compaction must wake the driver');

    db.close();
    assert.ok(!logs.some((line) => line.startsWith('error:')), `no degradation logs: ${logs.join(' | ')}`);
    assert.ok(!logs.some((line) => line.startsWith('warn:')), `no shape warnings: ${logs.join(' | ')}`);
  } finally {
    host.disposeAll();
    rmSync(dataDir, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
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
    poolSweepIntervalMs: 60000,
    projectOverrides: {},
    injectSessionProject: true,
    injectSessionId: true,
    capturePassive: true,
    compactionRecovery: true,
    recoveryTokenBudget: 800,
  });
  const session = makeSession('wire-2', repo);
  await handlers.get('agent/session-start')?.({ agent: { session, inject(): void {} } });
  await waitFor(() => logs.some((line) => line.startsWith('error:')));
  assert.equal(registrations.length, 0, 'no tools registered when engram is unavailable');
  assert.equal(logs.filter((line) => line.startsWith('error:')).length, 1, 'exactly one degradation log');
  host.disposeAll();
});
