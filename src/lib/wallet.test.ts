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
  selectShieldedUtxosForAmount,
  synthesizeShieldedOnlyBalances,
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

describe("selectShieldedUtxosForAmount", () => {
  it("picks a single largest-first record when it alone covers the target", () => {
    const small = fakeRecord({ commitment: "aa".repeat(32), amount: "30" });
    const big = fakeRecord({ commitment: "bb".repeat(32), amount: "100" });
    const { selected, total, unselected } = selectShieldedUtxosForAmount([small, big], "resource_xtr", 40n);
    expect(selected.map((r) => r.commitment)).toEqual([big.commitment]);
    expect(total).toBe(100n);
    expect(unselected.map((r) => r.commitment)).toEqual([small.commitment]);
  });

  it("combines multiple records when no single one covers the target", () => {
    const a = fakeRecord({ commitment: "aa".repeat(32), amount: "60" });
    const b = fakeRecord({ commitment: "bb".repeat(32), amount: "50" });
    const c = fakeRecord({ commitment: "cc".repeat(32), amount: "10" });
    const { selected, total, unselected } = selectShieldedUtxosForAmount([c, a, b], "resource_xtr", 100n);
    // Largest-first: a (60) then b (50) covers 100 with only 2 inputs, c left unselected.
    expect(selected.map((r) => r.commitment)).toEqual([a.commitment, b.commitment]);
    expect(total).toBe(110n);
    expect(unselected.map((r) => r.commitment)).toEqual([c.commitment]);
  });

  it("ignores records for a different resource or already spent", () => {
    const wrongResource = fakeRecord({ amount: "100", resourceAddress: "resource_other" });
    const spent = fakeRecord({ amount: "100", spent: true });
    const { selected, total } = selectShieldedUtxosForAmount([wrongResource, spent], "resource_xtr", 10n);
    expect(selected).toEqual([]);
    expect(total).toBe(0n);
  });

  it("selects everything available when the target exceeds the total balance", () => {
    const record = fakeRecord({ amount: "100" });
    const { selected, total } = selectShieldedUtxosForAmount([record], "resource_xtr", 500n);
    expect(selected).toEqual([record]);
    expect(total).toBe(100n);
  });
});

describe("resolveUnshieldPlan", () => {
  it("computes the private remainder for a valid partial reveal from a single record", () => {
    const record = fakeRecord({ amount: "100" });
    const { commitments, remainder } = resolveUnshieldPlan([record], record.resourceAddress, 40n);
    expect(commitments).toEqual([record.commitment]);
    expect(remainder).toBe(60n);
  });

  it("spends multiple records in one plan when needed to cover the amount", () => {
    const a = fakeRecord({ commitment: "aa".repeat(32), amount: "60" });
    const b = fakeRecord({ commitment: "bb".repeat(32), amount: "50" });
    const { commitments, remainder } = resolveUnshieldPlan([a, b], a.resourceAddress, 100n);
    expect(commitments).toEqual([a.commitment, b.commitment]);
    expect(remainder).toBe(10n);
  });

  it("throws when the resource has no unspent balance at all", () => {
    const record = fakeRecord({ spent: true });
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, 40n)).toThrow("Amount exceeds your private balance");
    expect(() => resolveUnshieldPlan([record], "resource_other", 40n)).toThrow("Amount exceeds your private balance");
  });

  it("throws for a zero or negative reveal amount", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, 0n)).toThrow("The amount to reveal must be greater than zero.");
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, -5n)).toThrow("The amount to reveal must be greater than zero.");
  });

  it("pulls in one more record when the minimal selection would leave zero remainder", () => {
    const a = fakeRecord({ commitment: "aa".repeat(32), amount: "60" });
    const b = fakeRecord({ commitment: "bb".repeat(32), amount: "60" });
    const { commitments, remainder } = resolveUnshieldPlan([a, b], a.resourceAddress, 60n);
    expect(commitments).toEqual([a.commitment, b.commitment]);
    expect(remainder).toBe(60n);
  });

  it("throws when revealing the full balance in one transaction with nothing left to add as remainder", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, 100n)).toThrow(
      "Can't unshield your full private balance in one transaction"
    );
  });

  it("throws when the reveal amount exceeds the total private balance", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveUnshieldPlan([record], record.resourceAddress, 150n)).toThrow("Amount exceeds your private balance");
  });

  it("allows revealing all but the smallest unit", () => {
    const record = fakeRecord({ amount: "100" });
    const { remainder } = resolveUnshieldPlan([record], record.resourceAddress, 99n);
    expect(remainder).toBe(1n);
  });
});

