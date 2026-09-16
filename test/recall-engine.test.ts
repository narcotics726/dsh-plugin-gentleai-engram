import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RecallEngine } from '../dist/recall/engine.js';
import { inspectIndex } from '../dist/recall/index-db.js';
import { docText, fakeEmbedder, removeDir, tempDir, writeSource, type SourceRow } from './recall-support.ts';

/**
 * Read-layer behaviour on the axes the spec is written about: filtering versus
 * the return cut, project/scope/type semantics, truncation visibility, and
 * freshness.
 *
 * The ranking is made fully predictable by querying a token no document
 * contains (`zzz`): then no document is a lexical candidate, no document gets the
 * coverage boost, and the order is exactly the cosine order the fixture sets. The
 * dimensions are 4 rather than 512 for the same reason — the arithmetic under
 * test is the ordering, not the model.
 */

const DIM = 4;
const QUERY = 'zzz';
const QUERY_VEC = [1, 0, 0, 0];

interface Fixture {
  dir: string;
  engine: RecallEngine;
  cleanup(): void;
}

function abs(cos: number): readonly number[] {
  return [cos, Math.sqrt(Math.max(0, 1 - cos * cos)), 0, 0];
}

/** Rows with an explicit cosine against the query, highest first. */
function rankedRows(spec: ReadonlyArray<{ id: number; cos: number; type?: string; scope?: string; project?: string }>): SourceRow[] {
  return spec.map((entry) => ({
    id: entry.id,
    title: `t${entry.id}`,
    content: `c${entry.id}`,
    type: entry.type ?? 'A',
    scope: entry.scope ?? 'project',
    project: entry.project ?? 'alpha',
  }));
}

function withVectors(rows: SourceRow[], spec: ReadonlyArray<{ id: number; cos: number }>): Map<string, readonly number[]> {
  const vectors = new Map<string, readonly number[]>();
  for (const row of rows) vectors.set(docText(row), abs(0.5));
  for (const entry of spec) {
    const row = rows.find((candidate) => candidate.id === entry.id)!;
    vectors.set(docText(row), abs(entry.cos));
  }
  vectors.set(QUERY, QUERY_VEC);
  return vectors;
}

async function engineWith(spec: ReadonlyArray<{ id: number; cos: number; type?: string; scope?: string; project?: string }>): Promise<Fixture> {
  const rows = rankedRows(spec);
  const dir = tempDir();
  const dbPath = join(dir, 'source.db');
  writeSource(dbPath, rows);
  const engine = new RecallEngine({
    dbPath,
    indexPath: join(dir, 'index.db'),
    w: 0.2,
    topK: 50,
    coverage: 'field_cov',
    dim: DIM,
    embedder: async () => fakeEmbedder({ dim: DIM, vectors: withVectors(rows, spec) }),
  });
  await engine.rebuild();
  return {
    dir,
    engine,
    rows,
    cleanup: () => {
      engine.close();
      removeDir(dir);
    },
  };
}

test('[3.1] 换代后的检索：限额内就地重建并作答；上限不足则当场拒绝且不动索引', async () => {
  const rows = rankedRows([{ id: 1, cos: 0.99 }]);
  const dir = tempDir();
  const dbPath = join(dir, 'source.db');
  const indexPath = join(dir, 'index.db');
  writeSource(dbPath, rows);
  const options = {
    dbPath,
    indexPath,
    w: 0.2,
    topK: 50,
    coverage: 'field_cov' as const,
    dim: DIM,
    embedder: async () => fakeEmbedder({ dim: DIM, vectors: withVectors(rows, [{ id: 1, cos: 0.99 }]) }),
  };
  const before = new RecallEngine({ ...options, identityDigest: '上一代' });
  const after = new RecallEngine({ ...options, identityDigest: '这一代' });
  try {
    await before.rebuild();
    before.close();

    // A generation change is Δ = the whole corpus, so it goes through the SAME
    // judgement as any delta: within the cap, the very same query rebuilds in
    // place and answers. No external rebuild, no special case.
    const payload = await after.query({ query: QUERY, limit: 1, project: 'alpha' }, { maxDocs: 10 });
    assert.equal(payload.hits.length, 1);
    assert.equal(payload.metering.mode, 'full');
    after.close();

    // With a cap that cannot fit the corpus, the same query declines the work
    // and leaves the index exactly as it found it.
    const denied = new RecallEngine({ ...options, identityDigest: '又一代' });
    await assert.rejects(
      () => denied.query({ query: QUERY, limit: 1, project: 'alpha' }, { maxDocs: 0 }),
      (error: { kind?: string; mode?: string; pendingDocs?: number }) => {
        assert.equal(error.kind, 'sync-needed');
        assert.equal(error.mode, 'full');
        assert.equal(error.pendingDocs, 1, '待处理量 = 语料条数');
        return true;
      },
    );
    denied.close();
    // Untouched: the index still belongs to the rejected generation.
    assert.equal(inspectIndex(indexPath, '这一代').needsFullBuild, false, '拒绝不得改动派生数据');
    assert.equal(inspectIndex(indexPath, '又一代').needsFullBuild, true);
  } finally {
    before.close();
    after.close();
    removeDir(dir);
  }
});

