import {
  Network,
  OotleWallet,
  StealthTransfer,
  TransactionBuilder,
  WalletStealthAuthorizer,
  WasmStealthCrypto,
  XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  XTR_FAUCET_COMPONENT_ADDRESS,
  XTR_FAUCET_VAULT_ADDRESS,
  amountLiteral,
  createOutput,
  decryptOwnedUtxo,
  defaultIndexerUrl,
  getVaultIdsForAccount,
  resolveTransaction,
  resourceAddressLiteral,
  sealTransaction,
  sendTransaction,
  signTransaction,
  stealthUtxoSubstateId,
  submitTransaction,
} from "@tari-project/ootle";
import type { StealthTransferSpec, UnsignedTransactionWithBlobs } from "@tari-project/ootle";
import type {
  IndexerGetTransactionResultResponse,
  IndexerSubmitTransactionResponse,
  Instruction,
  Memo,
  OutputBody,
  Substate,
  SubstateRequirement,
} from "@tari-project/ootle-ts-bindings";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { parseOotleAddress } from "@tari-project/ootle-wasm";
import type { WalletAccountApi } from "./accountApi";
import { deriveAccountComponentAddress } from "./componentAddress";
import { scanTransactionsForOwnedOutputs, sumConfidentialCommitments } from "./confidential";
import type { ScannedStealthOutput } from "./confidential";
import { deriveAccountKeys } from "./derivation";
import { htlcConditions } from "./htlc";
import { type NetworkName, toOotleNetwork } from "./ootleNetwork";
import {
  addPendingShield,
  addShieldedOutput,
  getPrivatePaymentScanCursor,
  listPendingShields,
  listShieldedOutputs,
  localAccountId,
  markShieldedOutputSpent,
  removePendingShield,
  setPrivatePaymentScanCursor,
} from "./storage";
import type { ShieldedOutputRecord } from "./storage";
import { withTimeout } from "./timeout";
import { fromHex, toHex } from "./vault";

