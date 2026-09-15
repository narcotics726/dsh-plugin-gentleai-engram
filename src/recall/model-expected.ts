import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The expected identity of the artifacts retrieval needs — declared **here, in
 * the repository**, not read back from an installation.
 *
 * Why this file exists at all (design D0): if the expected digests came from
 * the install step's own record (`MANIFEST.json`), then "is this the declared
 * artifact?" would degenerate into "is this whatever the last install wrote?" —
 * a tautology that passes for a truncated download, a swapped `--model-from`
 * source, and a runtime swapped for another version. Pinning the declaration in
 * the repository is what makes the judgement independent of any one machine:
 * editing or deleting an installation's record does not move the conclusion.
 *
 * The module is deliberately pure `node:fs` / `node:path` / `node:crypto`: it is
 * the single declaration shared by the host process, the install script (which
 * reads the compiled copy from `dist/`, design D11) and the tests. It must stay
 * free of anything that would put the embedding runtime into the host entry's
 * module closure — `pnpm check:boundary` is the mechanism that proves it.
 *
 * Every value below is a measurement, not a guess: the file digests were
 * recomputed from the installed directory, and the runtime was independently
 * re-derived from the pinned dependency under `node_modules/.pnpm/` (design D9,
 * task 1.2). The model half is anchored at a pinned HuggingFace revision whose
 * bytes were re-fetched and compared (design D2).
 */

/** macOS metadata that is never part of an installation (design D3). */
export function isExcludedName(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._');
}

export interface ExpectedFile {
  /** POSIX-relative path inside the model directory. */
  relPath: string;
  bytes: number;
  sha256: string;
  /** Human label used in failure messages. */
  what: string;
}

/**
 * A path checked as one opaque entry rather than entry by entry.
 *
 * `onnxruntime-common` is deployed as a whole package, and the fingerprint
 * below does not describe its interior (it only counts regular files), so
 * enumerating its layers would be a promise this declaration cannot keep. The
 * group's overall fingerprint **is** its whole criterion — the coverage gap is
 * written down as a limit instead of papered over (design D3).
 */
export interface ExpectedGroup {
  relPath: string;
  algorithm: string;
  fingerprint: string;
  files: number;
  bytes: number;
  what: string;
}

export interface ExpectedIdentity {
  /** Individually checked files, POSIX-relative to the model directory. */
  files: readonly ExpectedFile[];
  /** The one directory checked as a single opaque entry. */
  group: ExpectedGroup;
  /**
   * What the declaration is anchored to. Not used for judging — an installation
   * is judged by the digests above — but required to re-derive the declaration
   * independently (design D2).
   */
  model: {
    readonly repo: string;
    readonly revision: string;
    readonly files: readonly string[];
  };
  runtime: {
    readonly package: string;
    readonly version: string;
  };
}

/** Fingerprint algorithm version: changing the algorithm changes this string. */
export const GROUP_ALGORITHM = 'sha256-relpath-hash-v1';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * The declaration. Frozen deeply — `Object.freeze` alone is shallow and would
 * leave nested digests writable by anyone holding a reference.
 */
export const EXPECTED_IDENTITY: ExpectedIdentity = deepFreeze({
  files: [
    {
      relPath: 'model_optimized.onnx',
      bytes: 94_781_076,
      sha256: '1294ea4b6331115a353d81f96b85e8c8d7fdcc284453d5b2fab5b016230aad38',
      what: '嵌入模型 model_optimized.onnx',
    },
    {
      relPath: 'tokenizer.json',
      bytes: 439_125,
      sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
      what: '分词器 tokenizer.json',
    },
    {
      relPath: 'tokenizer_config.json',
      bytes: 367,
      sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
      what: '分词器配置 tokenizer_config.json',
    },
    {
      relPath: 'node_modules/onnxruntime-web/package.json',
      bytes: 4_593,
      sha256: '9c803baa1820e75a82907bbf29c0a4be84d4eaec33693b4ab3bd5051fde85ee9',
      what: 'onnxruntime-web 包描述',
    },
    {
      relPath: 'node_modules/onnxruntime-web/dist/ort.node.min.mjs',
      bytes: 27_061,
      sha256: 'd03374770621e06e4750482236ec6dbd6299d0205b9de44b9eebe52a0721ef71',
      what: 'onnxruntime-web Node 入口',
    },
    {
      relPath: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
      bytes: 24_218,
      sha256: '5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747',
      what: 'onnxruntime-web Emscripten glue',
    },
    {
      relPath: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
      bytes: 13_961_845,
      sha256: 'ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d',
      what: 'onnxruntime-web SIMD+threads 运行时',
    },
  ],
  group: {
    relPath: 'node_modules/onnxruntime-common',
    algorithm: GROUP_ALGORITHM,
    fingerprint: '8aeb72b1bbfbed33f8d9e614b4c63ebf95328595e6640885dd2082bd0cf8024c',
    files: 193,
    bytes: 573_091,
    what: 'onnxruntime-common 包',
  },
  model: {
    repo: 'Qdrant/bge-small-zh-v1.5',
    revision: '46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59',
    files: ['model_optimized.onnx', 'tokenizer.json', 'tokenizer_config.json'],
  },
  runtime: {
    package: 'onnxruntime-web',
    version: '1.29.0',
  },
});

