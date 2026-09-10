import type { SessionEventMap } from '@deepseek-ai/dsh-session/types';
// Type-only: loads the module augmentation that adds the `compaction/*` members to
// `SessionEventMap`, so reading those payloads is compile-checked instead of cast.
import type { CompactionId } from '@deepseek-ai/dsh-compaction/types';

/**
 * A session event as the host delivers it: an envelope whose payload lives in `data`
 * (`Session.append()` builds `{type, seq, time, data, ...surfaceMetadata}`). Readers must
 * never expect payload fields on the envelope itself.
 */
export interface SessionEventLike {
  type?: unknown;
  data?: unknown;
}

type FieldKind = 'number' | 'number-or-null' | 'string' | 'array';

interface FieldContract {
  readonly path: string;
  readonly kind: FieldKind;
}

/**
 * Fields every subscribed session event must carry. A payload that is missing one of them
 * (or carries the wrong type) is a contract violation and must be reported, never dropped
 * silently — field drift inside `data` is otherwise indistinguishable from "nothing happened".
 */
const EVENT_CONTRACT = {
  'assistant/message': [
    { path: 'turn', kind: 'number' },
    { path: 'step', kind: 'number' },
    { path: 'message.content', kind: 'array' },
  ],
  'compaction/summary': [
    { path: 'compactionId', kind: 'string' },
    { path: 'summary', kind: 'array' },
  ],
  // `turn` is `null` for the standalone manual transaction between turns — the exact case
  // whose recall must not be queued at a step boundary that is about to be torn down.
  'compaction/end': [
    { path: 'compactionId', kind: 'string' },
    { path: 'turn', kind: 'number-or-null' },
  ],
} as const satisfies Record<string, readonly FieldContract[]>;

export type SubscribedEventType = keyof typeof EVENT_CONTRACT;

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function matchesKind(value: unknown, kind: FieldKind): boolean {
  if (kind === 'array') return Array.isArray(value);
  if (kind === 'number') return isFiniteNumber(value);
  if (kind === 'number-or-null') return value === null || isFiniteNumber(value);
  return typeof value === 'string';
}

/**
 * Read one subscribed session event's payload from its envelope.
 *
 * Returns `undefined` when the event is not of the requested type (not our business, no
 * warning) or when the envelope/payload violates the contract (reported through `warn`).
 */
export function readEventPayload<T extends SubscribedEventType>(
  event: SessionEventLike | undefined,
  type: T,
  warn: (detail: string) => void,
): SessionEventMap[T] | undefined {
  if (event === undefined || event.type !== type) return undefined;
  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    const expected = EVENT_CONTRACT[type].map((field) => field.path).join(', ');
    warn(`payload is not an object (expected fields: ${expected})`);
    return undefined;
  }
  const missing = EVENT_CONTRACT[type].filter((field) => !matchesKind(readPath(data, field.path), field.kind));
  if (missing.length > 0) {
    warn(
      `payload fields missing or mistyped: ${missing.map((field) => `${field.path} (${field.kind})`).join(', ')}`,
    );
    return undefined;
  }
  return data as SessionEventMap[T];
}

/**
 * Warn at most once per (session, event type).
 *
 * The throttle key is deliberately per session: a plugin instance lives as long as the
 * process, so a single process-wide warning would stay silent across every later session —
 * exactly the silent failure mode this contract exists to remove.
 */
export class EventShapeWarnings {
  readonly #seen = new Set<string>();
  readonly #warn: (message: string) => void;

  constructor(warn: (message: string) => void) {
    this.#warn = warn;
  }

  report(sessionId: string, type: SubscribedEventType, detail: string): void {
    const key = `${sessionId}:${type}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#warn(`session event shape mismatch for "${type}" in session ${sessionId}: ${detail}`);
  }
}

export function blocksToText(blocks: readonly { type?: unknown; text?: unknown }[] | undefined): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined))
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

export interface SessionLike {
  header?: { id?: unknown };
  snapshotEvents?: () => readonly unknown[];
}

/** Final assistant text of one turn, skipping interrupted (partial) messages. */
export function turnFinalText(
  session: SessionLike | undefined,
  turn: unknown,
  warnings: EventShapeWarnings,
): string | undefined {
  const sessionId = typeof session?.header?.id === 'string' ? session.header.id : '(unknown session)';
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  let found: string | undefined;
  for (const event of events) {
    const envelope = event as SessionEventLike | undefined;
    if (envelope?.type !== 'assistant/message') continue;
    const data = readEventPayload(envelope, 'assistant/message', (detail) =>
      warnings.report(sessionId, 'assistant/message', detail),
    );
    if (data === undefined) continue;
    if (turn !== undefined && data.turn !== turn) continue;
    if (data.interrupted === true) continue;
    found = blocksToText(data.message?.content);
  }
  return found;
}

export type { CompactionId };
