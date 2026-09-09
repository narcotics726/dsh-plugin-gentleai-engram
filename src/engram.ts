import { extractText, type McpContentBlock } from './mcp-client.js';

/** The common engram MCP response envelope (see engram DOCS "Response envelope"). */
export interface EngramEnvelope {
  project?: string;
  projectSource?: string;
  result: string;
}

export function parseEnvelope(content: readonly McpContentBlock[] | undefined): EngramEnvelope {
  const text = extractText(content);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      project: typeof parsed.project === 'string' && parsed.project !== '' ? parsed.project : undefined,
      projectSource:
        typeof parsed.project_source === 'string' && parsed.project_source !== ''
          ? parsed.project_source
          : undefined,
      result: typeof parsed.result === 'string' ? parsed.result : text,
    };
  } catch {
    return { result: text };
  }
}

const KEY_LEARNINGS = /^##\s*Key Learnings\s*:?\s*$/m;

/** Whether the text contains the capture convention's section heading. */
export function hasLearningsSection(text: string): boolean {
  return KEY_LEARNINGS.test(text);
}

/** `extracted=N saved=M duplicates=D` from a passive-capture result, when present. */
export function parseCaptureCounts(result: string): { extracted?: number; saved?: number; duplicates?: number } {
  const match = /extracted=(\d+)\s+saved=(\d+)\s+duplicates=(\d+)/.exec(result);
  if (!match) return {};
  return {
    extracted: Number(match[1]),
    saved: Number(match[2]),
    duplicates: Number(match[3]),
  };
}

/** Rough token budget -> character budget (4 chars per token). */
export function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const maxChars = Math.max(0, Math.floor(tokenBudget * 4));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(truncated to ${tokenBudget} tokens)`;
}
