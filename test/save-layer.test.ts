import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../dist/config.js';
import {
  normalizeSaveParams,
  SAVE_SOURCE_MARK,
  SaveInputError,
  toFallbackArgs,
  toWriteBody,
} from '../dist/save/params.js';
import { WriteFailure, writeObservation } from '../dist/save/write-client.js';
import {
  REPLACED_SAVE_TOOL,
  SAVE_INPUT_SCHEMA,
  SAVE_REMINDER,
  SAVE_TIMEOUT_MARGIN_MS,
  SAVE_TOOL_NAME,
  renderSave,
  saveToolTimeoutMs,
  type SaveResult,
} from '../dist/save-tool.js';
import { UNREGISTERED_ENGRAM_TOOLS } from '../dist/tools.js';

/**
 * The write layer's own surface: argument normalisation shared by both paths, the
 * HTTP client's request/response contract, and the save tool's schema plus the
 * projection the model actually reads.
 */

const TARGET = { sessionId: 'sess-1', project: 'alpha' };

interface Stub {
  url: string;
  received: Array<Record<string, unknown>>;
  /** Set when a request's socket closed before a response was written. */
  abandoned: boolean;
  close(): Promise<void>;
}

/** A local HTTP server that speaks the write route's shapes. */
async function stubServer(
  handler: (body: Record<string, unknown>, respond: (status: number, payload: string) => void) => void,
): Promise<Stub> {
  const received: Array<Record<string, unknown>> = [];
  let abandoned = false;
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('close', () => {
      if (!response.writableEnded) abandoned = true;
    });
    request.on('end', () => {
      received.push(JSON.parse(raw) as Record<string, unknown>);
      handler(received[received.length - 1]!, (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(payload);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    get abandoned() {
      return abandoned;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  } as Stub;
}

/** A port nothing listens on: the connection-refused case. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('归一化：缺省 type 与 observation 别名由桥统一补，路径之前只有这一次', () => {
  const base = normalizeSaveParams({ title: 'T', content: 'C' });
  assert.deepEqual(base, { title: 'T', content: 'C', type: 'manual', scope: '', topicKey: '' });
  // The alias only applies when `content` is blank — same rule as the backend's
  // handler, which is what makes the two paths emit identical content.
  assert.equal(normalizeSaveParams({ title: 'T', observation: 'from-alias' }).content, 'from-alias');
  assert.equal(
    normalizeSaveParams({ title: 'T', content: 'real', observation: 'ignored' }).content,
    'real',
  );
  assert.equal(normalizeSaveParams({ title: 'T', content: 'C', type: '' }).type, 'manual');
  assert.equal(normalizeSaveParams({ title: 'T', content: 'C', type: 'bugfix' }).type, 'bugfix');
  assert.equal(normalizeSaveParams({ title: 'T', content: 'C' }).content, 'C', '正文只按空判定，不被改写');
  assert.throws(() => normalizeSaveParams({ title: 'T', content: '   ' }), SaveInputError);
  assert.throws(() => normalizeSaveParams({ title: '', content: 'C' }), SaveInputError);
});

test('两条路径发出的字段逐字相同（含省略 type 与使用别名的两种入参）', () => {
  for (const raw of [
    { title: 'T', content: 'C' },
    { title: 'T', observation: 'from-alias' },
    { title: 'T', content: 'C', type: 'decision', scope: 'personal', topic_key: 'k/1' },
  ]) {
    const params = normalizeSaveParams(raw as Record<string, unknown>);
    const body = toWriteBody(params, TARGET);
    const fallback = toFallbackArgs(params, TARGET);
    for (const key of ['session_id', 'type', 'title', 'content', 'project', 'scope', 'topic_key']) {
      assert.deepEqual(body[key], fallback[key], `${key} 必须在两条路径上逐字相同（${JSON.stringify(raw)}）`);
    }
    // Only the HTTP path can carry the mark: the MCP save tool takes no `tool_name`.
    assert.equal(body.tool_name, SAVE_SOURCE_MARK);
    assert.ok(!Object.hasOwn(fallback, 'tool_name'));
  }
});

test('写入面：201 落库，body 逐字段正确，来源标记就在其中', async () => {
  const stub = await stubServer((_body, respond) => respond(201, '{"id":42,"status":"saved"}'));
  try {
    const params = normalizeSaveParams({ title: 'T', content: 'C', type: 'decision' });
    const outcome = await writeObservation({
      baseUrl: stub.url,
      timeoutMs: 2000,
      body: toWriteBody(params, TARGET),
    });
    assert.deepEqual(outcome, { id: 42 });
    assert.deepEqual(stub.received[0], {
      session_id: 'sess-1',
      type: 'decision',
      title: 'T',
      content: 'C',
      project: 'alpha',
      scope: '',
      topic_key: '',
      tool_name: SAVE_SOURCE_MARK,
    });
  } finally {
    await stub.close();
  }
});

test('写入面：201 但响应不是 JSON 时，写入仍算成功、只是标识未知', async () => {
  const stub = await stubServer((_body, respond) => respond(201, 'not json at all'));
  try {
    const outcome = await writeObservation({
      baseUrl: stub.url,
      timeoutMs: 2000,
      body: { a: 1 },
    });
    assert.deepEqual(outcome, {}, '不能因为读不出 id 就当失败，否则回退会写第二行');
  } finally {
    await stub.close();
  }
});

test('写入面：四类错误各自可辨（4xx / 5xx / 连接 / 超时）', async () => {
  const rejected = await stubServer((_body, respond) =>
    respond(400, '{"error":"session project does not match requested project"}'),
  );
  try {
    await assert.rejects(
      () => writeObservation({ baseUrl: rejected.url, timeoutMs: 2000, body: {} }),
      (error: unknown) => {
        assert.ok(error instanceof WriteFailure);
        assert.equal(error.kind, 'rejected');
        assert.equal(error.status, 400);
        assert.match(error.message, /session project does not match/);
        return true;
      },
    );
  } finally {
    await rejected.close();
  }

  const broken = await stubServer((_body, respond) => respond(500, '{"error":"boom"}'));
  try {
    await assert.rejects(
      () => writeObservation({ baseUrl: broken.url, timeoutMs: 2000, body: {} }),
      (error: unknown) => {
        assert.equal((error as WriteFailure).kind, 'server');
        return true;
      },
    );
  } finally {
    await broken.close();
  }

  const port = await closedPort();
  await assert.rejects(
    () => writeObservation({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000, body: {} }),
    (error: unknown) => {
      assert.equal((error as WriteFailure).kind, 'connection');
      return true;
    },
  );
});

test('写入面：超时被放弃；调用方的取消信号真的传进请求', async () => {
  const slow = await stubServer(() => {
    /* never responds */
  });
  try {
    await assert.rejects(
      () => writeObservation({ baseUrl: slow.url, timeoutMs: 120, body: {} }),
      (error: unknown) => {
        assert.equal((error as WriteFailure).kind, 'timeout');
        return true;
      },
    );

    const controller = new AbortController();
    const pending = writeObservation({
      baseUrl: slow.url,
      timeoutMs: 5000,
      signal: controller.signal,
      body: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as WriteFailure).kind, 'cancelled');
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(slow.abandoned, '中止后请求必须被放弃，而不是继续等在那儿');
  } finally {
    await slow.close();
  }
});

