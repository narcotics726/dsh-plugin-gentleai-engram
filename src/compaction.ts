import type { McpCallResult } from './mcp-client.js';
import { parseEnvelope, truncateToTokenBudget } from './engram.js';
import { errorMessage, type Logger } from './log.js';

/**
 * Where a post-compaction recall is queued.
 *
 * `next-step` is right for a compaction owned by a running turn; `next-turn` is the only safe
 * boundary for a standalone manual compaction, because the step queue is torn down as that
 * transaction converges and the queued recall is discarded unrun.
 */
export type RecallTarget = 'next-turn' | 'next-step';

export interface CompactionOptions {
  enabled: boolean;
  tokenBudget: number;
  log: Logger;
  /** Project of the session, used for the recall query. */
  resolveProject(sessionId: string): string | undefined;
  call(sessionId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  /** Model-visible recall delivery seam (the host wires `agent.send`). */
  deliver(sessionId: string, text: string, target: RecallTarget): void;
}

/**
 * Compaction is invisible on the agent plane: it never restarts the session and
 * emits only `session/event compaction/*`. The summary event carries the
 * summary content itself, so the bridge persists it verbatim instead of
 * generating one; recall is injected after `compaction/end` releases the lock.
 */
export class CompactionRecovery {
  readonly #summarized = new Set<string>();
  readonly #injected = new Set<string>();
  readonly #options: CompactionOptions;

  constructor(options: CompactionOptions) {
    this.#options = options;
  }

  async onSummary(
    sessionId: string,
    compactionId: string,
    summaryText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#options.enabled || this.#summarized.has(compactionId)) return;
    this.#summarized.add(compactionId);
    if (summaryText.trim() === '') {
      // An empty summary is a legal payload, but silence would be indistinguishable from a
      // broken read: the id is in the log so the two causes stay separable after the fact.
      this.#options.log.warn(
        `compaction ${compactionId} of session ${sessionId} carries an empty summary; nothing was persisted`,
      );
      return;
    }
    try {
      await this.#options.call(
        sessionId,
        'mem_session_summary',
        { content: summaryText, session_id: sessionId, capture_prompt: false },
        signal,
      );
    } catch (error) {
      this.#options.log.warn(`compaction summary persist failed for session ${sessionId}: ${errorMessage(error)}`);
    }
  }

  async onEnd(
    sessionId: string,
    compactionId: string,
    failed: boolean,
    turn: number | null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#options.enabled || failed || this.#injected.has(compactionId)) return;
    this.#injected.add(compactionId);
    const project = this.#options.resolveProject(sessionId);
    try {
      const args: Record<string, unknown> = { limit: 20 };
      if (project !== undefined) args.project = project;
      const result = await this.#options.call(sessionId, 'mem_context', args, signal);
      const envelope = parseEnvelope(result.content);
      const text = truncateToTokenBudget(envelope.result, this.#options.tokenBudget);
      if (text.trim() === '') return;
      // `turn === null` is the host's own marker for a standalone transaction between turns:
      // its step inbox is discarded when the transaction converges (measured on a manual
      // `/compact`, where the queued recall came back with `outcome: 'canceled'` at once).
      this.#options.deliver(sessionId, text, turn === null ? 'next-turn' : 'next-step');
    } catch (error) {
      this.#options.log.warn(`post-compaction recall failed for session ${sessionId}: ${errorMessage(error)}`);
    }
  }
}