export interface TokenBalance {
  resourceAddress: string;
  kind: string; // "Fungible" | "NonFungible" | "Confidential" | "Stealth"
  /** The plain, public (revealed) amount — what this vault shows on-chain to anyone. */
  amount: bigint;
  /** Value hidden inside this vault's Pedersen commitments, decrypted with this account's own
   * view key (see confidential.ts) — 0n for every kind except Confidential, and for a
   * Confidential vault with no commitments. Never requires a network call beyond what
   * getBalances() already fetches. */
  confidentialAmount: bigint;
  /** Commitments that failed to decrypt against this account's view key. Expected to be 0 for a
   * vault's own commitments map (every entry there should be ours) — nonzero is worth surfacing,
   * not silently swallowing. */
  confidentialDecryptFailures: number;
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
 * `Output.memo`/`OutputInit.memo` is typed `object` in `@tari-project/ootle` (untyped there), but
 * is actually the tagged `Memo` union from `@tari-project/ootle-ts-bindings` -- confirmed by
 * reading that package's generated `Memo.d.ts` directly rather than assuming the Rust SDK docs'
 * `.with_memo_message(...)` name maps 1:1 onto this TS binding. `{ Message: text }` is the plain
 * free-text variant; the other variants (`U256`, `Bytes`, `PayRefAndBytes`) aren't used by this
 * wallet's UI, which only ever offers a plain text note.
 */
function toMemo(memo: string | undefined): Memo | undefined {
  return memo ? { Message: memo } : undefined;
}

/**
 * Inverse of `toMemo()`, for a *received* output: `DecryptedData.memo` (confidential.ts's
 * `ScannedStealthOutput.memo`, `claimPrivatePayment()`'s decrypt result) is the raw JSON-encoded
 * `Memo` union string, not plain text -- confirmed against the SDK's own `DecryptedData` doc
 * comment, not assumed. This wallet only ever creates `Message` memos, but a payment from a
 * different sender/tool could use any variant -- render something readable for those instead of
 * leaking raw JSON or silently dropping the memo. Returns `undefined` for no memo, an unparseable
 * value, or an empty `Message`.
 */
function fromMemo(memoJson: string | undefined): string | undefined {
  if (!memoJson) return undefined;
  try {
    const memo = JSON.parse(memoJson) as Memo;
    if ("Message" in memo) return memo.Message || undefined;
    if ("SenderAddress" in memo) return `From: ${memo.SenderAddress}`;
    const [kind, value] = Object.entries(memo)[0] as [string, string];
    return `[${kind} memo: ${value}]`;
  } catch {
    return undefined;
  }
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

  /** `entropy` is the 16-byte CipherSeed entropy (see cipherSeed.ts), not a raw 32-byte seed. */
  static fromSeed(entropy: Uint8Array, index: number, networkName: NetworkName): OotleAccount {
    const network = toOotleNetwork(networkName);
    const { ownerSecret, viewSecret } = deriveAccountKeys(entropy, index);
    const signer = SecretKeyWallet.fromSecretKey(ownerSecret, network, viewSecret);
    return new OotleAccount(index, network, signer);
  }

  async getProvider(): Promise<IndexerProvider> {
    if (!this.provider) {
      // Nothing has run yet at this point, so any failure here is by definition a connectivity
      // problem (unlike execute()'s later errors, which are meaningful on-chain rejections this
      // class deliberately leaves unwrapped) — mirrors the same "unreachable" framing
      // DaemonAccount.connectClient() uses for the equivalent first-contact step.
      const url = defaultIndexerUrl(this.network);
      try {
        this.provider = await withTimeout(
          IndexerProvider.connect({ url, network: this.network }),
          15_000,
          "connecting to the Tari indexer"
        );
      } catch (e) {
        const details = e instanceof Error ? e.message : String(e);
        throw new Error(`Could not reach the Tari indexer at ${url}. (${details})`);
      }
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
    } catch (e) {
      // A real timeout here (the indexer connection above already succeeded, so this specifically
      // means it's up but slow/overloaded) must not look identical to "this account genuinely has
      // no vaults yet" — silently mapping both to an empty balance list would show a brand-new
      // account and a degraded-indexer account the exact same way, with no indication anything's
      // actually wrong in the latter case.
      if (e instanceof Error && e.message.startsWith("Timed out")) throw e;
      return []; // account not yet on-chain (never funded)
    }

    // Fold in this account's own known-good stealth outputs (from shield()/unshield(), or from
    // redeeming someone else's shared commitment via the "Advanced" unshield flow) up front, not
    // gated behind a vault existing -- see ShieldedOutputRecord's doc comment for why this local
    // ledger is the only lead to them at all: they're freestanding `utxo_{resource}_{commitment}`
    // substates, never entries in a vault's own `Confidential.commitments` map, so nothing below
    // this point would otherwise see them. A resource whose *only* balance came from redeeming a
    // shared commitment has no on-chain vault at all (`vaultIds.length === 0` for it), so this
    // can't be computed only after confirming a vault exists.
    const shieldedByResource = new Map<string, bigint>();
    for (const record of await listShieldedOutputs(localAccountId(this.index))) {
      if (record.spent) continue;
      shieldedByResource.set(record.resourceAddress, (shieldedByResource.get(record.resourceAddress) ?? 0n) + BigInt(record.amount));
    }
    if (vaultIds.length === 0 && shieldedByResource.size === 0) return [];

    const parsed: { resourceAddress: string; kind: string; amount: bigint; commitments?: Record<string, OutputBody> }[] = [];
    if (vaultIds.length > 0) {
      const { substates } = await withTimeout(provider.fetchSubstates(vaultIds), 15_000, "fetching vault balances");
      for (const id of vaultIds) {
        const substate: Substate | undefined = substates[id];
        const value = substate?.substate;
        if (!value || !("Vault" in value)) continue;
        const container = value.Vault.resource_container;
        const [kind, data] = Object.entries(container)[0] as [string, Record<string, unknown>];
        const rawAmount = (data.amount ?? data.revealed_amount ?? 0) as string | number | bigint;
        const commitments = kind === "Confidential" ? (data.commitments as Record<string, OutputBody> | undefined) : undefined;
        parsed.push({ resourceAddress: data.address as string, kind, amount: BigInt(rawAmount), commitments });
      }
    }
    if (parsed.length === 0 && shieldedByResource.size === 0) return [];

    // Decrypt each Confidential vault's hidden commitments with this account's own view key —
    // pure local decryption of data already fetched above, no new network calls. One crypto
    // provider + one view-secret fetch is reused across every confidential vault in this
    // account rather than re-deriving per vault.
    const confidentialByIndex = new Map<number, { total: bigint; failedCount: number }>();
    const hasConfidential = parsed.some((p) => p.commitments && Object.keys(p.commitments).length > 0);
    if (hasConfidential) {
      const crypto = new WasmStealthCrypto(this.network);
      const viewSecret = await this.signer.getViewSecret();
      for (const [i, p] of parsed.entries()) {
        const commitments = p.commitments;
        if (!commitments || Object.keys(commitments).length === 0) continue;
        confidentialByIndex.set(i, await sumConfidentialCommitments(crypto, viewSecret, commitments));
      }
    }

    // Batch-fetch each distinct resource's own substate for its real `divisibility` and metadata
    // symbol/name — decimal precision and display name are both on-chain data, not a client-side
    // guess (confirmed empirically: XTR is 6, a typical DemoToken defaults to 8, and assuming one
    // divisibility for both silently misprices trades by orders of magnitude).
    // Union with shielded-only resources (computed up front, before the vault check above) so a
    // resource with no vault at all still gets its real divisibility/symbol/name looked up.
    const resourceIds = [...new Set([...parsed.map((p) => p.resourceAddress), ...shieldedByResource.keys()])];
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

    const balances: TokenBalance[] = parsed.map((p, i) => ({
      resourceAddress: p.resourceAddress,
      kind: p.kind,
      amount: p.amount,
      confidentialAmount: (confidentialByIndex.get(i)?.total ?? 0n) + (shieldedByResource.get(p.resourceAddress) ?? 0n),
      confidentialDecryptFailures: confidentialByIndex.get(i)?.failedCount ?? 0,
      divisibility: divisibilityByResource.get(p.resourceAddress) ?? 0,
      symbol: symbolByResource.get(p.resourceAddress) ?? null,
      name: nameByResource.get(p.resourceAddress) ?? null,
    }));

    // Resources whose only balance is a shielded output with no on-chain vault at all (e.g.
    // redeemed via the "Advanced" unshield flow from someone else's shared commitment) never
    // appear in `parsed` above -- synthesize an entry for each so they aren't silently dropped.
    balances.push(
      ...synthesizeShieldedOnlyBalances(
        new Set(parsed.map((p) => p.resourceAddress)),
        shieldedByResource,
        divisibilityByResource,
        symbolByResource,
        nameByResource,
      ),
    );
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
    // A first-time transaction into brand-new resources needs one retry per previously-unknown
    // substate it discovers (each pool, each pool's own internal vaults, and any new vault the
    // account itself needs created to hold a token it's never held before) — confirmed empirically
    // that a single-hop swap into a new resource needed more than the original budget of 12, and a
    // routed (multi-hop) swap touches roughly double the substates a direct one does (two pools
    // instead of one, up to two new account vaults instead of one for the intermediate *and* final
    // tokens) — hit exactly this exhausting 20 on a real 2-hop swap.
    const maxRetries = opts.maxRetries ?? 30;
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
    return pollTransactionResult(provider, transaction_id);
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
   *
   * Retries back off (`retryDelayMs * (attempt + 1)`, so 300ms, 600ms, 900ms, ...) rather than
   * resubmitting back-to-back: confirmed empirically that hammering `resolveInputs()` immediately
   * after a rejection can keep handing back the same already-stale version every time (the
   * indexer's own view of a shared, heavily-contended substate can lag behind consensus by more
   * than one round trip takes) — a short, growing pause gives that view time to catch up instead
   * of burning the whole retry budget re-observing the same stale state.
   */
  async claimTestnetXtr(maxFee = 5000n, retries = 10, retryDelayMs = 300) {
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
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      }
    }
  }

