#!/usr/bin/env node
/**
 * Re-derive the expected identity declaration from independent sources.
 *
 * The declaration in `src/recall/model-expected.ts` is only worth something if
 * somebody else can check it — an expectation nobody can re-derive is a claim,
 * not a contract (see the `engram-bridge-model-install` requirement 「声明可被
 * 独立复核」). This script is that check, and it deliberately keeps three things
 * apart:
 *
 *   - **independent data**: the runtime half comes from the pinned dependency
 *     under `node_modules/.pnpm/`, offline; the model half comes from a local
 *     HuggingFace cache, or from re-fetching the pinned revision;
 *   - **an independent implementation**: the directory fingerprint below is
 *     written from the algorithm's description, not imported from `dist/`, so a
 *     changed sort order or baseline cannot pass by comparing code with itself;
 *   - **unverified vs failed**: anything this run could not reach is reported as
 *     「未复核」 and listed in the summary. A check that did not run is never
 *     counted as a pass.
 *
 * Exit status: 0 when every check that could run agreed, 1 when one disagreed,
 * 2 when the script could not start (no `dist/`).
 *
 * Usage (all optional):
 *   node scripts/verify-model-expected.mjs [--model-dir <dir>] [--cache <dir>]
 *                                          [--remote-proxy <url>]
 *
 * `--cache` points at a HuggingFace-style cache root (the one holding
 * `models--<repo>/snapshots/<rev>/`), or `$ENGRAM_FASTEMBED_CACHE`; without one
 * the model half is reported as unverified — `find <cache-root> -type d -name
 * 'models--Qdrant--bge-small-zh-v1.5'` locates a cache if this machine has one.
 * (The spike's own cache was removed 2026-09-15, so the
 * offline half now needs a cache to be downloaded again.)
 *
 * Direct downloads do not work on a proxied machine (Node's `fetch` ignores
 * `HTTP(S)_PROXY`), which is why the remote check shells out to `curl -x`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`verify-model-expected: ${name} 需要一个值`);
    process.exit(2);
  }
  return value;
}

const MODULE = join(REPO, 'dist', 'recall', 'model-expected.js');
if (!existsSync(MODULE)) {
  console.error(
    'verify-model-expected: 找不到 dist/。先构建一次（`pnpm build`，或直接 ' +
      '`node_modules/.bin/tsc -p tsconfig.json`），再运行本脚本。',
  );
  process.exit(2);
}
const { EXPECTED_IDENTITY, expectedIdentityDigest } = await import(pathToFileURL(MODULE).href);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sha256File = (path) => sha256(readFileSync(path));

/**
 * Directory fingerprint, implemented from the design's text (see
 * `directoryFingerprint` in `src/recall/model-expected.ts` for the normative
 * version): regular files only, symlinks never followed, POSIX relative names
 * sorted by UTF-16 code unit, `` `${relPath}\n${sha256}\n` `` concatenated, then
 * hashed; `.DS_Store` and `._*` excluded.
 */
function fingerprint(dir) {
  const found = [];
  let bytes = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name.startsWith('._')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const data = readFileSync(full);
      bytes += data.byteLength;
      found.push([relative(dir, full).split(sep).join('/'), sha256(data)]);
    }
  };
  walk(dir);
  found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    fingerprint: sha256(found.map(([relPath, hash]) => `${relPath}\n${hash}\n`).join('')),
    files: found.length,
    bytes,
  };
}

/** Every regular file in a tree, keyed by POSIX relative path. */
function fileHashes(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name.startsWith('._')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(relative(dir, full).split(sep).join('/'), sha256File(full));
    }
  };
  walk(dir);
  return out;
}

let failures = 0;
let unverified = 0;

function ok(label, detail = '') {
  console.log(`  ✓ ${label}${detail === '' ? '' : ` — ${detail}`}`);
}
function fail(label, detail = '') {
  failures += 1;
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
}
function skip(label, detail = '') {
  unverified += 1;
  console.log(`  · 未复核：${label}${detail === '' ? '' : ` — ${detail}`}`);
}
function section(title) {
  console.log(`\n${title}`);
}

function defaultModelDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'storages', 'engram-bridge', 'model');
}

console.log('verify-model-expected: 复核仓库内声明的期望身份');
console.log(`  模型锚点：${EXPECTED_IDENTITY.model.repo}@${EXPECTED_IDENTITY.model.revision}`);
console.log(`  运行时锚点：${EXPECTED_IDENTITY.runtime.package}@${EXPECTED_IDENTITY.runtime.version}`);
console.log(`  身份摘要：${expectedIdentityDigest()}`);

// ---------------------------------------------------------------- runtime half

