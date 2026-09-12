import { createWalletSeed, deserializeSeed, importWalletSeed, seedToMnemonic, serializeSeed } from "../lib/cipherSeed";
import { decryptVault, encryptVault } from "../lib/vault";
import {
  addAddressBookEntry,
  addConnectedSite,
  addDaemonAccount,
  addDaemonConnection,
  addTransactionHistoryEntry,
  addTransactionRequest,
  beginTransactionRequestSubmit,
  daemonAccountId,
  getConnectedSite,
  getState,
  getTransactionRequest,
  hasViewAccess,
  listTransactionHistory,
  removeAddressBookEntry,
  removeAllConnectedSites,
  removeConnectedSite,
  removeDaemonAccount,
  removeDaemonConnection,
  setState,
  setTransactionRequestStatus,
  setViewAccess,
  TRANSACTION_REQUEST_TTL_MS,
  type TransactionHistoryEntry,
  type TransactionRequestRecord,
  wipeWallet,
} from "../lib/storage";
import { summarizeInstruction } from "../lib/instructionSummary";
import { classifyProviderError } from "../lib/messages";
import type {
  AccountSummary,
  AccountsChangedBroadcast,
  DaemonAccountOption,
  DappTokenBalance,
  PageRequestMessage,
  PageResponseMessage,
  PendingApprovalInput,
  PopupRequest,
  PrivateBalance,
  PrivatePaymentScanResult,
  ShieldedOutputSummary,
  TransactionRequestOperation,
  TransactionRequestSummary,
  WalletCapabilities,
  WalletStatus,
} from "../lib/messages";
import type { Instruction, SubstateRequirement } from "@tari-project/ootle-ts-bindings";
import { isStealthTransferInstruction } from "@tari-project/ootle";
import {
  OotleAccount,
  chromeStorageAdapter,
  configureOotleStorage,
  getPrivatePaymentScanCursor,
  localAccountId,
  recoverPendingShields,
  resetKnownVersions,
  wipeOotleState,
  type WalletAccountApi,
} from "@chironbuilder/ootle-sdk";
import { DaemonAccount } from "../lib/daemonAccount";
import { clearAccountCache, getAccountById, getActiveAccount, getDaemonClient } from "./accounts";
import { clearUnlockedSeed, getLastActivity, getUnlockedSeed, isUnlocked, setUnlockedSeed, touchActivity } from "./session";
import { getPendingApproval, requestApproval, resolveApproval } from "./approvals";
import { shouldAutoLock } from "../lib/autoLock";
import { encryptSecret } from "../lib/secretAtRest";
import { migrateOotleStorageOnce } from "../lib/migrateOotleStorage";

