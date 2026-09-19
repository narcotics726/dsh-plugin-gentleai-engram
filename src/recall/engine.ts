import { rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  contentSha,
  documentText,
  IndexDb,
  inspectIndex,
  readSourceState,
  type EmbedderLike,
  type SourceState,
  type SyncMetering,
  type SyncPlan,
} from './index-db.js';
import { acquireIndexLock, LockBusyError, type HeldIndexLock } from './index-lock.js';
import { expectedIdentityDigest } from './model-expected.js';
import { excerpt, Scorer, type CoverageVariant } from './scoring.js';
import type {
  CandidateEvidence,
  CandidatePayload,
  CandidateQuery,
  RecallHit,
  RecallMetering,
  RecallPayload,
  RecallQuery,
} from './protocol.js';

/**
 * The read layer itself: bring the derived index up to date with the source,
 * rank, filter, and cut.
 *
 * Every step's arithmetic lives elsewhere (index-db for the index, scoring for
 * the ranking). What this file owns:
 *
 *  * the ORDER of the write path, which is the whole point of the change —
 *    take the lock, drop or prove the cached handle, read the source UNDER the
 *    lock, judge the index again, compare the work against the caller's cap,
 *    and only then load the model and embed. Over the cap nothing is loaded and
 *    nothing is written: the call reports `SyncNeededError` and the caller
 *    decides (design D5/D7);
 *  * "rebuilding" is not a special case: it is Δ = the whole corpus, judged by
 *    the same cap as any delta;
 *  * ranking covers the WHOLE corpus, filtering never changes a score and never
 *    consumes a return slot, and the cut's truncation decision continues past
 *    the cut (using comparisons only, never another embedding).
 */

/** Raised when the derived index cannot be trusted and must be built from scratch. */
export class RebuildNeededError extends Error {
  readonly kind = 'rebuild-needed';
  constructor(reason: string) {
    super(`engram-bridge: 派生索引需要重建（${reason}）`);
    this.name = 'RebuildNeededError';
  }
}

/** Raised when this call declined the work: it exceeded its own cap. */
export class SyncNeededError extends Error {
  readonly kind = 'sync-needed';
  readonly mode: 'incremental' | 'full';
  readonly pendingDocs: number;
  constructor(mode: 'incremental' | 'full', pendingDocs: number, reason: string) {
    super(`engram-bridge: 本次调用做不完所需的工作（${reason}）`);
    this.name = 'SyncNeededError';
    this.mode = mode;
    this.pendingDocs = pendingDocs;
  }
}

export interface RecallWritePolicy {
  /**
   * Cap on this call's work (changed + removed). Absent = unlimited, which is
   * exactly one product path: the operator request (design D8).
   */
  maxDocs?: number;
  /** How long to wait for the index lock before giving up. */
  lockWaitMs?: number;
  /** SQLite write-lock wait; a resident call must fail fast, not eat its budget. */
  busyTimeoutMs?: number;
}

export interface RecallEngineOptions {
  dbPath: string;
  indexPath: string;
  w: number;
  topK: number;
  coverage: CoverageVariant;
  dim?: number;
  /**
   * Identity of the declared model/runtime the vectors belong to. The writer
   * (`sync`) and the checker (`inspectIndex`) both read it through this one
   * option, so they cannot drift apart (design D10). Defaults to the
   * repository's declaration; the worker passes it explicitly.
   */
  identityDigest?: string;
  /** Lazily created; the resident worker memoises the loaded model behind this. */
  embedder: () => Promise<EmbedderLike>;
  onEmbedLoad?: (loadMs: number) => void;
}

interface DocRow {
  doc_id: number;
  type: string;
  project: string;
  scope: string;
  title: string;
  content: string;
}

/** Everything a one-shot child reports about one run. */
export interface OneShotResult {
  mode: string;
  docs: number;
  embedDocs: number;
  ms: number;
  docCount: number;
}

export class RecallEngine {
  private readonly options: RecallEngineOptions;
  private index?: IndexDb;
  private scorer?: Scorer;
  /** Inode + stored hash of the handle, for the cheap "is it still current?" check. */
  private indexIno?: number;
  private lastStoredHash?: string;

  constructor(options: RecallEngineOptions) {
    this.options = options;
  }

