import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type { McpToolDeclaration } from '../dist/mcp-client.js';
import {
  RECALL_INPUT_SCHEMA,
  RECALL_OUTPUT_SCHEMA,
  RECALL_SYNC_INPUT_SCHEMA,
  RECALL_SYNC_OUTPUT_SCHEMA,
  buildRecallSyncToolDefinition,
  buildRecallToolDefinition,
} from '../dist/recall-tool.js';
import { buildSaveToolDefinition, SAVE_INPUT_SCHEMA, SAVE_OUTPUT_SCHEMA } from '../dist/save-tool.js';
import type { SaveResult } from '../dist/save-tool.js';
import { buildToolDefinitions, OUTPUT_SCHEMA } from '../dist/tools.js';
import { TOOLS } from './engram-tools.mjs';

/**
 * Every schema this plugin hands the host must be inside the host's ENFORCED
 * JSON-schema subset.
 *
 * This is not a style preference. The host validates, rejects the tool AND fails
 * the ENTIRE plugin tree at load — the observed failure was
 * `unsupported JSON schema: schema.properties.candidates.items.properties
 * .same_topic_key.type must be a single type string (type arrays are not
 * supported)`, which took down boot for every profile with the plugin installed.
 * It is invisible to the repository's own tests because the fake host in the
 * wiring rigs does not validate schemas, and it is invisible to `--dump-config`
 * because that never loads modules.
 *
 * So the check is mechanical and runs the host's own validator — over the
 * constants AND over the definitions we actually register — and additionally
 * validates a REAL output value against its schema, which is what catches the
 * sibling bug class: a value that no longer matches its declared type.
 */

/** Every schema constant the plugin can hand to the host. */
const REGISTERED_SCHEMAS: ReadonlyArray<[string, unknown]> = [
  ['OUTPUT_SCHEMA (bridged engram tools)', OUTPUT_SCHEMA],
  ['RECALL_INPUT_SCHEMA', RECALL_INPUT_SCHEMA],
  ['RECALL_OUTPUT_SCHEMA', RECALL_OUTPUT_SCHEMA],
  ['RECALL_SYNC_INPUT_SCHEMA', RECALL_SYNC_INPUT_SCHEMA],
  ['RECALL_SYNC_OUTPUT_SCHEMA', RECALL_SYNC_OUTPUT_SCHEMA],
  ['SAVE_INPUT_SCHEMA', SAVE_INPUT_SCHEMA],
  ['SAVE_OUTPUT_SCHEMA', SAVE_OUTPUT_SCHEMA],
];

const engramDeclaration: McpToolDeclaration = {
  name: 'mem_context',
  inputSchema: { type: 'object', properties: { project: { type: 'string' } } },
};

test('每一个注册给宿主的 schema 都在宿主执行的子集里', () => {
  for (const [label, schema] of REGISTERED_SCHEMAS) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(schema), `${label} 超出宿主的 schema 子集`);
  }
  // Input schemas are object roots; the host applies this stricter assertion to
  // tool arguments.
  for (const [label, schema] of REGISTERED_SCHEMAS) {
    if (!label.endsWith('INPUT_SCHEMA')) continue;
    assert.doesNotThrow(() => assertObjectJsonSchema(schema), `${label} 必须是对象根`);
  }
});

test('工具定义实际交出去的 schema 也在子集里（走注册路径，而不是只看常量）', () => {
  const definitions = [
    buildSaveToolDefinition({ timeoutMs: 1, run: async () => ({ type: 'manual', project: 'p', candidates: [] }) }),
    buildRecallToolDefinition({ timeoutMs: 1, run: async () => ({}) as never }),
    buildRecallSyncToolDefinition({ timeoutMs: 1, run: async () => '' }),
    ...buildToolDefinitions([engramDeclaration], {
      timeoutMs: 1,
      run: async () => ({ content: [] }),
    }),
  ];
  assert.equal(definitions.length, 4);
  for (const definition of definitions) {
    assert.doesNotThrow(
      () => assertObjectJsonSchema(definition.parameters),
      `${definition.name} 的参数 schema 超出子集`,
    );
    const output = definition.output as { schema?: unknown } | undefined;
    assert.ok(output?.schema !== undefined, `${definition.name} 必须有 output.schema`);
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(output.schema),
      `${definition.name} 的 output.schema 超出子集`,
    );
  }
});

