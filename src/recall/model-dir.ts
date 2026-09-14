import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
 * Thrown when the installation is incomplete. Deliberately NOT the same failure
 * as a missing/corrupt derived index: the index is rebuilt, this is reported.
 */
export class ModelUnavailableError extends Error {
  readonly kind = 'runtime-missing';

  constructor(dir: string, missing: readonly MissingPart[]) {
    const detail = missing.map((part) => `${part.what} (${part.path})`).join('; ');
    super(
      `engram-bridge: 检索所需的运行时或模型不完整，检索不可用。模型目录 ${dir} 缺少：${detail}。` +
        '请运行 `node scripts/install-recall-model.mjs --model-dir ' +
        dir +
        '` 完成安装（约 110 MB）。本插件不会自动下载。',
    );
    this.name = 'ModelUnavailableError';
  }
}

export function assertModelDir(dir: string): ModelPaths {
  const missing = missingModelParts(dir);
  if (missing.length > 0) throw new ModelUnavailableError(dir, missing);
  return modelPaths(dir);
}
