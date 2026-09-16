import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codePointCompare, codePointLength, tokenize, type Token } from './tokenizer.js';
import { expectedIdentityDigest } from './model-expected.js';

/**
 * Derived read index: schema, transactional source snapshot, incremental sync,
 * full build.
 *
 * PROVENANCE: the update shape is a port of the verified prototype
 *   liveindex/liveindex.py (the spike tree was removed 2026-09-15; this
 *   repository is now the only copy — the digest below still identifies it)
 *   sha256 52b1e91419ead57f9e7eced3c4470c4e1cf262b0b75263815494fec2291df571
 * whose four properties were verified there and are NOT re-derived here:
 *   V1 the rows and the hash of exactly those rows are one snapshot (explicit
 *      `BEGIN`; without it, tearing was reproduced 79.4% of the time)
 *   V2 an incremental update is row-equal (lexical) and bit-equal (vectors) to a
 *      full rebuild, independent of batch size
 *   V3 an observation written moments ago is retrievable
 *   V4 SQLite's own transaction is a sufficient atomicity unit (SIGKILL mid
 *      update rolls back cleanly, `integrity_check` = ok)
 *
 * The one deliberate change from the prototype: `docs` also carries
 * `title/content/type/project/scope`. The prototype had only counts, so it could
 * neither render a result nor filter one, and deriving the type/project domains
 * needed a second source. The display copy is refreshed in the SAME transaction
 * as the rest of the row, and is recomputable from the source, so this does not
 * create a second source of truth.
 */

export const ALGO_VERSION = 'bigram-live-v2';

/**
 * Build-time scoring constants. This is the ONLY place they are declared; the
 * scorer reads them back out of the index `meta` table, so an index and the
 * constants that ordered it can never disagree. Values are the reference
 * implementation's (bigram_lib DEFAULT_*), verified as the tuned defaults.
 */
export const SCORING = {
  k1: 1.2,
  b: 0.2,
  titleWeight: 3.0,
  evidenceWeight: 0.25,
} as const;

/**
 * Port of `bigram_lib.source_hash`: sha256 over (id, updated_at, len(content),
 * content) of every active row in ascending id order, where `len` counts code
 * points. Byte-for-byte the same stream as the Python reference, so an index
 * built here is comparable with one built there.
 */
export const SOURCE_HASH_FORMULA =
  "sha256 over, for each active row in ascending id order, the UTF-8 bytes of '{id}\\x1f{updated_at}\\x1f{len(content)}\\x1f{content}\\x1e'";

export interface SourceDoc {
  id: number;
  title: string;
  content: string;
  type: string;
  project: string;
  scope: string;
  updatedAt: string;
}

export interface SourceState {
  docs: SourceDoc[];
  hash: string;
  totalContentChars: number;
}

