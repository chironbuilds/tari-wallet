import { describe, expect, it } from "vitest";
import { classifyProviderError } from "./messages";

// Every message string here is copied verbatim from an actual `throw new Error(...)` site in
// background/index.ts's handlePageRequest (or something it calls) -- this locks the classifier to
// what those throw sites actually say today, so a message wording change that silently drops out
// of one of these buckets fails loudly here instead of only showing up as a dApp getting the wrong
// `.code`.
describe("classifyProviderError", () => {
  it("classifies user-declined approvals as 4001 (rejected)", () => {
    expect(classifyProviderError("Connection request rejected.")).toEqual({ code: 4001, message: "Request rejected by the user" });
    expect(classifyProviderError("Rejected by the user.")).toEqual({ code: 4001, message: "Request rejected by the user" });
    expect(classifyProviderError("Transaction rejected.")).toEqual({ code: 4001, message: "Request rejected by the user" });
  });

  it("does not classify a genuine on-chain transaction rejection as user-declined, even though its message also contains 'rejected' (confirmed live against a daemon: a real Reject outcome was previously misreported as 4001)", () => {
    expect(classifyProviderError("Transaction abc123 was rejected: SubstateNotFound")).toEqual({
      code: -32603,
      message: "Transaction abc123 was rejected: SubstateNotFound",
    });
    expect(classifyProviderError("Transaction abc123 accepted the fee but rejected the rest: InsufficientFeesPaid")).toEqual({
      code: -32603,
      message: "Transaction abc123 accepted the fee but rejected the rest: InsufficientFeesPaid",
    });
  });

  it("classifies no-connection/locked-wallet states as 4100 (unauthorized)", () => {
    expect(classifyProviderError("Wallet is locked.")).toEqual({
      code: 4100,
      message: "Not connected — call tari_requestAccounts first",
    });
    expect(classifyProviderError("Site is not connected. Call tari_requestAccounts first.")).toEqual({
      code: 4100,
      message: "Not connected — call tari_requestAccounts first",
    });
  });

  it("classifies an unknown RPC method as 4200 (unsupported), keeping the method name", () => {
    expect(classifyProviderError("Unknown method: tari_madeUpMethod")).toEqual({
      code: 4200,
      message: "Unsupported method: tari_madeUpMethod",
    });
  });

  it("falls back to -32603 (internal) for anything else, preserving the original message", () => {
    expect(classifyProviderError("No wallet set up in the Tari extension yet.")).toEqual({
      code: -32603,
      message: "No wallet set up in the Tari extension yet.",
    });
    expect(classifyProviderError("Indexer request timed out")).toEqual({ code: -32603, message: "Indexer request timed out" });
  });
});
