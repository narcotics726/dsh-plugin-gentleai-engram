import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RecallEngine } from '../dist/recall/engine.js';
import { RecallProcessManager } from '../dist/recall/process.js';
import { SAVE_SOURCE_MARK } from '../dist/save/params.js';
import { SAVE_TIMEOUT_MARGIN_MS, saveToolTimeoutMs } from '../dist/save-tool.js';
import {
  expectedOf,
  fakeEmbedder,
  fakeModelDir,
  removeDir,
  tempDir,
  vectorMap,
  writeSource,
} from './recall-support.ts';

/**
 * The candidate query.
 *
 * Two audiences. Most of these tests drive `RecallEngine.candidates` directly:
 * the contract there is deliberately the OPPOSITE of retrieval (no catch-up, no
 * rebuild, no refusal, same project only), and the evidence structure is defined
 * there. The worker/manager half — budget, silent degradation, cancellation — is
 * exercised through `RecallProcessManager` against test/recall-worker-stub.mjs.
 */

interface Built {
  engine: RecallEngine;
  dbPath: string;
  indexPath: string;
  dir: string;
}

async function built(
  rows: Parameters<typeof writeSource>[1],
  options: { topK?: number; dim?: number; vectors?: Map<string, readonly number[]> } = {},
): Promise<Built> {
  const dir = tempDir('candidates-');
  const dbPath = join(dir, 'engram.db');
  const indexPath = join(dir, 'index.db');
  writeSource(dbPath, rows);
  const engine = new RecallEngine({
    dbPath,
    indexPath,
    w: 0.2,
    topK: options.topK ?? 50,
    coverage: 'field_cov',
    dim: options.dim ?? 4,
    embedder: async () => fakeEmbedder({ dim: options.dim ?? 4, vectors: options.vectors }),
  });
  await engine.rebuild();
  return { engine, dbPath, indexPath, dir };
}

function query(overrides: Partial<Parameters<RecallEngine['candidates']>[0]> = {}) {
  return {
    title: '派生索引只读',
    content: '候选在写入之前算好。',
    type: 'decision',
    topicKey: '',
    sessionId: '',
    project: 'alpha',
    limit: 5,
    ...overrides,
  };
}

test('派生数据缺失时不重建、不创建任何东西，只表现为没有候选', async () => {
  const dir = tempDir('candidates-missing-');
  try {
    const dbPath = join(dir, 'engram.db');
    const indexPath = join(dir, 'index', 'index.db');
    writeSource(dbPath, [{ id: 1, title: 't', content: 'c', project: 'alpha' }]);
    const engine = new RecallEngine({
      dbPath,
      indexPath,
      w: 0.2,
      topK: 50,
      coverage: 'field_cov',
      embedder: async () => fakeEmbedder({ dim: 4 }),
    });
    const payload = await engine.candidates(query());
    assert.deepEqual(payload.candidates, []);
    assert.equal(payload.metering.docCount, 0);
    assert.ok(!existsSync(indexPath), '候选查询永不触发重建：连索引文件都不该被创建');
    engine.close();
  } finally {
    removeDir(dir);
  }
});

test('派生数据不可信时返回空，且一个字节都不改', async () => {
  const b = await built([{ id: 1, title: '派生索引只读', content: '候选在写入之前算好。', project: 'alpha' }]);
  try {
    const db = new DatabaseSync(b.indexPath);
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('update_prefix','tampered')").run();
    db.close();
    const docsBefore = docCountOf(b.indexPath);
    const payload = await b.engine.candidates(query());
    assert.deepEqual(payload.candidates, []);
    assert.equal(docCountOf(b.indexPath), docsBefore, '不可信时不读取、不改写');
  } finally {
    b.engine.close();
    removeDir(b.dir);
  }
});

/** Documents in the derived index, read straight from the file. */
function docCountOf(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare('SELECT count(*) AS c FROM docs').get() as { c: number }).c);
  } finally {
    db.close();
  }
}

test('正本落后时不追赶：候选按当时索引作答，落后与规模只是读数', async () => {
  const b = await built([
    { id: 1, title: '派生索引只读', content: '候选在写入之前算好。', project: 'alpha' },
  ]);
  try {
    writeSource(b.dbPath, [
      { id: 1, title: '派生索引只读', content: '候选在写入之前算好。', project: 'alpha' },
      { id: 2, title: '派生索引只读（新）', content: '候选在写入之前算好。新写的。', project: 'alpha' },
    ]);
    const payload = await b.engine.candidates(query());
    assert.equal(payload.metering.sourceChanged, true, '与读层同一个整表内容哈希判定');
    assert.equal(payload.metering.lagDocs, 1);
    assert.equal(payload.metering.docCount, 1, '索引里仍只有一条');
    assert.ok(
      payload.candidates.every((candidate) => candidate.id !== 2),
      '尚未进索引的那条不可能成为候选',
    );
  } finally {
    b.engine.close();
    removeDir(b.dir);
  }
});

