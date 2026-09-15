import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RecallProcessManager, RecallUnavailableError } from '../dist/recall/process.js';
import { expectedOf, fakeModelDir, removeDir, tempDir } from './recall-support.ts';

/**
 * Resident-worker lifecycle.
 *
 * The worker is replaced by test/recall-worker-stub.mjs, so these tests are about
 * the CONTRACT in src/recall/process.ts — lazy start, one process per plugin
 * instance, reclaim that never touches an in-flight call, teardown with no
 * survivors, per-call budget, and the rebuild-and-retry path — not about the
 * engine (covered by recall-engine.test.ts) or the model (covered by the
 * out-of-repo acceptance).
 */

const STUB = join(process.cwd(), 'test', 'recall-worker-stub.mjs');

interface Harness {
  manager: RecallProcessManager;
  flag: string;
  dir: string;
  modelDir: string;
  logs: string[];
  notes(): string[];
  pids: number[];
  cleanup(): Promise<void>;
}

function harness(env: Record<string, string> = {}, options: Record<string, unknown> = {}): Harness {
  const dir = tempDir('recall-process-');
  const flag = join(dir, 'stub');
  const logs: string[] = [];
  const pids: number[] = [];
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  process.env.STUB_FLAG = flag;
  const modelDir = fakeModelDir(dir);
  const manager = new RecallProcessManager({
    dbPath: join(dir, 'source.db'),
    indexPath: join(dir, 'index.db'),
    modelDir,
    threads: 2,
    w: 0.2,
    topK: 50,
    coverage: 'field_cov',
    idleMs: 60000,
    timeoutMs: 5000,
    workerPath: STUB,
    // Synthetic bytes can never match the repository's declaration, so the
    // judgement is fed the fixture's own identity (design D11).
    expected: expectedOf(modelDir),
    log: {
      debug: (message: string) => {
        logs.push(message);
        const match = /pid=(\d+)/.exec(message);
        if (match !== null) pids.push(Number(match[1]));
      },
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    },
    ...options,
  });
  return {
    manager,
    flag,
    dir,
    modelDir,
    logs,
    pids,
    notes: () => readNotes(flag),
    cleanup: async () => {
      await manager.dispose();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeDir(dir);
    },
  };
}

/** What the stub worker recorded for this run; empty means it never started. */
function readNotes(flag: string): string[] {
  return existsSync(`${flag}.log`) ? readFileSync(`${flag}.log`, 'utf8').trim().split('\n') : [];
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor 超时');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('懒启动：未检索时没有子进程，连续两次检索共用一个，空闲后回收', async () => {
  const h = harness();
  try {
    assert.equal(h.manager.running(), false, '未检索时不得有子进程');

    const first = await h.manager.query({ query: 'a', limit: 1, project: 'alpha' });
    assert.equal(first.hits.length, 1);
    assert.equal(h.manager.running(), true);
    await waitFor(() => h.pids.length === 1);
    const pid = h.pids[0]!;

    await h.manager.query({ query: 'b', limit: 1, project: 'alpha' });
    assert.deepEqual(h.pids, [pid], '同一插件实例内应复用同一个进程');

    // 未到空闲时长：不回收。
    assert.equal(h.manager.sweep(Date.now()), 0);
    assert.equal(h.manager.running(), true);
    // 超过空闲时长：回收。
    assert.equal(h.manager.sweep(Date.now() + 600_000), 1);
    await waitFor(() => !h.manager.running());
    await waitFor(() => !alive(pid));
  } finally {
    await h.cleanup();
  }
});

test('在途调用期间的空闲回收不得关闭该进程', async () => {
  const h = harness({ STUB_QUERY_DELAY_MS: '400' });
  try {
    const inflight = h.manager.query({ query: 'slow', limit: 1, project: 'alpha' });
    await waitFor(() => h.manager.inFlight() === 1);
    assert.equal(h.manager.sweep(Date.now() + 600_000), 0, '有在途调用时不得回收');
    assert.equal(h.manager.running(), true);
    await inflight;
  } finally {
    await h.cleanup();
  }
});

