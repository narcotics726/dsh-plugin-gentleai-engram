import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../dist/config.js';

test('config defaults', () => {
  const resolved = new Config({ command: '/bin/engram' });
  assert.deepEqual(resolved.args, ['mcp']);
  assert.equal(resolved.toolCallTimeoutMs, 60000);
  assert.equal(resolved.poolMaxConnections, 8);
  assert.equal(resolved.poolMaxIdleMs, 600000);
  assert.equal(resolved.poolSweepIntervalMs, 60000);
  assert.equal(resolved.injectSessionProject, true);
  assert.equal(resolved.injectSessionId, true);
  assert.equal(resolved.capturePassive, true);
  assert.equal(resolved.compactionRecovery, true);
  assert.equal(resolved.recoveryTokenBudget, 800);
  assert.deepEqual(resolved.projectOverrides, {});
});

test('config rejects a missing command', () => {
  assert.throws(() => new Config({}));
});

test('config rejects a sweep interval below the floor (no busy poll)', () => {
  assert.throws(() => new Config({ command: '/bin/engram', poolSweepIntervalMs: 0 }));
  assert.throws(() => new Config({ command: '/bin/engram', poolSweepIntervalMs: -1 }));
  assert.throws(() => new Config({ command: '/bin/engram', poolSweepIntervalMs: 999 }));
  assert.equal(new Config({ command: '/bin/engram', poolSweepIntervalMs: 1000 }).poolSweepIntervalMs, 1000);
});