// Must happen before anything below touches OotleAccount/shielded-output/known-versions storage.
// Synchronous (just sets a module-level variable), so there's no ordering risk with the message
// listener registered right after it. The one-time data migration is fire-and-forget: it only
// backfills data an existing install already had lying around under the old (pre-SDK) storage
// keys, so a message handled before it finishes just sees an empty SDK-side cache momentarily,
// never wrong data.
configureOotleStorage(chromeStorageAdapter());
void migrateOotleStorageOnce();

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
        sendResponse({
          kind: "tari-page-response",
          id: message.id,
          error: classifyProviderError(String(err?.message ?? err)),
        } satisfies PageResponseMessage)
      );
    return true;
  }
  if (message && typeof message.kind === "string" && message.kind.startsWith("popup-")) {
    handlePopupRequest(message as PopupRequest)
      .then((result) => sendResponse({ ok: true, result: sanitizeForMessage(result) }))
      .catch((err) => {
        // Deliberately not logging the error text: a failed popup request's error can embed the
        // user-entered daemon URL, which shouldn't leak into the extension console.
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

  switch (method) {
    case "tari_getNetwork": {
      // No connected-site check on purpose (any page can ask which network this is) -- exactly why
      // this must NOT touch activity. It used to, unconditionally, at the top of this function:
      // any page (connected or not, no approval needed) could poll this on a timer and silently
      // keep the auto-lock countdown reset forever, defeating the point of auto-lock entirely on a
      // shared/unattended machine. Activity now only counts when a request actually uses an
      // established, user-approved connection -- see the other cases below.
      const { network } = await getState();
      return network;
    }

    case "tari_getAccounts": {
      const site = await getConnectedSite(origin);
      if (!site || !(await isUnlocked())) return [];
      const account = await getAccountById(site.accountId);
      if (!account) return [];
      await touchActivity();
      return [await account.getComponentAddress()];
    }

    case "tari_requestAccounts": {
      if (!(await getState()).vault) throw new Error("No wallet set up in the Tari extension yet.");
      const existing = await getConnectedSite(origin);
      if (existing && (await isUnlocked())) {
        const account = await getAccountById(existing.accountId);
        if (account) {
          await touchActivity();
          return [await account.getComponentAddress()];
        }
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
      await touchActivity();
      return [await account.getComponentAddress()];
    }

    case "tari_disconnect": {
      await removeConnectedSite(origin);
      return null;
    }

    // ---- Private view access -----------------------------------------------------------------
    // A read grant over the connected account's confidential position, asked for separately from
    // the connection itself: connecting reveals one public component address, this reveals the
    // whole position the rest of the chain cannot see. See ConnectedSite.viewAccessGrantedAt.

    case "tari_requestViewAccess": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      await touchActivity();
      if (site.viewAccessGrantedAt !== undefined) return { granted: true };
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      // Refused early, before opening a prompt the user could only answer with a lie: a
      // daemon-relayed account never exposes its view secret, so nothing behind this grant could
      // ever be served for it (capabilities.privateBalanceView says the same thing up front).
      if (!(account instanceof OotleAccount)) {
        throw new Error("Private view access isn't available for daemon-connected accounts — switch to a local account first.");
      }
      const approved = await requestApproval({ kind: "viewAccess", origin, accountId: site.accountId });
      if (!approved) return { granted: false };
      // Re-read rather than trusting the `site` captured before the (arbitrarily long) prompt: the
      // user may have disconnected this origin, or switched accounts and dropped every connection,
      // while the window sat open. setViewAccess is a no-op for a now-missing site, but a stale
      // `{ granted: true }` back to the dApp would be a lie either way.
      const granted = await setViewAccess(origin, true);
      if (!granted) throw new Error("This site was disconnected before view access could be granted.");
      return { granted: true };
    }

    case "tari_getViewAccess": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      return { granted: site.viewAccessGrantedAt !== undefined };
    }

    case "tari_revokeViewAccess": {
      // No connected-site check and no error for an origin that never had it: giving up a
      // permission you may not hold is idempotent by nature, and a dApp cleaning up after itself
      // shouldn't have to guard the call.
      await setViewAccess(origin, false);
      return null;
    }

    // ---- Confidential reads ------------------------------------------------------------------

    case "tari_getPrivateBalances": {
      const account = await requireViewAccess(origin);
      return (await account.getPrivateBalances()).map(
        (b): PrivateBalance => ({
          resourceAddress: b.resourceAddress,
          amount: b.amount.toString(),
          outputCount: b.outputCount,
          divisibility: b.divisibility,
          symbol: b.symbol,
          name: b.name,
        })
      );
    }

    case "tari_getShieldedOutputs": {
      const account = await requireViewAccess(origin);
      const p = (params ?? {}) as { resourceAddress?: string };
      const records = await account.listUnspentShieldedOutputs(p.resourceAddress);
      // Mapped field by field rather than spread: a ShieldedOutputRecord also carries `accountId`
      // and `spent`, neither of which is any of a dApp's business, and a spread would hand both
      // over the moment a new internal field is added to that record.
      return records.map(
        (r): ShieldedOutputSummary => ({
          resourceAddress: r.resourceAddress,
          commitment: r.commitment,
          amount: r.amount,
          transactionId: r.transactionId,
          createdAt: r.createdAt,
          memo: r.memo,
        })
      );
    }

    case "tari_scanForPrivatePayments": {
      const account = await requireViewAccess(origin);
      const p = (params ?? {}) as { maxPages?: number };
      const { claimed, found } = await account.scanForPrivatePayments(p.maxPages);
      // Same reason the popup's own rescan does this: a scan that discovers real incoming payments
      // must leave a trace in the wallet's own history, not only in the dApp's response.
      const site = await getConnectedSite(origin);
      if (site) await recordPrivatePaymentHistory(site.accountId, found);
      const result: PrivatePaymentScanResult = {
        claimed,
        found: found.map((f) => ({
          resourceAddress: f.resourceAddress,
          commitment: f.commitment,
          amount: f.amount.toString(),
          transactionId: f.transactionId,
          memo: f.memo,
        })),
      };
      return result;
    }

    case "tari_claimPrivatePayment": {
      const account = await requireViewAccess(origin);
      const p = params as { resourceAddress: string; commitment: string };
      const { amount, memo } = await account.claimPrivatePayment(p.resourceAddress, p.commitment);
      const site = await getConnectedSite(origin);
      if (site) {
        await recordPrivatePaymentHistory(site.accountId, [
          { resourceAddress: p.resourceAddress, amount, transactionId: p.commitment, memo },
        ]);
      }
      return { amount: amount.toString(), memo };
    }

    case "tari_signOwnershipChallenge": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const rawAccount = await getAccountById(site.accountId);
      if (!rawAccount) throw new Error("Wallet is locked.");
      const account = requireLocalAccount(rawAccount, "Proving ownership");
      const p = params as { resourceAddress: string; substateId: string; challenge: string };
      if (typeof p.challenge !== "string" || p.challenge.length === 0) {
        throw new Error("challenge must be a non-empty string.");
      }
      await touchActivity();
      const approved = await requestApproval({
        kind: "signOwnershipProof",
        origin,
        accountId: site.accountId,
        resourceAddress: p.resourceAddress,
        substateId: p.substateId,
        challenge: p.challenge,
      });
      if (!approved) throw new Error("Rejected by the user.");
      return account.signOwnershipProof(p.resourceAddress, p.substateId, p.challenge);
    }

    case "tari_signWalletOwnershipChallenge": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const rawAccount = await getAccountById(site.accountId);
      if (!rawAccount) throw new Error("Wallet is locked.");
      const account = requireLocalAccount(rawAccount, "Proving wallet ownership");
      const p = params as { challenge: string };
      if (typeof p.challenge !== "string" || p.challenge.length === 0) {
        throw new Error("challenge must be a non-empty string.");
      }
      await touchActivity();
      const walletAddress = await account.getWalletAddress();
      const approved = await requestApproval({
        kind: "signWalletOwnershipProof",
        origin,
        accountId: site.accountId,
        walletAddress,
        challenge: p.challenge,
      });
      if (!approved) throw new Error("Rejected by the user.");
      return account.signWalletOwnership(p.challenge);
    }

    case "tari_getWalletAddress": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      await touchActivity();
      return account.getWalletAddress();
    }

    case "tari_getBalances": {
      const site = await getConnectedSite(origin);
      if (!site || !(await isUnlocked())) return [];
      const account = await getAccountById(site.accountId);
      if (!account) return [];
      await touchActivity();
      // The confidential half is withheld unless this site holds the separate view grant -- see
      // ConnectedSite.viewAccessGrantedAt. `privateVisible` is what makes the withheld case
      // distinguishable from a genuine zero; a dApp that reads `confidentialAmount` alone and sees
      // "0" must not be able to conclude the account holds nothing privately.
      const privateVisible = site.viewAccessGrantedAt !== undefined;
      const balances = await account.getBalances();
      return balances.map(
        (b): DappTokenBalance => ({
          resourceAddress: b.resourceAddress,
          kind: b.kind,
          amount: b.amount.toString(),
          confidentialAmount: privateVisible ? b.confidentialAmount.toString() : "0",
          privateVisible,
          divisibility: b.divisibility,
          symbol: b.symbol,
          name: b.name,
        })
      );
    }

    case "tari_getSubstate": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      await touchActivity();
      const p = params as { substateId: string; version?: number | null };
      const provider = await account.getProvider();
      return provider.getSubstate(p.substateId, p.version ?? null);
    }

    case "tari_getCapabilities": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      await touchActivity();
      // Every stealth-touching feature -- spend or read -- needs this account's own view secret
      // and one-time stealth signing, which only a seed-derived local account has (see
      // WalletDaemonSigner's doc comment). One check, reused, rather than a per-field instanceof
      // that could drift apart from the checks submitApprovedTransactionRequest actually enforces.
      const isLocal = account instanceof OotleAccount;
      const capabilities: WalletCapabilities = {
        exactInputSelection: true,
        stealthWithdraw: isLocal,
        htlcFund: isLocal,
        scriptPathSpend: isLocal,
        privateSpend: isLocal,
        privateBalanceView: isLocal,
        privateViewGranted: site.viewAccessGrantedAt !== undefined,
        transactionResultLookup: true,
        transactionRequests: true,
        walletAddress: true,
        minimumValuePromise: isLocal,
        ownershipProof: isLocal,
        walletOwnershipProof: isLocal,
        confidentialDeposit: isLocal,
        dryRunIsLocal: false,
      };
      return capabilities;
    }

    case "tari_getTransactionResult": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const account = await getAccountById(site.accountId);
      if (!account) throw new Error("Wallet is locked.");
      await touchActivity();
      const p = params as { transactionId: string };
      const provider = await account.getProvider();
      return provider.getTransactionResult(p.transactionId);
    }

    // Deprecated (see messages.ts): a thin wrapper over createTransactionRequest +
    // submitTransactionRequestOperation, blocking for the whole round trip like it always has.
    case "tari_signAndSubmitTransaction": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      await touchActivity();
      const p = params as { instructions: Instruction[]; maxFee?: string; dryRun?: boolean; inputs?: SubstateRequirement[] };
      assertNoStealthTransferInstruction(p.instructions);
      // Dry runs are read-only simulations (quotes, balance-adjacent lookups) — a DEX price quote
      // that reprices on every keystroke would otherwise pop an approval window per keystroke.
      // Only a real submission spends anything, so only that needs the user's sign-off; dry runs
      // never go through the request/approval system at all, deprecated or not.
      if (p.dryRun) {
        if (!(await isUnlocked())) throw new Error("Wallet is locked.");
        const account = await getAccountById(site.accountId);
        if (!account) throw new Error("Could not resolve account.");
        const maxFee = p.maxFee ? BigInt(p.maxFee) : undefined;
        return account.execute(p.instructions, { maxFee, dryRun: true, inputs: p.inputs });
      }
      const operation: TransactionRequestOperation = {
        kind: "instructions",
        instructions: p.instructions,
        maxFee: p.maxFee,
        inputs: p.inputs,
      };
      return createAndWaitToSubmit(origin, site.accountId, operation);
    }

    // Deprecated (see messages.ts). The only way for a connected dApp to move Stealth-typed funds
    // (e.g. XTR) into its own contract call — `tari_signAndSubmitTransaction`'s `account.execute()`
    // cannot: a plain `CallMethod withdraw` on a Stealth vault is not a standalone-valid instruction
    // (confirmed: fails client-side with a generic `TransactionInput` deserialization error, even
    // alone with no other instructions). See `OotleAccount.withdrawStealthAndExecute`'s own doc
    // comment for the full story.
    case "tari_withdrawStealthAndExecute": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      await touchActivity();
      const p = params as {
        resourceAddress: string;
        amount: string;
        workspaceVarName: string;
        followUpInstructions: Instruction[];
        relatedComponents?: string[];
        maxFee?: string;
      };
      const operation: TransactionRequestOperation = { kind: "withdrawStealthAndExecute", ...p };
      return createAndWaitToSubmit(origin, site.accountId, operation);
    }

    // Deprecated (see messages.ts). See `OotleAccount.htlcFund`'s doc comment: fund-only for now
    // (no way to claim/refund yet).
    case "tari_htlcFund": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      await touchActivity();
      const p = params as {
        resourceAddress: string;
        amount: string;
        claimantWalletAddress: string;
        hashLockHex: string;
        refundEpoch: string;
        maxFee?: string;
      };
      const operation: TransactionRequestOperation = { kind: "htlcFund", ...p };
      return createAndWaitToSubmit(origin, site.accountId, operation);
    }

    case "tari_createTransactionRequest": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      await touchActivity();
      const operation = params as TransactionRequestOperation;
      if (operation.kind === "instructions") assertNoStealthTransferInstruction(operation.instructions);
      const { requestId } = await createTransactionRequest(origin, site.accountId, operation);
      return { requestId };
    }

    case "tari_getTransactionRequest": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      const p = params as { requestId: string };
      const record = await getTransactionRequest(p.requestId);
      if (!record || record.origin !== origin) throw new Error("Unknown transaction request.");
      return toTransactionRequestSummary(record);
    }

    case "tari_submitTransactionRequest": {
      const site = await getConnectedSite(origin);
      if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
      await touchActivity();
      const p = params as { requestId: string };
      const record = await getTransactionRequest(p.requestId);
      if (!record || record.origin !== origin) throw new Error("Unknown transaction request.");
      // The request was bound to whichever account the site was connected to when it was created
      // (record.accountId, set at createTransactionRequest time). If the site has since reconnected
      // under a different account (e.g. the user switched accounts in the extension, which drops
      // every connection, then re-approved this site), the approved request must not spend from an
      // account the site is no longer bound to -- it would otherwise silently move funds from the
      // *old* account even though the site is now connected to a different one.
      if (record.accountId !== site.accountId) {
        throw new Error("This transaction request belongs to a different account — switch back to that account or create a new request.");
      }
      return submitApprovedTransactionRequest(p.requestId);
    }

    default:
      throw new Error(`Unknown method: ${method satisfies never}`);
  }
}

