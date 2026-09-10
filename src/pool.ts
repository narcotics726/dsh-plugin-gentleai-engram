import type { McpClient, McpToolDeclaration } from './mcp-client.js';
import { errorMessage, type Logger } from './log.js';

export interface PoolEntry {
  readonly workspace: string;
  readonly client: McpClient;
  readonly tools: readonly McpToolDeclaration[];
  /** Idle clock: refreshed on acquire and on every settlement. */
  lastUsed: number;
  /** Calls not yet settled; a busy connection is never reclaimed as idle. */
  inFlight: number;
}

export interface PoolOptions {
  /** Establish one connection whose child cwd is the workspace. */
  connect(workspace: string): Promise<McpClient>;
  maxConnections: number;
  maxIdleMs: number;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts per workspace, including the first. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * One engram child process per session workspace, created lazily.
 *
 * Why per workspace and not one global process: `mem_capture_passive` and
 * `mem_session_end` resolve their project from the child's cwd and accept no
 * project argument, so a single process can only ever serve one workspace
 * correctly. Spawns are serialized because concurrent starts against the same
 * SQLite file can fail transiently with `database is locked`.
 */
export class ConnectionPool {
  readonly #entries = new Map<string, PoolEntry>();
  readonly #inflight = new Map<string, Promise<PoolEntry>>();
  #chain: Promise<unknown> = Promise.resolve();
  #disposed = false;
  readonly #options: Required<Pick<PoolOptions, 'maxConnections' | 'maxIdleMs' | 'maxAttempts' | 'retryDelayMs'>>;
  readonly #connect: (workspace: string) => Promise<McpClient>;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: PoolOptions) {
    this.#connect = options.connect;
    this.#log = options.log;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#options = {
      maxConnections: Math.max(1, options.maxConnections),
      maxIdleMs: Math.max(0, options.maxIdleMs),
      maxAttempts: Math.max(1, options.maxAttempts ?? 2),
      retryDelayMs: Math.max(0, options.retryDelayMs ?? 250),
    };
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The live entry for a workspace, if any (no spawn). */
  peek(workspace: string): PoolEntry | undefined {
    return this.#entries.get(workspace);
  }

  /**
   * Run one call on the workspace's connection.
   *
   * The connection is never handed out: the pool owns the in-flight count, so a connection
   * cannot be "acquired but forgotten" and a settlement always restarts its idle clock.
   */
  async withConnection<T>(workspace: string, work: (entry: PoolEntry) => Promise<T>): Promise<T> {
    const entry = await this.#acquire(workspace);
    entry.inFlight += 1;
    try {
      return await work(entry);
    } finally {
      entry.inFlight -= 1;
      entry.lastUsed = this.#now();
    }
  }

  /** Resolve a connection for the workspace, spawning at most one at a time. */
  async #acquire(workspace: string): Promise<PoolEntry> {
    if (this.#disposed) throw new Error('engram-bridge: connection pool is disposed');
    const existing = this.#entries.get(workspace);
    if (existing !== undefined) {
      existing.lastUsed = this.#now();
      return existing;
    }
    const inflight = this.#inflight.get(workspace);
    if (inflight !== undefined) return await inflight;
    const pending = this.#serialized(() => this.#connectWithRetry(workspace));
    this.#inflight.set(workspace, pending);
    try {
      return await pending;
    } finally {
      this.#inflight.delete(workspace);
    }
  }

  /**
   * Close every entry idle for longer than `maxIdleMs`; returns the closed workspaces.
   * A connection with calls in flight is never reclaimed as idle.
   */
  sweep(): string[] {
    if (this.#options.maxIdleMs <= 0) return [];
    const deadline = this.#now() - this.#options.maxIdleMs;
    const closed: string[] = [];
    for (const entry of [...this.#entries.values()]) {
      if (entry.inFlight > 0) continue;
      if (entry.lastUsed <= deadline) {
        this.#close(entry.workspace, 'idle timeout');
        closed.push(entry.workspace);
      }
    }
    return closed;
  }

  /**
   * Run work that spawns an engram child outside the pool under the same
   * serialization as pool spawns. Concurrent starts against one SQLite file can
   * fail transiently with `database is locked` (observed), so a load-time
   * discovery must not race the first workspace connection.
   */
  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.#serialized(work);
  }

  /** Close every connection and refuse further acquisitions. */
  dispose(): void {
    this.#disposed = true;
    for (const entry of [...this.#entries.values()]) this.#close(entry.workspace, 'plugin unloaded');
    this.#entries.clear();
    this.#inflight.clear();
  }

  async #connectWithRetry(workspace: string): Promise<PoolEntry> {
    const { maxAttempts, retryDelayMs } = this.#options;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.#disposed) throw new Error('engram-bridge: connection pool is disposed');
      try {
        const client = await this.#connect(workspace);
        const entry: PoolEntry = { workspace, client, tools: client.tools, lastUsed: this.#now(), inFlight: 0 };
        this.#entries.set(workspace, entry);
        this.#evictOverLimit(workspace);
        return entry;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          this.#log.debug(
            `connect to engram failed for ${workspace} (attempt ${attempt}/${maxAttempts}): ${errorMessage(error)}; retrying`,
          );
          await this.#sleep(retryDelayMs);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  #evictOverLimit(keep: string): void {
    while (this.#entries.size > this.#options.maxConnections) {
      let victim: PoolEntry | undefined;
      for (const entry of this.#entries.values()) {
        if (entry.workspace === keep) continue;
        if (victim === undefined || entry.lastUsed < victim.lastUsed) victim = entry;
      }
      if (victim === undefined) return;
      // The cap is a hard limit: a busy victim is closed anyway, and the failure of its
      // in-flight call is the acknowledged price (engram-bridge-runtime, 上限淘汰场景).
      if (victim.inFlight > 0) {
        this.#log.warn(
          `closing engram connection for ${victim.workspace} while ${victim.inFlight} call(s) are in flight (over connection limit)`,
        );
      }
      this.#close(victim.workspace, 'over connection limit');
    }
  }

  #close(workspace: string, reason: string): void {
    const entry = this.#entries.get(workspace);
    if (entry === undefined) return;
    this.#entries.delete(workspace);
    this.#log.debug(`closing engram connection for ${workspace} (${reason})`);
    try {
      entry.client.close();
    } catch {
      /* already closed */
    }
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
