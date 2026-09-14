import type { DatabaseSync } from 'node:sqlite';
import type { IndexDb } from './index-db.js';
import { distinctTokens, tokenKey, tokenize, type Token } from './tokenizer.js';

/**
 * Lexical + vector scoring over the derived index.
 *
 * PROVENANCE: port of the validated TypeScript scorer at
 *   ops/readlayer-eng/v7scorer/scorer.ts
 *   sha256 7882367c4e53415f2bb9a7f30adea07cd7c58fc520352e3eac0e0c851d035a84
 * which reproduced read.py's ranking exactly (668/668 queries identical up to
 * depth 23; the single divergence at depth 24 is a float32 accumulation-order
 * property, recorded as a known boundary and NOT treated as a bug).
 *
 * Shape of the pipeline:
 *   1. lexical candidates: docs sharing >= 1 distinct query token, ordered by
 *      (field-weighted coverage + bounded BM25 evidence) desc, doc id asc
 *   2. pool = that ordering truncated to `topK` — used ONLY to decide who gets
 *      the coverage boost, never to restrict the candidate set
 *   3. score = float32 cosine(query, doc) for EVERY document, plus `w *
 *      coverage` for pool members only
 *   4. stable sort by score desc, array position asc
 *
 * Every arithmetic choice mirrors the reference's dtypes: the lexical layer is
 * IEEE double (plain JS number), the cosine is float32 with strict left-to-right
 * accumulation, and the boost is a float32 multiply then float32 add. The
 * scoring constants are read from the index `meta` table — see index-db.ts for
 * why that is the single source.
 */

export const f32 = Math.fround;

export interface ScoringParams {
  k1: number;
  b: number;
  titleWeight: number;
  evidenceWeight: number;
}

/**
 * Read the four build-time constants out of the index `meta`.
 *
 * Deliberately NO fallback values: a fallback here would be a second declaration
 * of a constant that decides the ordering, so an index built with different
 * constants would be silently scored with the wrong ones. A missing key means the
 * index does not belong to this algorithm version — that is a rebuild, not a
 * default.
 */
export function scoringParamsFromMeta(meta: ReadonlyMap<string, string>): ScoringParams {
  const required = (key: string): number => {
    const raw = meta.get(key);
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`engram-bridge: 索引 meta 缺少可用的 ${key}（索引与打分常量不同版本，应重建）`);
    }
    return value;
  };
  return {
    k1: required('scoring_k1'),
    b: required('scoring_b'),
    titleWeight: required('scoring_title_weight'),
    evidenceWeight: required('scoring_evidence_weight'),
  };
}

/** float32 dot product, strict left-to-right (the verified primary mode). */
export function dotF32(a: Float32Array, ao: number, b: Float32Array, bo: number, d: number): number {
  let s = 0;
  for (let i = 0; i < d; i++) s = f32(s + f32(a[ao + i]! * b[bo + i]!));
  return s;
}

/** Coverage variants of the reference implementation (`COVERAGE_VARIANTS`). */
export type CoverageVariant = 'field_cov' | 'cov_n' | 'idf_cov';

export const COVERAGE_VARIANTS: readonly CoverageVariant[] = ['field_cov', 'cov_n', 'idf_cov'];

const EXCERPT_CHARS = 200;

/** `_excerpt` from the reference: collapse whitespace, cut at 200 code points. */
export function excerpt(content: string): string {
  const text = content.split(/[\s\u001c-\u001f\u0085]+/u).filter((part) => part !== '').join(' ');
  const cps = Array.from(text);
  return cps.length <= EXCERPT_CHARS ? text : `${cps.slice(0, EXCERPT_CHARS).join('')}…`;
}

export interface RankResult {
  /** Document ids in final ranked order (the whole corpus). */
  ids: number[];
  /** float32 score per rank position. */
  boosted: Float32Array;
  cosine: Float32Array;
  coverage: Float64Array;
  /** Size of the coverage-boost pool (`topK`). */
  poolSize: number;
  /** Documents sharing at least one query token. */
  candidates: number;
}

interface DocFields {
  title: Set<string>;
  type: Set<string>;
  project: Set<string>;
}

