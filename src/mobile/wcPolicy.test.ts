import { describe, expect, it } from "vitest";
import { approvedNamespaces, checkRequest, evaluateProposal } from "./wcPolicy";

const ok = { validation: "VALID" as const };

describe("evaluateProposal", () => {
  it("accepts a proposal requiring our chain", () => {
    expect(evaluateProposal({ requiredNamespaces: { tari: { chains: ["tari:esmeralda"] } } }, ok, "esmeralda")).toEqual({ ok: true });
  });

  it("accepts our chain offered only as optional", () => {
    expect(
      evaluateProposal({ requiredNamespaces: {}, optionalNamespaces: { tari: { chains: ["tari:mainnet", "tari:esmeralda"] } } }, ok, "mainnet")
    ).toEqual({ ok: true });
  });

  it("accepts a chain-keyed namespace", () => {
    expect(evaluateProposal({ requiredNamespaces: { "tari:mainnet": {} } }, ok, "mainnet")).toEqual({ ok: true });
  });

  it("refuses scams even when everything else matches", () => {
    const v = evaluateProposal({ requiredNamespaces: { tari: { chains: ["tari:mainnet"] } } }, { validation: "VALID", isScam: true }, "mainnet");
    expect(v.ok).toBe(false);
  });

  it("refuses other required namespaces", () => {
    const v = evaluateProposal({ requiredNamespaces: { eip155: { chains: ["eip155:1"] } } }, ok, "mainnet");
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("eip155") });
  });

  it("refuses a required chain on another network", () => {
    const v = evaluateProposal({ requiredNamespaces: { tari: { chains: ["tari:mainnet", "tari:esmeralda"] } } }, ok, "mainnet");
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("Switch network") });
  });

  it("refuses unknown Tari chains and proposals that never mention ours", () => {
    expect(evaluateProposal({ requiredNamespaces: { tari: { chains: ["tari:devnet"] } } }, ok, "mainnet").ok).toBe(false);
    expect(evaluateProposal({ requiredNamespaces: {}, optionalNamespaces: { tari: { chains: ["tari:esmeralda"] } } }, ok, "mainnet").ok).toBe(false);
    expect(evaluateProposal({ requiredNamespaces: {} }, ok, "mainnet").ok).toBe(false);
  });
});

describe("checkRequest", () => {
  it("passes a known method on our chain", () => {
    expect(checkRequest("tari_getBalances", "tari:mainnet", "mainnet")).toEqual({ ok: true });
  });

  it("refuses unknown methods, unknown chains and the other network", () => {
    expect(checkRequest("tari_submitTransaction", "tari:mainnet", "mainnet").ok).toBe(false);
    expect(checkRequest("tari_getBalances", "eip155:1", "mainnet").ok).toBe(false);
    expect(checkRequest("tari_getBalances", "tari:esmeralda", "mainnet").ok).toBe(false);
  });
});

describe("approvedNamespaces", () => {
  it("approves one chain, every method, and the CAIP-10 account", () => {
    const ns = approvedNamespaces("esmeralda", "component_" + "ab".repeat(32));
    expect(ns.tari.chains).toEqual(["tari:esmeralda"]);
    expect(ns.tari.accounts).toEqual([`tari:esmeralda:component_${"ab".repeat(32)}`]);
    expect(ns.tari.methods).toContain("tari_createTransactionRequest");
    expect(ns.tari.events).toEqual(["accountsChanged", "networkChanged"]);
  });
});