test('候选限定在同一项目：跨项目的相似条目不出现在结果里', async () => {
  const b = await built([
    { id: 1, title: '派生索引只读', content: '候选在写入之前算好。', project: 'alpha' },
    { id: 2, title: '派生索引只读', content: '候选在写入之前算好。', project: 'beta' },
  ]);
  try {
    const payload = await b.engine.candidates(query());
    assert.deepEqual(
      payload.candidates.map((candidate) => candidate.id),
      [1],
    );
    assert.ok(payload.metering.filteredOut >= 1, '被项目过滤掉的计入读数');
  } finally {
    b.engine.close();
    removeDir(b.dir);
  }
});

test('证据：规范值就是那张结构表，字段名中性、不含依赖新行的字段', async () => {
  const title = '派生索引只读';
  const content = '候选在写入之前算好。';
  const b = await built([
    { id: 1, title, content, type: 'decision', project: 'alpha' },
    { id: 2, title, content: '别的正文。', type: 'decision', project: 'alpha' },
  ]);
  try {
    const payload = await b.engine.candidates(query({ topicKey: 'architecture/index', sessionId: 'sess-1' }));
    const first = payload.candidates[0]!;
    assert.deepEqual(
      Object.keys(first).sort(),
      [
        'corpus_size',
        'id',
        'identical_content',
        'same_session',
        'same_topic_key',
        'same_type_and_title',
        'semantic_rank',
        'shared_rare_terms',
        'title',
        'type',
        'updated_at',
      ],
      '规范值的字段就是设计里那一张表',
    );
    assert.ok(!Object.hasOwn(first, 'will_update'), 'will_update 由宿主在写后判定，不在候选查询里');
    assert.ok(!Object.hasOwn(first, 'earlier'), '依赖「新行已经存在」的比较不得出现');
    assert.equal(first.same_type_and_title, true);
    assert.equal(first.identical_content, true);
    assert.equal(first.semantic_rank, 1);
    assert.equal(first.corpus_size, 2);
    assert.ok(first.shared_rare_terms.count > 0, '中文近似条目必须有共享稀有词');
    assert.equal(
      first.shared_rare_terms.terms.length,
      first.shared_rare_terms.count,
      '数值必须追到具体的词',
    );
    // topic_key 与 session_id 不在派生索引里，只能回读正本得到。
    const withKeys = await b.engine.candidates(
      query({ topicKey: '', sessionId: 'sess-1', limit: 5 }),
    );
    assert.equal(withKeys.candidates[0]!.same_topic_key, '', '没给主题键就不声称共享主题键（空串是哨兵）');
    assert.equal(withKeys.candidates[0]!.same_session, false, '正本里那条不属于本会话');
  } finally {
    b.engine.close();
    removeDir(b.dir);
  }
});

test('候选排序就是读层自己的排序：同一段文本，两条路径给出同一个顺序', async () => {
  const title = '派生索引只读';
  const content = '候选在写入之前算好，并与检索走同一个打分器。';
  const b = await built([
    { id: 1, title, content, project: 'alpha' },
    { id: 2, title: '别的标题', content, project: 'alpha' },
    { id: 3, title, content: '无关的第三段。', project: 'alpha' },
  ]);
  try {
    const payload = await b.engine.candidates(query({ title, content, limit: 3 }));
    const recall = await b.engine.query({ query: `${title}\n${content}`, limit: 3, project: 'alpha' }, {});
    assert.deepEqual(
      payload.candidates.map((candidate) => candidate.id),
      recall.hits.map((hit) => hit.id),
      '候选顺序必须与同文本的检索顺序一致（同一个打分器，同一套相似定义）',
    );
  } finally {
    b.engine.close();
    removeDir(b.dir);
  }
});

