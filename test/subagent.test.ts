import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSubagentSession, shadowEngramTools } from '../dist/subagent.js';

const silent = { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} };

test('sub-agent detection uses the durable header', () => {
  assert.equal(isSubagentSession({ origin: 'subagent' }), true);
  assert.equal(isSubagentSession({ delegationDepth: 2 }), true);
  assert.equal(isSubagentSession({ delegationDepth: 0 }), false);
  assert.equal(isSubagentSession({}), false);
  assert.equal(isSubagentSession(undefined), false);
});

test('shadowing registers one child-scoped restriction', () => {
  const restricted: Array<{ deny?: readonly string[] }> = [];
  let guards = 0;
  const disposers: Array<() => void> = [];
  const agent = {
    ctx: {
      effect(callback: () => unknown): void {
        disposers.push(callback() as () => void);
      },
      tools: {
        restrict(filter: { deny?: readonly string[] }): () => void {
          restricted.push(filter);
          return () => {};
        },
        guard(): () => void {
          guards += 1;
          return () => {};
        },
      },
    },
  };
  shadowEngramTools(agent as never, ['mcp__engram__mem_save', 'mcp__engram__mem_search'], silent);
  assert.equal(restricted.length, 1);
  assert.deepEqual(restricted[0]?.deny, ['mcp__engram__mem_save', 'mcp__engram__mem_search']);
  assert.equal(guards, 0, 'no extra guard: the restriction already closes the folding path');
  assert.equal(disposers.length, 1);
});

test('shadowing with nothing registered does nothing', () => {
  let calls = 0;
  const agent = {
    ctx: {
      effect(): void { calls += 1; },
      tools: { restrict(): () => void { calls += 1; return () => {}; } },
    },
  };
  shadowEngramTools(agent as never, [], silent);
  assert.equal(calls, 0);
});
