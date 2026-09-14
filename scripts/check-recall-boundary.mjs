#!/usr/bin/env node
/**
 * Boundary check: the host entry must not reach the embedding runtime.
 *
 * Hard rule 7 allows a pure-JS/WASM third-party dependency only inside a
 * subprocess, and demands a MECHANISM proving the host entry does not load it —
 * a declaration in a document is not evidence. This script walks the static
 * import closure of `dist/index.js` (the host entry named by package.json's
 * `main`) and fails if any of it resolves to `onnxruntime-web`, or to the worker
 * and embedder modules that exist precisely to keep that import out of the host.
 *
 * `import type` is erased by tsc, so the type-only reference to the package in
 * `src/recall/embed.ts` does not appear here.
 *
 * Usage: node scripts/check-recall-boundary.mjs [entry]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = process.argv[2] ?? join(REPO, 'dist', 'index.js');

/** Specifiers that must never be reachable from the host entry. */
const FORBIDDEN_PACKAGES = ['onnxruntime-web', 'onnxruntime-common', 'onnxruntime-node'];
/** Files that only the worker subprocess may load. */
const FORBIDDEN_FILES = new Set(['embed.js', 'worker.js']);

const SPECIFIER = /(?:^|[^\w$.])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(source) {
  const out = new Set();
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (typeof specifier === 'string' && specifier !== '') out.add(specifier);
  }
  return [...out];
}

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function isForbidden(specifier) {
  return FORBIDDEN_PACKAGES.some(
    (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
  );
}

function walk(entry) {
  if (!existsSync(entry)) {
    console.error(`boundary: host entry not found: ${entry} (run \`pnpm build\` first)`);
    process.exit(2);
  }
  const seen = new Set();
  const queue = [entry];
  const violations = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (isForbidden(specifier)) {
        violations.push(`${file} imports ${specifier}`);
        continue;
      }
      const next = resolveRelative(file, specifier);
      if (next === undefined) continue;
      if (FORBIDDEN_FILES.has(next.split('/').pop())) {
        violations.push(`${file} imports ${next}`);
        continue;
      }
      queue.push(next);
    }
  }
  return { seen, violations };
}

const { seen, violations } = walk(ENTRY);
if (violations.length > 0) {
  console.error('boundary: FAIL — 宿主入口的 import 闭包触及了嵌入运行时：');
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    '硬规则 7：嵌入运行时只能由子进程加载。请把该引用移到 src/recall/worker.ts（或 embed.ts）一侧。',
  );
  process.exit(1);
}

const modules = readdirSync(join(REPO, 'dist'), { recursive: true }).filter((name) =>
  typeof name === 'string' && name.endsWith('.js'),
).length;
console.log(
  `boundary: ok — 宿主入口闭包 ${seen.size} 个模块，未触及 ${FORBIDDEN_PACKAGES.join(' / ')}；dist 共 ${modules} 个 .js`,
);
