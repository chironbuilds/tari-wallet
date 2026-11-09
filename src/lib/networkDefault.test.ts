import { describe, expect, it } from "vitest";
import { canMoveToMainnetDefault, MAINNET_LAUNCH_MS } from "./networkDefault";

const unchosen = { network: "esmeralda", networkChosen: false } as const;

describe("canMoveToMainnetDefault", () => {
  it("waits for the launch time", () => {
    expect(canMoveToMainnetDefault(unchosen, MAINNET_LAUNCH_MS - 1)).toBe(false);
    expect(canMoveToMainnetDefault(unchosen, MAINNET_LAUNCH_MS)).toBe(true);
  });

  it("leaves a wallet that has picked a network alone", () => {
    expect(canMoveToMainnetDefault({ network: "esmeralda", networkChosen: true }, MAINNET_LAUNCH_MS)).toBe(false);
  });

  it("only moves wallets on the old default", () => {
    expect(canMoveToMainnetDefault({ network: "igor", networkChosen: false }, MAINNET_LAUNCH_MS)).toBe(false);
    expect(canMoveToMainnetDefault({ network: "mainnet", networkChosen: false }, MAINNET_LAUNCH_MS)).toBe(false);
  });
});
