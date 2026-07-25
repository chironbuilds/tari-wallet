import { describe, expect, it } from "vitest";
import type { IndexerGetTransactionResultResponse } from "@tari-project/ootle-ts-bindings";
import type { IndexerProvider } from "@tari-project/ootle-indexer";
import type { ShieldedOutputRecord } from "./storage";
import {
  extractMissingSubstateAddress,
  extractStaleLockVersion,
  pollTransactionResult,
  resolveSendPrivatelyPlan,
  resolveUnshieldPlan,
} from "./wallet";

function fakeRecord(overrides: Partial<ShieldedOutputRecord> = {}): ShieldedOutputRecord {
  return {
    accountId: "local:0",
    resourceAddress: "resource_xtr",
    commitment: "aa".repeat(32),
    amount: "100",
    transactionId: "tx-shield-1",
    createdAt: 0,
    spent: false,
    ...overrides,
  };
}

/** A fake `IndexerProvider` returning `responses` in order (repeating the last one once
 * exhausted) — only `getTransactionResult` is ever called by `pollTransactionResult`. */
function fakeProvider(responses: IndexerGetTransactionResultResponse[]): IndexerProvider {
  let i = 0;
  return {
    getTransactionResult: async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  } as unknown as IndexerProvider;
}

/** Builds a minimal-but-correctly-typed `Finalized` response wrapping the given finalize outcome
 * -- pollTransactionResult only ever reads `.execution_result.finalize.result`, but every other
 * field is still filled with a real, correctly-typed value rather than force-cast, so a future
 * change to what this function reads would still get a type-correct fixture to test against. */
function finalizedWith(result: unknown): IndexerGetTransactionResultResponse {
  return {
    result: {
      Finalized: {
        final_decision: "Commit",
        execution_result: {
          finalize: { result },
          execution_time: { secs: 0, nanos: 0 },
          execute_epoch: null,
          wasm_execution_points: 0n,
        },
        execution_time: { secs: 0, nanos: 0 },
        finalized_time: new Date().toISOString(),
        abort_details: null,
      },
    },
  } as unknown as IndexerGetTransactionResultResponse;
}

describe("extractMissingSubstateAddress", () => {
  it("matches a plain call-target miss (address before 'not found')", () => {
    expect(extractMissingSubstateAddress("At instruction #1: component_44066f512439abf4baa18bf5d357b190b631f1cc8be9bd4912ab97396ac7eb29 not found")).toBe(
      "component_44066f512439abf4baa18bf5d357b190b631f1cc8be9bd4912ab97396ac7eb29"
    );
  });

  it("matches a template-internal reference (address after 'not found:')", () => {
    expect(
      extractMissingSubstateAddress("Template referenced substate but it was not found: resource_e9b9309fad4f89800d0ddf12c7754edeeb4bafa5418013a4c70a51cce26af8e7")
    ).toBe("resource_e9b9309fad4f89800d0ddf12c7754edeeb4bafa5418013a4c70a51cce26af8e7");
  });

  it("matches a quoted cross-template-call miss", () => {
    expect(
      extractMissingSubstateAddress(
        "Cross-template call failed for method 'swap' on component 'component_f61cab40bca62ba3e98ff9b4d64d3dacb4d390bc41ff526d01e0ad94b148ba41': Substate 'component_f61cab40bca62ba3e98ff9b4d64d3dacb4d390bc41ff526d01e0ad94b148ba41' not found or is not a transaction input"
      )
    ).toBe("component_f61cab40bca62ba3e98ff9b4d64d3dacb4d390bc41ff526d01e0ad94b148ba41");
  });

  it("returns null for a message with no recognizable missing-substate pattern", () => {
    expect(extractMissingSubstateAddress("Some unrelated error message")).toBeNull();
  });

  it("returns null for an unrelated rejection reason", () => {
    expect(extractMissingSubstateAddress("InsufficientFeesPaid: not enough balance")).toBeNull();
  });
});

describe("extractStaleLockVersion", () => {
  it("extracts the substate id and version from a lock-failure message", () => {
    expect(extractStaleLockVersion("Lock failure: Substate vault_44032dd6cfe5c099cb3de86b9a2341271f23a7c670f472cee08475117f42c6aa:8 is DOWN")).toEqual({
      substateId: "vault_44032dd6cfe5c099cb3de86b9a2341271f23a7c670f472cee08475117f42c6aa",
      version: 8,
    });
  });

  it("returns null when the message doesn't match the lock-failure shape", () => {
    expect(extractStaleLockVersion("Some other error")).toBeNull();
  });

  it("returns null for a lock failure message missing the version number", () => {
    expect(extractStaleLockVersion("Substate vault_44032dd6cfe5c099cb3de86b9a2341271f23a7c670f472cee08475117f42c6aa is DOWN")).toBeNull();
  });
});

