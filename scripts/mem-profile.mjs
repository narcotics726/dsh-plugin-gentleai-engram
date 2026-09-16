#!/usr/bin/env node
/**
 * mem-profile.mjs — the resident retrieval worker's memory CURVE.
 *
 * The read layer's cross-platform criterion is "1 thread, steady state ≤ 600 MB"
 * (method and boundaries: an internal note). This is the tool that
 * measures it, on the SHIPPED worker process rather than on a bare embedder:
 * the reading therefore includes the engine, the open index and the scorer, and
 * is legitimately higher than the spike's 505/514 MB — that older number came
 * from a script that only created an `Embedder` and nothing else.
 *
 * One peak cannot answer "can this sit in a process all day", so three numbers:
 *   floor   — after the model is loaded (the cost of merely being ready)
 *   steady  — under continuous querying (the leak check)
 *   peak    — the maximum RSS sampled while running
 *
 * RSS is read with `ps -o rss= -p <pid>` — kilobytes on both Linux and macOS.
 * `/proc/self/status` (what the spike used) exists only on Linux, and the machine
 * this exists for is a Mac. `peak` is the max of periodic SAMPLES, not an exact
 * high-water mark; say so when quoting it.
 *
 * Usage:
 *   node scripts/mem-profile.mjs [--model-dir D] [--db D] [--index D]
 *                                [--threads 1] [--queries 500] [--interval-ms 100]
 *                                [--rebuild-threads 16] [--skip-rebuild]
 *                                [--query TEXT] [--project P]
 *
 * Exit: 0 criterion met, 1 criterion missed, 2 setup error.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(REPO, 'dist', 'recall', 'worker.js');

/** Criterion: 1 thread, steady state. Change it only with the spec. */
const STEADY_LIMIT_MB = 600;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`mem-profile: ${name} 需要一个值`);
    process.exit(2);
  }
  return value;
}

const num = (name, fallback) => {
  const raw = arg(name);
  return raw === undefined ? fallback : Number(raw);
};

if (!existsSync(WORKER)) {
  console.error(`mem-profile: 找不到 ${WORKER}。先构建：\`pnpm build\`（或 node_modules/.bin/tsc -p tsconfig.json）。`);
  process.exit(2);
}

const {
  defaultSearchDbPath,
  defaultSearchIndexDir,
  defaultSearchModelDir,
} = await import(join(REPO, 'dist', 'config.js'));
const { inspectIndex } = await import(join(REPO, 'dist', 'recall', 'index-db.js'));

const modelDir = resolve(arg('--model-dir', defaultSearchModelDir()));
const dbPath = resolve(arg('--db', defaultSearchDbPath()));
const indexPath = resolve(arg('--index', join(defaultSearchIndexDir(), 'index.db')));
const threads = num('--threads', 1);
const queries = num('--queries', 500);
const intervalMs = num('--interval-ms', 100);
const rebuildThreads = num('--rebuild-threads', Math.max(1, Math.min(16, Number(process.env.MEM_PROFILE_REBUILD_THREADS ?? 16))));
/** Sampling cadence for the one-shot peak (a 10-min run tolerates a coarse one). */
const sampleMs = num('--sample-ms', 250);
/**
 * The resident's production cap (design D4: 1300 ms·thread/doc, threads clamped
 * to the measured range). The resident must stay bounded — only the diagnostic
 * one-shot below is allowed to be `unlimited`.
 */
const residentMaxDocs = Math.max(0, Math.floor((60_000 * Math.min(16, threads)) / 1300));
const query = arg('--query', '检索层内存复测 常驻 worker 稳态');
const project = arg('--project', undefined);

for (const [label, path] of [['模型目录', modelDir], ['源库', dbPath]]) {
  if (!existsSync(path)) {
    console.error(`mem-profile: ${label}不存在：${path}`);
    process.exit(2);
  }
}
mkdirSync(dirname(indexPath), { recursive: true });

const env = (extraThreads, maxDocs) => ({
  ...process.env,
  ENGRAM_BRIDGE_DB_PATH: dbPath,
  ENGRAM_BRIDGE_INDEX_PATH: indexPath,
  ENGRAM_BRIDGE_MODEL_DIR: modelDir,
  ENGRAM_BRIDGE_THREADS: String(extraThreads),
  ENGRAM_BRIDGE_W: '0.2',
  ENGRAM_BRIDGE_TOP_K: '50',
  ENGRAM_BRIDGE_COVERAGE: 'field_cov',
  // Diagnostics override the cap: this tool has to initialize an index whose
  // corpus may exceed what one production call may do, and it must never be
  // refused for that (design D2's `unlimited` is the explicit value).
  ENGRAM_BRIDGE_MAX_DOCS: maxDocs,
  ENGRAM_BRIDGE_LOCK_WAIT_MS: '30000',
  ENGRAM_BRIDGE_BUSY_TIMEOUT_MS: '60000',
});

/** Resident memory in MB (KB on Linux and macOS alike). */
function rssMb(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
  } catch {
    return undefined;
  }
}

/**
 * Sample a short-lived one-shot child's RSS until it exits, and report the
 * peak. This is the number the resident judgement cannot cover: the transient
 * high-thread process (`design.md` D4/D7, and the one open item in its Risks).
 */
