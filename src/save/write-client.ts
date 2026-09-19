/**
 * The bridge's own write channel: one `POST /observations` against engram's HTTP
 * surface, with Node's built-in `fetch`.
 *
 * Why this exists at all is in the change's proposal: the only model-visible
 * write path used to be the MCP save tool, and that handler unconditionally runs
 * a conflict-candidate scan whose matching is title-only FTS with a tokenizer
 * that cannot split Chinese. Writing through the HTTP surface skips that scan
 * entirely, and the bridge computes its own candidates instead.
 *
 * Everything here is a pure request/response concern. The policy — when to fall
 * back, what a refusal means, which budget applies — lives in the caller.
 */

/** How a write attempt failed. Each kind maps to a different caller decision. */
export type WriteFailureKind =
  /** The request never reached the service (connection refused, DNS, reset). */
  | 'connection'
  /** No response within the budget: the request may or may not have been applied. */
  | 'timeout'
  /** The service answered 5xx: it was reachable but did not do the work. */
  | 'server'
  /** The service answered 4xx: the request itself is wrong; retrying elsewhere repeats it. */
  | 'rejected'
  /** The caller's own cancellation. */
  | 'cancelled';

export class WriteFailure extends Error {
  readonly kind: WriteFailureKind;
  /** HTTP status, when there was a response at all. */
  readonly status?: number;
  constructor(kind: WriteFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'WriteFailure';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface WriteRequest {
  /** Base URL of the HTTP write surface, e.g. `http://127.0.0.1:7437`. */
  baseUrl: string;
  /** This request's own deadline. Expiry abandons the request. */
  timeoutMs: number;
  /** The host's deadline is cooperative: without this, a timeout is decorative. */
  signal?: AbortSignal;
  body: Record<string, unknown>;
}

export interface WriteOutcome {
  /**
   * The id the backend reported for the observation it wrote or updated. Absent
   * when the write clearly succeeded but the response carried no id — the caller
   * must then still treat the save as done, because a retry would write twice.
   */
  id?: number;
}

/** The write route, relative to the base URL. */
export const WRITE_PATH = '/observations';

export function writeEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${WRITE_PATH}`;
}

/**
 * One write attempt. Resolves only for a request the service accepted; every
 * other outcome is a `WriteFailure` carrying its kind, so the caller can decide
 * between "fall back" (connection/timeout/server) and "fail as stated"
 * (rejected).
 */
export async function writeObservation(request: WriteRequest): Promise<WriteOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => controller.abort();
  // A closure, not a narrowed property read: `aborted` is readonly, so TypeScript
  // would keep the first check's narrowing across the awaits below (the signal can
  // abort at any point in between).
  const cancelled = (): boolean => request.signal?.aborted === true;
  if (cancelled()) {
    throw new WriteFailure('cancelled', 'engram-bridge: 写入已被发起者取消，本次没有写入任何记忆。');
  }
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Math.floor(request.timeoutMs)));
  timer.unref?.();

  let response: Response;
  try {
    response = await fetch(writeEndpoint(request.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new WriteFailure(
        'timeout',
        `engram-bridge: 写入请求超过 ${Math.floor(request.timeoutMs)}ms 未返回响应（已放弃等待；服务端可能已经落库）。`,
      );
    }
    if (cancelled()) {
      throw new WriteFailure('cancelled', 'engram-bridge: 写入已被发起者取消，本次没有写入任何记忆。');
    }
    throw new WriteFailure(
      'connection',
      `engram-bridge: 连接写入面失败（${describeFetchError(error)}）`,
    );  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }

  const text = await readBody(response);
  if (response.status >= 500) {
    throw new WriteFailure(
      'server',
      `engram-bridge: 写入面返回 ${response.status}${detailOf(text)}`,
      response.status,
    );
  }
  if (response.status >= 400) {
    throw new WriteFailure(
      'rejected',
      `engram-bridge: 写入面拒绝了这次写入（${response.status}${detailOf(text)}）`,
      response.status,
    );
  }
  // 201 Created is what the route sends; any other 2xx is accepted as success all
  // the same, because the service did the work and a retry would write twice.
  const parsed = parseJson(text);
  const id = typeof parsed?.id === 'number' && Number.isFinite(parsed.id) ? parsed.id : undefined;
  return id === undefined ? {} : { id };
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    // A body we cannot read is not a failed write: the status already told us
    // whether the service accepted it.
    return '';
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The service's own `error` field when it sent one; a snippet otherwise. */
function detailOf(text: string): string {
  const parsed = parseJson(text);
  const error = parsed?.error;
  if (typeof error === 'string' && error !== '') return `：${error}`;
  const trimmed = text.trim();
  return trimmed === '' ? '' : `：${trimmed.slice(0, 200)}`;
}

function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  if (code !== undefined) return code;
  if (typeof cause?.message === 'string' && cause.message !== '') return cause.message;
  return error instanceof Error ? error.message : String(error);
}
