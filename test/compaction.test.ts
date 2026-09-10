import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompactionRecovery } from '../dist/compaction.js';

const envelope = (result: string) => ({
  content: [{ type: 'text', text: JSON.stringify({ project: 'p', result }) }],
});

function harness(
  options: { enabled?: boolean; budget?: number; context?: string; fail?: boolean; recallWakeup?: boolean } = {},
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const injected: string[] = [];
  const targets: string[] = [];
  const wakeups: boolean[] = [];
  const warnings: string[] = [];
  const recovery = new CompactionRecovery({
    enabled: options.enabled ?? true,
    tokenBudget: options.budget ?? 800,
    recallWakeup: options.recallWakeup ?? true,
    log: { debug(): void {}, info(): void {}, warn: (message: string) => { warnings.push(message); }, error(): void {} },
    resolveProject: () => 'proj',
    call: async (_sessionId, tool, args) => {
      calls.push({ tool, args });
      if (options.fail === true) throw new Error('engram down');
      return envelope(options.context ?? 'recent memory');
    },
    deliver: (_sessionId, text, target, wakeup) => {
      injected.push(text);
      targets.push(target);
      wakeups.push(wakeup);
    },
  });
  return { recovery, calls, injected, targets, wakeups, warnings };
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

test('an empty summary is not submitted and is not silent', async () => {
  const { recovery, calls, warnings, injected } = harness();
  await recovery.onSummary('s1', 'c-empty', '   ');
  assert.equal(calls.length, 0, 'nothing is submitted for an empty summary');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /c-empty/);
  await recovery.onEnd('s1', 'c-empty', false, null);
  assert.equal(injected.length, 1);
});

test('injects recall once after a successful compaction end', async () => {
  const { recovery, injected, calls } = harness();
  await recovery.onEnd('s1', 'c1', false, null);
  await recovery.onEnd('s1', 'c1', false, null);
  assert.equal(injected.length, 1);
  assert.ok((injected[0] ?? '').includes('recent memory'), 'the recall body survives');
  assert.equal(calls[0]?.tool, 'mem_context');
  assert.equal(calls[0]?.args.project, 'proj');
});

test('a failed compaction does not inject', async () => {
  const { recovery, injected } = harness();
  await recovery.onEnd('s1', 'c1', true, null);
  assert.equal(injected.length, 0);
});

test('the injected payload stays inside the configured budget', async () => {
  const long = 'x'.repeat(4000);
  const { recovery, injected } = harness({ budget: 800, context: long });
  await recovery.onEnd('s1', 'c1', false, null);
  assert.equal(injected.length, 1);
  const [frame = '', body = ''] = (injected[0] ?? '').split('\n\n');
  assert.match(frame, /post-compaction self-recovery/, 'the framing comes first');
  assert.match(body, /truncated to \d+ tokens/, 'a long recall is truncated');
  assert.ok(body.length <= 800 * 4 + 64, `recall body of ${body.length} chars exceeds the budget`);
  assert.ok(!body.includes('x'.repeat(3000)), 'the body is cut, not passed through whole');
});

test('disabled recovery does nothing', async () => {
  const { recovery, calls, injected } = harness({ enabled: false });
  await recovery.onSummary('s1', 'c1', 'summary');
  await recovery.onEnd('s1', 'c1', false, null);
  assert.equal(calls.length, 0);
  assert.equal(injected.length, 0);
});

test('failures are logged and never thrown', async () => {
  const { recovery, warnings } = harness({ fail: true });
  await recovery.onSummary('s1', 'c1', 'summary');
  await recovery.onEnd('s1', 'c2', false, null);
  assert.equal(warnings.length, 2);
});

test('a standalone compaction wakes an independent self-recovery turn', async () => {
  // A manual /compact is a transaction between turns (turn === null). Delivering without waking
  // leaves the recall parked until the user speaks, and the host then claims it as a turn of its
  // own - which pushes the user's own message into the turn after that.
  const { recovery, injected, targets, wakeups } = harness();
  await recovery.onEnd('s1', 'c-manual', false, null);
  assert.equal(injected.length, 1);
  assert.equal(wakeups[0], true, 'a turn-less transaction must wake the driver');
  assert.equal(targets[0], 'next-step', 'the delivery boundary is uniform');
});

test('a run-owned compaction never wakes the driver', async () => {
  // The owning turn claims the recall at its next step boundary; waking would open a second turn.
  const { recovery, targets, wakeups } = harness();
  await recovery.onEnd('s1', 'c-turn', false, 3);
  assert.equal(wakeups[0], false);
  assert.equal(targets[0], 'next-step');
});

test('the delivery boundary does not vary with the compaction owner', async () => {
  const standalone = harness();
  await standalone.recovery.onEnd('s1', 'a', false, null);
  const owned = harness();
  await owned.recovery.onEnd('s1', 'b', false, 7);
  assert.equal(standalone.targets[0], owned.targets[0], 'the host may reclassify the boundary');
});

test('recallWakeup=false keeps the recall but suppresses the wake', async () => {
  const { recovery, injected, wakeups, warnings } = harness({ recallWakeup: false });
  await recovery.onEnd('s1', 'c-manual', false, null);
  assert.equal(injected.length, 1, 'the recall is still delivered');
  assert.equal(wakeups[0], false, 'the known-degraded opt-out does not wake');
  assert.equal(warnings.length, 0);
});

test('the injected recall is self-describing and order-independent', async () => {
  // The turn that carries the recall may or may not already carry user input: the wake can race
  // the user's next message, in which case the host merges both into one turn.
  const { recovery, injected } = harness({ context: 'recent memory' });
  await recovery.onEnd('s1', 'c1', false, null);
  const text = injected[0] ?? '';
  assert.match(text, /compact/i, 'it says where it came from');
  assert.match(text, /no other user input/i, 'the no-user-input branch is spelled out');
  assert.match(text, /carries user input/i, 'the user-input branch is spelled out');
  assert.ok(text.includes('recent memory'), 'the recall body follows the framing');
});

test('the self-description survives even an absurdly small budget', async () => {
  const { recovery, injected } = harness({ budget: 5, context: 'x'.repeat(4000) });
  await recovery.onEnd('s1', 'c1', false, null);
  assert.match(injected[0] ?? '', /compact/i, 'the framing is not the part that gets truncated');
});
