import { describe, expect, it, vi } from "vitest";

vi.mock("@tari-project/ootle", () => ({ getVaultIdsForAccount: vi.fn() }));
vi.mock("@chironbuilder/ootle-sdk", () => ({ OotleAccount: class {} }));
vi.mock("../lib/bor", () => ({ decodeSubstateValue: (v: unknown) => v }));

const { accountBalanceChanges, ownAccountCalls, rejectionOf } = await import("./preview");

const ME = "component_" + "a".repeat(64);
const OTHER = "component_" + "b".repeat(64);
const TARI = "resource_" + "01".repeat(32);
const TOKEN = "resource_" + "cd".repeat(32);

function result(events: unknown[], outcome: unknown = "Accept") {
  return { finalize: { events, result: outcome } } as never;
}

describe("ownAccountCalls", () => {
  it("flags non-deposit methods on the signing account only", () => {
    const instructions = [
      { CallMethod: { call: { Address: ME }, method: "withdraw", args: [] } },
      { CallMethod: { call: { Address: ME }, method: "deposit", args: [] } },
      { CallMethod: { call: { Address: OTHER }, method: "withdraw", args: [] } },
      { CallMethod: { call: { Workspace: 0 }, method: "withdraw", args: [] } },
      "DropAllProofsInWorkspace",
    ] as never;
    expect(ownAccountCalls(instructions, ME)).toEqual(["withdraw"]);
  });
});

describe("accountBalanceChanges", () => {
  const vaults = new Map([
    ["vault_1", TARI],
    ["vault_2", TOKEN],
  ]);

  it("nets withdrawals and deposits per resource on the account's own vaults", () => {
    const changes = accountBalanceChanges(
      result([
        { substate_id: "vault_1", topic: "std.vault.withdraw", payload: { amount: 5_000_000 } },
        { substate_id: "vault_1", topic: "std.vault.deposit", payload: { amount: "1000000" } },
        { substate_id: "vault_2", topic: "std.vault.deposit", payload: { amount: 7 } },
        { substate_id: "vault_9", topic: "std.vault.withdraw", payload: { amount: 999 } },
        { substate_id: "vault_1", topic: "std.vault.pay_fee", payload: { amount: 100 } },
      ]),
      vaults
    );
    expect(changes).toEqual(new Map([[TARI, -4_000_000n], [TOKEN, 7n]]));
  });

  it("drops resources whose net change is zero and ignores malformed amounts", () => {
    const changes = accountBalanceChanges(
      result([
        { substate_id: "vault_1", topic: "std.vault.withdraw", payload: { amount: 3 } },
        { substate_id: "vault_1", topic: "std.vault.deposit", payload: { amount: 3 } },
        { substate_id: "vault_2", topic: "std.vault.withdraw", payload: { amount: "1.5" } },
      ]),
      vaults
    );
    expect(changes.size).toBe(0);
  });
});

describe("rejectionOf", () => {
  it("reports Reject and AcceptFeeRejectRest, nothing for Accept", () => {
    expect(rejectionOf(result([]))).toBeUndefined();
    expect(rejectionOf(result([], { Reject: { ExecutionFailure: "boom" } }))).toContain("boom");
    expect(rejectionOf(result([], { AcceptFeeRejectRest: [{}, { ExecutionFailure: "nope" }] }))).toContain("nope");
  });
});