  /** Diagnostics: the state a caller would act on (no side effects). */
  inspect(): ReturnType<typeof inspectIndex> {
    return inspectIndex(this.options.indexPath, this.identity);
  }

  /** The generation every write and every check is stamped with. */
  private get identity(): string {
    return this.options.identityDigest ?? expectedIdentityDigest();
  }

  close(): void {
    this.scorer = undefined;
    this.index?.close();
    this.index = undefined;
    this.indexIno = undefined;
    this.lastStoredHash = undefined;
  }

  /**
   * Whether the cached handle may be reused. Cheap and precise: the inode
   * catches a file another writer replaced, the stored hash catches a commit by
   * another process. This is what makes "re-judge under the lock" affordable —
   * re-creating the scorer would reload every vector.
   */
  handleStillCurrent(): boolean {
    if (this.index === undefined) return false;
    try {
      if (statSync(this.options.indexPath).ino !== this.indexIno) return false;
      return this.index.storedHash() === this.lastStoredHash;
    } catch {
      return false;
    }
  }

  private async lock(policy: RecallWritePolicy, fallbackWaitMs: number): Promise<HeldIndexLock> {
    return await acquireIndexLock(this.options.indexPath, {
      waitMs: policy.lockWaitMs ?? fallbackWaitMs,
    });
  }

  /** Adopt a freshly written index as the cached one. */
  private adopt(index: IndexDb, metering: SyncMetering): void {
    this.index = index;
    try {
      this.indexIno = statSync(this.options.indexPath).ino;
    } catch {
      this.indexIno = undefined;
    }
    this.lastStoredHash = index.storedHash();
    if (metering.mode !== 'noop') this.scorer = undefined;
  }

  /**
   * Judge the index under the lock and, when it cannot be trusted, decide
   * whether rebuilding fits this call's cap. Returns whether the sync must be
   * a full rebuild. Never destroys anything before the cap check (design D5).
   */
  private openForWrite(state: SourceState, policy: RecallWritePolicy): { index: IndexDb; full: boolean } {
    const inspection = inspectIndex(this.options.indexPath, this.identity);
    if (inspection.needsFullBuild) {
      // A rebuild is Δ = the whole corpus, and the corpus size is known before
      // anything is opened. Decide FIRST: a refusal must not create or delete a
      // single file.
      this.assertWithinCap({ mode: 'full', touched: state.docs.length }, policy, inspection.reason);
      if (inspection.reason === 'unreadable') {
        // Not even readable as a database: start from an empty file. The build
        // itself still happens in one transaction (no separate "empty index"
        // commit, so a kill cannot leave a new half-state behind).
        discardIndexFiles(this.options.indexPath);
      }
    }
    let index: IndexDb;
    try {
      index = IndexDb.open(this.options.indexPath, { busyTimeoutMs: policy.busyTimeoutMs });
    } catch {
      discardIndexFiles(this.options.indexPath);
      index = IndexDb.open(this.options.indexPath, { busyTimeoutMs: policy.busyTimeoutMs });
    }

    let untrusted: string | undefined;
    if (inspection.needsFullBuild) {
      untrusted = inspection.reason;
    } else if (!index.integrityOk()) {
      untrusted = 'integrity_check';
    } else if (index.updatePrefixPresent()) {
      untrusted = '残留的更新标记';
    } else {
      const meta = index.meta();
      const missing = ['scoring_k1', 'scoring_b', 'scoring_title_weight', 'scoring_evidence_weight'].find(
        (key) => meta.get(key) === undefined,
      );
      if (missing !== undefined) {
        untrusted = `索引缺少打分常量 ${missing}`;
      } else {
        const vectors = Number(
          (index.handle.prepare('SELECT count(*) AS c FROM vectors').get() as { c: number }).c,
        );
        if (vectors !== index.docCount()) {
          untrusted = `向量数 ${vectors} 与文档数 ${index.docCount()} 不一致`;
        }
      }
    }

    if (untrusted === undefined) return { index, full: false };
    // "Needs a rebuild" is Δ = the whole corpus — the same judgement as any
    // other work, so a cap over it is a refusal, not a special case.
    this.assertWithinCap({ mode: 'full', touched: state.docs.length }, policy, untrusted);
    return { index, full: true };
  }

