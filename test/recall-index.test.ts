import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ALGO_VERSION, EMBED_SLICE_DOCS, IDENTITY_META_KEY, IndexDb, SCORING, SOURCE_HASH_FORMULA, contentSha, inspectIndex, readSourceState } from '../dist/recall/index-db.js';
import { MAX_BATCH } from '../dist/recall/embed.js';
import { EXPECTED_IDENTITY, expectedIdentityDigest } from '../dist/recall/model-expected.js';
import { Scorer } from '../dist/recall/scoring.js';
import { dot, expectedSourceHash, fakeEmbedder, removeDir, tempDir, writeSource, type SourceRow } from './recall-support.ts';

/**
 * Index-level tests: the snapshot, the delta, the transaction, and the single
 * source for the scoring constants.
 *
 * The four properties under test were verified in the out-of-repo prototype and
 * are re-asserted here against THIS implementation, not re-derived:
 * V1 one consistent snapshot, V2 delta == full rebuild, V3 a brand-new row is
 * retrievable, V4 the transaction is the atomicity unit.
 */

const DIM = 8;

function table(path: string, sql: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown[];
  } finally {
    db.close();
  }
}

function snapshot(path: string): Record<string, unknown[]> {
  return {
    docs: table(path, 'SELECT * FROM docs ORDER BY doc_id'),
    terms: table(path, 'SELECT * FROM terms ORDER BY token, kind'),
    postings: table(path, 'SELECT * FROM postings ORDER BY token, kind, doc_id'),
    vectors: table(path, 'SELECT doc_id, model, dim, hex(vec) AS v FROM vectors ORDER BY doc_id'),
    meta: table(path, "SELECT key, value FROM meta WHERE key <> 'update_prefix' ORDER BY key"),
  };
}

function indexOf(dir: string): string {
  return join(dir, 'index.db');
}

const CORPUS: SourceRow[] = [
  {
    id: 1,
    title: '读层打分',
    content: '检索得分由归一化余弦与字段覆盖率加权得到。',
    type: 'decision',
    project: 'alpha',
  },
  { id: 2, title: '连接池回收', content: '空闲连接由定时器回收。', type: 'architecture', project: 'alpha' },
  { id: 3, title: 'personal', content: '用户偏好把推理链留在明面上。', type: 'preference', project: 'alpha', scope: 'personal' },
  { id: 4, title: 'other', content: 'Another project note about indexing.', type: 'discovery', project: 'beta' },
  { id: 5, title: 'gone', content: '这条已删除。', type: 'manual', project: 'alpha', deleted: true },
];

test('readSourceState: 只读活跃行，哈希与独立计算一致', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    writeSource(dbPath, CORPUS);
    const state = readSourceState(dbPath);
    assert.deepEqual(
      state.docs.map((doc) => doc.id),
      [1, 2, 3, 4],
      '软删除的行必须被排除',
    );
    assert.equal(state.hash, expectedSourceHash(CORPUS));
    assert.equal(state.docs[2]!.scope, 'personal');
    assert.ok(SOURCE_HASH_FORMULA.includes('updated_at'), '公式常量应描述哈希输入');
  } finally {
    removeDir(dir);
  }
});

