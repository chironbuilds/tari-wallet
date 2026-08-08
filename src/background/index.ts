import { createWalletSeed, deserializeSeed, importWalletSeed, seedToMnemonic, serializeSeed } from "../lib/cipherSeed";
import { decryptVault, encryptVault } from "../lib/vault";
import {
  addAddressBookEntry,
  addConnectedSite,
  addDaemonAccount,
  addDaemonConnection,
  addTransactionHistoryEntry,
  daemonAccountId,
  getConnectedSite,
  getState,
  listTransactionHistory,
  localAccountId,
  removeAddressBookEntry,
  removeAllConnectedSites,
  removeConnectedSite,
  removeDaemonAccount,
  removeDaemonConnection,
  setState,
  type TransactionHistoryEntry,
  wipeWallet,
} from "../lib/storage";
import { summarizeInstruction } from "../lib/instructionSummary";
import type {
  AccountSummary,
  AccountsChangedBroadcast,
  DaemonAccountOption,
  PageRequestMessage,
  PageResponseMessage,
  PendingApprovalInput,
  PopupRequest,
  WalletStatus,
} from "../lib/messages";
import { isStealthTransferInstruction } from "@tari-project/ootle";
import { componentAddressFromWalletAddress } from "../lib/componentAddress";
import { DaemonAccount } from "../lib/daemonAccount";
import { OotleAccount, recoverPendingShields } from "../lib/wallet";
import { clearAccountCache, getAccountById, getActiveAccount, getDaemonClient } from "./accounts";
import { clearUnlockedSeed, getLastActivity, getUnlockedSeed, isUnlocked, setUnlockedSeed, touchActivity } from "./session";
import { getPendingApproval, requestApproval, resolveApproval } from "./approvals";
import { shouldAutoLock } from "../lib/autoLock";
import { encryptSecret } from "../lib/secretAtRest";

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
      .catch((err) => {
        console.error(`[popup-request:${message.kind}]`, err); // TEMP diagnostic -- see wallet.ts shield() debugging
        sendResponse({ ok: false, error: String(err?.message ?? err) });
      });
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Page (dApp) requests, relayed by the content script
// ---------------------------------------------------------------------------

