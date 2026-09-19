import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkProtocolTools,
  extractToolMentions,
  UNREGISTERED_MARKERS,
} from '../dist/protocol-consistency.js';
import { defaultProtocolAssetPaths, loadProtocolAssets } from '../dist/protocol.js';
import {
  RECALL_SYNC_TOOL_NAME,
  RECALL_TOOL_NAME,
} from '../dist/recall-tool.js';
import { SAVE_TOOL_NAME } from '../dist/save-tool.js';
import { UNREGISTERED_ENGRAM_TOOLS } from '../dist/tools.js';
import { TOOLS } from './engram-tools.mjs';

/**
 * The protocol text and the tool surface are two halves of one obligation, and
 * nothing in the type system connects them. This is the check that does.
 *
 * The surface used here is the REAL one: the backend's 22 declarations (the stub
 * fixture), minus the tools the bridge deliberately does not register, plus the
 * three the plugin owns.
 */

const declared = TOOLS.map((tool: { name: string }) => tool.name);
const visible = [
  ...declared.filter((name: string) => !UNREGISTERED_ENGRAM_TOOLS.includes(name)),
  RECALL_TOOL_NAME,
  RECALL_SYNC_TOOL_NAME,
  SAVE_TOOL_NAME,
];

test('基线：未改动的随包文本上，一致性检查通过', () => {
  assert.equal(declared.length, 22, '后端声明 22 个工具');
  assert.equal(visible.length, 22 - 4 + 3, '注册面 = 声明面 − 刻意不注册 + 插件自有 3 个');
  const assets = loadProtocolAssets(defaultProtocolAssetPaths());
  const violations = [
    ...checkProtocolTools(assets.resident, { visible }),
    ...checkProtocolTools(assets.skill.content, { visible }),
  ];
  assert.deepEqual(
    violations,
    [],
    `协议文本里有工具名与工具面不一致：${JSON.stringify(violations)}`,
  );
});

test('文本可以为解释「刻意不注册」而提到不在场的名字，但必须标明不可调用', () => {
  // The shipped text does exactly this for the replaced save tool, and that
  // mention must NOT be read as an instruction to call it.
  const assets = loadProtocolAssets(defaultProtocolAssetPaths());
  const mentions = extractToolMentions(assets.skill.content).filter(
    (mention) => mention.name === 'mem_save',
  );
  assert.ok(mentions.length > 0, '重写后的正文仍要解释被取代的保存工具');
  for (const mention of mentions) {
    assert.ok(
      UNREGISTERED_MARKERS.some((marker) => mention.text.includes(marker)),
      `第 ${mention.line} 行提到 mem_save 却没有标明不可调用：${mention.text}`,
    );
  }
});

test('把已撤下的名字改成「要求调用」的写法，检查变红并指名那个名字', () => {
  const asset = '记：做完决定 → 立刻 `mem_save`，不等用户开口\n';
  const violations = checkProtocolTools(asset, { visible });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.name, 'mem_save');
  assert.equal(violations[0]!.reason, 'unregistered-without-marker');
  assert.equal(violations[0]!.line, 1);

  // ... and the same mention WITH the marker passes.
  assert.deepEqual(
    checkProtocolTools('桥**刻意不注册**原始保存工具（`mem_save`）。\n', { visible }),
    [],
  );
});

test('既不注册也不解释的名字同样是违规（要求调用一个不存在的工具）', () => {
  const violations = checkProtocolTools('用 `mem_invented_tool` 收尾\n', { visible });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.reason, 'unknown-tool');
});

test('通配写法不被当成工具名，带前缀与不带前缀等价', () => {
  assert.deepEqual(extractToolMentions('工具名是 `mcp__engram__mem_*`。\n'), []);
  const withPrefix = extractToolMentions('`mcp__engram__mem_context`\n');
  const bare = extractToolMentions('`mem_context`\n');
  assert.equal(withPrefix[0]!.name, 'mem_context');
  assert.deepEqual(withPrefix.map((m) => m.name), bare.map((m) => m.name));
  assert.deepEqual(
    checkProtocolTools('`mcp__engram__mem_context`\n', { visible: ['mem_context'] }),
    [],
    '名字带前缀的可见工具不应被判违规',
  );
});
