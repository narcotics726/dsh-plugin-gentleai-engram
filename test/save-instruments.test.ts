import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaveInstruments } from '../dist/instruments.js';
import type { CandidateMetering } from '../dist/recall/protocol.js';
import { buildIndex, callTool, rig, startSession, writeStub } from './save-support.ts';

/**
 * The write layer's instruments (design D9).
 *
 * They exist to answer four questions that only become answerable once the
 * feature runs, and they answer them by writing log lines — they never change a
 * ranking, never gate a tool, and never persist anything. Both halves are pinned
 * here: the counters in memory, and the lines that reach the operator.
 */

function metering(overrides: Partial<CandidateMetering> = {}): CandidateMetering {
  return {
    sourceChanged: false,
    lagDocs: 0,
    docCount: 563,
    candidates: 12,
    poolSize: 30,
    filteredOut: 0,
    hashMs: 1,
    embedMs: 2,
    scoreMs: 3,
    totalMs: 37,
    ...overrides,
  };
}

test('落后：与读层同一个整表内容哈希判定，四个字段都在一行里', () => {
  const instruments = new SaveInstruments();
  const line = instruments.candidateLine({
    sessionId: 's1',
    poolIds: [410, 12, 12],
    shownIds: [410],
    metering: metering({ sourceChanged: true, lagDocs: 5 }),
  });
  assert.match(line, /落后=true/);
  assert.match(line, /落后规模=5/);
  assert.match(line, /索引条数=563/);
  assert.match(line, /耗时=37ms/);
  // Pool composition: the first document and how many distinct documents.
  assert.match(line, /池首位=#410/);
  assert.match(line, /池内文档数=2/);
  assert.match(line, /展示=1/);
  assert.match(line, /一致=0\/2/, '池内不同文档数才是分母');
});

test('空池与降级：池为空时明说，降级时带上原因', () => {
  const instruments = new SaveInstruments();
  const empty = instruments.candidateLine({
    sessionId: 's1',
    poolIds: [],
    shownIds: [],
    metering: metering({ candidates: 0, poolSize: 0 }),
  });
  assert.match(empty, /池首位=\(空\)/);
  assert.match(empty, /池内文档数=0/);
  const degraded = instruments.candidateLine({
    sessionId: 's1',
    poolIds: [],
    shownIds: [],
    metering: metering(),
    degraded: 'timeout',
  });
  assert.match(degraded, /降级=timeout/);
});

test('一致性率：本会话看过的条目 vs 候选池，按次记录、不落盘', () => {
  const instruments = new SaveInstruments();
  instruments.noteSeen('s1', [1, 2]);
  assert.deepEqual(instruments.consistency('s1', [1, 5]), { hits: 1, pool: 2 });
  assert.deepEqual(instruments.consistency('s1', [7, 8]), { hits: 0, pool: 2 });
  assert.deepEqual(instruments.consistency('other-session', [1]), { hits: 0, pool: 1 }, '按会话隔离');
  // Nothing is persisted: a fresh instance is a restart.
  assert.deepEqual(new SaveInstruments().snapshot('s1'), {
    seen: [],
    verdicts: {},
    readFirst: 0,
    blind: 0,
    unknown: 0,
  });
});

test('判词分布与「下判前有没有读过全文」', () => {
  const instruments = new SaveInstruments();
  // #1 is the row this session just saved (already in front of the model); #2 is
  // the candidate, and it was fetched in full.
  instruments.noteSaved('s1', 1);
  instruments.noteObservationRead('s1', 2);
  const read = instruments.noteVerdict('s1', 'supersedes', [1, 2]);
  assert.equal(read.readFirst, true);
  const blind = instruments.noteVerdict('s1', 'related', [3, 4]);
  assert.equal(blind.readFirst, false);
  assert.deepEqual(blind.distribution, { related: 1, supersedes: 1 });
  // `not_conflict` writes no row, yet it is the most common verdict: counted too.
  instruments.noteVerdict('s1', 'not_conflict', [1, 2]);
  assert.deepEqual(instruments.snapshot('s1').verdicts, {
    not_conflict: 1,
    related: 1,
    supersedes: 1,
  });
  // A call that does not carry the pair (the retraction path takes a relation id)
  // is counted without inventing a read-first answer.
  instruments.noteVerdict('s1', 'not_conflict', undefined);
  const snapshot = instruments.snapshot('s1');
  assert.equal(snapshot.unknown, 1);
  assert.equal(snapshot.readFirst, 2, 'supersedes 与 not_conflict 两次都算读过（#1 是本次保存写的、#2 拉过全文）');
  assert.equal(snapshot.blind, 1);
  const line = instruments.verdictLine('s1', {
    verb: 'related',
    readFirst: false,
    distribution: { related: 1 },
  });
  assert.match(line, /关系=related/);
  assert.match(line, /下判前读过候选全文=false/);
  assert.match(line, /判词分布 related=1/);
  assert.match(line, /未定=1/);
});

test('实测：一次带候选的保存在日志里留下候选计量那一行', async () => {
  const stub = await writeStub(201, '{"id":1,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    await buildIndex(r.host);
    await callTool(
      r.host,
      'mcp__engram__mem_bridge_save',
      { title: '写层规划：候选在写入之前算好', content: '与库里那条近似的中文内容。', type: 'architecture' },
      { sessionId: 'stub-save' },
    );
    const line = r.host.logs.info.find((message) => message.includes('保存候选计量'));
    assert.ok(line !== undefined, `日志里必须有候选计量行：${r.host.logs.info.join(' | ')}`);
    for (const field of ['落后=', '落后规模=', '索引条数=', '池首位=', '池内文档数=', '耗时=']) {
      assert.ok(line.includes(field), `候选计量行缺 ${field}：${line}`);
    }
    // 一致性率：检索命中过 #1，候选池里也有 #1。
    assert.match(line, /一致=[1-9]\d*\//, `刚被检索过的那条应当记进一致性率：${line}`);
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('实测：下判前的全文读取与判词分布都落到日志里', async () => {
  const stub = await writeStub(201, '{"id":1,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    // Pull both ends' full text before judging (1, 2): that counts as "read first".
    await callTool(r.host, 'mcp__engram__mem_get_observation', { id: 1 }, { sessionId: 'stub-save' });
    await callTool(r.host, 'mcp__engram__mem_get_observation', { id: 2 }, { sessionId: 'stub-save' });
    await callTool(
      r.host,
      'mcp__engram__mem_compare',
      { memory_id_a: 1, memory_id_b: 2, relation: 'supersedes', confidence: 1, reasoning: 'x' },
      { sessionId: 'stub-save' },
    );
    // Now judge a pair nobody read.
    await callTool(
      r.host,
      'mcp__engram__mem_compare',
      { memory_id_a: 3, memory_id_b: 4, relation: 'related', confidence: 0.9, reasoning: 'y' },
      { sessionId: 'stub-save' },
    );
    const lines = r.host.logs.info.filter((message) => message.includes('下判：'));
    assert.equal(lines.length, 2, `每次下判一行：${r.host.logs.info.join(' | ')}`);
    assert.match(lines[0]!, /关系=supersedes 下判前读过候选全文=true/);
    assert.match(lines[1]!, /关系=related 下判前读过候选全文=false/);
    assert.match(lines[1]!, /判词分布 related=1 supersedes=1/);
  } finally {
    await r.cleanup();
    await stub.close();
  }
});