test('readSourceState: 行与哈希是同一快照（无事务读会撕裂）', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    writeSource(dbPath, CORPUS);
    const hashOf = (docs: Array<{ id: number; content: string; updatedAt: string }>): string =>
      expectedSourceHash(
        docs.map((doc) => ({ id: doc.id, title: '', content: doc.content, updatedAt: doc.updatedAt })),
      );

    // 阳性对照：两次独立读之间插入一次提交，哈希与第二次读一致而与第一次不一致。
    // 这正是无事务读会发生的撕裂，它证明下面那条断言有区分力。
    const naive = new DatabaseSync(dbPath);
    const first = naive.prepare('SELECT id, content, updated_at AS u FROM observations WHERE deleted_at IS NULL ORDER BY id').all() as Array<{ id: number; content: string; u: string }>;
    const firstHash = expectedSourceHash(first.map((row) => ({ id: row.id, title: '', content: row.content, updatedAt: row.u })));
    const writer = new DatabaseSync(dbPath);
    writer.prepare("UPDATE observations SET content=?, updated_at='2026-09-01' WHERE id=1").run('撕裂对照：改写后的内容。');
    writer.close();
    const second = naive.prepare('SELECT id, content, updated_at AS u FROM observations WHERE deleted_at IS NULL ORDER BY id').all() as Array<{ id: number; content: string; u: string }>;
    const secondHash = expectedSourceHash(second.map((row) => ({ id: row.id, title: '', content: row.content, updatedAt: row.u })));
    naive.close();
    assert.notEqual(firstHash, secondHash, '阳性对照：无事务的两次读之间必须能看到提交');

    // 实际实现：返回的行与返回的哈希必须自洽（有事务时提交不会落在两次读之间）。
    const state = readSourceState(dbPath);
    assert.equal(
      hashOf(state.docs),
      state.hash,
      '返回的行与返回的哈希必须来自同一次快照',
    );

    // 并发写入下重复读，仍然自洽。
    const child = spawn(
      process.execPath,
      ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(dbPath)});let i=0;const s=db.prepare("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)");const t=setInterval(()=>{s.run(1000+i,'c','并发写入 '+i,'manual','alpha','project','x','2026-09-02',null);i++;},1);setTimeout(()=>{clearInterval(t);db.close();process.exit(0)},900);`],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 30; i++) {
      const concurrent = readSourceState(dbPath);
      assert.equal(hashOf(concurrent.docs), concurrent.hash, `并发第 ${i} 次读仍必须自洽`);
    }
    child.kill('SIGKILL');
  } finally {
    removeDir(dir);
  }
});

test('增量同步与全量重建逐行相等（含新增列与向量）', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const embed = fakeEmbedder({ dim: DIM });

    // 全量：从基线直接建
    writeSource(dbPath, CORPUS);
    const fullPath = indexOf(join(dir, 'full'));
    const full = IndexDb.recreate(fullPath);
    await full.sync(readSourceState(dbPath), embed, { full: true });
    full.close();

    // 增量：先建一份"少两行、其中一行内容不同"的旧索引，再同步到基线
    const incrPath = indexOf(join(dir, 'incr'));
    const older: SourceRow[] = [
      { ...CORPUS[0]!, content: '旧内容：检索得分。' },
      CORPUS[1]!,
    ];
    writeSource(dbPath, older);
    const incr = IndexDb.recreate(incrPath);
    await incr.sync(readSourceState(dbPath), embed, { full: true });
    incr.close();

    writeSource(dbPath, CORPUS);
    const reopened = IndexDb.open(incrPath);
    const metering = await reopened.sync(readSourceState(dbPath), embed);
    reopened.close();
    assert.equal(metering.mode, 'incremental');
    assert.equal(metering.docsTouched, 3, '一条改写 + 两条新增');
    assert.ok(metering.embedDocs >= 1);

    assert.deepEqual(snapshot(incrPath), snapshot(fullPath));
  } finally {
    removeDir(dir);
  }
});

test('新增 / 修改 / 删除都在下一次查询可见，且只付增量代价', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    writeSource(dbPath, CORPUS.slice(0, 3));
    const index = IndexDb.recreate(indexPath);
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { full: true });

    writeSource(dbPath, [...CORPUS.slice(0, 3), { id: 9, title: '新增', content: '刚写入的一条记忆。', project: 'alpha' }]);
    const added = await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }));
    assert.equal(added.mode, 'incremental');
    assert.equal(added.embedDocs, 1, '只有新增的那条需要重新嵌入');
    assert.ok(index.docIds().includes(9));

    writeSource(dbPath, [
      { ...CORPUS[0]!, content: '改写后的内容。' },
      CORPUS[1]!,
      CORPUS[2]!,
      { id: 9, title: '新增', content: '刚写入的一条记忆。', project: 'alpha' },
    ]);
    const edited = await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }));
    assert.equal(edited.mode, 'incremental');
    assert.equal(edited.docsTouched, 1);

    // 保持第 1 条为"改写后"的内容：这一步只想验证删除，别让另一次改写混进来。
    writeSource(dbPath, [{ ...CORPUS[0]!, content: '改写后的内容。' }, CORPUS[1]!, CORPUS[2]!]);
    const removed = await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }));
    assert.equal(removed.mode, 'incremental');
    assert.equal(removed.docsTouched, 1);
    assert.ok(!index.docIds().includes(9));
    assert.equal(
      table(indexPath, 'SELECT count(*) AS c FROM vectors')[0]!['c'],
      3,
      '删除的文档不能留下孤儿向量',
    );

    const noop = await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }));
    assert.equal(noop.mode, 'noop');
    assert.equal(noop.sourceChanged, false);
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('批内嵌入抛错时索引逐行不变，且下一次更新能完成', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    writeSource(dbPath, CORPUS.slice(0, 3));
    const index = IndexDb.recreate(indexPath);
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { full: true });
    const before = snapshot(indexPath);

    const changed: SourceRow[] = [
      { ...CORPUS[0]!, content: '改写一。' },
      { ...CORPUS[1]!, content: '改写二。' },
      CORPUS[2]!,
    ];
    writeSource(dbPath, changed);
    await assert.rejects(
      () => index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM, failOnTextIndex: 1 })),
      /synthetic embed failure/,
    );
    assert.deepEqual(snapshot(indexPath), before, '失败的更新不得留下任何痕迹');
    assert.equal(index.updatePrefixPresent(), false, '不得留下残留标记');
    assert.ok(index.integrityOk());

    const retry = await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }));
    assert.equal(retry.mode, 'incremental');
    assert.equal(retry.docsTouched, 2);
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('进程在更新中途被 SIGKILL：索引仍可用、无残留标记、下一次同步能完成', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    writeSource(dbPath, CORPUS.slice(0, 3));
    const index = IndexDb.recreate(indexPath);
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { full: true });
    index.close();
    const before = snapshot(indexPath);

    // 子进程复刻一次真实更新的中间状态：开启写事务、写下进度标记、清空表，
    // 然后在提交之前被 SIGKILL。这与 sync() 事务内部被杀死处在同一位置。
    const flag = join(dir, 'ready');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const {DatabaseSync}=require('node:sqlite');const fs=require('fs');` +
          `const db=new DatabaseSync(${JSON.stringify(indexPath)});` +
          `db.exec('BEGIN IMMEDIATE');` +
          `db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('update_prefix','crash');` +
          `db.exec('DELETE FROM postings');db.exec('DELETE FROM docs');db.exec('DELETE FROM vectors');` +
          `fs.writeFileSync(${JSON.stringify(flag)},'ready');` +
          `setTimeout(()=>{},60000);`,
      ],
      { stdio: 'ignore' },
    );
    const deadline = Date.now() + 10000;
    while (!existsSync(flag) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(flag), '子进程应已进入事务中间状态');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    const reopened = IndexDb.open(indexPath);
    assert.ok(reopened.integrityOk(), 'integrity_check 必须为 ok');
    assert.equal(reopened.updatePrefixPresent(), false, '被回滚的事务不应留下标记');
    assert.deepEqual(snapshot(indexPath), before, '未提交的更新必须整体回滚');

    writeSource(dbPath, [...CORPUS.slice(0, 3), { id: 7, title: '崩溃后新增', content: '崩溃之后写入的一条。', project: 'alpha' }]);
    const metering = await reopened.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }));
    assert.equal(metering.mode, 'incremental');
    assert.ok(reopened.docIds().includes(7));
    reopened.close();
  } finally {
    removeDir(dir);
  }
});

