import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionBindings } from '../dist/bindings.js';

const silent = { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} };
const envelope = (body: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });

test('binds once per session and captures the engram project', async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const bindings = new SessionBindings({
    pool: {} as never,
    log: silent,
    call: async (_workspace, tool, args) => {
      calls.push({ tool, args });
      return envelope({ project: 'from-engram', project_source: 'git_root', result: 'started' });
    },
  });
  const first = await bindings.ensure('s1', '/ws');
  const second = await bindings.ensure('s1', '/ws');
  assert.equal(first.project, 'from-engram');
  assert.equal(first.projectSource, 'git_root');
  assert.equal(second, first);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { tool: 'mem_session_start', args: { id: 's1', directory: '/ws' } });
});

test('concurrent ensure is a barrier with a single call', async () => {
  let calls = 0;
  const bindings = new SessionBindings({
    pool: {} as never,
    log: silent,
    call: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return envelope({ project: 'p', project_source: 'config', result: 'started' });
    },
  });
  await Promise.all([bindings.ensure('s1', '/ws'), bindings.ensure('s1', '/ws')]);
  assert.equal(calls, 1);
});

test('a failed binding is not cached', async () => {
  let calls = 0;
  const bindings = new SessionBindings({
    pool: {} as never,
    log: silent,
    call: async () => {
      calls += 1;
      if (calls === 1) throw new Error('engram down');
      return envelope({ project: 'p', result: 'started' });
    },
  });
  await assert.rejects(() => bindings.ensure('s1', '/ws'), /engram down/);
  const binding = await bindings.ensure('s1', '/ws');
  assert.equal(binding.project, 'p');
  assert.equal(calls, 2);
});
