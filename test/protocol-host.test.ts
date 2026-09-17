import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { apply } from '../dist/index.js';

/**
 * The protocol contributions against the HOST'S REAL services — the real
 * section registry, the real assembly pipeline and the real skill registry.
 *
 * This is the half a fake host cannot check: that the host accepts the
 * literal order, that the section survives assembly and reaches the rendered
 * prompt exactly once, that an empty contribution disappears, and that the
 * skill registration carries every field the registry requires.
 */

const repo = process.cwd();
const stubPath = join(repo, 'test', 'engram-stub.mjs');
const resident = readFileSync(join(repo, 'protocol', 'resident.md'), 'utf8').trim();

function configFor(callsPath: string): never {
  return {
    command: process.execPath,
    args: [stubPath],
    env: { ENGRAM_STUB_LOG: callsPath },
    toolCallTimeoutMs: 10000,
    poolMaxConnections: 1,
    poolMaxIdleMs: 0,
    poolSweepIntervalMs: 60000,
    projectOverrides: {},
    injectSessionProject: true,
    injectSessionId: true,
    capturePassive: false,
    compactionRecovery: false,
    recoveryTokenBudget: 800,
    recallWakeup: false,
    searchEnabled: false,
  } as never;
}

async function withBridgedHost(
  run: (context: Context, systemPrompt: SystemPrompt, skills: SkillRegistry) => Promise<void>,
): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), 'engram-protocol-host-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(temp, 'dsh-home');
  const disposers: Array<() => void> = [];
  try {
    const context = new Context();
    const systemPrompt = new SystemPrompt(context, { includeHarnessIdentity: false });
    const skills = new SkillRegistry(context, {});
    const host: Record<string, unknown> = {
      logger: { debug(): void {}, info(): void {}, warn(): void {}, error(): void {} },
      on(): () => void {
        return () => {};
      },
      effect(callback: () => (() => void) | void): () => void {
        const dispose = callback();
        disposers.push(() => dispose?.());
        return () => {};
      },
      tools: { register: () => () => {} },
      // The services are the REAL ones: the plugin registers into them.
      systemPrompt,
      skills,
    };
    host.inject = (_deps: readonly string[], callback: (value: unknown) => void): void => callback(host);
    apply(host as never, configFor(join(temp, 'calls.jsonl')));
    await run(context, systemPrompt, skills);
  } finally {
    for (const dispose of [...disposers].reverse()) dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(temp, { recursive: true, force: true });
  }
}

test('the real assembly accepts the literal order and renders the section once', async () => {
  await withBridgedHost(async (_context, systemPrompt) => {
    const assembly = await systemPrompt.assemble();
    const names = assembly.sections.map((section) => section.name);
    assert.ok(names.includes('engram:protocol'), `assembled sections: ${names.join(', ')}`);
    const ours = assembly.sections.find((section) => section.name === 'engram:protocol')!;
    assert.ok(ours.text.length > 0, 'the resolved text is the resident asset');
    const rendered = renderPrompt(assembly);
    assert.equal(rendered.split(resident).length - 1, 1, 'the resident text appears exactly once');
  });
});

test('a sub-agent assembly drops the section instead of telling it what it owes', async () => {
  await withBridgedHost(async (_context, systemPrompt) => {
    const agent = { session: { header: { origin: 'subagent' } } };
    const assembly = await systemPrompt.assemble({ agent, scope: agent } as never);
    const rendered = renderPrompt(assembly);
    assert.ok(!rendered.includes('mem_save'), 'no obligation text for an agent without the tools');
    // The section is still REGISTERED; the host is what drops empty text.
    assert.ok(assembly.sections.some((section) => section.name === 'engram:protocol'));
  });
});

test('the real skill registry accepts the registration and loads the body back', async () => {
  await withBridgedHost(async (_context, _systemPrompt, skills) => {
    const definition = await skills.get('engram-memory', {});
    assert.ok(definition !== undefined, 'the runtime registration is discoverable');
    assert.equal(definition!.source, 'runtime');
    assert.equal(definition!.provider, 'runtime');
    assert.ok(definition!.description.length > 0);
    assert.ok(!definition!.description.includes('\n'));
    assert.ok(definition!.content.startsWith('# '));
    const listed = await skills.list({});
    assert.deepEqual(listed.map((entry) => entry.name), ['engram-memory']);
  });
});

test('a cold assembly already carries the section — no tool call is needed first', async () => {
  await withBridgedHost(async (_context, systemPrompt) => {
    const first = renderPrompt(await systemPrompt.assemble());
    assert.ok(first.includes(resident));
  });
});
