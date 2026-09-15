#!/usr/bin/env node
/**
 * Install the read layer's model + PRUNED onnxruntime-web runtime.
 *
 * Both parts are big third-party artifacts (95 MB model, 14.59 MB pruned runtime
 * out of a 142 MB install) and neither belongs in this repository, so this is an
 * explicit step. Nothing downloads silently at call time: if the directory is
 * incomplete, retrieval fails loudly with a message naming this script.
 *
 * The install **proves itself** at the end: it judges the result against the
 * expected identity declared in the repository (`src/recall/model-expected.ts`,
 * read back from `dist/`), and exits non-zero naming what disagrees instead of
 * reporting success. The record it writes (`MANIFEST.json`) describes what was
 * actually installed; it is never the basis of that judgement — otherwise a
 * truncated download or a swapped source would certify itself.
 *
 * Pruning is measured, not guessed: the CPU-WASM Node path opens exactly
 * `package.json`, `ort.node.min.mjs`, `ort-wasm-simd-threaded.mjs`,
 * `ort-wasm-simd-threaded.wasm` plus the whole `onnxruntime-common` package, and
 * removing any of the three executable files makes an embed fail. The layout
 * keeps `node_modules/` intact because `ort.node.min.mjs` resolves the bare
 * specifier `onnxruntime-common`.
 *
 * Usage:
 *   node scripts/install-recall-model.mjs --model-dir <dir> [--model-from <dir>] [--check]
 *
 * `--model-from` accepts either a directory that directly holds the three model
 * files, or a HuggingFace/fastembed cache root containing
 * `models--Qdrant--bge-small-zh-v1.5/snapshots/<rev>/`.
 *
 * `--check` judges an existing installation against the declared identity and
 * exits non-zero when it disagrees.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The expected identity is the repository's single source of truth for "which
// bytes are the right bytes". It is imported from `dist/` (design D11): `dist/`
// is not committed, so a fresh clone must build before installing — say so
// plainly instead of failing with a module-resolution stack trace.
const EXPECTED_MODULE = join(REPO, 'dist', 'recall', 'model-expected.js');
if (!existsSync(EXPECTED_MODULE)) {
  console.error(
    'install-recall-model: 找不到 dist/。安装结果要按仓库里声明的期望身份自证，' +
      '请先构建一次：`pnpm build`（或 `node_modules/.bin/tsc -p tsconfig.json`）。',
  );
  process.exit(2);
}
const { EXPECTED_IDENTITY, directoryFingerprint, verifyModelDir } = await import(
  pathToFileURL(EXPECTED_MODULE).href
);

const HF_REPO = EXPECTED_IDENTITY.model.repo;
const HF_REVISION = EXPECTED_IDENTITY.model.revision;
const MODEL_FILES = [...EXPECTED_IDENTITY.model.files];
const ORT_PACKAGE = EXPECTED_IDENTITY.runtime.package;
const ORT_COMMON = EXPECTED_IDENTITY.group.relPath.split('/').pop();
/** Package-relative paths of the runtime files, derived from the declaration. */
const ORT_PREFIX = `node_modules/${ORT_PACKAGE}/`;
const ORT_FILES = EXPECTED_IDENTITY.files
  .filter((file) => file.relPath.startsWith(ORT_PREFIX))
  .map((file) => file.relPath.slice(ORT_PREFIX.length));

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
 * Locate the `onnxruntime-common` package: `ort.node.min.mjs` resolves it as a
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
      /* dangling link: reported by the judgement as a mismatch */
    }
  }
  return total;
}

/** Render a judgement result: missing and mismatched are kept apart. */
function describeProblems(problems) {
  return problems.map((problem) => {
    const label = problem.kind === 'missing' ? '缺失' : '不符';
    const detail =
      problem.kind === 'missing'
        ? problem.expected
        : `期望 ${problem.expected}；实际 ${problem.actual}`;
    return `  - ${label} ${problem.relPath}（${problem.what}）：${detail}`;
  });
}

function judge(modelDir) {
  return verifyModelDir(modelDir);
}

