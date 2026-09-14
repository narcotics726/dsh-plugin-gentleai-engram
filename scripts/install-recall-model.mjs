#!/usr/bin/env node
/**
 * Install the read layer's model + PRUNED onnxruntime-web runtime.
 *
 * Both parts are big third-party artifacts (95 MB model, 14.59 MB pruned runtime
 * out of a 142 MB install) and neither belongs in this repository, so this is an
 * explicit step. Nothing downloads silently at call time: if the directory is
 * incomplete, retrieval fails loudly with a message naming this script.
 *
 * Pruning is measured, not guessed: `prune_test.sh` in the spike showed the
 * CPU-WASM Node path opens exactly `package.json`, `ort.node.min.mjs`,
 * `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` plus the whole
 * `onnxruntime-common` package, and that removing any of the three executable
 * files makes an embed fail. The layout keeps `node_modules/` intact because
 * `ort.node.min.mjs` imports the bare specifier `onnxruntime-common`.
 *
 * Usage:
 *   node scripts/install-recall-model.mjs --model-dir <dir> [--model-from <dir>] [--check]
 *
 * `--model-from` accepts either a directory that directly holds the three model
 * files, or a HuggingFace/fastembed cache root containing
 * `models--Qdrant--bge-small-zh-v1.5/snapshots/<rev>/`.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HF_REPO = 'Qdrant/bge-small-zh-v1.5';
/** Pinned revision: the one the spike measured against. */
const HF_REVISION = '46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59';
const MODEL_FILES = ['model_optimized.onnx', 'tokenizer.json', 'tokenizer_config.json'];
const ORT_PACKAGE = 'onnxruntime-web';
const ORT_FILES = [
  'package.json',
  'dist/ort.node.min.mjs',
  'dist/ort-wasm-simd-threaded.mjs',
  'dist/ort-wasm-simd-threaded.wasm',
];
const ORT_COMMON = 'onnxruntime-common';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`install-recall-model: ${name} 需要一个值`);
    process.exit(2);
  }
  return value;
}

function defaultModelDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(process.env.HOME ?? '', '.dsh');
  return join(home, 'storages', 'engram-bridge', 'model');
}

/** Find the three model files under a user-provided source root. */
function locateModelFiles(root) {
  const direct = MODEL_FILES.filter((file) => existsSync(join(root, file)));
  if (direct.length === MODEL_FILES.length) return root;
  const snapshots = join(root, `models--${HF_REPO.replace('/', '--')}`, 'snapshots');
  if (existsSync(snapshots)) {
    for (const revision of readdirSync(snapshots)) {
      const candidate = join(snapshots, revision);
      if (MODEL_FILES.every((file) => existsSync(join(candidate, file)))) return candidate;
    }
  }
  return undefined;
}