// ---------------------------------------------------------------------------
// Transaction requests: create -> (popup approval) -> submit
//
// Shared by both the new tari_createTransactionRequest/tari_getTransactionRequest/
// tari_submitTransactionRequest RPCs and the deprecated single-call RPCs (tari_
// signAndSubmitTransaction/tari_withdrawStealthAndExecute/tari_htlcFund), which are thin wrappers
// over the same primitives -- see messages.ts's TransactionRequestOperation doc comment.
// ---------------------------------------------------------------------------

// account.execute() only builds/signs/seals via TransactionBuilder -- it never runs
// WalletStealthAuthorizer, so it can't produce the balance proof or per-input one-time
// authorizations a real StealthTransfer instruction needs. The engine would reject an incomplete
// statement anyway (no fund-loss risk), but failing fast with a clear message beats a confusing
// late rejection, and skips popping an approval window for a tx that can never succeed via this
// path.
function assertNoStealthTransferInstruction(instructions: Instruction[]): void {
  if (instructions.some(isStealthTransferInstruction)) {
    throw new Error(
      "A raw StealthTransfer instruction can't be submitted through a connected app — the wallet has to build it. " +
        'Use tari_createTransactionRequest with one of the private-spend kinds instead ("shield", "unshield", "sendPrivately", "htlcFund", "htlcClaim", "htlcRefund").'
    );
  }
}

