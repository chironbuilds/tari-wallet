// Holds the decrypted master seed while the wallet is unlocked. Manifest V3 service workers are
// ephemeral — the browser can kill and restart this script at any time between events — so a plain
// module-level variable would silently "re-lock" the wallet whenever that happens. `chrome.storage
// .session` is the platform's answer: in-memory only (never written to disk, cleared when the
// browser fully closes), but it survives service-worker restarts within a browsing session. This
// is the same pattern other MV3 wallet extensions use for exactly this reason.
const SEED_KEY = "unlockedSeedHex";

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
  await chrome.storage.session.set({ [SEED_KEY]: toHex(seed) });
}

export async function getUnlockedSeed(): Promise<Uint8Array | null> {
  const { [SEED_KEY]: hex } = await chrome.storage.session.get(SEED_KEY);
  return typeof hex === "string" ? fromHex(hex) : null;
}

export async function clearUnlockedSeed(): Promise<void> {
  await chrome.storage.session.remove(SEED_KEY);
}

export async function isUnlocked(): Promise<boolean> {
  return (await getUnlockedSeed()) !== null;
}
