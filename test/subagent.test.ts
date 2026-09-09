import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSubagentSession, shadowEngramTools, subagentDenialReason } from '../dist/subagent.js';

const silent = { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} };

test('sub-agent detection uses the durable header', () => {
  assert.equal(isSubagentSession({ origin: 'subagent' }), true);
  assert.equal(isSubagentSession({ delegationDepth: 2 }), true);
  assert.equal(isSubagentSession({ delegationDepth: 0 }), false);
  assert.equal(isSubagentSession({}), false);
  assert.equal(isSubagentSession(undefined), false);
});

test('direct engram calls are denied', () => {
  assert.match(String(subagentDenialReason({ name: 'mcp__engram__mem_save' })), /shadowed in sub-agents/);
  assert.equal(subagentDenialReason({ name: 'read' }), undefined);
});

test('folding tools are denied only when they target engram', () => {
  assert.match(
    String(subagentDenialReason({ name: 'mcp_call', arguments: { tool: 'mcp__engram__mem_save' } })),
    /shadowed in sub-agents/,
  );
  assert.equal(subagentDenialReason({ name: 'mcp_call', arguments: { tool: 'other__thing' } }), undefined);
  assert.equal(subagentDenialReason({ name: 'mcp_call' }), undefined);
});

test('shadowing registers a child-scoped restriction and guard', () => {
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
  assert.equal(guards, 1);
  assert.equal(disposers.length, 2);
});

test('shadowing without registered tools still installs the guard', () => {
  let guards = 0;
  const agent = {
    ctx: {
      effect(callback: () => unknown): void { callback(); },
      tools: { guard(): () => void { guards += 1; return () => {}; } },
    },
  };
  shadowEngramTools(agent as never, [], silent);
  assert.equal(guards, 1);
});
