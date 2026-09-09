import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  McpCancelledError,
  McpClient,
  McpClosedError,
  McpTimeoutError,
  McpToolError,
  type ChildLike,
} from '../dist/mcp-client.js';

interface WireMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function makeFake(handler: (message: WireMessage, reply: (body: unknown) => void) => void) {
  const dataListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(...args: unknown[]) => void> = [];
  const child: ChildLike = {
    stdout: {
      setEncoding(): void {},
      on(_event: 'data', listener: (chunk: string) => void): unknown {
        dataListeners.push(listener);
        return undefined;
      },
    },
    stderr: { setEncoding(): void {}, on(): unknown { return undefined; } },
    stdin: {
      write(chunk: string): unknown {
        const line = chunk.trim();
        if (line !== '') {
          const message = JSON.parse(line) as WireMessage;
          if (message.id !== undefined) {
            handler(message, (body) => {
              for (const listener of dataListeners) listener(`${JSON.stringify(body)}\n`);
            });
          }
        }
        return undefined;
      },
    },
    on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown {
      if (event === 'exit') exitListeners.push(listener);
      return undefined;
    },
    kill(): unknown { return undefined; },
  };
  return { child, exit: (code: number) => { for (const listener of exitListeners) listener(code, null); } };
}

const options = (child: ChildLike, requestTimeoutMs = 200) => ({
  command: 'engram',
  args: ['mcp'],
  env: {},
  cwd: '/ws',
  requestTimeoutMs,
  spawnImpl: () => child,
});

test('connect performs the handshake and pages the tool list', async () => {
  const seen: string[] = [];
  const fake = makeFake((message, reply) => {
    seen.push(message.method ?? '');
    if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: {} });
    if (message.method === 'tools/list') {
      const cursor = message.params?.cursor;
      reply(
        cursor === undefined
          ? { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'a' }], nextCursor: 'next' } }
          : { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'b' }] } },
      );
    }
  });
  const client = await McpClient.connect(options(fake.child));
  assert.deepEqual(seen, ['initialize', 'tools/list', 'tools/list']);
  assert.deepEqual(client.tools.map((tool) => tool.name), ['a', 'b']);
  client.close();
});

test('callTool returns content and surfaces isError as a tool error', async () => {
  const fake = makeFake((message, reply) => {
    if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: {} });
    if (message.method === 'tools/list') reply({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      reply(
        name === 'ok'
          ? { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'fine' }] } }
          : { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } },
      );
    }
  });
  const client = await McpClient.connect(options(fake.child));
  const result = await client.callTool('ok', {});
  assert.equal(result.content[0]?.text, 'fine');
  await assert.rejects(() => client.callTool('bad', {}), (error: unknown) => {
    assert.ok(error instanceof McpToolError);
    assert.equal(error.message, 'nope');
    return true;
  });
  client.close();
});

test('a dead child settles every pending call', async () => {
  const fake = makeFake((message, reply) => {
    if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: {} });
    if (message.method === 'tools/list') reply({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    // tools/call never answers
  });
  const client = await McpClient.connect(options(fake.child, 5000));
  const pending = client.callTool('mem_save', {});
  fake.exit(1);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof McpClosedError);
    return true;
  });
});

test('a slow call times out', async () => {
  const fake = makeFake((message, reply) => {
    if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: {} });
    if (message.method === 'tools/list') reply({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
  });
  const client = await McpClient.connect(options(fake.child, 30));
  await assert.rejects(() => client.callTool('mem_save', {}), (error: unknown) => {
    assert.ok(error instanceof McpTimeoutError);
    return true;
  });
});

test('an aborted call is cancelled without killing the child', async () => {
  const fake = makeFake((message, reply) => {
    if (message.method === 'initialize') reply({ jsonrpc: '2.0', id: message.id, result: {} });
    if (message.method === 'tools/list') reply({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
  });
  const client = await McpClient.connect(options(fake.child, 5000));
  const controller = new AbortController();
  const pending = client.callTool('mem_save', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof McpCancelledError);
    return true;
  });
  client.close();
});
