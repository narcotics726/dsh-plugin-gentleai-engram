import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultProtocolAssetPaths,
  loadProtocolAssets,
  parseSkillAsset,
  PROTOCOL_SECTION_NAME,
  PROTOCOL_SECTION_ORDER,
  splitFrontmatter,
} from '../dist/protocol.js';

test('a folded block description becomes one line and leaves the body', () => {
  const text = [
    '---',
    'name: demo',
    'description: >-',
    '  first line',
    '  second line',
    'version: 2',
    '---',
    '',
    '# Body',
    'text',
    '',
  ].join('\n');
  const split = splitFrontmatter(text);
  assert.equal(split.fields.get('name'), 'demo');
  assert.equal(split.fields.get('description'), 'first line second line');
  assert.equal(split.fields.get('version'), '2');
  assert.equal(split.body, '# Body\ntext\n');
});

test('an input without a leading block keeps its whole text and has no fields', () => {
  const text = '# 常驻段\n\n没有 frontmatter。\n';
  const split = splitFrontmatter(text);
  assert.equal(split.fields.size, 0);
  assert.equal(split.body, text);
});

test('an unterminated block is not frontmatter', () => {
  const text = '---\nname: demo\n正文被吞掉了\n';
  const split = splitFrontmatter(text);
  assert.equal(split.fields.size, 0);
  assert.equal(split.body, text);
});

test('the shipped skill asset parses into catalog fields plus a frontmatter-free body', () => {
  const assets = loadProtocolAssets(defaultProtocolAssetPaths());
  assert.equal(assets.skill.name, 'engram-memory');
  assert.ok(assets.skill.description.length > 0);
  assert.ok(!assets.skill.description.includes('\n'), 'description must be one line');
  assert.ok(assets.skill.content.startsWith('# '), 'body must not start with a frontmatter block');
  assert.ok(!assets.skill.content.includes('name: engram-memory'));
  assert.ok(assets.resident.includes('mem_bridge_save'));
  assert.ok(!assets.resident.startsWith('---'));
});

test('the section name and order are literals in the gap the host leaves open', () => {
  // A named lookup would be version-fragile: the host renamed DEPLOYMENT_PERSONA
  // to DEPLOYMENT_PERSONA_PREFIX between the pinned and the running version.
  assert.equal(PROTOCOL_SECTION_NAME, 'engram:protocol');
  assert.equal(PROTOCOL_SECTION_ORDER, 350);
  assert.ok(Number.isFinite(PROTOCOL_SECTION_ORDER));
  assert.ok(PROTOCOL_SECTION_ORDER > 0 && PROTOCOL_SECTION_ORDER < 500);
});

test('a missing asset fails at load and names the file', () => {
  const missing = new URL('./no-such-protocol-asset.md', import.meta.url);
  assert.throws(
    () => loadProtocolAssets({ resident: missing, skill: defaultProtocolAssetPaths().skill }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /协议资产不可读/);
      assert.match(error.message, /no-such-protocol-asset/);
      return true;
    },
  );
});

test('a skill asset without name or description is refused', () => {
  assert.throws(() => parseSkillAsset('---\nname: demo\n---\n\nbody\n', 'x.md'), /description/);
  assert.throws(() => parseSkillAsset('没有 frontmatter\n', 'x.md'), /name/);
});
