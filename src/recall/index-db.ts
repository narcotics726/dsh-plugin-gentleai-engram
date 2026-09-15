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
 *   ops/readlayer-eng/liveindex/liveindex.py
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

export type SyncMode = 'noop' | 'hash-only' | 'incremental' | 'full';

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
}

/**
 * Cap on how many documents one call may sync inline. Beyond it the call is
 * refused with an explicit reason instead of syncing for an unbounded time
 * inside a turn that is waiting for the result. The threshold is provisional: it
 * is listed as an Open Question in the change and needs a real backlog
 * measurement before it is treated as tuned.
 */
export const MAX_INLINE_SYNC_DOCS = 500;

export class BacklogError extends Error {
  readonly kind = 'backlog';
  constructor(pending: number, indexPath: string) {
    super(
      `engram-bridge: 索引落后较多（待同步 ${pending} 条 > 单次调用上限 ${MAX_INLINE_SYNC_DOCS}），` +
        '为避免在一个正在等结果的回合里无限期同步，本次检索已拒绝。' +
        `删除索引目录里的 ${indexPath} 后下一次检索会重建（或改用更小的批量）。`,
    );
    this.name = 'BacklogError';
  }
}

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
  static open(indexPath: string): IndexDb {
    mkdirSync(dirname(indexPath), { recursive: true });
    const db = new DatabaseSync(indexPath);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec(SCHEMA.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS '));
    return new IndexDb(indexPath, db);
  }

  /** Delete and recreate: used before a full build and to recover a corrupt file. */
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
   * and rebuilds. Both paths run inside one SQLite transaction, which is the
   * atomicity unit: a kill mid-update rolls the whole thing back.
   */
  async sync(
    state: SourceState,
    embed: EmbedderLike,
    options: SyncOptions = {},
  ): Promise<SyncMetering> {
    const hashMs = options.hashMs ?? 0;
    const t0 = performance.now();
    const stored = this.storedHash();
    // An index that has never been built (empty stored hash) needs a full build,
    // not a delta: every document would be "changed" and the delta path would
    // trip the backlog cap instead of doing the one honest thing.
    const mode: SyncMode =
      options.full === true || stored === '' ? 'full' : stored === state.hash ? 'noop' : 'incremental';
    if (mode === 'noop') {
      return this.metering(state, false, 0, hashMs, t0, 0, 'noop');
    }

    const have = new Map<number, [string, string]>();
    if (mode === 'incremental') {
      for (const row of this.db
        .prepare('SELECT doc_id, updated_at, content_sha FROM docs')
        .all() as Array<{ doc_id: number; updated_at: string; content_sha: string }>) {
        have.set(row.doc_id, [row.updated_at, row.content_sha]);
      }
    }

    const want = new Map<number, [string, string]>();
    for (const doc of state.docs) want.set(doc.id, [doc.updatedAt, contentSha(doc.title, doc.content)]);

    let changed: SourceDoc[] = state.docs;
    let removed: number[] = [];
    if (mode === 'incremental') {
      changed = [];
      for (const doc of state.docs) {
        const key = want.get(doc.id)!;
        if (have.get(doc.id)?.[0] !== key[0] || have.get(doc.id)?.[1] !== key[1]) changed.push(doc);
      }
      removed = [...have.keys()].filter((id) => !want.has(id)).sort((a, b) => a - b);
      if (changed.length === 0 && removed.length === 0) {
        // The hash moved but no document did (e.g. only a volatile column).
        this.db.exec('BEGIN IMMEDIATE');
        this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('source_hash', state.hash);
        this.db.exec('COMMIT');
        return this.metering(state, true, 0, hashMs, t0, 0, 'hash-only');
      }
    }

    const touched = [...changed.map((d) => d.id), ...removed];
    if (mode === 'incremental' && touched.length > MAX_INLINE_SYNC_DOCS) {
      throw new BacklogError(touched.length, this.path);
    }

    // Embed BEFORE opening the write transaction: an embedding failure must not
    // leave a half-applied index, and holding a write lock across a slow WASM
    // call would block the source for no reason.
    const vectors = new Map<number, Float32Array>();
    if (changed.length > 0) {
      const embedded = await embed.embed(changed.map((doc) => documentText(doc)));
      if (embedded.length !== changed.length) {
        throw new Error(
          `engram-bridge: 嵌入器返回 ${embedded.length} 个向量，但待嵌入文档为 ${changed.length} 个`,
        );
      }
      changed.forEach((doc, index) => vectors.set(doc.id, embedded[index]!));
    }

    const { docRows, entries } = applyDocs(changed);
    const prefix = `${process.pid}-${Date.now()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
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

  private metering(
    state: SourceState,
    sourceChanged: boolean,
    docsTouched: number,
    hashMs: number,
    t0: number,
    embedDocs: number,
    mode: SyncMode,
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
      docCount: state.docs.length,
      indexBytes,
    };
  }
}

function* chunksOf(ids: readonly number[], size = 900): Generator<number[]> {
  for (let i = 0; i < ids.length; i += size) yield ids.slice(i, i + size);
}