  /**
   * Shields (moves from revealed to private/confidential) `amount` of `resourceAddress`, held as
   * a new stealth output owned by this same account. Uses an entirely separate submission
   * pipeline from `execute()`: the SDK's `StealthTransfer` builder produces its own
   * `TransactionEnvelope` directly (via `WalletStealthAuthorizer`/`AuthorizedTransfer`), not
   * through `TransactionBuilder`/`resolveTransaction`/`signTransaction`/`sealTransaction`.
   *
   * The one genuinely new failure mode this adds beyond `send()`: if the extension's service
   * worker is killed *after* the transaction finalizes on-chain but *before* the resulting
   * commitment is written to storage, the shield succeeds financially but the wallet loses its
   * only lead back to that output — worse than a failed `send()`, whose destination is always a
   * known component address. `pendingShieldTransactionIds` (written before polling, cleared only
   * after the commitment record is stored) narrows that window to "killed between finalization
   * and one storage write" and gives `recoverPendingShields()` (background/index.ts) something
   * to reconcile on next launch.
   *
   * `maxFee` defaults far higher than `send()`'s 5000 -- confirmed live that 5000 gets
   * "AcceptFeeRejectRest" with `ExecutionFailure: "Insufficient fees to fund native
   * verification"` (the stealth balance proof / range proof verification costs real compute
   * points beyond the engine's free grace allowance). Unused fee is refunded on success, so
   * erring high just wastes nothing; erring low burns the small fee-intent cost with nothing to
   * show for it, since only the fee half of the transaction gets committed.
   */
  async shield(resourceAddress: string, amount: bigint, maxFee = 50000n, memo?: string): Promise<{ transactionId: string }> {
    const accountId = localAccountId(this.index);
    const provider = await this.getProvider();
    const account = await this.getComponentAddress();
    // Output.destination decodes as a bech32m wallet address (owner_key + view_key), NOT the
    // on-chain component address -- passing `account` here throws "Bech32 decode error" (confirmed
    // live). See getWalletAddress()'s doc comment for why these two addresses are easy to conflate.
    const walletAddress = await this.getWalletAddress();

    const spec = await new StealthTransfer(provider, resourceAddress)
      // StealthTransfer.prepare() auto-adds the revealed account's own substate and any vault
      // addresses embedded in its on-chain state, but never the resource's own substate -- fine
      // for XTR (resource_0101...0101 is engine-special-cased and needs no lock), but any other
      // resource's instructions fail with "SubstateNotFound: resource_... not found" at
      // instruction #1 without it explicitly pinned here. Confirmed directly against prepare()'s
      // source (node_modules/@tari-project/ootle/dist/index.js) -- not assumed from the docs.
      .withBuilder((b) => b.addInput({ substate_id: resourceAddress, version: null }))
      .spendRevealedInput(account, amount)
      .toStealthOutput(createOutput({ destination: walletAddress, amount, resourceAddress, memo: toMemo(memo) }))
      .payFeeFromRevealed(maxFee)
      .prepare();
    const ownCommitment = extractOutputCommitment(spec, 0);

    const wallet = new OotleWallet().registerKeyProvider(account, this.signer).setDefaultSigner(account);
    // No stealth inputs to unblind for a shield (revealed-only source), so no viewSecret needed.
    // `fromSpec`'s own default crypto is `new WasmStealthCrypto()` -- Network.LocalNet, NOT this
    // account's real network -- which produced an "Invalid transaction signature" server-side
    // rejection (confirmed live) since the balance proof it computes is network-domain-separated.
    // Must match the network StealthTransfer itself used when it built the outputs statement.
    const authorized = await WalletStealthAuthorizer.fromSpec(wallet, spec, { crypto: new WasmStealthCrypto(this.network) }).prepare(
      provider
    );
    const envelope = await authorized.seal();
    const transactionId = await submitTransaction(provider, envelope);

    await addPendingShield({ transactionId, accountId, resourceAddress, amount: amount.toString(), ownCommitment, memo });
    try {
      const response = await withTimeout(pollTransactionResult(provider, transactionId), 60_000, "submitting the shield transaction");
      await recordKnownVersions(response);
      await recordKnownShieldedOutput(accountId, resourceAddress, ownCommitment, amount, transactionId, memo);
    } finally {
      await removePendingShield(transactionId);
    }
    return { transactionId };
  }

  /**
   * Unshields (moves from private/confidential back to revealed) `revealedOutAmount` of this
   * account's shielded balance for `resourceAddress` — see `ShieldedOutputRecord`'s doc comment
   * for why a known local record is the only way to spend one (no client-side scan-by-view-key
   * API exists for stealth UTXOs). Which specific output(s) to spend is decided internally by
   * `resolveUnshieldPlan`'s coin selection (largest-first, spending more than one in the same
   * transaction via repeated `spendStealthInput()` calls if a single output isn't enough) — the
   * caller only supplies an amount, not a commitment.
   *
   * Two `StealthTransfer` builder requirements, confirmed directly against its `validate()`/
   * `emitInstructions()` source (not assumed from the docs alone), shape this method:
   *
   * 1. `toRevealedOutput`/`payFeeFromRevealed` both require a revealed source account already
   *    registered via `spendRevealedInput`, which itself requires an amount `> 0` — there is no
   *    way to register just the account without withdrawing something. This method withdraws a
   *    trivial `1n`-unit "dust" amount for that sole purpose and folds it straight back into the
   *    revealed output (`revealedOutAmount + 1n`), so it costs nothing beyond the tx fee.
   * 2. The builder always requires at least one stealth output — a "pure" 100%-revealed spend
   *    with zero private remainder cannot be constructed in one step. This method always creates
   *    a new stealth output for the selected inputs' total minus `revealedOutAmount` back to this
   *    same account, so `resolveUnshieldPlan` guarantees that remainder is always `> 0`.
   *
   * Shares `shield()`'s mid-flight crash safety: the pending-shield ledger entry carries
   * `spentCommitments` so `recoverPendingShields()` can both record the new change output *and*
   * mark the spent ones, even if the service worker dies between finalization and the storage
   * writes.
   */
  async unshield(resourceAddress: string, revealedOutAmount: bigint, maxFee = 100000n, memo?: string): Promise<{ transactionId: string }> {
    const accountId = localAccountId(this.index);
    const records = await listShieldedOutputs(accountId);
    const { commitments, remainder } = resolveUnshieldPlan(records, resourceAddress, revealedOutAmount);
    const dust = 1n;

    const provider = await this.getProvider();
    const account = await this.getComponentAddress();
    // See shield()'s comment: Output.destination needs the bech32m wallet address, not the
    // on-chain component address.
    const walletAddress = await this.getWalletAddress();

    // See shield()'s comment: the resource's own substate must be pinned explicitly -- prepare()
    // never adds it on its own.
    let builder = new StealthTransfer(provider, resourceAddress)
      .withBuilder((b) => b.addInput({ substate_id: resourceAddress, version: null }))
      .spendRevealedInput(account, dust);
    for (const commitment of commitments) {
      builder = builder.spendStealthInput(account, fromHex(commitment));
    }
    const spec = await builder
      .toStealthOutput(createOutput({ destination: walletAddress, amount: remainder, resourceAddress, memo: toMemo(memo) }))
      .toRevealedOutput(revealedOutAmount + dust)
      .payFeeFromRevealed(maxFee)
      .prepare();
    const ownCommitment = extractOutputCommitment(spec, 0);

    const wallet = new OotleWallet().registerKeyProvider(account, this.signer).setDefaultSigner(account);
    const viewSecret = await this.signer.getViewSecret();
    // See shield()'s comment: must pass this account's real network, not fromSpec's LocalNet default.
    const authorized = await WalletStealthAuthorizer.fromSpec(wallet, spec, { viewSecret, crypto: new WasmStealthCrypto(this.network) }).prepare(
      provider
    );
    const envelope = await authorized.seal();
    const transactionId = await submitTransaction(provider, envelope);

    await addPendingShield({
      transactionId,
      accountId,
      resourceAddress,
      amount: remainder.toString(),
      spentCommitments: commitments,
      ownCommitment,
      memo,
    });
    try {
      const response = await withTimeout(pollTransactionResult(provider, transactionId), 60_000, "submitting the unshield transaction");
      await recordKnownVersions(response);
      await recordKnownShieldedOutput(accountId, resourceAddress, ownCommitment, remainder, transactionId, memo);
      for (const commitment of commitments) {
        await markShieldedOutputSpent(accountId, commitment);
      }
    } finally {
      await removePendingShield(transactionId);
    }
    return { transactionId };
  }

