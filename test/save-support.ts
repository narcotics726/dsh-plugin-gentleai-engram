import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../dist/index.js';
import { expectedOf, fakeModelDir, writeSource, type SourceRow } from './recall-support.ts';

/**
 * Shared rig for the write-layer tests.
 *
 * It is the read layer's rig with three additions: a local HTTP server standing
 * in for engram's write surface (so the write path is exercised for real, over a
 * socket), a second config knob for that URL, and helpers that drive the plugin's
 * own save tool through the fake host.
 *
 * The embedding runtime is test/ort-stub.mjs, as in the read-layer wiring tests,
 * so the derived index can actually be built and the candidate query actually
 * answered — no model needed.
 */

export const repo = process.cwd();
export const stubPath = join(repo, 'test', 'engram-stub.mjs');
export const ortStub = readFileSync(join(repo, 'test', 'ort-stub.mjs'), 'utf8');

export interface ToolDefinitionLike {
  name: string;
  description?: string;
  parameters?: unknown;
  output?: unknown;
  timeoutMs?: number;
  execute?: (args: unknown, exec: unknown) => Promise<unknown>;
}

export interface HostLog {
  info: string[];
  warn: string[];
  error: string[];
}

export interface SaveHost {
  ctx: never;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  registrations: Map<string, ToolDefinitionLike>;
  logs: HostLog;
  disposeAll(): void;
}

export function fakeHost(): SaveHost {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registrations = new Map<string, ToolDefinitionLike>();
  const logs: HostLog = { info: [], warn: [], error: [] };
  const disposers: Array<() => void> = [];
  const ctx: Record<string, unknown> = {
    logger: {
      debug(): void {},
      info: (message: string) => logs.info.push(message),
      warn: (message: string) => logs.warn.push(message),
      error: (message: string) => logs.error.push(message),
    },
    on(event: string, listener: (...args: unknown[]) => unknown): () => void {
      handlers.set(event, listener);
      return () => handlers.delete(event);
    },
    effect(callback: () => (() => void) | void): () => void {
      const dispose = callback();
      const run = (): void => {
        dispose?.();
      };
      disposers.push(run);
      return run;
    },
    tools: {
      register(definition: { name: string }): () => void {
        registrations.set(definition.name, definition as ToolDefinitionLike);
        return () => registrations.delete(definition.name);
      },
    },
  };
  return {
    ctx: ctx as never,
    handlers,
    registrations,
    logs,
    disposeAll(): void {
      for (const dispose of [...disposers].reverse()) dispose();
      disposers.length = 0;
    },
  };
}

/** A local stand-in for engram's HTTP write surface. */
export interface WriteStub {
  url: string;
  received: Array<Record<string, unknown>>;
  /** Replace what subsequent requests answer. */
  answer(status: number, body: string): void;
  close(): Promise<void>;
}

