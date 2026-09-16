import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fakeModelDir, removeDir, tempDir, writeSource } from './recall-support.ts';

/**
 * The worker's own error recovery, plus the `--rebuild` child's exit code.
 *
 * These run the REAL `dist/recall/worker.js`, with the embedding runtime
 * replaced by `test/ort-stub.mjs` — the failure modes under test happen before
 * (or instead of) any real inference, so no 95 MB model is needed.
 *
 * The point of the first pair is design D6: `this.embedderPromise ??= …` caches
 * the REJECTION, so a load failure that later goes away would keep the worker
 * poisoned for its whole life — retrieval would never recover without a restart
 * or a reclaim. Both causes are covered because they are indistinguishable to
 * the host: a wrong byte is classified `internal`, a missing file
 * `runtime-missing`.
 */

const STUB_SOURCE = readFileSync(join(process.cwd(), 'test', 'ort-stub.mjs'), 'utf8');
const WORKER = join(process.cwd(), 'dist', 'recall', 'worker.js');

interface WorkerFrame {
  type: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: { kind: string; message: string };
}

interface WorkerHarness {
  request(id: number, cmd: string): Promise<WorkerFrame>;
  close(): Promise<void>;
  stderr(): string;
}

function startWorker(dir: string, modelDir: string, maxDocs = '4'): WorkerHarness {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [WORKER], {
    env: {
      ...process.env,
      ENGRAM_BRIDGE_DB_PATH: join(dir, 'source.db'),
      ENGRAM_BRIDGE_INDEX_PATH: join(dir, 'index', 'index.db'),
      ENGRAM_BRIDGE_MODEL_DIR: modelDir,
      ENGRAM_BRIDGE_THREADS: '1',
      ENGRAM_BRIDGE_W: '0.2',
      ENGRAM_BRIDGE_TOP_K: '50',
      ENGRAM_BRIDGE_COVERAGE: 'field_cov',
      ENGRAM_BRIDGE_MAX_DOCS: maxDocs,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting: Array<(frame: WorkerFrame) => void> = [];
  let stderr = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    const text = line.trim();
    if (text === '') return;
    const frame = JSON.parse(text) as WorkerFrame;
    if (frame.type !== 'response') return;
    waiting.shift()?.(frame);
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderr += `${line}\n`;
  });
  return {
    request(id: number, cmd: string): Promise<WorkerFrame> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`worker 未在期限内回应：${stderr}`)), 20000);
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
        child.stdin.write(`${JSON.stringify({ id, cmd })}\n`);
      });
    },
    close(): Promise<void> {
      child.stdin.end();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    stderr: () => stderr,
  };
}

function fixture(root: string): { modelDir: string } {
  const modelDir = fakeModelDir(root, { ortEntrySource: STUB_SOURCE });
  mkdirSync(join(root, 'index'), { recursive: true });
  writeSource(join(root, 'source.db'), [
    { id: 1, title: 'hello', content: 'hello world', type: 'note', project: 'alpha', scope: 'project' },
  ]);
  return { modelDir };
}

test('[2.5] 嵌入加载失败不被永久记住：内容坏（internal）修好后能重新加载', async () => {
  const dir = tempDir('recall-reload-');
  let harness: WorkerHarness | undefined;
  try {
    const { modelDir } = fixture(dir);
    harness = startWorker(dir, modelDir);
    const tokenizerPath = join(modelDir, 'tokenizer.json');
    const good = readFileSync(tokenizerPath, 'utf8');

    writeFileSync(tokenizerPath, '{'); // present, but not parseable
    const first = await harness.request(1, 'rebuild');
    assert.equal(first.ok, false);
    assert.equal(first.error?.kind, 'internal', `第一次应失败：${JSON.stringify(first)}`);

    writeFileSync(tokenizerPath, good);
    const second = await harness.request(2, 'rebuild');
    assert.equal(
      second.ok,
      true,
      `原因消除后必须重新加载而不是返回同一条缓存错误：${JSON.stringify(second)}`,
    );
  } finally {
    await harness?.close();
    removeDir(dir);
  }
});

test('[2.5] 嵌入加载失败不被永久记住：文件缺失（runtime-missing）补回后能重新加载', async () => {
  const dir = tempDir('recall-reload-');
  let harness: WorkerHarness | undefined;
  try {
    const { modelDir } = fixture(dir);
    harness = startWorker(dir, modelDir);
    const modelPath = join(modelDir, 'model_optimized.onnx');
    const good = readFileSync(modelPath);

    unlinkSync(modelPath);
    const first = await harness.request(1, 'rebuild');
    assert.equal(first.ok, false);
    assert.equal(first.error?.kind, 'runtime-missing', `第一次应报运行时缺失：${JSON.stringify(first)}`);

    writeFileSync(modelPath, good);
    const second = await harness.request(2, 'rebuild');
    assert.equal(
      second.ok,
      true,
      `补回文件后必须重新加载而不是返回同一条缓存错误：${JSON.stringify(second)}`,
    );
  } finally {
    await harness?.close();
    removeDir(dir);
  }
});