async function main() {
  const modelDir = resolve(arg('--model-dir', defaultModelDir()));
  if (process.argv.includes('--check')) {
    const problems = judge(modelDir);
    if (problems.length === 0) {
      console.log(`install-recall-model: ok — ${modelDir} 与期望身份一致（${(dirSize(modelDir) / 1e6).toFixed(1)} MB）`);
      return;
    }
    console.error(`install-recall-model: ${modelDir} 与期望身份不一致（${problems.length} 项）：`);
    for (const line of describeProblems(problems)) console.error(line);
    console.error('  期望身份在仓库内（src/recall/model-expected.ts），安装记录不参与判定。');
    process.exit(1);
  }

  const ortFrom = resolve(arg('--ort-from', join(REPO, 'node_modules')));
  const modelFrom = arg('--model-from', undefined);
  mkdirSync(modelDir, { recursive: true });

  console.log(`install-recall-model: 目标 ${modelDir}`);

  // 1. pruned runtime. The target `node_modules/` is cleared first: copying
  //    merges and does not prune, so a leftover file from an older install
  //    would make the layer-entry judgement fail forever — and re-running this
  //    same command would not fix it (design D15).
  const ortSource = join(ortFrom, ORT_PACKAGE);
  if (!existsSync(ortSource)) {
    console.error(
      `install-recall-model: 找不到 ${ortSource}。先运行 \`pnpm install\`（${ORT_PACKAGE} 是精确锁版本的依赖）。`,
    );
    process.exit(2);
  }
  const commonSource = locateOrtCommon(ortFrom);
  if (commonSource === undefined) {
    console.error(`install-recall-model: 找不到 ${ORT_COMMON}（从 ${ortFrom} 出发）`);
    process.exit(2);
  }
  try {
    rmSync(join(modelDir, 'node_modules'), { recursive: true, force: true });
    for (const file of ORT_FILES) {
      const target = join(modelDir, 'node_modules', ORT_PACKAGE, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(ortSource, file), target);
    }
    // `dereference` matters when the source root is itself a link: without it
    // the installation would be a link pointing back into the source tree.
    cpSync(commonSource, join(modelDir, 'node_modules', ORT_COMMON), {
      recursive: true,
      dereference: true,
    });
  } catch (error) {
    // A half-written installation is not usable — the judgement below is what
    // guarantees that, so there is no need to roll back. Report and stop.
    console.error(
      `install-recall-model: 复制运行时失败，安装未完成（${modelDir} 不可用，请重跑本命令）：${error.message}`,
    );
    process.exit(1);
  }
  console.log(
    `  裁剪后的运行时：${ORT_FILES.length} 个文件 + ${ORT_COMMON}/（未复制 3 个其它 .wasm 变体与全部 .map/lib，约 128 MB）`,
  );

  // 2. model
  let source;
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
    source = { kind: 'local', dir: located };
    console.log(`  模型：从 ${located} 复制（跟随符号链接，落成真实文件）`);
  } else {
    console.log(`  模型：从 ${HF_REPO}@${HF_REVISION} 下载`);
    await downloadModelFiles(modelDir);
    source = { kind: 'remote', repo: HF_REPO, revision: HF_REVISION };
  }

  // 3. self-proof, before anything claims success
  const problems = judge(modelDir);
  if (problems.length > 0) {
    console.error(
      `install-recall-model: 安装结果与期望身份不一致（${problems.length} 项），未安装成功：`,
    );
    for (const line of describeProblems(problems)) console.error(line);
    process.exit(1);
  }

  // 4. record what was actually installed. Provenance only — the judgement
  //    above never reads this file (design D0).
  const files = EXPECTED_IDENTITY.files.map((file) => join(modelDir, ...file.relPath.split('/')));
  const commonDir = join(modelDir, ...EXPECTED_IDENTITY.group.relPath.split('/'));
  const installedGroup = directoryFingerprint(commonDir);
  const manifest = {
    installedAt: new Date().toISOString(),
    source,
    ortVersion: JSON.parse(
      readFileSync(join(modelDir, 'node_modules', ORT_PACKAGE, 'package.json'), 'utf8'),
    ).version,
    files: Object.fromEntries(
      files.map((file) => [
        file.slice(modelDir.length + 1),
        { bytes: statSync(file).size, sha256: sha256(file) },
      ]),
    ),
    group: {
      relPath: EXPECTED_IDENTITY.group.relPath,
      algorithm: installedGroup.algorithm,
      fingerprint: installedGroup.fingerprint,
      files: installedGroup.files,
      bytes: installedGroup.bytes,
    },
    totalBytes: dirSize(modelDir),
  };
  writeFileSync(join(modelDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `install-recall-model: 完成并自证一致 — 合计 ${(manifest.totalBytes / 1e6).toFixed(1)} MB，` +
      `其中运行时 ${(dirSize(join(modelDir, 'node_modules')) / 1e6).toFixed(2)} MB`,
  );
  console.log(`  在插件配置里设置：searchModelDir: ${modelDir}`);
}

await main();