test('inspectIndex 判定缺失 / 无 meta / 算法版本不符 / 模型身份不符', () => {
  const dir = tempDir();
  try {
    const indexPath = indexOf(dir);
    assert.equal(inspectIndex(indexPath).needsFullBuild, true);
    assert.equal(inspectIndex(indexPath).reason, 'missing');

    const index = IndexDb.recreate(indexPath);
    assert.equal(inspectIndex(indexPath).needsFullBuild, true, '尚未建成的索引（source_hash 为空）需要全量重建');
    index.handle.exec("INSERT OR REPLACE INTO meta VALUES ('source_hash','abc')");
    // 更早版本建的索引没有模型身份键：无从判断它属于哪一份模型，按需要重建对待。
    assert.equal(inspectIndex(indexPath).needsFullBuild, true);
    assert.equal(inspectIndex(indexPath).reason, 'no-meta');
    index.handle.exec(`INSERT OR REPLACE INTO meta VALUES ('${IDENTITY_META_KEY}','另一代')`);
    assert.equal(inspectIndex(indexPath).needsFullBuild, true);
    assert.equal(inspectIndex(indexPath).reason, 'model-mismatch');
    index.handle.exec(`INSERT OR REPLACE INTO meta VALUES ('${IDENTITY_META_KEY}','${expectedIdentityDigest()}')`);
    assert.equal(inspectIndex(indexPath).needsFullBuild, false);
    assert.equal(inspectIndex(indexPath).algoVersion, ALGO_VERSION);
    index.handle.exec("UPDATE meta SET value='bigram-live-v1' WHERE key='algo_version'");
    assert.equal(inspectIndex(indexPath).reason, 'algo-mismatch');
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('[7.1] 只在模型权重上换代也判需要重建', () => {
  const dir = tempDir();
  try {
    const indexPath = indexOf(dir);
    const real = expectedIdentityDigest();
    // 唯一差别是模型权重：换个运行时文件或换排序方式也会让摘要变，但那是别的
    // 性质；这里要钉死的是「摘要确实覆盖权重」。
    const swappedWeights = expectedIdentityDigest({
      ...EXPECTED_IDENTITY,
      files: EXPECTED_IDENTITY.files.map((file, index) =>
        index === 0 ? { ...file, sha256: '0'.repeat(64) } : file,
      ),
    });
    assert.notEqual(swappedWeights, real, '只换模型权重也必须换摘要');

    const index = IndexDb.recreate(indexPath);
    index.handle.exec("INSERT OR REPLACE INTO meta VALUES ('source_hash','abc')");
    index.handle.exec(`INSERT OR REPLACE INTO meta VALUES ('${IDENTITY_META_KEY}','${real}')`);

    assert.equal(inspectIndex(indexPath, real).needsFullBuild, false, '同一代 → 不需要重建');
    const swapped = inspectIndex(indexPath, swappedWeights);
    assert.equal(swapped.needsFullBuild, true, '换代 → 需要重建，而不是拿旧向量作答');
    assert.equal(swapped.reason, 'model-mismatch');
    assert.equal(swapped.storedIdentity, real, '要把盘上那一代报出来');
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('打分器从索引 meta 读取四个常量（改哪一个排序都变）', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    // 词项出现在标题里、文档长度差异大、词频不同 —— 四个常量各自都要有作用面。
    const rows: SourceRow[] = [
      { id: 1, title: '原子性 索引', content: '原子性 原子性 原子性 索引 增量 更新 事务 提交 回滚 一致 派生 数据', type: 'design', project: 'alpha' },
      { id: 2, title: '别的', content: '原子性 索引 一句话。', type: 'design', project: 'alpha' },
      { id: 3, title: '第三个', content: '原子性 索引 较长的正文 用于拉长文档长度 让长度归一化真正起作用 再多一些字 继续拉长', type: 'design', project: 'alpha' },
    ];
    writeSource(dbPath, rows);
    const index = IndexDb.recreate(indexPath);
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { full: true });
    const state = readSourceState(dbPath);
    const query = '原子性 索引';
    const queryVec = new Float32Array(DIM);
    queryVec[0] = 1;

    const baseline = new Scorer(index, DIM).lexicalOrder(query);
    assert.ok(baseline.ordering.length >= 2, 'fixture 需要多个候选');

    const originals = new Map<string, string>();
    for (const key of ['scoring_k1', 'scoring_b', 'scoring_title_weight', 'scoring_evidence_weight']) {
      originals.set(key, String((index.handle.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string }).value));
    }
    for (const [key, value] of [
      ['scoring_k1', 2.5],
      ['scoring_b', 0.9],
      ['scoring_title_weight', 9.0],
      ['scoring_evidence_weight', 0.9],
    ] as const) {
      index.handle.prepare('UPDATE meta SET value=? WHERE key=?').run(String(value), key);
      const changed = new Scorer(index, DIM).lexicalOrder(query);
      assert.notDeepEqual(
        changed.ordering,
        baseline.ordering,
        `改 ${key} 之后词法排序必须变化（否则打分器没有读它）`,
      );
      index.handle.prepare('UPDATE meta SET value=? WHERE key=?').run(originals.get(key)!, key);
    }
    // 逐个恢复后回到基线，说明差异确实来自 meta，而不是缓存或顺序漂移。
    assert.deepEqual(new Scorer(index, DIM).lexicalOrder(query).ordering, baseline.ordering);
    assert.deepEqual(SCORING, { k1: 1.2, b: 0.2, titleWeight: 3.0, evidenceWeight: 0.25 });
    void state;
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('回归：四个打分常量只在建索引处声明一次，打分器里没有兜底字面量', () => {
  const scoringPath = join(process.cwd(), 'src', 'recall', 'scoring.ts');
  const scorerSource = readFileSync(scoringPath, 'utf8');
  const start = scorerSource.indexOf('export function scoringParamsFromMeta');
  assert.ok(start > 0, '打分器必须从 meta 读常量');
  // 只取这个函数本身：从起点到第一个顶格的右花括号。
  const end = scorerSource.indexOf('\n}', start);
  assert.ok(end > start, '找不到 scoringParamsFromMeta 的结尾');
  const body = scorerSource.slice(start, end);
  // 去掉字符串与标识符之后剩下的数字只可能是数值字面量（`k1` 这类键名会先变成占位符）。
  const stripped = body
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, 'ID');
  assert.ok(
    !/[0-9]/.test(stripped),
    '读常量的函数里不得出现任何数值字面量（兜底默认值就是第二处声明）',
  );

  // titleWeight / evidenceWeight 的数值只能声明一次，且只能在建索引那一侧。
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(join(process.cwd(), 'src'));
  const declaring = files
    .filter((file) => /\b(titleWeight|evidenceWeight)\s*:\s*[0-9]/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(process.cwd().length + 1));
  assert.deepEqual(declaring, ['src/recall/index-db.ts'], '打分常量的数值只能在建索引处声明');
});

test('超过 maxDocs 时：不嵌入、不写入、不留标记，返回 deferred 与待处理条数', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    writeSource(dbPath, [{ id: 1, title: 'a', content: 'only one.', project: 'alpha' }]);
    const index = IndexDb.recreate(indexPath);
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { full: true });
    const before = snapshot(indexPath);

    const many: SourceRow[] = [
      { id: 1, title: 'a', content: 'only one.', project: 'alpha' },
      { id: 100, title: 't0', content: 'c0', project: 'alpha' },
      { id: 101, title: 't1', content: 'c1', project: 'alpha' },
      { id: 102, title: 't2', content: 'c2', project: 'alpha' },
      { id: 103, title: 't3', content: 'c3', project: 'alpha' },
    ];
    writeSource(dbPath, many);

    let embedCalls = 0;
    const metering = await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM, onEmbed: () => embedCalls++ }), {
      maxDocs: 3,
    });
    assert.equal(metering.mode, 'deferred');
    assert.equal(metering.pendingDocs, 4, '待处理条数 = 本次要动的条数（4 条新增）');
    assert.equal(metering.embedDocs, 0);
    assert.equal(embedCalls, 0, '超限时一次嵌入都不做');
    assert.deepEqual(snapshot(indexPath), before, '超限时索引逐行不变');
    assert.equal(index.updatePrefixPresent(), false, '不得留下进行中标记');

    // In-cap work still goes through, so the deferral is about the cap only.
    const done = await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { maxDocs: 4 });
    assert.equal(done.mode, 'incremental');
    assert.equal(done.embedDocs, 4);
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('maxDocs 对 full 与增量是同一个判定（full 也要能 defer 且不破坏索引）', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    writeSource(dbPath, CORPUS.slice(0, 3));
    const index = IndexDb.recreate(indexPath);
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { full: true });
    const stored = index.storedHash();
    const before = snapshot(indexPath);

    const deferred = await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), {
      full: true,
      maxDocs: 2,
    });
    assert.equal(deferred.mode, 'deferred');
    assert.equal(deferred.pendingDocs, 3);
    assert.equal(index.storedHash(), stored, 'defer 不得把 source_hash 清空或改写');
    assert.deepEqual(snapshot(indexPath), before);
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('写事务内的复核：锁被接管或期间有人提交过，整次写入回滚且报 busy', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    writeSource(dbPath, CORPUS.slice(0, 3));
    const index = IndexDb.recreate(indexPath);
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { full: true });
    const before = snapshot(indexPath);

    writeSource(dbPath, [
      { ...CORPUS[0]!, content: '改写后的内容。' },
      CORPUS[1]!,
      CORPUS[2]!,
    ]);

    // (a) the lock was taken away: assertStillHeld throws inside the transaction
    await assert.rejects(
      () =>
        index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), {
          assertStillHeld: () => {
            throw Object.assign(new Error('busy'), { kind: 'busy' });
          },
        }),
      (error: { kind?: string }) => error.kind === 'busy',
    );
    assert.deepEqual(snapshot(indexPath), before, '被接管后整次写入必须回滚');

    // (b) somebody else committed during the embedding gap: the stored hash no
    // longer matches what we read under the lock, so applying our diff would
    // move the index backwards.
    await assert.rejects(
      () =>
        index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), {
          expectedStoredHash: 'a-different-hash',
        }),
      (error: { kind?: string }) => error.kind === 'busy',
    );
    assert.deepEqual(snapshot(indexPath), before, '快照过期后整次写入必须回滚');
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('嵌入按批切片：批大小不超过嵌入器的硬上限，且批间给出进度回调', async () => {
  assert.ok(
    EMBED_SLICE_DOCS <= MAX_BATCH,
    `切片 ${EMBED_SLICE_DOCS} 必须 ≤ 嵌入器硬上限 ${MAX_BATCH}，否则心跳之间会出现超长无进展段`,
  );
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    const rows: SourceRow[] = Array.from({ length: EMBED_SLICE_DOCS * 2 + 1 }, (_, i) => ({
      id: i + 1,
      title: `t${i}`,
      content: `c${i}`,
      project: 'alpha',
    }));
    writeSource(dbPath, rows);
    const index = IndexDb.recreate(indexPath);
    const batches: number[] = [];
    let progress = 0;
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM, onEmbed: (texts) => batches.push(texts.length) }), {
      full: true,
      onProgress: () => progress++,
    });
    assert.deepEqual(batches, [EMBED_SLICE_DOCS, EMBED_SLICE_DOCS, 1], '按切片调用嵌入器');
    assert.equal(progress, batches.length + 1, '每片之后一次心跳，进入写事务之前再来一次');
    index.close();
  } finally {
    removeDir(dir);
  }
});