  /**
   * Withdraws `amount` of a Stealth-typed resource (e.g. XTR) from this account's revealed
   * balance and feeds it, as a `Bucket` left on the workspace under `workspaceVarName`, into
   * `followUpInstructions` — all in one signed transaction.
   *
   * This is the *only* way to move Stealth-typed funds into an arbitrary contract call. A plain
   * `CallMethod withdraw` on a Stealth vault is not a standalone-valid instruction: confirmed
   * empirically (isolated to a bare `withdraw` immediately followed by `deposit`, zero other
   * instructions) that `account.execute()` fails it client-side, before ever reaching the
   * network, with a generic `JSON deserialization failed: ... untagged enum TransactionInput`
   * error. Moving Stealth funds anywhere always requires the native `StealthTransfer`
   * instruction, signed via `WalletStealthAuthorizer` — which `execute()`/`TransactionBuilder`
   * never invokes (see this file's own `execute()` doc comment, and the
   * `isStealthTransferInstruction` guard + comment in `background/index.ts`). This method uses
   * the *same* `StealthTransfer` builder + `WalletStealthAuthorizer` pipeline `shield()`/
   * `unshield()` already use, extended with `toRevealedOutputAsBucket`/`andThen` (see
   * `vendor/ootle-patched/README.md`) to leave the revealed output on the workspace instead of
   * auto-depositing it back to this account, and to append the caller's own instructions after
   * it in the same transaction.
   *
   * @param relatedComponents Every *other* component `followUpInstructions` touches (e.g. a
   *   DAO contract being called). The `StealthTransfer` builder auto-registers this account's
   *   own vaults as tx inputs, but has no way to know what the caller's own follow-up
   *   instructions reference — the engine rejects a `CallMethod` touching an unregistered
   *   substate with `SubstateNotFound`. Each is registered by address, plus every vault its own
   *   state references (the same vault-discovery this account's own address already gets).
   */
  async withdrawStealthAndExecute(
    resourceAddress: string,
    amount: bigint,
    workspaceVarName: string,
    followUpInstructions: Instruction[],
    relatedComponents: string[] = [],
    maxFee = 100000n
  ): Promise<{ transactionId: string }> {
    if (amount <= 0n) throw new Error(`withdrawStealthAndExecute amount must be > 0, got ${amount}`);
    const provider = await this.getProvider();
    const account = await this.getComponentAddress();
    const walletAddress = await this.getWalletAddress();
    // A zero-stealth-output StealthTransferStatement (pure revealed-in, revealed-out-as-bucket)
    // isn't a shape the bundled ootle-wasm@0.37.0 signer can parse -- confirmed live: it throws
    // the same generic "did not match any variant of untagged enum TransactionInput" error inside
    // signTransaction's own WASM call, regardless of how balance_proof is represented (present,
    // null, or omitted -- all three tried). Every other stealth-transfer path in this file
    // (shield/unshield/sendPrivately) always includes >=1 real stealth output for exactly this
    // reason. Rather than fight an apparent WASM-binary limitation, this keeps a tiny (1 µ-unit)
    // stealth output back to this account -- the same proven-working shape -- alongside the real
    // amount as a revealed bucket.
    const dust = 1n;

    let builder = new StealthTransfer(provider, resourceAddress)
      .withBuilder((b) => b.addInput({ substate_id: resourceAddress, version: null }))
      .spendRevealedInput(account, amount + dust)
      .toStealthOutput(createOutput({ destination: walletAddress, amount: dust, resourceAddress }))
      .toRevealedOutputAsBucket(amount, workspaceVarName)
      .andThen(followUpInstructions);
    for (const component of relatedComponents) {
      builder = builder.withBuilder((b) => b.addInput({ substate_id: component, version: null }));
      for (const vaultId of await getVaultIdsForAccount(provider, component)) {
        builder = builder.withBuilder((b) => b.addInput({ substate_id: vaultId, version: null }));
      }
    }
    const spec = await builder.payFeeFromRevealed(maxFee).prepare();

    const wallet = new OotleWallet().registerKeyProvider(account, this.signer).setDefaultSigner(account);
    const viewSecret = await this.signer.getViewSecret();
    const authorized = await WalletStealthAuthorizer.fromSpec(wallet, spec, { viewSecret, crypto: new WasmStealthCrypto(this.network) }).prepare(
      provider
    );
    const envelope = await authorized.seal();
    const transactionId = await submitTransaction(provider, envelope);
    const response = await withTimeout(pollTransactionResult(provider, transactionId), 60_000, "submitting the transaction");
    await recordKnownVersions(response);
    return { transactionId };
  }

