import { extractText, type McpContentBlock } from '../mcp-client.js';

/**
 * Reading the fallback path's answer.
 *
 * The upstream save tool replies with a plain-text JSON envelope
 * (`{project, project_source, result, id, sync_id, state, ...}` plus, when its
 * own candidate scan found something, `judgment_required` and a `candidates`
 * array whose entries carry `judgment_id`s). Two things follow, and both are
 * load-bearing:
 *
 *  * the canonical "what did this save write" value is only reachable by
 *    parsing that envelope — there is no structured field on the wire;
 *  * the upstream candidates and their judgment ids must be DROPPED. Relaying
 *    them would let the very thing this change removes leak back to the model
 *    through the fallback (design D1/D8). They are counted here so the log can
 *    record the fact; they are never rendered.
 */
export interface FallbackOutcome {
  /** The id the backend reported for the observation it wrote or updated. */
  id?: number;
  /** How many candidates the upstream scan returned; for the log only. */
  upstreamCandidates: number;
  /** Whether the upstream envelope said a judgment is pending; for the log only. */
  upstreamJudgmentPending: boolean;
  /** The upstream message text, retained for the log. */
  resultText: string;
}

export function parseFallbackOutcome(content: readonly McpContentBlock[] | undefined): FallbackOutcome {
  const text = extractText(content);
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  const id = typeof parsed?.id === 'number' && Number.isFinite(parsed.id) ? parsed.id : undefined;
  const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0;
  const outcome: FallbackOutcome = {
    upstreamCandidates: candidates,
    upstreamJudgmentPending: parsed?.judgment_required === true,
    resultText: typeof parsed?.result === 'string' ? parsed.result : text,
  };
  if (id !== undefined) outcome.id = id;
  return outcome;
}
