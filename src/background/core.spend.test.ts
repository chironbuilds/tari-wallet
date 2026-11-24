// The paths that move funds, with the SDK account's network calls replaced by spies: what a dApp
// may see of balances, dry runs, submitting an approved request exactly once, fee choices, the
// follow-up-instruction guard, and the popup's own send. Checks what the core asks the account to
// do, not the on-chain result (that's the live suite's job).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OotleAccount } from "@chironbuilder/ootle-sdk";
import { TARI_RESOURCE_ADDRESS } from "../popup/format";
import { getState } from "../lib/storage";
import { connect, createWallet, setupHarness, tick, type Harness } from "./testHarness";

let h: Harness;
let execute: ReturnType<typeof vi.spyOn>;
let send: ReturnType<typeof vi.spyOn>;
let withdrawStealth: ReturnType<typeof vi.spyOn>;

const TOKEN = "resource_" + "ab".repeat(32);
const BALANCES = [
  {
    resourceAddress: TARI_RESOURCE_ADDRESS,
    kind: "Stealth",
    amount: 5_000_000n,
    confidentialAmount: 2_000_000n,
    confidentialDecryptFailures: 0,
    divisibility: 6,
    symbol: "TARI",
    name: "Tari",
  },
  {
    resourceAddress: TOKEN,
    kind: "Fungible",
    amount: 12_345_678_900n,
    confidentialAmount: 0n,
    confidentialDecryptFailures: 0,
    divisibility: 8,
    symbol: "DEMO",
    name: null,
  },
];

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network disabled in unit tests"))));
  vi.spyOn(OotleAccount.prototype, "getBalances").mockResolvedValue(BALANCES as never);
  execute = vi.spyOn(OotleAccount.prototype, "execute").mockResolvedValue({ transactionId: "tx-1" } as never);
  send = vi.spyOn(OotleAccount.prototype, "send").mockResolvedValue({ transactionId: "tx-send" } as never);
  withdrawStealth = vi.spyOn(OotleAccount.prototype, "withdrawStealthAndExecute").mockResolvedValue({ transactionId: "tx-w" } as never);
  h = setupHarness();
  await createWallet(h);
});

