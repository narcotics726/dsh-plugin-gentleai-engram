import type { McpCallResult } from './mcp-client.js';
import { parseEnvelope } from './engram.js';
import { errorMessage, type Logger } from './log.js';
import type { ConnectionPool } from './pool.js';

export interface Binding {
  sessionId: string;
  workspace: string;
  /** Project engram resolved for this session; undefined when resolution failed. */
  project?: string;
  projectSource?: string;
}

export interface BindingsOptions {
  pool: ConnectionPool;
  log: Logger;
  /** Injected for tests: call one engram tool on a live connection. */
  call(workspace: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
}

/**
 * One engram session per dsh session, keyed by the dsh session id.
 *
 * Binding is a barrier, not a fire-and-forget: every engram tool call awaits
 * `ensure` first, because engram hard-fails writes that name an unknown
 * `session_id` (`unknown_session`). A failed binding is not cached, so a
 * transient failure can recover on the next call.
 */
export class SessionBindings {
  readonly #inflight = new Map<string, Promise<Binding>>();
  readonly #bound = new Map<string, Binding>();
  readonly #options: BindingsOptions;

  constructor(options: BindingsOptions) {
    this.#options = options;
  }

  peek(sessionId: string): Binding | undefined {
    return this.#bound.get(sessionId);
  }

  ensure(sessionId: string, workspace: string): Promise<Binding> {
    const bound = this.#bound.get(sessionId);
    if (bound !== undefined && bound.workspace === workspace) return Promise.resolve(bound);
    const inflight = this.#inflight.get(sessionId);
    if (inflight !== undefined) return inflight;
    const pending = this.#bind(sessionId, workspace);
    this.#inflight.set(sessionId, pending);
    return pending;
  }

  dispose(): void {
    this.#inflight.clear();
    this.#bound.clear();
  }

  async #bind(sessionId: string, workspace: string): Promise<Binding> {
    try {
      const result = await this.#options.call(workspace, 'mem_session_start', {
        id: sessionId,
        directory: workspace,
      });
      const envelope = parseEnvelope(result.content);
      const binding: Binding = {
        sessionId,
        workspace,
        project: envelope.project,
        projectSource: envelope.projectSource,
      };
      this.#bound.set(sessionId, binding);
      this.#options.log.debug(
        `bound dsh session ${sessionId} to engram project ${binding.project ?? '?'} (${binding.projectSource ?? '?'})`,
      );
      return binding;
    } catch (error) {
      this.#options.log.warn(`failed to bind engram session ${sessionId}: ${errorMessage(error)}`);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      this.#inflight.delete(sessionId);
    }
  }
}