test('写入侧的 SQLite 等待是按路径给的（常驻要快速失败，不能吃满自己的预算）', () => {
  const dir = tempDir();
  try {
    const indexPath = indexOf(dir);
    const fast = IndexDb.open(indexPath, { busyTimeoutMs: 3000 });
    const row = fast.handle.prepare('PRAGMA busy_timeout').get() as { timeout?: number };
    assert.equal(Number(row.timeout), 3000);
    fast.close();
    const slow = IndexDb.open(indexPath, { busyTimeoutMs: 60000 });
    assert.equal(
      Number((slow.handle.prepare('PRAGMA busy_timeout').get() as { timeout?: number }).timeout),
      60000,
    );
    slow.close();
  } finally {
    removeDir(dir);
  }
});

test('contentSha 覆盖标题与正文', () => {
  assert.notEqual(contentSha('a', 'b'), contentSha('ab', ''));
  assert.notEqual(contentSha('a', 'b'), contentSha('a', 'b '));
});

test('全量重建让向量与文档数一致，且余弦为正（抽查）', async () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const indexPath = indexOf(dir);
    writeSource(dbPath, CORPUS.slice(0, 2));
    const index = IndexDb.recreate(indexPath);
    await index.sync(readSourceState(dbPath), fakeEmbedder({ dim: DIM }), { full: true });
    assert.equal(
      table(indexPath, 'SELECT count(*) AS c FROM vectors')[0]!['c'],
      table(indexPath, 'SELECT count(*) AS c FROM docs')[0]!['c'],
    );
    const vec = index.vector(1);
    assert.ok(vec !== undefined);
    assert.ok(dot(Array.from(vec!), Array.from(vec!)) > 0.99);
    index.close();
  } finally {
    removeDir(dir);
  }
});

