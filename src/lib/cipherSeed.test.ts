// Fast, self-consistency tests. Byte-exact correctness against the real Rust CipherSeed
// implementation is checked separately in scripts/test-crypto.ts (npm run test:crypto), which
// needs the slower Argon2d pass and is run against golden vectors generated from the actual
// upstream crate — see that file's comments for how those were produced.
import { describe, expect, it } from "vitest";
import {
  createWalletSeed,
  decipherSeed,
  deserializeSeed,
  encipherSeed,
  importWalletSeed,
  InvalidRecoveryPhraseError,
  isPlausibleMnemonic,
  randomWalletSeed,
  seedToMnemonic,
  serializeSeed,
} from "./cipherSeed";

describe("createWalletSeed / importWalletSeed round-trip", () => {
  it("a freshly created wallet's mnemonic imports back to the same seed", async () => {
    const { seed, mnemonic } = await createWalletSeed();
    expect(mnemonic.split(" ")).toHaveLength(24);
    const imported = await importWalletSeed(mnemonic);
    expect(imported).toEqual(seed);
  }, 20_000);

  it("reveal (seedToMnemonic) reproduces the exact same mnemonic every time", async () => {
    const { seed, mnemonic } = await createWalletSeed();
    expect(await seedToMnemonic(seed)).toBe(mnemonic);
    expect(await seedToMnemonic(seed)).toBe(mnemonic);
  }, 20_000);

  it("serializeSeed/deserializeSeed round-trips and preserves salt/birthday for reveal", async () => {
    const { seed, mnemonic } = await createWalletSeed();
    const restored = deserializeSeed(serializeSeed(seed));
    expect(restored).toEqual(seed);
    expect(await seedToMnemonic(restored)).toBe(mnemonic);
  }, 20_000);

  it("rejects a mnemonic with the wrong word count", async () => {
    await expect(importWalletSeed("abandon abandon abandon")).rejects.toThrow(InvalidRecoveryPhraseError);
  });

  it("rejects a mnemonic containing an unknown word", async () => {
    const words = Array(24).fill("abandon");
    words[3] = "notarealword";
    await expect(importWalletSeed(words.join(" "))).rejects.toThrow(InvalidRecoveryPhraseError);
  });

  it("rejects a tampered (checksum-breaking) mnemonic", async () => {
    const { mnemonic } = await createWalletSeed();
    const words = mnemonic.split(" ");
    words[0] = words[0] === "abandon" ? "ability" : "abandon";
    await expect(importWalletSeed(words.join(" "))).rejects.toThrow(InvalidRecoveryPhraseError);
  }, 20_000);

  it("rejects decrypting with the wrong passphrase (checksum passes, MAC fails)", async () => {
    const seed = randomWalletSeed();
    const enciphered = await encipherSeed(seed, "correct horse battery staple");
    await expect(decipherSeed(enciphered, "wrong passphrase")).rejects.toThrow(InvalidRecoveryPhraseError);
  }, 20_000);
});

describe("isPlausibleMnemonic", () => {
  it("accepts a freshly created wallet's mnemonic without needing the passphrase pass", async () => {
    const { mnemonic } = await createWalletSeed();
    expect(isPlausibleMnemonic(mnemonic)).toBe(true);
  }, 20_000);

  it("rejects the wrong word count", () => {
    expect(isPlausibleMnemonic("abandon abandon abandon")).toBe(false);
  });

  it("rejects an unknown word", () => {
    expect(isPlausibleMnemonic(Array(23).fill("abandon").concat("notarealword").join(" "))).toBe(false);
  });

  it("rejects a checksum-breaking tamper", async () => {
    const { mnemonic } = await createWalletSeed();
    const words = mnemonic.split(" ");
    words[0] = words[0] === "abandon" ? "ability" : "abandon";
    expect(isPlausibleMnemonic(words.join(" "))).toBe(false);
  }, 20_000);
});
