import type { McpCallResult } from './mcp-client.js';
import { parseEnvelope, truncateToTokenBudget } from './engram.js';
import { errorMessage, type Logger } from './log.js';

/**
 * Where a post-compaction recall is delivered.
 *
 * The bridge uses `next-step` for both compaction owners: a running turn claims the step queue at
 * its next boundary, and an idle driver is woken to open a turn of its own. This is a delivery
 * preference, not a contract - the host reclassifies the boundary itself when the phase is
 * already aborted, and parks waking input when the agent is disposed.
 */
export type RecallTarget = 'next-turn' | 'next-step';

/**
 * Framing prepended to the recall so the injected message explains itself.
 *
 * The turn carrying it may or may not already carry user input - waking races the user's next
 * message, and the host merges both into one turn when the user wins that race - so the
 * instruction is conditional rather than assuming an empty turn.
 */
const RECALL_FRAME = [
  '[engram post-compaction self-recovery] The context was just compacted, and the bridge injected',
  'the memory recall below so you can re-orient. If this turn carries no other user input, reply',
  'with one short sentence stating what you recovered and any obvious gap, and do not start new',
  'work. If this turn carries user input, answer it and treat the recall as background.',
].join(' ');

export interface CompactionOptions {
  enabled: boolean;
  tokenBudget: number;
  log: Logger;
  /** Project of the session, used for the recall query. */
  resolveProject(sessionId: string): string | undefined;
  call(sessionId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  /** Whether a standalone compaction wakes the driver to open its own self-recovery turn. */
  recallWakeup: boolean;
  /** Model-visible recall delivery seam (the host wires `agent.send`). */
  deliver(sessionId: string, text: string, target: RecallTarget, wakeup: boolean): void;
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
      if (envelope.result.trim() === '') return;
      // Reserve the framing's share of the budget: a recall that cannot explain what it is would
      // be worse than a shorter one, so the framing is never the part that gets truncated away.
      const recallBudget = Math.max(0, this.#options.tokenBudget - Math.ceil(RECALL_FRAME.length / 4));
      const text = `${RECALL_FRAME}\n\n${truncateToTokenBudget(envelope.result, recallBudget)}`;
      // `turn === null` is the host's marker for a standalone transaction between turns. Nothing
      // is running that could claim the recall, so the driver has to be woken for it. A run-owned
      // compaction is claimed by its own turn at the next step boundary instead - waking there
      // would open a second, empty turn.
      const wakeup = turn === null && this.#options.recallWakeup;
      this.#options.deliver(sessionId, text, 'next-step', wakeup);
    } catch (error) {
      this.#options.log.warn(`post-compaction recall failed for session ${sessionId}: ${errorMessage(error)}`);
    }
  }
}
