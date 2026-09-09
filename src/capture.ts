import type { McpCallResult } from './mcp-client.js';
import { hasLearningsSection, parseCaptureCounts, parseEnvelope } from './engram.js';
import { errorMessage, type Logger } from './log.js';

export interface CaptureOptions {
  enabled: boolean;
  log: Logger;
  call(sessionId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
}

/**
 * Turn-final passive capture.
 *
 * The hook is `agent/turn-stopping`, which the runtime does not fire for a turn
 * aborted mid-stream — so aborted turns are skipped by construction. Because a
 * listener that steers earns a second dispatch for the same turn, capture is
 * latched per (session, turn). Extraction and deduplication stay in engram.
 */
export class PassiveCapture {
  readonly #done = new Set<string>();
  readonly #options: CaptureOptions;

  constructor(options: CaptureOptions) {
    this.#options = options;
  }

  async capture(sessionId: string, turn: number, text: string, signal?: AbortSignal): Promise<void> {
    if (!this.#options.enabled || text.trim() === '') return;
    const key = `${sessionId}:${turn}`;
    if (this.#done.has(key)) return;
    this.#done.add(key);
    try {
      const result = await this.#options.call(
        sessionId,
        'mem_capture_passive',
        { content: text, session_id: sessionId, source: 'dsh-turn-stopping' },
        signal,
      );
      const envelope = parseEnvelope(result.content);
      const counts = parseCaptureCounts(envelope.result);
      if (hasLearningsSection(text) && counts.extracted === 0) {
        this.#options.log.warn(
          `turn ${turn} of session ${sessionId} contained a Key Learnings section but engram extracted 0 items`,
        );
      }
    } catch (error) {
      // Memory bookkeeping never changes the user-visible reply.
      this.#options.log.warn(`passive capture failed for session ${sessionId}: ${errorMessage(error)}`);
    }
  }
}
