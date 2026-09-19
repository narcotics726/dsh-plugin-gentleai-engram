/**
 * Does the shipped protocol text ask the model to call tools that are actually
 * on its surface?
 *
 * The text and the tool surface are two halves of one obligation: the resident
 * block says WHEN the model owes engram something, and the skill body says HOW.
 * Both name tools. Nothing in the type system connects a name in a markdown
 * asset to a registered tool, and the failure mode is silent — the model reads
 * an instruction, calls a name, and gets an unknown-tool error (or worse, skips
 * the step because it "knows" the tool exists).
 *
 * Two kinds of mention are legitimate:
 *
 *  * a name that IS on the surface — an instruction to call it;
 *  * a name the plugin deliberately does not register, mentioned exactly in
 *    order to explain that it is missing. That mention must SAY so, on the same
 *    line, using one of `UNREGISTERED_MARKERS`. Without that marker the two
 *    kinds are indistinguishable to a reader and to this check.
 *
 * Anything else is a violation: a name that is neither available nor explained.
 */

import { UNREGISTERED_ENGRAM_TOOLS } from './tools.js';

/** Phrases that mark a mention as "this one is deliberately not callable". */
export const UNREGISTERED_MARKERS: readonly string[] = [
  '刻意不注册',
  '不可调用',
  '不注册',
  '找不到它们',
];

export type ProtocolViolationReason = 'unregistered-without-marker' | 'unknown-tool';

export interface ProtocolToolViolation {
  name: string;
  /** 1-based line number in the asset. */
  line: number;
  reason: ProtocolViolationReason;
  text: string;
}

export interface ProtocolToolMention {
  name: string;
  line: number;
  text: string;
}

/** Tool-name prefix; a mention may carry it or not, on either side of the check. */
const PREFIX = 'mcp__engram__';

/** Both the text and the surface may spell a name with the prefix; compare bare. */
function bare(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

/**
 * Every engram tool name mentioned in `text`, bare (prefix stripped).
 *
 * `mem_` without a following identifier character is not a name — which is what
 * keeps a wildcard such as `mcp__engram__mem_*` from being read as a tool.
 */
export function extractToolMentions(text: string): ProtocolToolMention[] {
  const out: ProtocolToolMention[] = [];
  const lines = text.split('\n');
  const pattern = /(?:mcp__engram__)?mem_[a-z0-9_]+/g;
  lines.forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      out.push({ name: bare(match[0]), line: index + 1, text: line });
    }
  });
  return out;
}

export interface ProtocolToolSurface {
  /** Names the model can actually call right now. */
  visible: readonly string[];
  /** Names the plugin deliberately does not register. */
  unregistered?: readonly string[];
}

/**
 * Check one asset. Returns every violation; an empty array is a pass.
 *
 * A mention of a deliberately-unregistered tool passes only when the same line
 * carries one of the markers, so "explaining the gap" and "issuing an
 * instruction" stay separable.
 */
export function checkProtocolTools(
  text: string,
  surface: ProtocolToolSurface,
): ProtocolToolViolation[] {
  const unregistered = new Set((surface.unregistered ?? UNREGISTERED_ENGRAM_TOOLS).map(bare));
  const visible = new Set(surface.visible.map(bare));
  const violations: ProtocolToolViolation[] = [];
  for (const mention of extractToolMentions(text)) {
    if (unregistered.has(mention.name)) {
      if (!UNREGISTERED_MARKERS.some((marker) => mention.text.includes(marker))) {
        violations.push({ ...mention, reason: 'unregistered-without-marker' });
      }
      continue;
    }
    if (!visible.has(mention.name)) {
      violations.push({ ...mention, reason: 'unknown-tool' });
    }
  }
  return violations;
}
