// Standard BIP-39 mnemonic encode/decode (24 words <-> 256-bit entropy), used only to give the
// user a human-writable backup of the wallet's master seed. The wordlist and checksum format are
// the widely-audited BIP-39 spec; what happens to the entropy AFTER decoding (the HD derivation
// in derivation.ts) is our own scheme, not Tari's official one — see the note there.
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { WORDLIST } from "./wordlist";

const WORD_INDEX = new Map(WORDLIST.map((w, i) => [w, i]));
const ENTROPY_BYTES = 32; // 256 bits -> 24 words; BIP-39 checksum length is ENT_bits / 32 = 8 bits.

function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(2).padStart(8, "0");
  return out;
}

function binaryToBytes(bin: string): Uint8Array {
  const bytes = new Uint8Array(bin.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bin.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

export function entropyToMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new Error(`entropy must be ${ENTROPY_BYTES} bytes`);
  }
  const checksumByte = sha256(entropy);
  const bits = bytesToBinary(entropy) + bytesToBinary(checksumByte).slice(0, 8);
  const words: string[] = [];
  for (let i = 0; i < bits.length / 11; i++) {
    const idx = parseInt(bits.slice(i * 11, i * 11 + 11), 2);
    const word = WORDLIST[idx];
    if (word === undefined) throw new Error(`Internal error: wordlist index ${idx} out of range`);
    words.push(word);
  }
  return words.join(" ");
}

export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  const words = mnemonic
    .trim()
    .split(/\s+/)
    .map((w) => w.toLowerCase());
  if (words.length !== 24) {
    throw new Error("Recovery phrase must be exactly 24 words");
  }
  let bits = "";
  for (const w of words) {
    const idx = WORD_INDEX.get(w);
    if (idx === undefined) throw new Error(`"${w}" is not a valid recovery-phrase word`);
    bits += idx.toString(2).padStart(11, "0");
  }
  const entropyBits = bits.slice(0, ENTROPY_BYTES * 8);
  const checksumBits = bits.slice(ENTROPY_BYTES * 8);
  const entropy = binaryToBytes(entropyBits);
  const expectedChecksum = bytesToBinary(sha256(entropy)).slice(0, 8);
  if (checksumBits !== expectedChecksum) {
    throw new Error("Recovery phrase is invalid (checksum mismatch) — check the word order and spelling");
  }
  return entropy;
}

export function generateMnemonic(): string {
  return entropyToMnemonic(randomBytes(ENTROPY_BYTES));
}

export function validateMnemonic(mnemonic: string): boolean {
  try {
    mnemonicToEntropy(mnemonic);
    return true;
  } catch {
    return false;
  }
}
