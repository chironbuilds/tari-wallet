import {
  Network,
  TransactionBuilder,
  XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  XTR_FAUCET_COMPONENT_ADDRESS,
  XTR_FAUCET_VAULT_ADDRESS,
  amountLiteral,
  defaultIndexerUrl,
  getVaultIdsForAccount,
  resolveTransaction,
  resourceAddressLiteral,
  sealTransaction,
  sendTransaction,
  signTransaction,
} from "@tari-project/ootle";
import type { UnsignedTransactionWithBlobs } from "@tari-project/ootle";
import type {
  IndexerGetTransactionResultResponse,
  IndexerSubmitTransactionResponse,
  Instruction,
  Substate,
  SubstateRequirement,
} from "@tari-project/ootle-ts-bindings";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import type { WalletAccountApi } from "./accountApi";
import { deriveAccountComponentAddress } from "./componentAddress";
import { deriveAccountKeys } from "./derivation";
import { type NetworkName, toOotleNetwork } from "./ootleNetwork";

export interface TokenBalance {
  resourceAddress: string;
  kind: string; // "Fungible" | "NonFungible" | "Confidential" | "Stealth"
  amount: bigint;
  /** The resource's on-chain decimal precision (e.g. 6 for XTR, 8 for a typical DemoToken) —
   * a real `Resource.divisibility` field, not a guessed convention. */
  divisibility: number;
  /** The resource's `metadata.SYMBOL`, if it set one — null for a resource with no such metadata
   * key, in which case a caller should fall back to the address. */
  symbol: string | null;
  /** The resource's `metadata.name` (a longer display name, distinct from the ticker-style
   * `symbol`), if it set one — null otherwise. */
  name: string | null;
}

/**
 * One derived Ootle account: a signer (owner + view keypair) plus the network connection needed
 * to read its state and submit transactions, entirely independent of the wallet daemon.
 */
export class OotleAccount implements WalletAccountApi {
  readonly index: number;
  readonly network: Network;
  readonly signer: SecretKeyWallet;
  private provider: IndexerProvider | null = null;

  private constructor(index: number, network: Network, signer: SecretKeyWallet) {
    this.index = index;
    this.network = network;
    this.signer = signer;
  }

  static fromSeed(masterSeed: Uint8Array, index: number, networkName: NetworkName): OotleAccount {
    const network = toOotleNetwork(networkName);
    const { ownerSecret, viewSecret } = deriveAccountKeys(masterSeed, index);
    const signer = SecretKeyWallet.fromSecretKey(ownerSecret, network, viewSecret);
    return new OotleAccount(index, network, signer);
  }

  async getProvider(): Promise<IndexerProvider> {
    if (!this.provider) {
      this.provider = await IndexerProvider.connect({ url: defaultIndexerUrl(this.network), network: this.network });
    }
    return this.provider;
  }

  /**
   * The bech32m "otl_..." wallet address, for display / receiving funds. Confirmed (empirically,
   * against `generateOotleAddress`) to be what `Signer.getAddress()` actually returns for a
   * `SecretKeyWallet` — despite the base `Signer` interface's JSDoc calling it "the component
   * address", it is NOT the on-chain account component address. See `getComponentAddress()`.
   */
  async getWalletAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  async getPublicKey(): Promise<Uint8Array> {
    return this.signer.getPublicKey();
  }

  /**
   * The account's on-chain component address — what instructions use as the `account` argument
   * (deposit/withdraw/pay_fee/etc.) and what `getVaultIdsForAccount` needs to find balances.
   *
   * Computed client-side via `deriveAccountComponentAddress` (`componentAddress.ts`), which
   * reproduces Ootle's domain-separated Blake2b hash of (ACCOUNT_TEMPLATE_ADDRESS, owner_public_key)
   * byte-for-byte — verified against all three committed golden vectors from
   * `tari-ootle`'s `crates/ootle_sdk_core/fixtures/address_derive/`.
   */
  async getComponentAddress(): Promise<string> {
    const publicKey = await this.getPublicKey();
    return deriveAccountComponentAddress(publicKey);
  }

