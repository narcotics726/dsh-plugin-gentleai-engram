/**
 * The engram protocol text, carried as package assets rather than code.
 *
 * Two files under `protocol/` are the single source of truth (design D2): the
 * resident trigger block and the on-demand skill body. They ship with the
 * plugin, so no user-machine file has to exist for the model to be told what
 * it owes engram.
 *
 * The assets live OUTSIDE `src/`: `tsc` has `rootDir: src` and never copies
 * non-TypeScript files, so an asset under `src/` would be missing from `dist`.
 * `package.json` lists `protocol` in `files` for the same reason.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The section's name and order are LITERALS on purpose (design D3).
 *
 * The host owns a table of centrally allocated positions behind
 * `ctx.systemPrompt.getSectionOrder(name)`, but that table is neither exported
 * nor stable: between the version this repository pins and the one running on
 * the machine, `DEPLOYMENT_PERSONA` was renamed to `DEPLOYMENT_PERSONA_PREFIX`
 * (keeping 0) while `HARNESS_SOURCE`/`WEB_SURFACE` moved from -900/-800 to
 * 10000/10100. A named lookup would therefore compile and then throw at load
 * (`section()` rejects a non-finite order). 350 sits in the gap both versions
 * leave open between the persona (0) and the first policy section (500).
 */
export const PROTOCOL_SECTION_NAME = 'engram:protocol';
export const PROTOCOL_SECTION_ORDER = 350;

export interface ProtocolSkill {
  name: string;
  description: string;
  content: string;
}

export interface ProtocolAssets {
  /** Resident trigger text: the body of the system prompt section. */
  resident: string;
  /** On-demand skill body plus the catalog metadata it must be registered with. */
  skill: ProtocolSkill;
}

export interface ProtocolAssetPaths {
  resident: URL;
  skill: URL;
}

/**
 * Resolved from `dist/`, so `..` is the package root: the assets stay siblings
 * of `dist/` in both the `link:` install used on this machine and a published
 * tarball.
 */
export function defaultProtocolAssetPaths(): ProtocolAssetPaths {
  return {
    resident: new URL('../protocol/resident.md', import.meta.url),
    skill: new URL('../protocol/engram-memory.skill.md', import.meta.url),
  };
}

export interface FrontmatterSplit {
  /** Scalar fields declared in the frontmatter block; empty when there is none. */
  fields: Map<string, string>;
  /** Everything after the block, or the whole input when there is no block. */
  body: string;
}

/**
 * Split an optional leading frontmatter block from a markdown asset.
 *
 * Deliberately not a YAML parser: only the two scalar shapes this repository's
 * assets use are supported (a plain scalar, and a folded/literal block scalar).
 * A block scalar is how the skill's multi-line `description` is written, and
 * the registered catalog description has to come out as ONE line, so folded
 * blocks are joined with spaces.
 *
 * An input without a leading `---` line is returned whole, with no fields: the
 * resident asset is plain markdown and must not need a block to be readable.
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  if (!/^---\r?\n/.test(text)) return { fields: new Map(), body: text };
  const lines = text.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      end = i;
      break;
    }
  }
  // An unterminated block is NOT frontmatter: treating it as one would silently
  // swallow the document.
  if (end === -1) return { fields: new Map(), body: text };

  const fields = new Map<string, string>();
  const block = lines.slice(1, end);
  for (let i = 0; i < block.length; i += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(block[i]!);
    if (match === null) continue;
    const key = match[1]!;
    const raw = match[2]!.trim();
    if (/^[>|][+-]?$/.test(raw)) {
      const folded = raw[0] === '>';
      const chunk: string[] = [];
      let j = i + 1;
      for (; j < block.length; j += 1) {
        const line = block[j]!;
        if (line.trim() !== '' && /^[A-Za-z][A-Za-z0-9_-]*:/.test(line)) break;
        chunk.push(line.trim());
      }
      i = j - 1;
      const joined = folded ? chunk.filter((part) => part !== '').join(' ') : chunk.join('\n');
      fields.set(key, raw.endsWith('-') ? joined : joined + '\n');
    } else {
      fields.set(key, raw.replace(/^['"]|['"]$/g, ''));
    }
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '');
  return { fields, body };
}

function readAsset(url: URL, what: string): string {
  try {
    return readFileSync(url, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`engram-bridge: 协议资产不可读（${what}）：${fileURLToPath(url)} — ${reason}`);
  }
}

/**
 * Parse the skill asset. A missing `name` or `description` fails here rather
 * than at the registry, which would otherwise register a skill nobody can
 * route to (the catalog shows the description and nothing else).
 */
export function parseSkillAsset(text: string, source: string): ProtocolSkill {
  const { fields, body } = splitFrontmatter(text);
  const name = (fields.get('name') ?? '').trim();
  const description = (fields.get('description') ?? '').trim();
  if (name === '') throw new Error(`engram-bridge: 协议技能资产缺少 frontmatter 的 name：${source}`);
  if (description === '') {
    throw new Error(`engram-bridge: 协议技能资产缺少 frontmatter 的 description：${source}`);
  }
  if (body.trim() === '') throw new Error(`engram-bridge: 协议技能资产正文为空：${source}`);
  return { name, description, content: body };
}

/**
 * Read both assets. Called from `apply()`, never at module scope: reading files
 * is a process-level side effect and this plugin's contributions are all
 * ctx-owned. A missing or unreadable asset throws AT LOAD, naming the file.
 */
export function loadProtocolAssets(paths: ProtocolAssetPaths = defaultProtocolAssetPaths()): ProtocolAssets {
  const resident = readAsset(paths.resident, '常驻段').trim();
  if (resident === '') throw new Error(`engram-bridge: 常驻段资产为空：${fileURLToPath(paths.resident)}`);
  const skill = parseSkillAsset(readAsset(paths.skill, '流程技能'), fileURLToPath(paths.skill));
  return { resident, skill };
}
