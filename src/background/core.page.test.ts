// The dApp-facing request handler (handlePageRequest): who may call what, what needs the user's
// approval, and what a site can learn. Runs the real core over an in-memory platform; the network
// is stubbed out, so only paths that need no indexer are exercised here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PENDING_APPROVALS_PER_ORIGIN, MAX_PENDING_APPROVALS_TOTAL } from "./approvals";
import { sanitizeForMessage } from "./core";
import { OTHER_SITE, PASSWORD, SITE, connect, createWallet, setupHarness, tick, type Harness } from "./testHarness";

let h: Harness;

beforeEach(() => {
  // No test here may reach a real indexer.
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network disabled in unit tests"))));
  h = setupHarness();
});

afterEach(() => {
  h.cleanup();
  vi.unstubAllGlobals();
});

const NOT_CONNECTED = /not connected/i;

describe("origin checks", () => {
  it.each(["http://dapp.example", "ftp://dapp.example", "not a url", "chrome-extension://abc"])("refuses the insecure origin %s", async (origin) => {
    await createWallet(h);
    expect(await h.pageError("tari_getNetwork", undefined, origin)).toMatch(/https/);
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:5173"])("allows the loopback dev origin %s", async (origin) => {
    await createWallet(h);
    expect(await h.page("tari_getNetwork", undefined, origin)).toBe("esmeralda");
  });

  it("rejects an unknown method", async () => {
    await createWallet(h);
    expect(await h.pageError("tari_stealAllFunds")).toMatch(/Unknown method/);
  });
});

describe("before connecting", () => {
  beforeEach(async () => {
    await createWallet(h);
  });

  it("answers tari_getNetwork without a connection", async () => {
    expect(await h.page("tari_getNetwork")).toBe("esmeralda");
  });

  it("reveals no accounts or balances", async () => {
    expect(await h.page("tari_getAccounts")).toEqual([]);
    expect(await h.page("tari_getBalances")).toEqual([]);
  });

  it.each([
    ["tari_getWalletAddress", undefined],
    ["tari_signWalletOwnershipChallenge", { challenge: "x" }],
    ["tari_signOwnershipChallenge", { resourceAddress: "r", substateId: "s", challenge: "x" }],
    ["tari_getCapabilities", undefined],
    ["tari_getSubstate", { substateId: "component_00" }],
    ["tari_getTransactionResult", { transactionId: "00" }],
    ["tari_signAndSubmitTransaction", { instructions: [] }],
    ["tari_signAndSubmitTransaction", { instructions: [], dryRun: true }],
    ["tari_withdrawStealthAndExecute", { resourceAddress: "r", amount: "1", workspaceVarName: "b", followUpInstructions: [] }],
    ["tari_htlcFund", { resourceAddress: "r", amount: "1", claimantWalletAddress: "a", hashLockHex: "00", refundEpoch: "1" }],
    ["tari_createTransactionRequest", { kind: "instructions", instructions: [] }],
    ["tari_getTransactionRequest", { requestId: "x" }],
    ["tari_submitTransactionRequest", { requestId: "x" }],
    ["tari_requestViewAccess", undefined],
    ["tari_getViewAccess", undefined],
    ["tari_getPrivateBalances", undefined],
    ["tari_getShieldedOutputs", undefined],
    ["tari_scanForPrivatePayments", undefined],
    ["tari_scanForResourceUtxos", { resourceAddress: "r" }],
    ["tari_scanForOwnedUtxos", { resourceAddress: "r" }],
    ["tari_claimPrivatePayment", { resourceAddress: "r", commitment: "c" }],
  ])("refuses %s", async (method, params) => {
    expect(await h.pageError(method, params)).toMatch(NOT_CONNECTED);
    expect(h.shown).toEqual([]); // and no approval window was opened
  });

  it("allows revoking view access it never had (idempotent)", async () => {
    expect(await h.page("tari_revokeViewAccess")).toBeNull();
  });
});