/**
 * The single gate in front of every confidential *read* RPC: resolves the connected account,
 * insisting on all three of a live connection, the site's explicit private view grant (see
 * `ConnectedSite.viewAccessGrantedAt`), and a seed-derived local account -- the only kind holding
 * the view secret these reads decrypt with.
 *
 * The three failures are deliberately distinct messages rather than one generic denial: a dApp
 * handling "ask for the grant", "ask the user to unlock", and "this account can never do this"
 * identically would be stuck in a prompt loop for the last of them.
 */
async function requireViewAccess(origin: string): Promise<OotleAccount> {
  const site = await getConnectedSite(origin);
  if (!site) throw new Error("Site is not connected. Call tari_requestAccounts first.");
  if (site.viewAccessGrantedAt === undefined) {
    throw new Error("This site doesn't have private view access. Call tari_requestViewAccess first.");
  }
  const account = await getAccountById(site.accountId);
  if (!account) throw new Error("Wallet is locked.");
  if (!(account instanceof OotleAccount)) {
    throw new Error("Reading private balances isn't available for daemon-connected accounts — switch to a local account first.");
  }
  await touchActivity();
  return account;
}

/** The (instructions to display, note to explain) pair shown on the popup approval screen for
 * `operation` -- one case per kind, matching exactly what each of the three deprecated RPCs
 * showed before they became wrappers over this shared flow. */