export interface DirectoryFingerprint {
  algorithm: string;
  fingerprint: string;
  files: number;
  bytes: number;
}

/**
 * Fingerprint of a directory, pinned verbatim so it can be re-derived by anyone
 * (design D8):
 *
 * - baseline: the directory passed in (for the group, its own path — **not** the
 *   model directory, whose contents change on every install);
 * - entries: regular files only, recursion never follows a symlink;
 * - names: POSIX separators, sorted by UTF-16 code unit (plain `<`, **not**
 *   `localeCompare` — the two orders produce different digests);
 * - material: `` `${relPath}\n${sha256}\n` `` concatenated in that order;
 * - digest: sha256 of the material;
 * - excluded: `.DS_Store`, `._*`.
 *
 * Symlinks, directories and other entry types contribute nothing. That is a
 * documented limit rather than a guarantee: a directory or a symlink added
 * inside the group is invisible to this digest (design D3), which is why the
 * group is treated as one opaque entry instead of pretending to enumerate it.
 */
export function directoryFingerprint(dir: string): DirectoryFingerprint {
  const entries: Array<[string, string]> = [];
  let bytes = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (isExcludedName(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // `isFile()` comes from the directory entry itself (lstat semantics), so a
      // symlink is not a file here even when it points at one.
      if (!entry.isFile()) continue;
      const data = readFileSync(full);
      bytes += data.byteLength;
      entries.push([
        relative(dir, full).split(sep).join('/'),
        createHash('sha256').update(data).digest('hex'),
      ]);
    }
  };
  walk(dir);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const material = entries.map(([relPath, hash]) => `${relPath}\n${hash}\n`).join('');
  return {
    algorithm: GROUP_ALGORITHM,
    fingerprint: createHash('sha256').update(material).digest('hex'),
    files: entries.length,
    bytes,
  };
}

/**
 * Digest of the whole declaration: the value the derived index records as the
 * generation it was built from (design D10).
 *
 * It has to cover the **model weights**. A digest of the runtime directory does
 * not change when `model_optimized.onnx` is swapped, so "same generation" would
 * hold across a model change and the index would keep answering from the
 * previous vector space — silently, forever.
 */
export function expectedIdentityDigest(expected: ExpectedIdentity = EXPECTED_IDENTITY): string {
  const material = [
    ...expected.files.map((file) => `file\n${file.relPath}\n${file.bytes}\n${file.sha256}\n`),
    `group\n${expected.group.relPath}\n${expected.group.algorithm}\n${expected.group.fingerprint}\n` +
      `${expected.group.files}\n${expected.group.bytes}\n`,
  ].join('');
  return createHash('sha256').update(material).digest('hex');
}

export interface IdentityProblem {
  kind: 'missing' | 'mismatch';
  relPath: string;
  what: string;
  expected: string;
  actual: string;
}

type EntryType = 'absent' | 'file' | 'directory' | 'symlink' | 'other';

function entryType(path: string): EntryType {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) return 'absent';
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  if (info.isSymbolicLink()) return 'symlink';
  return 'other';
}