describe("connecting", () => {
  it("refuses to connect when no wallet exists", async () => {
    expect(await h.pageError("tari_requestAccounts")).toMatch(/No wallet/);
  });

  it("asks once, then binds the site to the active account", async () => {
    await createWallet(h);
    const address = await connect(h);
    expect(address).toMatch(/^component_[0-9a-f]{64}$/);
    expect(h.shown.map((a) => a.kind)).toEqual(["connect"]);
    expect(h.shown[0]!.origin).toBe(SITE);
    expect(await h.page("tari_getAccounts")).toEqual([address]);

    // Already connected: no second prompt.
    expect(await h.page("tari_requestAccounts")).toEqual([address]);
    expect(h.shown).toHaveLength(1);
  });

  it.each(["reject", "dismiss", "fail-to-open"] as const)("a connect prompt that is %s leaves the site unconnected", async (action) => {
    await createWallet(h);
    h.answerWith(action);
    expect(await h.pageError("tari_requestAccounts")).toMatch(/rejected/i);
    expect(await h.page("tari_getAccounts")).toEqual([]);
    expect(await h.pageError("tari_getWalletAddress")).toMatch(NOT_CONNECTED);
  });

  it("keeps connections per origin", async () => {
    await createWallet(h);
    await connect(h, SITE);
    expect(await h.page("tari_getAccounts", undefined, OTHER_SITE)).toEqual([]);
    expect(await h.pageError("tari_getWalletAddress", undefined, OTHER_SITE)).toMatch(NOT_CONNECTED);
  });

  it("binds the account that was active when the prompt opened, not when it was answered", async () => {
    await createWallet(h);
    await h.popup({ kind: "popup-add-account" }); // account 1 becomes active
    const shownFor = { accountId: "" };
    h.answerWith("hold");
    const pending = h.page<string[]>("tari_requestAccounts");
    await tick();
    shownFor.accountId = (h.shown[0] as { accountId: string }).accountId;
    // The user switches back to account 0 while the prompt is open, then approves it.
    await h.popup({ kind: "popup-set-active-account", accountId: "local:0" });
    await h.answer(h.shown[0]!.id, true);
    const [bound] = await pending;
    expect(shownFor.accountId).toBe("local:1");
    const sites = await h.popup<Array<{ origin: string; accountId: string }>>({ kind: "popup-get-connected-sites" });
    expect(sites.find((s) => s.origin === SITE)?.accountId).toBe("local:1");
    expect(bound).toMatch(/^component_/);
  });

  it("tari_disconnect drops the connection and tells the host", async () => {
    await createWallet(h);
    await connect(h);
    expect(await h.page("tari_disconnect")).toBeNull();
    expect(h.sitesChanged).toHaveBeenCalled();
    expect(await h.page("tari_getAccounts")).toEqual([]);
    expect(await h.pageError("tari_getWalletAddress")).toMatch(NOT_CONNECTED);
  });

  it("switching the active account drops every connection and broadcasts it", async () => {
    await createWallet(h);
    await h.popup({ kind: "popup-add-account" });
    await h.popup({ kind: "popup-set-active-account", accountId: "local:0" });
    await connect(h, SITE);
    await connect(h, OTHER_SITE);
    await h.popup({ kind: "popup-set-active-account", accountId: "local:1" });
    expect(await h.popup({ kind: "popup-get-connected-sites" })).toEqual([]);
    expect(h.broadcasts.some((b) => b.kind === "tari-accounts-changed")).toBe(true);
  });

  it("the user disconnecting a site from the wallet ends its access", async () => {
    await createWallet(h);
    await connect(h);
    await h.popup({ kind: "popup-disconnect-site", origin: SITE });
    expect(await h.pageError("tari_getWalletAddress")).toMatch(NOT_CONNECTED);
  });
});