  /**
   * Funds an HTLC (hashed timelock contract): creates a stealth output for `amount` of
   * `resourceAddress`, gated not by a normal one-time stealth key but by a two-leaf TIP-0006
   * condition tree (`htlcConditions` in `./htlc.ts`) — a claim path admissible only to
   * `claimantWalletAddress` (revealing the SHA-256 preimage of `hashLockHex`, before
   * `refundEpoch`), and a refund path admissible only to this account (at/after `refundEpoch`).
   * `htlcConditions`'s own doc comment covers the exact leaf shapes.
   *
   * This account never needs (and must never be given) the actual preimage — only its hash. The
   * caller resolves `refundEpoch` from a desired wall-clock deadline via the provider/network's
   * current epoch, the same as any other epoch-relative on-chain deadline.
   *
   * Returns the full `conditions` tree alongside the transaction id and this output's own
   * commitment: only the tree's **root** is committed on-chain, so the claimant needs the exact
   * leaves — out of band, via whatever swap protocol coordinates the two sides — to later reveal
   * the claim leaf. **There is currently no way for this wallet to spend such an output (claim or
   * refund).** Doing that safely needs covenant-claim generation (required whenever a script-path
   * input is spent, to prove balance integrity across the spent/created outputs sharing that
   * input's condition root) — that has no wasm export yet, unlike the witness-construction half
   * (`buildScriptPathWitness`, from tari-project/tari-ootle#2426). Fund-only until a follow-up
   * upstream change exposes it; see the `tari-ootle-scriptpath-htlc` memory for the full story.
   *
   * `destination` is set to the claimant's own wallet address (not this account's) so the
   * claimant can independently decrypt and verify the funded amount themselves, the same as any
   * other stealth payment addressed to them — spend authority is governed entirely separately, by
   * `payTo`.
   */
  async htlcFund(
    resourceAddress: string,
    amount: bigint,
    claimantWalletAddress: string,
    hashLockHex: string,
    refundEpoch: bigint,
    maxFee = 50000n
  ): Promise<{ transactionId: string; conditions: object[]; ownCommitment: string }> {
    const provider = await this.getProvider();
    const account = await this.getComponentAddress();
    const walletAddress = await this.getWalletAddress();

    const claimant = parseOotleAddress(claimantWalletAddress);
    const refunder = parseOotleAddress(walletAddress);
    const conditions = htlcConditions({
      hashLockHex,
      refundEpoch,
      claimantPublicKeyHex: toHex(claimant.owner_key),
      refunderPublicKeyHex: toHex(refunder.owner_key),
    });

    // See shield()'s comment: the resource's own substate must be pinned explicitly -- prepare()
    // never adds it on its own.
    const spec = await new StealthTransfer(provider, resourceAddress)
      .withBuilder((b) => b.addInput({ substate_id: resourceAddress, version: null }))
      .spendRevealedInput(account, amount)
      .toStealthOutput(
        createOutput({ destination: claimantWalletAddress, amount, resourceAddress, payTo: { Conditions: conditions } })
      )
      .payFeeFromRevealed(maxFee)
      .prepare();
    const ownCommitment = extractOutputCommitment(spec, 0);

    const wallet = new OotleWallet().registerKeyProvider(account, this.signer).setDefaultSigner(account);
    // No stealth inputs to unblind (revealed-only source), so no viewSecret needed -- same as shield().
    const authorized = await WalletStealthAuthorizer.fromSpec(wallet, spec, { crypto: new WasmStealthCrypto(this.network) }).prepare(
      provider
    );
    const envelope = await authorized.seal();
    const transactionId = await submitTransaction(provider, envelope);

    const response = await withTimeout(
      pollTransactionResult(provider, transactionId),
      60_000,
      "submitting the HTLC funding transaction"
    );
    await recordKnownVersions(response);
    return { transactionId, conditions, ownCommitment };
  }

  /**
   * Sends `amount` of this account's shielded balance for `resourceAddress` directly to
   * `recipientWalletAddress` — a private-to-private transfer, unlike `shield()` (which always
   * targets this same account's own wallet address). The recipient never appears on-chain in the
   * clear; only they (holding the matching view key) can discover the payment, and only by being
   * told the resulting commitment out of band — same "no scan API" caveat as everywhere else
   * stealth outputs are spent. Which specific output(s) to spend is decided internally by
   * `resolveSendPrivatelyPlan`'s coin selection (largest-first, spending more than one in the same
   * transaction via repeated `spendStealthInput()` calls if a single output isn't enough) — the
   * caller only supplies an amount, not a commitment.
   *
   * Unlike `unshield()`, sending the *entire* selected total with no remainder is possible in one
   * step here: the builder's "at least one stealth output" requirement is trivially satisfied by
   * the recipient's own output, with no need for a same-account dust/change output to satisfy it.
   * Change (if `amount` is less than the selected inputs' total) is a second stealth output back
   * to this account.
   *
   * The fee-paying "dust" trick from `unshield()` still applies for the same reason: pay_fee and
   * (when there's change) the *concept* of "this account received a new output" both need a
   * revealed source account registered via `spendRevealedInput`, which requires amount `> 0`.
   *
   * Crash-safety: this account's own change commitment (if any) is read directly from the
   * locally-built outputs statement, *not* inferred from the finalized transaction's
   * `up_substates` — those also contain the recipient's brand-new stealth output, and naively
   * grabbing "the first new stealth output" would risk recording the recipient's payment as our
   * own. See `PendingShield.ownCommitment`'s doc comment.
   */
  async sendPrivately(
    resourceAddress: string,
    recipientWalletAddress: string,
    amount: bigint,
    maxFee = 100000n,
    memo?: string
  ): Promise<{ transactionId: string; recipientCommitment: string }> {
    const accountId = localAccountId(this.index);
    const records = await listShieldedOutputs(accountId);
    const { commitments, changeAmount } = resolveSendPrivatelyPlan(records, resourceAddress, amount);
    const dust = 1n;

    const provider = await this.getProvider();
    const account = await this.getComponentAddress();
    const ownWalletAddress = await this.getWalletAddress();

    // See shield()'s comment: the resource's own substate must be pinned explicitly -- prepare()
    // never adds it on its own.
    let builder = new StealthTransfer(provider, resourceAddress)
      .withBuilder((b) => b.addInput({ substate_id: resourceAddress, version: null }))
      .spendRevealedInput(account, dust);
    for (const commitment of commitments) {
      builder = builder.spendStealthInput(account, fromHex(commitment));
    }
    builder = builder.toStealthOutput(createOutput({ destination: recipientWalletAddress, amount, resourceAddress, memo: toMemo(memo) }));
    if (changeAmount > 0n) {
      builder = builder.toStealthOutput(createOutput({ destination: ownWalletAddress, amount: changeAmount, resourceAddress }));
    }
    const spec = await builder.toRevealedOutput(dust).payFeeFromRevealed(maxFee).prepare();
    // Output 0 is the recipient's; output 1 (only present when there's change) is ours. The
    // recipient has no way to discover their new output on their own (no scan-by-view-key API
    // exists) -- this commitment must be handed back to the caller so it can be shared with them
    // out of band; without it, the payment is invisible to them even though it succeeded on-chain.
    const recipientCommitment = extractOutputCommitment(spec, 0);
    const ownCommitment = changeAmount > 0n ? extractOutputCommitment(spec, 1) : undefined;

    const wallet = new OotleWallet().registerKeyProvider(account, this.signer).setDefaultSigner(account);
    const viewSecret = await this.signer.getViewSecret();
    const authorized = await WalletStealthAuthorizer.fromSpec(wallet, spec, { viewSecret, crypto: new WasmStealthCrypto(this.network) }).prepare(
      provider
    );
    const envelope = await authorized.seal();
    const transactionId = await submitTransaction(provider, envelope);

    await addPendingShield({
      transactionId,
      accountId,
      resourceAddress,
      amount: changeAmount.toString(),
      spentCommitments: commitments,
      ownCommitment,
    });
    try {
      const response = await withTimeout(pollTransactionResult(provider, transactionId), 60_000, "submitting the private send");
      await recordKnownVersions(response);
      if (ownCommitment) await recordKnownShieldedOutput(accountId, resourceAddress, ownCommitment, changeAmount, transactionId);
      for (const commitment of commitments) {
        await markShieldedOutputSpent(accountId, commitment);
      }
    } finally {
      await removePendingShield(transactionId);
    }
    return { transactionId, recipientCommitment };
  }