function summarizeOperationForApproval(operation: TransactionRequestOperation): { instructions: Instruction[]; note?: string } {
  switch (operation.kind) {
    case "instructions":
      return { instructions: operation.instructions };
    case "withdrawStealthAndExecute":
      return {
        instructions: operation.followUpInstructions,
        note: `Reveals ${BigInt(operation.amount).toString()} of ${operation.resourceAddress} for use in this transaction.`,
      };
    case "htlcFund":
      return {
        instructions: [],
        note: `Locks ${BigInt(operation.amount).toString()} of ${operation.resourceAddress} in an HTLC, claimable by ${
          operation.claimantWalletAddress
        } (with the matching secret) before epoch ${BigInt(operation.refundEpoch).toString()}, refundable back to this account after.`,
      };
    // Every private-spend kind shows an empty instruction list on purpose: the wallet builds the
    // StealthTransfer itself at submit time (a dApp cannot hand one over -- see
    // assertNoStealthTransferInstruction), so there are no dApp-authored instructions to display.
    // The note carries the whole meaning of the request instead, and each one states plainly which
    // direction value moves and whether it becomes publicly visible -- that is the only thing
    // distinguishing these from each other on the approval screen.
    case "shield": {
      const base = `Moves ${BigInt(operation.amount).toString()} of ${operation.resourceAddress} from your public balance into your private balance. Stays in this account.`;
      // Stated outright, not left for the user to infer from a field name. Shielding is the act of
      // making value invisible; a promise puts a permanent public floor back on it, for everyone,
      // for as long as the output lives. Someone approving a "move to private" must not discover
      // afterwards that they also published a number.
      return {
        instructions: [],
        note: promiseNote(operation.minimumValuePromise, base, "this new private output"),
      };
    }
    case "depositConfidential":
      return {
        instructions: [],
        note: `Moves ${BigInt(operation.amount).toString()} of ${operation.resourceAddress} from your public balance into a Confidential vault. Stays in this account. Different privacy mechanism from "shield" -- only works if this resource was created as a Confidential-type resource.`,
      };
    case "unshield":
      return {
        instructions: [],
        note: `Moves ${BigInt(
          operation.revealedAmount
        ).toString()} of ${operation.resourceAddress} from your private balance back into your public balance — this amount becomes visible on-chain.`,
      };
    case "sendPrivately": {
      const base = `Sends ${BigInt(operation.amount).toString()} of ${operation.resourceAddress} privately to ${
        operation.recipientWalletAddress
      }. The amount and recipient stay hidden on-chain.`;
      return {
        instructions: [],
        note: promiseNote(operation.minimumValuePromise, base, "the recipient's new output"),
      };
    }
    case "htlcClaim":
      return {
        instructions: [],
        note: `Claims an HTLC-locked private payment of ${operation.resourceAddress} into your private balance, by revealing the secret to the network.`,
      };
    case "htlcRefund":
      return {
        instructions: [],
        note: `Refunds ${BigInt(
          operation.amount
        ).toString()} of ${operation.resourceAddress} from an HTLC you funded back into your private balance. Only works once its refund epoch has passed.`,
      };
  }
}

/**
 * Appends the minimum-value-promise disclosure to an operation's approval note, when one is set.
 *
 * Separate from the per-kind notes because the warning is identical wherever a promise appears and
 * must not drift between them: the whole point is that the user reads the same unambiguous sentence
 * about a permanent public disclosure regardless of which operation carries it. A zero or absent
 * promise adds nothing at all -- a warning shown on every transaction is one nobody reads on the
 * transaction that needed it.
 */