test('筛选不影响任何条目的得分，也不改变相对顺序', async () => {  const f = await engineWith([
    { id: 1, cos: 0.99, type: 'A' },
    { id: 2, cos: 0.8, type: 'B' },
    { id: 3, cos: 0.6, type: 'A' },
  ]);
  try {
    const unfiltered = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' });
    const filtered = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha', type: 'A' });
    assert.deepEqual(filtered.hits.map((hit) => hit.id), [1, 3]);
    for (const hit of filtered.hits) {
      const same = unfiltered.hits.find((candidate) => candidate.id === hit.id)!;
      assert.equal(hit.score, same.score, `#${hit.id} 的得分不应因筛选改变`);
    }
    assert.deepEqual(
      filtered.hits.map((hit) => hit.id),
      unfiltered.hits.filter((hit) => [1, 3].includes(hit.id)).map((hit) => hit.id),
    );
  } finally {
    f.cleanup();
  }
});

test('不匹配筛选的条目不占返回名额，结果补足到要求的条数', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.99, type: 'B' },
    { id: 2, cos: 0.9, type: 'A' },
    { id: 3, cos: 0.8, type: 'A' },
    { id: 4, cos: 0.7, type: 'A' },
  ]);
  try {
    const payload = await f.engine.query({ query: QUERY, limit: 3, project: 'alpha', type: 'A' });
    assert.deepEqual(payload.hits.map((hit) => hit.id), [2, 3, 4]);
    assert.equal(payload.filteredOut, 1);
    assert.equal(payload.truncated, false);
  } finally {
    f.cleanup();
  }
});

test('触顶且上限之后仍有匹配项时报告未显示', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.99, type: 'B' },
    { id: 2, cos: 0.9, type: 'A' },
    { id: 3, cos: 0.8, type: 'A' },
    { id: 4, cos: 0.7, type: 'A' },
    { id: 5, cos: 0.6, type: 'A' },
  ]);
  try {
    const payload = await f.engine.query({ query: QUERY, limit: 3, project: 'alpha', type: 'A' });
    assert.deepEqual(payload.hits.map((hit) => hit.id), [2, 3, 4]);
    assert.equal(payload.truncated, true, '第 5 条仍是匹配项，必须报告还有未显示的');
  } finally {
    f.cleanup();
  }
});

test('恰好 limit 条匹配项且上限之后不再有匹配项时不报告截断（决定性用例）', async () => {
  const f = await engineWith([
    // 唯一能逼出"触顶后继续扫完剩余排序"的用例：被筛选排除的条目排在已返回条目
    // 之前，但匹配项恰好只有 limit 条。只按"被排除条目数 > 0"实现的版本会在这里
    // 谎报截断。
    { id: 1, cos: 0.99, type: 'B' },
    { id: 2, cos: 0.9, type: 'A' },
    { id: 3, cos: 0.8, type: 'A' },
    { id: 4, cos: 0.7, type: 'A' },
  ]);
  try {
    const payload = await f.engine.query({ query: QUERY, limit: 3, project: 'alpha', type: 'A' });
    assert.deepEqual(payload.hits.map((hit) => hit.id), [2, 3, 4]);
    assert.equal(payload.hits.length, 3);
    assert.equal(payload.filteredOut, 1, '确实有一个条目被筛掉，但它排在已返回条目之前');
    assert.equal(payload.truncated, false, '匹配项恰好 limit 条：不得提示还有未显示的');
  } finally {
    f.cleanup();
  }
});

