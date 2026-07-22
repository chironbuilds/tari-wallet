import { Network, TransactionBuilder, amountLiteral, defaultIndexerUrl, resolveTransaction, resourceAddressLiteral } from "@tari-project/ootle";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { WalletDaemonClient } from "@tari-project/ootle-wallet-daemon-signer";
import type {
  Account,
  IndexerGetTransactionResultResponse,
  Instruction,
  KeyId,
  TransactionResult,
  TransactionWaitResultResponse,
} from "@tari-project/ootle-ts-bindings";
import type { TransactionExecuteOpts, WalletAccountApi } from "./accountApi";
import { type NetworkName, toOotleNetwork } from "./ootleNetwork";
import { withTimeout } from "./timeout";
import type { TokenBalance } from "./wallet";

const DAEMON_TIMEOUT_MS = 15_000;

/**
 * A plain `fetch()` failure (connection refused, DNS failure, or — on some platforms — a hang that
 * never even reaches the daemon) throws a raw `TypeError`/`AbortError` straight out of
 * `FetchRpcTransport`. An actual JSON-RPC error the daemon *did* respond with (wrong auth, bad
 * params, ...) is always wrapped by `WalletDaemonClient` as `Error("RPC Error ...", { cause: {
 * method, code, message, data } })` — checking for `method` alongside `code` matters: Chrome's
 * `fetch()` throws a bare `TypeError` with no `.cause` for a connection failure, but Node's
 * (undici-based) `fetch()` sets `.cause` to the underlying errno error, which *also* has a `.code`
 * (e.g. `"ECONNREFUSED"`) — confirmed empirically this produces a false negative here when
 * exercised from a Node verification script, even though the real (browser) code path never hits
 * it. `method` is unique to this client's own RPC-error wrapping either way, so checking for it is
 * strictly more correct in both environments. That distinction is what lets `connectClient()` below
 * skip a doomed-to-fail retry when the daemon isn't reachable at all, instead of just being slow to
 * say so.
 */
export function isDaemonUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return !(e.cause && typeof e.cause === "object" && "method" in e.cause && "code" in e.cause);
}

/** Runs a daemon call with a bounded timeout and rewrites an unreachable-daemon failure (dead
 * connection or a hang past the timeout — indistinguishable from the user's point of view) into an
 * actionable message, instead of a raw "Failed to fetch" or "Timed out after ...". */