/** One (token, kind) → posting list cache, plus per-document lexical fields. */
export class Scorer {
  readonly docIds: number[];
  readonly params: ScoringParams;
  readonly dim: number;
  readonly n: number;
  private readonly pos = new Map<number, number>();
  private readonly nTokens = new Map<number, number>();
  private readonly fields = new Map<number, DocFields>();
  private readonly vectors: (Float32Array | undefined)[];
  private readonly avgdl: number;
  private readonly postCache = new Map<string, Map<number, [number, number]>>();
  private readonly stmtPost;

  constructor(index: IndexDb, dim?: number) {
    const db: DatabaseSync = index.handle;
    const meta = index.meta();
    this.params = scoringParamsFromMeta(meta);
    // Prefer the dimension the index actually recorded: it is a property of the
    // stored vectors, not a constant this file should be asserting. A mixed-dim
    // index is an inconsistency the caller must rebuild, not silently average.
    const recorded = db.prepare('SELECT DISTINCT dim FROM vectors').all() as Array<{ dim: number }>;
    if (recorded.length > 1) {
      throw new Error('engram-bridge: 索引里的向量维度不一致（索引已损坏，应重建）');
    }
    this.dim = dim ?? recorded[0]?.dim ?? 512;
    this.docIds = index.docIds();
    this.n = this.docIds.length;
    this.docIds.forEach((id, position) => this.pos.set(id, position));

    for (const row of db.prepare('SELECT doc_id, n_tokens FROM docs').all() as Array<{
      doc_id: number;
      n_tokens: number;
    }>) {
      this.nTokens.set(row.doc_id, row.n_tokens);
    }
    for (const row of db.prepare('SELECT doc_id, title, type, project FROM docs').all() as Array<{
      doc_id: number;
      title: string;
      type: string;
      project: string;
    }>) {
      this.fields.set(row.doc_id, {
        title: setOf(tokenize(row.title)),
        type: setOf(tokenize(row.type)),
        project: setOf(tokenize(row.project)),
      });
    }
    const avg = (db.prepare('SELECT avg(n_tokens) AS a FROM docs').get() as { a: number | null }).a;
    this.avgdl = typeof avg === 'number' && Number.isFinite(avg) && avg > 0 ? avg : 1.0;

    this.vectors = new Array<Float32Array | undefined>(this.n);
    for (const row of db.prepare('SELECT doc_id, dim, vec FROM vectors').all() as Array<{
      doc_id: number;
      dim: number;
      vec: Uint8Array;
    }>) {
      const position = this.pos.get(row.doc_id);
      if (position === undefined) continue;
      const copy = new Uint8Array(row.vec.byteLength);
      copy.set(row.vec);
      this.vectors[position] = new Float32Array(copy.buffer);
    }
    this.stmtPost = db.prepare('SELECT doc_id, tf_title, tf_content FROM postings WHERE token=? AND kind=?');
  }

  private postings(token: Token): Map<number, [number, number]> {
    const key = tokenKey(token);
    let cached = this.postCache.get(key);
    if (cached === undefined) {
      cached = new Map();
      for (const row of this.stmtPost.all(token[0], token[1]) as Array<{
        doc_id: number;
        tf_title: number;
        tf_content: number;
      }>) {
        cached.set(row.doc_id, [row.tf_title, row.tf_content]);
      }
      this.postCache.set(key, cached);
    }
    return cached;
  }

