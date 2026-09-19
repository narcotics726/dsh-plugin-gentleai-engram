/**
 * Protocol stub for the recall worker.
 *
 * Used by test/recall-process.test.ts to exercise the host-side LIFECYCLE
 * (lazy start, reuse, idle reclaim, timeout, teardown, the refusal path and the
 * one-shot path) without a model, without WASM, and without the real engine. It
 * speaks exactly the frames src/recall/process.ts expects and nothing more.
 *
 * Environment:
 *   STUB_SYNC_NEEDED=n     first queries answer { kind: 'sync-needed' } with n pending
 *   STUB_DEFERRAL_MODE=m   'incremental' (default) or 'full'
 *   STUB_BUSY=1            queries answer { kind: 'busy' }
 *   STUB_QUERY_DELAY_MS=n  delay query responses
 *   STUB_CANDIDATES_DELAY_MS=n  delay candidate responses (drives the budget test)
 *   STUB_SYNC_DELAY_MS=n   delay the one-shot exit (keeps a one-shot in flight)
 *   STUB_SYNC_EXIT=n       one-shot exit code (sync mode)
 *   STUB_REBUILD_EXIT=n    one-shot exit code (rebuild mode)
 *   STUB_FLAG=<path>       where a run leaves its fingerprints
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const flag = process.env.STUB_FLAG ?? '';
const note = (line) => {
  if (flag !== '') appendFileSync(`${flag}.log`, `${line}\n`);
};
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

const oneShotMode = process.argv.includes('--rebuild')
  ? 'rebuild'
  : process.argv.includes('--sync')
    ? 'sync'
    : undefined;

if (oneShotMode !== undefined) {
  note(oneShotMode);
  writeFileSync(`${flag}.${oneShotMode}`, 'done');
  process.stdout.write(
    oneShotMode === 'rebuild' ? '全量重建完成：stub\n' : '增量同步完成：stub\n',
  );
  const exitCode = Number(
    (oneShotMode === 'rebuild' ? process.env.STUB_REBUILD_EXIT : process.env.STUB_SYNC_EXIT) ?? 0,
  );
  const delay = Number(process.env.STUB_SYNC_DELAY_MS ?? 0);
  // Stay in one-shot mode: a scheduled exit must NOT fall through into the
  // resident server below (that would make the "child" exit 0 on stdin EOF and
  // silently turn a long run into an instant success).
  if (delay > 0) setTimeout(() => process.exit(exitCode), delay);
  else process.exit(exitCode);
} else {
  serve();
}

function serve() {
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
  const candidateDelay = Number(process.env.STUB_CANDIDATES_DELAY_MS ?? 0);
  // The candidate command's contract is "answer or degrade, never fail": the host
  // abandons its own request on the budget, so the stub just answers (late, when a
  // delay is configured) with the empty shape.
  const emptyCandidates = {
    candidates: [],
    poolIds: [],
    metering: {
      sourceChanged: false,
      lagDocs: 0,
      docCount: 0,
      candidates: 0,
      poolSize: 0,
      filteredOut: 0,
      hashMs: 0,
      embedMs: 0,
      scoreMs: 0,
      totalMs: 0,
    },
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const request = JSON.parse(line);
    note(`cmd:${request.cmd}`);
    if (request.cmd === 'shutdown') {
      write({ type: 'response', id: request.id, ok: true, result: { ok: true } });
      setImmediate(() => process.exit(0));
      return;
    }
    if (request.cmd === 'query' && process.env.STUB_SYNC_NEEDED && !existsSync(`${flag}.sync`)) {
      write({
        type: 'response',
        id: request.id,
        ok: false,
        error: {
          kind: 'sync-needed',
          message: 'stub: 本次调用做不完所需的工作',
          deferral: {
            mode: process.env.STUB_DEFERRAL_MODE ?? 'incremental',
            pendingDocs: Number(process.env.STUB_SYNC_NEEDED),
          },
        },
      });
      return;
    }
    if (request.cmd === 'query' && process.env.STUB_BUSY === '1') {
      write({
        type: 'response',
        id: request.id,
        ok: false,
        error: { kind: 'busy', message: 'stub: 索引正在被另一个进程更新（等待 2000ms 后仍被占用）' },
      });
      return;
    }
    if (request.cmd === 'candidates') {
      const respond = () =>
        write({ type: 'response', id: request.id, ok: true, result: emptyCandidates });
      if (candidateDelay > 0) setTimeout(respond, candidateDelay);
      else respond();
      return;
    }
    const respond = () => write({ type: 'response', id: request.id, ok: true, result: payload(request.query ?? {}) });
    if (request.cmd === 'query' && delay > 0) setTimeout(respond, delay);
    else respond();
  });
  rl.on('close', () => setImmediate(() => process.exit(0)));
}
