import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "./secretAtRest";

const SEED_A = crypto.getRandomValues(new Uint8Array(16));
const SEED_B = crypto.getRandomValues(new Uint8Array(16));

describe("encryptSecret / decryptSecret round-trip", () => {
  it("decrypts with the same seed it was encrypted under", async () => {
    const secret = await encryptSecret(SEED_A, "super-secret-daemon-api-key");
    expect(await decryptSecret(SEED_A, secret)).toBe("super-secret-daemon-api-key");
  });

  it("rejects decryption under a different seed", async () => {
    const secret = await encryptSecret(SEED_A, "super-secret-daemon-api-key");
    await expect(decryptSecret(SEED_B, secret)).rejects.toThrow("Could not decrypt stored secret");
  });

  it("produces a different iv/ciphertext each time, even for the same seed and plaintext", async () => {
    const a = await encryptSecret(SEED_A, "same key");
    const b = await encryptSecret(SEED_A, "same key");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decryptSecret(SEED_A, a)).toBe("same key");
    expect(await decryptSecret(SEED_A, b)).toBe("same key");
  });

  it("rejects a tampered ciphertext (AES-GCM auth tag fails)", async () => {
    const secret = await encryptSecret(SEED_A, "a daemon api key");
    const tampered: EncryptedSecret = {
      ...secret,
      ciphertext: secret.ciphertext.slice(0, -2) + (secret.ciphertext.slice(-2) === "00" ? "01" : "00"),
    };
    await expect(decryptSecret(SEED_A, tampered)).rejects.toThrow("Could not decrypt stored secret");
  });

  it("round-trips an empty string", async () => {
    const secret = await encryptSecret(SEED_A, "");
    expect(await decryptSecret(SEED_A, secret)).toBe("");
  });

  it("round-trips unicode content", async () => {
    const secret = await encryptSecret(SEED_A, "key-with-emoji-🔑-and-ünïcode");
    expect(await decryptSecret(SEED_A, secret)).toBe("key-with-emoji-🔑-and-ünïcode");
  });
});
