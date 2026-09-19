#!/usr/bin/env node
/**
 * Minimal stdio MCP server standing in for the real engram binary in the DEFAULT gate.
 *
 * It speaks exactly what the bridge speaks (`initialize`, `notifications/initialized`,
 * `tools/list`, `tools/call`), records every `tools/call` as one JSON line in
 * `$ENGRAM_STUB_LOG`, and replays canned engram envelopes. Tests therefore assert what the
 * bridge SUBMITTED (content, source, session_id) without needing the real binary.
 */
import { appendFileSync } from 'node:fs';
import { TOOLS } from './engram-tools.mjs';

const LOG = process.env.ENGRAM_STUB_LOG;

// `ENGRAM_STUB_NO_PROJECT=1` makes every envelope omit the project fields, which
// is how the write-layer tests construct "the backend did not give us a project".
const envelope = (result, extra = {}) => ({
  type: 'text',
  text: JSON.stringify({
    ...(process.env.ENGRAM_STUB_NO_PROJECT === '1'
      ? {}
      : { project: 'stub-project', project_source: 'stub' }),
    result,
    ...extra,
  }),
});

function respondFor(name) {
  if (name === 'mem_session_start') return { content: [envelope('session started')] };
  if (name === 'mem_capture_passive') {
    return { content: [envelope('Passive capture complete: extracted=1 saved=1 duplicates=0')] };
  }
  if (name === 'mem_session_summary') return { content: [envelope('summary saved')] };
  if (name === 'mem_context') return { content: [envelope('STUB RECALL: recent memory context for this session')] };
  if (name === 'mem_save') {
    // The upstream save tool's envelope: the id of the row it wrote or updated,
    // plus — unconditionally, in the real backend — its own candidate scan and the
    // pending relation it inserted for it. The fallback path has to keep the id
    // and drop the rest.
    return {
      content: [
        envelope('Memory saved: "stub" (manual)\nCONFLICT REVIEW PENDING — 1 candidate(s); use mem_judge to record verdicts.', {
          id: 4242,
          sync_id: 'obs-stub',
          state: 'active',
          judgment_required: true,
          judgment_status: 'pending',
          judgment_id: 'rel-stub',
          candidates: [
            { id: 9, sync_id: 'obs-9', title: 'stub candidate', type: 'decision', score: -0.000002, judgment_id: 'rel-stub' },
          ],
        }),
      ],
    };
  }
  return { content: [envelope('ok')] };
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notification: nothing to answer
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'engram-stub', version: '0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof LOG === 'string' && LOG !== '') {
      try {
        appendFileSync(LOG, `${JSON.stringify({ name, args, cwd: process.cwd() })}\n`);
      } catch {
        /* the log is a test aid, never fatal */
      }
    }
    send({ jsonrpc: '2.0', id, result: respondFor(name) });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } });
}

// Child lifetime is observable: the pool's idle reclaim is asserted by waiting for this line.
// `child.kill()` sends SIGTERM, whose default action skips `exit` handlers, so the signal
// itself has to write the marker before terminating.
function logExit() {
  if (typeof LOG === 'string' && LOG !== '') {
    try {
      appendFileSync(LOG, `${JSON.stringify({ event: 'exit', cwd: process.cwd() })}\n`);
    } catch {
      /* test aid only */
    }
  }
}
process.on('exit', logExit);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    logExit();
    process.exit(0);
  });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed input */
    }
  }
});
