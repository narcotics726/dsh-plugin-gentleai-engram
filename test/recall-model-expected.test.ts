import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import {
  EXPECTED_IDENTITY,
  directoryFingerprint,
  expectedIdentityDigest,
  expectedLayers,
  verifyModelDir,
} from '../dist/recall/model-expected.js';
import type { ExpectedIdentity, IdentityProblem } from '../dist/recall/model-expected.js';
import { removeDir, tempDir } from './recall-support.ts';

/**
 * The expected-identity declaration and the judgement built on it.
 *
 * Two kinds of fixture appear here:
 *
 * - the **real** declaration is asserted structurally (entry count, anchored
 *   sources, frozen-ness) and its fingerprint algorithm is pinned against an
 *   independent reference implementation below;
 * - the **judgement** is exercised against a synthetic installation whose
 *   declaration is derived from the fixture itself, so scope and reporting can
 *   be tested without a 110 MB artifact.
 */

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const GROUP_REL = 'node_modules/onnxruntime-common';

/** Independent reading of design D8, parameterised so variants are expressible. */
function referenceFingerprint(
  dir: string,
  options: { compare: (a: string, b: string) => number; exclude: boolean },
): string {
  const found: Array<[string, string]> = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (options.exclude && (entry.name === '.DS_Store' || entry.name.startsWith('._'))) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      found.push([
        relative(dir, full).split(sep).join('/'),
        sha256(readFileSync(full)),
      ]);
    }
  };
  walk(dir);
  found.sort((a, b) => options.compare(a[0], b[0]));
  return sha256(found.map(([relPath, hash]) => `${relPath}\n${hash}\n`).join(''));
}

