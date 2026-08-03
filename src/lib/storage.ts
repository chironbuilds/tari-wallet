// Thin wrapper around chrome.storage.local for everything the wallet persists between browser
// restarts. The encrypted vault blob and every daemon connection's API key are the sensitive
// pieces here — see vault.ts and secretAtRest.ts respectively for how each is protected;
// everything else in this file is plain metadata.
import type { EncryptedVault } from "./vault";
import type { EncryptedSecret } from "./secretAtRest";
import { DEFAULT_AUTO_LOCK_MINUTES } from "./autoLock";

export interface ConnectedSite {
  origin: string;
  /** Stable account id this site is bound to — see `localAccountId`/`daemonAccountId`. */
  accountId: string;
  connectedAt: number;
}

/**
 * A daemon this extension has connected to as a JRPC client — the "hardware wallet" analog of a
 * seed. Authenticated with a long-lived **API key** the user mints from the daemon's own web UI
 * (which has a real browser session there), not a session token this extension logs into itself —
 * confirmed with the tari-ootle maintainers that a `chrome-extension://` origin can't hold a
 * daemon browser session at all (session refresh needs an HttpOnly cookie this origin never gets;
 * WebAuthn's RP origin is locked to `http://localhost:{port}` regardless). See `DaemonAccount`.
 *
 * `encryptedApiKey` (not a plain `apiKey: string`) -- this key carries the daemon's `admin`
 * permission (see README "Daemon-relayed accounts"), the same severity of credential as the
 * wallet seed itself, so it gets the same "unreadable without the unlocked wallet" protection
 * via secretAtRest.ts rather than sitting in chrome.storage.local as plain text.
 */
export interface DaemonConnectionConfig {
  id: string;
  url: string;
  encryptedApiKey: EncryptedSecret;
  label: string;
}

/** One account on a connected daemon that the user has added to this wallet's account list. */
export interface DaemonAccountRef {
  connectionId: string;
  componentAddress: string;
  label: string;
}

/**
 * A saved recipient — either a `component_…` public address (for Send) or an `otl_…` bech32m
 * wallet address (for Send privately). Plain metadata, same sensitivity as a daemon connection's
 * `url`/`label` (not the encrypted API key) — addresses are public on-chain data regardless.
 */
export interface AddressBookEntry {
  id: string;
  label: string;
  address: string;
}

/**
 * A stealth (confidential) output this wallet created via a shield transfer, recorded so a
 * later unshield can find it — there is no way to scan/list stealth UTXOs by view key alone
 * (see confidential.ts / OotleAccount.shield()'s doc comment), so this local record is the
 * *only* lead back to the commitment once the shield transaction finalizes.
 *
 * `commitment` is public on-chain data (derivable from the resulting utxo_{resource}_{commitment}
 * substate id) — no more sensitive than a resource/vault address, so this is plain metadata, not
 * `secretAtRest.ts`-encrypted like the daemon API key or the seed.
 */
export interface ShieldedOutputRecord {
  accountId: string;
  resourceAddress: string;
  /** 32-byte Pedersen commitment, hex. */
  commitment: string;
  /** Raw, resource-native units (matches TokenBalance.amount's convention). */
  amount: string;
  transactionId: string;
  createdAt: number;
  /** Set true once this output has been spent via unshield. */
  spent: boolean;
  /** The output's plaintext memo, if any -- known directly for a self-created output (shield/
   * unshield already have it as a plain call argument), decrypted alongside the amount for a
   * claimed/scanned one (see `DecryptedData.memo` in confidential.ts's callers). Absent, not
   * empty-string, when the output genuinely carries no memo. */
  memo?: string;
}

/**
 * A shield or unshield submitted but not yet confirmed recorded in `shieldedOutputs` — carries
 * every field `recordShieldedOutput`/`markShieldedOutputSpent` need to complete the write on
 * recovery (see `OotleAccount.shield()`'s doc comment for why this exists: a killed service
 * worker between finalization and the storage write would otherwise strand the only lead to a
 * real commitment). A bare transaction-id list wouldn't be enough to recover from — the
 * account/resource/amount aren't otherwise recoverable from the id alone.
 */
export interface PendingShield {
  transactionId: string;
  accountId: string;
  resourceAddress: string;
  amount: string;
  /** Set for an unshield's or private send's pending entry: the now-spent commitments (a
   * multi-UTXO spend may consume several) to mark on recovery, once the new (change)
   * `ShieldedOutputRecord` above has been written. Absent for a plain shield. */
  spentCommitments?: string[];
  /**
   * This account's own new commitment, if this operation creates one — known locally (read from
   * the outputs statement built *before* submission, since a stealth output's commitment is
   * generated client-side during `prepare()`) rather than inferred after the fact by scanning
   * the finalized transaction's `up_substates`. Set for shield (the shielded amount itself),
   * unshield (the private remainder), and a private send that leaves change; absent for a
   * private send that spends an entire record with no change, where there is genuinely nothing
   * new to record for this account (its `up_substates` contains only the *recipient's* new
   * stealth output, which must never be attributed to us).
   */
  ownCommitment?: string;
  /** This account's own memo for the operation, if any -- see `ShieldedOutputRecord.memo`. Carried
   * through so a crash between finalization and the `ShieldedOutputRecord` write doesn't lose it. */
  memo?: string;
}

