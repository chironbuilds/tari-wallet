import { describe, expect, it } from "vitest";
import { nftSendability } from "./nftSendability";

// Shapes as the indexer decoder yields them (taken from Esmeralda's NFT faucet resource and a vault).
const open = { access_rules: { withdraw: "AllowAll", deposit: "AllowAll" }, auth_hook: null };
const restricted = { Restricted: { Require: { Require: { ScopedToComponent: "component_ff00" } } } };

describe("nftSendability", () => {
  it("allows a collection anyone may move, from a vault that isn't frozen", () => {
    expect(nftSendability(open, { freeze_flags: 0 })).toEqual({ canSend: true });
    expect(nftSendability(open, undefined)).toEqual({ canSend: true });
  });

  it("refuses a collection whose tokens can't leave the holder (soulbound)", () => {
    expect(nftSendability({ ...open, access_rules: { withdraw: "DenyAll", deposit: "AllowAll" } }, { freeze_flags: 0 })).toEqual({ canSend: false, reason: "rules" });
  });

  it("refuses a collection that needs a permission to move or receive", () => {
    expect(nftSendability({ ...open, access_rules: { withdraw: restricted, deposit: "AllowAll" } }, undefined)).toEqual({ canSend: false, reason: "rules" });
    expect(nftSendability({ ...open, access_rules: { withdraw: "AllowAll", deposit: "DenyAll" } }, undefined)).toEqual({ canSend: false, reason: "rules" });
  });

  it("refuses a collection whose transfers go through an approving contract", () => {
    expect(nftSendability({ ...open, auth_hook: { component: "component_ab", method: "on_transfer" } }, undefined)).toEqual({ canSend: false, reason: "rules" });
  });

  it("refuses a frozen vault", () => {
    expect(nftSendability(open, { freeze_flags: 1 })).toEqual({ canSend: false, reason: "frozen" });
  });

  it("refuses when the rules couldn't be read", () => {
    expect(nftSendability(undefined, undefined)).toEqual({ canSend: false, reason: "unknown" });
  });
});
