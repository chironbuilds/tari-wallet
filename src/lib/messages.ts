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
  | { kind: "popup-add-account" }
  | { kind: "popup-set-active-account"; index: number }
  | { kind: "popup-get-connected-sites" }
  | { kind: "popup-disconnect-site"; origin: string }
  | { kind: "popup-get-pending-approval"; approvalId: string }
  | { kind: "popup-resolve-approval"; approvalId: string; approve: boolean }
  | { kind: "popup-reset-wallet" };

export interface WalletStatus {
  hasWallet: boolean;
  isUnlocked: boolean;
  network: "esmeralda" | "igor";
  activeAccountIndex: number;
  accountCount: number;
  address: string | null;
  receiveAddress: string | null;
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
