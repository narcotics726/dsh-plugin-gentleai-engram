import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { TOOL_PREFIX } from './subagent.js';
import type { RecallPayload, RecallQuery } from './recall/protocol.js';

/**
 * The plugin's own retrieval tool.
 *
 * It keeps the `mcp__engram__` prefix so it is grouped with the rest of the
 * memory tools and inherits the same sub-agent visibility restriction, but it is
 * a plugin-owned definition — it does NOT impersonate an engram declaration
 * (design D1/D2). Its canonical value is its own shape, not a fake MCP result,
 * so the session log can tell a local derived-index retrieval apart from a call
 * that went to the engram backend.
 */

export const RECALL_TOOL_NAME = `${TOOL_PREFIX}mem_bridge_recall`;

/**
 * The model-facing explicit entry. It is a SEPARATE tool, not a parameter on
 * retrieval, because the wait it may spend is a decision the caller has to make
 * knowingly: retrieval stays fast or refuses, and this tool is where "I am
 * willing to wait minutes" becomes a distinct, describable action (design D7).
 */
export const RECALL_SYNC_TOOL_NAME = `${TOOL_PREFIX}mem_bridge_recall_sync`;

/**
 * THE single declaration of the return-count default. It appears in this tool's
 * input schema and nowhere else — config deliberately offers no second default
 * for it (design D6/D9), so a test can read it out of the schema.
 */
export const DEFAULT_RECALL_LIMIT = 10;

export const RECALL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '检索串（单个字符串）。中文按 bigram 词法 + 语义向量混合打分。',
    },
    limit: {
      type: 'number',
      default: DEFAULT_RECALL_LIMIT,
      description: `返回条数上限（默认 ${DEFAULT_RECALL_LIMIT}）。被截断时结果会说明还有未显示的条目。`,
    },
    project: {
      type: 'string',
      description: '项目名。省略时使用当前会话解析出的项目；未要求跨项目时只返回该项目的记忆。',
    },
    all_projects: {
      type: 'boolean',
      description: '显式要求跨项目检索（默认 false）。为 true 时不按项目过滤。',
    },
    type: {
      type: 'string',
      description:
        '按类型过滤。取值不做枚举：传一个不存在的取值时结果会列出实际存在的取值。',
    },
    scope: {
      type: 'string',
      description: '按范围过滤（project / personal）。省略时两种范围都可以出现。',
    },
    match_mode: {
      type: 'string',
      description:
        '已忽略（保留仅为兼容历史调用）。本检索不是 FTS 的 AND/OR：词法候选不设阈值，语义分数始终参与。',
    },
  },
  required: ['query'],
};

/** Canonical output contract: the read layer's own value, not `content[]`. */
export const RECALL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    hits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          type: { type: 'string' },
          project: { type: 'string' },
          scope: { type: 'string' },
          score: { type: 'number' },
          excerpt: { type: 'string' },
        },
        required: ['id', 'title', 'type', 'project', 'scope', 'score', 'excerpt'],
      },
    },
    limit: { type: 'number' },
    truncated: { type: 'boolean' },
    filteredOut: { type: 'number' },
    poolSize: { type: 'number' },
    candidates: { type: 'number' },
    availableTypes: { type: 'array', items: { type: 'string' } },
    metering: { type: 'object' },
  },
  required: ['hits', 'limit', 'truncated', 'availableTypes'],
  additionalProperties: false,
};

/**
 * Render the canonical value for the model.
 *
 * Wording constraint (design D3): the coverage pool is hard-capped, so the text
 * must never say "共 N 条候选" — that would read as the size of the corpus. The
 * only thing that carries information is whether something is not shown, and the
 * truncation decision (made in the engine) is exact: "exactly `limit` matches"
 * does not produce the line at all.
 */
