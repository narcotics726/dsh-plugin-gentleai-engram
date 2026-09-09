import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpToolDeclaration } from './mcp-client.js';

/**
 * On-disk tool-surface cache.
 *
 * The tool list a step's request is built from is frozen when the step's system
 * prompt is assembled — BEFORE any pre-step/request hook runs (verified in
 * dsh-agent-loop: `preStep` assembles at index.js:502, the pre-step waterfall
 * at :506, `buildRequest(..., assembly.tools, ...)` at :619). A load-time
 * discovery therefore cannot make the tools visible on the very first request of
 * a cold one-shot run. Caching the last successful discovery lets the next boot
 * register synchronously at load, so the first request already carries them.
 */
export interface ToolCacheRecord {
  fingerprint: string;
  discoveredAt: string;
  tools: McpToolDeclaration[];
}

export function toolCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'storages', 'engram-bridge', 'tools.json');
}

/** Stable identity of the tool surface: same executable + args => same tools. */
export function toolCacheFingerprint(command: string, args: readonly string[]): string {
  return `${command} ${args.join(' ')}`;
}

export function readToolCache(
  path: string,
  fingerprint: string,
): McpToolDeclaration[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ToolCacheRecord>;
    if (parsed.fingerprint !== fingerprint) return undefined;
    if (!Array.isArray(parsed.tools)) return undefined;
    const tools = parsed.tools.filter(
      (tool): tool is McpToolDeclaration =>
        typeof tool === 'object' && tool !== null && typeof (tool as { name?: unknown }).name === 'string',
    );
    return tools.length > 0 ? tools : undefined;
  } catch {
    return undefined;
  }
}

export function writeToolCache(
  path: string,
  fingerprint: string,
  tools: readonly McpToolDeclaration[],
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const record: ToolCacheRecord = { fingerprint, discoveredAt: new Date().toISOString(), tools: [...tools] };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    /* a cache miss is never fatal */
  }
}

export function sameToolSurface(a: readonly McpToolDeclaration[], b: readonly McpToolDeclaration[]): boolean {
  if (a.length !== b.length) return false;
  const names = (list: readonly McpToolDeclaration[]): string => list.map((tool) => tool.name).sort().join(',');
  return names(a) === names(b);
}