describe("while connected", () => {
  let address: string;
  beforeEach(async () => {
    await createWallet(h);
    address = await connect(h);
    h.shown.length = 0;
  });

  it("gives the wallet address without a prompt", async () => {
    const wallet = await h.page<string>("tari_getWalletAddress");
    expect(wallet).toMatch(/^otl_esm_1/);
    expect(h.shown).toEqual([]);
    expect(address).toMatch(/^component_/);
  });

  it("reports capabilities for a local account, without private view", async () => {
    const caps = await h.page<Record<string, unknown>>("tari_getCapabilities");
    expect(caps).toMatchObject({ network: "esmeralda", walletOwnershipProof: true, privateViewGranted: false, dryRunIsLocal: false });
  });

  it("signs an ownership challenge only after approval, and shows what is signed", async () => {
    const result = await h.page<{ signature: unknown; walletAddress: string }>("tari_signWalletOwnershipChallenge", { challenge: "hello" });
    expect(result.signature).toBeTruthy();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]).toMatchObject({ kind: "signWalletOwnershipProof", origin: SITE, challenge: "hello" });
  });

  it.each(["reject", "dismiss", "fail-to-open"] as const)("an ownership challenge that is %s is refused", async (action) => {
    h.answerWith(action);
    expect(await h.pageError("tari_signWalletOwnershipChallenge", { challenge: "hello" })).toMatch(/Rejected/i);
  });

  it.each([{}, { challenge: "" }, { challenge: 42 }])("refuses a malformed challenge %j without prompting", async (params) => {
    expect(await h.pageError("tari_signWalletOwnershipChallenge", params)).toMatch(/challenge/);
    expect(h.shown).toEqual([]);
  });

  it("refuses everything once the wallet is locked", async () => {
    await h.popup({ kind: "popup-lock" });
    expect(await h.page("tari_getAccounts")).toEqual([]);
    expect(await h.page("tari_getBalances")).toEqual([]);
    expect(await h.pageError("tari_getWalletAddress")).toMatch(/locked/i);
    expect(await h.pageError("tari_signWalletOwnershipChallenge", { challenge: "x" })).toMatch(/locked/i);
    expect(await h.pageError("tari_signAndSubmitTransaction", { instructions: [], dryRun: true })).toMatch(/locked/i);
    expect(h.shown).toEqual([]);
  });

  it("works again after unlocking", async () => {
    await h.popup({ kind: "popup-lock" });
    await h.popup({ kind: "popup-unlock", password: PASSWORD });
    expect(await h.page("tari_getAccounts")).toEqual([address]);
  });
});

describe("private view access", () => {
  beforeEach(async () => {
    await createWallet(h);
    await connect(h);
    h.shown.length = 0;
  });

  it("private reads need a separate grant", async () => {
    expect(await h.page("tari_getViewAccess")).toEqual({ granted: false });
    expect(await h.pageError("tari_getPrivateBalances")).toMatch(/view access/);
    expect(await h.pageError("tari_scanForPrivatePayments")).toMatch(/view access/);
  });

  it("a declined grant stays declined", async () => {
    h.answerWith("reject");
    expect(await h.page("tari_requestViewAccess")).toEqual({ granted: false });
    expect(await h.page("tari_getViewAccess")).toEqual({ granted: false });
  });

  it("an approved grant is remembered, and revoking it works", async () => {
    expect(await h.page("tari_requestViewAccess")).toEqual({ granted: true });
    expect(h.shown.map((a) => a.kind)).toEqual(["viewAccess"]);
    expect(await h.page("tari_getViewAccess")).toEqual({ granted: true });
    expect((await h.page<Record<string, unknown>>("tari_getCapabilities")).privateViewGranted).toBe(true);
    // Asking again doesn't prompt again.
    expect(await h.page("tari_requestViewAccess")).toEqual({ granted: true });
    expect(h.shown).toHaveLength(1);

    await h.page("tari_revokeViewAccess");
    expect(await h.page("tari_getViewAccess")).toEqual({ granted: false });
  });

  it("the user can revoke a grant from the wallet", async () => {
    await h.page("tari_requestViewAccess");
    await h.popup({ kind: "popup-revoke-site-view-access", origin: SITE });
    expect(await h.page("tari_getViewAccess")).toEqual({ granted: false });
  });

  it("a grant does not carry over to a reconnection", async () => {
    await h.page("tari_requestViewAccess");
    await h.page("tari_disconnect");
    await connect(h);
    expect(await h.page("tari_getViewAccess")).toEqual({ granted: false });
  });
});

