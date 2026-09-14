/**
 * Protocol stub for the resident recall worker.
 *
 * Used by test/recall-process.test.ts to exercise the host-side LIFECYCLE
 * (lazy start, reuse, idle reclaim, timeout, teardown, rebuild-and-retry)
 * without a model, without WASM, and without the real engine. It speaks exactly
 * the frames src/recall/process.ts expects and nothing more.
 *
 * Environment:
 *   STUB_REBUILD_NEEDED=1   first query answers { kind: 'rebuild-needed' }
 *   STUB_QUERY_DELAY_MS=n   delay query responses
 *   STUB_FLAG=<path>        where a run leaves its fingerprints
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const flag = process.env.STUB_FLAG ?? '';
const note = (line) => {
  if (flag !== '') appendFileSync(`${flag}.log`, `${line}\n`);
};
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

if (process.argv.includes('--rebuild')) {
  note('rebuild');
  writeFileSync(`${flag}.rebuilt`, 'done');
  process.stdout.write('全量重建完成：stub\n');
  process.exit(Number(process.env.STUB_REBUILD_EXIT ?? 0));
}

write({ type: 'ready', pid: process.pid, threads: Number(process.env.ENGRAM_BRIDGE_THREADS ?? 1), modelDir: process.env.ENGRAM_BRIDGE_MODEL_DIR ?? '' });

const payload = (query) => ({
  hits: [
    {
      id: 1,
      title: 'stub',
      type: 'decision',
      project: query.project ?? '',
      scope: 'project',
      score: 0.5,
      excerpt: 'stub excerpt',
    },
  ],
  limit: query.limit,
  truncated: false,
  filteredOut: 0,
  poolSize: 0,
  candidates: 0,
  availableTypes: [],
  metering: {
    sourceChanged: false,
    rowsScanned: 0,
    docsTouched: 0,
    hashMs: 0,
    syncMs: 0,
    embedDocs: 0,
    embedLoadMs: 0,
    embedQueryMs: 0,
    scoreMs: 0,
    totalMs: 0,
    mode: 'noop',
    docCount: 0,
    indexBytes: 0,
  },
});

const delay = Number(process.env.STUB_QUERY_DELAY_MS ?? 0);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  note(`cmd:${request.cmd}`);
  if (request.cmd === 'shutdown') {
    write({ type: 'response', id: request.id, ok: true, result: { ok: true } });
    setImmediate(() => process.exit(0));
    return;
  }
  if (request.cmd === 'query' && process.env.STUB_REBUILD_NEEDED === '1' && !existsSync(`${flag}.rebuilt`)) {
    write({
      type: 'response',
      id: request.id,
      ok: false,
      error: { kind: 'rebuild-needed', message: 'stub: 需要重建' },
    });
    return;
  }
  const respond = () => write({ type: 'response', id: request.id, ok: true, result: payload(request.query ?? {}) });
  if (request.cmd === 'query' && delay > 0) setTimeout(respond, delay);
  else respond();
});
rl.on('close', () => setImmediate(() => process.exit(0)));
