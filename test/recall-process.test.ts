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

test('[5.2] 需要更多工作：不起任何子进程，直接以明确原因拒绝（不再自动转交）', async () => {
  const h = harness({ STUB_SYNC_NEEDED: '40' });
  try {
    await assert.rejects(
      () => h.manager.query({ query: 'a', limit: 1, project: 'alpha' }),
      (error: unknown) => {
        assert.ok(error instanceof RecallUnavailableError);
        assert.equal(error.kind, 'backlog');
        assert.notEqual(error.kind, 'internal');
        return true;
      },
    );
    assert.equal(h.notes().filter((line) => line === 'cmd:query').length, 1, '只查询一次，不重试');
    assert.ok(!h.notes().includes('sync'), '不得起一次性进程');
    assert.ok(!h.notes().includes('rebuild'), '不得起一次性进程');
    assert.equal(h.manager.running(), true, '常驻进程仍在，只是这次拒绝了');
  } finally {
    await h.cleanup();
  }
});

test('[5.2] 正在更新：以同类原因拒绝，且 kind 不是 internal', async () => {
  const h = harness({ STUB_BUSY: '1' });
  try {
    await assert.rejects(
      () => h.manager.query({ query: 'a', limit: 1, project: 'alpha' }),
      (error: unknown) => {
        assert.ok(error instanceof RecallUnavailableError);
        assert.equal(error.kind, 'busy');
        assert.match(error.message, /正在被另一个进程更新/);
        return true;
      },
    );
  } finally {
    await h.cleanup();
  }
});

test('[5.4] 拒绝文案：条数 / 自动上限 / 显式入口 / 预估秒数 / 未改动；超出入口上限时改指操作者命令', async () => {
  const within = harness({ STUB_SYNC_NEEDED: '100' }, { rebuildThreads: 2 });
  try {
    const error = await within.manager
      .query({ query: 'a', limit: 1, project: 'alpha' })
      .then(() => undefined, (e: unknown) => e as RecallUnavailableError);
    assert.ok(error instanceof RecallUnavailableError);
    assert.match(error.message, /100 条/);
    assert.match(error.message, /mem_bridge_recall_sync/);
    assert.match(error.message, /预计约 \d+ 秒/);
    assert.match(error.message, /没有被改动/);
    assert.doesNotMatch(error.message, /删除索引/);
    assert.doesNotMatch(error.message, /自动重试/);
  } finally {
    await within.cleanup();
  }

  const beyond = harness(
    { STUB_SYNC_NEEDED: '5000' },
    { rebuildThreads: 1, embedMsPerDocPerThread: 1000 },
  );
  try {
    const error = await beyond.manager
      .query({ query: 'a', limit: 1, project: 'alpha' })
      .then(() => undefined, (e: unknown) => e as RecallUnavailableError);
    assert.ok(error instanceof RecallUnavailableError);
    assert.match(error.message, /engram-sync/, '连入口也放不下时必须指出操作者路径');
    assert.match(error.message, /searchTimeoutMs/);
  } finally {
    await beyond.cleanup();
  }
});

test('[5.3] 显式入口走 --sync，并把子进程的摘要回报给调用方', async () => {
  const h = harness();
  try {
    const summary = await h.manager.catchUp();
    assert.match(summary, /增量同步完成/);
    assert.ok(h.notes().includes('sync'), '显式入口必须走 --sync');
    assert.ok(!h.notes().includes('rebuild'));
  } finally {
    await h.cleanup();
  }
});

test('[5.3] 一次性进程的退出码归一：3 → runtime-missing，4 → backlog，其它 → internal', async () => {
  const cases: Array<[string, string]> = [
    ['3', 'runtime-missing'],
    ['4', 'backlog'],
    ['1', 'internal'],
  ];
  for (const [exit, kind] of cases) {
    const h = harness({ STUB_REBUILD_EXIT: exit });
    try {
      await assert.rejects(
        () => h.manager.rebuild(),
        (error: unknown) => {
          assert.ok(error instanceof RecallUnavailableError);
          assert.equal(error.kind, kind, `exit=${exit}`);
          return true;
        },
      );
      assert.ok(h.notes().includes('rebuild'), '一次性进程必须以独立进程运行');
    } finally {
      await h.cleanup();
    }
  }
});

test('[5.3] 一次性运行期间：常驻不重启、检索得到 busy、且没有无人处理的 rejection', async () => {
  const h = harness({ STUB_SYNC_DELAY_MS: '800' });
  try {
    const inflight = h.manager.catchUp();
    await waitFor(() => h.notes().includes('sync'));
    assert.equal(h.manager.running(), false, '一次性运行期间不得有常驻进程');
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      await assert.rejects(
        () => h.manager.query({ query: 'a', limit: 1, project: 'alpha' }),
        (error: unknown) => {
          assert.ok(error instanceof RecallUnavailableError);
          assert.equal(error.kind, 'busy');
          assert.notEqual(error.kind, 'internal');
          return true;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(rejections, [], '闸期间不得产生无人处理的 rejection');
      assert.equal(h.manager.running(), false, '闸期间不得启动常驻进程');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    await inflight;
  } finally {
    await h.cleanup();
  }
});

test('[5.3] 一次性运行期间 dispose：迅速返回并终止它（不留下跑满预算的子进程）', async () => {
  const h = harness({ STUB_SYNC_DELAY_MS: '30000' });
  try {
    const inflight = h.manager.catchUp().then(
      () => 'finished' as const,
      (error: unknown) => error,
    );
    await waitFor(() => h.notes().includes('sync'));
    const t0 = Date.now();
    await h.manager.dispose();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `dispose 不得等一次性进程自己结束（实际 ${elapsed}ms）`);
    const settled = await inflight;
    assert.ok(settled instanceof Error, '被终止的一次性进程必须以失败结算，而不是悄悄完成');
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
