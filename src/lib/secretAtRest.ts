// Encrypts small secondary secrets (currently: daemon connection API keys) at rest in
// chrome.storage.local, using a key derived from the wallet's own unlocked seed.
//
// Before this, daemon API keys (README: "a long-lived API key... minted once from the daemon's
// own web UI", required to carry the `admin` permission) were stored in chrome.storage.local as
// plain text, unlike the seed itself (which is AES-256-GCM encrypted behind the unlock password
// via vault.ts). That's a real asymmetry: this codebase clearly already treats "someone reads
// chrome.storage.local off disk" as a threat worth defending against for one credential that
// grants meaningful control (the seed), but not for another that also grants meaningful control
// (admin access to a wallet daemon) via the exact same storage mechanism.
//
// This deliberately does NOT reuse the unlock password (vault.ts's PBKDF2 path) -- that would
// mean re-prompting for the password every time a daemon connection is added or used, for no
// real security benefit, since the seed itself is only available in memory (chrome.storage
// .session) precisely when the wallet is unlocked. Deriving a stable AES key from the seed's own
// entropy via a domain-separated SHA-256 hash (not the raw entropy directly, so this key can
// never be confused with or leak the seed derivation itself) gets the same "only readable while
// unlocked" property for free, with no extra prompts. The seed's ~128+ bits of entropy is already
// far more than a user password provides, so a fast KDF (a single hash) here is appropriate --
// unlike vault.ts's PBKDF2, which specifically exists to slow down guessing a low-entropy
// password, not to strengthen already-high-entropy input.
import { fromHex, toHex } from "./vault";

const DOMAIN_PREFIX = "tari-wallet-extension/secret-at-rest/v1:";

export interface EncryptedSecret {
  iv: string; // hex
  ciphertext: string; // hex
}

async function deriveKey(seedEntropy: Uint8Array): Promise<CryptoKey> {
  const prefixBytes = new TextEncoder().encode(DOMAIN_PREFIX);
  const input = new Uint8Array(prefixBytes.length + seedEntropy.length);
  input.set(prefixBytes, 0);
  input.set(seedEntropy, prefixBytes.length);
  const hash = await crypto.subtle.digest("SHA-256", input as BufferSource);
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(seedEntropy: Uint8Array, plaintext: string): Promise<EncryptedSecret> {
  const key = await deriveKey(seedEntropy);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext))
  );
  return { iv: toHex(iv), ciphertext: toHex(ciphertext) };
}

/** @throws if `seedEntropy` doesn't match the one this secret was encrypted under, or the data is corrupt. */
export async function decryptSecret(seedEntropy: Uint8Array, secret: EncryptedSecret): Promise<string> {
  const key = await deriveKey(seedEntropy);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(secret.iv) as BufferSource },
      key,
      fromHex(secret.ciphertext) as BufferSource
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Could not decrypt stored secret (wrong seed or corrupt data).");
  }
}
