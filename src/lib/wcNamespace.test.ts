import { describe, expect, it } from "vitest";
import { isWcMethod, isWcOrigin, networkFromWcChainId, TARI_WC_METHODS, wcChainId, wcOrigin } from "./wcNamespace";

describe("wcNamespace", () => {
  it("round-trips chain ids for every network", () => {
    for (const n of ["mainnet", "esmeralda", "igor"] as const) expect(networkFromWcChainId(wcChainId(n))).toBe(n);
  });

  it("rejects foreign or malformed chain ids", () => {
    for (const c of ["eip155:1", "tari:devnet", "tari", "tari:mainnet:extra", "TARI:mainnet", ""]) {
      expect(networkFromWcChainId(c)).toBeNull();
    }
  });

  it("allowlists exactly the provider methods", () => {
    for (const m of TARI_WC_METHODS) expect(isWcMethod(m)).toBe(true);
    for (const m of ["eth_sendTransaction", "tari_submitTransaction", "", undefined, 1]) expect(isWcMethod(m)).toBe(false);
  });

  it("builds session origins from topics", () => {
    const topic = "0f".repeat(32);
    expect(wcOrigin(topic)).toBe(`wc:${topic}`);
    expect(isWcOrigin(wcOrigin(topic))).toBe(true);
  });
});
