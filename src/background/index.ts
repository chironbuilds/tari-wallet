import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy, validateMnemonic } from "../lib/mnemonic";
import { decryptVault, encryptVault } from "../lib/vault";
import {
  addConnectedSite,
  getConnectedSite,
  getState,
  removeAllConnectedSites,
  removeConnectedSite,
  setState,
  wipeWallet,
} from "../lib/storage";
import type {
  AccountsChangedBroadcast,
  PageRequestMessage,
  PageResponseMessage,
  PendingApprovalInput,
  PopupRequest,
  WalletStatus,
} from "../lib/messages";
import { clearAccountCache, getAccountByIndex, getActiveAccount } from "./accounts";
import { clearUnlockedSeed, getUnlockedSeed, isUnlocked, setUnlockedSeed } from "./session";
import { getPendingApproval, requestApproval, resolveApproval } from "./approvals";

// chrome.runtime.sendMessage serializes its payload as JSON, not a full structured clone — a
// BigInt anywhere in a response (transaction results, token amounts) makes the whole send fail
// with "could not serialize message" rather than a catchable per-field error. Deep-converting
// every BigInt to a string before handing a result to sendResponse() sidesteps that entirely; nothing
// downstream needs BigInt precision beyond display/round-tripping through a string.
function sanitizeForMessage(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sanitizeForMessage);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeForMessage(v)]));
  }
  return value;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.kind === "tari-page-request") {
    handlePageRequest(message as PageRequestMessage, sender)
      .then((result) =>
        sendResponse({ kind: "tari-page-response", id: message.id, result: sanitizeForMessage(result) } satisfies PageResponseMessage)
      )
      .catch((err) =>
        sendResponse({ kind: "tari-page-response", id: message.id, error: String(err?.message ?? err) } satisfies PageResponseMessage)
      );
    return true;
  }
  if (message && typeof message.kind === "string" && message.kind.startsWith("popup-")) {
    handlePopupRequest(message as PopupRequest)
      .then((result) => sendResponse({ ok: true, result: sanitizeForMessage(result) }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Page (dApp) requests, relayed by the content script
// ---------------------------------------------------------------------------

async function handlePageRequest(message: PageRequestMessage, _sender: chrome.runtime.MessageSender): Promise<unknown> {
  const { origin, method, params } = message;

  switch (method) {
    case "tari_getNetwork": {
      const { network } = await getState();
      return network;
    }

    case "tari_getAccounts": {
      const site = await getConnectedSite(origin);
      if (!site || !(await isUnlocked())) return [];
      const account = await getAccountByIndex(site.accountIndex);
      return account ? [await account.getComponentAddress()] : [];
    }

    case "tari_requestAccounts": {
      if (!(await getState()).vault) throw new Error("No wallet set up in the Tari extension yet.");
      const existing = await getConnectedSite(origin);
      if (existing && (await isUnlocked())) {
        const account = await getAccountByIndex(existing.accountIndex);
        if (account) return [await account.getComponentAddress()];
      }
      const approved = await requestApproval({ kind: "connect", origin });
      if (!approved) throw new Error("Connection request rejected.");
      // Unlocking (if needed) happens inside the approval popup before it resolves; by the time
      // we get here the wallet must be unlocked or the user closed the window without unlocking.
      if (!(await isUnlocked())) throw new Error("Wallet is locked.");
      const { activeAccountIndex } = await getState();
      await addConnectedSite(origin, activeAccountIndex);
      const account = await getAccountByIndex(activeAccountIndex);
      if (!account) throw new Error("Could not resolve account.");
      return [await account.getComponentAddress()];
    }

    case "tari_disconnect": {
      await removeConnectedSite(origin);
      return null;
    }

    case "tari_getBalances": {
      const site = await getConnectedSite(origin);
      if (!site || !(await isUnlocked())) return [];
      const account = await getAccountByIndex(site.accountIndex);
      return account ? account.getBalances() : [];
    }

    case "tari_getSubstate": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountByIndex(site.accountIndex);
      if (!account) throw new Error("Wallet is locked.");
      const p = params as { substateId: string; version?: number | null };
      const provider = await account.getProvider();
      return provider.getSubstate(p.substateId, p.version ?? null);
    }

    case "tari_signAndSubmitTransaction": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const p = params as {
        instructions: import("@tari-project/ootle-ts-bindings").Instruction[];
        maxFee?: string;
        dryRun?: boolean;
        inputs?: import("@tari-project/ootle-ts-bindings").SubstateRequirement[];
      };
      // Dry runs are read-only simulations (quotes, balance-adjacent lookups) — a DEX price quote
      // that reprices on every keystroke would otherwise pop an approval window per keystroke.
      // Only a real submission spends anything, so only that needs the user's sign-off.
      if (!p.dryRun) {
        const approval: PendingApprovalInput = { kind: "transaction", origin, instructions: p.instructions, maxFee: p.maxFee, dryRun: p.dryRun };
        const approved = await requestApproval(approval);
        if (!approved) throw new Error("Transaction rejected.");
      }
      if (!(await isUnlocked())) throw new Error("Wallet is locked.");
      const account = await getAccountByIndex(site.accountIndex);
      if (!account) throw new Error("Could not resolve account.");
      const maxFee = p.maxFee ? BigInt(p.maxFee) : undefined;
      const result = await account.execute(p.instructions, { maxFee, dryRun: p.dryRun, inputs: p.inputs });
      return result;
    }

    default:
      throw new Error(`Unknown method: ${method satisfies never}`);
  }
}

/**
 * Pushes a `tari-accounts-changed` message to every tab's content script (which forwards it into
 * the page as a `tari#accountsChanged` DOM event — see inject.ts). Broadcasts blind to every tab
 * rather than filtering by which origins were actually connected: reading a tab's URL to filter
 * would need either the `tabs` permission or a host-permission match, and a page that was never
 * connected simply has nothing listening for this event, so there's no harm in it arriving.
 */
async function broadcastAccountsChanged(accounts: string[]): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const message: AccountsChangedBroadcast = { kind: "tari-accounts-changed", accounts };
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    // Most tabs have no content script (chrome://, extension pages, other origins mid-navigation)
    // — sendMessage rejects with "Receiving end does not exist" for those, which is expected and
    // not worth surfacing.
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Popup requests
// ---------------------------------------------------------------------------

async function buildStatus(): Promise<WalletStatus> {
  const state = await getState();
  const unlocked = await isUnlocked();
  let address: string | null = null;
  let receiveAddress: string | null = null;
  if (unlocked) {
    const account = await getActiveAccount();
    if (account) {
      receiveAddress = await account.getWalletAddress();
      address = await account.getComponentAddress();
    }
  }
  return {
    hasWallet: state.vault !== null,
    isUnlocked: unlocked,
    network: state.network,
    activeAccountIndex: state.activeAccountIndex,
    accountCount: state.accountCount,
    address,
    receiveAddress,
  };
}

async function handlePopupRequest(message: PopupRequest): Promise<unknown> {
  switch (message.kind) {
    case "popup-get-status":
      return buildStatus();

    case "popup-create-wallet": {
      const mnemonic = generateMnemonic();
      const entropy = mnemonicToEntropy(mnemonic); // round-trip validates our own encoder
      const vault = await encryptVault(message.password, entropy);
      await setState({ vault, accountCount: 1, activeAccountIndex: 0 });
      await setUnlockedSeed(entropy);
      return { mnemonic };
    }

    case "popup-import-wallet": {
      if (!validateMnemonic(message.mnemonic)) throw new Error("Invalid recovery phrase.");
      const entropy = mnemonicToEntropy(message.mnemonic);
      const vault = await encryptVault(message.password, entropy);
      await setState({ vault, accountCount: 1, activeAccountIndex: 0 });
      await setUnlockedSeed(entropy);
      return {};
    }

    case "popup-unlock": {
      const { vault } = await getState();
      if (!vault) throw new Error("No wallet set up yet.");
      const entropy = await decryptVault(message.password, vault);
      await setUnlockedSeed(entropy);
      return {};
    }

    case "popup-lock": {
      await clearUnlockedSeed();
      clearAccountCache();
      return {};
    }

    case "popup-reveal-mnemonic": {
      const { vault } = await getState();
      if (!vault) throw new Error("No wallet set up yet.");
      const entropy = await decryptVault(message.password, vault);
      return { mnemonic: entropyToMnemonic(entropy) };
    }

    case "popup-get-balances": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      return account.getBalances();
    }

    case "popup-claim-testnet-xtr": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      return account.claimTestnetXtr();
    }

    case "popup-send": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      return account.send(message.toAddress, message.resourceAddress, BigInt(message.amount));
    }

    case "popup-add-account": {
      const state = await getState();
      const newIndex = state.accountCount;
      await setState({ accountCount: newIndex + 1, activeAccountIndex: newIndex });
      return { index: newIndex };
    }

    case "popup-set-active-account": {
      const { activeAccountIndex } = await getState();
      if (message.index !== activeAccountIndex) {
        // Every existing connection is pinned to whichever account was active when it was made
        // (see addConnectedSite) — switching accounts without dropping them would leave connected
        // sites silently reading/spending from the account the user just switched away from.
        await removeAllConnectedSites();
        await broadcastAccountsChanged([]);
      }
      await setState({ activeAccountIndex: message.index });
      return {};
    }

    case "popup-get-connected-sites": {
      const { connectedSites } = await getState();
      return connectedSites;
    }

    case "popup-disconnect-site": {
      await removeConnectedSite(message.origin);
      return {};
    }

    case "popup-get-pending-approval":
      return getPendingApproval(message.approvalId) ?? null;

    case "popup-resolve-approval":
      resolveApproval(message.approvalId, message.approve);
      return {};

    case "popup-reset-wallet": {
      await clearUnlockedSeed();
      clearAccountCache();
      await wipeWallet();
      return {};
    }

    default:
      throw new Error(`Unknown popup message: ${JSON.stringify(message)}`);
  }
}

// Reset in-memory session state whenever the browser (re)starts the service worker fresh — the
// session storage already handles this correctly on its own (it's cleared when the browser
// closes), this just ensures our per-worker caches don't outlive a stale seed.
chrome.runtime.onStartup.addListener(() => {
  clearAccountCache();
});