describe("resolveSendPrivatelyPlan", () => {
  it("computes zero change when sending the full balance", () => {
    const record = fakeRecord({ amount: "100" });
    const { commitments, changeAmount } = resolveSendPrivatelyPlan([record], record.resourceAddress, 100n);
    expect(commitments).toEqual([record.commitment]);
    expect(changeAmount).toBe(0n);
  });

  it("computes the private change for a partial send", () => {
    const record = fakeRecord({ amount: "100" });
    const { changeAmount } = resolveSendPrivatelyPlan([record], record.resourceAddress, 40n);
    expect(changeAmount).toBe(60n);
  });

  it("spends multiple records in one plan when needed to cover the amount", () => {
    const a = fakeRecord({ commitment: "aa".repeat(32), amount: "60" });
    const b = fakeRecord({ commitment: "bb".repeat(32), amount: "50" });
    const { commitments, changeAmount } = resolveSendPrivatelyPlan([a, b], a.resourceAddress, 100n);
    expect(commitments).toEqual([a.commitment, b.commitment]);
    expect(changeAmount).toBe(10n);
  });

  it("throws when the resource has no unspent balance at all", () => {
    const record = fakeRecord({ spent: true });
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, 40n)).toThrow("Amount exceeds your private balance");
    expect(() => resolveSendPrivatelyPlan([record], "resource_other", 40n)).toThrow("Amount exceeds your private balance");
  });

  it("throws for a zero or negative send amount", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, 0n)).toThrow("The amount to send must be greater than zero.");
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, -5n)).toThrow("The amount to send must be greater than zero.");
  });

  it("throws when the send amount exceeds the total private balance", () => {
    const record = fakeRecord({ amount: "100" });
    expect(() => resolveSendPrivatelyPlan([record], record.resourceAddress, 101n)).toThrow("Amount exceeds your private balance");
  });
});

describe("synthesizeShieldedOnlyBalances", () => {
  it("synthesizes a Stealth-kind balance for a resource with no vault at all", () => {
    const shieldedByResource = new Map([["resource_ghost", 250n]]);
    const [entry, ...rest] = synthesizeShieldedOnlyBalances(
      new Set(), // no vault-derived resources
      shieldedByResource,
      new Map([["resource_ghost", 6]]),
      new Map([["resource_ghost", "GHOST"]]),
      new Map([["resource_ghost", "Ghost Token"]])
    );
    expect(rest).toHaveLength(0);
    expect(entry).toEqual({
      resourceAddress: "resource_ghost",
      kind: "Stealth",
      amount: 0n,
      confidentialAmount: 250n,
      confidentialDecryptFailures: 0,
      divisibility: 6,
      symbol: "GHOST",
      name: "Ghost Token",
    });
  });

  it("skips a resource that already has a vault-derived entry", () => {
    const shieldedByResource = new Map([["resource_xtr", 100n]]);
    const result = synthesizeShieldedOnlyBalances(
      new Set(["resource_xtr"]), // already covered by a real vault
      shieldedByResource,
      new Map(),
      new Map(),
      new Map()
    );
    expect(result).toHaveLength(0);
  });

  it("falls back to divisibility 0 and null symbol/name when metadata lookup has nothing", () => {
    const shieldedByResource = new Map([["resource_unknown", 5n]]);
    const result = synthesizeShieldedOnlyBalances(new Set(), shieldedByResource, new Map(), new Map(), new Map());
    expect(result).toHaveLength(1);
    expect(result[0]?.divisibility).toBe(0);
    expect(result[0]?.symbol).toBeNull();
    expect(result[0]?.name).toBeNull();
  });

  it("returns nothing when there are no shielded-only resources", () => {
    expect(synthesizeShieldedOnlyBalances(new Set(), new Map(), new Map(), new Map(), new Map())).toHaveLength(0);
  });
});