test('回收开关为 0 时永不回收', async () => {
  const h = harness({}, { idleMs: 0 });
  try {
    await h.manager.query({ query: 'a', limit: 1, project: 'alpha' });
    assert.equal(h.manager.sweep(Date.now() + 600_000), 0);
    assert.equal(h.manager.running(), true);
  } finally {
    await h.cleanup();
  }
});

test('卸载后没有残留子进程', async () => {
  const h = harness();
  try {
    await h.manager.query({ query: 'a', limit: 1, project: 'alpha' });
    await waitFor(() => h.pids.length === 1);
    const pid = h.pids[0]!;
    assert.ok(alive(pid));
    await h.manager.dispose();
    await waitFor(() => !alive(pid), 4000);
    assert.equal(h.manager.running(), false);
  } finally {
    await h.cleanup();
  }
});

test('单次调用超时：以明确原因失败并终止子进程', async () => {
  const h = harness({ STUB_QUERY_DELAY_MS: '3000' }, { timeoutMs: 120 });
  try {
    await assert.rejects(
      () => h.manager.query({ query: 'slow', limit: 1, project: 'alpha' }),
      (error: unknown) => {
        assert.ok(error instanceof RecallUnavailableError);
        assert.equal(error.kind, 'timeout');
        assert.match(error.message, /searchTimeoutMs/);
        return true;
      },
    );
    await waitFor(() => !h.manager.running());
  } finally {
    await h.cleanup();
  }
});

test('索引需要重建：自动跑一次全量重建再重试，且不把重建留给模型', async () => {
  const h = harness({ STUB_REBUILD_NEEDED: '1' });
  try {
    const payload = await h.manager.query({ query: 'a', limit: 1, project: 'alpha' });
    assert.equal(payload.hits.length, 1);
    assert.ok(existsSync(`${h.flag}.rebuilt`), '应已运行过一次性重建');
    assert.ok(h.notes().includes('rebuild'), '重建必须以独立进程运行');
    assert.ok(h.logs.some((line) => /开始全量重建/.test(line)));
    // 重试发生在重建之后，且只重试一次。
    assert.equal(h.notes().filter((line) => line === 'cmd:query').length, 2);
  } finally {
    await h.cleanup();
  }
});

test('重建失败时把失败原因报给调用方，而不是继续重试', async () => {
  const h = harness({ STUB_REBUILD_NEEDED: '1', STUB_REBUILD_EXIT: '1' });
  try {
    await assert.rejects(
      () => h.manager.query({ query: 'a', limit: 1, project: 'alpha' }),
      (error: unknown) => {
        assert.ok(error instanceof RecallUnavailableError);
        assert.equal(error.kind, 'internal');
        assert.match(error.message, /全量重建派生索引失败/);
        return true;
      },
    );
    assert.equal(h.notes().filter((line) => line === 'cmd:query').length, 1, '重建失败不应再重试');
  } finally {
    await h.cleanup();
  }
});

test('[2.6] 重建因模型原因失败时以独立退出码归一为 runtime-missing', async () => {
  const h = harness({ STUB_REBUILD_NEEDED: '1', STUB_REBUILD_EXIT: '3' });
  try {
    await assert.rejects(
      () => h.manager.query({ query: 'a', limit: 1, project: 'alpha' }),
      (error: unknown) => {
        assert.ok(error instanceof RecallUnavailableError);
        assert.equal(
          error.kind,
          'runtime-missing',
          '模型原因不得被报成「重建失败」',
        );
        return true;
      },
    );
  } finally {
    await h.cleanup();
  }
});