function typeLabel(type: EntryType): string {
  switch (type) {
    case 'absent':
      return '不存在';
    case 'directory':
      return '目录（期望常规文件）';
    case 'symlink':
      return '符号链接（期望常规文件）';
    default:
      return '非常规文件';
  }
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function checkFile(dir: string, file: ExpectedFile): IdentityProblem | undefined {
  const expected = `sha256 ${file.sha256}（${file.bytes} B）`;
  const type = entryType(join(dir, ...file.relPath.split('/')));
  if (type === 'absent') {
    return { kind: 'missing', relPath: file.relPath, what: file.what, expected, actual: '不存在' };
  }
  if (type !== 'file') {
    return {
      kind: 'mismatch',
      relPath: file.relPath,
      what: file.what,
      expected,
      actual: typeLabel(type),
    };
  }
  const data = readFileSync(join(dir, ...file.relPath.split('/')));
  const hash = sha256Hex(data);
  if (data.byteLength !== file.bytes || hash !== file.sha256) {
    return {
      kind: 'mismatch',
      relPath: file.relPath,
      what: file.what,
      expected,
      actual: `sha256 ${hash}（${data.byteLength} B）`,
    };
  }
  return undefined;
}

function checkGroup(dir: string, group: ExpectedGroup): IdentityProblem | undefined {
  const expected = `${group.algorithm} ${group.fingerprint}（${group.files} 文件 / ${group.bytes} B）`;
  const path = join(dir, ...group.relPath.split('/'));
  const type = entryType(path);
  if (type === 'absent') {
    return { kind: 'missing', relPath: group.relPath, what: group.what, expected, actual: '不存在' };
  }
  if (type !== 'directory') {
    const label = type === 'file' ? '常规文件（期望目录）' : typeLabel(type);
    return { kind: 'mismatch', relPath: group.relPath, what: group.what, expected, actual: label };
  }
  const actual = directoryFingerprint(path);
  const summary = `${actual.algorithm} ${actual.fingerprint}（${actual.files} 文件 / ${actual.bytes} B）`;
  if (
    actual.fingerprint !== group.fingerprint ||
    actual.files !== group.files ||
    actual.bytes !== group.bytes
  ) {
    return {
      kind: 'mismatch',
      relPath: group.relPath,
      what: group.what,
      expected,
      actual: summary,
    };
  }
  return undefined;
}

/**
 * The entry sets each layer on the loading path must have, derived from the
 * declaration so it cannot drift from it.
 *
 * Only layers under `node_modules/` are returned: the model directory's root
 * layer is deliberately exempt, because harmless things live there (the install
 * record, dot-files) and nothing in it is resolved by the runtime (design D3).
 * The group's own interior never becomes a layer — it is one opaque entry in
 * its parent.
 */
export function expectedLayers(expected: ExpectedIdentity = EXPECTED_IDENTITY): Array<[string, Set<string>]> {
  const layers = new Map<string, Set<string>>();
  const record = (relPath: string): void => {
    const segments = relPath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const layer = segments.slice(0, index).join('/');
      const name = segments[index]!;
      let names = layers.get(layer);
      if (names === undefined) {
        names = new Set();
        layers.set(layer, names);
      }
      names.add(name);
    }
  };
  for (const file of expected.files) record(file.relPath);
  record(expected.group.relPath);
  return [...layers.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * A layer may contain **extra** entries only. Absence is already reported, more
 * precisely, by the file and group checks above: every declared name in these
 * layers is either a declared file, the group, or a directory leading to one.
 *
 * The rule exists for what file checks cannot see: `ort.node.min.mjs` resolves
 * `onnxruntime-common` as a bare specifier, so a second copy planted at
 * `<pkg>/node_modules` or `<pkg>/dist/node_modules` is loaded even though every
 * declared file is intact. Entry names therefore count whatever their type is —
 * a symlink is an entry too, and following it would be exactly the shadowing
 * this rule is here to catch.
 */
function checkLayer(dir: string, layer: string, names: Set<string>): IdentityProblem | undefined {
  const path = join(dir, ...layer.split('/'));
  const expected = `条目集合 { ${[...names].sort().join(', ')} }`;
  const type = entryType(path);
  if (type === 'absent') {
    return { kind: 'missing', relPath: layer, what: `${layer} 层`, expected, actual: '不存在' };
  }
  if (type !== 'directory') {
    return {
      kind: 'mismatch',
      relPath: layer,
      what: `${layer} 层`,
      expected,
      actual: type === 'symlink' ? '符号链接（期望目录）' : typeLabel(type),
    };
  }
  const actual = new Set(readdirSync(path).filter((name) => !isExcludedName(name)));
  const extra = [...actual].filter((name) => !names.has(name)).sort();
  if (extra.length === 0) return undefined;
  return {
    kind: 'mismatch',
    relPath: layer,
    what: `${layer} 层`,
    expected,
    actual: `多出 ${extra.map((name) => `「${name}」`).join('、')}`,
  };
}

/**
 * Judge an installed directory against the declared identity (design D3).
 *
 * `missing` and `mismatch` are kept apart on purpose: the remedies differ (go
 * install it, versus find out what changed it), and the spec requires the two
 * to be distinguishable.
 *
 * Only the root layer of `dir` is exempt from the entry-set rule; nothing else
 * is relaxed. The install record is never read — that is the whole point (D0).
 */
export function verifyModelDir(
  dir: string,
  expected: ExpectedIdentity = EXPECTED_IDENTITY,
): IdentityProblem[] {
  const problems: IdentityProblem[] = [];
  for (const file of expected.files) {
    const problem = checkFile(dir, file);
    if (problem !== undefined) problems.push(problem);
  }
  const group = checkGroup(dir, expected.group);
  if (group !== undefined) problems.push(group);
  for (const [layer, names] of expectedLayers(expected)) {
    const problem = checkLayer(dir, layer, names);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}