function promiseNote(minimumValuePromise: string | undefined, base: string, subject: string): string {
  if (minimumValuePromise === undefined || BigInt(minimumValuePromise) === 0n) return base;
  return `${base} It will also publicly and permanently record that ${subject} is worth at least ${BigInt(
    minimumValuePromise,
  ).toString()} — visible to everyone on-chain, not just this site, for as long as the output exists.`;
}

/** The transaction-history `counterparty` label for `operation` -- one case per kind, matching
 * exactly what each of the three deprecated RPCs recorded before they became wrappers. */
function operationHistoryLabel(origin: string, operation: TransactionRequestOperation): string {
  switch (operation.kind) {
    case "instructions": {
      const summary = operation.instructions.map((i) => summarizeInstruction(i).title).join(", ");
      return `${origin}: ${summary}`;
    }
    case "withdrawStealthAndExecute": {
      const summary = operation.followUpInstructions.map((i) => summarizeInstruction(i).title).join(", ");
      return `${origin}: reveal + ${summary}`;
    }
    case "htlcFund":
      return `${origin}: HTLC fund -> ${operation.claimantWalletAddress}`;
    case "shield":
      return `${origin}: shield`;
    case "depositConfidential":
      return `${origin}: deposit confidential`;
    case "unshield":
      return `${origin}: unshield`;
    case "sendPrivately":
      return `${origin}: private send -> ${operation.recipientWalletAddress}`;
    case "htlcClaim":
      return `${origin}: HTLC claim`;
    case "htlcRefund":
      return `${origin}: HTLC refund`;
  }
}

function toTransactionRequestSummary(record: TransactionRequestRecord): TransactionRequestSummary {
  return {
    requestId: record.id,
    status: record.status,
    note: record.note,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    result: record.result,
    error: record.error,
  };
}

/**
 * Persists a `TransactionRequestRecord` (status "pending") and fires off — without awaiting — the
 * same popup approval every transaction always required, sharing the approval's id with the
 * record's id (see approvals.ts's `requestApproval` doc comment) so the popup's click updates this
 * exact record. Returns immediately; `approved` resolves later, whenever the user actually clicks
 * — callers that need to block on it (the deprecated wrappers) await it themselves.
 */
async function createTransactionRequest(
  origin: string,
  accountId: string,
  operation: TransactionRequestOperation
): Promise<{ requestId: string; approved: Promise<boolean> }> {
  const requestId = crypto.randomUUID();
  const { instructions, note } = summarizeOperationForApproval(operation);
  const maxFee = "maxFee" in operation ? operation.maxFee : undefined;
  const now = Date.now();
  const record: TransactionRequestRecord = {
    id: requestId,
    origin,
    accountId,
    operation,
    note: note ?? "",
    status: "pending",
    createdAt: now,
    expiresAt: now + TRANSACTION_REQUEST_TTL_MS,
  };
  // Written before the approval popup can possibly be interacted with, so resolveApproval's dual
  // write (background/approvals.ts) always finds this record -- there is no window where the user
  // could click before it exists.
  await addTransactionRequest(record);
  const approval: PendingApprovalInput = { kind: "transaction", origin, instructions, maxFee, note, accountId };
  const approved = requestApproval(approval, requestId);
  return { requestId, approved };
}

/**
 * Narrows an account to the seed-derived kind every stealth-touching operation needs (a
 * daemon-relayed account has no view secret and can't produce one-time stealth signatures -- see
 * `WalletDaemonSigner`'s doc comment), or throws naming the operation that wanted it. Written once
 * here rather than per-case so a new stealth operation can't quietly ship without the check.
 */
function requireLocalAccount(account: WalletAccountApi, what: string): OotleAccount {
  if (!(account instanceof OotleAccount)) {
    throw new Error(`${what} isn't available for daemon-connected accounts — switch to a local account first.`);
  }
  return account;
}

/**
 * Submits a transaction request through the storage-level claim gate: atomically moves the record
 * from "approved" to "submitting" BEFORE anything executes (beginTransactionRequestSubmit), runs
 * the operation via the matching account method, and settles the persisted status to
 * "submitted"+result or "failed"+error afterwards. The pre-execution claim is what makes
 * submission safe against concurrency: two simultaneous submits (or a submit racing the
 * deprecated blocking wrapper over the same record) cannot both pass the gate -- exactly one wins,
 * the other fails with "wrong-status" instead of double-executing. Shared by
 * `tari_submitTransactionRequest` and every deprecated wrapper's final step.
 */
