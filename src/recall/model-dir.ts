import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXPECTED_IDENTITY,
  verifyModelDir,
  type ExpectedIdentity,
  type IdentityProblem,
} from './model-expected.js';

/**
 * Layout of the explicitly installed model + pruned runtime directory
 * (`searchModelDir`).
 *
 * Nothing here is downloaded automatically, and nothing here is committed: the
 * model is a 95 MB third-party artifact and the runtime is 142 MB unpruned. The
 * install step is `scripts/install-recall-model.mjs`; when a part is missing the
 * read layer fails loudly at the call site (see `engram-bridge-recall`'s
 * 「运行时或模型缺失时响亮失败」).
 *
 * The runtime keeps the node_modules layout because `ort.node.min.mjs` imports
 * the bare specifier `onnxruntime-common` and loads its Emscripten glue from
 * `wasmPaths`; both resolutions are relative to the importing file.
 */
export interface ModelPaths {
  dir: string;
  onnxModel: string;
  tokenizerJson: string;
  tokenizerConfig: string;
  ortPackageJson: string;
  ortEntry: string;
  ortGlue: string;
  ortWasm: string;
  ortCommonDir: string;
  /** `ort.env.wasm.wasmPaths` value (trailing slash required by Emscripten). */
  ortDist: string;
}

export function modelPaths(dir: string): ModelPaths {
  const pkg = join(dir, 'node_modules', 'onnxruntime-web');
  const dist = join(pkg, 'dist');
  return {
    dir,
    onnxModel: join(dir, 'model_optimized.onnx'),
    tokenizerJson: join(dir, 'tokenizer.json'),
    tokenizerConfig: join(dir, 'tokenizer_config.json'),
    ortPackageJson: join(pkg, 'package.json'),
    ortEntry: join(dist, 'ort.node.min.mjs'),
    ortGlue: join(dist, 'ort-wasm-simd-threaded.mjs'),
    ortWasm: join(dist, 'ort-wasm-simd-threaded.wasm'),
    ortCommonDir: join(dir, 'node_modules', 'onnxruntime-common'),
    ortDist: dist,
  };
}

export interface MissingPart {
  path: string;
  what: string;
}

/** Which parts of the installation are absent (empty array = complete). */
export function missingModelParts(dir: string): MissingPart[] {
  const paths = modelPaths(dir);
  const required: MissingPart[] = [
    { path: paths.onnxModel, what: '嵌入模型 model_optimized.onnx' },
    { path: paths.tokenizerJson, what: '分词器 tokenizer.json' },
    { path: paths.tokenizerConfig, what: '分词器配置 tokenizer_config.json' },
    { path: paths.ortPackageJson, what: 'onnxruntime-web 包描述' },
    { path: paths.ortEntry, what: 'onnxruntime-web Node 入口' },
    { path: paths.ortGlue, what: 'onnxruntime-web Emscripten glue' },
    { path: paths.ortWasm, what: 'onnxruntime-web SIMD+threads 运行时' },
  ];
  const missing = required.filter((part) => !existsSync(part.path));
  if (!existsSync(paths.ortCommonDir)) {
    missing.push({ path: paths.ortCommonDir, what: 'onnxruntime-common 包' });
  }
  return missing;
}

export function modelPartSizes(dir: string): Record<string, number> {
  const paths = modelPaths(dir);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries({
    model_optimized_onnx: paths.onnxModel,
    ort_wasm: paths.ortWasm,
  })) {
    try {
      out[key] = statSync(value).size;
    } catch {
      out[key] = 0;
    }
  }
  return out;
}

/**
 * One reason an installation is unusable.
 *
 * `missing` and `mismatch` are kept apart because the remedy differs (go
 * install it, versus find out what replaced it) and because a message claiming
 * 「缺少」 about a file that is present is simply false.
 */
export interface UnavailablePart {
  kind: 'missing' | 'mismatch';
  path: string;
  what: string;
  expected?: string;
  actual?: string;
}

/**
 * Thrown when the installation is not the one the repository declares.
 * Deliberately NOT the same failure as a missing/corrupt derived index: the
 * index is rebuilt, this is reported.
 */
export class ModelUnavailableError extends Error {
  readonly kind = 'runtime-missing';

  constructor(dir: string, parts: readonly UnavailablePart[]) {
    const lines = parts.map((part) =>
      part.kind === 'missing'
        ? `缺失 ${part.what}（${part.path}）`
        : `不符 ${part.what}（${part.path}）：期望 ${part.expected ?? '?'}；实际 ${part.actual ?? '?'}`,
    );
    const header = parts.every((part) => part.kind === 'missing') ? '缺少：' : '不可用项：';
    super(
      `engram-bridge: 检索所需的运行时或模型不可用。模型目录 ${dir} ${header}${lines.join('；')}。` +
        '请运行 `node scripts/install-recall-model.mjs --model-dir ' +
        dir +
        '` 装成仓库里声明的那一份（约 110 MB）。本插件不会自动下载，也不会自动修复。',
    );
    this.name = 'ModelUnavailableError';
  }
}

function missingPart(part: MissingPart): UnavailablePart {
  return { kind: 'missing', path: part.path, what: part.what };
}

function problemPart(dir: string, problem: IdentityProblem): UnavailablePart {
  return {
    kind: problem.kind,
    path: join(dir, ...problem.relPath.split('/')),
    what: problem.what,
    expected: problem.expected,
    actual: problem.actual,
  };
}

export function assertModelDir(dir: string): ModelPaths {
  const missing = missingModelParts(dir);
  if (missing.length > 0) throw new ModelUnavailableError(dir, missing.map(missingPart));
  return modelPaths(dir);
}

/**
 * Judge `dir` against the repository's declared expected identity and throw
 * when it is not that installation.
 *
 * Called only by `process.ts`, immediately before each `spawn` — deliberately
 * NOT from `assertModelDir`, whose callers run per retrieval (`embed.ts` builds
 * the embedder once per worker) and would then hash ~110 MB on every call,
 * which the spec forbids (design D1). On failure nothing is spawned and nothing
 * is cached, so a later call re-judges and recovers (design D1, 「自愈」).
 */
export function assertExpectedIdentity(
  dir: string,
  expected: ExpectedIdentity = EXPECTED_IDENTITY,
): void {
  const problems = verifyModelDir(dir, expected);
  if (problems.length === 0) return;
  throw new ModelUnavailableError(dir, problems.map((problem) => problemPart(dir, problem)));
}
