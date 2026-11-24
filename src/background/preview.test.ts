import { describe, expect, it, vi } from "vitest";

vi.mock("@tari-project/ootle", () => ({ getVaultIdsForAccount: vi.fn() }));
vi.mock("@chironbuilder/ootle-sdk", () => ({ OotleAccount: class {} }));
vi.mock("../lib/bor", () => ({ decodeSubstateValue: (v: unknown) => v }));

const { accountBalanceChanges, ownAccountCalls, rejectionOf, previewOperation } = await import("./preview");
const { OotleAccount } = await import("@chironbuilder/ootle-sdk");
const { getVaultIdsForAccount } = await import("@tari-project/ootle");

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

describe("previewOperation", () => {
  const VAULT = "vault_" + "1".repeat(64);
  const events = [
    { substate_id: VAULT, topic: "std.vault.withdraw", payload: { amount: 2_500_000 } },
    { substate_id: "vault_other", topic: "std.vault.withdraw", payload: { amount: 1 } },
  ];

  function account(over: Record<string, unknown> = {}) {
    vi.mocked(getVaultIdsForAccount).mockResolvedValue([VAULT] as never);
    return Object.assign(new (OotleAccount as unknown as new () => object)(), {
      getComponentAddress: async () => ME,
      getProvider: async () => ({
        fetchSubstates: async () => ({ substates: { [VAULT]: { value: { Vault: { resource_container: { Fungible: { address: TARI } } } } } } }),
      }),
      execute: vi.fn(async () => ({ result: result(events) })),
      dryRunWithdrawStealthAndExecute: vi.fn(async () => result(events)),
      verifyHtlc: vi.fn(async () => ({ value: 42n, problems: ["refund epoch soon"] })),
      ...over,
    }) as never;
  }
  const call = (address: string, method: string) => ({ CallMethod: { call: { Address: address }, method, args: [] } });

  it.each(["shield", "unshield", "sendPrivately", "htlcFund", "depositConfidential", "htlcRefund"])(
    "returns nothing for %s, which the wallet builds itself",
    async (kind) => {
      expect(await previewOperation(account(), { kind } as never)).toBeNull();
    },
  );

  it("can't simulate for a non-local account", async () => {
    const daemon = {} as never;
    expect(await previewOperation(daemon, { kind: "instructions", instructions: [] } as never)).toMatchObject({
      simulated: false,
      error: expect.stringMatching(/local account/),
    });
  });

  it("simulates raw instructions as a dry run and reports what leaves the account", async () => {
    const acc = account();
    const instructions = [call(OTHER, "buy"), call(ME, "withdraw")];
    const preview = await previewOperation(acc, { kind: "instructions", instructions, maxFee: "500" } as never);
    expect((acc as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledWith(instructions, expect.objectContaining({ dryRun: true, maxFee: 500n }));
    expect(preview).toMatchObject({ simulated: true, wouldFail: undefined, ownAccountCalls: ["withdraw"] });
    expect(preview!.changes).toEqual(new Map([[TARI, -2_500_000n]]));
  });

  it("reports when the engine would reject the transaction", async () => {
    const acc = account({ execute: vi.fn(async () => ({ result: result([], { Reject: { ExecutionFailure: "insufficient" } }) })) });
    expect(await previewOperation(acc, { kind: "instructions", instructions: [] } as never)).toMatchObject({
      simulated: true,
      wouldFail: expect.stringContaining("insufficient"),
    });
  });

  it("turns a simulation error into a message, keeping the own-account calls it found", async () => {
    const acc = account({ execute: vi.fn(async () => Promise.reject(new Error("indexer unreachable"))) });
    expect(await previewOperation(acc, { kind: "instructions", instructions: [call(ME, "withdraw")] } as never)).toMatchObject({
      simulated: false,
      error: "indexer unreachable",
      ownAccountCalls: ["withdraw"],
    });
  });

  it("simulates withdrawStealthAndExecute with its own dry run", async () => {
    const acc = account();
    const op = { kind: "withdrawStealthAndExecute", resourceAddress: TARI, amount: "100", workspaceVarName: "b", followUpInstructions: [], maxFee: "9" };
    expect(await previewOperation(acc, op as never)).toMatchObject({ simulated: true });
    expect((acc as { dryRunWithdrawStealthAndExecute: ReturnType<typeof vi.fn> }).dryRunWithdrawStealthAndExecute).toHaveBeenCalledWith(TARI, 100n, "b", [], [], 9n);
  });

  it("says when a kind can't be simulated yet", async () => {
    const op = { kind: "redeemStealthOutputAndExecute", resourceAddress: TARI, commitmentHex: "00", revealedAmount: "1", followUpInstructions: [] };
    expect(await previewOperation(account(), op as never)).toMatchObject({ simulated: false, error: expect.stringMatching(/can't be simulated/) });
  });

  it("checks an HTLC claim and passes its problems through", async () => {
    const op = { kind: "htlcClaim", resourceAddress: TARI, commitment: "c", conditions: {}, preimageHex: "ff" };
    expect(await previewOperation(account(), op as never)).toMatchObject({ htlc: { value: 42n, problems: ["refund epoch soon"] } });
    const failing = account({ verifyHtlc: vi.fn(async () => Promise.reject(new Error("not an HTLC"))) });
    expect(await previewOperation(failing, op as never)).toMatchObject({ error: "not an HTLC" });
  });
});
