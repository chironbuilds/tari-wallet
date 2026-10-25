// Holds the decrypted master seed while the wallet is unlocked. Manifest V3 service workers are
// ephemeral — the browser can kill and restart this script at any time between events — so a plain
// module-level variable would silently "re-lock" the wallet whenever that happens. `chrome.storage
// .session` is the platform's answer: in-memory only (never written to disk, cleared when the
// browser fully closes), but it survives service-worker restarts within a browsing session. This
// is the same pattern other MV3 wallet extensions use for exactly this reason.
const SEED_KEY = "unlockedSeedHex";
const ACTIVITY_KEY = "lastActivityMs";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function setUnlockedSeed(seed: Uint8Array): Promise<void> {
  await chrome.storage.session.set({ [SEED_KEY]: toHex(seed), [ACTIVITY_KEY]: Date.now() });
}

export async function getUnlockedSeed(): Promise<Uint8Array | null> {
  const { [SEED_KEY]: hex } = await chrome.storage.session.get(SEED_KEY);
  return typeof hex === "string" ? fromHex(hex) : null;
}

export async function clearUnlockedSeed(): Promise<void> {
  await chrome.storage.session.remove([SEED_KEY, ACTIVITY_KEY]);
}

// The recovery phrase of a wallet that was created but not yet verified, so a popup reopened on the
// phrase screen can show it again. Same lifetime as the unlocked seed (memory only, gone when the
// browser closes) and removed the moment the user passes the check.
const PENDING_MNEMONIC_KEY = "pendingMnemonic";

export async function setPendingMnemonic(mnemonic: string): Promise<void> {
  await chrome.storage.session.set({ [PENDING_MNEMONIC_KEY]: mnemonic });
}

export async function getPendingMnemonic(): Promise<string | null> {
  const { [PENDING_MNEMONIC_KEY]: m } = await chrome.storage.session.get(PENDING_MNEMONIC_KEY);
  return typeof m === "string" ? m : null;
}

export async function clearPendingMnemonic(): Promise<void> {
  await chrome.storage.session.remove(PENDING_MNEMONIC_KEY);
}

export async function isUnlocked(): Promise<boolean> {
  return (await getUnlockedSeed()) !== null;
}

/** Marks the wallet as just-used, resetting the auto-lock countdown. Call on every real request
 * handled while unlocked (see background/index.ts) — opening the popup, a dApp call, sending,
 * etc. all count as "in use." */
export async function touchActivity(): Promise<void> {
  await chrome.storage.session.set({ [ACTIVITY_KEY]: Date.now() });
}

/** Null if the wallet has never been unlocked this session. */
export async function getLastActivity(): Promise<number | null> {
  const { [ACTIVITY_KEY]: v } = await chrome.storage.session.get(ACTIVITY_KEY);
  return typeof v === "number" ? v : null;
}
