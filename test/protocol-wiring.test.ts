import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../dist/index.js';

/**
 * The protocol half of the plugin against a fake host: the resident section
 * (including the sub-agent rule) and the runtime skill registration.
 *
 * The real engram surface is irrelevant here, so the stub child is only there
 * to keep the load-time capability discovery harmless.
 */

const repo = process.cwd();
const stubPath = join(repo, 'test', 'engram-stub.mjs');

interface RegisteredSection {
  name: string;
  order: number;
  text: unknown;
}

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
  } as never;
}

type Mode = 'both' | 'services-absent' | 'no-inject';

function protocolHost(mode: Mode) {
  const sections: RegisteredSection[] = [];
  const skills: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const disposers: Array<() => void> = [];
  const child = {
    effect(callback: () => (() => void) | void): () => void {
      const dispose = callback();
      disposers.push(() => dispose?.());
      return () => {};
    },
    systemPrompt:
      mode === 'both'
        ? {
            section(section: RegisteredSection): () => void {
              sections.push(section);
              return () => removed.push('section');
            },
          }
        : undefined,
    skills:
      mode === 'both'
        ? {
            register(skill: Record<string, unknown>): () => void {
              skills.push(skill);
              return () => removed.push('skill');
            },
          }
        : undefined,
  };
  const ctx: Record<string, unknown> = {
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
  };
  if (mode !== 'no-inject') {
    ctx.inject = (_deps: readonly string[], callback: (value: unknown) => void): void => callback(child);
  }
  return {
    ctx: ctx as never,
    sections,
    skills,
    removed,
    disposeAll(): void {
      for (const dispose of [...disposers].reverse()) dispose();
      disposers.length = 0;
    },
  };
}

function withTempHome<T>(run: (callsPath: string) => T): T {
  const temp = mkdtempSync(join(tmpdir(), 'engram-protocol-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(temp, 'dsh-home');
  try {
    return run(join(temp, 'calls.jsonl'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(temp, { recursive: true, force: true });
  }
}

test('the resident section is registered under its literal name and order', () => {
  withTempHome((callsPath) => {
    const host = protocolHost('both');
    apply(host.ctx, configFor(callsPath));
    assert.equal(host.sections.length, 1);
    const section = host.sections[0]!;
    assert.equal(section.name, 'engram:protocol');
    assert.equal(section.order, 350);
    assert.ok(Number.isFinite(section.order));
  });
});

test('the section text is the resident asset for a main agent and empty for a sub-agent', () => {
  withTempHome((callsPath) => {
    const host = protocolHost('both');
    apply(host.ctx, configFor(callsPath));
    const provide = host.sections[0]!.text as (context: unknown) => string;
    const main = provide({ agent: { session: { header: {} } } });
    assert.ok(main.includes('mem_save'));
    assert.ok(main.includes('engram-memory'));
    // Both sub-agent markers the plugin's own predicate recognizes.
    assert.equal(provide({ agent: { session: { header: { origin: 'subagent' } } } }), '');
    assert.equal(provide({ agent: { session: { header: { delegationDepth: 1 } } } }), '');
    // Diagnostics assemblies carry no agent at all and are not model steps.
    assert.equal(provide({}), main);
  });
});

test('the skill is registered as a runtime skill with catalog fields and a clean body', () => {
  withTempHome((callsPath) => {
    const host = protocolHost('both');
    apply(host.ctx, configFor(callsPath));
    assert.equal(host.skills.length, 1);
    const skill = host.skills[0]!;
    assert.equal(skill.name, 'engram-memory');
    assert.equal(skill.source, 'runtime');
    const description = skill.description as string;
    assert.ok(description.length > 0);
    assert.ok(!description.includes('\n'));
    const content = skill.content as string;
    assert.ok(content.startsWith('# '));
    assert.ok(!content.includes('name: engram-memory'));
  });
});

test('disposal removes both contributions', () => {
  withTempHome((callsPath) => {
    const host = protocolHost('both');
    apply(host.ctx, configFor(callsPath));
    host.disposeAll();
    assert.deepEqual(host.removed.sort(), ['section', 'skill']);
  });
});

test('a host without an inject point, or without those services, still loads', () => {
  for (const mode of ['no-inject', 'services-absent'] as const) {
    withTempHome((callsPath) => {
      const host = protocolHost(mode);
      assert.doesNotThrow(() => apply(host.ctx, configFor(callsPath)));
      assert.equal(host.sections.length, 0);
      assert.equal(host.skills.length, 0);
      host.disposeAll();
    });
  }
});
