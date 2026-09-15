import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type * as OrtNs from 'onnxruntime-web';
import { BertTokenizer } from './bert-tokenizer.js';
import { assertModelDir, type ModelPaths } from './model-dir.js';

/**
 * text -> unit float32[512] via onnxruntime-web (pure WASM, CPU EP).
 *
 * PROVENANCE: port of the validated spike at
 *   wasmspike/embed.ts (the spike tree was removed 2026-09-15; this repository
 *   is now the only copy — the digest below still identifies it)
 *   sha256 947564f9218fbb336751b8385513d292f18c4e8b5cf4494a53bd5f91ecc7fa31
 * Replicates fastembed 0.8.0's `OnnxTextEmbedding` post-processing for
 * BAAI/bge-small-zh-v1.5, confirmed numerically in the spike:
 *   embeddings = last_hidden_state[:, 0]                    # CLS pooling, NOT mean
 *   out        = embeddings / max(||embeddings||, 1e-12)    # L2 normalise
 * Batching mirrors fastembed: pad each batch to its own longest sequence (pad id
 * 0) and let attention_mask hide the pads. Batch size 32 is a hard ceiling (346
 * documents in ONE batch aborts the process with `std::bad_alloc`).
 *
 * The runtime is loaded by absolute path from the model directory rather than as
 * a package import, so the shipped artifact is the pruned 14.59 MB copy and not
 * whatever happens to be in node_modules. `import type` above is erased at build
 * time and pulls in nothing at runtime.
 *
 * This module must only ever be reachable from the worker subprocess entry. Hard
 * rule 7 forbids loading it in the host process; `scripts/check-recall-boundary.mjs`
 * fails the build if the host entry's import closure ever reaches it.
 */

export const EMBED_DIM = 512;
/** Hard ceiling: one batch containing the whole corpus aborts the WASM heap. */
export const MAX_BATCH = 32;

export interface EmbedTimings {
  tokenizeMs: number;
  runMs: number;
  batches: number;
}

export interface EmbedderOptions {
  modelDir: string;
  threads: number;
  batchSize?: number;
}

export class Embedder {
  readonly tokenizer: BertTokenizer;
  readonly paths: ModelPaths;
  readonly loadMs: number;
  readonly threads: number;
  readonly batchSize: number;
  readonly modelBytes: number;
  lastTimings: EmbedTimings = { tokenizeMs: 0, runMs: 0, batches: 0 };
  private readonly session: OrtNs.InferenceSession;
  private readonly ort: typeof OrtNs;

  private constructor(
    ort: typeof OrtNs,
    session: OrtNs.InferenceSession,
    tokenizer: BertTokenizer,
    paths: ModelPaths,
    loadMs: number,
    threads: number,
    batchSize: number,
    modelBytes: number,
  ) {
    this.ort = ort;
    this.session = session;
    this.tokenizer = tokenizer;
    this.paths = paths;
    this.loadMs = loadMs;
    this.threads = threads;
    this.batchSize = batchSize;
    this.modelBytes = modelBytes;
  }

  static async create(options: EmbedderOptions): Promise<Embedder> {
    const t0 = performance.now();
    const paths = assertModelDir(options.modelDir);
    const threads = Number.isFinite(options.threads) && options.threads >= 1 ? Math.floor(options.threads) : 1;
    const batchSize = Math.min(
      MAX_BATCH,
      Math.max(1, Math.floor(options.batchSize ?? MAX_BATCH)),
    );
    const tokenizer = new BertTokenizer(
      paths.tokenizerJson,
      (JSON.parse(readFileSync(paths.tokenizerConfig, 'utf8')) as { model_max_length?: number })
        .model_max_length ?? 512,
    );
    const ort = (await import(pathToFileURL(paths.ortEntry).href)) as typeof OrtNs;
    // Explicit, never inherited: Node's default is 4, and resident memory is
    // almost entirely determined by this one number (512 MB @1, 572 @4, 761 @16).
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.wasmPaths = `${paths.ortDist}/`;
    ort.env.logLevel = 'error';
    const model = readFileSync(paths.onnxModel);
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return new Embedder(
      ort,
      session,
      tokenizer,
      paths,
      performance.now() - t0,
      threads,
      batchSize,
      model.byteLength,
    );
  }

  /** Unnormalised CLS-pooled embeddings, one Float32Array(512) per text. */
  async embedRaw(texts: readonly string[]): Promise<Float32Array[]> {
    let tokenizeMs = 0;
    let runMs = 0;
    let batches = 0;
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const slice = texts.slice(start, start + this.batchSize);
      const tTok = performance.now();
      const idsList = slice.map((t) => this.tokenizer.encode(t));
      tokenizeMs += performance.now() - tTok;
      const len = Math.max(...idsList.map((a) => a.length));
      const b = slice.length;
      const ids = new BigInt64Array(b * len);
      const mask = new BigInt64Array(b * len);
      const types = new BigInt64Array(b * len);
      for (let i = 0; i < b; i++) {
        const row = idsList[i]!;
        for (let j = 0; j < row.length; j++) {
          ids[i * len + j] = BigInt(row[j]!);
          mask[i * len + j] = 1n;
        }
      }
      const tRun = performance.now();
      const results = await this.session.run({
        input_ids: new this.ort.Tensor('int64', ids, [b, len]),
        attention_mask: new this.ort.Tensor('int64', mask, [b, len]),
        token_type_ids: new this.ort.Tensor('int64', types, [b, len]),
      });
      runMs += performance.now() - tRun;
      batches++;
      const hidden = results.last_hidden_state;
      if (hidden === undefined) {
        throw new Error('engram-bridge: 嵌入模型没有返回 last_hidden_state');
      }
      const data = hidden.data as Float32Array;
      const dim = hidden.dims[2] as number;
      const stride = (hidden.dims[1] as number) * dim;
      for (let i = 0; i < b; i++) {
        const row = new Float32Array(dim);
        row.set(data.subarray(i * stride, i * stride + dim));
        out.push(row);
      }
    }
    this.lastTimings = { tokenizeMs, runMs, batches };
    return out;
  }

  /** L2-normalised embeddings (the production contract: text -> unit float32[512]). */
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const raw = await this.embedRaw(texts);
    return raw.map((v) => l2normalize(v));
  }

  async dispose(): Promise<void> {
    try {
      await this.session.release();
    } catch {
      /* releasing a session on the way out is best-effort */
    }
  }
}

/** fastembed normalize(): divide by max(||v||_2, 1e-12). */
export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  let n = Math.sqrt(s);
  if (!(n > 1e-12)) n = 1e-12;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** float32 little-endian bytes for the index's `vectors.vec` BLOB. */
export function vectorToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** Inverse of `vectorToBlob`; copies so the reader does not alias page memory. */
export function blobToVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