test('[2.4] 判定失败：不起子进程、不产生无人处理的 rejection，原因消除后立即恢复', async () => {
  const dir = tempDir('recall-judge-');
  const modelDir = fakeModelDir(dir);
  const flag = join(dir, 'stub');
  const previousFlag = process.env.STUB_FLAG;
  process.env.STUB_FLAG = flag;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  const manager = new RecallProcessManager({
    dbPath: join(dir, 's.db'),
    indexPath: join(dir, 'i.db'),
    modelDir,
    threads: 1,
    w: 0.2,
    topK: 50,
    coverage: 'field_cov',
    idleMs: 60000,
    timeoutMs: 5000,
    workerPath: STUB,
    expected: expectedOf(modelDir),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  try {
    const configPath = join(modelDir, 'tokenizer_config.json');
    const original = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, `${original} `);

    await assert.rejects(
      () => manager.query({ query: 'a', limit: 1, project: 'alpha' }),
      (error: unknown) => {
        assert.ok(error instanceof RecallUnavailableError);
        assert.equal(error.kind, 'runtime-missing');
        assert.match(error.message, /tokenizer_config\.json/, '错误里须指名不符的文件');
        return true;
      },
    );
    assert.equal(manager.running(), false, '(b) 判定失败不得起子进程');
    assert.deepEqual(await readNotes(flag), [], '(b) 子进程从未被 spawn');

    // (c) 判定抛在 `start()` 的异步体之外，所以没有派生 promise 会吞掉它。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, [], '(c) 不得出现无人处理的 rejection');

    // (d) 判定失败不缓存任何东西：原因消除后紧接着的下一次调用就恢复。
    writeFileSync(configPath, original);
    await manager.query({ query: 'a', limit: 1, project: 'alpha' });
    assert.equal(manager.running(), true, '(d) 恢复后应正常起子进程');
  } finally {
    process.off('unhandledRejection', onRejection);
    if (previousFlag === undefined) delete process.env.STUB_FLAG;
    else process.env.STUB_FLAG = previousFlag;
    await manager.dispose();
    removeDir(dir);
  }
});

test('[2.7] 每次调用的检查只判存在性：改动内容不影响同一生命周期内的第二次检索', async () => {
  const h = harness();
  try {
    await h.manager.query({ query: 'a', limit: 1, project: 'alpha' });
    const pids = [...h.pids];

    // Presence is untouched, content is not: the per-call guard must not care
    // (it is the cheap check), and the running worker must not be re-judged or
    // restarted — the bytes it holds in memory are the ones it was judged on.
    writeFileSync(join(h.modelDir, 'tokenizer.json'), '{ this is not json');
    assert.doesNotThrow(() => h.manager.assertInstalled(), '每调用一次的检查不得做摘要比对');
    await h.manager.query({ query: 'a', limit: 1, project: 'alpha' });
    assert.deepEqual(h.pids, pids, '第二次检索不得重新起进程');
  } finally {
    await h.cleanup();
  }
});

test('子进程退出会让在途调用以明确原因失败，而不是挂住', async () => {
  const dir = tempDir('recall-crash-');
  const flag = join(dir, 'stub');
  const logged: string[] = [];
  process.env.STUB_FLAG = flag;
  writeFileSync(join(dir, 'suicide.mjs'), "process.exit(3);\n");
  const modelDir = fakeModelDir(dir);
  const manager = new RecallProcessManager({
    dbPath: join(dir, 's.db'),
    indexPath: join(dir, 'i.db'),
    modelDir,
    threads: 1,
    w: 0.2,
    topK: 50,
    coverage: 'field_cov',
    idleMs: 1000,
    timeoutMs: 5000,
    workerPath: join(dir, 'suicide.mjs'),
    expected: expectedOf(modelDir),
    log: { debug: () => {}, info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) },
  });
  try {
    await assert.rejects(
      () => manager.query({ query: 'a', limit: 1, project: 'alpha' }),
      (error: unknown) => {
        assert.ok(error instanceof RecallUnavailableError);
        return true;
      },
    );
    assert.ok(logged.some((line) => /检索子进程退出|启动失败/.test(line)), '日志必须明确');
  } finally {
    await manager.dispose();
    removeDir(dir);
  }
});