afterEach(() => {
  h.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const create = (operation: Record<string, unknown>) => h.page<{ requestId: string }>("tari_createTransactionRequest", operation);
const status = async (requestId: string) => (await h.page<{ status: string; error?: string }>("tari_getTransactionRequest", { requestId }));
const settle = async () => {
  await tick();
  await tick();
};

describe("balances a dApp can see", () => {
  beforeEach(async () => {
    await connect(h);
  });

  it("shows public amounts as strings and hides private amounts without a view grant", async () => {
    const balances = await h.page<Array<Record<string, unknown>>>("tari_getBalances");
    expect(balances[0]).toMatchObject({
      resourceAddress: TARI_RESOURCE_ADDRESS,
      amount: "5000000",
      confidentialAmount: "0",
      privateVisible: false,
      divisibility: 6,
    });
    expect(balances[1]).toMatchObject({ amount: "12345678900", divisibility: 8, symbol: "DEMO" });
    // Nothing internal leaks through.
    expect(Object.keys(balances[0]!)).not.toContain("confidentialDecryptFailures");
  });

  it("shows private amounts once the site holds a view grant", async () => {
    await h.page("tari_requestViewAccess");
    const [tari] = await h.page<Array<Record<string, unknown>>>("tari_getBalances");
    expect(tari).toMatchObject({ confidentialAmount: "2000000", privateVisible: true });
  });
});

describe("dry runs", () => {
  beforeEach(async () => {
    await connect(h);
    h.shown.length = 0;
  });

  it("simulate without an approval and pass the budget through", async () => {
    const instructions = [{ CallMethod: { call: { Address: "component_x" }, method: "quote", args: [] } }];
    expect(await h.page("tari_signAndSubmitTransaction", { instructions, dryRun: true, maxFee: "1500" })).toEqual({ transactionId: "tx-1" });
    expect(h.shown).toEqual([]);
    expect(execute).toHaveBeenCalledWith(instructions, expect.objectContaining({ dryRun: true, maxFee: 1500n }));
  });

  it("never record a transaction request", async () => {
    await h.page("tari_signAndSubmitTransaction", { instructions: [], dryRun: true });
    expect((await getState()).transactionRequests).toEqual([]);
  });
});

describe("submitting an approved request", () => {
  beforeEach(async () => {
    await connect(h);
  });

  it("executes exactly what was approved, once, and records the result", async () => {
    const instructions = [{ CallMethod: { call: { Address: "component_x" }, method: "buy", args: [] } }];
    const { requestId } = await create({ kind: "instructions", instructions, maxFee: "2000" });
    await settle();
    expect(await h.page("tari_submitTransactionRequest", { requestId })).toEqual({ transactionId: "tx-1" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(instructions, expect.objectContaining({ maxFee: 2000n, feeType: { kind: "transparent" } }));
    expect(execute.mock.calls[0]![1]).not.toHaveProperty("dryRun", true);
    expect(await status(requestId)).toMatchObject({ status: "submitted" });

    // A second submit can't run it again.
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(/status is "submitted"/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("two submits racing each other execute it once", async () => {
    let finish!: () => void;
    execute.mockImplementation(() => new Promise((r) => (finish = () => r({ transactionId: "tx-race" }))) as never);
    const { requestId } = await create({ kind: "instructions", instructions: [] });
    await settle();
    const first = h.pageError("tari_submitTransactionRequest", { requestId });
    const second = h.pageError("tari_submitTransactionRequest", { requestId });
    await settle();
    finish();
    const errors = (await Promise.all([first, second])).filter(Boolean);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/status is "submitting"/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a failed execution is recorded as failed and can't be retried blindly", async () => {
    execute.mockRejectedValue(new Error("Insufficient funds"));
    const { requestId } = await create({ kind: "instructions", instructions: [] });
    await settle();
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(/Insufficient funds/);
    expect(await status(requestId)).toMatchObject({ status: "failed" });
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(/status is "failed"/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("the deprecated blocking call approves, submits and returns the result", async () => {
    expect(await h.page("tari_signAndSubmitTransaction", { instructions: [], maxFee: "10" })).toEqual({ transactionId: "tx-1" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("nothing executes when the user rejects", async () => {
    h.answerWith("reject");
    expect(await h.pageError("tari_signAndSubmitTransaction", { instructions: [] })).toMatch(/reject/i);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("fee choice", () => {
  beforeEach(async () => {
    await connect(h);
  });

  const feeOf = () => (execute.mock.calls[0]![1] as { feeType: { kind: string } }).feeType.kind;

  it("uses the fee type the dApp suggested", async () => {
    const { requestId } = await create({ kind: "instructions", instructions: [], feeType: "private" });
    await settle();
    await h.page("tari_submitTransactionRequest", { requestId });
    expect(feeOf()).toBe("private");
  });

  it("the user can change a suggested fee type on the approval screen", async () => {
    h.answerWith("approve", "private");
    const { requestId } = await create({ kind: "instructions", instructions: [], feeType: "transparent" });
    await settle();
    await h.page("tari_submitTransactionRequest", { requestId });
    expect(feeOf()).toBe("private");
  });

  it("an enforced fee type can't be changed, even if a different choice arrives with the approval", async () => {
    h.answerWith("approve", "transparent");
    const { requestId } = await create({ kind: "instructions", instructions: [], feeType: "private", enforceFeeType: true });
    await settle();
    await h.page("tari_submitTransactionRequest", { requestId });
    expect(feeOf()).toBe("private");
  });

  it("the approval screen is told whether the fee type is locked", async () => {
    h.answerWith("hold");
    await create({ kind: "instructions", instructions: [], feeType: "private", enforceFeeType: true });
    await tick();
    expect(h.shown.find((a) => a.kind === "transaction")).toMatchObject({ feeChoice: { enforced: true } });
  });
});

describe("withdrawStealthAndExecute follow-up guard", () => {
  let own: string;
  beforeEach(async () => {
    own = await connect(h);
  });

  const operation = (followUpInstructions: unknown[]) => ({
    kind: "withdrawStealthAndExecute",
    resourceAddress: TARI_RESOURCE_ADDRESS,
    amount: "100",
    workspaceVarName: "bucket",
    followUpInstructions,
  });

  it("refuses follow-up calls that would spend from the user's own account", async () => {
    const { requestId } = await create(operation([{ CallMethod: { call: { Address: own }, method: "withdraw", args: [] } }]));
    await settle();
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(/call "withdraw" on your own account/);
    expect(withdrawStealth).not.toHaveBeenCalled();
  });

  it("allows depositing back into the user's own account", async () => {
    const follow = [{ CallMethod: { call: { Address: own }, method: "deposit", args: [] } }];
    const { requestId } = await create(operation(follow));
    await settle();
    await h.page("tari_submitTransactionRequest", { requestId });
    expect(withdrawStealth).toHaveBeenCalledWith(TARI_RESOURCE_ADDRESS, 100n, "bucket", follow, [], undefined, { kind: "transparent" });
  });

  it("allows calls on other components", async () => {
    const { requestId } = await create(operation([{ CallMethod: { call: { Address: "component_" + "cd".repeat(32) }, method: "buy", args: [] } }]));
    await settle();
    await h.page("tari_submitTransactionRequest", { requestId });
    expect(withdrawStealth).toHaveBeenCalledTimes(1);
  });
});

describe("the popup's own send", () => {
  const RECIPIENT = "otl_esm_1" + "q".repeat(60);

  it("sends the exact amount and records it in history", async () => {
    await h.popup({ kind: "popup-send", recipientWalletAddress: RECIPIENT, resourceAddress: TARI_RESOURCE_ADDRESS, amount: "1500000" });
    expect(send).toHaveBeenCalledWith(RECIPIENT, TARI_RESOURCE_ADDRESS, 1_500_000n);
    const [entry] = (await getState()).transactionHistory;
    expect(entry).toMatchObject({ kind: "send", status: "confirmed", amount: "1500000", counterparty: RECIPIENT, network: "esmeralda" });
  });

  it("records a failed send and reports the error", async () => {
    send.mockRejectedValue(new Error("Insufficient funds"));
    await expect(
      h.popup({ kind: "popup-send", recipientWalletAddress: RECIPIENT, resourceAddress: TARI_RESOURCE_ADDRESS, amount: "1" }),
    ).rejects.toThrow("Insufficient funds");
    expect((await getState()).transactionHistory[0]).toMatchObject({ kind: "send", status: "failed" });
  });

  it("refuses to send while locked", async () => {
    await h.popup({ kind: "popup-lock" });
    await expect(
      h.popup({ kind: "popup-send", recipientWalletAddress: RECIPIENT, resourceAddress: TARI_RESOURCE_ADDRESS, amount: "1" }),
    ).rejects.toThrow(/locked/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("the popup reads balances from the active account", async () => {
    expect(await h.popup({ kind: "popup-get-balances" })).toEqual(BALANCES);
  });
});