const webSource = join(
  REPO,
  'node_modules',
  '.pnpm',
  `onnxruntime-web@${EXPECTED_IDENTITY.runtime.version}`,
  'node_modules',
  'onnxruntime-web',
);
const commonSource = join(
  REPO,
  'node_modules',
  '.pnpm',
  `onnxruntime-common@${EXPECTED_IDENTITY.runtime.version}`,
  'node_modules',
  'onnxruntime-common',
);
const PREFIX = `node_modules/${EXPECTED_IDENTITY.runtime.package}/`;

section('[1] 运行时（离线，来源 = 锁定版本的依赖）');
if (!existsSync(webSource)) {
  skip('锁定依赖不在 node_modules/.pnpm 下', '先运行 `pnpm install`');
} else {
  const wrong = EXPECTED_IDENTITY.files
    .filter((file) => file.relPath.startsWith(PREFIX))
    .map((file) => ({ file, actual: sha256File(join(webSource, file.relPath.slice(PREFIX.length))) }))
    .filter(({ file, actual }) => actual !== file.sha256 || statSync(
      join(webSource, file.relPath.slice(PREFIX.length)),
    ).size !== file.bytes);
  const checked = EXPECTED_IDENTITY.files.filter((file) => file.relPath.startsWith(PREFIX)).length;
  if (wrong.length === 0) ok(`受检文件 ${checked}/${checked} 与声明一致`);
  else fail(`受检文件不一致：${wrong.map(({ file }) => file.relPath).join(', ')}`);

  if (!existsSync(commonSource)) {
    skip('找不到成组内容的源', commonSource);
  } else {
    const actual = fingerprint(commonSource);
    const declared = EXPECTED_IDENTITY.group;
    if (
      actual.fingerprint === declared.fingerprint &&
      actual.files === declared.files &&
      actual.bytes === declared.bytes
    ) {
      ok(
        `成组内容指纹一致`,
        `${declared.fingerprint.slice(0, 16)}…（${actual.files} 文件 / ${actual.bytes} B）`,
      );
    } else {
      fail(
        '成组内容指纹不一致',
        `声明 ${declared.fingerprint}（${declared.files} 文件 / ${declared.bytes} B）；` +
          `实算 ${actual.fingerprint}（${actual.files} 文件 / ${actual.bytes} B）`,
      );
    }
  }
}

// ------------------------------------------------------------- installed half

section('[2] 已安装目录');
const modelDir = resolve(arg('--model-dir') ?? defaultModelDir());
if (!existsSync(modelDir)) {
  skip('模型目录不存在', modelDir);
} else {
  const { verifyModelDir } = await import(pathToFileURL(MODULE).href);
  const problems = verifyModelDir(modelDir);
  if (problems.length === 0) {
    ok('按期望身份判定一致', modelDir);
  } else {
    fail(
      `判定不一致（${problems.length} 项）`,
      problems
        .slice(0, 3)
        .map((problem) => `${problem.kind} ${problem.relPath}`)
        .join('; ') + (problems.length > 3 ? ' …' : ''),
    );
  }

  if (existsSync(webSource) && existsSync(commonSource)) {
    const installedWeb = fileHashes(join(modelDir, 'node_modules', EXPECTED_IDENTITY.runtime.package));
    const sourceWeb = fileHashes(webSource);
    const sourceCommon = fileHashes(commonSource);
    const installedCommon = fileHashes(join(modelDir, EXPECTED_IDENTITY.group.relPath));

    const pruned = [...sourceWeb.keys()].filter((key) => !installedWeb.has(key));
    const differing = [...installedWeb].filter(([key, hash]) => sourceWeb.get(key) !== hash);
    if (differing.length === 0) {
      ok(
        `${EXPECTED_IDENTITY.runtime.package} 受检文件与源逐文件相同`,
        `已安装 ${installedWeb.size} 个，源整包 ${sourceWeb.size} 个（裁剪掉 ${pruned.length} 个是设计）`,
      );
    } else {
      fail('受检文件与源不同', differing.map(([key]) => key).join(', '));
    }

    const commonDiffering = [...installedCommon].filter(
      ([key, hash]) => sourceCommon.get(key) !== hash,
    );
    const onlyInstalled = [...installedCommon.keys()].filter((key) => !sourceCommon.has(key));
    if (commonDiffering.length === 0 && onlyInstalled.length === 0) {
      ok(
        '成组内容子树与源逐文件相同',
        `${installedCommon.size}/${sourceCommon.size}`,
      );
    } else {
      fail(
        '成组内容子树与源不同',
        [...commonDiffering.map(([key]) => key), ...onlyInstalled].slice(0, 3).join(', '),
      );
    }
  }
}

// --------------------------------------------------------- model half (local)