  /**
   * Port of `LexicalLayer.score_query(query, variant)`: every candidate ordered
   * exactly as the reference's `(-score, id)` sort.
   *
   * `ordering` is the reference's per-candidate `score` for the lexical layer
   * (coverage plus bounded BM25 evidence) — the value that decides who enters the
   * boost pool. It is returned so a test can prove the scorer reads all four
   * constants out of the index `meta` instead of carrying its own copies.
   */
  lexicalOrder(
    query: string,
    variant: CoverageVariant = 'field_cov',
  ): { ids: number[]; coverage: Float64Array; ordering: number[] } {
    const coverage = new Float64Array(this.n);
    const qd = distinctTokens(query);
    if (qd.length === 0 || this.n === 0) return { ids: [], coverage, ordering: [] };

    const post = qd.map((token) => this.postings(token));
    const df = post.map((p) => p.size);
    // math.log(1 + (N - df + 0.5)/(df + 0.5)) — all double.
    const idf = df.map((d) => Math.log(1.0 + (this.n - d + 0.5) / (d + 0.5)));

    const candidates = new Set<number>();
    for (const p of post) for (const id of p.keys()) candidates.add(id);
    const nq = qd.length;
    const totalIdf = idf.reduce((sum, value) => sum + value, 0) || 1.0;
    const { k1, b, titleWeight, evidenceWeight } = this.params;

    const rows: Array<{ id: number; score: number; cov: number }> = [];
    for (const id of [...candidates].sort((a, b2) => a - b2)) {
      const length = this.nTokens.get(id) ?? 1;
      const lnorm = 1.0 - b + (b * length) / this.avgdl;
      let raw = 0.0;
      let wmass = 0.0;
      let matched = 0;
      let mass = 0.0;
      const field = this.fields.get(id);
      for (let t = 0; t < nq; t++) {
        const tf = post[t]!.get(id);
        if (tf === undefined) continue;
        matched += 1;
        mass += idf[t]!;
        const tfe = titleWeight * tf[0] + tf[1];
        raw += (idf[t]! * (k1 + 1.0) * tfe) / (tfe + k1 * lnorm);
        const key = tokenKey(qd[t]!);
        let w = 0;
        if (field !== undefined && field.title.has(key)) w = 3;
        if (field !== undefined && (field.type.has(key) || field.project.has(key))) w = Math.max(w, 2);
        if (w === 0 && tf[1] > 0) w = 1;
        wmass += w;
      }
      let cov: number;
      if (variant === 'field_cov') cov = wmass / (3.0 * nq);
      else if (variant === 'cov_n') cov = matched / nq;
      else cov = mass / totalIdf;
      // Pool ordering matches the reference: every variant except idf_cov adds
      // the bounded BM25 evidence term.
      const ordering = variant === 'idf_cov' ? cov : cov + evidenceWeight * (raw / (raw + 1.0));
      rows.push({ id, score: ordering, cov });
    }
    rows.sort((a, b2) => (a.score !== b2.score ? (a.score > b2.score ? -1 : 1) : a.id - b2.id));
    for (const row of rows) coverage[this.pos.get(row.id)!] = row.cov;
    return { ids: rows.map((row) => row.id), coverage, ordering: rows.map((row) => row.score) };
  }

  /** Full ranking: cosine for every document plus the pool-only coverage boost. */
  rank(
    query: string,
    queryVec: Float32Array,
    options: { w: number; topK: number; coverage?: CoverageVariant },
  ): RankResult {
    const { ids: lexOrder, coverage } = this.lexicalOrder(query, options.coverage ?? 'field_cov');
    const pool = options.topK > 0 ? lexOrder.slice(0, options.topK) : lexOrder.slice();

    const cosine = new Float32Array(this.n);
    for (let j = 0; j < this.n; j++) {
      const vec = this.vectors[j];
      cosine[j] = vec === undefined ? 0 : dotF32(queryVec, 0, vec, 0, this.dim);
    }

    const boosted = new Float32Array(cosine);
    for (const id of pool) {
      const j = this.pos.get(id)!;
      boosted[j] = f32(boosted[j]! + f32(options.w * coverage[j]!));
    }

    const order = Array.from({ length: this.n }, (_, i) => i);
    order.sort((a, b) => (boosted[a]! !== boosted[b]! ? (boosted[a]! > boosted[b]! ? -1 : 1) : a - b));
    return {
      ids: order.map((j) => this.docIds[j]!),
      boosted: new Float32Array(order.map((j) => boosted[j]!)),
      cosine: new Float32Array(order.map((j) => cosine[j]!)),
      coverage: new Float64Array(order.map((j) => coverage[j]!)),
      poolSize: pool.length,
      candidates: lexOrder.length,
    };
  }
}

function setOf(tokens: Token[]): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) out.add(tokenKey(token));
  return out;
}