/** Run the one-shot `--rebuild` child to completion and report its exit code. */
function rebuildExit(dir: string, modelDir: string, dbPath: string, maxDocs = '4'): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, '--rebuild'], {
      env: {
        ...process.env,
        ENGRAM_BRIDGE_DB_PATH: dbPath,
        ENGRAM_BRIDGE_INDEX_PATH: join(dir, 'index', 'index.db'),
        ENGRAM_BRIDGE_MODEL_DIR: modelDir,
        ENGRAM_BRIDGE_THREADS: '1',
        ENGRAM_BRIDGE_W: '0.2',
        ENGRAM_BRIDGE_TOP_K: '50',
        ENGRAM_BRIDGE_COVERAGE: 'field_cov',
        ENGRAM_BRIDGE_MAX_DOCS: maxDocs,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

/** Run one one-shot mode to completion, capturing stdout and the exit code. */
function oneShot(
  mode: '--sync' | '--rebuild',
  dir: string,
  modelDir: string,
  maxDocs: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, mode], {
      env: {
        ...process.env,
        ENGRAM_BRIDGE_DB_PATH: join(dir, 'source.db'),
        ENGRAM_BRIDGE_INDEX_PATH: join(dir, 'index', 'index.db'),
        ENGRAM_BRIDGE_MODEL_DIR: modelDir,
        ENGRAM_BRIDGE_THREADS: '1',
        ENGRAM_BRIDGE_W: '0.2',
        ENGRAM_BRIDGE_TOP_K: '50',
        ENGRAM_BRIDGE_COVERAGE: 'field_cov',
        ENGRAM_BRIDGE_MAX_DOCS: maxDocs,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
}

test('[2.6] --rebuild 子进程用独立退出码区分模型原因', async () => {
  const dir = tempDir('recall-rebuild-exit-');
  try {
    const { modelDir } = fixture(dir);
    const dbPath = join(dir, 'source.db');
    const modelPath = join(modelDir, 'model_optimized.onnx');
    const good = readFileSync(modelPath);

    unlinkSync(modelPath);
    assert.equal(await rebuildExit(dir, modelDir, dbPath), 3, '模型原因须以独立退出码退出');
    writeFileSync(modelPath, good);

    assert.equal(
      await rebuildExit(dir, modelDir, join(dir, 'missing.db')),
      // 源库不存在是另一类失败，不能被并进「运行时或模型缺失」。
      1,
      '其它原因仍用通用退出码',
    );
  } finally {
    removeDir(dir);
  }
});

test('[4.2] --sync：上限足够就在一次调用里建/追上；不足则退出码 4 且不碰任何文件', async () => {
  const dir = tempDir('recall-oneshot-');
  try {
    const { modelDir } = fixture(dir);
    const indexPath = join(dir, 'index', 'index.db');

    // Over the cap: refuse on the spot. Nothing may be created, and the cap
    // judgement must precede the model load.
    const denied = await oneShot('--sync', dir, modelDir, '0');
    assert.equal(denied.code, 4, `超限必须以退出码 4 退出：${denied.out}`);
    assert.ok(!existsSync(indexPath), '被拒绝的一次性同步不得建立索引文件');
    assert.ok(!denied.out.includes('嵌入运行时'), '上限判定必须先于模型加载');

    // Within the cap: a fresh index has never been built, so this is a full
    // build — in one call, and in one transaction.
    const built = await oneShot('--sync', dir, modelDir, '4');
    assert.equal(built.code, 0, built.out);
    assert.ok(existsSync(indexPath));
    assert.match(built.out, /全量重建完成/);

    // Again: nothing changed, so it is a no-op rather than an error.
    const again = await oneShot('--sync', dir, modelDir, '4');
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /已是最新/);
  } finally {
    removeDir(dir);
  }
});

test('[4.2] 残留的 cmd:rebuild 也受限额约束：超限返回 sync-needed 帧而不是成功重建', async () => {
  const dir = tempDir('recall-cmd-rebuild-');
  let harness: WorkerHarness | undefined;
  try {
    const { modelDir } = fixture(dir);
    harness = startWorker(dir, modelDir, '0');
    const frame = await harness.request(1, 'rebuild');
    assert.equal(frame.ok, false);
    assert.equal(frame.error?.kind, 'sync-needed', JSON.stringify(frame));
    assert.notEqual(frame.error?.kind, 'internal');
  } finally {
    await harness?.close();
    removeDir(dir);
  }
});
