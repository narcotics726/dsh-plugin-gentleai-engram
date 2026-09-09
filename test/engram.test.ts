import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasLearningsSection, parseCaptureCounts, parseEnvelope, truncateToTokenBudget } from '../dist/engram.js';

test('parseEnvelope reads the engram response envelope', () => {
  const envelope = parseEnvelope([
    { type: 'text', text: JSON.stringify({ project: 'p', project_source: 'git_root', result: 'ok' }) },
  ]);
  assert.equal(envelope.project, 'p');
  assert.equal(envelope.projectSource, 'git_root');
  assert.equal(envelope.result, 'ok');
});

test('parseEnvelope falls back to raw text', () => {
  const envelope = parseEnvelope([{ type: 'text', text: 'not json' }]);
  assert.equal(envelope.project, undefined);
  assert.equal(envelope.result, 'not json');
});

test('hasLearningsSection matches the capture convention only', () => {
  assert.equal(hasLearningsSection('text\n\n## Key Learnings:\n1. a'), true);
  assert.equal(hasLearningsSection('## Key Learnings\n1. a'), true);
  assert.equal(hasLearningsSection('### Key Learnings:\n1. a'), false);
  assert.equal(hasLearningsSection('no section here'), false);
});

test('parseCaptureCounts reads the counters', () => {
  assert.deepEqual(parseCaptureCounts('Passive capture complete: extracted=2 saved=1 duplicates=1'), {
    extracted: 2,
    saved: 1,
    duplicates: 1,
  });
  assert.deepEqual(parseCaptureCounts('nothing'), {});
});

test('truncateToTokenBudget bounds the injected text', () => {
  const long = 'x'.repeat(100);
  const out = truncateToTokenBudget(long, 5);
  assert.ok(out.length < long.length);
  assert.ok(out.includes('truncated to 5 tokens'));
  assert.equal(truncateToTokenBudget('short', 5), 'short');
});