  /**
   * The recipient-side counterpart to `sendPrivately()`'s commitment hand-off: given a commitment
   * shared out of band, fetches the corresponding `utxo_{resource}_{commitment}` substate and
   * tries to decrypt it with this account's own view secret. `decryptOwnedUtxo` swallows the
   * "not ours" throw and returns `null` instead, so a wrong/foreign commitment fails cleanly here
   * rather than looking like a network error. Success both *proves* ownership and recovers the
   * amount in one step (no need to be told the amount separately) -- recorded exactly like a
   * self-shield's output, so it then just shows up in this account's private balance and
   * shielded-outputs picker.
   */
  async claimPrivatePayment(resourceAddress: string, commitmentHex: string): Promise<{ amount: bigint; memo?: string }> {
    const accountId = localAccountId(this.index);
    const existing = await listShieldedOutputs(accountId);
    if (existing.some((r) => r.resourceAddress === resourceAddress && r.commitment === commitmentHex)) {
      throw new Error("You've already claimed this payment.");
    }
    const provider = await this.getProvider();
    const substateId = stealthUtxoSubstateId(resourceAddress, fromHex(commitmentHex));
    const substate = await provider.getSubstate(substateId);
    const viewSecret = await this.signer.getViewSecret();
    const decrypted = await decryptOwnedUtxo(new WasmStealthCrypto(this.network), viewSecret, substate, substateId);
    if (!decrypted) {
      throw new Error("This commitment doesn't belong to your account, or wasn't found on-chain.");
    }
    const memo = fromMemo(decrypted.memo);
    // No originating transaction id is available from a bare commitment -- the substate id is
    // itself a stable, deterministic reference back to this exact output, so it fills that slot.
    await recordKnownShieldedOutput(accountId, resourceAddress, commitmentHex, decrypted.value, substateId, memo);
    return { amount: decrypted.value, memo };
  }

  /**
   * Automatic counterpart to `claimPrivatePayment()`: instead of requiring the recipient be told a
   * commitment out of band, walks the indexer's recent-transaction history looking for
   * `StealthTransfer` outputs this account can decrypt with its own view key (see
   * `scanTransactionsForOwnedOutputs`'s doc comment for why the data needed to do this is present
   * even in the *pruned* form `listRecentTransactions` returns).
   *
   * Cursor-based (`privatePaymentScanCursors[accountId]`, the newest transaction id seen last time)
   * so this can run cheaply and opportunistically on every `popup-get-status` — see
   * `buildStatus()`'s `recoverPendingShields()` call for the same pattern. Walks backward in pages
   * of `pageSize` (oldest-paging via `last_id`, per the indexer's own "recent" convention) up to
   * `maxPages`, stopping early once it reaches the transaction id it left off at last time. A very
   * active chain producing more than `maxPages * pageSize` new transactions between scans will
   * only be caught up partway; the next scan resumes from the same cursor and continues.
   */
  async scanForPrivatePayments(maxPages = 3, pageSize = 50): Promise<{ claimed: number; found: ScannedStealthOutput[] }> {
    const accountId = localAccountId(this.index);
    const provider = await this.getProvider();
    const viewSecret = await this.signer.getViewSecret();
    const crypto = new WasmStealthCrypto(this.network);
    const known = await listShieldedOutputs(accountId);
    const knownCommitments = new Set(known.map((r) => r.commitment));

    const previousCursor = await getPrivatePaymentScanCursor(accountId);
    let newestSeen: string | null = null;
    let lastId: string | null = null;
    const found: ScannedStealthOutput[] = [];
    // Whether this pass actually walked all the way back to `previousCursor` (or there was none to
    // reach -- the very first scan ever). Only true in that case is it safe to advance the cursor:
    // if `maxPages` runs out first, advancing anyway would silently and PERMANENTLY skip the
    // unscanned gap between here and the old cursor -- the next scan would start from the new
    // (already-advanced) cursor and never revisit it. Leaving the cursor where it was instead means
    // the next opportunistic scan just re-tries the same catch-up (redundant work, not data loss);
    // see this method's own doc comment ("the next scan resumes from the same cursor").
    let reachedCursor = previousCursor === null;

    pages: for (let page = 0; page < maxPages; page++) {
      const { transactions } = await provider.listRecentTransactions({ limit: pageSize, last_id: lastId });
      if (transactions.length === 0) {
        reachedCursor = true; // the indexer's whole history fit before ever finding previousCursor
        break;
      }
      if (page === 0) newestSeen = transactions[0]!.transaction_id;

      for (const entry of transactions) {
        if (entry.transaction_id === previousCursor) {
          reachedCursor = true;
          break pages;
        }
        const newlyFound = await scanTransactionsForOwnedOutputs(crypto, viewSecret, [entry], knownCommitments);
        for (const raw of newlyFound) {
          // scanTransactionsForOwnedOutputs' `memo` is the raw JSON-encoded Memo union (see
          // ScannedStealthOutput's doc comment) -- decode once here so both the persisted record
          // and this method's own return value carry plain text, not JSON, memo consumers never
          // need to know about `fromMemo()` themselves.
          const output = { ...raw, memo: fromMemo(raw.memo) };
          await recordKnownShieldedOutput(accountId, output.resourceAddress, output.commitment, output.amount, output.transactionId, output.memo);
          knownCommitments.add(output.commitment);
          found.push(output);
        }
      }
      lastId = transactions[transactions.length - 1]!.transaction_id;
    }

    if (newestSeen && reachedCursor) await setPrivatePaymentScanCursor(accountId, newestSeen);
    return { claimed: found.length, found };
  }
}

