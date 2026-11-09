import type { NetworkName } from "@chironbuilder/ootle-sdk";

/** Ootle mainnet launch: 2026-11-11 11:11 UTC. */
export const MAINNET_LAUNCH_MS = Date.UTC(2026, 10, 11, 11, 11, 0);

/** Whether a wallet that has never picked a network should be checked for the move to mainnet. */
export function canMoveToMainnetDefault(state: { network: NetworkName; networkChosen: boolean }, now: number): boolean {
  return now >= MAINNET_LAUNCH_MS && !state.networkChosen && state.network === "esmeralda";
}