function writeAt(dir: string, relPath: string, content: string): void {
  const full = join(dir, ...relPath.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const SYNTHETIC_FILES: ReadonlyArray<readonly [string, string]> = [
  ['model_optimized.onnx', 'synthetic weights'],
  ['tokenizer.json', '{"model":{}}'],
  ['tokenizer_config.json', '{"model_max_length":512}'],
  ['node_modules/onnxruntime-web/package.json', '{"name":"onnxruntime-web","version":"test"}'],
  ['node_modules/onnxruntime-web/dist/ort.node.min.mjs', 'export const env = {};\n'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'export const glue = 1;\n'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'wasm bytes'],
];

/** A synthetic installation plus the declaration that describes it. */
function syntheticInstall(root: string): { dir: string; expected: ExpectedIdentity } {
  const dir = join(root, 'model');
  for (const [relPath, content] of SYNTHETIC_FILES) writeAt(dir, relPath, content);
  writeAt(dir, `${GROUP_REL}/index.js`, 'common entry\n');
  writeAt(dir, `${GROUP_REL}/dist/cjs/runtime.js`, 'nested common file\n');
  // The install step writes its own record into the same directory: the root
  // layer must not care (design D3).
  writeAt(dir, 'MANIFEST.json', '{"installedAt":"2026-01-01T00:00:00.000Z"}');
  return { dir, expected: expectedFor(dir) };
}

function expectedFor(dir: string, overrides: Partial<ExpectedIdentity> = {}): ExpectedIdentity {
  const files = SYNTHETIC_FILES.map(([relPath, content]) => ({
    relPath,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    what: relPath,
  }));
  const fingerprint = directoryFingerprint(join(dir, ...GROUP_REL.split('/')));
  return {
    files,
    group: {
      relPath: GROUP_REL,
      algorithm: fingerprint.algorithm,
      fingerprint: fingerprint.fingerprint,
      files: fingerprint.files,
      bytes: fingerprint.bytes,
      what: GROUP_REL,
    },
    model: { repo: 'synthetic/fixture', revision: 'test', files: [] },
    runtime: { package: 'onnxruntime-web', version: 'test' },
    ...overrides,
  };
}

function problemsFor(dir: string, expected: ExpectedIdentity): IdentityProblem[] {
  return verifyModelDir(dir, expected);
}

test('声明覆盖 7 个文件 + 1 个成组目录，并把来源锚定写清', () => {
  const { files, group } = EXPECTED_IDENTITY;
  assert.equal(files.length + 1, 8, '声明条目数（7 文件 + 1 目录）须为 8');
  assert.equal(new Set(files.map((file) => file.relPath)).size, files.length, '相对路径不得重复');
  for (const file of files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.relPath} 的摘要须是 sha256 十六进制`);
    assert.ok(file.bytes > 0, `${file.relPath} 的字节数须为正`);
  }
  assert.equal(group.relPath, GROUP_REL);
  assert.match(group.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(group.files, 193);
  assert.equal(group.bytes, 573_091);

  // Anchors: without them the declaration cannot be re-derived by anyone else.
  assert.equal(EXPECTED_IDENTITY.model.repo, 'Qdrant/bge-small-zh-v1.5');
  assert.equal(
    EXPECTED_IDENTITY.model.revision,
    '46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59',
  );
  assert.deepEqual(
    EXPECTED_IDENTITY.model.files,
    ['model_optimized.onnx', 'tokenizer.json', 'tokenizer_config.json'],
  );
  assert.equal(EXPECTED_IDENTITY.runtime.package, 'onnxruntime-web');
  assert.equal(EXPECTED_IDENTITY.runtime.version, '1.29.0');
});

test('声明被深冻结（浅冻结挡不住嵌套属性被改）', () => {
  assert.ok(Object.isFrozen(EXPECTED_IDENTITY));
  assert.ok(Object.isFrozen(EXPECTED_IDENTITY.files));
  assert.ok(Object.isFrozen(EXPECTED_IDENTITY.files[0]));
  assert.ok(Object.isFrozen(EXPECTED_IDENTITY.group));
  assert.ok(Object.isFrozen(EXPECTED_IDENTITY.model));
  assert.throws(() => {
    (EXPECTED_IDENTITY.files[0] as { sha256: string }).sha256 = 'x'.repeat(64);
  }, TypeError);
});

test('目录指纹钉死了排序方式、基准与排除项', () => {
  const root = tempDir('recall-expected-');
  try {
    const common = join(root, GROUP_REL);
    // Code-unit order puts every uppercase letter before every lowercase one;
    // `localeCompare` compares case-insensitively first, so it orders these two
    // the other way round. This fixture can therefore tell the two apart.
    writeAt(common, 'a.txt', '1');
    writeAt(common, 'B.txt', '2');
    writeAt(common, 'nested/inner.txt', '3');
    writeAt(common, 'z.txt', '4');
    writeAt(common, '.DS_Store', 'junk');
    writeAt(common, '._resource', 'junk');
    writeAt(common, '._nested/hidden.txt', 'junk');
    writeAt(root, 'MANIFEST.json', '{"installedAt":"now"}');
    writeAt(root, 'sibling.txt', 'not part of the group');

    const shipped = directoryFingerprint(common).fingerprint;
    const pinned = referenceFingerprint(common, { compare: codeUnit, exclude: true });
    assert.equal(shipped, pinned, '指纹须等于按 UTF-16 码元序、不含 .DS_Store/._* 独立重算的值');

    // Negative controls: each variant must produce a value that actually
    // differs on THIS fixture, otherwise "it was pinned" is not demonstrated.
    const locale = referenceFingerprint(common, { compare: (a, b) => a.localeCompare(b), exclude: true });
    assert.notEqual(locale, pinned, 'localeCompare 排序必须在夹具上给出不同的值');
    const kept = referenceFingerprint(common, { compare: codeUnit, exclude: false });
    assert.notEqual(kept, pinned, '不排除 .DS_Store/._* 必须在夹具上给出不同的值');
    const wrongBase = referenceFingerprint(root, { compare: codeUnit, exclude: true });
    assert.notEqual(wrongBase, pinned, '以模型目录根为基准必须在夹具上给出不同的值');
    assert.equal(directoryFingerprint(common).files, 4, '基准之外的文件不得被计入');
    assert.equal(directoryFingerprint(root).files, 6, '换基准会连带把根层文件算进来');
  } finally {
    removeDir(root);
  }
});

test('身份摘要覆盖模型权重（换权重必须换摘要）', () => {
  const base = expectedIdentityDigest();
  assert.equal(expectedIdentityDigest(), base, '同一声明须给出稳定摘要');

  const entries = (overrides: Partial<ExpectedIdentity>): string =>
    expectedIdentityDigest({ ...EXPECTED_IDENTITY, ...overrides });

  const swappedWeights = EXPECTED_IDENTITY.files.map((file, index) =>
    index === 0 ? { ...file, sha256: 'a'.repeat(64) } : file,
  );
  assert.notEqual(entries({ files: swappedWeights }), base, '模型权重变了摘要必须变');
  assert.notEqual(
    entries({ group: { ...EXPECTED_IDENTITY.group, fingerprint: 'b'.repeat(64) } }),
    base,
    '运行时指纹变了摘要必须变',
  );
});

test('加载解析路径上的每一层由声明推出，且不含成组内容的内部与根层', () => {
  const layers = new Map(expectedLayers());
  assert.deepEqual([...layers.keys()].sort(), [
    'node_modules',
    'node_modules/onnxruntime-web',
    'node_modules/onnxruntime-web/dist',
  ]);
  assert.deepEqual(
    [...layers.get('node_modules')!].sort(),
    ['onnxruntime-common', 'onnxruntime-web'],
  );
  assert.deepEqual(
    [...layers.get('node_modules/onnxruntime-web')!].sort(),
    ['dist', 'package.json'],
  );
  assert.deepEqual(
    [...layers.get('node_modules/onnxruntime-web/dist')!].sort(),
    ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort.node.min.mjs'],
  );
  assert.equal(layers.has(`${GROUP_REL}/dist`), false, '成组内容的内部不得成为受检层');
  assert.equal(layers.has('.'), false, '模型目录根层不受条目集合约束');
});

test('判定：全新安装一致，根层的无关文件不影响', () => {
  const root = tempDir('recall-expected-');
  try {
    const { dir, expected } = syntheticInstall(root);
    assert.deepEqual(problemsFor(dir, expected), [], '符合声明的安装须判为一致');

    writeAt(dir, 'README.md', 'unrelated');
    writeAt(dir, 'MANIFEST.json.bak', '{"source":"elsewhere"}');
    assert.deepEqual(problemsFor(dir, expected), [], '根层的无关文件不得影响判定');
  } finally {
    removeDir(root);
  }
});

test('判定：解析路径上多出一层即不一致——副本不同或相同都一样', () => {
  const root = tempDir('recall-expected-');
  try {
    const { dir, expected } = syntheticInstall(root);

    // A different copy in the layer Node resolves first for the bare
    // `onnxruntime-common` specifier (``<pkg>/node_modules``).
    writeAt(dir, `node_modules/onnxruntime-web/node_modules/onnxruntime-common/index.js`, 'other\n');
    let problems = problemsFor(dir, expected);
    assert.equal(problems.length, 1, `期望恰好一条：${JSON.stringify(problems)}`);
    assert.equal(problems[0]!.kind, 'mismatch');
    assert.equal(problems[0]!.relPath, 'node_modules/onnxruntime-web');
    unlinkSync(join(dir, 'node_modules/onnxruntime-web/node_modules/onnxruntime-common/index.js'));

    // Same content, same name — still not the declared installation.
    writeAt(dir, `node_modules/onnxruntime-web/node_modules/onnxruntime-common/index.js`, 'common entry\n');
    problems = problemsFor(dir, expected);
    assert.equal(problems.length, 1, `同名同内容也须判不一致：${JSON.stringify(problems)}`);
    assert.equal(problems[0]!.kind, 'mismatch');

    // The other sibling on the resolution path: ``<pkg>/dist/node_modules``.
    writeAt(dir, `node_modules/onnxruntime-web/dist/node_modules/onnxruntime-common/index.js`, 'other\n');
    const paths = problemsFor(dir, expected).map((problem) => problem.relPath);
    assert.deepEqual(paths.sort(), ['node_modules/onnxruntime-web', 'node_modules/onnxruntime-web/dist']);
  } finally {
    removeDir(root);
  }
});

test('判定：缺失与不符分开报告', () => {
  const root = tempDir('recall-expected-');
  try {
    const { dir, expected } = syntheticInstall(root);
    unlinkSync(join(dir, 'tokenizer_config.json'));
    writeFileSync(join(dir, 'model_optimized.onnx'), 'synthetic weightz');

    const problems = problemsFor(dir, expected);
    const missing = problems.filter((problem) => problem.kind === 'missing');
    const mismatched = problems.filter((problem) => problem.kind === 'mismatch');
    assert.deepEqual(missing.map((problem) => problem.relPath), ['tokenizer_config.json']);
    assert.deepEqual(mismatched.map((problem) => problem.relPath), ['model_optimized.onnx']);

    const corrupt = mismatched[0]!;
    assert.match(corrupt.expected, /^sha256 [0-9a-f]{64}（\d+ B）$/);
    assert.match(corrupt.actual, /^sha256 [0-9a-f]{64}（\d+ B）$/);
    assert.notEqual(corrupt.expected, corrupt.actual, '不符时须同时给出期望与实际');
    assert.equal(missing[0]!.actual, '不存在');
  } finally {
    removeDir(root);
  }
});

test('判定：受检文件被换成符号链接报不符——即使链接指向同一份内容', () => {
  const root = tempDir('recall-expected-');
  try {
    const { dir, expected } = syntheticInstall(root);
    writeAt(dir, 'elsewhere/tokenizer.json', '{"model":{}}');
    unlinkSync(join(dir, 'tokenizer.json'));
    symlinkSync(join(dir, 'elsewhere/tokenizer.json'), join(dir, 'tokenizer.json'));

    const problems = problemsFor(dir, expected);
    assert.equal(problems.length, 1, `期望恰好一条：${JSON.stringify(problems)}`);
    assert.equal(problems[0]!.kind, 'mismatch', '链接存在，只是不是那一份，故是不符而非缺失');
    assert.equal(problems[0]!.relPath, 'tokenizer.json');
    assert.match(problems[0]!.actual, /符号链接/);
  } finally {
    removeDir(root);
  }
});

test('判定：成组内容内部的符号链接与空目录不影响指纹（已界定的限度）', () => {
  const root = tempDir('recall-expected-');
  try {
    const { dir, expected } = syntheticInstall(root);
    const common = join(dir, ...GROUP_REL.split('/'));
    const before = directoryFingerprint(common).fingerprint;
    mkdirSync(join(common, 'empty-subdir'), { recursive: true });
    symlinkSync(join(common, 'index.js'), join(common, 'link.js'));

    assert.equal(directoryFingerprint(common).fingerprint, before);
    assert.deepEqual(problemsFor(dir, expected), [], '限度如此：该组按整体指纹判，内部新增目录/链接看不见');
  } finally {
    removeDir(root);
  }
});

test('判定：截断与「期望值本身被改坏」也报不符', () => {
  const root = tempDir('recall-expected-');
  try {
    const { dir, expected } = syntheticInstall(root);

    // Truncation: the file exists, its size and digest both moved.
    writeFileSync(join(dir, 'tokenizer.json'), '{"model":{}');
    const truncated = problemsFor(dir, expected);
    assert.equal(truncated.length, 1);
    assert.equal(truncated[0]!.kind, 'mismatch');
    assert.equal(truncated[0]!.relPath, 'tokenizer.json');

    // A corrupted declaration must fail too — otherwise a wrong expectation
    // would silently bless a wrong installation.
    writeAt(dir, 'tokenizer.json', SYNTHETIC_FILES[1]![1]);
    const brokenFile = {
      ...expected,
      files: expected.files.map((file, index) =>
        index === 0 ? { ...file, sha256: 'c'.repeat(64) } : file,
      ),
    };
    const fromBrokenFile = problemsFor(dir, brokenFile);
    assert.deepEqual(fromBrokenFile.map((problem) => problem.relPath), ['model_optimized.onnx']);
    assert.equal(fromBrokenFile[0]!.kind, 'mismatch');

    const brokenGroup = {
      ...expected,
      group: { ...expected.group, fingerprint: 'd'.repeat(64) },
    };
    const fromBrokenGroup = problemsFor(dir, brokenGroup);
    assert.deepEqual(fromBrokenGroup.map((problem) => problem.relPath), [GROUP_REL]);
  } finally {
    removeDir(root);
  }
});

test('[4.2] 判定不读安装记录：删掉/改写它，结论不变', () => {
  const root = tempDir('recall-expected-');
  try {
    const { dir, expected } = syntheticInstall(root);
    const record = join(dir, 'MANIFEST.json');
    assert.deepEqual(problemsFor(dir, expected), []);

    unlinkSync(record);
    assert.deepEqual(problemsFor(dir, expected), [], '记录被删掉后结论不变');

    writeFileSync(record, '{"source":{"kind":"remote","repo":"someone/else"}}\n');
    assert.deepEqual(problemsFor(dir, expected), [], '记录被改写后结论不变');
  } finally {
    removeDir(root);
  }
});

test('[2.1] 判定读取安装记录的次数为零（并用对照证明打桩真的生效）', () => {
  const root = tempDir('recall-expected-');
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const original = fs.readFileSync;
  const seen: string[] = [];
  try {
    const { dir, expected } = syntheticInstall(root);
    fs.readFileSync = ((path: Parameters<typeof original>[0], ...rest: unknown[]) => {
      seen.push(String(path));
      return (original as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof original;
    syncBuiltinESMExports();

    verifyModelDir(dir, expected);
    assert.equal(
      seen.filter((path) => path.includes('MANIFEST')).length,
      0,
      '判定不得读安装记录（那是「实际装了什么」，不是「应该是哪一份」）',
    );

    // Control: without this, a stub that never fires would look like a pass.
    fs.readFileSync(join(dir, 'MANIFEST.json'), 'utf8');
    assert.equal(
      seen.filter((path) => path.includes('MANIFEST')).length,
      1,
      '打桩必须真的能记到对安装记录的读取',
    );
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
    removeDir(root);
  }
});
