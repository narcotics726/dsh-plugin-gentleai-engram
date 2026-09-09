import type { McpCallResult } from './mcp-client.js';
import { parseEnvelope, truncateToTokenBudget } from './engram.js';
import { errorMessage, type Logger } from './log.js';

export interface CompactionOptions {
  enabled: boolean;
  tokenBudget: number;
  log: Logger;
  /** Project of the session, used for the recall query. */
  resolveProject(sessionId: string): string | undefined;
  call(sessionId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  /** Model-visible recall injection seam (the host wires `agent.inject`). */
  inject(sessionId: string, text: string): void;
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
    if (summaryText.trim() === '') return;
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
      this.#options.inject(sessionId, text);
    } catch (error) {
      this.#options.log.warn(`post-compaction recall failed for session ${sessionId}: ${errorMessage(error)}`);
    }
  }
}