export async function writeStub(
  initialStatus = 201,
  initialBody = '{"id":1,"status":"saved"}',
  /**
   * Called AT THE MOMENT the request is handled. It exists so a test can read
   * state (the plugin's log) that must already exist when the write arrives —
   * the only honest way to prove ordering from outside, since the write itself
   * is the event we can observe.
   */
  observe?: () => void,
): Promise<WriteStub> {
  let status = initialStatus;
  let body = initialBody;
  const received: Array<Record<string, unknown>> = [];
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      received.push(JSON.parse(raw) as Record<string, unknown>);
      observe?.();
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    answer(nextStatus: number, nextBody: string): void {
      status = nextStatus;
      body = nextBody;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on: the connection-refused construction. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface RigOptions {
  rows?: readonly SourceRow[];
  /** Defaults to a live stub; pass a closed port's URL for "unreachable". */
  writeBaseUrl?: string;
  injectSessionId?: boolean;
  injectSessionProject?: boolean;
  searchEnabled?: boolean;
  /** Point the model directory at an empty directory: the runtime is missing. */
  withoutModel?: boolean;
  /** Extra environment for the stdio stub (e.g. answering with no project). */
  stubEnv?: Record<string, string>;
  projectOverrides?: Record<string, string>;
  /** M (shown candidates) and B (coverage pool) overrides. */
  saveCandidateLimit?: number;
  searchTopK?: number;
}

export interface Rig {
  host: SaveHost;
  temp: string;
  callsPath: string;
  indexDir: string;
  dbPath: string;
  cleanup(): Promise<void>;
}

export const DEFAULT_ROWS: readonly SourceRow[] = [
  {
    id: 1,
    title: '写层规划：候选在写入之前算好',
    content: '桥自己的保存入口在写入之前用读层的派生索引算候选，并限定在同一项目内。',
    type: 'architecture',
    project: 'stub-project',
  },
  {
    id: 2,
    title: 'another project row',
    content: '写层规划：候选在写入之前算好，另一项目的相似条目。',
    type: 'architecture',
    project: 'beta',
  },
];

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const temp = mkdtempSync(join(tmpdir(), 'save-wiring-'));
  const dshHome = join(temp, 'dsh-home');
  const callsPath = join(temp, 'calls.jsonl');
  const dbPath = join(temp, 'engram.db');
  const indexDir = join(temp, 'index');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  writeSource(dbPath, options.rows ?? DEFAULT_ROWS);
  const host = fakeHost();
  const modelDir =
    options.withoutModel === true ? join(temp, 'no-model') : fakeModelDir(temp, { ortEntrySource: ortStub });
  const config = {
    command: process.execPath,
    args: [stubPath],
    env: { ENGRAM_STUB_LOG: callsPath, ...(options.stubEnv ?? {}) },
    toolCallTimeoutMs: 10000,
    poolMaxConnections: 2,
    poolMaxIdleMs: 60000,
    poolSweepIntervalMs: 60000,
    projectOverrides: options.projectOverrides ?? {},
    injectSessionProject: options.injectSessionProject ?? true,
    injectSessionId: options.injectSessionId ?? true,
    capturePassive: true,
    compactionRecovery: true,
    recoveryTokenBudget: 800,
    recallWakeup: true,
    searchEnabled: options.searchEnabled ?? true,
    searchDbPath: dbPath,
    searchIndexDir: indexDir,
    searchModelDir: modelDir,
    embedThreads: 1,
    searchIdleMs: 60000,
    searchSweepIntervalMs: 60000,
    searchTimeoutMs: 30000,
    searchW: 0.2,
    searchTopK: options.searchTopK ?? 50,
    searchCoverage: 'field_cov' as const,
    writeBaseUrl: options.writeBaseUrl ?? 'http://127.0.0.1:1',
    writeTimeoutMs: 2000,
    saveCandidateBudgetMs: 3000,
    saveFallbackBudgetMs: 5000,
    saveCandidateLimit: options.saveCandidateLimit ?? 5,
  };
  // A fixture judged against a MISSING model directory cannot produce a matching
  // identity; leave the expectation at the repository's declaration there, which
  // is exactly the mismatch the missing-runtime test wants.
  apply(
    host.ctx,
    config,
    options.withoutModel === true ? {} : { expectedModel: expectedOf(modelDir) },
  );
  return {
    host,
    temp,
    callsPath,
    indexDir,
    dbPath,
    cleanup: async () => {
      host.disposeAll();
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

/** Drive a session through the host so the plugin binds and registers its tools. */
export async function startSession(host: SaveHost, sessionId: string): Promise<void> {
  const ctx = new Context();
  const store = new SessionStore(ctx);
  const session = store.create(sessionId, { meta: { cwd: repo } });
  const agent = { session };
  await host.handlers.get('agent/session-start')?.({ agent });
  await waitFor(() => host.registrations.has('mcp__engram__mem_bridge_save'));
}

/** A calling-agent stand-in: the plugin reads `exec.agent.session.header`. */
export function sessionOf(sessionId: string): { agent: unknown } {
  const ctx = new Context();
  const store = new SessionStore(ctx);
  return { agent: { session: store.create(sessionId, { meta: { cwd: repo } }) } };
}

export async function callTool(
  host: SaveHost,
  name: string,
  args: Record<string, unknown>,
  options: { sessionId?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
  const definition = host.registrations.get(name);
  if (definition?.execute === undefined) throw new Error(`tool not registered: ${name}`);
  return await definition.execute(args, {
    ...sessionOf(options.sessionId ?? 'stub-save'),
    signal: options.signal,
  });
}

/** Force the derived index into existence by running a retrieval first. */
export async function buildIndex(host: SaveHost, sessionId = 'stub-save'): Promise<void> {
  await callTool(host, 'mcp__engram__mem_bridge_recall', { query: '写层', limit: 5 }, { sessionId });
}

export interface StubCall {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
}

export function readCalls(path: string): StubCall[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as StubCall)
      .filter((call) => typeof call.name === 'string');
  } catch {
    return [];
  }
}

/** The index's recorded source hash: does anything about it move? */
export function indexSourceHash(indexDir: string): string {
  const db = new DatabaseSync(join(indexDir, 'index.db'), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='source_hash'").get() as { value: string } | undefined;
    return row?.value ?? '';
  } finally {
    db.close();
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor 超时');
}

/** The rendered text of one save result, as the model would read it. */
export function rendered(definition: ToolDefinitionLike, value: unknown): string {
  const output = definition.output as { render?: (args: unknown, value: unknown) => Array<{ text: string }> };
  assert.ok(typeof output?.render === 'function', 'save tool must render its own value');
  return output.render({}, value)
    .map((block) => block.text)
    .join('\n');
}