async function daemonCall<T>(url: string, promise: Promise<T>, label: string, timeoutMs = DAEMON_TIMEOUT_MS): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs, label);
  } catch (e) {
    if (isDaemonUnreachable(e)) {
      const details = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not reach the daemon at ${url} — make sure tari_ootle_walletd is running. (${details})`);
    }
    throw e;
  }
}

/**
 * One account on a `tari_ootle_walletd` this extension has connected to as a JRPC client — the
 * "hardware wallet" counterpart to `OotleAccount`. The daemon holds the real key material; this
 * class never signs or derives anything itself. Two consequences follow directly from that:
 *
 * 1. Unlike `OotleAccount.execute()`, this never runs a client-side substate-discovery retry loop.
 *    The daemon's own `transactions.submit` JRPC takes `detect_inputs: true`, which asks the
 *    daemon to run its real want-derivation (the same pass `ootle_sdk_core` does natively in Rust,
 *    which the TS indexer path this extension otherwise relies on doesn't have) — so it resolves
 *    every substate an instruction touches itself, server-side, in one round trip.
 * 2. `resolveTransaction()` (this extension's own `IndexerProvider`, not the daemon's) is still
 *    used before submission purely to fill in valid epoch bounds locally — a cheap, read-only step
 *    that doesn't require the daemon and keeps this class's shape close to `OotleAccount`'s.
 */
export class DaemonAccount implements WalletAccountApi {
  readonly network: Network;

  constructor(
    private readonly client: WalletDaemonClient,
    private readonly indexerProvider: IndexerProvider,
    networkName: NetworkName,
    private account: Account,
    private readonly address: string,
    private readonly url: string
  ) {
    this.network = toOotleNetwork(networkName);
  }

  /**
   * Connects to a running wallet daemon using a long-lived **API key**, not a browser session.
   *
   * This deliberately does *not* attempt `auth.request`/WebAuthn/`auth.refresh` session login —
   * confirmed with the tari-ootle maintainers (see the PR this replaced:
   * github.com/tari-project/tari-ootle/pull/2375) that `auth.refresh` reads an HttpOnly,
   * SameSite=Strict session cookie set on browser login, which a `chrome-extension://` origin
   * cannot ever hold — by design, not a bug. WebAuthn (the daemon's actual default auth method,
   * not `none`) additionally locks its RP origin to `http://localhost:{json_rpc_port}`, which a
   * Chrome extension page is never running on either way. Neither session-auth path can work from
   * here, full stop — an API key (minted from the daemon's own web UI, which *does* have a real
   * Admin browser session) is the supported way for an external client like this extension to
   * authenticate, and needs no refresh at all.
   */
  static async connectClient(url: string, apiKey: string): Promise<WalletDaemonClient> {
    if (!apiKey) {
      throw new Error(
        "This daemon needs an API key. Mint one from the daemon's own web UI (requires an Admin login there), then paste it in here."
      );
    }
    const client = WalletDaemonClient.usingFetchTransport(url);
    client.setReauthenticationEnabled(false);
    client.setToken(apiKey);
    try {
      // `accounts.list` (not `wallet.get_info`, which doesn't require auth at all — confirmed
      // empirically it answers fine with a garbage token) doubles as both the connectivity check
      // and the "is this API key actually valid" check in one round trip.
      await daemonCall(url, client.accountsList({ offset: 0, limit: 1 }), "connecting to the daemon");
    } catch (e) {
      if (!isDaemonUnreachable(e)) {
        throw new Error(`This API key was rejected by the daemon — it may be wrong, expired, or revoked. Mint a new one and try again. (${e instanceof Error ? e.message : String(e)})`);
      }
      throw e;
    }
    return client;
  }

  static async listAccounts(client: WalletDaemonClient, url: string): Promise<Account[]> {
    const { accounts } = await daemonCall(url, client.accountsList({ offset: 0, limit: 200 }), "listing the daemon's accounts");
    return accounts.map((a) => a.account);
  }

  static async connectAccount(
    client: WalletDaemonClient,
    url: string,
    networkName: NetworkName,
    componentAddress: string
  ): Promise<DaemonAccount> {
    const { account, address } = await daemonCall(
      url,
      client.accountsGet({ name_or_address: { ComponentAddress: componentAddress } }),
      "looking up the daemon account"
    );
    const indexerProvider = await IndexerProvider.connect({ url: defaultIndexerUrl(toOotleNetwork(networkName)), network: toOotleNetwork(networkName) });
    return new DaemonAccount(client, indexerProvider, networkName, account, address, url);
  }

  async getComponentAddress(): Promise<string> {
    return this.account.component_address;
  }

  async getWalletAddress(): Promise<string> {
    return this.address;
  }

  async getProvider(): Promise<IndexerProvider> {
    return this.indexerProvider;
  }

  async getBalances(): Promise<TokenBalance[]> {
    const { balances } = await daemonCall(
      this.url,
      this.client.accountsGetBalances({ account: { ComponentAddress: this.account.component_address }, refresh: true }),
      "fetching balances"
    );
    if (balances.length === 0) return [];

    // The daemon's own balance RPC only returns `token_symbol`, not the resource's longer
    // `metadata.name` — fetched separately via this account's own indexer connection (the same one
    // used for epoch-bound resolution in execute()), mirroring OotleAccount.getBalances()'s
    // resource-substate lookup so both account types expose the same TokenBalance shape.
    const resourceIds = [...new Set(balances.map((b) => b.resource_address))];
    const { substates } = await this.indexerProvider.fetchSubstates(resourceIds);
    const nameByResource = new Map<string, string | null>();
    for (const id of resourceIds) {
      const value = substates[id]?.substate;
      const resource = value && "Resource" in value ? (value.Resource as { metadata?: Record<string, unknown> }) : undefined;
      const name = resource?.metadata?.name;
      nameByResource.set(id, typeof name === "string" ? name : null);
    }

    return balances.map((b) => ({
      resourceAddress: b.resource_address,
      kind: b.resource_type,
      amount: BigInt(b.balance),
      divisibility: b.divisibility,
      symbol: b.token_symbol,
      name: nameByResource.get(b.resource_address) ?? null,
    }));
  }

  /**
   * Builds an unsigned transaction locally (same `TransactionBuilder` as `OotleAccount`), then hands
   * it to the daemon to resolve inputs, sign, and submit/simulate. `seal_signer` must be this
   * account's own owner key so the daemon signs and seals with the same key that pays the fee.
   */
  async execute(instructions: Instruction[], opts: TransactionExecuteOpts = {}): Promise<unknown> {
    const ownerKeyId: KeyId | null = this.account.owner_key_id;
    if (!ownerKeyId) throw new Error("This daemon account has no owner key — it is view-only and cannot sign transactions.");

    const maxFee = opts.maxFee ?? 5000n;
    const builder = TransactionBuilder.new(this.network).withInstructions(instructions).feeTransactionPayFromComponent(this.account.component_address, maxFee);
    if (opts.inputs?.length) builder.withInputs(opts.inputs);
    const unsignedTx = await withTimeout(
      resolveTransaction(this.indexerProvider, builder.buildUnsignedTransaction()),
      DAEMON_TIMEOUT_MS,
      "resolving the transaction"
    );
    // `TransactionBuilder` defaults this to false — the engine's `TransactionSignatureValidator`
    // then rejects with "has no main signer" unless there's a real per-instruction participant
    // signature (what OotleAccount's local signing produces via `signTransaction([signer], ...)`).
    // The daemon's own single-signer convenience RPCs (accountsTransfer, createFreeTestCoins) rely
    // on this flag being true instead, so their `seal_signer`-only, empty-`other_signers` shape
    // works — confirmed empirically: submission failed with exactly that "no main signer" error
    // until this was set, against a live tari_ootle_walletd on esmeralda.
    unsignedTx.is_seal_signer_authorized = true;

    const request = {
      transaction: { V1: unsignedTx },
      seal_signer: ownerKeyId,
      other_signers: [],
      signatures: [],
      detect_inputs: true,
      detect_inputs_use_unversioned: true,
      lock_ids: [],
    };

    if (opts.dryRun) {
      const response = await daemonCall(this.url, this.client.submitTransactionDryRun(request), "simulating the transaction");
      throwOnRejection(response.transaction_id, response.result.finalize.result);
      return response;
    }

    const { transaction_id } = await daemonCall(this.url, this.client.submitTransaction(request), "submitting the transaction");
    // The daemon's own `timeout_secs: 60` bounds how long it waits for finalization server-side;
    // the client-side budget here just needs enough slack for that plus normal round-trip time so
    // a dead connection (not just a slow finalization) still surfaces as a clear error.
    const response = await daemonCall(
      this.url,
      this.client.waitForTransactionResult({ transaction_id, timeout_secs: 60 }),
      "waiting for the transaction to finalize",
      70_000
    );
    if (response.timed_out) throw new Error(`Timed out waiting for transaction ${transaction_id} to finalize.`);
    if (response.result) throwOnRejection(transaction_id, response.result.result);
    return toIndexerResultShape(response);
  }

  async send(recipientAddress: string, resourceAddress: string, amount: bigint, maxFee = 5000n): Promise<unknown> {
    const account = await this.getComponentAddress();
    const instructions: Instruction[] = [
      { CallMethod: { call: { Address: account }, method: "withdraw", args: [resourceAddressLiteral(resourceAddress), amountLiteral(amount)] } },
      { PutLastInstructionOutputOnWorkspace: { key: 0 } },
      { CallMethod: { call: { Address: recipientAddress }, method: "deposit", args: [{ Workspace: { id: 0, offset: null } }] } },
    ];
    return this.execute(instructions, { maxFee });
  }

  /** Delegates to the daemon's own free-testnet-coins RPC — much simpler than `OotleAccount`'s
   * hand-rolled self-funding claim, since the daemon already knows how to fund its own accounts. */
  async claimTestnetXtr(): Promise<unknown> {
    return daemonCall(
      this.url,
      this.client.createFreeTestCoins({ account: { ComponentAddress: this.account.component_address }, max_fee: 5000n }),
      "claiming testnet XTR"
    );
  }
}

export function throwOnRejection(transactionId: string, outcome: TransactionResult): void {
  if ("Reject" in outcome) {
    throw new Error(`Transaction ${transactionId} was rejected: ${JSON.stringify(outcome.Reject)}`);
  }
  if ("AcceptFeeRejectRest" in outcome) {
    throw new Error(`Transaction ${transactionId} accepted the fee but rejected the rest: ${JSON.stringify(outcome.AcceptFeeRejectRest)}`);
  }
}

/**
 * Reshapes the daemon's `transactions.wait_result` response into the exact
 * `IndexerGetTransactionResultResponse` shape `OotleAccount.execute()` returns for a real
 * submission — `{result: {Finalized: {execution_result: ExecuteResult, ...}}}`, not the daemon's
 * own flatter `{result: FinalizeResult, status, final_fee, ...}`. Without this, any dApp parsing
 * the result (this extension's own DEX included) has to special-case which account backend served
 * it — confirmed empirically: the DEX's create-token flow threw "Unexpected transaction result
 * shape" against a daemon-relayed account before this normalization existed. `throwOnRejection`
 * has already run by the time this is called, so `response.result` being present here always means
 * a successful `Accept` outcome.
 */
export function toIndexerResultShape(response: TransactionWaitResultResponse): IndexerGetTransactionResultResponse {
  if (!response.result) return { result: "Pending" };
  return {
    result: {
      Finalized: {
        final_decision: "Commit",
        execution_result: {
          finalize: response.result,
          execution_time: { secs: 0, nanos: 0 },
          execute_epoch: null,
          wasm_execution_points: 0n,
        },
        execution_time: { secs: 0, nanos: 0 },
        finalized_time: new Date().toISOString(),
        abort_details: null,
      },
    },
  };
}