  /** Compare planned work against the caller's cap; over it, decline the work. */
  private assertWithinCap(plan: SyncPlan, policy: RecallWritePolicy, reason?: string): void {
    const cap = policy.maxDocs ?? Number.POSITIVE_INFINITY;
    if (plan.touched <= cap) return;
    const detail = reason === undefined ? '' : `（${reason}）`;
    throw new SyncNeededError(
      plan.mode === 'full' ? 'full' : 'incremental',
      plan.touched,
      `待处理 ${plan.touched} 条超出本次调用上限 ${String(policy.maxDocs)}${detail}`,
    );
  }

  /** The heartbeat + ownership re-check handed to `sync` (design D6). */
  private lockGuards(lock: HeldIndexLock): { onProgress: () => void; assertStillHeld: () => void } {
    return {
      onProgress: () => lock.heartbeat(),
      assertStillHeld: () => {
        if (!lock.stillHeld()) {
          throw new LockBusyError('engram-bridge: 索引锁已被别人接管，本次写入放弃（派生数据未被改动）');
        }
      },
    };
  }

  /** One full rebuild, used by the `--rebuild` one-shot mode and by fixtures. */
  async rebuild(policy: RecallWritePolicy = {}): Promise<OneShotResult> {
    const t0 = performance.now();
    const lock = await this.lock(policy, 0);
    try {
      this.close();
      const state = readSourceState(this.options.dbPath);
      const prepared = this.openForWrite(state, policy);
      if (!prepared.full) {
        // Force it: a "rebuild" must not become a delta just because the index
        // happens to look trustworthy.
        this.assertWithinCap({ mode: 'full', touched: state.docs.length }, policy, '强制全量重建');
      }
      const { metering } = await this.runSync(state, prepared.index, policy, lock, true);
      const summary: OneShotResult = {
        mode: metering.mode,
        docs: state.docs.length,
        embedDocs: metering.embedDocs,
        ms: performance.now() - t0,
        docCount: state.docs.length,
      };
      this.adopt(prepared.index, metering);
      return summary;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      lock.release();
    }
  }

  /**
   * Bring the index up to date without answering a query: the one-shot child's
   * entry point. Never destroys anything before the cap check, and never loads
   * the model before it either (design D7).
   */
  async syncOnce(policy: RecallWritePolicy = {}): Promise<OneShotResult> {
    const t0 = performance.now();
    const lock = await this.lock(policy, 0);
    try {
      this.close();
      const state = readSourceState(this.options.dbPath);
      const prepared = this.openForWrite(state, policy);
      const { metering } = await this.runSync(state, prepared.index, policy, lock, prepared.full);
      const summary: OneShotResult = {
        mode: metering.mode,
        docs: state.docs.length,
        embedDocs: metering.embedDocs,
        ms: performance.now() - t0,
        docCount: state.docs.length,
      };
      this.adopt(prepared.index, metering);
      return summary;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      lock.release();
    }
  }

  /**
   * The shared write: plan → cap → load model → sync. The plan is computed
   * before the model is loaded, which is what makes an over-cap refusal cheap
   * (it happens in `assertWithinCap` here or in `openForWrite`).
   */
  private async runSync(
    state: SourceState,
    index: IndexDb,
    policy: RecallWritePolicy,
    lock: HeldIndexLock,
    full: boolean,
  ): Promise<{ metering: SyncMetering; embedLoadMs: number }> {
    const plan = index.planFor(state, full);
    this.assertWithinCap(plan, policy);
    const embedLoad0 = performance.now();
    const embedder = await this.options.embedder();
    const embedLoadMs = performance.now() - embedLoad0;
    this.options.onEmbedLoad?.(embedLoadMs);
    const guards = this.lockGuards(lock);
    const metering = await index.sync(state, embedder, {
      full,
      identityDigest: this.identity,
      maxDocs: policy.maxDocs,
      expectedStoredHash: full ? undefined : index.storedHash(),
      ...guards,
    });
    if (metering.mode === 'deferred') {
      throw new SyncNeededError(
        'incremental',
        metering.pendingDocs ?? 0,
        `待处理 ${String(metering.pendingDocs)} 条超出本次调用上限`,
      );
    }
    return { metering, embedLoadMs };
  }