/** Python `str(float)`: keeps a fractional part, so 3 renders as "3.0". */
export function pythonFloatStr(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

export function contentSha(title: string, content: string): string {
  return createHash('sha256').update(`${title}\u0000${content}`, 'utf8').digest('hex');
}

/** The text a document vector is computed from (matches embed-probe/probe.py). */
export function documentText(doc: { title: string; content: string }): string {
  return `${doc.title}\n${doc.content}`;
}

export const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE docs(
  doc_id        INTEGER PRIMARY KEY,
  updated_at    TEXT    NOT NULL,
  content_sha   TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  scope         TEXT    NOT NULL,
  title_chars   INTEGER NOT NULL,
  content_chars INTEGER NOT NULL,
  n_tokens      INTEGER NOT NULL
);
CREATE TABLE postings(
  token      TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  doc_id     INTEGER NOT NULL,
  tf_title   INTEGER NOT NULL,
  tf_content INTEGER NOT NULL,
  PRIMARY KEY (token, kind, doc_id)
) WITHOUT ROWID;
CREATE TABLE terms(
  token TEXT    NOT NULL,
  kind  TEXT    NOT NULL,
  df    INTEGER NOT NULL,
  PRIMARY KEY (token, kind)
) WITHOUT ROWID;
CREATE TABLE vectors(
  doc_id INTEGER PRIMARY KEY,
  model  TEXT    NOT NULL,
  dim    INTEGER NOT NULL,
  vec    BLOB    NOT NULL
);
`;

const VECTOR_MODEL = 'bge';

export class SourceMissingError extends Error {
  readonly kind = 'source-missing';
  constructor(dbPath: string) {
    super(`engram-bridge: engram 正本数据库不存在：${dbPath}（配置项 searchDbPath）`);
    this.name = 'SourceMissingError';
  }
}

/**
 * Read one consistent snapshot of the source: the rows AND the hash of exactly
 * those rows. Both SELECTs run inside one explicit transaction; node:sqlite is
 * in autocommit mode otherwise, so without `BEGIN` a writer committing between
 * them can produce a hash that disagrees with the content (V1).
 */
export function readSourceState(dbPath: string): SourceState {
  if (!existsSync(dbPath)) throw new SourceMissingError(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    let rows: Array<{ id: number; updated_at: string | null; title: string | null; content: string | null; type: string | null; project: string | null; scope: string | null }>;
    try {
      rows = db
        .prepare(
          'SELECT id, updated_at, title, content, type, project, scope FROM observations ' +
            'WHERE deleted_at IS NULL ORDER BY id',
        )
        .all() as typeof rows;
    } finally {
      db.exec('COMMIT');
    }
    const h = createHash('sha256');
    let totalContentChars = 0;
    const docs: SourceDoc[] = [];
    for (const row of rows) {
      const content = row.content ?? '';
      const updatedAt = row.updated_at ?? '';
      const len = codePointLength(content);
      h.update(Buffer.from(`${row.id}\x1f${updatedAt}\x1f${len}\x1f${content}\x1e`, 'utf8'));
      totalContentChars += len;
      docs.push({
        id: row.id,
        title: row.title ?? '',
        content,
        type: row.type ?? '',
        project: row.project ?? '',
        scope: row.scope ?? '',
        updatedAt,
      });
    }
    return { docs, hash: h.digest('hex'), totalContentChars };
  } finally {
    db.close();
  }
}

export interface IndexInspection {
  needsFullBuild: boolean;
  reason: 'missing' | 'unreadable' | 'no-meta' | 'algo-mismatch' | 'model-mismatch' | 'ok';
  storedHash?: string;
  algoVersion?: string;
  storedIdentity?: string;
}

/**
 * Meta key holding the identity of the model/runtime the vectors were computed
 * with.
 *
 * It has to cover the model WEIGHTS. The `vectors.model` column is a coarse tag
 * (`bge`), and the runtime's directory fingerprint does not change when
 * `model_optimized.onnx` is swapped — so without this key a model change would
 * be invisible, and the index would keep answering from the previous vector
 * space: the new model's query vector compared against the old model's document
 * vectors, silently and indefinitely (design D10).
 */
export const IDENTITY_META_KEY = 'embedding_identity';

/**
 * Cheap pre-flight check, done BEFORE opening the index for use. A full build is
 * expensive and must not happen inside the resident (low-thread) process: the
 * caller uses this to route the build to a temporary high-thread process.
 */
export function inspectIndex(
  indexPath: string,
  identityDigest: string = expectedIdentityDigest(),
): IndexInspection {
  if (!existsSync(indexPath)) return { needsFullBuild: true, reason: 'missing' };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(indexPath, { readOnly: true });
    const meta = readMetaMap(db);
    if (meta.get('algo_version') === undefined) return { needsFullBuild: true, reason: 'no-meta' };
    const algoVersion = meta.get('algo_version');
    if (algoVersion !== ALGO_VERSION) {
      return { needsFullBuild: true, reason: 'algo-mismatch', algoVersion };
    }
    const storedHash = meta.get('source_hash');
    if (storedHash === undefined || storedHash === '') return { needsFullBuild: true, reason: 'no-meta' };
    const storedIdentity = meta.get(IDENTITY_META_KEY);
    // No key at all means the index predates this check: it cannot be told
    // apart from one built by another model, so it is treated as needing a
    // rebuild rather than as trustworthy.
    if (storedIdentity === undefined || storedIdentity === '') {
      return { needsFullBuild: true, reason: 'no-meta', storedHash, algoVersion };
    }
    if (storedIdentity !== identityDigest) {
      return {
        needsFullBuild: true,
        reason: 'model-mismatch',
        storedHash,
        algoVersion,
        storedIdentity,
      };
    }
    return { needsFullBuild: false, reason: 'ok', storedHash, algoVersion, storedIdentity };
  } catch {
    return { needsFullBuild: true, reason: 'unreadable' };
  } finally {
    try {
      db?.close();
    } catch {
      /* an index we cannot even close is still going to be rebuilt */
    }
  }
}

function readMetaMap(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) {
    out.set(row.key, row.value);
  }
  return out;
}

export interface EmbedderLike {
  /** L2-normalised vectors, one per input text. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export type SyncMode = 'noop' | 'hash-only' | 'incremental' | 'full' | 'deferred';

/** How much work a sync would do: what it is, and how many documents it touches. */
export interface SyncPlan {
  mode: SyncMode;
  touched: number;
}

export interface SyncMetering {
  /** Whether the source changed since the last successful update. */
  sourceChanged: boolean;
  /** Active rows read from the source in this call's snapshot. */
  rowsScanned: number;
  /** Documents the delta actually touched (changed + removed). */
  docsTouched: number;
  /** Time spent reading and hashing the source snapshot. */
  hashMs: number;
  /** Time spent applying the delta (excluding the source read). */
  syncMs: number;
  embedDocs: number;
  mode: SyncMode;
  /** Documents this call declined to touch, present when `mode === 'deferred'`. */
  pendingDocs?: number;
  docCount: number;
  indexBytes: number;
}

export interface SyncOptions {
  /** Measure of the source snapshot read + hash, taken by the caller. */
  hashMs?: number;
  /** Force a wipe-and-rebuild instead of a delta. */
  full?: boolean;
  /**
   * Identity of the model/runtime the vectors being written were computed with.
   * Defaults to the repository's declaration, the same value `inspectIndex`
   * compares against — one accessor, so the writer and the checker cannot drift
   * apart (design D10).
   */
  identityDigest?: string;
  /**
   * How many documents this call may touch (changed + removed). Absent means
   * unlimited — a mechanism default that only test fixtures and the operator
   * request may use; every other product path passes a real cap (design D2).
   * Over the cap nothing is embedded and nothing is written: the call returns
   * `mode: 'deferred'` with `pendingDocs`, and the caller decides.
   */
  maxDocs?: number;
  /**
   * Called between embedding slices. The lock holder supplies a heartbeat here
   * (`design.md` D6), so a long run keeps proving progress.
   */
  onProgress?: () => void;
  /**
   * Called right after the write transaction opens. The lock holder re-checks
   * that it still owns the lock here: the embedding gap is long, so a check
   * "before the transaction" proves nothing (design D6).
   */
  assertStillHeld?: () => void;
  /**
   * The index's own `source_hash` as read under the lock. If another writer
   * committed during the embedding gap this no longer matches, and the write
   * must be abandoned rather than regress the index.
   */
  expectedStoredHash?: string;
}

/** Per-call write-lock wait; a resident call must fail fast, not eat its budget. */
export const DEFAULT_BUSY_TIMEOUT_MS = 60_000;

/**
 * Documents per embedding slice. Mirrors the embedder's own hard batch ceiling
 * (`embed.ts` MAX_BATCH = 32) and exists so the writer can heartbeat between
 * slices; a test asserts the two constants stay in step (`design.md` D6).
 */
export const EMBED_SLICE_DOCS = 32;

interface PostingEntry {
  token: string;
  kind: string;
  docs: Map<number, [number, number]>;
}

function bump(entry: PostingEntry | undefined, token: Token, docId: number, field: 0 | 1): void {
  if (entry === undefined) return;
  const cur = entry.docs.get(docId);
  if (cur === undefined) entry.docs.set(docId, field === 0 ? [1, 0] : [0, 1]);
  else cur[field] += 1;
}

function applyDocs(
  docs: readonly SourceDoc[],
): { docRows: unknown[][]; entries: PostingEntry[] } {
  const post = new Map<string, PostingEntry>();
  const docRows: unknown[][] = [];
  for (const doc of docs) {
    const tt = tokenize(doc.title);
    const ct = tokenize(doc.content);
    docRows.push([
      doc.id,
      doc.updatedAt,
      contentSha(doc.title, doc.content),
      doc.title,
      doc.content,
      doc.type,
      doc.project,
      doc.scope,
      codePointLength(doc.title),
      codePointLength(doc.content),
      tt.length + ct.length,
    ]);
    const touch = (token: Token, field: 0 | 1): void => {
      const key = `${token[1]}\u0000${token[0]}`;
      let entry = post.get(key);
      if (entry === undefined) {
        entry = { token: token[0], kind: token[1], docs: new Map() };
        post.set(key, entry);
      }
      bump(entry, token, doc.id, field);
    };
    for (const token of tt) touch(token, 0);
    for (const token of ct) touch(token, 1);
  }
  const entries = [...post.values()].sort((a, b) => {
    const c = codePointCompare(a.token, b.token);
    return c !== 0 ? c : codePointCompare(a.kind, b.kind);
  });
  return { docRows, entries };
}

const INSERT_DOC =
  'INSERT INTO docs(doc_id, updated_at, content_sha, title, content, type, project, scope, ' +
  'title_chars, content_chars, n_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)';

export class IndexDb {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.db = db;
  }

  /** Open an existing index, or create an empty one. */
  static open(indexPath: string, options: { busyTimeoutMs?: number } = {}): IndexDb {
    mkdirSync(dirname(indexPath), { recursive: true });
    const db = new DatabaseSync(indexPath);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    // A resident call's whole budget is ~60 s, so waiting 60 s on SQLite's write
    // lock would be killed by the host with nothing committed (zero progress).
    // Callers pass a per-path value (design D6).
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`);
    db.exec(SCHEMA.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS '));
    return new IndexDb(indexPath, db);
  }

  /**
   * Delete and recreate: only for an index that cannot be read at all (missing
   * or corrupt), never for a routine rebuild — a routine rebuild goes through
   * `sync({ full: true })`, which clears and refills inside ONE transaction.
   * The lock file is deliberately NOT in this list: the holder recreates while
   * holding it, so deleting it would drop our own lock (design D5/D6).
   */
  static recreate(indexPath: string): IndexDb {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${indexPath}${suffix}`, { force: true });
      } catch {
        /* a -shm file we cannot unlink is not fatal: opening recreates it */
      }
    }
    const opened = IndexDb.open(indexPath);
    opened.db.exec('BEGIN');
    opened.db.prepare('INSERT INTO meta VALUES (?,?)').run('algo_version', ALGO_VERSION);
    opened.db.prepare('INSERT INTO meta VALUES (?,?)').run('source_hash', '');
    opened.db.exec('COMMIT');
    return opened;
  }

  meta(): Map<string, string> {
    return readMetaMap(this.db);
  }

  storedHash(): string {
    return this.meta().get('source_hash') ?? '';
  }

  /** True when a crash left the in-progress marker behind: a broken invariant. */
  updatePrefixPresent(): boolean {
    return this.meta().has('update_prefix');
  }

  integrityOk(): boolean {
    const row = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    return row?.integrity_check === 'ok';
  }

  docIds(): number[] {
    return (this.db.prepare('SELECT doc_id FROM docs ORDER BY doc_id').all() as Array<{ doc_id: number }>).map(
      (r) => r.doc_id,
    );
  }

  docCount(): number {
    return Number((this.db.prepare('SELECT count(*) AS c FROM docs').get() as { c: number }).c);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Raw handle for the scorer's read-only queries. */
  get handle(): DatabaseSync {
    return this.db;
  }

  /**
   * Bring the index to `state`, touching only what changed. `mode: 'full'` wipes
   * and refills inside ONE transaction. Both paths run inside that transaction,
   * which is the atomicity unit: a kill mid-update rolls the whole thing back.
   *
   * `maxDocs` is the caller's cap on this call's work (changed + removed) — the
   * one judgement shared by every path and both modes. Over it nothing is
   * embedded and nothing is written: the outcome is `mode: 'deferred'` with
   * `pendingDocs`, and the caller decides whether to hand off or refuse.
   */
  async sync(
    state: SourceState,
    embed: EmbedderLike,
    options: SyncOptions = {},
  ): Promise<SyncMetering> {
    const hashMs = options.hashMs ?? 0;
    const t0 = performance.now();
    const { mode, changed, removed } = this.diffFor(state, options.full === true);
    if (mode === 'noop') {
      return this.metering(state, false, 0, hashMs, t0, 0, 'noop');
    }
    if (mode === 'incremental' && changed.length === 0 && removed.length === 0) {
      // The hash moved but no document did (e.g. only a volatile column).
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.assertWriteAllowed(options);
        this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('source_hash', state.hash);
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* the transaction is already gone */
        }
        throw error;
      }
      return this.metering(state, true, 0, hashMs, t0, 0, 'hash-only');
    }

    const touched = [...changed.map((d) => d.id), ...removed];
    const maxDocs = options.maxDocs ?? Number.POSITIVE_INFINITY;
    if (touched.length > maxDocs) {
      return this.metering(state, true, 0, hashMs, t0, 0, 'deferred', touched.length);
    }

    // Embed BEFORE opening the write transaction: an embedding failure must not
    // leave a half-applied index. Sliced so the lock holder can heartbeat
    // between slices; vectors are batch-independent, so slicing cannot change
    // them (V2b).
    const vectors = new Map<number, Float32Array>();
    if (changed.length > 0) {
      const texts = changed.map((doc) => documentText(doc));
      const embedded: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += EMBED_SLICE_DOCS) {
        const slice = texts.slice(start, start + EMBED_SLICE_DOCS);
        embedded.push(...(await embed.embed(slice)));
        options.onProgress?.();
      }
      if (embedded.length !== changed.length) {
        throw new Error(
          `engram-bridge: 嵌入器返回 ${embedded.length} 个向量，但待嵌入文档为 ${changed.length} 个`,
        );
      }
      changed.forEach((doc, index) => vectors.set(doc.id, embedded[index]!));
    }

    const { docRows, entries } = applyDocs(changed);
    const prefix = `${process.pid}-${Date.now()}`;
    // Last cheap heartbeat: the closing stretch (applyDocs + the transaction)
    // has no other progress point (design D6).
    options.onProgress?.();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertWriteAllowed(options);
      this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('update_prefix', prefix);
      // Every (token, kind) whose row count MAY have changed: those currently
      // posted for a touched document, plus every term of the incoming docs.
      const affected = new Set<string>();
      if (mode === 'full') {
        this.db.exec('DELETE FROM postings');
        this.db.exec('DELETE FROM terms');
        this.db.exec('DELETE FROM docs');
        this.db.exec('DELETE FROM vectors');
      } else {
        for (const chunk of chunksOf(touched)) {
          const placeholders = chunk.map(() => '?').join(',');
          for (const row of this.db
            .prepare(`SELECT DISTINCT token, kind FROM postings WHERE doc_id IN (${placeholders})`)
            .all(...chunk) as Array<{ token: string; kind: string }>) {
            affected.add(`${row.kind}\u0000${row.token}`);
          }
          this.db.prepare(`DELETE FROM postings WHERE doc_id IN (${placeholders})`).run(...chunk);
          this.db.prepare(`DELETE FROM docs WHERE doc_id IN (${placeholders})`).run(...chunk);
          this.db.prepare(`DELETE FROM vectors WHERE doc_id IN (${placeholders})`).run(...chunk);
        }
      }

      const insDoc = this.db.prepare(INSERT_DOC);
      for (const row of docRows) insDoc.run(...(row as never[]));

      const insPost = this.db.prepare('INSERT INTO postings VALUES (?,?,?,?,?)');
      for (const entry of entries) {
        for (const docId of [...entry.docs.keys()].sort((a, b) => a - b)) {
          const [tfTitle, tfContent] = entry.docs.get(docId)!;
          insPost.run(entry.token, entry.kind, docId, tfTitle, tfContent);
        }
      }

      if (mode === 'full') {
        // Every posting comes from `entries`, so df is known without a count query.
        const insTerm = this.db.prepare('INSERT INTO terms VALUES (?,?,?)');
        for (const entry of entries) insTerm.run(entry.token, entry.kind, entry.docs.size);
      } else {
        for (const entry of entries) affected.add(`${entry.kind}\u0000${entry.token}`);
        this.repairTerms(affected);
      }

      const insVec = this.db.prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?,?)');
      for (const [docId, vec] of vectors) {
        insVec.run(docId, VECTOR_MODEL, vec.length, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
      }

      this.recomputeMeta(state, options.identityDigest);
      this.db.prepare("DELETE FROM meta WHERE key='update_prefix'").run();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone; report the original failure */
      }
      throw error;
    }
    return this.metering(state, true, changed.length + removed.length, hashMs, t0, changed.length, mode);
  }

  /** Vector for one document, or undefined when the index has none. */
  vector(docId: number): Float32Array | undefined {
    const row = this.db.prepare('SELECT dim, vec FROM vectors WHERE doc_id=?').get(docId) as
      | { dim: number; vec: Uint8Array }
      | undefined;
    if (row === undefined) return undefined;
    const copy = new Uint8Array(row.vec.byteLength);
    copy.set(row.vec);
    return new Float32Array(copy.buffer);
  }

  private repairTerms(keys: Iterable<string>): void {
    const select = this.db.prepare('SELECT count(*) AS c FROM postings WHERE token=? AND kind=?');
    const upsert = this.db.prepare('INSERT OR REPLACE INTO terms VALUES (?,?,?)');
    const drop = this.db.prepare('DELETE FROM terms WHERE token=? AND kind=?');
    const parsed = [...keys].map((key) => {
      const sep = key.indexOf('\u0000');
      return { kind: key.slice(0, sep), token: key.slice(sep + 1) };
    });
    // Reference order: sorted by (token, kind) under Python's code-point ordering.
    parsed.sort((a, b) => {
      const c = codePointCompare(a.token, b.token);
      return c !== 0 ? c : codePointCompare(a.kind, b.kind);
    });
    for (const { token, kind } of parsed) {
      const df = (select.get(token, kind) as { c: number }).c;
      if (df > 0) upsert.run(token, kind, df);
      else drop.run(token, kind);
    }
  }

  private recomputeMeta(state: SourceState, identityDigest?: string): void {
    const nTerms = (this.db.prepare('SELECT count(*) AS c FROM terms').get() as { c: number }).c;
    const nPostings = (this.db.prepare('SELECT count(*) AS c FROM postings').get() as { c: number }).c;
    const sums = this.db
      .prepare('SELECT COALESCE(sum(tf_title),0) AS t, COALESCE(sum(tf_content),0) AS c FROM postings')
      .get() as { t: number; c: number };
    const meta: Record<string, string> = {
      algo_version: ALGO_VERSION,
      // The generation these vectors belong to. Recorded on every sync, full or
      // incremental: an incremental update recomputes only the changed
      // documents, so if this were written by full builds alone, a model swap
      // followed by a delta would leave one index holding two vector spaces.
      [IDENTITY_META_KEY]: identityDigest ?? expectedIdentityDigest(),
      // Recorded for the same reason the reference records it: it is a property of
      // how the index was built (CJK bigrams only, no per-character unigrams). The
      // bridge has no unigram mode, so it is a constant until one exists — and if
      // one is added, it changes the ordering, hence `algo_version` too.
      all_cjk_unigrams: '0',
      source_hash: state.hash,
      doc_count: String(state.docs.length),
      total_content_chars: String(state.totalContentChars),
      n_terms: String(nTerms),
      n_postings: String(nPostings),
      n_title_tokens: String(sums.t),
      n_content_tokens: String(sums.c),
      scoring_k1: pythonFloatStr(SCORING.k1),
      scoring_b: pythonFloatStr(SCORING.b),
      scoring_title_weight: pythonFloatStr(SCORING.titleWeight),
      scoring_evidence_weight: pythonFloatStr(SCORING.evidenceWeight),
    };
    const upsert = this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');
    for (const [key, value] of Object.entries(meta).sort((a, b) => codePointCompare(a[0], b[0]))) {
      upsert.run(key, value);
    }
  }

  /**
   * What a sync against `state` would do — no embedding, no writes. Callers use
   * it to compare the work against their cap BEFORE loading the model, which is
   * the whole point of the operator path's cheap refusal (design D7).
   */
  planFor(state: SourceState, full = false): SyncPlan {
    const { mode, changed, removed } = this.diffFor(state, full);
    return { mode, touched: changed.length + removed.length };
  }

  /**
   * The one diff, used by both the plan and the sync itself so they cannot
   * drift. `full` (or an index that has never been built) means every document
   * is work.
   */
  private diffFor(
    state: SourceState,
    full: boolean,
  ): { mode: SyncMode; changed: SourceDoc[]; removed: number[] } {
    const stored = this.storedHash();
    const mode: SyncMode = full || stored === '' ? 'full' : stored === state.hash ? 'noop' : 'incremental';
    if (mode === 'noop') return { mode, changed: [], removed: [] };
    if (mode === 'full') return { mode, changed: state.docs, removed: [] };

    const have = new Map<number, [string, string]>();
    for (const row of this.db
      .prepare('SELECT doc_id, updated_at, content_sha FROM docs')
      .all() as Array<{ doc_id: number; updated_at: string; content_sha: string }>) {
      have.set(row.doc_id, [row.updated_at, row.content_sha]);
    }
    const want = new Map<number, [string, string]>();
    for (const doc of state.docs) want.set(doc.id, [doc.updatedAt, contentSha(doc.title, doc.content)]);
    const changed: SourceDoc[] = [];
    for (const doc of state.docs) {
      const key = want.get(doc.id)!;
      if (have.get(doc.id)?.[0] !== key[0] || have.get(doc.id)?.[1] !== key[1]) changed.push(doc);
    }
    const removed = [...have.keys()].filter((id) => !want.has(id)).sort((a, b) => a - b);
    return { mode, changed, removed };
  }

  /**
   * The write-transaction guard. Runs right after `BEGIN IMMEDIATE`, which is
   * the only place it means anything: the embedding gap before it can last
   * minutes, so a check "before the transaction" would prove nothing.
   *
   *  * `assertStillHeld` lets the lock holder verify it still owns the lock
   *    (by PATH — an fd always matches its own inode, design D6);
   *  * `expectedStoredHash` catches another writer that committed during the
   *    gap: our diff was computed against a snapshot that is no longer current,
   *    so applying it would move the index backwards.
   */
  private assertWriteAllowed(options: SyncOptions): void {
    options.assertStillHeld?.();
    if (options.expectedStoredHash !== undefined && this.storedHash() !== options.expectedStoredHash) {
      const error = new Error(
        'engram-bridge: 嵌入期间索引已被另一个写入者更新，本次写入放弃（派生数据未被改动）',
      );
      (error as { kind?: string }).kind = 'busy';
      throw error;
    }
  }

  private metering(
    state: SourceState,
    sourceChanged: boolean,
    docsTouched: number,
    hashMs: number,
    t0: number,
    embedDocs: number,
    mode: SyncMode,
    pendingDocs?: number,
  ): SyncMetering {
    let indexBytes = 0;
    try {
      indexBytes = statSync(this.path).size;
    } catch {
      /* the index may already be gone (rollback + shutdown) */
    }
    return {
      sourceChanged,
      rowsScanned: state.docs.length,
      docsTouched,
      hashMs,
      syncMs: performance.now() - t0,
      embedDocs,
      mode,
      ...(pendingDocs === undefined ? {} : { pendingDocs }),
      docCount: state.docs.length,
      indexBytes,
    };
  }
}

function* chunksOf(ids: readonly number[], size = 900): Generator<number[]> {
  for (let i = 0; i < ids.length; i += size) yield ids.slice(i, i + size);
}
