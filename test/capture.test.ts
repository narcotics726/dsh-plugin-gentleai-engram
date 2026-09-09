import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassiveCapture } from '../dist/capture.js';

const envelope = (result: string) => ({
  content: [{ type: 'text', text: JSON.stringify({ project: 'p', result }) }],
});

function harness(options: { enabled?: boolean; result?: string; fail?: boolean } = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const warnings: string[] = [];
  const capture = new PassiveCapture({
    enabled: options.enabled ?? true,
    log: { debug(): void {}, info(): void {}, warn: (message: string) => { warnings.push(message); }, error(): void {} },
    call: async (_sessionId, tool, args) => {
      calls.push({ tool, args });
      if (options.fail === true) throw new Error('engram down');
      return envelope(options.result ?? 'Passive capture complete: extracted=2 saved=2 duplicates=0');
    },
  });
  return { capture, calls, warnings };
}

test('submits the turn text once with the session id', async () => {
  const { capture, calls } = harness();
  await capture.capture('s1', 3, '## Key Learnings:\n1. something');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool, 'mem_capture_passive');
  assert.equal(calls[0]?.args.session_id, 's1');
  assert.match(String(calls[0]?.args.content), /Key Learnings/);
});

test('a repeated turn-stopping for the same turn does not submit twice', async () => {
  const { capture, calls } = harness();
  await capture.capture('s1', 3, 'text');
  await capture.capture('s1', 3, 'text');
  assert.equal(calls.length, 1);
});

test('a different turn submits again', async () => {
  const { capture, calls } = harness();
  await capture.capture('s1', 3, 'text');
  await capture.capture('s1', 4, 'text');
  assert.equal(calls.length, 2);
});

test('disabled capture never calls engram', async () => {
  const { capture, calls } = harness({ enabled: false });
  await capture.capture('s1', 1, '## Key Learnings:\n1. x');
  assert.equal(calls.length, 0);
});

test('an empty turn text is skipped', async () => {
  const { capture, calls } = harness();
  await capture.capture('s1', 1, '   ');
  assert.equal(calls.length, 0);
});

test('a section with zero extracted items is logged', async () => {
  const { capture, warnings } = harness({ result: 'Passive capture complete: extracted=0 saved=0 duplicates=0' });
  await capture.capture('s1', 1, '## Key Learnings:\n1. tiny');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /extracted 0 items/);
});

test('no section means no zero-extraction warning', async () => {
  const { capture, warnings } = harness({ result: 'Passive capture complete: extracted=0 saved=0 duplicates=0' });
  await capture.capture('s1', 1, 'plain reply');
  assert.equal(warnings.length, 0);
});

test('a capture failure is logged and never thrown', async () => {
  const { capture, warnings } = harness({ fail: true });
  await capture.capture('s1', 1, 'text');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /engram down/);
});
