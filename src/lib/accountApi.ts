import type { IndexerProvider } from "@tari-project/ootle-indexer";
import type { Instruction, SubstateRequirement } from "@tari-project/ootle-ts-bindings";
import type { TokenBalance } from "./wallet";

export interface TransactionExecuteOpts {
  maxFee?: bigint;
  dryRun?: boolean;
  inputs?: SubstateRequirement[];
  maxRetries?: number;
}

/**
 * Shared surface both `OotleAccount` (this extension's own seed-derived signer) and `DaemonAccount`
 * (a relayed account on a connected `tari_ootle_walletd`) implement — the "hardware wallet" split:
 * everywhere in background/index.ts that touches "the active account" is written against this
 * interface, so it doesn't need to know or care which kind of account is actually active.
 */
export interface WalletAccountApi {
  getComponentAddress(): Promise<string>;
  getWalletAddress(): Promise<string>;
  getBalances(): Promise<TokenBalance[]>;
  /** The indexer connection this account's reads are served from — used for general-purpose
   * substate lookups (`tari_getSubstate`) that aren't tied to any one account method. */
  getProvider(): Promise<IndexerProvider>;
  execute(instructions: Instruction[], opts?: TransactionExecuteOpts): Promise<unknown>;
  send(recipientAddress: string, resourceAddress: string, amount: bigint, maxFee?: bigint): Promise<unknown>;
  claimTestnetXtr(): Promise<unknown>;
}
