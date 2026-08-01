// Shared message shapes for the three extension contexts:
//   injected page script <-> content script <-> background service worker
// and separately: popup UI <-> background service worker.
import type { Instruction, SubstateRequirement } from "@tari-project/ootle-ts-bindings";

// ---- Page (window.tari) <-> content script <-> background ----

export type ProviderMethod =
  | "tari_requestAccounts"
  | "tari_getAccounts"
  | "tari_getNetwork"
  | "tari_getBalances"
  | "tari_getSubstate"
  | "tari_signAndSubmitTransaction"
  | "tari_disconnect";

export interface ProviderRequestParams {
  tari_requestAccounts: undefined;
  tari_getAccounts: undefined;
  tari_getNetwork: undefined;
  tari_getBalances: undefined;
  // Read-only substate lookup (e.g. a resource's on-chain `divisibility`) — general-purpose, not
  // tied to the connected account, so a dApp can look up any address it already knows.
  tari_getSubstate: { substateId: string; version?: number | null };
  // `inputs` lets a dApp pin substates it already knows are needed (e.g. a component it just read
  // and knows the address of); the wallet's own auto-resolve retry (see OotleAccount.execute())
  // handles whatever's still missing, so this is an optimization, never required for correctness.
  tari_signAndSubmitTransaction: { instructions: Instruction[]; maxFee?: string; dryRun?: boolean; inputs?: SubstateRequirement[] };
  tari_disconnect: undefined;
}

/** Sent from the content script to the background, tagged with the requesting page's origin. */
export interface PageRequestMessage {
  kind: "tari-page-request";
  origin: string;
  id: string;
  method: ProviderMethod;
  params: unknown;
}

export interface PageResponseMessage {
  kind: "tari-page-response";
  id: string;
  result?: unknown;
  error?: string;
}

/**
 * Unsolicited push from the background to every tab's content script, forwarded into the page as
 * a `tari#accountsChanged` DOM event (see inject.ts) — mirrors EIP-1193's `accountsChanged`.
 * Fired with an empty `accounts` array when the user switches the wallet's active account, since
 * every existing connection gets dropped at the same time (see `removeAllConnectedSites` in
 * storage.ts) and the page needs to know its previously-authorized account is no longer valid
 * without waiting for its next request to fail.
 */
export interface AccountsChangedBroadcast {
  kind: "tari-accounts-changed";
  accounts: string[];
}

// ---- Popup <-> background ----

export type PopupRequest =
  | { kind: "popup-get-status" }
  | { kind: "popup-create-wallet"; password: string }
  | { kind: "popup-import-wallet"; password: string; mnemonic: string }
  | { kind: "popup-unlock"; password: string }
  | { kind: "popup-lock" }
  | { kind: "popup-reveal-mnemonic"; password: string }
  | { kind: "popup-get-balances" }
  | { kind: "popup-claim-testnet-xtr" }
  | { kind: "popup-send"; toAddress: string; resourceAddress: string; amount: string }
  | { kind: "popup-shield"; resourceAddress: string; amount: string; maxFee?: string; memo?: string }
  | { kind: "popup-unshield"; resourceAddress: string; revealedAmount: string; maxFee?: string; memo?: string }
  | {
      kind: "popup-send-privately";
      resourceAddress: string;
      recipientWalletAddress: string;
      amount: string;
      maxFee?: string;
      memo?: string;
    }
  | { kind: "popup-claim-private-payment"; resourceAddress: string; commitment: string }
  | { kind: "popup-add-account" }
  | { kind: "popup-set-active-account"; accountId: string }
  | { kind: "popup-get-connected-sites" }
  | { kind: "popup-disconnect-site"; origin: string }
  | { kind: "popup-get-pending-approval"; approvalId: string }
  | { kind: "popup-resolve-approval"; approvalId: string; approve: boolean }
  | { kind: "popup-reset-wallet" }
  | { kind: "popup-connect-daemon"; url: string; apiKey: string; label: string }
  | { kind: "popup-list-daemon-accounts"; connectionId: string }
  | { kind: "popup-add-daemon-accounts"; connectionId: string; accounts: { componentAddress: string; label: string }[] }
  | { kind: "popup-remove-daemon-connection"; connectionId: string }
  | { kind: "popup-remove-daemon-account"; connectionId: string; componentAddress: string }
  | { kind: "popup-set-auto-lock-minutes"; minutes: number }
  | { kind: "popup-add-address-book-entry"; label: string; address: string }
  | { kind: "popup-remove-address-book-entry"; id: string }
  | { kind: "popup-set-network"; network: "esmeralda" | "igor" }
  | { kind: "popup-get-transaction-history" };

export interface AccountSummary {
  id: string;
  label: string;
  kind: "local" | "daemon";
}

export interface WalletStatus {
  hasWallet: boolean;
  isUnlocked: boolean;
  network: "esmeralda" | "igor";
  activeAccountId: string;
  accountCount: number;
  address: string | null;
  receiveAddress: string | null;
  /** Set when resolving the active account failed (e.g. a daemon-relayed account whose daemon is
   * unreachable) — `address`/`receiveAddress` are null in that case, but the rest of the status
   * (account list, network, etc.) is still valid, so the popup can render enough UI to let the
   * user switch to a working account instead of being stuck on a blank error screen. */
  activeAccountError: string | null;
  accounts: AccountSummary[];
  daemonConnections: { id: string; url: string; label: string }[];
  addressBook: { id: string; label: string; address: string }[];
  autoLockMinutes: number;
}

/** Mirrors storage.ts's `TransactionHistoryEntry` — see its doc comment for scope. Declared
 * separately here rather than imported, matching how `WalletStatus`'s other storage-backed fields
 * (e.g. `daemonConnections`) are their own popup-facing shapes, not direct storage.ts imports. */
export interface TransactionHistoryEntry {
  id: string;
  accountId: string;
  kind: "send" | "shield" | "unshield" | "send-privately" | "claim" | "private-payment-received" | "dapp-transaction";
  resourceAddress?: string;
  amount?: string;
  counterparty?: string;
  transactionId?: string;
  createdAt: number;
  status: "confirmed" | "failed";
}

/** One account as reported by a wallet daemon's `accounts.list`/`accounts.get` JRPC, surfaced to
 * the popup so the user can pick which ones to add — the "select accounts to import" step of the
 * hardware-wallet-style connect flow. */
export interface DaemonAccountOption {
  componentAddress: string;
  label: string;
}

// ---- Approval requests (background holds these; popup renders + resolves them) ----

export type PendingApproval =
  | { kind: "connect"; id: string; origin: string }
  | { kind: "transaction"; id: string; origin: string; instructions: Instruction[]; maxFee?: string; dryRun?: boolean };

// `Omit<PendingApproval, "id">` does not distribute over the union the way you'd want (it loses
// the discriminant), so this is spelled out by hand for requestApproval()'s input.
export type PendingApprovalInput =
  | { kind: "connect"; origin: string }
  | { kind: "transaction"; origin: string; instructions: Instruction[]; maxFee?: string; dryRun?: boolean };