  async query(request: RecallQuery, policy: RecallWritePolicy = {}): Promise<RecallPayload> {
    const total0 = performance.now();
    const lock = await this.lock(policy, 2_000);
    try {
      // Under the lock, and only then: drop the cached handle unless it can be
      // PROVEN current (a handle opened before the lock can point at an inode
      // another writer replaced, in which case the diff would read Δ = 0).
      if (!this.handleStillCurrent()) this.close();
      const hash0 = performance.now();
      const state = readSourceState(this.options.dbPath);
      const hashMs = performance.now() - hash0;

      const prepared = this.openForWrite(state, policy);
      const { metering, embedLoadMs } = await this.runSync(state, prepared.index, policy, lock, prepared.full);
      this.adopt(prepared.index, metering);
      const index = prepared.index;
      if (this.scorer === undefined) this.scorer = new Scorer(index, this.options.dim);
      const scorer = this.scorer;

      const embed0 = performance.now();
      const embedder = await this.options.embedder();
      const [queryVec] = await embedder.embed([request.query]);
      if (queryVec === undefined) {
        throw new Error('engram-bridge: 嵌入器没有为查询串返回向量');
      }
      const embedQueryMs = performance.now() - embed0;

      const score0 = performance.now();
      const ranked = scorer.rank(request.query, queryVec, {
        w: this.options.w,
        topK: this.options.topK,
        coverage: this.options.coverage,
      });
      const scoreMs = performance.now() - score0;

      const rows = index.handle
        .prepare('SELECT doc_id, type, project, scope, title, content FROM docs')
        .all() as unknown as DocRow[];
      const byId = new Map<number, DocRow>();
      for (const row of rows) byId.set(row.doc_id, row);

      const wantProject = request.allProjects === true ? undefined : request.project;
      const hits: RecallHit[] = [];
      let filteredOut = 0;
      let truncated = false;
      for (let rank = 0; rank < ranked.ids.length; rank++) {
        const id = ranked.ids[rank]!;
        const row = byId.get(id);
        if (row === undefined) continue;
        if (wantProject !== undefined && row.project !== wantProject) {
          filteredOut++;
          continue;
        }
        if (request.type !== undefined && row.type !== request.type) {
          filteredOut++;
          continue;
        }
        if (request.scope !== undefined && row.scope !== request.scope) {
          filteredOut++;
          continue;
        }
        if (hits.length >= request.limit) {
          // A matching document beyond the cut: there IS something not shown.
          // The loop keeps going only to finish counting `filteredOut`, which
          // needs no embedding — it is a comparison over already-loaded rows.
          truncated = true;
          continue;
        }
        hits.push({
          id,
          title: row.title,
          type: row.type,
          project: row.project,
          scope: row.scope,
          score: ranked.boosted[rank]!,
          excerpt: excerpt(row.content),
        });
      }

      const availableTypes =
        request.type !== undefined && hits.length === 0 ? this.availableTypes(index) : [];

      const meteringOut: RecallMetering = {
        sourceChanged: metering.sourceChanged,
        rowsScanned: metering.rowsScanned,
        docsTouched: metering.docsTouched,
        hashMs: metering.hashMs,
        syncMs: metering.syncMs,
        embedDocs: metering.embedDocs,
        embedLoadMs,
        embedQueryMs,
        scoreMs,
        totalMs: performance.now() - total0,
        mode: metering.mode,
        docCount: metering.docCount,
        indexBytes: metering.indexBytes,
      };
      return {
        hits,
        limit: request.limit,
        truncated,
        filteredOut,
        poolSize: ranked.poolSize,
        candidates: ranked.candidates,
        availableTypes,
        metering: meteringOut,
      };
    } finally {
      lock.release();
    }
  }

  /** Type domain, computed live from the index — never cached (D7). */
  availableTypes(index: IndexDb): string[] {
    return (
      index.handle
        .prepare("SELECT DISTINCT type FROM docs WHERE type <> '' ORDER BY type")
        .all() as Array<{ type: string }>
    ).map((row) => row.type);
  }

