import { describe, expect, it } from "vitest";
import { bytesToWords, wordsToBytes } from "./mnemonic";
import { WORDLIST } from "./wordlist";

describe("mnemonic codec", () => {
  it("round-trips a random 33-byte blob (the CipherSeed length) through 24 words", () => {
    for (let trial = 0; trial < 50; trial++) {
      const bytes = crypto.getRandomValues(new Uint8Array(33));
      const words = bytesToWords(bytes);
      expect(words).toHaveLength(24);
      expect(wordsToBytes(words)).toEqual(bytes);
    }
  });

  it("packs all-last-word input the way Rust's to_bytes_with_language documents", () => {
    // Each word contributing its low bits first, higher words shifted up — 24 copies of the
    // highest index (2047 = 0b111_1111_1111) should produce 33 bytes of alternating bit patterns,
    // not silently truncate or misalign.
    const lastWord = WORDLIST[WORDLIST.length - 1]!;
    const bytes = wordsToBytes(Array(24).fill(lastWord));
    expect(bytes).toHaveLength(33);
    expect(bytesToWords(bytes)).toEqual(Array(24).fill(lastWord));
  });

  it("rejects an unknown word", () => {
    const words = Array(24).fill(WORDLIST[0]);
    words[5] = "notarealword";
    expect(() => wordsToBytes(words)).toThrow(/not a valid recovery-phrase word/);
  });

  it("rejects a byte/word length that isn't the fixed CipherSeed size", () => {
    expect(() => wordsToBytes(["abandon"])).toThrow(/does not pack into a whole number of bytes/);
    expect(() => bytesToWords(new Uint8Array(1))).toThrow(/does not pack into a whole number of words/);
  });

  it("is case-insensitive on decode", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    const words = bytesToWords(bytes).map((w) => w.toUpperCase());
    expect(wordsToBytes(words)).toEqual(bytes);
  });
});
