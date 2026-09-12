// One-time move of this extension's own pre-SDK Ootle storage (four top-level chrome.storage.local
// keys written directly by the old, now-deleted src/lib/wallet.ts and src/lib/storage.ts) into
// @chironbuilder/ootle-sdk's own storage shape. Without this, an existing install upgrading to the
// SDK would see its shielded-output ledger, in-flight shields, private-payment scan cursor, and
// substate-version cache all silently reset -- for the shielded ledger specifically that's not
// cosmetic: it's this wallet's only lead back to funds it has shielded (see the SDK's
// ShieldedOutputRecord doc comment), so losing it needs a rescan to even notice the funds again.
//
// Idempotent and safe to run on every service-worker cold start (MV3 tears these down and restarts
// them often): guarded by its own marker key, and a fresh/already-migrated install just no-ops.
import { addPendingShield, addShieldedOutput, setKnownVersions, setPrivatePaymentScanCursor } from "@chironbuilder/ootle-sdk";
import type { PendingShield, ShieldedOutputRecord } from "@chironbuilder/ootle-sdk";

const MIGRATION_DONE_KEY = "ootleSdkStorageMigrationDone";
const OLD_KEYS = ["shieldedOutputs", "pendingShields", "privatePaymentScanCursors", "knownSubstateVersions"] as const;

export async function migrateOotleStorageOnce(): Promise<void> {
  const { [MIGRATION_DONE_KEY]: done } = await chrome.storage.local.get(MIGRATION_DONE_KEY);
  if (done) return;

  const old = await chrome.storage.local.get([...OLD_KEYS]);
  const shieldedOutputs = (old.shieldedOutputs ?? []) as ShieldedOutputRecord[];
  const pendingShields = (old.pendingShields ?? []) as PendingShield[];
  const privatePaymentScanCursors = (old.privatePaymentScanCursors ?? {}) as Record<string, string>;
  const knownVersions = (old.knownSubstateVersions ?? {}) as Record<string, number>;

  for (const record of shieldedOutputs) await addShieldedOutput(record);
  for (const pending of pendingShields) await addPendingShield(pending);
  for (const [accountId, transactionId] of Object.entries(privatePaymentScanCursors)) {
    await setPrivatePaymentScanCursor(accountId, transactionId);
  }
  if (Object.keys(knownVersions).length > 0) await setKnownVersions(knownVersions);

  // Deliberately not removing the old keys -- they're dead weight once migrated, not a correctness
  // risk, and leaving them is one less way this migration could ever destroy data it hasn't first
  // proven it copied successfully.
  await chrome.storage.local.set({ [MIGRATION_DONE_KEY]: true });
}