describe("pollTransactionResult", () => {
  it("returns the response immediately on a successful Finalized/Accept result", async () => {
    const response = finalizedWith({ Accept: { up_substates: [], down_substates: [] } });
    const result = await pollTransactionResult(fakeProvider([response]), "tx1");
    expect(result).toBe(response);
  });

  it("throws on a Rejected result", async () => {
    const response: IndexerGetTransactionResultResponse = { result: { Rejected: { details: "bad juju", rejected_time: "" } } };
    await expect(pollTransactionResult(fakeProvider([response]), "tx1")).rejects.toThrow("was rejected: bad juju");
  });

  it("throws on a Finalized/Reject outcome", async () => {
    const response = finalizedWith({ Reject: "some reason" });
    await expect(pollTransactionResult(fakeProvider([response]), "tx1")).rejects.toThrow("was rejected");
  });

  it("throws on a Finalized/AcceptFeeRejectRest outcome", async () => {
    const response = finalizedWith({ AcceptFeeRejectRest: [{ up_substates: [] }, "rest rejected"] });
    await expect(pollTransactionResult(fakeProvider([response]), "tx1")).rejects.toThrow("accepted the fee but rejected the rest");
  });

  it("keeps polling through Pending responses until finalized", async () => {
    const finalized = finalizedWith({ Accept: { up_substates: [], down_substates: [] } });
    const provider = fakeProvider([{ result: "Pending" }, finalized]);
    const result = await pollTransactionResult(provider, "tx1", 60_000);
    expect(result).toBe(finalized);
  });

  it("times out if the transaction stays Pending past timeoutMs", async () => {
    const provider = fakeProvider([{ result: "Pending" }]);
    await expect(pollTransactionResult(provider, "tx1", 10)).rejects.toThrow("Timed out waiting for transaction tx1 to finalize.");
  });
});

describe("resolveUnshieldPlan", () => {
  it("computes the private remainder for a valid partial reveal", () => {
    const record = fakeRecord({ amount: "100" });
    const { remainder } = resolveUnshieldPlan([record], record.resourceAddress, record.commitment, 40n);
    expect(remainder).toBe(60n);
  });

  it("throws when no unspent record matches the resource/commitment", () => {
    const record = fakeRecord();
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, "bb".repeat(32), 40n)).toThrow(
      "No known unspent shielded output matches that commitment."
    );
    expect(() => resolveUnshieldPlan([record], "resource_other", record.commitment, 40n)).toThrow(
      "No known unspent shielded output matches that commitment."
    );
  });

  it("ignores a record already marked spent", () => {
    const record = fakeRecord({ spent: true });
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, record.commitment, 40n)).toThrow(
      "No known unspent shielded output matches that commitment."
    );
  });

  it("throws for a zero or negative reveal amount", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, record.commitment, 0n)).toThrow(
      "The amount to reveal must be greater than zero."
    );
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, record.commitment, -5n)).toThrow(
      "The amount to reveal must be greater than zero."
    );
  });

  it("throws when the reveal amount would leave zero remainder (the full-record case)", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, record.commitment, 100n)).toThrow(
      "Can't unshield the full amount in one transaction"
    );
  });

  it("throws when the reveal amount exceeds the record's amount", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, record.commitment, 150n)).toThrow(
      "Can't unshield the full amount in one transaction"
    );
  });

  it("allows revealing all but the smallest unit", () => {
    const record = fakeRecord({ amount: "100" });
    const { remainder } = resolveUnshieldPlan([record], record.resourceAddress, record.commitment, 99n);
    expect(remainder).toBe(1n);
  });
});

describe("resolveSendPrivatelyPlan", () => {
  it("computes zero change when sending the full record amount", () => {
    const record = fakeRecord({ amount: "100" });
    const { changeAmount } = resolveSendPrivatelyPlan([record], record.resourceAddress, record.commitment, 100n);
    expect(changeAmount).toBe(0n);
  });

  it("computes the private change for a partial send", () => {
    const record = fakeRecord({ amount: "100" });
    const { changeAmount } = resolveSendPrivatelyPlan([record], record.resourceAddress, record.commitment, 40n);
    expect(changeAmount).toBe(60n);
  });

  it("throws when no unspent record matches the resource/commitment", () => {
    const record = fakeRecord();
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, "bb".repeat(32), 40n)).toThrow(
      "No known unspent shielded output matches that commitment."
    );
    expect(() => resolveSendPrivatelyPlan([record], "resource_other", record.commitment, 40n)).toThrow(
      "No known unspent shielded output matches that commitment."
    );
  });

  it("ignores a record already marked spent", () => {
    const record = fakeRecord({ spent: true });
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, record.commitment, 40n)).toThrow(
      "No known unspent shielded output matches that commitment."
    );
  });

  it("throws for a zero or negative send amount", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, record.commitment, 0n)).toThrow(
      "The amount to send must be greater than zero."
    );
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, record.commitment, -5n)).toThrow(
      "The amount to send must be greater than zero."
    );
  });

  it("throws when the send amount exceeds the record's amount", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, record.commitment, 101n)).toThrow(
      "Amount exceeds this output's private balance"
    );
  });
});