test('真实的保存结果符合它自己的 output schema（值也必须与声明的类型一致）', () => {
  const result: SaveResult = {
    id: 12,
    type: 'architecture',
    project: 'dsh-plugin-gentleai-engram',
    fallback: { reason: 'connection：ECONNREFUSED' },
    candidates: [
      {
        id: 11,
        title: '标题',
        type: 'architecture',
        updated_at: '2026-09-19 13:47:29',
        // 空串是「不共享主题键」的哨兵：schema 只允许一个标量类型，
        // 所以这里不是 null（见 design 的实现缺陷一节）。
        same_topic_key: '',
        same_session: true,
        same_type_and_title: false,
        identical_content: false,
        shared_rare_terms: { count: 2, terms: ['派生索引', '覆盖加成'] },
        semantic_rank: 1,
        corpus_size: 563,
        will_update: false,
      },
      {
        id: 12,
        title: '标题',
        type: 'architecture',
        updated_at: '2026-09-19 13:47:29',
        same_topic_key: 'architecture/engram-bridge-write-layer',
        same_session: false,
        same_type_and_title: true,
        identical_content: true,
        shared_rare_terms: { count: 0, terms: [] },
        semantic_rank: 2,
        corpus_size: 563,
        will_update: true,
      },
    ],
  };
  assert.deepEqual(validateJsonSchemaValue(SAVE_OUTPUT_SCHEMA, result), []);

  // A missing `id` is the "fallback could not report one" case and must also fit.
  const noId: SaveResult = { type: 'manual', project: 'p', candidates: [] };
  assert.deepEqual(validateJsonSchemaValue(SAVE_OUTPUT_SCHEMA, noId), []);
});

test('模拟一次「schema 写错」的回归：类型数组与错误的值都必须被报出来', () => {
  // 真机故障的原形：type 数组超出子集。校验器必须在这里就拦下，而不是等到
  // 宿主启动时把整棵插件树带下去。
  assert.throws(
    () => assertSupportedJsonSchema({ type: 'object', properties: { k: { type: ['string', 'null'] } } }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /single type string/);
      return true;
    },
  );
  assert.throws(
    () => assertSupportedJsonSchema({ type: 'object', properties: { k: { type: 'string', oneOf: [] } } }),
    /unsupported JSON schema/,
    '同时出现 type 与 oneOf 也要被拒',
  );

  // 同一个字段写成 null（本次真机故障的形状）时，校验器必须拒绝——否则这条
  // 守卫就只是装饰。
  const broken = {
    type: 'manual',
    project: 'p',
    candidates: [
      {
        id: 1,
        title: 't',
        type: 'manual',
        updated_at: '',
        same_topic_key: null,
        same_session: false,
        same_type_and_title: false,
        identical_content: false,
        shared_rare_terms: { count: 0, terms: [] },
        semantic_rank: 1,
        corpus_size: 1,
        will_update: false,
      },
    ],
  };
  const violations = validateJsonSchemaValue(SAVE_OUTPUT_SCHEMA, broken);
  assert.ok(violations.length > 0, 'null 必须被拒绝');
  assert.ok(
    violations.some((violation) => violation.includes('same_topic_key')),
    `违规必须指名那个字段：${violations.join('; ')}`,
  );
});

test('工具面声明的 schema 也必须在子集里（它们原样成为注册的 parameters）', () => {
  // The declarations come from the backend; a declaration outside the subset
  // would fail the plugin tree for reasons that have nothing to do with us, so
  // the shared fixture is checked here too.
  for (const declaration of TOOLS as Array<{ name: string; inputSchema?: unknown }>) {
    if (declaration.inputSchema === undefined) continue;
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(declaration.inputSchema),
      `${declaration.name} 的声明超出宿主 schema 子集`,
    );
  }
});
