/**
 * WordPiece tokenizer for the embedding model (BAAI/bge-small-zh-v1.5).
 *
 * PROVENANCE: port of the validated TypeScript port at
 *   ops/readlayer-eng/wasmspike/bert_tokenizer.ts
 *   sha256 04422367acc6d906edb6cf069d87254b77f01230e86b23e54766ae85e1778b7e
 * where it was checked against fastembed's own tokenizer (1014/1014 probe
 * sequences identical). Faithful to the `tokenizers` BertTokenizer pipeline read
 * out of the shipped `tokenizer.json`:
 *   normalizer      BertNormalizer(clean_text, handle_chinese_chars,
 *                                 strip_accents=null, lowercase=false)
 *   pre_tokenizer   BertPreTokenizer (whitespace split, punctuation isolated)
 *   model           WordPiece(continuing_subword_prefix="##", unk="[UNK]")
 *   post_processor  TemplateProcessing: [CLS] A [SEP]
 *
 * Truncation is applied AFTER the template inserts the special tokens, and it is
 * load-bearing: a truncated document is exactly
 *   [CLS] + first (maxLength-2) wordpieces + [SEP]
 * (239 of 346 frozen documents hit the 512 cap, so this path is the common one,
 * not the corner case).
 *
 * Control characters: Cc, Cf, Co (and Cs) are dropped, but Cn (unassigned /
 * noncharacters such as U+FFFF) is KEPT — the naive `\p{C}` removes Cn too and
 * changes tokenization. TAB/LF/CR survive as whitespace.
 */

import { readFileSync } from 'node:fs';

const WS = /\p{White_Space}/u; // binary property; U+2028/Zs/NBSP all included
const CAT_C = /\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}/u;
const CAT_P = /\p{P}/u;

/** Rust/HF `is_chinese_char`, i.e. the ranges BertNormalizer spaces out. */
export function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function isControl(cp: number, ch: string): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return CAT_C.test(ch);
}

function isPunct(cp: number, ch: string): boolean {
  if (cp < 128) {
    // ASCII: printable non-alphanumeric (HF BasicTokenizer._is_punctuation).
    return !((cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122));
  }
  return CAT_P.test(ch);
}

/** BertNormalizer.do_clean_text + do_handle_chinese_chars (lowercase=false). */
export function normalize(text: string): string {
  const cleaned: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || isControl(cp, ch)) continue;
    cleaned.push(WS.test(ch) ? ' ' : ch);
  }
  const out: string[] = [];
  for (const ch of cleaned) {
    if (isChineseChar(ch.codePointAt(0)!)) {
      out.push(' ', ch, ' ');
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

/** BertPreTokenizer: whitespace (removed) then punctuation (isolated). */
export function preTokenize(normalized: string): string[] {
  const pieces: string[] = [];
  for (const chunk of normalized.split(' ')) {
    if (chunk === '') continue;
    let cur = '';
    for (const ch of chunk) {
      if (isPunct(ch.codePointAt(0)!, ch)) {
        if (cur !== '') {
          pieces.push(cur);
          cur = '';
        }
        pieces.push(ch);
      } else {
        cur += ch;
      }
    }
    if (cur !== '') pieces.push(cur);
  }
  return pieces;
}

export interface TokenizerMeta {
  maxLength: number;
  clsId: number;
  sepId: number;
  unkId: number;
  prefix: string;
  maxInputCharsPerWord: number;
  vocabSize: number;
}

/** Bounded memo: a resident process must not grow a per-document cache forever. */
const CACHE_LIMIT = 2048;

export class BertTokenizer {
  readonly vocab: Map<string, number>;
  readonly meta: TokenizerMeta;
  private readonly cache = new Map<string, number[]>();

  constructor(tokenizerJsonPath: string, modelMaxLength = 512) {
    const spec = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8')) as {
      model: { vocab: Record<string, number>; continuing_subword_prefix?: string; max_input_chars_per_word?: number; unk_token?: string };
      // TemplateProcessing stores a token NAME here ("[CLS]"), not a numeric id
      // (the numeric id lives alongside it under `ids`). Looking it up in the
      // vocab is what turns it into 101.
      post_processor?: { special_tokens?: Record<string, { id?: string }> };
    };
    const vocabObj = spec.model.vocab;
    this.vocab = new Map(Object.entries(vocabObj));
    const prefix: string = spec.model.continuing_subword_prefix ?? '##';
    const maxChars: number = spec.model.max_input_chars_per_word ?? 100;
    const byToken = (t: string): number => {
      const id = this.vocab.get(t);
      if (id === undefined) throw new Error(`special token ${t} not in vocab`);
      return id;
    };
    this.meta = {
      maxLength: modelMaxLength,
      clsId: byToken(spec.post_processor?.special_tokens?.['[CLS]']?.id ?? '[CLS]'),
      sepId: byToken(spec.post_processor?.special_tokens?.['[SEP]']?.id ?? '[SEP]'),
      unkId: byToken(spec.model.unk_token ?? '[UNK]'),
      prefix,
      maxInputCharsPerWord: maxChars,
      vocabSize: this.vocab.size,
    };
  }

  /** WordPiece greedy longest-match; null means the whole word is [UNK]. */
  private wordpiece(word: string): string[] | null {
    const chars = Array.from(word); // code points, as the Rust model does
    if (chars.length > this.meta.maxInputCharsPerWord) return null;
    const out: string[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: string | null = null;
      while (start < end) {
        const piece = chars.slice(start, end).join('');
        const candidate = start > 0 ? this.meta.prefix + piece : piece;
        if (this.vocab.has(candidate)) {
          found = candidate;
          break;
        }
        end--;
      }
      if (found === null) return null;
      out.push(found);
      start = end;
    }
    return out;
  }

  /** post_processor ([CLS] A [SEP]) then truncate to maxLength (right). */
  encode(text: string): number[] {
    const hit = this.cache.get(text);
    if (hit !== undefined) return hit;
    const ids: number[] = [this.meta.clsId];
    for (const piece of preTokenize(normalize(text))) {
      const wp = this.wordpiece(piece);
      if (wp === null) {
        ids.push(this.meta.unkId);
      } else {
        for (const w of wp) ids.push(this.vocab.get(w)!);
      }
    }
    ids.push(this.meta.sepId);
    if (ids.length > this.meta.maxLength) {
      ids.length = this.meta.maxLength - 1; // [CLS] + first (max-2) wordpieces
      ids.push(this.meta.sepId);
    }
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(text, ids);
    return ids;
  }
}