async function handlePageRequest(message: PageRequestMessage, _sender: chrome.runtime.MessageSender): Promise<unknown> {
  const { origin, method, params } = message;
  await touchActivity();

  switch (method) {
    case "tari_getNetwork": {
      const { network } = await getState();
      return network;
    }

    case "tari_getAccounts": {
      const site = await getConnectedSite(origin);
      if (!site || !(await isUnlocked())) return [];
      const account = await getAccountById(site.accountId);
      return account ? [await account.getComponentAddress()] : [];
    }

    case "tari_requestAccounts": {
      if (!(await getState()).vault) throw new Error("No wallet set up in the Tari extension yet.");
      const existing = await getConnectedSite(origin);
      if (existing && (await isUnlocked())) {
        const account = await getAccountById(existing.accountId);
        if (account) return [await account.getComponentAddress()];
      }
      const approved = await requestApproval({ kind: "connect", origin });
      if (!approved) throw new Error("Connection request rejected.");
      // Unlocking (if needed) happens inside the approval popup before it resolves; by the time
      // we get here the wallet must be unlocked or the user closed the window without unlocking.
      if (!(await isUnlocked())) throw new Error("Wallet is locked.");
      const { activeAccountId } = await getState();
      await addConnectedSite(origin, activeAccountId);
      const account = await getAccountById(activeAccountId);
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
      const account = await getAccountById(site.accountId);
      return account ? account.getBalances() : [];
    }

    case "tari_getSubstate": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
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
      // account.execute() only builds/signs/seals via TransactionBuilder -- it never runs
      // WalletStealthAuthorizer, so it can't produce the balance proof or per-input one-time
      // authorizations a real StealthTransfer instruction needs. The engine would reject an
      // incomplete statement anyway (no fund-loss risk), but failing fast with a clear message
      // beats a confusing late rejection, and skips popping an approval window for a tx that
      // can never succeed via this path.
      if (p.instructions.some(isStealthTransferInstruction)) {
        throw new Error("Stealth transfers aren't supported via a connected app yet — use the wallet's own Shield/Unshield screens.");
      }
      // Dry runs are read-only simulations (quotes, balance-adjacent lookups) — a DEX price quote
      // that reprices on every keystroke would otherwise pop an approval window per keystroke.
      // Only a real submission spends anything, so only that needs the user's sign-off.
      if (!p.dryRun) {
        const approval: PendingApprovalInput = {
          kind: "transaction",
          origin,
          instructions: p.instructions,
          maxFee: p.maxFee,
          dryRun: p.dryRun,
          accountId: site.accountId,
        };
        const approved = await requestApproval(approval);
        if (!approved) throw new Error("Transaction rejected.");
      }
      if (!(await isUnlocked())) throw new Error("Wallet is locked.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Could not resolve account.");
      const maxFee = p.maxFee ? BigInt(p.maxFee) : undefined;
      const doExecute = () => account.execute(p.instructions, { maxFee, dryRun: p.dryRun, inputs: p.inputs });
      // A dry run spends nothing and never reaches the network's mempool -- recording it as a
      // "transaction" would be misleading (see instructionSummary.ts's "never decode a Literal"
      // policy for why the label below is structural only, not amounts).
      if (p.dryRun) return doExecute();
      const summary = p.instructions.map((i) => summarizeInstruction(i).title).join(", ");
      return withHistory({ accountId: site.accountId, kind: "dapp-transaction", counterparty: `${origin}: ${summary}` }, doExecute);
    }

    // The only way for a connected dApp to move Stealth-typed funds (e.g. XTR) into its own
    // contract call — `tari_signAndSubmitTransaction`'s `account.execute()` cannot: a plain
    // `CallMethod withdraw` on a Stealth vault is not a standalone-valid instruction (confirmed:
    // fails client-side with a generic `TransactionInput` deserialization error, even alone with
    // no other instructions). See `OotleAccount.withdrawStealthAndExecute`'s own doc comment for
    // the full story.
    case "tari_withdrawStealthAndExecute": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const p = params as {
        resourceAddress: string;
        amount: string;
        workspaceVarName: string;
        followUpInstructions: import("@tari-project/ootle-ts-bindings").Instruction[];
        relatedComponents?: string[];
        maxFee?: string;
      };
      const amount = BigInt(p.amount);
      const note = `Reveals ${amount.toString()} of ${p.resourceAddress} for use in this transaction.`;
      const approval: PendingApprovalInput = {
        kind: "transaction",
        origin,
        instructions: p.followUpInstructions,
        maxFee: p.maxFee,
        note,
        accountId: site.accountId,
      };
      const approved = await requestApproval(approval);
      if (!approved) throw new Error("Transaction rejected.");
      if (!(await isUnlocked())) throw new Error("Wallet is locked.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Could not resolve account.");
      // Needs this account's own view secret + one-time stealth signing (SecretKeyWallet), same
      // as shield()/unshield() — a daemon-relayed account can't provide either (see
      // WalletDaemonSigner's own doc comment). Not on WalletAccountApi at all, matching how
      // shield/unshield are handled in the popup-shield/popup-unshield cases above.
      if (!(account instanceof OotleAccount)) {
        throw new Error("Withdrawing stealth funds isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const maxFee = p.maxFee ? BigInt(p.maxFee) : undefined;
      const summary = p.followUpInstructions.map((i) => summarizeInstruction(i).title).join(", ");
      return withHistory(
        { accountId: site.accountId, kind: "dapp-transaction", counterparty: `${origin}: reveal + ${summary}` },
        () =>
          account.withdrawStealthAndExecute(
            p.resourceAddress,
            amount,
            p.workspaceVarName,
            p.followUpInstructions,
            p.relatedComponents ?? [],
            maxFee
          )
      );
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
  let activeAccountError: string | null = null;
  let lastKnownAddress = state.lastKnownAddress;
  if (unlocked) {
    // A daemon-relayed active account can throw here (the daemon is off, unreachable, etc.) — that
    // must not take down the whole status fetch, or the popup can't even render enough UI (the
    // account switcher included) to let the user switch away from the broken account.
    try {
      const account = await getActiveAccount();
      if (account) {
        receiveAddress = await account.getWalletAddress();
        address = await account.getComponentAddress();
        // Cache for the lock screen's identicon (see WalletState.lastKnownAddress's doc comment)
        // -- only a write when it actually changed, so this doesn't touch storage on every popup
        // open for the common case of reopening the same already-unlocked account.
        if (address !== lastKnownAddress) {
          lastKnownAddress = address;
          await setState({ lastKnownAddress: address });
        }
        // Best-effort reconciliation of any shield that finalized on-chain but never got its
        // ShieldedOutputRecord written (service worker killed mid-flight — see
        // OotleAccount.shield()'s doc comment). Any local account's provider works here: a
        // transaction result lookup isn't account-scoped, so this recovers pending shields from
        // every local account, not just the currently active one. Silently skipped if the
        // active account happens to be daemon-connected this round — it'll get another chance
        // once a local account is active again; this is a safety net, not the primary write path
        // (shield() already writes the record itself right after polling, in the same call).
        if (account instanceof OotleAccount) {
          try {
            await recoverPendingShields(await account.getProvider());
          } catch {
            // Don't let a recovery hiccup (indexer down, etc.) break the whole status fetch.
          }
          // Best-effort, incremental scan for incoming private payments this account can decrypt
          // with its own view key -- see OotleAccount.scanForPrivatePayments()'s doc comment. Runs
          // on every status fetch (i.e. every popup open) rather than needing the recipient to be
          // told a commitment out of band first. Anything found also gets a History entry -- without
          // this, an auto-discovered payment would silently join the private balance with no visible
          // record it ever arrived.
          try {
            const { found } = await account.scanForPrivatePayments();
            await recordPrivatePaymentHistory(state.activeAccountId, found);
          } catch {
            // Don't let a scan hiccup (indexer down, etc.) break the whole status fetch.
          }
        }
      }
    } catch (e) {
      activeAccountError = e instanceof Error ? e.message : String(e);
    }
  }
  // A local account's component address is pure client-side crypto derivation (seed -> public key
  // -> hash, see OotleAccount.getComponentAddress()) -- no network call, safe to compute for every
  // account on every status fetch. Only null while locked (getAccountById already returns null
  // then, via resolveAccountId's unlocked-seed gate -- no separate check needed here).
  const localAccounts: AccountSummary[] = await Promise.all(
    Array.from({ length: state.accountCount }, async (_, i) => {
      const id = localAccountId(i);
      const account = await getAccountById(id);
      return { id, label: `Account ${i + 1}`, kind: "local" as const, address: account ? await account.getComponentAddress() : null };
    })
  );
  const daemonAccounts: AccountSummary[] = state.daemonAccounts.map((a) => ({
    id: daemonAccountId(a.connectionId, a.componentAddress),
    label: a.label,
    kind: "daemon",
    address: a.componentAddress,
  }));
  return {
    hasWallet: state.vault !== null,
    isUnlocked: unlocked,
    network: state.network,
    activeAccountId: state.activeAccountId,
    accountCount: state.accountCount,
    address,
    receiveAddress,
    lastKnownAddress,
    activeAccountError,
    accounts: [...localAccounts, ...daemonAccounts],
    daemonConnections: state.daemonConnections.map((c) => ({ id: c.id, url: c.url, label: c.label })),
    addressBook: state.addressBook,
    autoLockMinutes: state.autoLockMinutes,
  };
}

/**
 * Wraps a transaction-submitting call with client-side history recording (see
 * TransactionHistoryEntry's doc comment for scope) — records "confirmed" if `action` resolves,
 * "failed" if it rejects, then re-throws so the caller's own error handling is unaffected either
 * way. A recording hiccup itself is swallowed (best-effort only), the same "don't let a recording
 * hiccup break the real flow" policy buildStatus() already applies to recoverPendingShields()/
 * scanForPrivatePayments().
 */
async function withHistory<T>(
  base: Omit<TransactionHistoryEntry, "id" | "createdAt" | "status">,
  action: () => Promise<T>,
  // Fields only knowable from the action's resolved result (e.g. claimPrivatePayment()'s
  // decrypted memo) -- merged into the "confirmed" record only, since there's no result to derive
  // them from on failure.
  deriveOnSuccess?: (result: T) => Partial<Omit<TransactionHistoryEntry, "id" | "createdAt" | "status">>
): Promise<T> {
  const record = async (status: TransactionHistoryEntry["status"], extra?: Partial<TransactionHistoryEntry>) => {
    try {
      await addTransactionHistoryEntry({ ...base, ...extra, status, id: crypto.randomUUID(), createdAt: Date.now() });
    } catch {
      // Best-effort -- see doc comment above.
    }
  };
  try {
    const result = await action();
    await record("confirmed", deriveOnSuccess?.(result));
    return result;
  } catch (e) {
    await record("failed");
    throw e;
  }
}

/**
 * Records a `"private-payment-received"` history entry for each output `scanForPrivatePayments()`
 * newly discovered -- shared by `buildStatus()`'s opportunistic auto-scan and the manual
 * `popup-rescan-private-payments` handler so a payment found either way shows up in History, not
 * just in the private balance. Best-effort per entry, matching `withHistory`'s own policy: one bad
 * write must not lose the rest.
 */
async function recordPrivatePaymentHistory(accountId: string, found: { resourceAddress: string; amount: bigint; transactionId: string; memo?: string }[]) {
  for (const output of found) {
    try {
      await addTransactionHistoryEntry({
        accountId,
        kind: "private-payment-received",
        resourceAddress: output.resourceAddress,
        amount: output.amount.toString(),
        transactionId: output.transactionId,
        memo: output.memo,
        status: "confirmed",
        id: crypto.randomUUID(),
        createdAt: Date.now(),
      });
    } catch {
      // Best-effort -- see doc comment above.
    }
  }
}

async function handlePopupRequest(message: PopupRequest): Promise<unknown> {
  await touchActivity();
  switch (message.kind) {
    case "popup-get-status":
      return buildStatus();

    case "popup-create-wallet": {
      const { seed, mnemonic } = await createWalletSeed();
      const vault = await encryptVault(message.password, serializeSeed(seed));
      await setState({ vault, accountCount: 1, activeAccountId: localAccountId(0) });
      await setUnlockedSeed(seed.entropy);
      return { mnemonic };
    }

    case "popup-import-wallet": {
      const seed = await importWalletSeed(message.mnemonic);
      const vault = await encryptVault(message.password, serializeSeed(seed));
      await setState({ vault, accountCount: 1, activeAccountId: localAccountId(0) });
      await setUnlockedSeed(seed.entropy);
      return {};
    }

    case "popup-unlock": {
      const { vault } = await getState();
      if (!vault) throw new Error("No wallet set up yet.");
      const seed = deserializeSeed(await decryptVault(message.password, vault));
      await setUnlockedSeed(seed.entropy);
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
      const seed = deserializeSeed(await decryptVault(message.password, vault));
      return { mnemonic: await seedToMnemonic(seed) };
    }

    case "popup-get-balances": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      return account.getBalances();
    }

    case "popup-claim-testnet-xtr": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      const { activeAccountId } = await getState();
      return withHistory({ accountId: activeAccountId, kind: "claim" }, () => account.claimTestnetXtr());
    }

    case "popup-send": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      const { activeAccountId } = await getState();
      // The recipient only ever hands out their one main "otl_..." wallet address -- their
      // on-chain account component address is deterministically derivable from it (both identify
      // the same account), so there's no need to separately ask them for a component_... address.
      const toAddress = componentAddressFromWalletAddress(message.recipientWalletAddress);
      return withHistory(
        {
          accountId: activeAccountId,
          kind: "send",
          resourceAddress: message.resourceAddress,
          amount: message.amount,
          counterparty: message.recipientWalletAddress,
        },
        () => account.send(toAddress, message.resourceAddress, BigInt(message.amount))
      );
    }

    case "popup-shield": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      // Shield/unshield needs this account's own view secret and one-time stealth signing
      // (SecretKeyWallet), neither of which a daemon-relayed account can provide -- the daemon
      // never exports its view secret to clients (see WalletDaemonSigner's own doc comment).
      // Not on WalletAccountApi at all (unlike claimTestnetXtr, which DaemonAccount genuinely
      // can do via a different RPC) -- this is a real capability gap, not just an unwired one.
      if (!(account instanceof OotleAccount)) {
        throw new Error("Shielding isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const maxFee = message.maxFee ? BigInt(message.maxFee) : undefined;
      const { activeAccountId } = await getState();
      return withHistory(
        { accountId: activeAccountId, kind: "shield", resourceAddress: message.resourceAddress, amount: message.amount, memo: message.memo },
        () => account.shield(message.resourceAddress, BigInt(message.amount), maxFee, message.memo)
      );
    }

    case "popup-unshield": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      if (!(account instanceof OotleAccount)) {
        throw new Error("Unshielding isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const maxFee = message.maxFee ? BigInt(message.maxFee) : undefined;
      const { activeAccountId } = await getState();
      return withHistory(
        { accountId: activeAccountId, kind: "unshield", resourceAddress: message.resourceAddress, amount: message.revealedAmount, memo: message.memo },
        () => account.unshield(message.resourceAddress, BigInt(message.revealedAmount), maxFee, message.memo)
      );
    }

    case "popup-send-privately": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      if (!(account instanceof OotleAccount)) {
        throw new Error("Sending privately isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const maxFee = message.maxFee ? BigInt(message.maxFee) : undefined;
      const { activeAccountId } = await getState();
      return withHistory(
        {
          accountId: activeAccountId,
          kind: "send-privately",
          resourceAddress: message.resourceAddress,
          amount: message.amount,
          counterparty: message.recipientWalletAddress,
          memo: message.memo,
        },
        () => account.sendPrivately(message.resourceAddress, message.recipientWalletAddress, BigInt(message.amount), maxFee, message.memo)
      );
    }

    case "popup-rescan-private-payments": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      if (!(account instanceof OotleAccount)) {
        throw new Error("Rescanning for private payments isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const { activeAccountId } = await getState();
      // A much deeper lookback than buildStatus()'s opportunistic per-popup-open scan (3 pages /
      // 50 each = 150 transactions) -- this is the user explicitly asking to go looking, so it's
      // worth the extra round trips to actually catch up on a long gap since the wallet was last
      // opened, not just the same shallow window the automatic scan already covers.
      const { claimed, found } = await account.scanForPrivatePayments(20, 50);
      await recordPrivatePaymentHistory(activeAccountId, found);
      return { claimed };
    }

    case "popup-claim-private-payment": {
      const account = await getActiveAccount();
      if (!account) throw new Error("Wallet is locked.");
      if (!(account instanceof OotleAccount)) {
        throw new Error("Claiming a private payment isn't available for daemon-connected accounts -- switch to a local account first.");
      }
      const { activeAccountId } = await getState();
      return withHistory(
        { accountId: activeAccountId, kind: "private-payment-received", resourceAddress: message.resourceAddress, counterparty: message.commitment },
        () => account.claimPrivatePayment(message.resourceAddress, message.commitment),
        // The amount/memo are only known once decryption succeeds -- see withHistory's own doc
        // comment for why these can't just go in the static base above.
        (result) => ({ amount: result.amount.toString(), memo: result.memo })
      );
    }

    case "popup-add-account": {
      const state = await getState();
      const newIndex = state.accountCount;
      const newId = localAccountId(newIndex);
      await setState({ accountCount: newIndex + 1, activeAccountId: newId });
      return { index: newIndex };
    }

    case "popup-set-active-account": {
      const { activeAccountId } = await getState();
      if (message.accountId !== activeAccountId) {
        // Every existing connection is pinned to whichever account was active when it was made
        // (see addConnectedSite) — switching accounts without dropping them would leave connected
        // sites silently reading/spending from the account the user just switched away from.
        await removeAllConnectedSites();
        await broadcastAccountsChanged([]);
      }
      await setState({ activeAccountId: message.accountId });
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
      return { resolved: resolveApproval(message.approvalId, message.approve) };

    case "popup-reset-wallet": {
      await clearUnlockedSeed();
      clearAccountCache();
      await wipeWallet();
      return {};
    }

    case "popup-connect-daemon": {
      // Adding a daemon connection requires the wallet to be unlocked -- its API key is
      // encrypted with a key derived from the seed (see secretAtRest.ts), so there's nothing to
      // derive that encryption key from otherwise. In practice Settings (where this is reached
      // from) is already unreachable while locked, so this should never actually trip; it's here
      // so the failure is a clear message rather than a confusing crash if that ever changes.
      const seed = await getUnlockedSeed();
      if (!seed) throw new Error("Wallet is locked.");
      const id = crypto.randomUUID();
      // Validates connectivity/the API key up front so a bad URL or key fails here, in the
      // "connect" step, rather than silently later on the first real account operation.
      const client = await DaemonAccount.connectClient(message.url, message.apiKey);
      const encryptedApiKey = await encryptSecret(seed, message.apiKey);
      await addDaemonConnection({ id, url: message.url, encryptedApiKey, label: message.label });
      const accounts = await DaemonAccount.listAccounts(client, message.url);
      const options: DaemonAccountOption[] = accounts.map((a) => ({
        componentAddress: a.component_address,
        label: a.name ?? a.component_address,
      }));
      return { connectionId: id, accounts: options };
    }

    case "popup-list-daemon-accounts": {
      const seed = await getUnlockedSeed();
      if (!seed) throw new Error("Wallet is locked.");
      const { client, url } = await getDaemonClient(message.connectionId, seed);
      const accounts = await DaemonAccount.listAccounts(client, url);
      const options: DaemonAccountOption[] = accounts.map((a) => ({
        componentAddress: a.component_address,
        label: a.name ?? a.component_address,
      }));
      return { accounts: options };
    }

    case "popup-add-daemon-accounts": {
      for (const account of message.accounts) {
        await addDaemonAccount({ connectionId: message.connectionId, componentAddress: account.componentAddress, label: account.label });
      }
      // Switch to the first newly-added account so the user lands somewhere useful, matching
      // `popup-add-account`'s behavior for a freshly-derived local account.
      const first = message.accounts[0];
      if (first) await setState({ activeAccountId: daemonAccountId(message.connectionId, first.componentAddress) });
      return {};
    }

    case "popup-remove-daemon-connection": {
      await removeDaemonConnection(message.connectionId);
      return {};
    }

    case "popup-remove-daemon-account": {
      await removeDaemonAccount(message.connectionId, message.componentAddress);
      return {};
    }

    case "popup-set-auto-lock-minutes": {
      await setState({ autoLockMinutes: message.minutes });
      return {};
    }

    case "popup-add-address-book-entry": {
      const entry = { id: crypto.randomUUID(), label: message.label, address: message.address };
      await addAddressBookEntry(entry);
      return entry;
    }

    case "popup-remove-address-book-entry": {
      await removeAddressBookEntry(message.id);
      return {};
    }

    case "popup-get-transaction-history": {
      const { activeAccountId } = await getState();
      return listTransactionHistory(activeAccountId);
    }

    case "popup-set-network": {
      await setState({ network: message.network });
      // Local accounts are cached by "network:index" (see accounts.ts's getLocalAccount), so they
      // already pick up the new network on their own -- but a daemon-relayed account's cache key
      // has no network component, and getDaemonAccount() only reads the current network when
      // constructing a *fresh* instance, so a cached one would otherwise keep talking to the old
      // network's indexer silently. Clearing forces everything to rebuild against the new network.
      clearAccountCache();
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

// ---------------------------------------------------------------------------
// Auto-lock on inactivity
// ---------------------------------------------------------------------------
// Before this, there was no auto-lock at all: chrome.storage.session (see session.ts) keeps the
// decrypted seed alive until the whole browser closes, no matter how long the wallet sat idle —
// real exposure on a shared or unattended machine. chrome.alarms (not setInterval/setTimeout) is
// what actually works here: MV3 kills this service worker after ~30s of inactivity, and a plain
// timer dies with it, while an alarm persists and re-fires even across a worker restart.
const AUTO_LOCK_ALARM = "tari-auto-lock-check";

chrome.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  void checkAutoLock();
});

async function checkAutoLock(): Promise<void> {
  if (!(await isUnlocked())) return;
  const lastActivity = await getLastActivity();
  if (lastActivity === null) return; // defensive: shouldn't happen while unlocked
  const { autoLockMinutes } = await getState();
  if (!shouldAutoLock(lastActivity, Date.now(), autoLockMinutes)) return;
  await clearUnlockedSeed();
  clearAccountCache();
}
