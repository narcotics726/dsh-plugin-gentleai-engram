import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { WriteLayerConfig } from './config.js';
import type { CandidateEvidence } from './recall/protocol.js';
import { TOOL_PREFIX } from './subagent.js';

/**
 * The plugin's own save entry point.
 *
 * It shares the `mcp__engram__` prefix so it is grouped with the rest of the
 * memory tools and inherits the same sub-agent visibility restriction, but it is
 * a plugin-owned definition: it does NOT impersonate an engram declaration, and
 * its canonical value is its own shape rather than a fake MCP result. The
 * upstream write tool is deliberately unregistered (`src/tools.ts`).
 */

export const SAVE_TOOL_NAME = `${TOOL_PREFIX}mem_bridge_save`;

/** The engram-declared tool this entry point replaces. */
export const REPLACED_SAVE_TOOL = 'mem_save';

/**
 * The how-many-candidates key (M). Its default lives in the config schema; this
 * module only reads it.
 */
export const SAVE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: '短、可检索的标题（动词 + 对象）。',
    },
    content: {
      type: 'string',
      description: '要保存的正文。省略时可用兼容别名 observation。',
    },
    observation: {
      type: 'string',
      description: 'content 的兼容别名；仅在 content 为空时使用。',
    },
    type: {
      type: 'string',
      description:
        '类别（decision / architecture / bugfix / pattern / config / discovery / learning …）。省略时用后端的默认值 manual。',
    },
    scope: {
      type: 'string',
      description: '范围：project（默认）或 personal。',
    },
    topic_key: {
      type: 'string',
      description: '演进中主题的稳定键：给同一个键会更新既有那条，而不是新增。',
    },
    session_id: {
      type: 'string',
      description:
        '会话标识。正常不要传：插件按当前 dsh 会话注入（与其它 engram 工具同一套规则）；显式传值优先。',
    },
    project: {
      type: 'string',
      description:
        '项目名。正常不要传：插件按当前会话解析出的项目注入；显式传值优先，但与会话在后端记录的项目不一致时写入会被后端拒绝。',
    },
  },
  required: ['title'],
};

/** One candidate as the model sees it: the evidence struct plus the post-write mark. */
export interface SaveResultCandidate extends CandidateEvidence {
  /**
   * True when the id the backend returned for THIS write is this candidate's id,
   * i.e. the write updated an existing memory instead of creating one. Decided
   * after the write by comparing ids — the ordering of AUTOINCREMENT ids makes
   * that comparison incapable of a false positive (design D3).
   */
  will_update: boolean;
}

/** The canonical value of one save. The model sees `renderSave`'s projection of it. */
export interface SaveResult {
  /** The observation this save wrote or updated. */
  id?: number;
  type: string;
  project: string;
  /** Present only when the save went through the fallback write path. */
  fallback?: { reason: string };
  candidates: SaveResultCandidate[];
}

export const SAVE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'number' },
    type: { type: 'string' },
    project: { type: 'string' },
    fallback: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          type: { type: 'string' },
          updated_at: { type: 'string' },
          // One scalar type: the host's enforced subset rejects type arrays, and a
          // rejected schema fails the ENTIRE plugin tree at load. "No shared topic
          // key" is the empty string.
          same_topic_key: { type: 'string' },
          same_session: { type: 'boolean' },
          same_type_and_title: { type: 'boolean' },
          identical_content: { type: 'boolean' },
          shared_rare_terms: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              terms: { type: 'array', items: { type: 'string' } },
            },
            required: ['count', 'terms'],
            additionalProperties: false,
          },
          semantic_rank: { type: 'number' },
          corpus_size: { type: 'number' },
          will_update: { type: 'boolean' },
        },
        required: [
          'id',
          'title',
          'type',
          'updated_at',
          'same_topic_key',
          'same_session',
          'same_type_and_title',
          'identical_content',
          'shared_rare_terms',
          'semantic_rank',
          'corpus_size',
          'will_update',
        ],
      },
    },
  },
  required: ['type', 'project', 'candidates'],
};

/**
 * The action reminder, appended ONLY when there are candidates.
 *
 * It is a constant, and it only ever talks about ACTIONS: read the full text
 * before judging; if unsure, do not record; if you need to ask the user, ask in
 * THIS reply and quote both ids. It states no conclusion about the relation and
 * does not restate the judging rules — those live in exactly one place, the
 * skill body (§4), and a second copy here would be a second truth (design D12b).
 *
 * The "ask in this reply" phrasing is load-bearing: candidates do not outlive
 * the turn, so "ask later" would silently lose the window, and the question has
 * to carry BOTH ids or the reply cannot construct a direction-correct relation.
 */
export const SAVE_REMINDER =
  '以上候选需要你裁决：下判前先读候选全文；没把握就别记录。\n' +
  '要问使用者，就在本次回复里问，并把这行里「本次保存的标识」与「候选的标识」都写进问题——候选不会重发。';

