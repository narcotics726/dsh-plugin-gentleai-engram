import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BertTokenizer, normalize, preTokenize } from '../dist/recall/bert-tokenizer.js';
import { Embedder, MAX_BATCH, l2normalize } from '../dist/recall/embed.js';
import { ModelUnavailableError, missingModelParts } from '../dist/recall/model-dir.js';
import { fakeModelDir, minimalTokenizerJson, removeDir, tempDir } from './recall-support.ts';

/**
 * Embedding-boundary tests.
 *
 * Two halves, both model-free:
 *
 *  * the WordPiece pipeline, against a synthetic vocabulary with hand-computed
 *    expected ids (including a truncation case and a control-character case) —
 *    the real 1014/1014 parity check against fastembed lives in the out-of-repo
 *    spike and cannot run here;
 *  * the batching contract over a stub runtime, which is what the port itself
 *    owns: batch splitting at the hard ceiling, right-padding to each batch's own
 *    longest sequence, masking that hides the pads, and output that does not
 *    depend on the batch size.
 */

const STUB_SOURCE = readFileSync(join(process.cwd(), 'test', 'ort-stub.mjs'), 'utf8');

function tokenizerFor(root: string, modelMaxLength = 512): BertTokenizer {
  const dir = fakeModelDir(root, { ortEntrySource: STUB_SOURCE, modelMaxLength });
  return new BertTokenizer(join(dir, 'tokenizer.json'), modelMaxLength);
}

test('分词：词表、特殊 token 与贪心最长匹配', () => {
  const dir = tempDir();
  try {
    const tokenizer = tokenizerFor(dir);
    // 这一条是回归：tokenizer.json 的 post_processor.special_tokens 里 `id` 是
    // token 名字而不是数字 id，必须查词表才能得到 101 那样的编号。
    assert.equal(tokenizer.meta.clsId, 2);
    assert.equal(tokenizer.meta.sepId, 3);
    assert.equal(tokenizer.meta.unkId, 1);
    assert.deepEqual(tokenizer.encode('hello'), [2, 4, 3]);
    assert.deepEqual(tokenizer.encode('hello world'), [2, 4, 5, 3]);
    assert.deepEqual(tokenizer.encode('hellos'), [2, 4, 6, 3], '##s 应作为续接子词');
    assert.deepEqual(tokenizer.encode('zzz'), [2, 1, 3], '词表外的词退化为 [UNK]');
  } finally {
    removeDir(dir);
  }
});

test('分词：截断在模板之后，形式为 [CLS] + 前 510 + [SEP]', () => {
  const dir = tempDir();
  try {
    const tokenizer = tokenizerFor(dir, 4);
    const ids = tokenizer.encode('hello hello hello');
    assert.deepEqual(ids, [2, 4, 4, 3], '必须恰好 maxLength 长，且以 [SEP] 收尾');
    assert.equal(ids.length, 4);

    const full = tokenizerFor(join(dir), 512);
    const long = full.encode('hello '.repeat(600));
    assert.equal(long.length, 512, '触顶时正好 512');
    assert.equal(long[0], 2);
    assert.equal(long[511], 3);
  } finally {
    removeDir(dir);
  }
});

test('分词：控制字符 Cc/Cf/Co 被删除，Cn 保留，CJK 两侧加空格', () => {
  assert.equal(normalize('a\u0000b'), 'ab', 'NUL 删除');
  assert.equal(normalize('a\u200bb'), 'ab', 'U+200B (Cf) 删除');
  assert.equal(normalize('a\u00adb'), 'ab', 'U+00AD (Cf) 删除');
  assert.equal(normalize('a\u000bb'), 'ab', 'U+000B (Cc) 删除');
  assert.equal(normalize('a\uffffb'), 'a\uffffb', 'U+FFFF (Cn) 必须保留：朴素的 \\p{C} 会多删它并破坏分词');
  assert.equal(normalize('a\tb'), 'a b', 'TAB 作为空白保留');
  assert.equal(normalize('中文'), ' 中  文 ');
  assert.deepEqual(preTokenize(normalize('中文')), ['中', '文']);
  assert.deepEqual(preTokenize('a,b'), ['a', ',', 'b']);
  assert.deepEqual(preTokenize('a b'), ['a', 'b']);
});