test('打分常量仍从索引 meta 读出：改动它，候选顺序随之变化', async () => {
  // Three texts, one vector: every cosine ties, so the ordering is decided by the
  // lexical layer and by which document the coverage-boost pool admitted. doc1
  // repeats the query token in its TITLE, doc2 has one title hit plus one content
  // hit — so the two differ exactly in how the title weight is spent.
  const vector = [1, 0, 0, 0];
  const title = 'aaaa';
  const content = 'q2';
  const vectors = vectorMap([
    { text: `${title}\n${content}`, vector },
    { text: 'aaaa aaaa\nq1', vector },
    { text: 'aaaa\naaaa', vector },
  ]);
  const b = await built(
    [
      { id: 1, title: 'aaaa aaaa', content: 'q1', project: 'alpha' },
      { id: 2, title: 'aaaa', content: 'aaaa', project: 'alpha' },
    ],
    { topK: 1, vectors },
  );
  try {
    const before = await b.engine.candidates(query({ title, content, limit: 1 }));
    assert.deepEqual(before.candidates.map((c) => c.id), [1], '标题里的重复命中在默认权重下胜出');

    const db = new DatabaseSync(b.indexPath);
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('scoring_title_weight','0.0')").run();
    db.close();
    const after = await b.engine.candidates(query({ title, content, limit: 1 }));
    assert.deepEqual(after.candidates.map((c) => c.id), [2], '改了打分常量，候选顺序随之变化');
  } finally {
    b.engine.close();
    removeDir(b.dir);
  }
});

// ---- worker / manager half -------------------------------------------------

const WORKER_STUB = join(process.cwd(), 'test', 'recall-worker-stub.mjs');

interface Harness {
  manager: RecallProcessManager;
  logs: string[];
  dir: string;
  cleanup(): Promise<void>;
}

function harness(env: Record<string, string> = {}, withoutModel = false): Harness {
  const dir = tempDir('candidates-process-');
  const logs: string[] = [];
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const modelDir = withoutModel ? join(dir, 'no-model') : fakeModelDir(dir);
  const manager = new RecallProcessManager({
    dbPath: join(dir, 'source.db'),
    indexPath: join(dir, 'index.db'),
    modelDir,
    threads: 1,
    w: 0.2,
    topK: 50,
    coverage: 'field_cov',
    idleMs: 60000,
    timeoutMs: 5000,
    workerPath: WORKER_STUB,
    ...(withoutModel ? {} : { expected: expectedOf(modelDir) }),
    log: {
      debug: (message: string) => logs.push(message),
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    },
  });
  return {
    manager,
    logs,
    dir,
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

test('运行时缺失时候选查询静默返回空，而检索在同样情形下响亮失败', async () => {
  const h = harness({}, true);
  try {
    const lookup = await h.manager.candidates(query(), { budgetMs: 1000 });
    assert.deepEqual(lookup.payload.candidates, []);
    assert.ok(lookup.degraded !== undefined, '降级原因进日志/读数，不进行为');
    await assert.rejects(() => h.manager.query({ query: 'x', limit: 5 }), /模型|运行时|不可用/);
  } finally {
    await h.cleanup();
  }
});

test('候选超出预算即放弃，且不会因此杀掉检索进程', async () => {
  const h = harness({ STUB_CANDIDATES_DELAY_MS: '4000' });
  try {
    const lookup = await h.manager.candidates(query(), { budgetMs: 150 });
    assert.deepEqual(lookup.payload.candidates, []);
    assert.equal(lookup.degraded, 'timeout');
    assert.ok(h.manager.running(), '候选是增强：超预算不得让读层失去已加载的模型');
  } finally {
    await h.cleanup();
  }
});

test('候选查询接受取消信号', async () => {
  const h = harness({ STUB_CANDIDATES_DELAY_MS: '4000' });
  try {
    const controller = new AbortController();
    const pending = h.manager.candidates(query(), { budgetMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const lookup = await pending;
    assert.deepEqual(lookup.payload.candidates, []);
    assert.equal(lookup.degraded, 'cancelled');
  } finally {
    await h.cleanup();
  }
});

test('候选查询正常返回：契约与检索相反，但结果是同一套结构', async () => {
  const h = harness();
  try {
    const lookup = await h.manager.candidates(query(), { budgetMs: 3000 });
    assert.ok(lookup.degraded === undefined, `不应降级：${lookup.degraded ?? ''}`);
    assert.deepEqual(lookup.payload.candidates, [], 'stub 只证明通路，不证明排序');
  } finally {
    await h.cleanup();
  }
});

test('来源标记与静态超时的常量仍然只有一处定义', () => {
  assert.equal(SAVE_SOURCE_MARK, 'dsh-engram-bridge');
  assert.ok(SAVE_TIMEOUT_MARGIN_MS > 0);
  assert.equal(saveToolTimeoutMs({ saveCandidateBudgetMs: 1, writeTimeoutMs: 2, saveFallbackBudgetMs: 3 }), 6 + SAVE_TIMEOUT_MARGIN_MS);
});