test('写入面：已经取消的信号在发起前就被拒绝', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => writeObservation({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 100, signal: controller.signal, body: {} }),
    (error: unknown) => {
      assert.equal((error as WriteFailure).kind, 'cancelled');
      return true;
    },
  );
});

test('保存工具：参数面与上游同形，去掉上游特有的三个，并声明会话与项目', () => {
  assert.equal(SAVE_TOOL_NAME, 'mcp__engram__mem_bridge_save');
  assert.ok(UNREGISTERED_ENGRAM_TOOLS.includes(REPLACED_SAVE_TOOL), '被取代的上游写入工具不得注册');
  const properties = SAVE_INPUT_SCHEMA.properties as Record<string, unknown>;
  for (const key of ['title', 'content', 'type', 'scope', 'topic_key', 'observation', 'session_id', 'project']) {
    assert.ok(Object.hasOwn(properties, key), `参数面必须有 ${key}`);
  }
  for (const key of ['capture_prompt', 'project_choice_reason', 'recovery_token']) {
    assert.ok(!Object.hasOwn(properties, key), `上游特有的 ${key} 不应出现`);
  }
  assert.deepEqual(SAVE_INPUT_SCHEMA.required, ['title']);
});

test('静态超时按最坏路径派生，并且覆盖最坏路径', () => {
  const budgets = { saveCandidateBudgetMs: 2000, writeTimeoutMs: 10000, saveFallbackBudgetMs: 20000 };
  const total = saveToolTimeoutMs(budgets);
  assert.equal(total, 2000 + 10000 + 20000 + SAVE_TIMEOUT_MARGIN_MS);
  // Positive assertion: the declared timeout covers candidates + write + fallback.
  assert.ok(
    total >= budgets.saveCandidateBudgetMs + budgets.writeTimeoutMs + budgets.saveFallbackBudgetMs,
    '静态超时必须覆盖最坏路径：候选预算 + 写入超时 + 回退预算',
  );
  assert.ok(SAVE_TIMEOUT_MARGIN_MS > 0, '余量必须为正：绑定、注入、进程往返与渲染都要放进去');
});

function candidate(overrides: Partial<SaveResult['candidates'][number]> = {}): SaveResult['candidates'][number] {
  return {
    id: 12,
    title: '既有条目',
    type: 'decision',
    updated_at: '2026-09-01 10:00:00',
    same_topic_key: '',
    same_session: false,
    same_type_and_title: false,
    identical_content: false,
    shared_rare_terms: { count: 2, terms: ['派生索引', '覆盖加成'] },
    semantic_rank: 3,
    corpus_size: 563,
    will_update: false,
    ...overrides,
  };
}

