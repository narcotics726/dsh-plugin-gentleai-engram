import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Package metadata the read layer depends on.
 *
 * `engines.node` is metadata only — a declaration, never an assertion. The host
 * process does not need `node:sqlite` (it is not in the host entry's closure),
 * but the retrieval subprocess does, and it is spawned with the SAME binary as
 * the host (`execPath` is never overridden anywhere in this repository). So
 * there is exactly one range to declare, and it is anchored at the measured
 * floor rather than at whatever version happened to be installed here.
 *
 *   measured: 24.16.0 and 26.7.0 both pass `node --test` and a real
 *   `worker.js --rebuild` (real model, real corpus) with exit 0.
 *
 * 22/23 were never measured, so they are not claimed.
 */

const REPO = process.cwd();

test('[5.1] engines.node 是实测下限 >=24，且不被运行期读取', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  assert.equal(pkg.engines?.node, '>=24');

  // No runtime assertion: the repository must not read this field, or the floor
  // would start behaving like a gate the code enforces differently from the
  // metadata it publishes.
  const offenders: string[] = [];
  for (const name of readdirSync(join(REPO, 'src'), { recursive: true })) {
    if (typeof name !== 'string' || !name.endsWith('.ts')) continue;
    const source = readFileSync(join(REPO, 'src', name), 'utf8');
    if (/\bengines\b/.test(source) || /process\.versions\.node/.test(source)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], 'src/ 不得在运行期读取 engines 或 process.versions.node');
});