/**
 * Reads the commitment of the output at `outputIndex` (in the order `toStealthOutput()` was
 * called) directly from the outputs statement `StealthTransfer.prepare()` already built —
 * generated client-side, so it's known *before* submission, not inferred afterward by scanning
 * the finalized transaction's `up_substates`. That scan-based approach is unambiguous when a
 * transfer only ever creates one new stealth output belonging to this account (shield, unshield),
 * but breaks down the moment a transfer also creates a *different* account's new stealth output
 * in the same transaction (a private send's recipient output) — grabbing "the first new stealth
 * output" from `up_substates` would then risk attributing someone else's payment to us.
 */
function extractOutputCommitment(spec: StealthTransferSpec, outputIndex: number): string {
  const parsed = spec.statement.outputsStatement.parsed() as { outputs?: { output?: { commitment?: string } }[] };
  const commitment = parsed.outputs?.[outputIndex]?.output?.commitment;
  if (typeof commitment !== "string" || commitment.length === 0) {
    throw new Error(`Failed to read output ${outputIndex}'s commitment from the locally-built outputs statement.`);
  }
  return commitment;
}

/**
 * Synthesizes a `TokenBalance` entry for each resource whose only balance is a shielded output
 * with no on-chain vault at all (e.g. redeemed via the "Advanced" unshield flow from someone
 * else's shared commitment) -- these never appear in `getBalances()`'s vault-derived `parsed`
 * list, since they're freestanding `utxo_{resource}_{commitment}` substates, not vault entries.
 * Skips any resource already covered by `parsedResources` (that one gets its shielded amount
 * folded into its existing entry instead, in `getBalances()` itself).
 */
export function synthesizeShieldedOnlyBalances(
  parsedResources: Set<string>,
  shieldedByResource: Map<string, bigint>,
  divisibilityByResource: Map<string, number>,
  symbolByResource: Map<string, string | null>,
  nameByResource: Map<string, string | null>
): TokenBalance[] {
  const balances: TokenBalance[] = [];
  for (const [resourceAddress, amount] of shieldedByResource) {
    if (parsedResources.has(resourceAddress)) continue;
    balances.push({
      resourceAddress,
      kind: "Stealth",
      amount: 0n,
      confidentialAmount: amount,
      confidentialDecryptFailures: 0,
      divisibility: divisibilityByResource.get(resourceAddress) ?? 0,
      symbol: symbolByResource.get(resourceAddress) ?? null,
      name: nameByResource.get(resourceAddress) ?? null,
    });
  }
  return balances;
}

/**
 * Coin selection for spending shielded outputs: picks this resource's unspent records
 * largest-first until their sum covers `targetAmount`, so a spend needing more than any single
 * output holds is satisfied by combining several in one transaction (the builder's
 * `spendStealthInput()` can be called once per input UTXO) rather than requiring the caller to
 * pick one record themselves. Largest-first minimizes the number of inputs spent (each one adds
 * real signature/proof-verification fee cost), rather than needlessly consolidating dust.
 *
 * Returns the unselected remainder too (still sorted largest-first) so callers that need "at
 * least one more unit available" (see `resolveUnshieldPlan`) can pull in exactly one more output
 * without re-deriving the candidate list.
 */
export function selectShieldedUtxosForAmount(
  records: ShieldedOutputRecord[],
  resourceAddress: string,
  targetAmount: bigint
): { selected: ShieldedOutputRecord[]; total: bigint; unselected: ShieldedOutputRecord[] } {
  const candidates = records
    .filter((r) => r.resourceAddress === resourceAddress && !r.spent)
    .sort((a, b) => {
      const diff = BigInt(b.amount) - BigInt(a.amount);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });

  const selected: ShieldedOutputRecord[] = [];
  let total = 0n;
  let i = 0;
  for (; i < candidates.length; i++) {
    if (total >= targetAmount) break;
    selected.push(candidates[i]!);
    total += BigInt(candidates[i]!.amount);
  }
  return { selected, total, unselected: candidates.slice(i) };
}

/**
 * Pure planning for `unshield()`: selects enough of the caller's unspent records for this
 * resource (via `selectShieldedUtxosForAmount`) to cover `revealedOutAmount`, and checks the
 * total leaves at least 1 unit as private remainder (see `unshield()`'s doc comment for why the
 * upper bound is strict, not `<=`). Extracted so this decision logic is unit-testable without a
 * live provider/WASM crypto, same reasoning as `pollTransactionResult`'s extraction.
 *
 * If the minimal selection's total lands *exactly* on `revealedOutAmount` (zero remainder), and
 * another unspent record for this resource exists, one more (the smallest available) is pulled
 * in purely to create a nonzero remainder — spending an extra UTXO is preferable to failing a
 * reveal that the account's total private balance could otherwise satisfy.
 */