describe("transactions", () => {
  const STEALTH = { StealthTransfer: {} };

  beforeEach(async () => {
    await createWallet(h);
    await connect(h);
    h.shown.length = 0;
  });

  it("refuses a raw StealthTransfer instruction before prompting", async () => {
    expect(await h.pageError("tari_signAndSubmitTransaction", { instructions: [STEALTH] })).toMatch(/StealthTransfer/);
    expect(await h.pageError("tari_signAndSubmitTransaction", { instructions: [STEALTH], dryRun: true })).toMatch(/StealthTransfer/);
    expect(await h.pageError("tari_createTransactionRequest", { kind: "instructions", instructions: [STEALTH] })).toMatch(/StealthTransfer/);
    expect(h.shown).toEqual([]);
  });

  it("refuses enforceFeeType without a feeType", async () => {
    expect(await h.pageError("tari_createTransactionRequest", { kind: "instructions", instructions: [], enforceFeeType: true })).toMatch(
      /enforceFeeType/,
    );
  });

  it("a created request is pending, shown for approval, and only readable by its own site", async () => {
    h.answerWith("hold");
    const { requestId } = await h.page<{ requestId: string }>("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
    await tick();
    expect(h.shown.map((a) => a.kind)).toContain("transaction");
    expect(await h.page("tari_getTransactionRequest", { requestId })).toMatchObject({ requestId, status: "pending" });

    await connect(h, OTHER_SITE);
    expect(await h.pageError("tari_getTransactionRequest", { requestId }, OTHER_SITE)).toMatch(/Unknown transaction request/);
    expect(await h.pageError("tari_submitTransactionRequest", { requestId }, OTHER_SITE)).toMatch(/Unknown transaction request/);
  });

  it("a request cannot be submitted before it is approved", async () => {
    h.answerWith("hold");
    const { requestId } = await h.page<{ requestId: string }>("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(/status is "pending"/);
  });

  it.each([
    ["reject", "rejected"],
    ["dismiss", "rejected"],
  ] as const)("a request that is %s ends up %s and cannot be submitted", async (action, status) => {
    h.answerWith(action);
    const { requestId } = await h.page<{ requestId: string }>("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
    await tick();
    await tick();
    expect(await h.page("tari_getTransactionRequest", { requestId })).toMatchObject({ status });
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(new RegExp(`status is "${status}"`));
  });

  it("an approved request refuses to submit from a different account", async () => {
    h.answerWith("approve");
    const { requestId } = await h.page<{ requestId: string }>("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
    await tick();
    await tick();
    expect(await h.page("tari_getTransactionRequest", { requestId })).toMatchObject({ status: "approved" });
    // Switch accounts (which drops the connection), reconnect under the new account, then submit.
    await h.popup({ kind: "popup-add-account" });
    await h.popup({ kind: "popup-set-active-account", accountId: "local:0" });
    await h.popup({ kind: "popup-set-active-account", accountId: "local:1" });
    await connect(h);
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(/different account/);
  });

  it("an approved request refuses to submit on another network", async () => {
    h.answerWith("approve");
    const { requestId } = await h.page<{ requestId: string }>("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
    await tick();
    await tick();
    await h.popup({ kind: "popup-set-network", network: "igor" });
    await connect(h);
    // The network switch drops connections; either way the request must not run on igor.
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(/approved on esmeralda/);
  });

  it("a locked wallet refuses to submit an approved request", async () => {
    h.answerWith("approve");
    const { requestId } = await h.page<{ requestId: string }>("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
    await tick();
    await tick();
    await h.popup({ kind: "popup-lock" });
    expect(await h.pageError("tari_submitTransactionRequest", { requestId })).toMatch(/locked/i);
    // Still approved (not stranded in "submitting"), so it can be submitted after unlocking.
    expect(await h.page("tari_getTransactionRequest", { requestId })).toMatchObject({ status: "approved" });
  });

  it("the deprecated blocking call fails cleanly when the approval is rejected", async () => {
    h.answerWith("reject");
    expect(await h.pageError("tari_signAndSubmitTransaction", { instructions: [] })).toMatch(/reject/i);
  });
});

describe("approval flood limits", () => {
  beforeEach(async () => {
    await createWallet(h);
    await connect(h);
    h.shown.length = 0;
    h.answerWith("hold");
  });

  it(`one site can have at most ${MAX_PENDING_APPROVALS_PER_ORIGIN} approvals open`, async () => {
    for (let i = 0; i < MAX_PENDING_APPROVALS_PER_ORIGIN; i++) {
      await h.page("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
    }
    expect(await h.pageError("tari_createTransactionRequest", { kind: "instructions", instructions: [] })).toMatch(/Too many requests/);
    expect(h.shown).toHaveLength(MAX_PENDING_APPROVALS_PER_ORIGIN);
  });

  it(`at most ${MAX_PENDING_APPROVALS_TOTAL} approvals are open across all sites`, async () => {
    const origins = Array.from({ length: MAX_PENDING_APPROVALS_TOTAL + 1 }, (_, i) => `https://site${i}.example`);
    h.answerWith("approve");
    for (const o of origins) await connect(h, o);
    h.shown.length = 0;
    h.answerWith("hold");
    for (const o of origins.slice(0, MAX_PENDING_APPROVALS_TOTAL)) {
      await h.page("tari_createTransactionRequest", { kind: "instructions", instructions: [] }, o);
    }
    expect(
      await h.pageError("tari_createTransactionRequest", { kind: "instructions", instructions: [] }, origins[MAX_PENDING_APPROVALS_TOTAL]),
    ).toMatch(/Too many requests/);
  });

  it("answering an approval frees its slot", async () => {
    for (let i = 0; i < MAX_PENDING_APPROVALS_PER_ORIGIN; i++) {
      await h.page("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
    }
    await tick();
    h.dismiss(h.shown[0]!.id);
    await h.page("tari_createTransactionRequest", { kind: "instructions", instructions: [] });
  });
});

describe("network switch requests", () => {
  beforeEach(async () => {
    await createWallet(h);
  });

  it("validates the target network", async () => {
    expect(await h.pageError("tari_switchNetwork", { network: "bitcoin" })).toMatch(/needs/);
  });

  it("is a no-op for the current network", async () => {
    expect(await h.page("tari_switchNetwork", { network: "esmeralda" })).toBe("esmeralda");
    expect(h.shown).toEqual([]);
  });

  it("switches only with approval", async () => {
    h.answerWith("reject");
    expect(await h.pageError("tari_switchNetwork", { network: "igor" })).toMatch(/rejected/);
    expect(await h.page("tari_getNetwork")).toBe("esmeralda");

    h.answerWith("approve");
    expect(await h.page("tari_switchNetwork", { network: "igor" })).toBe("igor");
    expect(await h.page("tari_getNetwork")).toBe("igor");
    expect(h.broadcasts.some((b) => b.kind === "tari-network-changed")).toBe(true);
  });

  it("refuses mainnet when its indexer can't be reached, without prompting", async () => {
    expect(await h.pageError("tari_switchNetwork", { network: "mainnet" })).toBeTruthy();
    expect(h.shown).toEqual([]);
    expect(await h.page("tari_getNetwork")).toBe("esmeralda");
  });

  it("drops the approved switch if the network changed while the prompt was open", async () => {
    h.answerWith("hold");
    const pending = h.pageError("tari_switchNetwork", { network: "igor" });
    await tick();
    await h.popup({ kind: "popup-set-network", network: "mainnet" }).catch(() => {}); // unreachable: stays esmeralda
    await h.popup({ kind: "popup-set-network", network: "igor" });
    await h.popup({ kind: "popup-set-network", network: "esmeralda" });
    // Back where it started: approving now is fine.
    await h.answer(h.shown[0]!.id, true);
    expect(await pending).toBeUndefined();
  });
});

describe("sanitizeForMessage", () => {
  it("turns bigints into strings at any depth and leaves the rest alone", () => {
    expect(sanitizeForMessage({ a: 1n, b: [2n, { c: 3n }], d: "x", e: null, f: true })).toEqual({
      a: "1",
      b: ["2", { c: "3" }],
      d: "x",
      e: null,
      f: true,
    });
  });
});
