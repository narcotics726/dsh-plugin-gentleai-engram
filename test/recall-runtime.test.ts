import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../dist/config.js';
import { RecallUnavailableError } from '../dist/recall/process.js';
import { DEFAULT_RECALL_LIMIT, RECALL_INPUT_SCHEMA, RECALL_OUTPUT_SCHEMA, RECALL_TOOL_NAME, renderRecall, toRecallQuery } from '../dist/recall-tool.js';
import type { RecallPayload } from '../dist/recall/protocol.js';
import { removeDir, tempDir } from './recall-support.ts';

/**
 * Runtime-surface tests: configuration contract, the tool's schema and wording,
 * the host-entry boundary mechanism, and the loud failure when the installation
 * is incomplete.
 */

const resolved = Config({ command: 'engram' }) as unknown as Record<string, unknown>;

test('配置：新键全部有默认值且类型正确（硬规则 5）', () => {
  const expected: Record<string, [string, unknown]> = {
    searchEnabled: ['boolean', true],
    searchDbPath: ['string', undefined],
    searchIndexDir: ['string', undefined],
    searchModelDir: ['string', undefined],
    embedThreads: ['number', 1],
    searchIdleMs: ['number', 600000],
    searchSweepIntervalMs: ['number', 60000],
    searchTimeoutMs: ['number', 60000],
    searchW: ['number', 0.2],
    searchTopK: ['number', 50],
    searchCoverage: ['string', 'field_cov'],
  };
  for (const [key, [type, value]] of Object.entries(expected)) {
    assert.equal(typeof resolved[key], type, `${key} 的类型`);
    if (value !== undefined) assert.equal(resolved[key], value, `${key} 的默认值`);
    assert.notEqual(resolved[key], undefined, `${key} 必须有默认值`);
  }
  assert.ok(String(resolved.searchDbPath).endsWith('engram.db'));
  assert.ok(String(resolved.searchIndexDir).includes(join('storages', 'engram-bridge')));
  assert.ok(String(resolved.searchModelDir).includes(join('storages', 'engram-bridge')));

  // limit 是工具输入，config 不得提供第二个默认（design D6/D9）。
  assert.deepEqual(
    Object.keys(resolved).filter((key) => /limit/i.test(key)),
    [],
    'config 里不应出现 limit',
  );
  // 新键一律 search* 前缀，唯一例外是命名运行时参数的 embedThreads。
  assert.deepEqual(
    Object.keys(resolved)
      .filter((key) => /recall/i.test(key))
      .sort(),
    ['recallWakeup'],
    'recall* 只应剩既有的压缩恢复开关',
  );
});

test('配置源码：w 的默认值只在 schema 里出现一次', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'config.ts'), 'utf8');
  const hits = source.split('\n').filter((line) => line.includes('0.20'));
  assert.equal(hits.length, 1, 'searchW 的默认值应在 config schema 里恰好出现一次');
  assert.ok(hits[0]!.includes('searchW'));
  const scorer = readFileSync(join(process.cwd(), 'src', 'recall', 'scoring.ts'), 'utf8');
  assert.ok(!scorer.includes('0.20'), '打分器里不得出现第二处 w');
});

test('工具输入 schema：project 在、since/until 不在、limit 默认值在 schema 里', () => {
  assert.equal(RECALL_TOOL_NAME, 'mcp__engram__mem_bridge_recall');
  const properties = RECALL_INPUT_SCHEMA.properties as Record<string, { default?: unknown; description?: string }>;
  assert.ok(Object.hasOwn(properties, 'query'));
  assert.ok(Object.hasOwn(properties, 'project'), 'project 是注入的前提');
  assert.ok(Object.hasOwn(properties, 'all_projects'));
  assert.ok(Object.hasOwn(properties, 'type'));
  assert.ok(Object.hasOwn(properties, 'scope'));
  assert.ok(Object.hasOwn(properties, 'match_mode'));
  assert.ok(!Object.hasOwn(properties, 'since'), 'since 刻意不做');
  assert.ok(!Object.hasOwn(properties, 'until'), 'until 刻意不做');
  assert.equal(properties.limit!.default, 10);
  assert.equal(DEFAULT_RECALL_LIMIT, 10);
  assert.deepEqual(RECALL_INPUT_SCHEMA.required, ['query']);
  assert.match(properties.match_mode!.description ?? '', /忽略/);
});

test('工具参数规范化：省略 limit 用 schema 默认值，空串项目不当作显式值', () => {
  assert.deepEqual(toRecallQuery({ query: 'q' }), { query: 'q', limit: 10 });
  assert.deepEqual(toRecallQuery({ query: 'q', limit: 3, project: 'a', all_projects: true }), {
    query: 'q',
    limit: 3,
    project: 'a',
    allProjects: true,
  });
  assert.equal(toRecallQuery({ query: 'q', project: '' }).project, undefined);
  assert.equal(toRecallQuery({ query: 'q', limit: 0 }).limit, 1);
  assert.equal(toRecallQuery({ query: 'q', limit: 999 }).limit, 100);
});