async function downloadModelFiles(target) {
  const base = `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/`;
  for (const file of MODEL_FILES) {
    const response = await fetch(base + file, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`下载 ${file} 失败：HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(join(target, file), bytes);
    console.log(`  下载 ${file} ${(bytes.byteLength / 1e6).toFixed(2)} MB`);
  }
}

/**
 * Locate the `onnxruntime-common` package: `ort.node.min.mjs` imports it as a
 * bare specifier, so the deployed layout must keep it resolvable. npm hoists it
 * next to `onnxruntime-web`; pnpm keeps it under `.pnpm/`.
 */
function locateOrtCommon(ortFrom) {
  const candidates = [
    join(ortFrom, ORT_COMMON),
    join(ortFrom, ORT_PACKAGE, 'node_modules', ORT_COMMON),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const pnpm = join(ortFrom, '.pnpm');
  if (existsSync(pnpm)) {
    for (const entry of readdirSync(pnpm)) {
      if (!entry.startsWith(`${ORT_COMMON}@`)) continue;
      const candidate = join(pnpm, entry, 'node_modules', ORT_COMMON);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function dirSize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true, recursive: true })) {
    const full = join(entry.parentPath ?? path, entry.name);
    // Stat, not lstat: a symlinked artifact whose target is gone must not be
    // counted as a present file (a HuggingFace cache entry is a symlink).
    try {
      if (statSync(full).isFile()) total += statSync(full).size;
    } catch {
      /* dangling link: reported as missing by report() */
    }
  }
  return total;
}

/** A part counts as present only when its bytes are actually here. */
function present(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function report(modelDir) {
  const missing = [];
  for (const file of MODEL_FILES) if (!present(join(modelDir, file))) missing.push(file);
  for (const file of ORT_FILES) if (!present(join(modelDir, 'node_modules', ORT_PACKAGE, file))) missing.push(join(ORT_PACKAGE, file));
  if (!existsSync(join(modelDir, 'node_modules', ORT_COMMON))) missing.push(ORT_COMMON);
  return missing;
}

async function main() {
  const modelDir = resolve(arg('--model-dir', defaultModelDir()));
  if (process.argv.includes('--check')) {
    const missing = report(modelDir);
    if (missing.length === 0) {
      console.log(`install-recall-model: ok — ${modelDir} 完整（${(dirSize(modelDir) / 1e6).toFixed(1)} MB）`);
      return;
    }
    console.error(`install-recall-model: ${modelDir} 缺少 ${missing.length} 项：`);
    for (const item of missing) console.error(`  - ${item}`);
    process.exit(1);
  }

  const ortFrom = resolve(arg('--ort-from', join(REPO, 'node_modules')));
  const modelFrom = arg('--model-from', undefined);
  mkdirSync(modelDir, { recursive: true });

  console.log(`install-recall-model: 目标 ${modelDir}`);

  // 1. pruned runtime
  const ortSource = join(ortFrom, ORT_PACKAGE);
  if (!existsSync(ortSource)) {
    console.error(
      `install-recall-model: 找不到 ${ortSource}。先运行 \`pnpm install\`（${ORT_PACKAGE} 是精确锁版本的依赖）。`,
    );
    process.exit(2);
  }
  for (const file of ORT_FILES) {
    const target = join(modelDir, 'node_modules', ORT_PACKAGE, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ortSource, file), target);
  }
  const commonSource = locateOrtCommon(ortFrom);
  if (commonSource === undefined) {
    console.error(`install-recall-model: 找不到 ${ORT_COMMON}（从 ${ortFrom} 出发）`);
    process.exit(2);
  }
  cpSync(commonSource, join(modelDir, 'node_modules', ORT_COMMON), { recursive: true });
  console.log(
    `  裁剪后的运行时：${ORT_FILES.length} 个文件 + ${ORT_COMMON}/（未复制 3 个其它 .wasm 变体与全部 .map/lib，约 128 MB）`,
  );

  // 2. model
  if (modelFrom !== undefined) {
    const located = locateModelFiles(resolve(modelFrom));
    if (located === undefined) {
      console.error(`install-recall-model: 在 ${modelFrom} 下找不到 ${MODEL_FILES.join(' / ')}`);
      process.exit(2);
    }
    // copyFileSync follows symlinks, which matters: a HuggingFace cache entry is
    // a link into `blobs/`, and reproducing that link would tie the installation
    // to the cache directory (and to a local cache).
    for (const file of MODEL_FILES) {
      copyFileSync(join(located, file), join(modelDir, file));
    }
    console.log(`  模型：从 ${located} 复制（跟随符号链接，落成真实文件）`);
  } else {
    console.log(`  模型：从 ${HF_REPO}@${HF_REVISION} 下载`);
    await downloadModelFiles(modelDir);
  }

  // 3. manifest
  const files = [
    ...MODEL_FILES.map((file) => join(modelDir, file)),
    ...ORT_FILES.map((file) => join(modelDir, 'node_modules', ORT_PACKAGE, file)),
  ];
  const manifest = {
    installedAt: new Date().toISOString(),
    huggingfaceRepo: modelFrom === undefined ? HF_REPO : undefined,
    huggingfaceRevision: modelFrom === undefined ? HF_REVISION : undefined,
    ortVersion: JSON.parse(readFileSync(join(modelDir, 'node_modules', ORT_PACKAGE, 'package.json'), 'utf8')).version,
    files: Object.fromEntries(
      files.map((file) => [file.slice(modelDir.length + 1), { bytes: statSync(file).size, sha256: sha256(file) }]),
    ),
    totalBytes: dirSize(modelDir),
  };
  writeFileSync(join(modelDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const missing = report(modelDir);
  if (missing.length > 0) {
    console.error(`install-recall-model: 安装后仍缺少：${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(
    `install-recall-model: 完成 — 合计 ${(manifest.totalBytes / 1e6).toFixed(1)} MB，` +
      `其中运行时 ${(dirSize(join(modelDir, 'node_modules')) / 1e6).toFixed(2)} MB`,
  );
  console.log(`  在插件配置里设置：searchModelDir: ${modelDir}`);
}

await main();