async function submitApprovedTransactionRequest(requestId: string): Promise<unknown> {
  // Checked before claiming so a locked wallet can't strand the record in "submitting" with no
  // execution ever following.
  if (!(await isUnlocked())) throw new Error("Wallet is locked.");
  const outcome = await beginTransactionRequestSubmit(requestId);
  if (!outcome.claimed) {
    switch (outcome.reason) {
      case "not-found":
        throw new Error("Unknown transaction request.");
      case "expired":
        throw new Error("This transaction request expired before it was submitted.");
      case "wrong-status":
        throw new Error(`Cannot submit: this request's status is "${outcome.record!.status}".`);
    }
  }
  const record = outcome.record;
  const account = await getAccountById(record.accountId);
  if (!account) throw new Error("Could not resolve account.");
  const operation = record.operation;
  const maxFee = operation.maxFee !== undefined ? BigInt(operation.maxFee) : undefined;

  const doExecute = (): Promise<unknown> => {
    switch (operation.kind) {
      case "instructions":
        return account.execute(operation.instructions, { maxFee, inputs: operation.inputs });
      case "withdrawStealthAndExecute":
        // Needs this account's own view secret + one-time stealth signing (SecretKeyWallet), same
        // as shield()/unshield() — a daemon-relayed account can't provide either (see
        // WalletDaemonSigner's own doc comment).
        return requireLocalAccount(account, "Withdrawing stealth funds").withdrawStealthAndExecute(
          operation.resourceAddress,
          BigInt(operation.amount),
          operation.workspaceVarName,
          operation.followUpInstructions,
          operation.relatedComponents ?? [],
          maxFee
        );
      case "htlcFund":
        // See tari_withdrawStealthAndExecute's own comment: only a seed-derived local account can
        // build the PayTo::Conditions output witness this needs.
        return requireLocalAccount(account, "Funding an HTLC").htlcFund(
          operation.resourceAddress,
          BigInt(operation.amount),
          operation.claimantWalletAddress,
          operation.hashLockHex,
          BigInt(operation.refundEpoch),
          maxFee
        );
      // Private spends. Each defers entirely to the OotleAccount method of the same name -- the
      // dApp never sees a mask, a view secret, or which specific UTXOs get spent (coin selection is
      // the wallet's own decision, from its own local ledger of stealth outputs). Same
      // local-account requirement as everything else stealth-touching.
      case "shield":
        return requireLocalAccount(account, "Shielding funds").shield(
          operation.resourceAddress,
          BigInt(operation.amount),
          maxFee,
          operation.memo,
          operation.minimumValuePromise !== undefined ? BigInt(operation.minimumValuePromise) : 0n
        );
      case "depositConfidential":
        return requireLocalAccount(account, "Depositing into a Confidential vault").depositConfidential(
          operation.resourceAddress,
          BigInt(operation.amount),
          maxFee
        );
      case "unshield":
        return requireLocalAccount(account, "Unshielding funds").unshield(
          operation.resourceAddress,
          BigInt(operation.revealedAmount),
          maxFee,
          operation.memo
        );
      case "sendPrivately":
        return requireLocalAccount(account, "Sending privately").sendPrivately(
          operation.resourceAddress,
          operation.recipientWalletAddress,
          BigInt(operation.amount),
          maxFee,
          operation.memo,
          operation.minimumValuePromise !== undefined ? BigInt(operation.minimumValuePromise) : 0n
        );
      case "htlcClaim":
        return requireLocalAccount(account, "Claiming an HTLC").htlcClaim(
          operation.resourceAddress,
          operation.commitment,
          operation.conditions,
          operation.preimageHex,
          maxFee
        );
      case "htlcRefund":
        return requireLocalAccount(account, "Refunding an HTLC").htlcRefund(
          operation.resourceAddress,
          operation.commitment,
          operation.conditions,
          BigInt(operation.amount),
          operation.outputMask,
          maxFee
        );
    }
  };

  const counterparty = operationHistoryLabel(record.origin, operation);
  try {
    const result = await withHistory({ accountId: record.accountId, kind: "dapp-transaction", counterparty }, doExecute);
    await setTransactionRequestStatus(record.id, { status: "submitted", result: sanitizeForMessage(result) });
    return result;
  } catch (e) {
    await setTransactionRequestStatus(record.id, { status: "failed", error: String(e instanceof Error ? e.message : e) });
    throw e;
  }
}

/** The deprecated-RPC path: create, block until the user responds (exactly like these methods
 * always blocked), then submit through the same atomic claim gate as
 * `tari_submitTransactionRequest` -- which also closes the old gap where an approval granted after
 * the request sat past its TTL still submitted (the gate rejects an expired "approved" record). */
