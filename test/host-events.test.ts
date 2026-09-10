import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { EventShapeWarnings, readEventPayload, turnFinalText } from '../dist/host-events.js';
import { turnFinalText as pluginTurnFinalText } from '../dist/index.js';

/**
 * Contract tests for the host session-event seam.
 *
 * Events are produced by the HOST's own store (`Context` + `SessionStore`), never by a
 * hand-written fixture: the envelope shape is therefore the real one, and a fixture can no
 * longer share a wrong assumption with the reader (that is how the flat-payload bug shipped).
 */

function realSession(id = 'wire-1'): InstanceType<typeof SessionStore>['create'] extends (i?: string) => infer S ? S : never {
  const ctx = new Context();
  const store = new SessionStore(ctx);
  return store.create(id) as never;
}

test('turnFinalText reads the assistant text from the host envelope', () => {
  const session = realSession('contract-1');
  session.append('turn/start', { turn: 1 });
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '## Key Learnings:\n1. envelope item' }] },
    },
    { surfaceOp: 'append' },
  );
  const warnings: string[] = [];
  const text = turnFinalText(session as never, 1, new EventShapeWarnings((message) => warnings.push(message)));
  assert.equal(text, '## Key Learnings:\n1. envelope item');
  assert.deepEqual(warnings, [], 'the host envelope must not produce a shape warning');
});

test('the plugin entry reads the same envelope (regression: it used to read top-level fields)', () => {
  const session = realSession('contract-2');
  session.append('turn/start', { turn: 1 });
  session.append(
    'assistant/message',
    { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'envelope-only text' }] } },
    { surfaceOp: 'append' },
  );
  const warnings: string[] = [];
  const text = pluginTurnFinalText(session as never, 1, new EventShapeWarnings((message) => warnings.push(message)) as never);
  assert.equal(text, 'envelope-only text');
});

test('a flattened payload yields no text and warns exactly once per session', () => {
  const warnings: string[] = [];
  const shape = new EventShapeWarnings((message) => warnings.push(message));
  const flat = {
    header: { id: 'flat-1' },
    snapshotEvents: () => [
      { type: 'assistant/message', turn: 1, message: { content: [{ type: 'text', text: 'flat text' }] } },
    ],
  };
  assert.equal(turnFinalText(flat as never, 1, shape), undefined, 'a flat payload must not be accepted');
  assert.equal(warnings.length, 1);
  turnFinalText(flat as never, 1, shape);
  assert.equal(warnings.length, 1, 'the same session and type must not warn twice');
  const other = { header: { id: 'flat-2' }, snapshotEvents: flat.snapshotEvents };
  turnFinalText(other as never, 1, shape);
  assert.equal(warnings.length, 2, 'a new session warns again');
});

test('a payload missing a required field is reported, not dropped silently', () => {
  const details: string[] = [];
  const payload = readEventPayload(
    { type: 'compaction/summary', data: { compactionId: 'c1' } },
    'compaction/summary',
    (detail) => details.push(detail),
  );
  assert.equal(payload, undefined);
  assert.equal(details.length, 1);
  assert.match(details[0] ?? '', /summary/);
});

test('a payload with the wrong field type is reported', () => {
  const details: string[] = [];
  const payload = readEventPayload(
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: 'not-an-array' } } },
    'assistant/message',
    (detail) => details.push(detail),
  );
  assert.equal(payload, undefined);
  assert.match(details[0] ?? '', /message\.content/);
});

test('an unrelated event type is ignored without a warning', () => {
  const details: string[] = [];
  assert.equal(readEventPayload({ type: 'turn/start', data: { turn: 1 } }, 'compaction/end', (d) => details.push(d)), undefined);
  assert.deepEqual(details, []);
});

test('compaction/end accepts both owners of a compaction transaction', () => {
  const details: string[] = [];
  const warn = (detail: string) => details.push(detail);
  const standalone = readEventPayload(
    { type: 'compaction/end', data: { compactionId: 'c1', turn: null } },
    'compaction/end',
    warn,
  );
  assert.equal(standalone?.turn, null, 'a manual transaction between turns is a legal payload');
  const owned = readEventPayload({ type: 'compaction/end', data: { compactionId: 'c1', turn: 3 } }, 'compaction/end', warn);
  assert.equal(owned?.turn, 3);
  assert.deepEqual(details, [], 'neither owner may be reported as a shape mismatch');
});

test('a compaction/end without a usable turn is reported, not read as standalone', () => {
  const details: string[] = [];
  const missing = readEventPayload({ type: 'compaction/end', data: { compactionId: 'c1' } }, 'compaction/end', (d) => details.push(d));
  assert.equal(missing, undefined);
  assert.match(details[0] ?? '', /turn/);
  const mistyped = readEventPayload(
    { type: 'compaction/end', data: { compactionId: 'c1', turn: 'none' } },
    'compaction/end',
    (d) => details.push(d),
  );
  assert.equal(mistyped, undefined);
  assert.equal(details.length, 2);
});
