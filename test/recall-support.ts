import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EmbedderLike } from '../dist/recall/index-db.js';
import { documentText } from '../dist/recall/index-db.js';

/**
 * Test-only helpers for the read layer.
 *
 * Everything here is synthetic: no real corpus, no binary fixture, and no model.
 * The embedding half is replaced by an injected deterministic embedder, which is
 * exactly why the engine takes an `embedder` factory instead of constructing one
 * — the repo-side tests must not depend on a 95 MB third-party artifact.
 */

export interface SourceRow {
  id: number;
  title: string;
  content: string;
  type?: string;
  project?: string;
  scope?: string;
  updatedAt?: string;
  deleted?: boolean;
}

export function tempDir(prefix = 'recall-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Create an engram-shaped source database with `observations`. */
export function writeSource(path: string, rows: readonly SourceRow[]): void {
  // Always a fresh source: tests mutate the corpus between syncs, and the point
  // of the mutation is to change the CONTENT, not to hit a DDL error.
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE observations(' +
      'id INTEGER PRIMARY KEY, title TEXT, content TEXT, type TEXT, project TEXT, scope TEXT, ' +
      'created_at TEXT, updated_at TEXT, deleted_at TEXT)',
  );
  const insert = db.prepare('INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)');
  for (const row of rows) {
    insert.run(
      row.id,
      row.title,
      row.content,
      row.type ?? 'manual',
      row.project ?? 'alpha',
      row.scope ?? 'project',
      '2026-01-01T00:00:00Z',
      row.updatedAt ?? '2026-01-01T00:00:00Z',
      row.deleted === true ? '2026-02-01T00:00:00Z' : null,
    );
  }
  db.close();
}

/** The canonical source hash, recomputed independently of the implementation. */
export function expectedSourceHash(rows: readonly SourceRow[]): string {
  const active = rows.filter((row) => row.deleted !== true).sort((a, b) => a.id - b.id);
  const hash = createHash('sha256');
  for (const row of active) {
    const content = row.content;
    hash.update(
      Buffer.from(
        `${row.id}\x1f${row.updatedAt ?? '2026-01-01T00:00:00Z'}\x1f${Array.from(content).length}\x1f${content}\x1e`,
        'utf8',
      ),
    );
  }
  return hash.digest('hex');
}

export interface FakeEmbedderOptions {
  dim?: number;
  /** Explicit vector per text; anything else falls back to the deterministic hash. */
  vectors?: ReadonlyMap<string, readonly number[]>;
  /** Called with each batch exactly as the caller passed it. */
  onEmbed?: (texts: readonly string[], batchIndex: number) => void;
  /** Throw instead of returning, for the batch containing this 0-based text index. */
  failOnTextIndex?: number;
}

/**
 * Deterministic stand-in for the embedding runtime.
 *
 * Vectors are a pure function of the text, never of the batch, so batching
 * cannot change them — the same property the real model was measured to have
 * (V2b: bit-equal across batch 1/8/32).
 */
export function fakeEmbedder(options: FakeEmbedderOptions = {}): EmbedderLike {
  const dim = options.dim ?? 8;
  let calls = 0;
  let seen = 0;
  return {
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      const batchIndex = calls++;
      options.onEmbed?.(texts, batchIndex);
      return texts.map((text) => {
        const index = seen++;
        if (options.failOnTextIndex === index) {
          throw new Error(`synthetic embed failure at text ${index}`);
        }
        const explicit = options.vectors?.get(text);
        if (explicit !== undefined) {
          if (explicit.length !== dim) {
            throw new Error(`explicit vector for ${JSON.stringify(text)} has length ${explicit.length}, want ${dim}`);
          }
          return normalise(explicit);
        }
        const digest = createHash('sha256').update(text, 'utf8').digest();
        const values = new Array<number>(dim);
        for (let i = 0; i < dim; i++) values[i] = (digest[i % digest.length]! - 127.5) / 128;
        return normalise(values);
      });
    },
  };
}

export function normalise(values: readonly number[]): Float32Array {
  let sum = 0;
  for (const value of values) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i]! / norm;
  return out;
}

/** Vector map for the exact strings the engine will embed (`title\ncontent`). */
export function vectorMap(
  entries: ReadonlyArray<{ text: string; vector: readonly number[] }>,
): Map<string, readonly number[]> {
  return new Map(entries.map((entry) => [entry.text, entry.vector]));
}

export function docText(row: SourceRow): string {
  return documentText({ title: row.title, content: row.content });
}

/** Cosine of two unit vectors, to predict the order a 4-dim fixture will produce. */
export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Create a COMPLETE, synthetic model directory.
 *
 * `src/recall/model-dir.ts` only checks that the expected parts exist, so a stub
 * layout satisfies the installation gate. The runtime files are placeholders
 * unless a caller supplies a working stub module — which is exactly how
 * test/recall-embed.test.ts exercises the batching contract without the real
 * 95 MB model.
 */
export interface ModelDirOptions {
  ortEntrySource?: string;
  tokenizerJson?: unknown;
  modelMaxLength?: number;
}

export function fakeModelDir(root: string, options: ModelDirOptions = {}): string {
  const dir = join(root, 'model');
  const pkg = join(dir, 'node_modules', 'onnxruntime-web');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'onnxruntime-common'), { recursive: true });
  writeFileSync(join(dir, 'model_optimized.onnx'), 'stub model bytes');
  writeFileSync(
    join(dir, 'tokenizer_config.json'),
    JSON.stringify({ model_max_length: options.modelMaxLength ?? 512 }),
  );
  writeFileSync(join(dir, 'tokenizer.json'), JSON.stringify(options.tokenizerJson ?? minimalTokenizerJson()));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'onnxruntime-web', version: 'stub' }));
  writeFileSync(join(pkg, 'dist', 'ort.node.min.mjs'), options.ortEntrySource ?? 'export const env = { wasm: {} };\n');
  writeFileSync(join(pkg, 'dist', 'ort-wasm-simd-threaded.mjs'), 'export default {};\n');
  writeFileSync(join(pkg, 'dist', 'ort-wasm-simd-threaded.wasm'), 'stub\n');
  return dir;
}

/** A tiny WordPiece vocabulary: enough to pin normalization, punctuation and truncation. */
export function minimalTokenizerJson(vocab: Record<string, number> = {}): unknown {
  return {
    model: {
      vocab: {
        '[PAD]': 0,
        '[UNK]': 1,
        '[CLS]': 2,
        '[SEP]': 3,
        hello: 4,
        world: 5,
        '##s': 6,
        a: 7,
        b: 8,
        c: 9,
        中: 10,
        文: 11,
        ...vocab,
      },
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      unk_token: '[UNK]',
    },
    post_processor: {
      // The token NAME lives in `id`, next to the numeric ids under `ids` — the
      // real tokenizer.json does exactly this.
      special_tokens: { '[CLS]': { id: '[CLS]', ids: [2] }, '[SEP]': { id: '[SEP]', ids: [3] } },
    },
  };
}
