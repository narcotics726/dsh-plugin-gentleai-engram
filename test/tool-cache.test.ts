import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readToolCache,
  sameToolSurface,
  toolCacheFingerprint,
  toolCachePath,
  writeToolCache,
} from '../dist/tool-cache.js';

const tools = [{ name: 'mem_save', inputSchema: { type: 'object' } }, { name: 'mem_search' }];

test('fingerprint covers the executable and its args', () => {
  assert.equal(toolCacheFingerprint('/bin/engram', ['mcp']), '/bin/engram mcp');
  assert.notEqual(toolCacheFingerprint('/bin/engram', ['mcp']), toolCacheFingerprint('/bin/engram', ['mcp', '--tools=agent']));
});

test('cache path follows DSH_HOME', () => {
  assert.equal(toolCachePath({ DSH_HOME: '/tmp/home' }), '/tmp/home/storages/engram-bridge/tools.json');
  assert.match(toolCachePath({ HOME: '/tmp/other' }), /storages\/engram-bridge\/tools\.json$/);
});

test('write then read round-trips the tool surface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-cache-'));
  const path = join(dir, 'nested', 'tools.json');
  try {
    const fingerprint = toolCacheFingerprint('/bin/engram', ['mcp']);
    writeToolCache(path, fingerprint, tools);
    const record = JSON.parse(readFileSync(path, 'utf8')) as { fingerprint: string; tools: unknown[] };
    assert.equal(record.fingerprint, fingerprint);
    assert.equal(record.tools.length, 2);
    assert.deepEqual(readToolCache(path, fingerprint)?.map((tool) => tool.name), ['mem_save', 'mem_search']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale fingerprint or a missing file yields no cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-cache-'));
  const path = join(dir, 'tools.json');
  try {
    writeToolCache(path, toolCacheFingerprint('/bin/engram', ['mcp']), tools);
    assert.equal(readToolCache(path, toolCacheFingerprint('/bin/engram', ['other'])), undefined);
    assert.equal(readToolCache(join(dir, 'missing.json'), 'x'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty or malformed cache is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engram-cache-'));
  const path = join(dir, 'tools.json');
  try {
    writeToolCache(path, 'fp', []);
    assert.equal(readToolCache(path, 'fp'), undefined);
    writeToolCache(path, 'fp', [{ name: 'a' }, { name: 'b' }]);
    assert.equal(readToolCache(path, 'fp')?.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('surface comparison is name-based and order-insensitive', () => {
  assert.equal(sameToolSurface([{ name: 'a' }, { name: 'b' }], [{ name: 'b' }, { name: 'a' }]), true);
  assert.equal(sameToolSurface([{ name: 'a' }], [{ name: 'a' }, { name: 'b' }]), false);
  assert.equal(sameToolSurface([{ name: 'a' }], [{ name: 'b' }]), false);
});