/**
 * The save tool's static timeout, derived from the WORST path.
 *
 * The host's tool-call timeout policy is the enforcer, and it reads this number
 * off the definition; it also replaces an already-settled result with a timeout
 * error when its own timer wins. So the number has to cover the whole worst case
 * up front — it cannot be rescued by "let the work finish anyway" (design D13):
 *
 *   candidates (own budget) + write (own timeout) + fallback (its own budget) + margin
 *
 * The margin covers session binding, injection, the process round-trips and
 * rendering. The fallback term is the one that was missing from the first
 * version of this derivation: the MCP client's per-request timeout is a property
 * of the connection (`toolCallTimeoutMs`, 60 s by default), so leaving it out
 * would put a fraction of a minute outside the static cap.
 */
export const SAVE_TIMEOUT_MARGIN_MS = 5000;

export function saveToolTimeoutMs(config: SaveLayerConfig): number {
  return (
    config.saveCandidateBudgetMs + config.writeTimeoutMs + config.saveFallbackBudgetMs + SAVE_TIMEOUT_MARGIN_MS
  );
}

/** The three budgets the derivation needs. */
export type SaveLayerConfig = Pick<
  WriteLayerConfig,
  'saveCandidateBudgetMs' | 'writeTimeoutMs' | 'saveFallbackBudgetMs'
>;

export interface SaveToolDeps {
  timeoutMs: number;
  run: (args: Record<string, unknown>, exec: { agent?: unknown; signal?: AbortSignal }) => Promise<SaveResult>;
}

export function buildSaveToolDefinition(deps: SaveToolDeps): ToolDefinition {
  return {
    name: SAVE_TOOL_NAME,
    description:
      '保存记忆到 engram（本插件自有的写入面：写入后返回本次落库的标识，' +
      '并在需要时附上同一项目内相似条目的机械证据供你裁决）。' +
      '候选只在那一次保存的结果里有效，不会重发。',
    parameters: SAVE_INPUT_SCHEMA,
    timeoutMs: deps.timeoutMs,
    output: {
      schema: SAVE_OUTPUT_SCHEMA,
      render: renderSave,
    },
    execute: async (args: unknown, exec): Promise<unknown> =>
      await deps.run((args ?? {}) as Record<string, unknown>, exec),
  };
}

/**
 * Project the canonical value into the model-visible text.
 *
 * Rules the wording obeys, each with a test: the two ids are distinguishable
 * (which one is this save, which one is a candidate); no internal ranking score
 * ever appears, only the mechanical rank; every number is traceable to a
 * concrete thing (shared terms are spelled out); no evidence line names a
 * verdict; the reminder appears if and only if there are candidates.
 */
export function renderSave(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const result = value as SaveResult | undefined;
  if (result === undefined || typeof result !== 'object') {
    return [{ type: 'text', text: '保存没有返回结果。' }];
  }
  const lines: string[] = [];
  lines.push(
    result.id === undefined
      ? `已保存（本次落库的标识未知）类型 ${result.type || '(空)'}`
      : `已保存 #${result.id}（本次保存的标识）类型 ${result.type || '(空)'}`,
  );
  if (result.fallback !== undefined) {
    lines.push(
      `本次走了回退路径：本地写入面不可达（${result.fallback.reason}）。` +
        '上游返回的候选与判定标识不在此转述。',
    );
  }
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  if (candidates.length === 0) {
    lines.push('本次没有给出候选。');
    return [{ type: 'text', text: lines.join('\n') }];
  }
  lines.push('以下是与本次内容相似的既有条目（候选）：');
  candidates.forEach((candidate, index) => {
    lines.push(
      `[${index + 1}] 候选 #${candidate.id} 类型 ${candidate.type || '(空)'} 更新于 ${candidate.updated_at || '(未知)'}`,
    );
    if (candidate.title !== '') lines.push(`    标题：${candidate.title}`);
    lines.push(`    语义名次：第 ${candidate.semantic_rank} 名（共 ${candidate.corpus_size} 条）`);
    const terms = candidate.shared_rare_terms?.terms ?? [];
    lines.push(
      terms.length === 0
        ? '    共享稀有词 0 个'
        : `    共享稀有词 ${candidate.shared_rare_terms.count} 个：${terms.join(' / ')}`,
    );
    if (candidate.same_topic_key !== '') lines.push(`    同一个主题键：${candidate.same_topic_key}`);
    if (candidate.same_session) lines.push('    同一次会话');
    if (candidate.same_type_and_title) lines.push('    同类型且标题相同');
    if (candidate.identical_content) lines.push('    内容完全相同');
    if (candidate.will_update) lines.push('    本次将更新它');
  });
  if (candidates.some((candidate) => candidate.will_update)) {
    lines.push(
      '注意：本次写入落在既有条目上（上面的「本次将更新它」），本次保存的标识与那条候选是同一个，' +
        '因此这一对不构成可写的关系。',
    );
  }
  lines.push(SAVE_REMINDER);
  return [{ type: 'text', text: lines.join('\n') }];
}
