import { IndexDb, inspectIndex, readSourceState, type EmbedderLike } from './index-db.js';
import { expectedIdentityDigest } from './model-expected.js';
import { excerpt, Scorer, type CoverageVariant } from './scoring.js';
import type { RecallHit, RecallMetering, RecallPayload, RecallQuery } from './protocol.js';

/**
 * The read layer itself: bring the derived index up to date with the source,
 * rank, filter, and cut.
 *
 * Every step's arithmetic lives elsewhere (index-db for the index, scoring for
 * the ranking). What this file owns is the ordering guarantees the spec makes:
 *
 *  * ranking covers the WHOLE corpus, not just the boosted pool, and happens
 *    BEFORE filtering;
 *  * filtering never changes a score and never consumes a return slot;
 *  * the cut happens after filtering, and the truncation decision continues past
 *    the cut so that "exactly `limit` matches" and "more than `limit` matches"
 *    are distinguishable — using comparisons only, never another embedding.
 *
 * Number of documents is small enough (346 in the frozen corpus, and the design
 * accepts linear per-query cost) that a full pass over the ranking is cheaper
 * than the single query embedding it accompanies.
 */

/** Raised when the derived index cannot be trusted and must be rebuilt by a full build. */
export class RebuildNeededError extends Error {
  readonly kind = 'rebuild-needed';
  constructor(reason: string) {
    super(`engram-bridge: 派生索引需要重建（${reason}）`);
    this.name = 'RebuildNeededError';
  }
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

export class RecallEngine {
  private readonly options: RecallEngineOptions;
  private index?: IndexDb;
  private scorer?: Scorer;

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
  }

  /** Wipe and rebuild the derived index from the source. Used by `--rebuild`. */
  async rebuild(): Promise<{ docs: number; embedDocs: number; ms: number; mode: string }> {
    const t0 = performance.now();
    const state = readSourceState(this.options.dbPath);
    this.close();
    const index = IndexDb.recreate(this.options.indexPath);
    const metering = await index.sync(state, await this.options.embedder(), {
      full: true,
      identityDigest: this.identity,
    });
    this.index = index;
    this.scorer = undefined;
    return {
      docs: state.docs.length,
      embedDocs: metering.embedDocs,
      ms: performance.now() - t0,
      mode: metering.mode,
    };
  }

  async query(request: RecallQuery): Promise<RecallPayload> {
    const total0 = performance.now();
    const hash0 = performance.now();
    const state = readSourceState(this.options.dbPath);
    const hashMs = performance.now() - hash0;

    const index = this.ensureIndex();
    const embedLoad0 = performance.now();
    const embedder = await this.options.embedder();
    const embedLoadMs = performance.now() - embedLoad0;

    const metering = await index.sync(state, embedder, { hashMs, identityDigest: this.identity });
    if (metering.mode !== 'noop' || this.scorer === undefined) {
      this.scorer = new Scorer(index, this.options.dim);
    }
    const scorer = this.scorer;

    const embed0 = performance.now();
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
        // A matching document beyond the cut: there IS something not shown. The
        // loop keeps going only to finish counting `filteredOut`, which needs no
        // embedding — it is a comparison over already-loaded rows.
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
  }

  /** Type domain, computed live from the index — never cached (D7). */
  availableTypes(index: IndexDb): string[] {
    return (
      index.handle
        .prepare("SELECT DISTINCT type FROM docs WHERE type <> '' ORDER BY type")
        .all() as Array<{ type: string }>
    ).map((row) => row.type);
  }

  private ensureIndex(): IndexDb {
    if (this.index !== undefined) return this.index;
    const inspection = inspectIndex(this.options.indexPath, this.identity);
    if (inspection.needsFullBuild) throw new RebuildNeededError(inspection.reason);
    const index = IndexDb.open(this.options.indexPath);
    if (!index.integrityOk()) {
      index.close();
      throw new RebuildNeededError('integrity_check');
    }
    if (index.updatePrefixPresent()) {
      index.close();
      throw new RebuildNeededError('残留的更新标记');
    }
    const meta = index.meta();
    const missingConstant = [
      'scoring_k1',
      'scoring_b',
      'scoring_title_weight',
      'scoring_evidence_weight',
    ].find((key) => meta.get(key) === undefined);
    if (missingConstant !== undefined) {
      index.close();
      throw new RebuildNeededError(`索引缺少打分常量 ${missingConstant}`);
    }
    const docCount = index.docCount();
    const vectorCount = Number(
      (index.handle.prepare('SELECT count(*) AS c FROM vectors').get() as { c: number }).c,
    );
    if (vectorCount !== docCount) {
      index.close();
      throw new RebuildNeededError(`向量数 ${vectorCount} 与文档数 ${docCount} 不一致`);
    }
    this.index = index;
    return index;
  }
}
