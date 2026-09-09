import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionPool } from '../dist/pool.js';

const silent = { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} };

function makePool(options: Record<string, unknown> = {}) {
  const created: string[] = [];
  let now = 1000;
  const pool = new ConnectionPool({
    maxConnections: 2,
    maxIdleMs: 100,
    log: silent,
    now: () => now,
    sleep: async () => {},
    maxAttempts: 1,
    retryDelayMs: 0,
    connect: async (workspace: string) => {
      created.push(workspace);
      return { tools: [{ name: 'mem_save' }], close(): void {} };
    },
    ...options,
  } as never);
  return { pool, created, tick: (ms: number) => { now += ms; } };
}

test('same workspace reuses one connection', async () => {
  const { pool, created } = makePool();
  await pool.acquire('/ws');
  await pool.acquire('/ws');
  assert.deepEqual(created, ['/ws']);
  assert.equal(pool.size, 1);
  pool.dispose();
});

test('different workspaces get their own connection', async () => {
  const { pool, created } = makePool();
  await pool.acquire('/a');
  await pool.acquire('/b');
  assert.deepEqual(created, ['/a', '/b']);
  assert.equal(pool.size, 2);
  pool.dispose();
});

test('concurrent first use of one workspace spawns once', async () => {
  const { pool, created } = makePool();
  const [a, b] = await Promise.all([pool.acquire('/ws'), pool.acquire('/ws')]);
  assert.equal(a, b);
  assert.deepEqual(created, ['/ws']);
  pool.dispose();
});

test('idle connections are swept', async () => {
  const { pool, tick } = makePool();
  await pool.acquire('/ws');
  tick(500);
  assert.deepEqual(pool.sweep(), ['/ws']);
  assert.equal(pool.size, 0);
  pool.dispose();
});

test('over the limit the least recently used connection is closed', async () => {
  const { pool, tick } = makePool({ maxConnections: 2 });
  await pool.acquire('/a');
  tick(10);
  await pool.acquire('/b');
  tick(10);
  await pool.acquire('/c');
  assert.equal(pool.size, 2);
  assert.equal(pool.peek('/a'), undefined);
  assert.notEqual(pool.peek('/b'), undefined);
  pool.dispose();
});

test('a transient connect failure is retried', async () => {
  let attempts = 0;
  const { pool, created } = makePool({
    maxAttempts: 2,
    connect: async (workspace: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('database is locked');
      created.push(workspace);
      return { tools: [], close(): void {} };
    },
  });
  const entry = await pool.acquire('/ws');
  assert.equal(entry.workspace, '/ws');
  assert.equal(attempts, 2);
  pool.dispose();
});

test('a persistent failure rejects and is not cached', async () => {
  let attempts = 0;
  const { pool } = makePool({
    maxAttempts: 2,
    connect: async () => {
      attempts += 1;
      throw new Error('boom');
    },
  });
  await assert.rejects(() => pool.acquire('/ws'), /boom/);
  assert.equal(attempts, 2);
  assert.equal(pool.size, 0);
  pool.dispose();
});