  async getBalances(): Promise<TokenBalance[]> {
    const provider = await this.getProvider();
    const account = await this.getComponentAddress();
    let vaultIds: string[];
    try {
      vaultIds = await withTimeout(getVaultIdsForAccount(provider, account), 15_000, "looking up this account's vaults");
    } catch {
      return []; // account not yet on-chain (never funded), or the lookup timed out
    }
    if (vaultIds.length === 0) return [];

    const { substates } = await withTimeout(provider.fetchSubstates(vaultIds), 15_000, "fetching vault balances");
    const parsed: { resourceAddress: string; kind: string; amount: bigint }[] = [];
    for (const id of vaultIds) {
      const substate: Substate | undefined = substates[id];
      const value = substate?.substate;
      if (!value || !("Vault" in value)) continue;
      const container = value.Vault.resource_container;
      const [kind, data] = Object.entries(container)[0] as [string, Record<string, unknown>];
      const rawAmount = (data.amount ?? data.revealed_amount ?? 0) as string | number | bigint;
      parsed.push({ resourceAddress: data.address as string, kind, amount: BigInt(rawAmount) });
    }
    if (parsed.length === 0) return [];

    // Batch-fetch each distinct resource's own substate for its real `divisibility` and metadata
    // symbol/name — decimal precision and display name are both on-chain data, not a client-side
    // guess (confirmed empirically: XTR is 6, a typical DemoToken defaults to 8, and assuming one
    // divisibility for both silently misprices trades by orders of magnitude).
    const resourceIds = [...new Set(parsed.map((p) => p.resourceAddress))];
    const { substates: resourceSubstates } = await withTimeout(provider.fetchSubstates(resourceIds), 15_000, "reading token decimal precision");
    const divisibilityByResource = new Map<string, number>();
    const symbolByResource = new Map<string, string | null>();
    const nameByResource = new Map<string, string | null>();
    for (const id of resourceIds) {
      const value = resourceSubstates[id]?.substate;
      const resource = value && "Resource" in value ? (value.Resource as { divisibility?: number; metadata?: Record<string, unknown> }) : undefined;
      divisibilityByResource.set(id, typeof resource?.divisibility === "number" ? resource.divisibility : 0);
      const metadata = resource?.metadata;
      symbolByResource.set(id, typeof metadata?.SYMBOL === "string" ? metadata.SYMBOL : null);
      nameByResource.set(id, typeof metadata?.name === "string" ? metadata.name : null);
    }

    const balances: TokenBalance[] = parsed.map((p) => ({
      ...p,
      divisibility: divisibilityByResource.get(p.resourceAddress) ?? 0,
      symbol: symbolByResource.get(p.resourceAddress) ?? null,
      name: nameByResource.get(p.resourceAddress) ?? null,
    }));
    return balances;
  }