section('[3] 模型来源（本地缓存，离线）');
function locateCache() {
  const explicit = arg('--cache') ?? process.env.ENGRAM_FASTEMBED_CACHE;
  if (explicit !== undefined && explicit !== '') return explicit;
  return undefined;
}
const cache = locateCache();
const modelHash = EXPECTED_IDENTITY.files.find((file) => file.relPath === 'model_optimized.onnx').sha256;
if (cache === undefined || !existsSync(cache)) {
  skip(
    '未提供本机 fastembed 缓存',
    "用 --cache <dir> 或 $ENGRAM_FASTEMBED_CACHE 指定；`find <cache-root> -type d -name 'models--Qdrant--bge-small-zh-v1.5'` 可定位",
  );
} else {
  const snapshot = join(
    cache,
    `models--${EXPECTED_IDENTITY.model.repo.replace('/', '--')}`,
    'snapshots',
    EXPECTED_IDENTITY.model.revision,
  );
  const treePath = join(
    cache,
    `models--${EXPECTED_IDENTITY.model.repo.replace('/', '--')}`,
    'trees',
    `${EXPECTED_IDENTITY.model.revision}.json`,
  );
  const blob = join(dirname(dirname(snapshot)), 'blobs', modelHash);
  if (!existsSync(blob)) {
    fail('缓存里没有名为模型摘要的 blob', blob);
  } else if (sha256File(blob) !== modelHash) {
    fail('blob 内容与它的名字不符', blob);
  } else {
    ok('blob 的文件名就是模型摘要，且内容一致', `blobs/${modelHash.slice(0, 16)}…`);
  }
  const link = join(snapshot, 'model_optimized.onnx');
  if (!existsSync(link)) {
    fail('缓存里没有该 revision 的模型条目', link);
  } else if (!lstatSync(link).isSymbolicLink()) {
    fail('缓存里的模型条目不是链接（布局与预期不符）', link);
  } else {
    const target = readlinkSync(link).split(sep).join('/').split('/').pop();
    if (target === modelHash) {
      ok('缓存条目的链接目标名就是模型摘要', `model_optimized.onnx -> blobs/${modelHash.slice(0, 16)}…`);
    } else {
      fail('缓存条目的链接目标名与声明不符', String(target));
    }
  }
  if (!existsSync(treePath)) {
    fail('缓存里没有该 revision 的 tree 元数据', treePath);
  } else {
    const tree = JSON.parse(readFileSync(treePath, 'utf8'));
    const entry = tree.files?.['model_optimized.onnx'];
    if (entry?.lfs_sha256 === modelHash) {
      ok('tree 元数据的 lfs_sha256 与声明一致', `size=${entry.size}`);
    } else {
      fail('tree 元数据的 lfs_sha256 与声明不符', JSON.stringify(entry ?? null));
    }
    const sizesWrong = EXPECTED_IDENTITY.model.files.filter(
      (name) => tree.files?.[name]?.size !== EXPECTED_IDENTITY.files.find((f) => f.relPath === name)?.bytes,
    );
    if (sizesWrong.length === 0) ok('tree 元数据的字节数与声明一致', EXPECTED_IDENTITY.model.files.join(', '));
    else fail('tree 元数据的字节数与声明不符', sizesWrong.join(', '));
  }
}

// -------------------------------------------------------- model half (remote)

section('[4] 模型来源（远端重取）');
const proxy = arg('--remote-proxy');
const base = `https://huggingface.co/${EXPECTED_IDENTITY.model.repo}/resolve/${EXPECTED_IDENTITY.model.revision}/`;
if (proxy === undefined) {
  skip('未提供 --remote-proxy（本机直连 huggingface.co 不通，Node 的 fetch 也不读环境代理）');
  console.log('    可复跑的步骤（把 <proxy> 换成自己的代理）：');
  for (const name of EXPECTED_IDENTITY.model.files) {
    console.log(`      curl -x <proxy> -L ${base}${name} -o /tmp/${name}  # sha256 须为 ${EXPECTED_IDENTITY.files.find((f) => f.relPath === name).sha256}`);
  }
} else {
  const work = mkdtempSync(join(tmpdir(), 'verify-model-expected-'));
  try {
    for (const name of EXPECTED_IDENTITY.model.files) {
      const declared = EXPECTED_IDENTITY.files.find((file) => file.relPath === name);
      const target = join(work, name);
      try {
        execFileSync('curl', ['-x', proxy, '-L', '-sS', '-f', '-o', target, base + name], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        fail(`重取 ${name} 失败`, String(error.stderr ?? error.message).trim().slice(0, 200));
        continue;
      }
      const actual = sha256File(target);
      if (actual === declared.sha256 && statSync(target).size === declared.bytes) {
        ok(`重取的 ${name} 与声明逐字节一致`);
      } else {
        fail(`重取的 ${name} 与声明不符`, `实算 ${actual}（${statSync(target).size} B）`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log('');
if (failures > 0) {
  console.error(`verify-model-expected: ${failures} 项与声明不符`);
  process.exit(1);
}
console.log(
  `verify-model-expected: 本次可执行的复核全部一致${unverified > 0 ? `（${unverified} 项未复核，见上）` : ''}`,
);