test('嵌入：超过批上限时拆成多批，按批内最长右填充并屏蔽填充位', async () => {
  const dir = tempDir();
  try {
    const modelDir = fakeModelDir(dir, { ortEntrySource: STUB_SOURCE });
    const stub = (await import(pathToFileURL(join(modelDir, 'node_modules', 'onnxruntime-web', 'dist', 'ort.node.min.mjs')).href)) as {
      __batches: number[];
      __widths: number[];
      __threads: number[];
    };
    stub.__batches.length = 0;
    stub.__widths.length = 0;
    stub.__threads.length = 0;

    const embedder = await Embedder.create({ modelDir, threads: 7 });
    assert.equal(embedder.threads, 7);
    assert.deepEqual(stub.__threads, [7], '必须显式设置线程数，且等于配置值（Node 默认是 4）');

    const texts = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? `hello ${'x'.repeat(i)}` : `hello world ${i}`));
    const raw = await embedder.embedRaw(texts);
    assert.deepEqual(stub.__batches, [MAX_BATCH, 8], `40 条文本必须拆成 32 + 8 两批，实际 ${stub.__batches.join('+')}`);

    // 每一行的"序列长度"等于自己 token 化的长度，"填充长度"等于所在批的最长序列。
    const lengths = texts.map((text) => embedder.tokenizer.encode(text).length);
    for (let batch = 0; batch < 2; batch++) {
      const from = batch * MAX_BATCH;
      const to = Math.min(texts.length, from + MAX_BATCH);
      // 右填充到"本批最长"：宽度按批记录，而不是按整批语料。
      assert.equal(stub.__widths[batch], Math.max(...lengths.slice(from, to)), `第 ${batch} 批的填充宽度`);
      for (let i = from; i < to; i++) {
        assert.equal(raw[i]![1], lengths[i], `第 ${i} 行必须只统计未屏蔽位`);
        const expected = embedder.tokenizer.encode(texts[i]!).reduce((sum, id) => sum + id, 0);
        assert.equal(raw[i]![0], expected, `第 ${i} 行的 id 和必须不含填充`);
      }
    }
    await embedder.dispose();
  } finally {
    removeDir(dir);
  }
});

test('嵌入：结果与批大小无关（位相等）', async () => {
  const dir = tempDir();
  try {
    const modelDir = fakeModelDir(dir, { ortEntrySource: STUB_SOURCE });
    const small = await Embedder.create({ modelDir, threads: 1, batchSize: 4 });
    const large = await Embedder.create({ modelDir, threads: 1, batchSize: MAX_BATCH });
    const texts = Array.from({ length: 19 }, (_, i) => `hello world ${i} ${'中'.repeat(i)}`);
    const a = await small.embed(texts);
    const b = await large.embed(texts);
    assert.equal(a.length, texts.length);
    for (let i = 0; i < texts.length; i++) {
      assert.deepEqual(Array.from(a[i]!), Array.from(b[i]!), `第 ${i} 条向量不应随批大小变化`);
    }
    // 批上限只能被降到 1..32 之间，不能越过硬上限。
    const clamped = await Embedder.create({ modelDir, threads: 1, batchSize: 1000 });
    assert.equal(clamped.batchSize, MAX_BATCH);
    await small.dispose();
    await large.dispose();
    await clamped.dispose();
  } finally {
    removeDir(dir);
  }
});

test('嵌入：l2 归一化把非零向量变成单位长度', () => {
  const unit = l2normalize(new Float32Array([3, 4, 0, 0]));
  assert.ok(Math.abs(Math.hypot(unit[0]!, unit[1]!) - 1) < 1e-6);
  const zero = l2normalize(new Float32Array([0, 0, 0, 0]));
  assert.deepEqual(Array.from(zero), [0, 0, 0, 0], '零向量不得产生 NaN');
});

test('模型目录不完整时抛出可读的缺失清单', async () => {
  const dir = tempDir();
  try {
    const missing = missingModelParts(join(dir, 'nothing-here'));
    assert.ok(missing.length >= 3);
    await assert.rejects(
      () => Embedder.create({ modelDir: join(dir, 'nothing-here'), threads: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof ModelUnavailableError);
        assert.match(error.message, /install-recall-model\.mjs/);
        return true;
      },
    );
  } finally {
    removeDir(dir);
  }
});

test('最小合成词表本身就是合法的 tokenizer.json 形态', () => {
  const spec = minimalTokenizerJson() as { post_processor: { special_tokens: Record<string, { id: string }> } };
  assert.equal(spec.post_processor.special_tokens['[CLS]']!.id, '[CLS]');
});
