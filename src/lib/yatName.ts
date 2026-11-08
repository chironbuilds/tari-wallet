// Emoji names (Yats) in the wallet: spelling rules and the parts of a name a resolver needs.
//
// A Yat is an ordered string of 1 to 6 emoji; order is identity (🦄🚀 is not 🚀🦄). Emoji are
// grapheme clusters (ZWJ sequences, skin tones, variation selectors), so a name is split by
// extended grapheme cluster, never by code point. Yat treats a few emoji as alternate spellings
// ("siblings") of one base emoji: 💜💜💜 and ❤️❤️❤️ are the same Yat, shown the way its owner
// prefers. Folding here gives the wallet Yat's own idea of identity, so a payer who types 💜 reaches
// the owner of ❤️. The sibling table is Yat's (y.at/create picker, read 2026-10-21).
//
// Ported from raddish's data-spine (yat-market/data-spine/src/emoji.mjs), which runs the same rules
// on its site against the full 208k-Yat census.

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
/** U+FE0F (emoji presentation) and U+FE0E (text presentation). */
const VARIATION_SELECTORS = /[︎️]/g;

/** Base emoji for each Yat sibling; keys and values in folded form (no variation selectors). */
export const YAT_SIBLINGS: Readonly<Record<string, string>> = Object.freeze({
  "💜": "❤", "💙": "❤", "💚": "❤", "💛": "❤", "🧡": "❤", "🖤": "❤", "🤍": "❤", "💖": "❤", "♥": "❤",
  "🦙": "🐑", "🐏": "🐑",
  "💶": "💵", "💴": "💵", "💷": "💵", "💸": "💵",
  "🏉": "🏈", "⛏": "🔨", "🦕": "🦖",
});

// Whole RGI emoji sequences (ZWJ, flags, keycaps) need the `v` flag, which this package's ES2022
// target does not let us write as a literal; every supported browser engine has it (Chrome 112+).
const RGI_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");

export function toGraphemes(str: string): string[] {
  return [...segmenter.segment(str)].map((s) => s.segment);
}

/** NFC, variation selectors dropped, Yat siblings folded: the identity of one emoji in a name. */
export function foldGrapheme(grapheme: string): string {
  const f = grapheme.normalize("NFC").replace(VARIATION_SELECTORS, "");
  return YAT_SIBLINGS[f] ?? f;
}

/** The folded graphemes of a name: what two spellings of the same Yat have in common. */
export function toTokens(str: string): string[] {
  return toGraphemes(str).map(foldGrapheme).filter((g) => g.length > 0);
}

export function isEmojiGrapheme(grapheme: string): boolean {
  const g = grapheme.normalize("NFC");
  return RGI_EMOJI.test(g) || /\p{Extended_Pictographic}/u.test(g);
}

export interface YatCheck {
  ok: boolean;
  length: number;
  reason?: "empty" | "too long" | "not emoji";
}

/** Is this string a Yat spelling: 1 to 6 emoji graphemes and nothing else? */
export function validateYat(str: string): YatCheck {
  const g = toGraphemes(str.trim());
  if (g.length === 0) return { ok: false, length: 0, reason: "empty" };
  // "not emoji" before "too long": an address or a word pasted here is many graphemes, and the
  // useful thing to say about it is that it is not a name at all.
  if (!g.every(isEmojiGrapheme)) return { ok: false, length: g.length, reason: "not emoji" };
  if (g.length > 6) return { ok: false, length: g.length, reason: "too long" };
  return { ok: true, length: g.length };
}

/** True when the string looks like an emoji name rather than an address: at least one emoji grapheme
 * and no ASCII letters or digits. Used to decide whether a Send recipient needs resolving. */
export function looksLikeYat(str: string): boolean {
  const s = str.trim();
  return s.length > 0 && !/[A-Za-z0-9_]/.test(s) && validateYat(s).ok;
}

/** The form y.at's API expects in a path: the folded tokens, joined, percent-encoded. */
export function yatPathId(str: string): string {
  return encodeURIComponent(toTokens(str).join(""));
}

/** The canonical display form: NFC, siblings folded, one string. */
export function canonicalYat(str: string): string {
  return toTokens(str).join("");
}