export function renderRecall(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const payload = value as RecallPayload | undefined;
  if (payload === undefined || !Array.isArray(payload.hits)) {
    return [{ type: 'text', text: '检索未返回结果。' }];
  }
  const lines: string[] = [];
  payload.hits.forEach((hit, index) => {
    lines.push(
      `[${index + 1}] #${hit.id} 得分 ${hit.score.toFixed(4)} 类型 ${hit.type || '(空)'} ` +
        `项目 ${hit.project || '(空)'} 范围 ${hit.scope || '(空)'}`,
    );
    if (hit.title !== '') lines.push(`标题：${hit.title}`);
    lines.push(hit.excerpt === '' ? '摘要：（空）' : `摘要：${hit.excerpt}`);
  });

  if (payload.hits.length === 0) {
    lines.push('没有匹配的记忆条目。');
    if (payload.availableTypes.length > 0) {
      lines.push(`该维度上实际存在的类型取值：${payload.availableTypes.join(' / ')}`);
    }
  } else if (payload.truncated) {
    lines.push(
      `还有未显示的匹配项：本次只返回了前 ${payload.hits.length} 条。提高 limit 可以看到更多。`,
    );
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

export interface RecallToolDeps {
  /** Host-side budget; must exceed the worker's own per-call budget. */
  timeoutMs: number;
  /**
   * The tool's `project` parameter is declared in `RECALL_INPUT_SCHEMA` above, so
   * generic injection fills it and an explicit caller value wins.
   */
  run: (request: RecallQuery, exec: { agent?: unknown; signal?: AbortSignal }) => Promise<RecallPayload>;
}

/** Normalise raw tool arguments into a request. The only place `limit` is defaulted. */
export function toRecallQuery(raw: Record<string, unknown>): RecallQuery {
  const request: RecallQuery = {
    query: String(raw.query ?? ''),
    limit: normaliseLimit(raw.limit),
  };
  if (typeof raw.project === 'string' && raw.project !== '') request.project = raw.project;
  if (raw.all_projects === true) request.allProjects = true;
  if (typeof raw.type === 'string' && raw.type !== '') request.type = raw.type;
  if (typeof raw.scope === 'string' && raw.scope !== '') request.scope = raw.scope;
  return request;
}

export function buildRecallToolDefinition(deps: RecallToolDeps): ToolDefinition {
  return {
    name: RECALL_TOOL_NAME,
    description:
      '检索记忆（本地只读派生索引：CJK bigram 词法覆盖 + 语义向量）。' +
      '只读、不写记忆；未要求跨项目时只返回当前项目的条目；结果被截断时会说明。',
    parameters: RECALL_INPUT_SCHEMA,
    timeoutMs: deps.timeoutMs,
    output: {
      schema: RECALL_OUTPUT_SCHEMA,
      render: renderRecall,
    },
    execute: async (args: unknown, exec): Promise<unknown> =>
      await deps.run(toRecallQuery((args ?? {}) as Record<string, unknown>), exec),
  };
}

function normaliseLimit(value: unknown): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_RECALL_LIMIT;
  return Math.min(100, Math.max(1, limit));
}

/** No parameters: the caller's only decision is whether to wait at all. */
export const RECALL_SYNC_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  required: [],
};

export const RECALL_SYNC_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

export interface RecallSyncToolDeps {
  /**
   * The tool's own declared budget. Every tool carries a static timeout, and
   * this one is the number the capacity derivation uses — nothing else.
   */
  timeoutMs: number;
  run: (exec: { agent?: unknown; signal?: AbortSignal }) => Promise<string>;
}

export function buildRecallSyncToolDefinition(deps: RecallSyncToolDeps): ToolDefinition {
  return {
    name: RECALL_SYNC_TOOL_NAME,
    description:
      '把记忆检索的派生索引追到最新（一次调用完成，可能耗时数分钟）。' +
      '只在检索明确告知"待处理量超出自动上限"、且调用方愿意等时使用：' +
      '调用前请先告知用户将要等待，完成后重新发起原来的检索。',
    parameters: RECALL_SYNC_INPUT_SCHEMA,
    timeoutMs: deps.timeoutMs,
    output: {
      schema: RECALL_SYNC_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: (value as { summary?: string } | undefined)?.summary ?? '派生索引已追到最新。' },
      ],
    },
    execute: async (_args: unknown, exec: { agent?: unknown; signal?: AbortSignal }): Promise<unknown> => ({
      summary: await deps.run(exec),
    }),
  };
}