function textOf(result: SaveResult): string {
  return renderSave({}, result)[0]!.text;
}

test('渲染：两个标识可区分、证据中性、数值追到具体物、不出现内部排序分数', () => {
  const result: SaveResult = {
    id: 99,
    type: 'decision',
    project: 'alpha',
    candidates: [
      candidate({ same_topic_key: 'architecture/index', same_session: true, identical_content: true }),
    ],
  };
  const text = textOf(result);
  assert.match(text, /已保存 #99（本次保存的标识）/);
  assert.match(text, /候选 #12/);
  assert.match(text, /语义名次：第 3 名（共 563 条）/, '给出的是机械名次，不是相似度原始值');
  assert.match(text, /共享稀有词 2 个：派生索引 \/ 覆盖加成/, '共享词要列出来，不只是计数');
  assert.match(text, /同一个主题键：architecture\/index/);
  assert.match(text, /同一次会话/);
  assert.match(text, /内容完全相同/);
  assert.doesNotMatch(text, /\d\.\d{4}/, '不得出现内部排序分数');
  assert.doesNotMatch(text, /score|得分/i);
  assert.doesNotMatch(text, /疑似模板/);
  assert.doesNotMatch(text, /template_like/);
});

test('渲染：判「无关」之外不写关系结论，提醒只在有候选时出现', () => {
  const withCandidate = textOf({
    id: 1,
    type: 'manual',
    project: 'alpha',
    candidates: [candidate()],
  });
  assert.ok(withCandidate.endsWith(SAVE_REMINDER), '候选存在时提醒必须在末尾');
  const without = textOf({ id: 1, type: 'manual', project: 'alpha', candidates: [] });
  assert.ok(!without.includes(SAVE_REMINDER), '没有候选时提醒不出现');
  assert.match(without, /本次没有给出候选/);
});

test('提醒是常量：只讲动作，含本次回复 / 不会重发 / 两个标识，且不含关系结论词', () => {
  assert.match(SAVE_REMINDER, /本次回复/);
  assert.match(SAVE_REMINDER, /不会重发/);
  assert.match(SAVE_REMINDER, /本次保存的标识/);
  assert.match(SAVE_REMINDER, /候选的标识/);
  assert.match(SAVE_REMINDER, /先读候选全文/);
  assert.match(SAVE_REMINDER, /没把握就别记录/);
  for (const verdict of ['重复', '取代', '冲突', '无关']) {
    assert.ok(!SAVE_REMINDER.includes(verdict), `提醒不得含关系结论词：${verdict}`);
  }
  // The judging rules stay in ONE place: the skill body.
  assert.ok(!SAVE_REMINDER.includes('mem_compare'), '提醒不复述判法');
});

test('渲染：改写既有条目时同时标明「本次将更新它」和「这一对不构成可写的关系」', () => {
  const result: SaveResult = {
    id: 12,
    type: 'decision',
    project: 'alpha',
    candidates: [candidate({ will_update: true })],
  };
  const text = textOf(result);
  assert.match(text, /本次将更新它/);
  assert.match(text, /不构成可写的关系/);
});

test('渲染：回退时说明回退且不转述上游候选', () => {
  const text = textOf({
    id: 7,
    type: 'manual',
    project: 'alpha',
    fallback: { reason: 'connection：连接写入面失败（ECONNREFUSED）' },
    candidates: [],
  });
  assert.match(text, /回退路径/);
  assert.match(text, /已保存 #7/);
  assert.match(text, /不在此转述/);
});

test('写层配置键：默认值与非法值都在 schema 里，B 复用读层的键', () => {
  const resolved = Config({ command: 'engram' }) as unknown as Record<string, unknown>;
  assert.equal(resolved.writeBaseUrl, 'http://127.0.0.1:7437', '写入面的默认端口来自该服务自己的默认值');
  assert.equal(resolved.writeTimeoutMs, 10000);
  assert.equal(resolved.saveCandidateBudgetMs, 2000);
  assert.equal(resolved.saveFallbackBudgetMs, 20000);
  assert.equal(resolved.saveCandidateLimit, 5);
  assert.throws(() => Config({ command: 'engram', writeTimeoutMs: 0 }));
  assert.throws(() => Config({ command: 'engram', saveFallbackBudgetMs: 0 }));
  assert.throws(() => Config({ command: 'engram', saveCandidateLimit: 0 }));

  // Each default is declared exactly once, in the schema.
  const source = readFileSync(join(process.cwd(), 'src', 'config.ts'), 'utf8');
  for (const literal of [/\b10000\b/, /\b2000\b/, /\b20000\b/]) {
    assert.equal(
      source.split('\n').filter((line) => literal.test(line)).length,
      1,
      `${literal} 应当只出现一次`,
    );
  }

  // The coverage-boost pool (B) is the read layer's key, not a second one.
  assert.deepEqual(
    Object.keys(resolved).filter((key) => /topk|poolsize/i.test(key)),
    ['searchTopK'],
  );
});
