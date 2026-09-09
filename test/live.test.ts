import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { McpClient } from '../dist/mcp-client.js';

/**
 * Live integration against a real engram binary. Never touches ~/.engram:
 * ENGRAM_DATA_DIR points at a throwaway directory inside the repo.
 * Run with: ENGRAM_LIVE=1 pnpm test
 */
const live = process.env.ENGRAM_LIVE === '1';
const engramBin = process.env.ENGRAM_BIN ?? '/opt/homebrew/bin/engram';
const repo = process.cwd();
const dataDir = join(repo, 'test', '.tmp-live-data');
const item = (tag: string): string => `${tag}: alpha beta gamma delta epsilon zeta eta theta iota`;

test('live: binding, save, capture and summary land in the right session', { skip: !live }, async () => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const client = await McpClient.connect({
    command: engramBin,
    args: ['mcp'],
    env: { ENGRAM_DATA_DIR: dataDir, ENGRAM_NO_UPDATE_CHECK: '1' },
    cwd: repo,
    requestTimeoutMs: 20000,
  });
  try {
    const names = client.tools.map((tool) => tool.name);
    for (const required of ['mem_save', 'mem_capture_passive', 'mem_session_summary', 'mem_context']) {
      assert.ok(names.includes(required), `engram exposes ${required}`);
    }

    const started = await client.callTool('mem_session_start', { id: 'live-1', directory: repo });
    const envelope = JSON.parse(started.content[0]?.text ?? '{}') as { project?: string; project_source?: string };
    assert.equal(envelope.project, 'dsh-plugin-gentleai-engram');
    assert.ok(typeof envelope.project_source === 'string' && envelope.project_source !== '');

    await client.callTool('mem_save', {
      session_id: 'live-1',
      title: 'live save',
      content: '**What**: live probe',
      type: 'discovery',
      capture_prompt: false,
    });
    const captured = await client.callTool('mem_capture_passive', {
      session_id: 'live-1',
      content: `## Key Learnings:\n1. ${item('one')}\n2. ${item('two')}`,
    });
    const captureEnvelope = JSON.parse(captured.content[0]?.text ?? '{}') as { result?: string };
    assert.match(captureEnvelope.result ?? '', /extracted=2/);

    await client.callTool('mem_session_summary', { session_id: 'live-1', content: '## Goal\nlive summary' });

    // A second session in the same workspace keeps its own attribution.
    await client.callTool('mem_session_start', { id: 'live-2', directory: repo });
    await client.callTool('mem_capture_passive', {
      session_id: 'live-2',
      content: `## Key Learnings:\n1. ${item('two-session')}`,
    });

    const db = new DatabaseSync(join(dataDir, 'engram.db'));
    const sessions = db.prepare('select id, directory, project, summary from sessions order by id').all() as Array<
      Record<string, unknown>
    >;
    assert.equal(sessions.length, 2);
    for (const row of sessions) {
      assert.equal(row.directory, repo);
      assert.equal(row.project, 'dsh-plugin-gentleai-engram');
    }
    // `mem_session_summary` records the narrative as an observation on the
    // session (engram's own summary entry); it does not rewrite sessions.summary.
    const summaryRows = db
      .prepare("select title, content from observations where session_id = ? and title like 'Session summary%'")
      .all('live-1') as Array<{ title: string; content: string }>;
    assert.equal(summaryRows.length, 1);
    assert.match(summaryRows[0]?.content ?? '', /live summary/);

    const captured1 = db
      .prepare('select count(*) as n from observations where session_id = ?')
      .get('live-1') as { n: number };
    const captured2 = db
      .prepare('select count(*) as n from observations where session_id = ?')
      .get('live-2') as { n: number };
    assert.ok(captured1.n >= 3, `session live-1 has its own observations (${captured1.n})`);
    assert.equal(captured2.n, 1);
    db.close();
  } finally {
    client.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('live: unknown session ids fail loudly', { skip: !live }, async () => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const client = await McpClient.connect({
    command: engramBin,
    args: ['mcp'],
    env: { ENGRAM_DATA_DIR: dataDir, ENGRAM_NO_UPDATE_CHECK: '1' },
    cwd: repo,
    requestTimeoutMs: 20000,
  });
  try {
    await assert.rejects(() =>
      client.callTool('mem_save', {
        session_id: 'nope',
        title: 'x',
        content: '**What**: x',
        type: 'discovery',
        capture_prompt: false,
      }),
    );
  } finally {
    client.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
