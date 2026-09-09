import { spawn } from 'node:child_process';
import type { Logger } from './log.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

export type JsonSchemaNode = Record<string, unknown>;

/** One tool as engram declares it. */
export interface McpToolDeclaration {
  name: string;
  description?: string;
  inputSchema?: JsonSchemaNode;
}

export interface McpContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
}

/** Base class for every transport-level failure, so callers can degrade once. */
export class McpError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

export class McpTimeoutError extends McpError {
  constructor(method: string, timeoutMs: number) {
    super(`engram MCP call \`${method}\` timed out after ${timeoutMs}ms`, 'MCP_TIMEOUT');
  }
}

export class McpCancelledError extends McpError {
  constructor(method: string) {
    super(`engram MCP call \`${method}\` was cancelled`, 'MCP_CANCELLED');
  }
}

export class McpClosedError extends McpError {
  constructor(detail: string) {
    super(`engram MCP connection closed: ${detail}`, 'MCP_CLOSED');
  }
}

/** A tool reported `isError`; the message is the tool's own text. */
export class McpToolError extends McpError {
  constructor(message: string) {
    super(message, 'MCP_TOOL_ERROR');
  }
}

/** Narrow child-process surface so tests can inject a fake transport. */
export interface ChildLike {
  readonly stdout: {
    setEncoding(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): unknown;
  };
  readonly stderr?: {
    setEncoding(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): unknown;
  };
  readonly stdin: { write(chunk: string): unknown };
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): unknown;
}

export type SpawnLike = (options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}) => ChildLike;

/** Variables a child needs to run at all; everything else must be opted in. */
const INHERITED_KEYS = ['PATH', 'HOME', 'SystemRoot', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ'];

/**
 * Minimal environment for the engram child: enough to execute, every
 * `ENGRAM_*` knob the user already set, then explicit config env on top.
 * The host's full environment is deliberately not forwarded.
 */
export function buildChildEnv(
  extra: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('ENGRAM_') && typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function defaultSpawn(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}): ChildLike {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child as unknown as ChildLike;
}

export interface McpClientOptions {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  /** Working directory of the child; the bridge always passes the session workspace. */
  cwd: string;
  requestTimeoutMs?: number;
  protocolVersion?: string;
  clientName?: string;
  clientVersion?: string;
  spawnImpl?: SpawnLike;
  logger?: Logger;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  cleanup: () => void;
}

/** Minimal newline-delimited JSON-RPC 2.0 client for an MCP stdio server. */
export class McpClient {
  #child: ChildLike;
  #buffer = '';
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #closed = false;
  #stderr = '';
  #timeoutMs: number;
  #logger: Logger | undefined;

  tools: McpToolDeclaration[] = [];

  private constructor(options: McpClientOptions) {
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#logger = options.logger;
    const spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.#child = spawnImpl({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: buildChildEnv(options.env),
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    this.#child.stderr?.setEncoding('utf8');
    this.#child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    this.#child.on('error', (error: unknown) => {
      this.#failAll(new McpClosedError(`spawn failed: ${String(error)}`));
    });
    // The draft never handled child exit, which left in-flight calls pending
    // forever; a dead child must settle every waiter.
    this.#child.on('exit', (code: unknown, signal: unknown) => {
      const detail = `exit code ${String(code)}${signal ? ` signal ${String(signal)}` : ''}`;
      this.#failAll(new McpClosedError(this.#stderr ? `${detail}: ${this.#stderr.trim()}` : detail));
    });
    this.#child.on('close', () => {
      this.#failAll(new McpClosedError('transport closed'));
    });
  }

  static async connect(options: McpClientOptions): Promise<McpClient> {
    const client = new McpClient(options);
    try {
      await client.#initialize(options);
      client.tools = await client.#listTools();
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  get stderr(): string {
    return this.#stderr;
  }

  async #initialize(options: McpClientOptions): Promise<void> {
    await this.#request('initialize', {
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: options.clientName ?? 'engram-bridge',
        version: options.clientVersion ?? '0.1.0',
      },
    });
    this.#notify('notifications/initialized', {});
  }

  async #listTools(): Promise<McpToolDeclaration[]> {
    const tools: McpToolDeclaration[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.#request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpToolDeclaration[];
        nextCursor?: string;
      };
      if (Array.isArray(page.tools)) tools.push(...page.tools);
      cursor = typeof page.nextCursor === 'string' && page.nextCursor !== '' ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  /** Call one engram tool. `signal` cancels the call without killing the child. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const result = (await this.#request('tools/call', { name, arguments: args }, signal)) as {
      content?: McpContentBlock[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const content = Array.isArray(result.content) ? result.content : [];
    if (result.isError === true) {
      throw new McpToolError(extractText(content) || `engram tool \`${name}\` failed`);
    }
    const value: McpCallResult = { content };
    if (result.structuredContent !== undefined) value.structuredContent = result.structuredContent;
    return value;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#child.kill();
    } catch {
      /* already gone */
    }
    this.#failAll(new McpClosedError('client closed'));
  }

  #failAll(error: Error): void {
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) {
      call.cleanup();
      call.reject(error);
    }
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line !== '') this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: string; code?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      this.#logger?.debug(`ignoring non-JSON line from engram: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.id !== 'number') return;
    const call = this.#pending.get(message.id);
    if (!call) return;
    this.#pending.delete(message.id);
    call.cleanup();
    if (message.error) {
      call.reject(new McpError(message.error.message ?? 'engram MCP error', 'MCP_SERVER_ERROR'));
      return;
    }
    call.resolve(message.result ?? {});
  }

  #notify(method: string, params: Record<string, unknown>): void {
    if (this.#closed) return;
    try {
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      /* child already gone; the exit handler settles waiters */
    }
  }

  #request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new McpClosedError('client closed'));
    if (signal?.aborted === true) return Promise.reject(new McpCancelledError(method));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        this.#timeoutMs > 0
          ? setTimeout(() => {
              const call = this.#pending.get(id);
              if (!call) return;
              this.#pending.delete(id);
              call.cleanup();
              reject(new McpTimeoutError(method, this.#timeoutMs));
            }, this.#timeoutMs)
          : undefined;
      timer?.unref?.();
      const onAbort = (): void => {
        const call = this.#pending.get(id);
        if (!call) return;
        this.#pending.delete(id);
        call.cleanup();
        this.#notify('notifications/cancelled', { requestId: id, reason: 'caller cancelled' });
        reject(new McpCancelledError(method));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.#pending.set(id, { method, resolve, reject, timer, cleanup });
      try {
        this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        this.#pending.delete(id);
        cleanup();
        reject(new McpClosedError(String(error)));
      }
    });
  }
}

export function extractText(content: readonly McpContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : undefined))
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}