  /**
   * Builds, signs (with this account's key) and submits/dry-runs a transaction. `opts.inputs` lets
   * a caller pre-pin substates it already knows are needed; beyond that, this indexer requires
   * *every* substate an instruction touches to be listed as an input — even ones referenced only
   * by address in a `CallMethod` on an already-existing component (confirmed empirically, first
   * with the faucet, and again with this account's own existing component when calling into it for
   * a `pay_fee`/`deposit`/`withdraw` on a second use) — and there's no want-derivation pass in this
   * TS SDK to discover that dependency graph up front the way the Rust `ootle_sdk_core` can.
   *
   * Rather than hand-tracing each call's full component/vault graph, this retries on the specific
   * rejection the engine itself gives for a missing input — "At instruction #N: <address> not
   * found" — extracting that address, resolving its current version, adding it to the pinned
   * inputs, and resubmitting. Each retry can surface a *different* missing address (a component's
   * vaults are only discoverable after the component itself is known), so this loops until either
   * success or the same address reappears (nothing new left to resolve). The version-race retry
   * `claimTestnetXtr()` needs for a heavily-contended shared substate is folded in too.
   */
  async execute(
    instructions: Instruction[],
    opts: { maxFee?: bigint; dryRun?: boolean; inputs?: SubstateRequirement[]; maxRetries?: number } = {}
  ) {
    const provider = await this.getProvider();
    const account = await this.getComponentAddress();
    const maxFee = opts.maxFee ?? 5000n;
    const maxRetries = opts.maxRetries ?? 20;
    const seenAddresses = new Set<string>();
    let inputs = await applyKnownVersions(opts.inputs ? [...opts.inputs] : []);

    for (let attempt = 0; ; attempt++) {
      const builder = TransactionBuilder.new(this.network).withInstructions(instructions).feeTransactionPayFromComponent(account, maxFee);
      if (inputs.length) builder.withInputs(inputs);
      const unsignedTx = builder.buildUnsignedTransaction();

      try {
        if (opts.dryRun) return await withTimeout(this.submitDryRun(provider, unsignedTx), 30_000, "submitting the transaction");
        const result = await withTimeout(this.submitReal(provider, unsignedTx), 60_000, "submitting the transaction");
        await recordKnownVersions(result);
        return result;
      } catch (e) {
        if (!(e instanceof Error) || attempt >= maxRetries) throw e;

        // No amount of retrying fixes an empty fee vault — surface this immediately instead of
        // burning the retry budget re-discovering the same "insufficient balance" outcome.
        if (e.message.includes("InsufficientFeesPaid") || /insufficient/i.test(e.message)) {
          throw new Error(`This account doesn't have enough XTR to pay the transaction fee. Claim testnet XTR first. (${e.message})`);
        }

        if (e.message.includes("Lock failure")) {
          // A "Lock failure: Substate X:N is DOWN" names the *exact* version that was just
          // consumed — the next version is deterministically N+1, computable locally with no
          // network round trip. This matters: re-querying the indexer here (the previous
          // approach) can hand back the very same stale N again, and worse, this loop's *own*
          // prior attempt can have advanced the real version further still if it reached and paid
          // the fee phase before its main instructions failed (`AcceptFeeRejectRest` still commits
          // the fee) — so trusting a fresh `resolveInputs()` call to have caught up is exactly the
          // race that was producing an apparently-stuck version across many retries.
          const staleVersion = extractStaleLockVersion(e.message);
          if (staleVersion) {
            inputs = inputs.map((input) =>
              input.substate_id === staleVersion.substateId ? { ...input, version: staleVersion.version + 1 } : input
            );
            continue;
          }
          const resolved = await withTimeout(
            provider.resolveInputs(inputs.map(({ substate_id }) => ({ substate_id, version: null }))),
            15_000,
            "refreshing input versions"
          );
          inputs = await applyKnownVersions(resolved);
          continue;
        }

        const missing = extractMissingSubstateAddress(e.message);
        if (!missing || seenAddresses.has(missing)) throw e;
        seenAddresses.add(missing);
        const [resolved] = await withTimeout(provider.resolveInputs([{ substate_id: missing, version: null }]), 15_000, "resolving a missing input");
        inputs = await applyKnownVersions([...inputs, resolved!]);
      }
    }
  }

  /**
   * A working replacement for the SDK's exported `sendDryRun()`, which is broken against this
   * indexer: it builds the identical signed/sealed envelope but POSTs it to the regular
   * `transactions` endpoint, which rejects dry-run envelopes with "Dry-run transactions must be
   * submitted to the /transactions/dry-run endpoint" (confirmed empirically). This reproduces
   * `sendDryRun`'s own pipeline — set `dry_run`, `resolveTransaction`, `signTransaction`,
   * `sealTransaction` (all exported, same functions it uses internally) — but posts the sealed
   * envelope to the correct path via the indexer client's transport directly. Dry-run responses
   * come back synchronously with the full result already attached (no `transactions/{id}/result`
   * polling needed, unlike a real submission).
   */
  private async submitDryRun(provider: IndexerProvider, unsignedTx: UnsignedTransactionWithBlobs): Promise<IndexerSubmitTransactionResponse> {
    const resolved = await resolveTransaction(provider, { ...unsignedTx, dry_run: true });
    const signed = await signTransaction([this.signer], resolved);
    const envelope = sealTransaction(signed);
    const res = await fetch(`${defaultIndexerUrl(this.network)}/transactions/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `TransactionEnvelope` (ootle-ts-bindings) is just `string` — the request body is the
      // `{ transaction }` wrapper (`IndexerSubmitTransactionRequest`), not the bare envelope string.
      body: JSON.stringify({ transaction: envelope }),
    });
    const text = await res.text();
    let body: { error?: { code: string; message: string } } | undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON — fall through and report the raw text below.
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? text ?? res.statusText}`);
    if (body?.error) throw new Error(`${body.error.code}: ${body.error.message}`);
    const response = body as IndexerSubmitTransactionResponse;

    // A rejected dry-run comes back as a normal HTTP 200 with the rejection embedded in the
    // result (there's nothing to poll — dry runs never reach consensus). Throwing here, in the
    // same "Transaction {id} was rejected: {reason}" shape `sendTransaction`'s own polling throws
    // in, means `execute()`'s retry loop only needs one error-handling path for both. Two failure
    // variants matter: a clean `Reject`, and `AcceptFeeRejectRest` (the fee phase succeeded — it
    // only touches the account, which by definition already resolved — but the *main* instructions
    // aborted, confirmed empirically hitting this on a first read of the DEX pool: the fee-only
    // success masked the "pool component not found" this same regex needs to see to retry).
    const outcome = response.result.finalize.result;
    if (typeof outcome === "object" && outcome !== null) {
      if ("Reject" in outcome) {
        throw new Error(`Transaction ${response.transaction_id} was rejected: ${JSON.stringify(outcome.Reject)}`);
      }
      if ("AcceptFeeRejectRest" in outcome) {
        throw new Error(
          `Transaction ${response.transaction_id} accepted the fee but rejected the rest: ${JSON.stringify(outcome.AcceptFeeRejectRest)}`
        );
      }
    }
    return response;
  }

