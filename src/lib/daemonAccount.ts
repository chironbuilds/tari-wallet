import { Network, TransactionBuilder, amountLiteral, defaultIndexerUrl, resolveTransaction, resourceAddressLiteral } from "@tari-project/ootle";
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { WalletDaemonClient, authenticate } from "@tari-project/ootle-wallet-daemon-signer";
import type { Account, Instruction, KeyId, TransactionResult } from "@tari-project/ootle-ts-bindings";
import type { TransactionExecuteOpts, WalletAccountApi } from "./accountApi";
import { type NetworkName, toOotleNetwork } from "./ootleNetwork";
import type { TokenBalance } from "./wallet";

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
    private readonly address: string
  ) {
    this.network = toOotleNetwork(networkName);
  }

  /**
   * Connects to a running wallet daemon and authenticates, mirroring `WalletDaemonSigner.connect()`
   * (that class isn't used directly here — relay mode calls the daemon's own account/balance/submit
   * JRPC methods rather than composing this extension's `TransactionBuilder` with a swapped-in
   * `Signer`, sidestepping an unverified `seal_public_key` handling path that class's own doc
   * comment flags as untested against a real daemon).
   */
  static async connectClient(url: string, authToken?: string): Promise<WalletDaemonClient> {
    const client = WalletDaemonClient.usingFetchTransport(url);
    if (authToken) {
      client.setToken(authToken);
    } else {
      const token = await authenticate(client);
      client.setToken(token);
    }
    client.setReauthenticationEnabled(true);
    // Cheap connectivity check — throws immediately with a clear network-level error if the URL is
    // wrong or nothing is listening, rather than surfacing a confusing failure on the first real call.
    await client.walletGetInfo();
    return client;
  }

  static async listAccounts(client: WalletDaemonClient): Promise<Account[]> {
    const { accounts } = await client.accountsList({ offset: 0, limit: 200 });
    return accounts.map((a) => a.account);
  }

  static async connectAccount(
    client: WalletDaemonClient,
    networkName: NetworkName,
    componentAddress: string
  ): Promise<DaemonAccount> {
    const { account, address } = await client.accountsGet({ name_or_address: { ComponentAddress: componentAddress } });
    const indexerProvider = await IndexerProvider.connect({ url: defaultIndexerUrl(toOotleNetwork(networkName)), network: toOotleNetwork(networkName) });
    return new DaemonAccount(client, indexerProvider, networkName, account, address);
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
    const { balances } = await this.client.accountsGetBalances({
      account: { ComponentAddress: this.account.component_address },
      refresh: true,
    });
    return balances.map((b) => ({
      resourceAddress: b.resource_address,
      kind: b.resource_type,
      amount: BigInt(b.balance),
      divisibility: b.divisibility,
      symbol: b.token_symbol,
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
    const unsignedTx = await resolveTransaction(this.indexerProvider, builder.buildUnsignedTransaction());
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
      const response = await this.client.submitTransactionDryRun(request);
      throwOnRejection(response.transaction_id, response.result.finalize.result);
      return response;
    }

    const { transaction_id } = await this.client.submitTransaction(request);
    const response = await this.client.waitForTransactionResult({ transaction_id, timeout_secs: 60 });
    if (response.timed_out) throw new Error(`Timed out waiting for transaction ${transaction_id} to finalize.`);
    if (response.result) throwOnRejection(transaction_id, response.result.result);
    return response;
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
    return this.client.createFreeTestCoins({ account: { ComponentAddress: this.account.component_address }, max_fee: 5000n });
  }
}

function throwOnRejection(transactionId: string, outcome: TransactionResult): void {
  if ("Reject" in outcome) {
    throw new Error(`Transaction ${transactionId} was rejected: ${JSON.stringify(outcome.Reject)}`);
  }
  if ("AcceptFeeRejectRest" in outcome) {
    throw new Error(`Transaction ${transactionId} accepted the fee but rejected the rest: ${JSON.stringify(outcome.AcceptFeeRejectRest)}`);
  }
}