/**
 * A transaction this wallet itself submitted (or an inbound private payment it explicitly
 * claimed), recorded client-side for a local history view. Deliberately scoped: this only covers
 * actions taken *from this point forward* through this wallet, not a retroactive reconstruction
 * of on-chain history (the indexer's recent-transactions feed is global/paginated, not filterable
 * by address — see OotleAccount.scanForPrivatePayments()'s use of it for the one place this
 * codebase already walks that feed). `resourceAddress`/`amount`/`transactionId` are omitted where
 * genuinely not known or not meaningfully decodable — see the `dapp-transaction` kind, which
 * deliberately never decodes instruction args (same "never decode a Literal" policy as
 * instructionSummary.ts, used for the approval screen).
 */
export interface TransactionHistoryEntry {
  id: string;
  accountId: string;
  kind: "send" | "shield" | "unshield" | "send-privately" | "claim" | "private-payment-received" | "dapp-transaction";
  resourceAddress?: string;
  /** Raw, resource-native units (matches ShieldedOutputRecord.amount's convention). */
  amount?: string;
  /** Recipient/sender address for a send-like kind, or a structural summary label for
   * `dapp-transaction` (see instructionSummary.ts) — free-form, display-only. */
  counterparty?: string;
  /** The real on-chain transaction id, when known — omitted for kinds whose underlying SDK call
   * doesn't currently surface one to the caller (see wallet.ts's `execute()`, which discards it
   * after using it internally to poll for the result). */
  transactionId?: string;
  createdAt: number;
  status: "confirmed" | "failed";
  /** The plaintext memo attached to a shield/unshield/send-privately/private-payment-received
   * entry, if any -- see `ShieldedOutputRecord.memo`. */
  memo?: string;
}

const MAX_TRANSACTION_HISTORY_ENTRIES = 500;

export interface WalletState {
  vault: EncryptedVault | null;
  accountCount: number; // how many *local* (seed-derived) accounts have been derived/revealed
  /** Stable id of whichever account (local or daemon) is currently active — see
   * `localAccountId`/`daemonAccountId`/`parseAccountId`. */
  activeAccountId: string;
  network: "esmeralda" | "igor";
  connectedSites: ConnectedSite[];
  daemonConnections: DaemonConnectionConfig[];
  daemonAccounts: DaemonAccountRef[];
  /** Saved recipient addresses, shared across Send and Send-privately. */
  addressBook: AddressBookEntry[];
  /** Transactions this wallet has submitted/claimed, newest first, capped at
   * MAX_TRANSACTION_HISTORY_ENTRIES — see TransactionHistoryEntry's doc comment for scope. */
  transactionHistory: TransactionHistoryEntry[];
  /** Minutes of inactivity before the wallet auto-locks; 0 = never. See src/lib/autoLock.ts. */
  autoLockMinutes: number;
  /** Every stealth output this wallet has shielded, local-account only (see ShieldedOutputRecord). */
  shieldedOutputs: ShieldedOutputRecord[];
  /** Shields submitted but not yet confirmed written to `shieldedOutputs` — see PendingShield's
   * doc comment for why this recovery ledger exists. */
  pendingShields: PendingShield[];
  /** Per-account cursor for `OotleAccount.scanForPrivatePayments()` -- the newest transaction id
   * seen on the last scan, keyed by accountId. Lets a scan that runs opportunistically on every
   * `popup-get-status` only walk transactions newer than the last one it already looked at,
   * instead of re-scanning the indexer's whole recent-transactions feed every time. */
  privatePaymentScanCursors: Record<string, string>;
}

const DEFAULTS: WalletState = {
  vault: null,
  accountCount: 1,
  activeAccountId: "local:0",
  network: "esmeralda",
  connectedSites: [],
  daemonConnections: [],
  daemonAccounts: [],
  addressBook: [],
  transactionHistory: [],
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  shieldedOutputs: [],
  pendingShields: [],
  privatePaymentScanCursors: {},
};

export function localAccountId(index: number): string {
  return `local:${index}`;
}

export function daemonAccountId(connectionId: string, componentAddress: string): string {
  return `daemon:${connectionId}:${componentAddress}`;
}

export type AccountId = { type: "local"; index: number } | { type: "daemon"; connectionId: string; componentAddress: string };

export function parseAccountId(id: string): AccountId {
  if (id.startsWith("local:")) return { type: "local", index: Number(id.slice("local:".length)) };
  if (id.startsWith("daemon:")) {
    const rest = id.slice("daemon:".length);
    const sep = rest.indexOf(":");
    return { type: "daemon", connectionId: rest.slice(0, sep), componentAddress: rest.slice(sep + 1) };
  }
  throw new Error(`Malformed account id: ${id}`);
}

export async function getState(): Promise<WalletState> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored } as WalletState;
}