function payload(overrides: Partial<RecallPayload> = {}): RecallPayload {
  return {
    hits: [
      { id: 1, title: '标题', type: 'decision', project: 'alpha', scope: 'project', score: 0.9, excerpt: '摘要' },
    ],
    limit: 10,
    truncated: false,
    filteredOut: 0,
    poolSize: 50,
    candidates: 3,
    availableTypes: [],
    metering: {
      sourceChanged: false,
      rowsScanned: 1,
      docsTouched: 0,
      hashMs: 0,
      syncMs: 0,
      embedDocs: 0,
      embedLoadMs: 0,
      embedQueryMs: 0,
      scoreMs: 0,
      totalMs: 0,
      mode: 'noop',
      docCount: 1,
      indexBytes: 0,
    },
    ...overrides,
  };
}

test('渲染：截断时说明还有未显示，恰好达到上限时不出现', () => {
  const truncated = renderRecall({}, payload({ truncated: true }))[0]!.text;
  assert.match(truncated, /未显示/);
  const exact = renderRecall({}, payload({ truncated: false }))[0]!.text;
  assert.doesNotMatch(exact, /未显示/);
  assert.doesNotMatch(exact, /共\s*\d+\s*条候选/, '不得出现会被读成语料上限的措辞');
});

test('渲染：类型不存在时列出实际取值', () => {
  const text = renderRecall(
    {},
    payload({ hits: [], availableTypes: ['architecture', 'decision'], filteredOut: 4 }),
  )[0]!.text;
  assert.match(text, /没有匹配/);
  assert.match(text, /architecture \/ decision/);
});

test('渲染：每条带 id/标题/类型/项目/范围/得分/摘要', () => {
  const text = renderRecall({}, payload())[0]!.text;
  for (const fragment of ['#1', '标题', 'decision', 'alpha', 'project', '摘要']) {
    assert.ok(text.includes(fragment), `渲染文本应包含 ${fragment}`);
  }
  const schema = RECALL_OUTPUT_SCHEMA.properties as Record<string, unknown>;
  for (const key of ['hits', 'truncated', 'availableTypes', 'filteredOut', 'metering']) {
    assert.ok(Object.hasOwn(schema, key), `output.schema 应声明 ${key}`);
  }
});

test('边界机制：宿主入口不触及嵌入运行时，且对违规 import 会失败', () => {
  const script = join(process.cwd(), 'scripts', 'check-recall-boundary.mjs');
  const ok = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  assert.match(ok, /boundary: ok/);

  // 阴性对照：一个 import 了该依赖的入口必须让检查失败。
  const dir = tempDir('boundary-');
  try {
    const probe = join(dir, 'probe.js');
    writeFileSync(probe, "import * as ort from 'onnxruntime-web';\nexport const x = ort;\n");
    assert.throws(() => execFileSync(process.execPath, [script, probe], { encoding: 'utf8', stdio: 'pipe' }));

    // 锁模块同样只在写入者进程里：宿主拿它没有意义（宿主不写索引），而把它
    // 挡在宿主闭包外是一条机制，不是一句声明。
    assert.match(
      readFileSync(script, 'utf8'),
      /FORBIDDEN_FILES\s*=\s*new Set\(\[[^\]]*'index-lock\.js'/,
      '锁模块必须在宿主入口的禁触清单里',
    );
    const lockProbe = join(dir, 'lock-probe.js');
    writeFileSync(lockProbe, "import './x.js';\nexport const x = 1;\n");
    writeFileSync(join(dir, 'x.js'), "export {};\n");
    assert.ok(readFileSync(script, 'utf8').includes("'index-lock.js'"));
  } finally {
    removeDir(dir);
  }
});

test('模型目录不完整时在调用点响亮失败，且不启动任何子进程', async () => {
  const { RecallProcessManager } = await import('../dist/recall/process.js');
  const dir = tempDir('model-missing-');
  const logged: string[] = [];
  const manager = new RecallProcessManager({
    dbPath: join(dir, 'source.db'),
    indexPath: join(dir, 'index.db'),
    modelDir: join(dir, 'model'),
    threads: 1,
    w: 0.2,
    topK: 50,
    coverage: 'field_cov',
    idleMs: 1000,
    timeoutMs: 2000,
    log: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => logged.push(message),
      error: (message: string) => logged.push(message),
    },
  });
  try {
    // 安装目录存在但为空：缺少所有部件。
    mkdirSync(join(dir, 'model', 'node_modules'), { recursive: true });
    await assert.rejects(
      () => manager.query({ query: 'x', limit: 1, project: 'alpha' }),
      (error: unknown) => {
        assert.ok(error instanceof RecallUnavailableError);
        assert.equal(error.kind, 'runtime-missing');
        assert.match(error.message, /install-recall-model\.mjs/);
        assert.match(error.message, /不会自动下载/);
        // 缺失与不符是两种情形：缺席的部件说「缺失」，存在的部件不能说「缺少」。
        assert.match(error.message, /缺少/);
        assert.doesNotMatch(error.message, /不符/);
        return true;
      },
    );
    assert.equal(manager.running(), false, '缺失模型时不应启动检索子进程');
  } finally {
    await manager.dispose();
    removeDir(dir);
  }
});