async function createAndWaitToSubmit(origin: string, accountId: string, operation: TransactionRequestOperation): Promise<unknown> {
  const { requestId, approved } = await createTransactionRequest(origin, accountId, operation);
  if (!(await approved)) throw new Error("Transaction rejected.");
  return submitApprovedTransactionRequest(requestId);
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
          // Private-payment scanning does NOT happen here anymore -- it used to run synchronously
          // on every popup open, and a wallet's very first scan (no cursor yet) defaults to a
          // 400-page lookback (see scanForPrivatePayments()'s doc comment), which blocked the
          // popup's first render on up to 20,000 transactions of indexer round trips. The popup now
          // triggers `popup-auto-scan-private-payments` itself once the home screen has already
          // rendered (see renderHome()), so this cost is never on the path to seeing a balance at
          // all -- least of all for a freshly created wallet, which can't have any private payment
          // history to find in the first place (see that handler's own doc comment).
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
 * newly discovered -- shared by `buildStatus()`'s opportunistic auto-scan, the manual
 * `popup-rescan-private-payments` handler, and the dApp-facing `tari_scanForPrivatePayments`/
 * `tari_claimPrivatePayment`, so a payment found by any of them shows up in History and not just in
 * the private balance. That matters most for the dApp path: a payment discovered by a site the user
 * granted view access to should leave the same visible trace in their own wallet as one they found
 * themselves. Best-effort per entry, matching `withHistory`'s own policy: one bad
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
      await setState({ vault, accountCount: 1, activeAccountId: localAccountId(0), walletOrigin: "created" });
      // getLocalAccount() caches by "network:index" alone, not by seed identity -- unreachable in
      // the normal flow (this case only shows when no wallet exists yet, i.e. the cache was never
      // populated), but a request racing a just-completed popup-reset-wallet could read the old
      // seed before its clearUnlockedSeed() and repopulate the cache after its clearAccountCache(),
      // leaving a stale entry from the *wiped* seed for this brand-new wallet to silently inherit.
      // Cheap enough to always clear here regardless of whether that race actually happened.
      clearAccountCache();
      await setUnlockedSeed(seed.entropy);
      return { mnemonic };
    }

    case "popup-import-wallet": {
      const seed = await importWalletSeed(message.mnemonic);
      const vault = await encryptVault(message.password, serializeSeed(seed));
      await setState({ vault, accountCount: 1, activeAccountId: localAccountId(0), walletOrigin: "imported" });
      // See popup-create-wallet's comment just above -- same stale-cache race, same fix.
      clearAccountCache();
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
      // The recipient only ever hands out their one main "otl_..." wallet address -- `send()`
      // derives the on-chain component address from it itself, and also needs the wallet address
      // (not just the derived address) to create that component on the fly if the recipient has
      // no prior on-chain activity yet (see OotleAccount.send()'s doc comment).
      return withHistory(
        {
          accountId: activeAccountId,
          kind: "send",
          resourceAddress: message.resourceAddress,
          amount: message.amount,
          counterparty: message.recipientWalletAddress,
        },
        () => account.send(message.recipientWalletAddress, message.resourceAddress, BigInt(message.amount))
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

    case "popup-auto-scan-private-payments": {
      // The popup's own opportunistic scan, triggered once the home screen is already showing
      // (see renderHome()) instead of blocking buildStatus() -- see that removal's comment for why.
      const account = await getActiveAccount();
      if (!account || !(account instanceof OotleAccount)) return { claimed: 0 };
      const { activeAccountId, walletOrigin } = await getState();
      const hasCursor = (await getPrivatePaymentScanCursor(activeAccountId)) !== null;
      // A wallet this extension generated cannot have received a private payment before the moment
      // it was created -- there is no seed, therefore no view key, therefore nothing to have been
      // encrypted to. Its first scan can use the same shallow window every later scan does. An
      // imported (or origin-unknown, pre-this-field) wallet's seed may be years old, so its first
      // scan alone gets the deep lookback -- scanForPrivatePayments()'s own default for exactly
      // this case. Only applies before a cursor exists; once one is written every scan is shallow
      // regardless of origin.
      const maxPages = !hasCursor && walletOrigin === "created" ? 3 : undefined;
      try {
        const { claimed, found } = await account.scanForPrivatePayments(maxPages);
        await recordPrivatePaymentHistory(activeAccountId, found);
        return { claimed };
      } catch {
        return { claimed: 0 }; // best-effort -- an indexer hiccup here shouldn't surface as an error the user has to dismiss
      }
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

    case "popup-revoke-site-view-access": {
      await setViewAccess(message.origin, false);
      return null;
    }

    case "popup-disconnect-site": {
      await removeConnectedSite(message.origin);
      return {};
    }

    case "popup-get-pending-approval":
      return getPendingApproval(message.approvalId) ?? null;

    case "popup-resolve-approval":
      return { resolved: await resolveApproval(message.approvalId, message.approve) };

    case "popup-reset-wallet": {
      await clearUnlockedSeed();
      clearAccountCache();
      resetKnownVersions();
      await wipeWallet();
      await wipeOotleState();
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
