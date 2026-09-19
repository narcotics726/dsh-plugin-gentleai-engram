import type { CandidateQuery } from '../recall/protocol.js';

/**
 * Normalisation of a save's arguments, shared by BOTH write paths.
 *
 * This module exists because of one measured property of the backend: the
 * de-duplication key includes `type`, and the two write paths do not normalise
 * alike. The MCP save handler defaults a missing `type` to `manual` and maps the
 * legacy `observation` alias onto `content`; the HTTP write surface does neither.
 * If the bridge normalised on one path only, the same call would write two
 * different observations when a timeout falls back — so normalisation happens
 * HERE, before either path, and both paths emit byte-identical fields
 * (design D1).
 */

/**
 * The value written to `observations.tool_name` on every save that goes through
 * the bridge's own HTTP write surface.
 *
 * Three things are deliberate:
 *
 *  * it is a CONSTANT and does not change — renaming it would split the audit
 *    history in two;
 *  * it is MODEL-VISIBLE: `mem_get_observation` renders `Tool: <tool_name>`, and
 *    the protocol tells the model to read a candidate's full text before judging
 *    it. It is a provenance fact, not a private channel;
 *  * the column is shared with passive capture, which writes
 *    `dsh-turn-stopping` there (see `src/capture.ts`), so a value alone never
 *    proves which path wrote a row: `NULL` also covers a row some other client
 *    wrote, and a response timeout can leave the mark on a row that fell back.
 *    The authoritative attribution is the result text plus the log (design D8).
 */
export const SAVE_SOURCE_MARK = 'dsh-engram-bridge';

/** Raised when the arguments cannot name an observation at all. */
export class SaveInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveInputError';
  }
}

export interface SaveParams {
  title: string;
  content: string;
  /** Never empty: a missing `type` is the backend's own `manual` default. */
  type: string;
  scope: string;
  topicKey: string;
}

/**
 * The single normalisation, applied once per call and reused by both paths.
 *
 * The rules are copied from the MCP handler on purpose (they are the backend's
 * behaviour, not a design of ours), including the detail that `observation` is
 * only consulted when `content` is blank and that content is only TRIMMED for
 * the emptiness check — the value that gets written is the one the caller sent.
 */
export function normalizeSaveParams(raw: Record<string, unknown>): SaveParams {
  const title = typeof raw.title === 'string' ? raw.title : '';
  let content = typeof raw.content === 'string' ? raw.content : '';
  if (content.trim() === '') {
    const alias = typeof raw.observation === 'string' ? raw.observation : '';
    if (alias.trim() !== '') content = alias;
  }
  if (content.trim() === '') {
    throw new SaveInputError(
      'engram-bridge: 保存需要 content（或用兼容别名的 observation）；两者都为空，本次没有写入任何记忆。',
    );
  }
  if (title.trim() === '') {
    throw new SaveInputError('engram-bridge: 保存需要 title；本次没有写入任何记忆。');
  }
  const type = typeof raw.type === 'string' && raw.type !== '' ? raw.type : 'manual';
  const scope = typeof raw.scope === 'string' ? raw.scope : '';
  const topicKey = typeof raw.topic_key === 'string' ? raw.topic_key : '';
  return { title, content, type, scope, topicKey };
}

/** Identity of the write: which session, which project. Filled by injection. */
export interface SaveTarget {
  sessionId: string;
  project: string;
}

/**
 * The body of `POST /observations` (upstream `AddObservationParams`), plus the
 * source mark the MCP path cannot carry: its save tool takes no `tool_name`.
 */
export function toWriteBody(
  params: SaveParams,
  target: SaveTarget,
): Record<string, unknown> {
  return {
    session_id: target.sessionId,
    type: params.type,
    title: params.title,
    content: params.content,
    project: target.project,
    scope: params.scope,
    topic_key: params.topicKey,
    tool_name: SAVE_SOURCE_MARK,
  };
}

/**
 * The arguments for the FALLBACK call to the upstream save tool.
 *
 * Derived from the same normalised struct, so the two paths cannot disagree
 * about what is being written; `session_id` / `project` were already injected by
 * the caller (the upstream tool declares both).
 */
export function toFallbackArgs(
  params: SaveParams,
  target: SaveTarget,
): Record<string, unknown> {
  return {
    session_id: target.sessionId,
    type: params.type,
    title: params.title,
    content: params.content,
    project: target.project,
    scope: params.scope,
    topic_key: params.topicKey,
  };
}

/** The candidate query for a save: the text about to be written, plus its identity. */
export function toCandidateQuery(
  params: SaveParams,
  target: SaveTarget,
  limit: number,
): CandidateQuery {
  return {
    title: params.title,
    content: params.content,
    type: params.type,
    topicKey: params.topicKey,
    sessionId: target.sessionId,
    project: target.project,
    limit,
  };
}