test('被排除的条目都排在已返回条目之后时不报告短少', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.99, type: 'A' },
    { id: 2, cos: 0.9, type: 'A' },
    { id: 3, cos: 0.8, type: 'A' },
    { id: 4, cos: 0.1, type: 'B' },
  ]);
  try {
    const payload = await f.engine.query({ query: QUERY, limit: 3, project: 'alpha', type: 'A' });
    assert.deepEqual(payload.hits.map((hit) => hit.id), [1, 2, 3]);
    assert.equal(payload.filteredOut, 1);
    assert.equal(payload.truncated, false);
  } finally {
    f.cleanup();
  }
});

test('提高返回条数后原先未显示的条目出现', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.99, type: 'A' },
    { id: 2, cos: 0.9, type: 'A' },
    { id: 3, cos: 0.8, type: 'A' },
  ]);
  try {
    const small = await f.engine.query({ query: QUERY, limit: 2, project: 'alpha' });
    const large = await f.engine.query({ query: QUERY, limit: 5, project: 'alpha' });
    assert.deepEqual(small.hits.map((hit) => hit.id), [1, 2]);
    assert.equal(small.truncated, true);
    assert.deepEqual(large.hits.map((hit) => hit.id), [1, 2, 3]);
    assert.equal(large.truncated, false);
  } finally {
    f.cleanup();
  }
});

test('默认只看当前项目；显式跨项目才可见其他项目，且每条标明项目', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.99, project: 'alpha' },
    { id: 2, cos: 0.9, project: 'beta' },
  ]);
  try {
    const scoped = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' });
    assert.deepEqual(scoped.hits.map((hit) => hit.id), [1]);
    assert.equal(scoped.hits[0]!.project, 'alpha');

    const across = await f.engine.query({ query: QUERY, limit: 10, allProjects: true });
    assert.deepEqual(across.hits.map((hit) => hit.id), [1, 2]);
    assert.equal(across.hits[1]!.project, 'beta');
  } finally {
    f.cleanup();
  }
});

test('省略范围时两种范围都可能出现；指定范围时只返回该范围', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.99, scope: 'project' },
    { id: 2, cos: 0.9, scope: 'personal' },
  ]);
  try {
    const both = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' });
    assert.deepEqual(both.hits.map((hit) => hit.id), [1, 2]);
    assert.equal(both.filteredOut, 0, '范围本身不得把任何一种整体排除');

    const only = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha', scope: 'personal' });
    assert.deepEqual(only.hits.map((hit) => hit.id), [2]);
  } finally {
    f.cleanup();
  }
});

test('类型取值不存在时列出实际取值；存在时只返回该类型', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.99, type: 'decision' },
    { id: 2, cos: 0.9, type: 'architecture' },
    { id: 3, cos: 0.8, type: 'preference' },
  ]);
  try {
    const missing = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha', type: 'nonexistent' });
    assert.equal(missing.hits.length, 0);
    assert.deepEqual(missing.availableTypes, ['architecture', 'decision', 'preference']);

    const present = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha', type: 'decision' });
    assert.deepEqual(present.hits.map((hit) => hit.id), [1]);
    assert.deepEqual(present.availableTypes, [], '有匹配项时不需要纠错提示');
  } finally {
    f.cleanup();
  }
});

test('正本内容变化后紧接着的下一次检索可见，且只付增量代价', async () => {
  const f = await engineWith([{ id: 1, cos: 0.9 }]);
  try {
    const dbPath = join(f.dir, 'source.db');
    writeSource(dbPath, [
      { id: 1, title: 't1', content: 'c1' },
      { id: 42, title: '新增', content: '一条刚写入的记忆。', project: 'alpha' },
    ]);
    // 新文档的向量用确定性兜底值即可，这里只关心"是否可见"。
    const payload = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' });
    assert.ok(payload.hits.some((hit) => hit.id === 42));
    assert.equal(payload.metering.mode, 'incremental');
    assert.equal(payload.metering.sourceChanged, true);
    assert.equal(payload.metering.embedDocs, 1, '只嵌入变化的那一条');

    const again = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' });
    assert.equal(again.metering.mode, 'noop');
    assert.equal(again.metering.sourceChanged, false);
  } finally {
    f.cleanup();
  }
});

