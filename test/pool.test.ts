import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionPool } from '../dist/pool.js';

const silent = { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  return {
    pool,
    created,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test('same workspace reuses one connection', async () => {
  const { pool, created } = makePool();
  await pool.withConnection('/ws', async () => undefined);
  await pool.withConnection('/ws', async () => undefined);
  assert.deepEqual(created, ['/ws']);
  assert.equal(pool.size, 1);
  pool.dispose();
});

test('different workspaces get their own connection', async () => {
  const { pool, created } = makePool();
  await pool.withConnection('/a', async () => undefined);
  await pool.withConnection('/b', async () => undefined);
  assert.deepEqual(created, ['/a', '/b']);
  assert.equal(pool.size, 2);
  pool.dispose();
});

test('concurrent first use of one workspace spawns once', async () => {
  const { pool, created } = makePool();
  const [a, b] = await Promise.all([
    pool.withConnection('/ws', async (entry) => entry),
    pool.withConnection('/ws', async (entry) => entry),
  ]);
  assert.equal(a, b);
  assert.deepEqual(created, ['/ws']);
  pool.dispose();
});

test('calls on different workspaces run concurrently, not through the spawn chain', async () => {
  const { pool } = makePool();
  const started: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = pool.withConnection('/a', async () => {
    started.push('/a');
    await gate;
  });
  const second = pool.withConnection('/b', async () => {
    started.push('/b');
    await gate;
  });
  await flush();
  assert.deepEqual(started.sort(), ['/a', '/b'], 'both call bodies must be running');
  release?.();
  await Promise.all([first, second]);
  pool.dispose();
});

test('idle connections are swept', async () => {
  const { pool, tick } = makePool();
  await pool.withConnection('/ws', async () => undefined);
  tick(500);
  assert.deepEqual(pool.sweep(), ['/ws']);
  assert.equal(pool.size, 0);
  pool.dispose();
});

test('a connection with a call in flight is not reclaimed as idle', async () => {
  const { pool, tick } = makePool();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = pool.withConnection('/ws', async () => {
    await gate;
  });
  await flush();
  tick(500);
  assert.deepEqual(pool.sweep(), [], 'a busy connection must survive the idle sweep');
  release?.();
  await call;
  assert.deepEqual(pool.sweep(), [], 'the idle clock restarts at settlement');
  tick(500);
  assert.deepEqual(pool.sweep(), ['/ws'], 'and only then is it reclaimable');
  pool.dispose();
});

test('a failed call releases the in-flight slot and restarts the idle clock', async () => {
  const { pool, tick } = makePool();
  await assert.rejects(
    () =>
      pool.withConnection('/ws', async () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(pool.peek('/ws')?.inFlight, 0);
  tick(50);
  assert.deepEqual(pool.sweep(), []);
  tick(200);
  assert.deepEqual(pool.sweep(), ['/ws']);
  pool.dispose();
});

test('over the limit the least recently used connection is closed', async () => {
  const { pool, tick } = makePool({ maxConnections: 2 });
  await pool.withConnection('/a', async () => undefined);
  tick(10);
  await pool.withConnection('/b', async () => undefined);
  tick(10);
  await pool.withConnection('/c', async () => undefined);
  assert.equal(pool.size, 2);
  assert.equal(pool.peek('/a'), undefined);
  assert.notEqual(pool.peek('/b'), undefined);
  pool.dispose();
});

test('over the limit a BUSY connection is still closed, and the cap holds', async () => {
  const warnings: string[] = [];
  const { pool } = makePool({
    maxConnections: 1,
    log: { ...silent, warn: (message: string) => warnings.push(message) },
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = pool.withConnection('/a', async () => {
    await gate;
    return 'a done';
  });
  await flush();

  const second = await pool.withConnection('/b', async () => 'b done');
  assert.equal(second, 'b done', 'the new workspace still gets served');
  assert.equal(pool.size, 1, 'the cap is a hard limit even while the victim is busy');
  assert.equal(pool.peek('/a'), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /in flight/);

  release?.();
  // The in-flight call's own failure is the transport's contract (the child is gone), not
  // the pool's; the pool guarantees only that the slot is released and the cap holds.
  assert.equal(await call, 'a done');
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
  const workspace = await pool.withConnection('/ws', async (entry) => entry.workspace);
  assert.equal(workspace, '/ws');
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
  await assert.rejects(() => pool.withConnection('/ws', async () => undefined), /boom/);
  assert.equal(attempts, 2);
  assert.equal(pool.size, 0);
  pool.dispose();
});