export async function setState(patch: Partial<WalletState>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export async function hasWallet(): Promise<boolean> {
  const { vault } = await getState();
  return vault !== null;
}

export async function getConnectedSite(origin: string): Promise<ConnectedSite | undefined> {
  const { connectedSites } = await getState();
  return connectedSites.find((s) => s.origin === origin);
}

export async function addConnectedSite(origin: string, accountId: string): Promise<void> {
  const state = await getState();
  const withoutExisting = state.connectedSites.filter((s) => s.origin !== origin);
  await setState({
    connectedSites: [...withoutExisting, { origin, accountId, connectedAt: Date.now() }],
  });
}

export async function removeConnectedSite(origin: string): Promise<void> {
  const state = await getState();
  await setState({ connectedSites: state.connectedSites.filter((s) => s.origin !== origin) });
}

/** Disconnects every connected site. Each connection is pinned to the account id active at the
 * time it was made (see `addConnectedSite`), so switching accounts without this would leave sites
 * silently talking to the account the user just switched away from — clearing them forces every
 * site to reconnect via `tari_requestAccounts`, which then binds to the newly active account. */
export async function removeAllConnectedSites(): Promise<void> {
  await setState({ connectedSites: [] });
}

export async function addDaemonConnection(config: DaemonConnectionConfig): Promise<void> {
  const state = await getState();
  await setState({ daemonConnections: [...state.daemonConnections, config] });
}

export async function removeDaemonConnection(id: string): Promise<void> {
  const state = await getState();
  await setState({
    daemonConnections: state.daemonConnections.filter((c) => c.id !== id),
    daemonAccounts: state.daemonAccounts.filter((a) => a.connectionId !== id),
  });
}

export async function addDaemonAccount(ref: DaemonAccountRef): Promise<void> {
  const state = await getState();
  const withoutExisting = state.daemonAccounts.filter(
    (a) => !(a.connectionId === ref.connectionId && a.componentAddress === ref.componentAddress)
  );
  await setState({ daemonAccounts: [...withoutExisting, ref] });
}

export async function removeDaemonAccount(connectionId: string, componentAddress: string): Promise<void> {
  const state = await getState();
  await setState({
    daemonAccounts: state.daemonAccounts.filter((a) => !(a.connectionId === connectionId && a.componentAddress === componentAddress)),
  });
}

export async function addAddressBookEntry(entry: AddressBookEntry): Promise<void> {
  const state = await getState();
  await setState({ addressBook: [...state.addressBook, entry] });
}

export async function removeAddressBookEntry(id: string): Promise<void> {
  const state = await getState();
  await setState({ addressBook: state.addressBook.filter((e) => e.id !== id) });
}

/** Newest-first; entries beyond MAX_TRANSACTION_HISTORY_ENTRIES are dropped (oldest first). */
export async function addTransactionHistoryEntry(entry: TransactionHistoryEntry): Promise<void> {
  const state = await getState();
  await setState({ transactionHistory: [entry, ...state.transactionHistory].slice(0, MAX_TRANSACTION_HISTORY_ENTRIES) });
}

export async function listTransactionHistory(accountId: string): Promise<TransactionHistoryEntry[]> {
  const { transactionHistory } = await getState();
  return transactionHistory.filter((e) => e.accountId === accountId);
}

export async function wipeWallet(): Promise<void> {
  await chrome.storage.local.clear();
}

export async function listShieldedOutputs(accountId: string): Promise<ShieldedOutputRecord[]> {
  const { shieldedOutputs } = await getState();
  return shieldedOutputs.filter((r) => r.accountId === accountId);
}

export async function addShieldedOutput(record: ShieldedOutputRecord): Promise<void> {
  const state = await getState();
  await setState({ shieldedOutputs: [...state.shieldedOutputs, record] });
}

export async function markShieldedOutputSpent(accountId: string, commitment: string): Promise<void> {
  const state = await getState();
  await setState({
    shieldedOutputs: state.shieldedOutputs.map((r) => (r.accountId === accountId && r.commitment === commitment ? { ...r, spent: true } : r)),
  });
}

export async function listPendingShields(): Promise<PendingShield[]> {
  const { pendingShields } = await getState();
  return pendingShields;
}

export async function addPendingShield(pending: PendingShield): Promise<void> {
  const state = await getState();
  if (state.pendingShields.some((p) => p.transactionId === pending.transactionId)) return;
  await setState({ pendingShields: [...state.pendingShields, pending] });
}

export async function removePendingShield(transactionId: string): Promise<void> {
  const state = await getState();
  await setState({ pendingShields: state.pendingShields.filter((p) => p.transactionId !== transactionId) });
}

export async function getPrivatePaymentScanCursor(accountId: string): Promise<string | null> {
  const { privatePaymentScanCursors } = await getState();
  return privatePaymentScanCursors[accountId] ?? null;
}

export async function setPrivatePaymentScanCursor(accountId: string, transactionId: string): Promise<void> {
  const state = await getState();
  await setState({ privatePaymentScanCursors: { ...state.privatePaymentScanCursors, [accountId]: transactionId } });
}