test('[3.1] 派生索引损坏：限额内当次自恢复；上限不足时以 sync-needed 拒绝，而不是运行时缺失', async () => {
  const f = await engineWith([{ id: 1, cos: 0.9 }]);
  try {
    const indexPath = join(f.dir, 'index.db');
    f.engine.close();
    writeFileSync(indexPath, 'not a database at all');

    // Over the cap: refuse with the work judgement (NOT the runtime-missing
    // path — the two must stay apart).
    await assert.rejects(
      () => f.engine.query({ query: QUERY, limit: 10, project: 'alpha' }, { maxDocs: 0 }),
      (error: { kind?: string; mode?: string }) => {
        assert.equal(error.kind, 'sync-needed');
        assert.equal(error.mode, 'full');
        return true;
      },
    );

    // Within the cap: the same call rebuilds it and answers.
    const payload = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' }, { maxDocs: 10 });
    assert.deepEqual(payload.hits.map((hit) => hit.id), [1]);
  } finally {
    f.cleanup();
  }
});

test('记忆被删除后不再出现在结果里', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.99 },
    { id: 2, cos: 0.9 },
  ]);
  try {
    writeSource(join(f.dir, 'source.db'), [{ id: 1, title: 't1', content: 'c1' }]);
    const payload = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' });
    assert.deepEqual(payload.hits.map((hit) => hit.id), [1]);
  } finally {
    f.cleanup();
  }
});

test('[3.1] dims/向量数不一致（孤立的向量缺失）时按需重建而不是静默算 0', async () => {
  const f = await engineWith([{ id: 1, cos: 0.9 }, { id: 2, cos: 0.8 }]);
  try {
    const indexPath = join(f.dir, 'index.db');
    f.engine.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(indexPath);
    db.exec('DELETE FROM vectors WHERE doc_id=2');
    db.close();
    const payload = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' }, { maxDocs: 10 });
    assert.equal(payload.hits.length, 2);
    assert.equal(payload.metering.mode, 'full', '不一致即全量，且就在这次调用里完成');
  } finally {
    f.cleanup();
  }
});

test('[3.1] 索引文件被删除：限额内当次自恢复（删数据 = Δ 全量）', async () => {
  const f = await engineWith([{ id: 1, cos: 0.9 }]);
  try {
    const indexPath = join(f.dir, 'index.db');
    f.engine.close();
    rmSync(indexPath, { force: true });
    const payload = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' }, { maxDocs: 10 });
    assert.deepEqual(payload.hits.map((hit) => hit.id), [1]);
    assert.equal(payload.metering.mode, 'full');
  } finally {
    f.cleanup();
  }
});

test('[3.2] 同一个判定既覆盖增量也覆盖重建：超限拒绝两次结果一致，且不改变索引', async () => {
  const f = await engineWith([
    { id: 1, cos: 0.9 },
    { id: 2, cos: 0.8 },
  ]);
  try {
    const indexPath = join(f.dir, 'index.db');
    const generation = inspectIndex(indexPath).storedHash;
    writeSource(join(f.dir, 'source.db'), [
      { id: 1, title: 't1', content: 'c1' },
      { id: 2, title: 't2', content: 'c2' },
      { id: 3, title: 't3', content: 'c3' },
      { id: 4, title: 't4', content: 'c4' },
    ]);
    for (const attempt of [1, 2]) {
      await assert.rejects(
        () => f.engine.query({ query: QUERY, limit: 10, project: 'alpha' }, { maxDocs: 1 }),
        (error: { kind?: string; mode?: string; pendingDocs?: number }) => {
          assert.equal(error.kind, 'sync-needed', `第 ${attempt} 次拒绝`);
          assert.equal(error.mode, 'incremental');
          assert.equal(error.pendingDocs, 2, '两条变化（新增 2 条）');
          return true;
        },
      );
      assert.equal(inspectIndex(indexPath).storedHash, generation, '重复拒绝不得改动派生数据');
    }
  } finally {
    f.cleanup();
  }
});

test('索引里没有任何记忆时返回空结果而不是报错', async () => {
  const f = await engineWith([]);
  try {
    const payload = await f.engine.query({ query: QUERY, limit: 10, project: 'alpha' });
    assert.equal(payload.hits.length, 0);
    assert.equal(payload.truncated, false);
    assert.equal(payload.metering.docCount, 0);
    assert.ok(readFileSync(join(f.dir, 'index.db')).byteLength > 0);
  } finally {
    f.cleanup();
  }
});
