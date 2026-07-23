// Byte-string <-> mnemonic-word codec, reproducing Tari's `to_bytes`/`from_bytes`
// (base_layer/common_types/src/seeds/mnemonic.rs) for the one length this codebase ever uses it
// at: exactly 33 bytes <-> 24 words (264 bits, divides evenly both ways: 33*8 = 24*11 = 264) —
// NOT the standard BIP-39 codec. Each word encodes 11 bits (log2(2048)); the byte array and the
// word sequence both represent the same 264-bit integer, just in base-256 and base-2048
// respectively, least-significant digit first. There's no embedded checksum here (CipherSeed's own
// CRC32 + MAC are the integrity checks — see cipherSeed.ts); Tari's own codec instead zero-pads
// misaligned lengths, a case that can't arise for our fixed 33-byte input, so mismatched lengths
// are treated as a bug and rejected outright rather than silently padded.
//
// The wordlist itself is confirmed byte-identical, same order, to Tari's `MNEMONIC_ENGLISH_WORDS`
// (both are the standard public-domain BIP-39 English list) — only the packing algorithm differs
// from BIP-39, so WORDLIST is reused as-is.
import { WORDLIST } from "./wordlist";

const WORD_INDEX = new Map(WORDLIST.map((w, i) => [w, i]));
const BITS_PER_WORD = 11;

export function bytesToWords(bytes: Uint8Array): string[] {
  if ((bytes.length * 8) % BITS_PER_WORD !== 0) {
    throw new Error(`Internal error: ${bytes.length} bytes does not pack into a whole number of words`);
  }
  let rest = 0n;
  let restBits = 0;
  const words: string[] = [];
  for (const byte of bytes) {
    rest |= BigInt(byte) << BigInt(restBits);
    restBits += 8;
    while (restBits >= BITS_PER_WORD) {
      const index = Number(rest & 0x7ffn);
      const word = WORDLIST[index];
      if (word === undefined) throw new Error(`Internal error: wordlist index ${index} out of range`);
      words.push(word);
      rest >>= BigInt(BITS_PER_WORD);
      restBits -= BITS_PER_WORD;
    }
  }
  return words;
}

export function wordsToBytes(words: string[]): Uint8Array {
  if ((words.length * BITS_PER_WORD) % 8 !== 0) {
    throw new Error(`Internal error: ${words.length} words does not pack into a whole number of bytes`);
  }
  const bytes: number[] = [];
  let rest = 0n;
  let restBits = 0;
  for (const rawWord of words) {
    const index = WORD_INDEX.get(rawWord.toLowerCase());
    if (index === undefined) throw new Error(`"${rawWord}" is not a valid recovery-phrase word`);
    rest |= BigInt(index) << BigInt(restBits);
    restBits += BITS_PER_WORD;
    while (restBits >= 8) {
      bytes.push(Number(rest & 0xffn));
      rest >>= 8n;
      restBits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
