// Biometric unlock (Android). The unlocked seed is encrypted once with a hardware-backed Keystore key
// that only works right after a strong biometric match (BiometricVaultPlugin.java); unlocking
// decrypts it back. The user's password is never stored. A domain-separated SHA-256 check of the
// seed is kept beside the ciphertext so a stale entry can never unlock a different wallet.
import { registerPlugin } from "@capacitor/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { getUnlockedSeed, setUnlockedSeed } from "../background/session";
import { platform } from "../platform";
import type { BiometricSupport, BiometricUnlockResult } from "../platform/types";
import { t } from "../lib/i18n";

interface BiometricVaultPlugin {
  status(): Promise<{ available: boolean; code: number; hasKey: boolean }>;
  encrypt(options: { secret: string; title: string; subtitle: string; cancel: string }): Promise<{ ciphertext: string; iv: string }>;
  decrypt(options: { ciphertext: string; iv: string; title: string; subtitle: string; cancel: string }): Promise<{ secret: string }>;
  deleteKey(): Promise<void>;
  cancel(): Promise<void>;
}

const Native = registerPlugin<BiometricVaultPlugin>("BiometricVault");

const STORE_KEY = "biometricUnlock";
const CHECK_DOMAIN = new TextEncoder().encode("sapient-biometric-unlock-v1");

interface StoredUnlock {
  ciphertext: string;
  iv: string;
  /** hex(SHA-256(domain || seed)) -- recognises the right seed without storing anything reusable. */
  check: string;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function seedCheck(seed: Uint8Array): string {
  const input = new Uint8Array(CHECK_DOMAIN.length + seed.length);
  input.set(CHECK_DOMAIN);
  input.set(seed, CHECK_DOMAIN.length);
  const digest = sha256(input);
  input.fill(0);
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two equal-length hex strings. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function loadStored(): Promise<StoredUnlock | null> {
  const v = (await platform().local.get(STORE_KEY))[STORE_KEY] as StoredUnlock | undefined;
  return v && typeof v.ciphertext === "string" && typeof v.iv === "string" && typeof v.check === "string" ? v : null;
}

function errorCode(e: unknown): string {
  return typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "";
}

function promptText() {
  return { title: t("biometric.promptTitle"), subtitle: t("biometric.promptSubtitle"), cancel: t("biometric.usePassword") };
}

export function createBiometric(): BiometricSupport {
  return {
    async status() {
      try {
        const s = await Native.status();
        const stored = await loadStored();
        return { available: s.available, enabled: s.available && s.hasKey && stored !== null };
      } catch {
        return { available: false, enabled: false };
      }
    },

    async enable() {
      const seed = await getUnlockedSeed();
      if (!seed) throw new Error("Wallet is locked.");
      const secret = toB64(seed);
      const check = seedCheck(seed);
      const { ciphertext, iv } = await Native.encrypt({ secret, ...promptText(), title: t("biometric.enableTitle") });
      await platform().local.set({ [STORE_KEY]: { ciphertext, iv, check } satisfies StoredUnlock });
    },

    async cancel() {
      await Native.cancel().catch(() => {});
    },

    async disable() {
      await platform().local.remove(STORE_KEY);
      await Native.deleteKey().catch(() => {});
    },

    async unlock(): Promise<BiometricUnlockResult> {
      const stored = await loadStored();
      if (!stored) return "unavailable";
      let seed: Uint8Array;
      try {
        const { secret } = await Native.decrypt({ ciphertext: stored.ciphertext, iv: stored.iv, ...promptText() });
        seed = fromB64(secret);
      } catch (e) {
        const code = errorCode(e);
        if (code === "CANCELLED") return "cancelled";
        if (code === "LOCKOUT") return "lockout";
        if (code === "INVALIDATED" || code === "NO_KEY") {
          await platform().local.remove(STORE_KEY);
          return "invalidated";
        }
        throw e;
      }
      try {
        // Never unlock with something that isn't this wallet's seed (e.g. a leftover entry after a
        // reset and re-import): drop it and fall back to the password.
        if (!sameHex(seedCheck(seed), stored.check)) {
          await platform().local.remove(STORE_KEY);
          await Native.deleteKey().catch(() => {});
          return "invalidated";
        }
        await setUnlockedSeed(seed);
        return "unlocked";
      } finally {
        seed.fill(0);
      }
    },
  };
}