export function resolveUnshieldPlan(
  records: ShieldedOutputRecord[],
  resourceAddress: string,
  revealedOutAmount: bigint
): { commitments: string[]; remainder: bigint } {
  if (revealedOutAmount <= 0n) throw new Error("The amount to reveal must be greater than zero.");
  const { selected, total, unselected } = selectShieldedUtxosForAmount(records, resourceAddress, revealedOutAmount);
  if (total < revealedOutAmount) {
    throw new Error(`Amount exceeds your private balance (you have ${total}).`);
  }
  let finalSelected = selected;
  let finalTotal = total;
  if (finalTotal === revealedOutAmount) {
    const extra = unselected[unselected.length - 1]; // smallest remaining unspent record, if any
    if (!extra) {
      throw new Error(
        "Can't unshield your full private balance in one transaction -- at least 1 unit must remain private as change."
      );
    }
    finalSelected = [...finalSelected, extra];
    finalTotal += BigInt(extra.amount);
  }
  return { commitments: finalSelected.map((r) => r.commitment), remainder: finalTotal - revealedOutAmount };
}

/**
 * Pure planning for `sendPrivately()`: selects enough of the caller's unspent records for this
 * resource to cover `amount` — unlike `resolveUnshieldPlan`, sending the *entire* selected total
 * with zero change is allowed, since the recipient's own stealth output already satisfies the
 * builder's "at least one stealth output" requirement (no same-account dust output is needed to
 * satisfy it, unlike unshield's revealed destination). Extracted for the same unit-testability
 * reasons as `resolveUnshieldPlan`.
 */
export function resolveSendPrivatelyPlan(
  records: ShieldedOutputRecord[],
  resourceAddress: string,
  amount: bigint
): { commitments: string[]; changeAmount: bigint } {
  if (amount <= 0n) throw new Error("The amount to send must be greater than zero.");
  const { selected, total } = selectShieldedUtxosForAmount(records, resourceAddress, amount);
  if (total < amount) {
    throw new Error(`Amount exceeds your private balance (you have ${total}).`);
  }
  return { commitments: selected.map((r) => r.commitment), changeAmount: total - amount };
}

/**
 * Reconciles shields whose `pollTransactionResult` never got to finish (the extension's service
 * worker was killed between submission and the storage write) — see `PendingShield`'s doc
 * comment. Checks each pending shield's current status *once* (not a blocking poll-to-finalize
 * loop — if it's still genuinely pending, this leaves it for the next check rather than stalling
 * whatever triggered recovery, typically `popup-get-status`) and either completes the storage
 * write (finalized successfully), drops it (rejected — no stealth output was ever created, so
 * there's nothing to recover), or leaves it alone (still pending). One provider is reused across
 * every pending shield, whichever local account they belong to — this is a read-only connection,
 * not account/signing-specific.
 */
export async function recoverPendingShields(provider: IndexerProvider): Promise<void> {
  const pending = await listPendingShields();
  for (const p of pending) {
    try {
      const response = await provider.getTransactionResult(p.transactionId);
      const result = response.result;
      if (result === "Pending") continue; // still in flight -- leave it for next time
      if ("Rejected" in result) {
        await removePendingShield(p.transactionId);
        continue;
      }
      const outcome = result.Finalized.execution_result?.finalize.result;
      const succeeded = outcome && typeof outcome === "object" && "Accept" in outcome;
      if (succeeded) {
        await recordKnownVersions(response);
        if (p.ownCommitment) {
          await recordKnownShieldedOutput(p.accountId, p.resourceAddress, p.ownCommitment, BigInt(p.amount), p.transactionId, p.memo);
        }
        if (p.spentCommitments) {
          for (const commitment of p.spentCommitments) {
            await markShieldedOutputSpent(p.accountId, commitment);
          }
        }
      }
      // Reject / AcceptFeeRejectRest: no stealth output was created either way, nothing to
      // recover -- just stop waiting on it.
      await removePendingShield(p.transactionId);
    } catch {
      // A transient network/indexer error checking one pending shield must not stop the rest
      // from being reconciled -- leave this one in the list, it'll be retried next time.
    }
  }
}

/**
 * Persists a `ShieldedOutputRecord` for a commitment already known locally (see
 * `extractOutputCommitment`'s doc comment for why this is preferred over scanning the finalized
 * transaction's `up_substates`) — the only lead back to it, since there is no client-side
 * scan/list API for stealth UTXOs (see confidential.ts's module doc).
 */
async function recordKnownShieldedOutput(
  accountId: string,
  resourceAddress: string,
  commitment: string,
  amount: bigint,
  transactionId: string,
  memo?: string
): Promise<void> {
  await addShieldedOutput({
    accountId,
    resourceAddress,
    commitment,
    amount: amount.toString(),
    transactionId,
    createdAt: Date.now(),
    spent: false,
    memo,
  });
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

/**
 * Polls a submitted transaction's result to finalization (or rejection/timeout). Extracted from
 * `OotleAccount.submitReal()` so `shield()`/`unshield()` — which submit via a completely
 * different pipeline (`StealthTransfer`/`WalletStealthAuthorizer`/`submitTransaction`, not
 * `TransactionBuilder`) — share the exact same hardened Reject/AcceptFeeRejectRest/timeout
 * handling instead of a second, potentially-drifting copy of it.
 */
export async function pollTransactionResult(
  provider: IndexerProvider,
  transactionId: string,
  timeoutMs = 60_000
): Promise<IndexerGetTransactionResultResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await provider.getTransactionResult(transactionId);
    const result = response.result;
    if (result === "Pending") {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for transaction ${transactionId} to finalize.`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if ("Rejected" in result) {
      throw new Error(`Transaction ${transactionId} was rejected: ${result.Rejected.details}`);
    }
    const outcome = result.Finalized.execution_result?.finalize.result;
    if (outcome && typeof outcome === "object") {
      if ("Reject" in outcome) {
        throw new Error(`Transaction ${transactionId} was rejected: ${JSON.stringify(outcome.Reject)}`);
      }
      if ("AcceptFeeRejectRest" in outcome) {
        throw new Error(`Transaction ${transactionId} accepted the fee but rejected the rest: ${JSON.stringify(outcome.AcceptFeeRejectRest)}`);
      }
    }
    return response;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
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

export function extractMissingSubstateAddress(message: string): string | null {
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

export function extractStaleLockVersion(message: string): { substateId: string; version: number } | null {
  const match = STALE_LOCK_PATTERN.exec(message);
  return match ? { substateId: match[1]!, version: Number(match[2]) } : null;
}
