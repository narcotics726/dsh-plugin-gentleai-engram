/**
 * Bigram tokenizer for the lexical half of the read layer.
 *
 * PROVENANCE: port of the validated TypeScript port at
 *   tsbigram/tokenizer.ts (the spike tree was removed 2026-09-15; this
 *   repository is now the only copy — the digest below still identifies it)
 *   sha256 96ccd4b43fc624eb3df83ca5be45f17cb5417bbf244fa7a7e7afe293a9666267
 * itself a port of the spike's Python `bigram/bigram_lib.py`
 * (CJK_RANGES, is_cjk, tokenize, distinct_tokens). The lexical port was verified
 * row-equal against the Python reference (spike REPORT.md V5: 346 docs /
 * 28181 terms / 79157 postings / 13 meta), so this file is a reproduction, not a
 * redesign. Two traps it handles explicitly:
 *
 *  1. JS strings are UTF-16, Python strings are code points. A CJK Extension B+
 *     character is one Python character but two JS code units, and an astral
 *     emoji also counts as 1 for Python `len()`. Every count/slice iterates code
 *     points (`for..of` / `Array.from`), never raw `string.length`.
 *  2. `str.isascii() and str.isalnum()` on one character is exactly
 *     `/[0-9A-Za-z]/`; `str.lower()` on ASCII is exactly `toLowerCase()`.
 */

/** CJK ranges, exactly as bigram_lib.CJK_RANGES (inclusive code points). */
export const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0x20000, 0x2a6df], // Extension B
  [0x2a700, 0x2ebef], // Extensions C-F
  [0x2f800, 0x2fa1f], // CJK Compatibility Ideographs Supplement
  [0x30000, 0x3134f], // Extension G
];

export type Kind = 'b' | 'u' | 'a';

/** [token, kind] — the reference tokenizer returns a list of such tuples. */
export type Token = readonly [string, Kind];

export function isCjkCodePoint(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (lo <= cp && cp <= hi) return true;
  }
  return false;
}

/** Python `bigram_lib.is_cjk(ch)`; accepts exactly one code point. */
export function isCjk(ch: string): boolean {
  const cps = Array.from(ch);
  if (cps.length !== 1) {
    throw new TypeError(`isCjk() expects a single code point, got ${cps.length}`);
  }
  return isCjkCodePoint(cps[0]!.codePointAt(0)!);
}

// Python: ch.isascii() and ch.isalnum()  ==  /[0-9A-Za-z]/
const ASCII_ALNUM = /^[0-9A-Za-z]$/;

export function isAsciiAlnum(ch: string): boolean {
  return ASCII_ALNUM.test(ch);
}

/** Number of Python characters (code points) in `s`. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Python's default string ordering (lexicographic over code points), which is
 * not the same as JS `<` over UTF-16 code units.
 */
export function codePointCompare(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i]!.codePointAt(0)!;
    const y = cb[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ca.length - cb.length;
}

/**
 * Port of `bigram_lib.tokenize`: a list of (token, kind) in text order,
 * duplicates preserved (tf).
 *
 * With `allUnigrams` every CJK character is additionally emitted as a 'u' token;
 * with the default only an isolated one-character CJK run yields a 'u' token.
 */
export function tokenize(text: string, allUnigrams = false): Token[] {
  const out: Token[] = [];
  const cps = Array.from(text); // one entry per Python character
  const n = cps.length;
  let i = 0;
  while (i < n) {
    const ch = cps[i]!;
    if (isCjk(ch)) {
      let j = i;
      while (j < n && isCjk(cps[j]!)) j++;
      const run = cps.slice(i, j);
      if (run.length === 1) {
        out.push([run[0]!, 'u']);
      } else {
        if (allUnigrams) {
          for (const c of run) out.push([c, 'u']);
        }
        for (let k = 0; k < run.length - 1; k++) {
          out.push([run[k]! + run[k + 1]!, 'b']);
        }
      }
      i = j;
    } else if (isAsciiAlnum(ch)) {
      let j = i;
      while (j < n && isAsciiAlnum(cps[j]!)) j++;
      const w = cps.slice(i, j).join('').toLowerCase();
      if (w.length >= 2) out.push([w, 'a']);
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Port of `bigram_lib.distinct_tokens`: ordered distinct (token, kind) pairs for
 * a query. Python preserves first-insertion order of a dict; so do we, via a
 * Map. The key uses NUL as a separator, which cannot occur in a token (tokens
 * are CJK characters or ASCII [a-z0-9]).
 */
export function distinctTokens(text: string, allUnigrams = false): Token[] {
  const seen = new Map<string, Token>();
  for (const [tok, kind] of tokenize(text, allUnigrams)) {
    const key = kind + '\u0000' + tok;
    if (!seen.has(key)) seen.set(key, [tok, kind]);
  }
  return [...seen.values()];
}

/** Map key for one (token, kind) pair. */
export function tokenKey(token: Token): string {
  return token[1] + '\u0000' + token[0];
}