  /**
   * Candidates for a write: which existing memories resemble the text about to
   * be saved.
   *
   * Four decisions live here, and all four are the OPPOSITE of `query()` on
   * purpose (design D4/D5):
   *
   *  1. **No catch-up, ever.** The index is opened read-only and answered from
   *     as it stands. Untrusted or missing derived data returns an empty result;
   *     nothing is rebuilt, nothing is created.
   *  2. **No refusal.** Anything that goes wrong here is "no candidates this
   *     time" — a candidate lookup is an enhancement, and the write must not
   *     depend on it.
   *  3. **The ordering is the read layer's own** (`Scorer.rank`), so a save
   *     cannot show the model a second, differently-computed notion of
   *     "similar" in the same session.
   *  4. **Candidates are restricted to one project**: a cross-project pair
   *     cannot be written as a relation in this backend, so offering one would
   *     be offering a dead end.
   */
  async candidates(
    request: CandidateQuery,
    policy: RecallWritePolicy = {},
    signal?: AbortSignal,
  ): Promise<CandidatePayload> {
    const total0 = performance.now();
    assertNotAborted(signal);
    const index = this.openForCandidates(policy);
    if (index === undefined) return emptyCandidates(total0);

    try {
      // The hash judgement is deliberately the SAME one the read layer uses
      // (design D9.1): a second, approximate "is it stale" signal would be a
      // second truth about staleness. A missing source is not fatal here — the
      // index still answers, we just cannot say whether it lags.
      const hash0 = performance.now();
      let source: SourceState | undefined;
      try {
        source = readSourceState(this.options.dbPath);
      } catch {
        source = undefined;
      }
      const hashMs = performance.now() - hash0;
      const sourceChanged = source !== undefined && source.hash !== index.storedHash();
      const lagDocs = source === undefined ? 0 : source.docs.length - index.docCount();

      const scorer = new Scorer(index, this.options.dim);
      const text = documentText({ title: request.title, content: request.content });

      const embed0 = performance.now();
      assertNotAborted(signal);
      const embedder = await this.options.embedder();
      const [queryVec] = await embedder.embed([text]);
      if (queryVec === undefined) throw new Error('engram-bridge: 嵌入器没有返回候选查询向量');
      const embedMs = performance.now() - embed0;
      assertNotAborted(signal);

      const score0 = performance.now();
      const ranked = scorer.rank(text, queryVec, {
        w: this.options.w,
        topK: this.options.topK,
        coverage: this.options.coverage,
      });
      const scoreMs = performance.now() - score0;

      const rows = index.handle
        .prepare('SELECT doc_id, type, project, title, updated_at, content_sha FROM docs')
        .all() as unknown as IndexRow[];
      const byId = new Map<number, IndexRow>();
      for (const row of rows) byId.set(row.doc_id, row);
      const wantContentSha = contentSha(request.title, request.content);

      const shown: Array<{ row: IndexRow; rank: number }> = [];
      let filteredOut = 0;
      for (let rank = 0; rank < ranked.ids.length; rank++) {
        const id = ranked.ids[rank]!;
        const row = byId.get(id);
        if (row === undefined) continue;
        if (request.project !== '' && row.project !== request.project) {
          filteredOut++;
          continue;
        }
        if (shown.length >= request.limit) break;
        shown.push({ row, rank: rank + 1 });
      }

      const ids = shown.map((entry) => entry.row.doc_id);
      const shared = scorer.sharedRareTerms(text, ids, SHARED_TERM_LIMIT);
      const extras = readSourceExtras(this.options.dbPath, ids);

      const candidates: CandidateEvidence[] = shown.map((entry) => {
        const row = entry.row;
        const extra = extras.get(row.doc_id);
        const topicKey = extra?.topicKey ?? '';
        const sessionId = extra?.sessionId ?? '';
        const terms = shared.get(row.doc_id) ?? [];
        return {
          id: row.doc_id,
          title: row.title,
          type: row.type,
          updated_at: row.updated_at,
          same_topic_key:
            request.topicKey !== '' && topicKey === request.topicKey ? topicKey : '',
          same_session: request.sessionId !== '' && sessionId === request.sessionId,
          same_type_and_title: row.type === request.type && row.title === request.title,
          identical_content: row.content_sha === wantContentSha,
          shared_rare_terms: { count: terms.length, terms },
          semantic_rank: entry.rank,
          corpus_size: index.docCount(),
        };
      });

      return {
        candidates,
        poolIds: ranked.ids.slice(0, ranked.poolSize),
        metering: {
          sourceChanged,
          lagDocs,
          docCount: index.docCount(),
          candidates: ranked.candidates,
          poolSize: ranked.poolSize,
          filteredOut,
          hashMs,
          embedMs,
          scoreMs,
          totalMs: performance.now() - total0,
        },
      };
    } finally {
      index.close();
    }
  }

