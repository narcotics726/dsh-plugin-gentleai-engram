import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { buildRecallCommandDefinition } from '../dist/recall-command.js';
import { COMMAND_NAME } from '../dist/recall/protocol.js';

/**
 * The operator path (design D8).
 *
 * A REAL CommandRuntime and a real SessionStore, not a stub: the whole point of
 * this path is that it reuses the live manager and lands in the session log, so
 * what needs verifying is the host registry's own dispatch and lifecycle —
 * which a hand-written fake would not exercise.
 */

function rig(run: (exec: { signal?: AbortSignal }) => Promise<string>) {
  const ctx = new Context();
  // Constructed directly: `ctx.plugin(CommandRuntime)` registers the same
  // service but only once its fiber settles, and this test has nothing to wait
  // for before dispatching.
  new CommandRuntime(ctx as never);
  const store = new SessionStore(ctx);
  const session = store.create('cmd-1', { meta: { cwd: '/tmp' } });
  const agent = { session } as never;
  const commands = (ctx as unknown as { commands: { register(def: unknown): () => void; execute(a: never, line: string, images: readonly never[], signal: AbortSignal): Promise<unknown> } }).commands;
  const dispose = commands.register(buildRecallCommandDefinition({ run }) as never);
  return { ctx, agent, commands, dispose, session };
}

function eventTypes(session: { snapshotEvents(): readonly unknown[] }): string[] {
  return session.snapshotEvents().map((event) => String((event as { type?: unknown }).type));
}

test('[6.3] 命令注册后可见，派发会跑 handler，并把 command/run 与 command/done 写进会话日志', async () => {
  const r = rig(async () => '增量同步完成：1 条文档');
  try {
    const line = `/${COMMAND_NAME}`;
    const execution = (await r.commands.execute(r.agent, line, [], new AbortController().signal)) as {
      result: { kind: string; text?: string };
    };
    assert.equal(execution.result.kind, 'success');
    assert.match(String(execution.result.text), /增量同步完成/);
    const types = eventTypes(r.session);
    assert.ok(types.includes('command/run'), `缺 command/run：${types.join(',')}`);
    assert.ok(types.includes('command/done'), `缺 command/done：${types.join(',')}`);
  } finally {
    r.dispose();
  }
});

test('[6.3] handler 失败时命令以 error 结算，而不是把异常抛给调度方', async () => {
  const r = rig(async () => {
    throw new Error('engram-bridge: 索引正在被另一个进程更新');
  });
  try {
    const execution = (await r.commands.execute(r.agent, `/${COMMAND_NAME}`, [], new AbortController().signal)) as {
      result: { kind: string; text?: string };
    };
    assert.equal(execution.result.kind, 'error');
    assert.match(String(execution.result.text), /正在被另一个进程更新/);
  } finally {
    r.dispose();
  }
});

test('[6.3] 取消：signal 必须真的交给 handler，且调度以失败结算', async () => {
  const seen: boolean[] = [];
  let release: (() => void) | undefined;
  const r = rig(async (exec) => {
    await new Promise<void>((resolve) => {
      release = resolve;
      exec.signal?.addEventListener('abort', () => {
        seen.push(exec.signal?.aborted === true);
        resolve();
      }, { once: true });
    });
    return '不该被当成成功';
  });
  try {
    const controller = new AbortController();
    const pending = r.commands.execute(r.agent, `/${COMMAND_NAME}`, [], controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(() => pending, '被取消的命令必须以失败结算');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, [true], 'handler 必须自己观察到 signal（注册表只停止等待）');
    release?.();
  } finally {
    r.dispose();
  }
});

test('[6.3] 命令名与登记元数据满足宿主校验：小写、可变现、不记录多余输入', () => {
  const definition = buildRecallCommandDefinition({ run: async () => '' });
  assert.equal(definition.name, COMMAND_NAME);
  assert.match(definition.name, /^[a-z][a-z0-9_-]*$/, '宿主用这个正则校验命令名');
  assert.equal(definition.recordInput, false, '不接受参数的命令不得把多余输入记成 args');
  assert.ok(definition.description.length > 0);
});