async function sampleOneShot(mode, threads) {
  const child = spawn(process.execPath, [WORKER, mode], {
    env: env(threads, 'unlimited'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const samples = [];
  let alive = true;
  child.on('exit', () => {
    alive = false;
  });
  while (alive && child.pid !== undefined) {
    const mb = rssMb(child.pid);
    if (mb !== undefined) samples.push(mb);
    await sleep(sampleMs);
  }
  const code = await new Promise((done) => child.on('exit', (c) => done(c ?? 1)));
  return { code, peak: samples.length > 0 ? Math.max(...samples) : undefined, samples: samples.length };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- full build

const inspection = inspectIndex(indexPath);
if (inspection.needsFullBuild) {
  if (process.argv.includes('--skip-rebuild')) {
    console.error(`mem-profile: 索引需要重建（${inspection.reason}）但给了 --skip-rebuild`);
    process.exit(2);
  }
  console.log(`mem-profile: 索引需要重建（${inspection.reason}），先用 ${rebuildThreads} 线程跑一次全量`);
  const t0 = Date.now();
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [WORKER, '--rebuild'], { env: env(rebuildThreads, 'unlimited'), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(`  ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`  ${chunk}`));
    child.on('exit', (exitCode) => done(exitCode ?? 1));
  });
  if (code !== 0) {
    console.error(`mem-profile: 全量重建失败（exit=${code}）`);
    process.exit(2);
  }
  console.log(`  重建完成 ${((Date.now() - t0) / 1000).toFixed(1)}s（这一段是 ${rebuildThreads} 线程的峰值，不计入下面的稳态）`);
}

// ---------------------------------------------------- one-shot transient peak

if (process.argv.includes('--oneshot-peak')) {
  console.log(`mem-profile: 量一次性进程的瞬时峰值（${rebuildThreads} 线程，--sync，上限 unlimited）`);
  const { code, peak, samples } = await sampleOneShot('--sync', rebuildThreads);
  console.log(
    `  退出码 ${code}，采样 ${samples} 次，峰值 ${peak === undefined ? '—' : `${peak.toFixed(0)} MB`}`,
  );
  console.log('  这条读数管的是常驻判据管不到的那一段（短命高线程进程），见 design.md 的 Risks。');
  process.exit(code === 0 ? 0 : 2);
}

// ------------------------------------------------------------- resident worker

const samples = [];
const child = spawn(process.execPath, [WORKER], { env: env(threads, String(residentMaxDocs)), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
let pid;
let readyThreads = threads;
let stderr = '';
const waiting = [];

createInterface({ input: child.stdout }).on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (frame.type === 'ready') {
    pid = frame.pid;
    readyThreads = frame.threads;
    return;
  }
  if (frame.type === 'log') {
    if (frame.level === 'warn' || frame.level === 'error') console.error(`  worker ${frame.level}: ${frame.message}`);
    return;
  }
  if (frame.type === 'response') waiting.shift()?.(frame);
});
createInterface({ input: child.stderr }).on('line', (line) => {
  stderr += `${line}\n`;
});

const sampleTimer = setInterval(() => {
  if (pid === undefined) return;
  const mb = rssMb(pid);
  if (mb !== undefined) samples.push(mb);
}, intervalMs);

function request(id, cmd, extra = {}) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`mem-profile: worker 未在 120s 内回应\n${stderr}`)), 120000);
    waiting.push((frame) => {
      clearTimeout(timer);
      done(frame);
    });
    child.stdin.write(`${JSON.stringify({ id, cmd, ...extra })}\n`);
  });
}

const shutdown = () => {
  clearInterval(sampleTimer);
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};

let failures = 0;
try {
  // Wait for the ready frame so the pid is known before the model is loaded.
  const deadline = Date.now() + 30000;
  while (pid === undefined && Date.now() < deadline) await sleep(50);
  if (pid === undefined) throw new Error('mem-profile: worker 没报 ready');
  console.log(`mem-profile: worker pid=${pid} threads=${readyThreads}（采样间隔 ${intervalMs}ms）`);

  const floorStart = rssMb(pid);
  const latencies = [];
  let firstRssAfterQuery;
  for (let i = 0; i < queries; i++) {
    const frame = await request(i + 1, 'query', {
      query: { query, limit: 1, ...(project === undefined ? {} : { project }) },
    });
    if (!frame.ok) throw new Error(`mem-profile: 第 ${i + 1} 次检索失败：${JSON.stringify(frame.error)}`);
    latencies.push(frame.result?.metering?.totalMs ?? 0);
    if (i === 0) {
      await sleep(Math.max(intervalMs, 50)); // let the first post-load sample land
      firstRssAfterQuery = samples[samples.length - 1];
    }
  }
  await sleep(intervalMs);

  const floor = firstRssAfterQuery ?? floorStart;
  const tail = samples.slice(Math.floor(samples.length / 2));
  const sorted = [...tail].sort((a, b) => a - b);
  const steady = sorted[Math.floor(sorted.length / 2)];
  const peak = Math.max(...samples);
  const sortedLatency = [...latencies].sort((a, b) => a - b);

  console.log('');
  console.log(`  就绪前 RSS        ${floorStart === undefined ? '—' : `${floorStart.toFixed(0)} MB`}`);
  console.log(`  稳态 floor        ${floor.toFixed(0)} MB  （模型加载后，样本 ${samples.length} 个）`);
  console.log(`  稳态 steady       ${steady.toFixed(0)} MB  （后半段样本中位）`);
  console.log(`  采样峰值 peak     ${peak.toFixed(0)} MB  （采样值，不是精确 HWM）`);
  console.log(`  单次检索中位      ${sortedLatency[Math.floor(sortedLatency.length / 2)].toFixed(1)} ms  （${latencies.length} 次，${threads} 线程）`);
  const verdict = steady <= STEADY_LIMIT_MB;
  console.log('');
  console.log(
    `  判据：${threads} 线程稳态 ≤ ${STEADY_LIMIT_MB} MB → ${verdict ? '通过' : '未通过'}（实测 ${steady.toFixed(0)} MB）`,
  );
  failures = verdict ? 0 : 1;
} catch (error) {
  console.error(String(error.message ?? error));
  failures = 2;
} finally {
  shutdown();
}
process.exit(failures);