  /**
   * The index for a candidate lookup, or `undefined` when it cannot be trusted.
   * Strictly read-only and strictly non-creating: a missing index is "no
   * candidates", never a build (design D4).
   */
  private openForCandidates(policy: RecallWritePolicy): IndexDb | undefined {
    const inspection = inspectIndex(this.options.indexPath, this.identity);
    if (inspection.needsFullBuild) return undefined;
    try {
      const index = IndexDb.openReadOnly(this.options.indexPath, {
        busyTimeoutMs: policy.busyTimeoutMs ?? CANDIDATE_BUSY_TIMEOUT_MS,
      });
      if (index === undefined) return undefined;
      if (!index.integrityOk() || index.updatePrefixPresent()) {
        index.close();
        return undefined;
      }
      return index;
    } catch {
      return undefined;
    }
  }
}

/** One `docs` row as the candidate path needs it (no content: only its hash). */
interface IndexRow {
  doc_id: number;
  type: string;
  project: string;
  title: string;
  updated_at: string;
  content_sha: string;
}

/**
 * Shared rare terms listed per candidate. Small on purpose: the line has to stay
 * readable, and the point is "which words", not "how many".
 */
export const SHARED_TERM_LIMIT = 5;

/** A candidate lookup never waits on SQLite's write lock; there is no writer. */
export const CANDIDATE_BUSY_TIMEOUT_MS = 300;

function emptyCandidates(t0: number): CandidatePayload {
  return {
    candidates: [],
    poolIds: [],
    metering: {
      sourceChanged: false,
      lagDocs: 0,
      docCount: 0,
      candidates: 0,
      poolSize: 0,
      filteredOut: 0,
      hashMs: 0,
      embedMs: 0,
      scoreMs: 0,
      totalMs: performance.now() - t0,
    },
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error('engram-bridge: 候选查询已被取消');
    (error as { kind?: string }).kind = 'cancelled';
    throw error;
  }
}

/**
 * Delete the index files without creating anything. Only for an index that
 * cannot be read at all; a routine rebuild goes through `sync({ full: true })`,
 * which clears and refills in one transaction. The lock file is not ours to
 * delete here — the holder is us (design D5/D6).
 */
function discardIndexFiles(indexPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${indexPath}${suffix}`, { force: true });
    } catch {
      /* a file we cannot unlink is not fatal: opening recreates it */
    }
  }
}

/**
 * The two source columns the derived index deliberately does not carry, read
 * back for the candidates we are about to show.
 *
 * One `IN (...)` over at most the displayed candidates, on a read-only handle,
 * inside the worker (design D12). They are NOT folded into the index on purpose:
 * `topic_key` changes on every upsert, and `session_id` is written once per
 * observation — folding them in would put cheap side-reads into the expensive
 * index and cost a schema bump plus a full rebuild.
 *
 * Any failure returns an empty map: the two evidence lines that use it then
 * simply do not appear, and the candidates still ship.
 */
function readSourceExtras(
  dbPath: string,
  ids: readonly number[],
): Map<number, { topicKey: string; sessionId: string }> {
  const out = new Map<number, { topicKey: string; sessionId: string }>();
  if (ids.length === 0) return out;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${CANDIDATE_BUSY_TIMEOUT_MS}`);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, topic_key, session_id FROM observations WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; topic_key: string | null; session_id: string | null }>;
    for (const row of rows) {
      out.set(row.id, { topicKey: row.topic_key ?? '', sessionId: row.session_id ?? '' });
    }
  } catch {
    /* the candidates still ship without those two lines */
  } finally {
    try {
      db?.close();
    } catch {
      /* a handle we cannot close is not worth failing a save over */
    }
  }
  return out;
}
