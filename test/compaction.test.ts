import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompactionRecovery } from '../dist/compaction.js';

const envelope = (result: string) => ({
  content: [{ type: 'text', text: JSON.stringify({ project: 'p', result }) }],
});

function harness(options: { enabled?: boolean; budget?: number; context?: string; fail?: boolean } = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const injected: string[] = [];
  const warnings: string[] = [];
  const recovery = new CompactionRecovery({
    enabled: options.enabled ?? true,
    tokenBudget: options.budget ?? 800,
    log: { debug(): void {}, info(): void {}, warn: (message: string) => { warnings.push(message); }, error(): void {} },
    resolveProject: () => 'proj',
    call: async (_sessionId, tool, args) => {
      calls.push({ tool, args });
      if (options.fail === true) throw new Error('engram down');
      return envelope(options.context ?? 'recent memory');
    },
    inject: (_sessionId, text) => { injected.push(text); },
  });
  return { recovery, calls, injected, warnings };
}

test('persists the summary content once per compaction', async () => {
  const { recovery, calls } = harness();
  await recovery.onSummary('s1', 'c1', 'the summary text');
  await recovery.onSummary('s1', 'c1', 'the summary text');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool, 'mem_session_summary');
  assert.equal(calls[0]?.args.session_id, 's1');
  assert.equal(calls[0]?.args.content, 'the summary text');
});

test('injects recall once after a successful compaction end', async () => {
  const { recovery, injected, calls } = harness();
  await recovery.onEnd('s1', 'c1', false);
  await recovery.onEnd('s1', 'c1', false);
  assert.equal(injected.length, 1);
  assert.equal(injected[0], 'recent memory');
  assert.equal(calls[0]?.tool, 'mem_context');
  assert.equal(calls[0]?.args.project, 'proj');
});

test('a failed compaction does not inject', async () => {
  const { recovery, injected } = harness();
  await recovery.onEnd('s1', 'c1', true);
  assert.equal(injected.length, 0);
});

test('recall respects the token budget', async () => {
  const long = 'x'.repeat(400);
  const { recovery, injected } = harness({ budget: 5, context: long });
  await recovery.onEnd('s1', 'c1', false);
  assert.equal(injected.length, 1);
  assert.ok((injected[0] ?? '').length < long.length);
});

test('disabled recovery does nothing', async () => {
  const { recovery, calls, injected } = harness({ enabled: false });
  await recovery.onSummary('s1', 'c1', 'summary');
  await recovery.onEnd('s1', 'c1', false);
  assert.equal(calls.length, 0);
  assert.equal(injected.length, 0);
});

test('failures are logged and never thrown', async () => {
  const { recovery, warnings } = harness({ fail: true });
  await recovery.onSummary('s1', 'c1', 'summary');
  await recovery.onEnd('s1', 'c2', false);
  assert.equal(warnings.length, 2);
});