  /**
   * A working replacement for the SDK's exported `sendTransaction()`. That function still submits
   * correctly, but its own polling (`ct()`/`st()` internally) only surfaces a generic
   * `abort_details` summary on rejection — not the full structured `RejectReason`/`SubstateDiff`
   * this class's auto-resolve retry (see `execute()`) needs to find a missing substate's address
   * in. Confirmed empirically: a real submission that hit "SubstateNotFound: vault_... not found"
   * came back from `sendTransaction()` with no address in the thrown message at all, so the retry
   * loop had nothing to extract and gave up on the first attempt — the exact failure this method
   * exists to fix. Submission itself (`provider.submitTransaction`) is unchanged and already
   * proven correct; only the result-polling and error-message construction are reimplemented, in
   * the same detailed shape `submitDryRun()` above already produces.
   */
  private async submitReal(provider: IndexerProvider, unsignedTx: UnsignedTransactionWithBlobs): Promise<IndexerGetTransactionResultResponse> {
    const resolved = await resolveTransaction(provider, unsignedTx);
    const signed = await signTransaction([this.signer], resolved);
    const envelope = sealTransaction(signed);
    const { transaction_id } = await provider.submitTransaction(envelope);

    const deadline = Date.now() + 60_000;
    for (;;) {
      const response = await provider.getTransactionResult(transaction_id);
      const result = response.result;
      if (result === "Pending") {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for transaction ${transaction_id} to finalize.`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if ("Rejected" in result) {
        throw new Error(`Transaction ${transaction_id} was rejected: ${result.Rejected.details}`);
      }
      const outcome = result.Finalized.execution_result?.finalize.result;
      if (outcome && typeof outcome === "object") {
        if ("Reject" in outcome) {
          throw new Error(`Transaction ${transaction_id} was rejected: ${JSON.stringify(outcome.Reject)}`);
        }
        if ("AcceptFeeRejectRest" in outcome) {
          throw new Error(`Transaction ${transaction_id} accepted the fee but rejected the rest: ${JSON.stringify(outcome.AcceptFeeRejectRest)}`);
        }
      }
      return response;
    }
  }

  /**
   * Transfers `amount` (raw, resource-native units) of `resourceAddress` from this account to
   * `recipientAddress` — a plain `withdraw` off this account's own vault, handed straight to
   * `deposit` on the recipient's account component via a workspace bucket, in one transaction.
   * Works for any resource this account holds, including XTR; `execute()`'s auto-resolve retry
   * (see its own doc comment) discovers and pins whichever vaults/components aren't already
   * known, exactly as it does for every other instruction this class builds by hand.
   */
  async send(recipientAddress: string, resourceAddress: string, amount: bigint, maxFee = 5000n) {
    const account = await this.getComponentAddress();
    const instructions: Instruction[] = [
      { CallMethod: { call: { Address: account }, method: "withdraw", args: [resourceAddressLiteral(resourceAddress), amountLiteral(amount)] } },
      { PutLastInstructionOutputOnWorkspace: { key: 0 } },
      { CallMethod: { call: { Address: recipientAddress }, method: "deposit", args: [{ Workspace: { id: 0, offset: null } }] } },
    ];
    return this.execute(instructions, { maxFee });
  }

  /**
   * Claims free testnet XTR from the network's builtin faucet (esmeralda/igor only — there is no
   * such faucet on mainnet). Mirrors both `build_faucet_claim_with_wants` in tari-ootle's
   * `crates/ootle_sdk_core/src/faucet.rs` and (confirmed against its actual pinned-input list)
   * `handle_create_free_test_coins` in `applications/tari_walletd/src/handlers/accounts.rs` — the
   * handler backing the `accounts.create_free_test_coins` walletd RPC that tari-dex's swap-ui
   * calls. Self-funding, so it works even for a brand-new account that doesn't exist on-chain yet:
   * the fee phase itself creates the account, funds it from the faucet
   * (`XTR_FAUCET_COMPONENT_ADDRESS.take(account)`), then pays its own fee out of what it just
   * received.
   *
   * Unlike every other component this class calls, none of the faucet's substates (component,
   * vault, claim resource) get auto-resolved from the instructions by this indexer — each has to
   * be pinned as an explicit transaction input (confirmed empirically: submitting with only the
   * claim resource pinned rejected with "component_...0000 not found" at the `take` call).
   * `provider.resolveInputs()` fills in each one's current version.
   *
   * The faucet vault is a single shared substate every claimant on the testnet contends for, so
   * the version pinned by `resolveInputs()` routinely goes stale between resolution and consensus
   * (confirmed empirically: "Lock failure: Substate vault_...:8 is DOWN" — someone else's claim
   * landed first). This isn't a bug to fix, just contention to ride out: catch that specific
   * rejection and retry with freshly-resolved versions and a new transaction id.
   */
  async claimTestnetXtr(maxFee = 5000n, retries = 4) {
    const provider = await this.getProvider();
    const publicKeyHex = bytesToHex(await this.getPublicKey());
    const account = await this.getComponentAddress();

    for (let attempt = 0; ; attempt++) {
      const inputs = await withTimeout(
        provider.resolveInputs([
          { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null },
          { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null },
          { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null },
        ]),
        15_000,
        "resolving the faucet's current state"
      );

      const unsignedTx = TransactionBuilder.new(this.network)
        .withFeeInstructionsBuilder((b) =>
          b
            .createAccount(publicKeyHex)
            .saveVar("faucet_account")
            .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: "take" }, [{ Workspace: "faucet_account" }])
        )
        .feeTransactionPayFromComponent(account, maxFee)
        .withInputs(inputs)
        .buildUnsignedTransaction();

      try {
        const result = await withTimeout(sendTransaction(provider, this.signer, unsignedTx), 30_000, "submitting the claim");
        // This is typically the first transaction for a brand-new account — recording its
        // resulting versions (the newly-created fee vault included) closes the exact gap that
        // otherwise bites the *next* transaction (see `applyKnownVersions`'s doc comment).
        await recordKnownVersions(result);
        return result;
      } catch (e) {
        const isStaleVersionRace = e instanceof Error && e.message.includes("Lock failure");
        if (!isStaleVersionRace || attempt >= retries) throw e;
      }
    }
  }
}

// The indexer's own view of a substate an account keeps touching (above all its own fee vault,
// referenced by nearly every transaction) can lag behind the version our *own* just-confirmed
// transaction produced — confirmed empirically: even a brand-new account, on its second-ever
// transaction, got "Lock failure: vault:1 is DOWN" from `resolveInputs()` handing back version 1
// when the true current version (from our own prior transaction's `up_substates`) was already
// higher, and this reproduced identically across multiple fresh accounts and reloads. A stateful
// wallet daemon avoids this because it tracks its own substate versions locally instead of
// re-asking a remote indexer for state it just changed itself. This is that same idea — persisted
// to `chrome.storage.local` (not just an in-memory Map) specifically because an in-memory-only
// cache loses exactly the knowledge that matters most across a service-worker restart or
// extension reload, which is the scenario this was written to fix.
const KNOWN_VERSIONS_STORAGE_KEY = "knownSubstateVersions";
let knownVersionsPromise: Promise<Map<string, number>> | null = null;

async function loadKnownVersions(): Promise<Map<string, number>> {
  if (!knownVersionsPromise) {
    knownVersionsPromise = chrome.storage.local.get(KNOWN_VERSIONS_STORAGE_KEY).then((stored) => {
      const raw = (stored[KNOWN_VERSIONS_STORAGE_KEY] ?? {}) as Record<string, number>;
      return new Map(Object.entries(raw));
    });
  }
  return knownVersionsPromise;
}

/** Prefers our own record of a substate's version over whatever the indexer just reported, when
 * we have a newer one — see the block comment above for why. */
async function applyKnownVersions(inputs: SubstateRequirement[]): Promise<SubstateRequirement[]> {
  const known = await loadKnownVersions();
  return inputs.map((input) => {
    const version = known.get(input.substate_id);
    return version !== undefined && (input.version === null || version > input.version) ? { ...input, version } : input;
  });
}

/** Remembers the post-transaction version of every substate a *confirmed* (never a dry-run —
 * those don't reflect real state) transaction touched, so the next transaction that references
 * one of them doesn't have to trust the indexer's possibly-stale view of it. */
async function recordKnownVersions(response: IndexerGetTransactionResultResponse): Promise<void> {
  const result = response.result;
  if (result === "Pending" || "Rejected" in result) return;
  const outcome = result.Finalized.execution_result?.finalize.result;
  const upSubstates =
    outcome && typeof outcome === "object" && "Accept" in outcome
      ? outcome.Accept.up_substates
      : outcome && typeof outcome === "object" && "AcceptFeeRejectRest" in outcome
        ? outcome.AcceptFeeRejectRest[0].up_substates
        : undefined;
  if (!upSubstates || upSubstates.length === 0) return;

  const known = await loadKnownVersions();
  for (const [id, substate] of upSubstates) known.set(id, substate.version);
  await chrome.storage.local.set({ [KNOWN_VERSIONS_STORAGE_KEY]: Object.fromEntries(known) });
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

// A hung fetch (or any other network stall) inside a page-triggered request otherwise blocks that
// page's promise forever with no error and no way to recover short of reloading the extension —
// confirmed empirically hitting exactly this waiting on a testnet indexer response. Every
// individual network step in execute()'s retry loop is wrapped in this so a stall surfaces as a
// clear timeout error instead of an indefinite hang.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms while ${label}.`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Matches the address this engine names in a "not found" rejection. Confirmed two distinct
// phrasings for what is structurally the same SubstateNotFound rejection, depending on *how* the
// missing reference was hit: a plain call-target miss reads "At instruction #1: component_...
// not found" (address before the phrase), while a template-internal reference (e.g. a confidential
// vault's withdraw() needing an extra substate the instructions never named directly) reads
// "...Template referenced substate but it was not found: resource_..." (address after). A
// cross-template call (e.g. the DEX router calling into a pool component internally) reads
// "Substate 'component_...' not found or is not a transaction input" — address quoted, so the
// optional `['"]?` matters: without it, the quote character sits between the address and "not
// found" and the whitespace-only pattern silently fails to match. Any of the `<kind>_<hex>`
// address forms this SDK uses (component/resource/vault/transaction_receipt/...), always hex
// after the last `_`.
const MISSING_SUBSTATE_PATTERNS = [
  /\b([a-z_]+_[0-9a-f]{16,})['"]?\s+not found\b/i,
  /not found:\s*([a-z_]+_[0-9a-f]{16,})\b/i,
];

function extractMissingSubstateAddress(message: string): string | null {
  for (const pattern of MISSING_SUBSTATE_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return match[1]!;
  }
  return null;
}

// Matches "Lock failure: Substate <id>:<version> is DOWN" — the exact substate and version that
// was just consumed, letting the caller compute the next version (version + 1) deterministically
// instead of re-querying a possibly-still-lagging indexer.
const STALE_LOCK_PATTERN = /Substate ([a-z_]+_[0-9a-f]{16,}):(\d+) is DOWN/i;

function extractStaleLockVersion(message: string): { substateId: string; version: number } | null {
  const match = STALE_LOCK_PATTERN.exec(message);
  return match ? { substateId: match[1]!, version: Number(match[2]) } : null;
}
