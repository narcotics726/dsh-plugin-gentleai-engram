import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildIndex,
  callTool,
  closedPort,
  DEFAULT_ROWS,
  indexSourceHash,
  readCalls,
  rendered,
  rig,
  startSession,
  writeStub,
} from './save-support.ts';
import { writeSource } from './recall-support.ts';

/**
 * The save entry point, end to end through the real plugin: the model-visible
 * tool surface, the HTTP write channel, the fallback, identity through the
 * existing injection, and the candidate contract (pre-write, same project,
 * never persisted, never gating the write).
 */

const SAVE = 'mcp__engram__mem_bridge_save';

test('配置非法在加载时抛错：展示条数不得大于覆盖加成的池', async () => {
  await assert.rejects(
    () => rig({ searchTopK: 1, saveCandidateLimit: 5 }),
    /searchTopK\(1\) 小于 saveCandidateLimit\(5\)/,
  );
  await assert.rejects(
    () => rig({ writeBaseUrl: 'not a url' }),
    /writeBaseUrl 不是合法的 URL/,
  );
});

test('工具面：新的保存入口在、上游写入工具不在，前缀计数仍是 21', async () => {
  const stub = await writeStub();
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    const names = [...r.host.registrations.keys()];
    assert.ok(names.includes(SAVE));
    assert.ok(!names.includes('mcp__engram__mem_save'), '被取代的上游写入工具不得注册');
    assert.ok(!names.includes('mcp__engram__mem_search'));
    assert.ok(!names.includes('mcp__engram__mem_capture_passive'));
    assert.ok(!names.includes('mcp__engram__mem_save_prompt'));
    assert.equal(
      names.filter((name) => name.startsWith('mcp__engram__')).length,
      21,
      `声明 22、刻意不注册 4、插件自有 3 ⇒ 21，实际：${names.join(',')}`,
    );
    const definition = r.host.registrations.get(SAVE)!;
    const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok(Object.hasOwn(properties, 'session_id'));
    assert.ok(Object.hasOwn(properties, 'project'));
    assert.ok(!Object.hasOwn(properties, 'capture_prompt'));
    assert.equal(definition.timeoutMs, 2000 + 3000 + 5000 + 5000);
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('保存：写入面可用时落库、带上来源标记、候选随结果交付且方向无歧义', async () => {
  const stub = await writeStub(201, '{"id":777,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    await buildIndex(r.host);
    const value = await callTool(
      r.host,
      SAVE,
      {
        title: '写层规划：候选在写入之前算好',
        content: '桥自己的保存入口在写入之前用读层的派生索引算候选，并限定在同一项目内。',
        type: 'architecture',
      },
      { sessionId: 'stub-save' },
    );
    const text = rendered(r.host.registrations.get(SAVE)!, value);
    const result = value as { id?: number; candidates: Array<{ id: number }> };
    assert.equal(result.id, 777, '结果里必须有本次落库的标识');
    assert.ok(
      result.candidates.some((candidate) => candidate.id === 1),
      `同项目里那条近似条目必须成为候选：${JSON.stringify(result.candidates)}`,
    );
    assert.match(text, /已保存 #777（本次保存的标识）/);
    assert.match(text, /候选 #1/);
    assert.match(text, /共享稀有词/, '证据必须在场');
    assert.match(text, /不会重发/, '有候选时动作提醒必须在场');

    // The write itself: the mark is on the request, and the two paths would have
    // sent identical content (see test/save-layer.test.ts for the unit half).
    assert.equal(stub.received.length, 1);
    assert.equal(stub.received[0]!.tool_name, 'dsh-engram-bridge');
    assert.equal(stub.received[0]!.project, 'stub-project');
    assert.equal(stub.received[0]!.session_id, 'stub-save');
    assert.equal(stub.received[0]!.type, 'architecture');
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('候选限定在同一项目：另一个项目的相似条目不出现在结果里', async () => {
  const stub = await writeStub(201, '{"id":800,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    await buildIndex(r.host);
    const value = (await callTool(
      r.host,
      SAVE,
      { title: '写层规划：候选在写入之前算好', content: '另一项目的相似条目也在库里。', type: 'architecture' },
      { sessionId: 'stub-save' },
    )) as { candidates: Array<{ id: number }> };
    assert.ok(value.candidates.length > 0, '本项目那条必须出现');
    assert.ok(
      value.candidates.every((candidate) => candidate.id !== 2),
      '跨项目的对在本后端写不成关系，不得作为候选',
    );
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('候选不落库、不跨回合：两次保存各按当时内容重算，派生数据与正本都没被候选改动', async () => {
  const stub = await writeStub(201, '{"id":900,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    await buildIndex(r.host);
    const before = indexSourceHash(r.indexDir);
    const first = (await callTool(
      r.host,
      SAVE,
      { title: '写层规划：候选在写入之前算好', content: '第一段内容，与库里那条近似。', type: 'architecture' },
      { sessionId: 'stub-save' },
    )) as { candidates: Array<{ id: number; shared_rare_terms: { terms: string[] } }> };
    const firstEvidence = first.candidates.find((candidate) => candidate.id === 1);
    assert.ok(firstEvidence !== undefined, '本项目那条必须成为候选');

    // The second save is answered from ITS OWN text: the evidence for the same
    // candidate is recomputed, so it cannot be a remembered copy of the first.
    const second = (await callTool(
      r.host,
      SAVE,
      { title: '完全无关的标题 zzzz', content: '完全无关的内容 qqqq，与库里任何一条都不近似。', type: 'discovery' },
      { sessionId: 'stub-save' },
    )) as { candidates: Array<{ id: number; shared_rare_terms: { terms: string[] } }> };
    const secondEvidence = second.candidates.find((candidate) => candidate.id === 1);
    assert.ok(secondEvidence !== undefined, '本项目只有这一条，仍会出现');
    assert.notDeepEqual(
      secondEvidence.shared_rare_terms.terms,
      firstEvidence.shared_rare_terms.terms,
      '证据必须按当时的内容重算，而不是上一回合留下的副本',
    );

    assert.equal(indexSourceHash(r.indexDir), before, '候选不得让派生数据发生任何变化');
    assert.equal(stub.received.length, 2, '两者都真的写了记忆');
    assert.ok(
      r.host.logs.info.filter((line) => line.includes('保存候选计量')).length >= 2,
      '每次保存各记一行仪表（插件不保存历史）',
    );
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('不追索引：正本变了也不为候选追赶，候选按当时索引作答', async () => {
  const stub = await writeStub(201, '{"id":901,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    await buildIndex(r.host);
    const before = indexSourceHash(r.indexDir);
    // A row written to the source AFTER the index was built: it must not be
    // caught up for, and it must not appear as a candidate.
    writeSource(r.dbPath, [
      ...DEFAULT_ROWS,
      {
        id: 3,
        title: '写层规划：候选在写入之前算好（新写的）',
        content: '桥自己的保存入口在写入之前用读层的派生索引算候选，并限定在同一项目内。新写的。',
        type: 'architecture',
        project: 'stub-project',
      },
    ]);
    const value = (await callTool(
      r.host,
      SAVE,
      {
        title: '写层规划：候选在写入之前算好',
        content: '桥自己的保存入口在写入之前用读层的派生索引算候选，并限定在同一项目内。',
        type: 'architecture',
      },
      { sessionId: 'stub-save' },
    )) as { candidates: Array<{ id: number }> };
    assert.ok(
      !value.candidates.some((candidate) => candidate.id === 3),
      '尚未进索引的条目不可能成为候选（不为候选追赶）',
    );
    assert.equal(indexSourceHash(r.indexDir), before, '候选查询不得触发同步或重建');
    // The instrument still says the derived data lags, which is the point.
    assert.ok(
      r.host.logs.info.some((line) => /保存候选计量：.*落后=true/.test(line)),
      `落后仪表必须在场：${r.host.logs.info.join(' | ')}`,
    );
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('写入不依赖候选：模型目录缺失时保存照常成功、没有候选，检索则响亮失败', async () => {
  const stub = await writeStub(201, '{"id":902,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url, withoutModel: true });
  try {
    await startSession(r.host, 'stub-save');
    const value = (await callTool(
      r.host,
      SAVE,
      { title: 'T', content: '写入不依赖候选。', type: 'discovery' },
      { sessionId: 'stub-save' },
    )) as { id?: number; candidates: unknown[] };
    assert.equal(value.id, 902, '写入必须成功');
    assert.deepEqual(value.candidates, [], '没有候选');
    await assert.rejects(
      () => callTool(r.host, 'mcp__engram__mem_bridge_recall', { query: 'x' }, { sessionId: 'stub-save' }),
      /运行时|模型|不可用/,
      '与候选的静默降级形成对照：检索在同样情形下要响亮失败',
    );
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('引擎开关关闭：保存照常成功、不产出候选，也不为该次保存加载运行时', async () => {
  const stub = await writeStub(201, '{"id":903,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url, searchEnabled: false });
  try {
    await startSession(r.host, 'stub-save');
    const value = (await callTool(
      r.host,
      SAVE,
      { title: 'T', content: '开关关闭。', type: 'discovery' },
      { sessionId: 'stub-save' },
    )) as { id?: number; candidates: unknown[] };
    assert.equal(value.id, 903);
    assert.deepEqual(value.candidates, []);
    assert.ok(!existsSync(r.indexDir), '开关关闭时不得为该次保存建立派生索引');
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('回退：连接被拒时保存成功、带上游的落库标识、不转述上游候选，且日志记下待判行', async () => {
  const port = await closedPort();
  const r = await rig({ writeBaseUrl: `http://127.0.0.1:${port}` });
  try {
    await startSession(r.host, 'stub-save');
    await buildIndex(r.host);
    const value = (await callTool(
      r.host,
      SAVE,
      { title: '回退路径', content: '写入面不可达时走上游写入工具。', type: 'discovery' },
      { sessionId: 'stub-save' },
    )) as { id?: number; fallback?: { reason: string }; candidates: Array<{ id: number }> };
    const text = rendered(r.host.registrations.get(SAVE)!, value);
    assert.equal(value.id, 4242, '回退也要履行同样的结果义务：给出本次落库标识');
    assert.ok(value.fallback !== undefined);
    assert.match(text, /回退路径/);
    assert.match(text, /已保存 #4242/);
    assert.ok(!text.includes('#9'), '上游返回的候选不得被转述');
    assert.ok(!text.includes('rel-stub'), '上游的判定标识不得被转述');
    assert.ok(
      readCalls(r.callsPath).some((call) => call.name === 'mem_save'),
      '回退真的走了上游写入工具',
    );
    assert.ok(
      r.host.logs.warn.some((line) => /保存回退到上游写入工具/.test(line) && /待判关系行/.test(line)),
      `回退的待判行事实必须记进日志：${r.host.logs.warn.join(' | ')}`,
    );
  } finally {
    await r.cleanup();
  }
});

test('4xx 不回退：以明确原因失败、不落库、上游写入工具一次都没被调用', async () => {
  const stub = await writeStub(400, '{"error":"session project does not match requested project"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    await assert.rejects(
      () =>
        callTool(
          r.host,
          SAVE,
          { title: 'T', content: '被拒的请求不应换一条路重犯。', type: 'discovery' },
          { sessionId: 'stub-save' },
        ),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /session project does not match/);
        assert.ok(!/回退/.test(message), '4xx 结果里不得出现回退字样');
        return true;
      },
    );
    assert.ok(
      !readCalls(r.callsPath).some((call) => call.name === 'mem_save'),
      '4xx 不得回退',
    );
    assert.equal(stub.received.length, 1);
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('5xx 回退；回退拿自己的独立预算，不继承共享的工具超时', async () => {
  const stub = await writeStub(503, '{"error":"unavailable"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    const value = (await callTool(
      r.host,
      SAVE,
      { title: 'T', content: '5xx 应当回退。', type: 'discovery' },
      { sessionId: 'stub-save' },
    )) as { id?: number; fallback?: unknown };
    assert.equal(value.id, 4242);
    assert.ok(value.fallback !== undefined);
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('归属按既有那一套注入：两个开关都开时带上会话与项目；显式传值优先', async () => {
  const stub = await writeStub(201, '{"id":904,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    await callTool(r.host, SAVE, { title: 'T', content: 'C', type: 'discovery' }, { sessionId: 'stub-save' });
    assert.equal(stub.received[0]!.session_id, 'stub-save');
    assert.equal(stub.received[0]!.project, 'stub-project');

    // An explicit value wins and is not rewritten.
    await callTool(
      r.host,
      SAVE,
      { title: 'T2', content: 'C2', type: 'discovery', project: 'beta', session_id: 'explicit-session' },
      { sessionId: 'stub-save' },
    );
    assert.equal(stub.received[1]!.project, 'beta');
    assert.equal(stub.received[1]!.session_id, 'explicit-session');
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('项目注入关闭且未显式传值时拒绝保存，且没有发生任何写入', async () => {
  const stub = await writeStub(201, '{"id":1,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url, injectSessionProject: false });
  try {
    await startSession(r.host, 'stub-save');
    await assert.rejects(
      () =>
        callTool(r.host, SAVE, { title: 'T', content: 'C', type: 'discovery' }, { sessionId: 'stub-save' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /injectSessionProject/);
        assert.match(message, /显式传 project/);
        assert.match(message, /没有写入任何记忆/);
        return true;
      },
    );
    assert.equal(stub.received.length, 0, '被拒绝的保存不得发出任何写入请求');
    assert.ok(!readCalls(r.callsPath).some((call) => call.name === 'mem_save'));

    // One of the two ways out: pass the value explicitly.
    const value = (await callTool(
      r.host,
      SAVE,
      { title: 'T', content: 'C', type: 'discovery', project: 'stub-project' },
      { sessionId: 'stub-save' },
    )) as { id?: number };
    assert.equal(value.id, 1);
    assert.equal(stub.received.length, 1);
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('会话标识注入关闭且未显式传值时拒绝保存', async () => {
  const stub = await writeStub(201, '{"id":1,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url, injectSessionId: false });
  try {
    await startSession(r.host, 'stub-save');
    await assert.rejects(
      () =>
        callTool(r.host, SAVE, { title: 'T', content: 'C', type: 'discovery' }, { sessionId: 'stub-save' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /injectSessionId/);
        assert.match(message, /显式传 session_id/);
        assert.match(message, /没有写入任何记忆/);
        return true;
      },
    );
    assert.equal(stub.received.length, 0);
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('后端没有给出项目、也没有覆盖链时拒绝保存（后端那一支）', async () => {
  const stub = await writeStub(201, '{"id":1,"status":"saved"}');
  const r = await rig({ writeBaseUrl: stub.url, stubEnv: { ENGRAM_STUB_NO_PROJECT: '1' } });
  try {
    await startSession(r.host, 'stub-save');
    await assert.rejects(
      () =>
        callTool(r.host, SAVE, { title: 'T', content: 'C', type: 'discovery' }, { sessionId: 'stub-save' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /项目无从判定/);
        assert.match(message, /projectOverrides/);
        assert.match(message, /没有写入任何记忆/);
        return true;
      },
    );
    assert.equal(stub.received.length, 0);
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('自反对被挡在门外：两个标识相同的请求不会到达后端', async () => {
  const stub = await writeStub();
  const r = await rig({ writeBaseUrl: stub.url });
  try {
    await startSession(r.host, 'stub-save');
    await assert.rejects(
      () =>
        callTool(
          r.host,
          'mcp__engram__mem_compare',
          { memory_id_a: 5, memory_id_b: 5, relation: 'supersedes', confidence: 1, reasoning: 'x' },
          { sessionId: 'stub-save' },
        ),
      /自反|同一条记忆/,
    );
    assert.ok(
      !readCalls(r.callsPath).some((call) => call.name === 'mem_compare'),
      '自反请求必须在转发前被拒绝（上游对自反对没有保护）',
    );
  } finally {
    await r.cleanup();
    await stub.close();
  }
});

test('写前算候选：写入请求到达时，候选查询的仪表行已经在日志里', async () => {
  // The witness is inside the write server itself: while it is handling the
  // request, the candidate lookup must ALREADY have happened. If the order were
  // reversed, this list would be empty at that instant.
  const seenAtWrite: string[][] = [];
  let host: { logs: { info: string[] } } | undefined;
  const stub = await writeStub(201, '{"id":905,"status":"saved"}', () => {
    seenAtWrite.push([...(host?.logs.info ?? [])]);
  });
  const r = await rig({ writeBaseUrl: stub.url });
  host = r.host;
  try {
    await startSession(r.host, 'stub-save');
    await buildIndex(r.host);
    const value = (await callTool(
      r.host,
      SAVE,
      { title: '写前算候选', content: '候选必须在写入之前算出，因此不可能包含本次新建的那一行。', type: 'discovery' },
      { sessionId: 'stub-save' },
    )) as { id?: number; candidates: Array<{ id: number }> };
    assert.equal(value.id, 905);
    assert.equal(seenAtWrite.length, 1);
    assert.ok(
      seenAtWrite[0]!.some((line) => line.includes('保存候选计量')),
      `写入发生时日志里必须有候选计量行：${JSON.stringify(seenAtWrite[0])}`,
    );
    assert.ok(
      value.candidates.every((candidate) => candidate.id !== 905),
      '候选不可能指向本次新建的行：它在写入前还不存在',
    );
  } finally {
    await r.cleanup();
    await stub.close();
  }
});
