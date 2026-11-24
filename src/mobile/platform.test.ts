// The Android host (mobile/platform.ts) with Capacitor Preferences faked: wallet storage survives a
// restart and tolerates corrupt entries, approvals queue one at a time, dismissals reject, and the
// deep-link "return to the dApp" only fires when it should.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    keys: async () => ({ keys: [...prefs.keys()] }),
    get: async ({ key }: { key: string }) => ({ value: prefs.has(key) ? prefs.get(key)! : null }),
    set: async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void prefs.delete(key),
    clear: async () => prefs.clear(),
  },
}));
vi.mock("./biometric", () => ({ createBiometric: () => undefined }));

const { createAndroidPlatform } = await import("./platform");

const handlePopupRequest = vi.fn(async (m: { kind: string }) => ({ echoed: m.kind, big: 5n }));
const sanitize = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const make = () => createAndroidPlatform({ handlePopupRequest: handlePopupRequest as never, sanitize });

beforeEach(() => {
  prefs.clear();
  vi.stubGlobal("window", { location: { hash: "", reload: vi.fn() } });
  vi.stubGlobal("__APP_VERSION__", "9.8.7");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("storage", () => {
  it("persists across a restart", async () => {
    const first = await make();
    await first.local.set({ vault: { ciphertext: "abc" }, network: "mainnet" });
    const second = await make(); // the app restarted
    expect(await second.local.get(["vault", "network"])).toEqual({ vault: { ciphertext: "abc" }, network: "mainnet" });
  });

  it("removes and clears on disk too", async () => {
    const p = await make();
    await p.local.set({ a: 1, b: 2 });
    await p.local.remove("a");
    expect([...prefs.keys()]).toEqual(["b"]);
    await p.local.clear();
    expect(prefs.size).toBe(0);
    expect(await (await make()).local.get(null)).toEqual({});
  });

  it("skips a corrupt entry instead of failing to start", async () => {
    prefs.set("good", JSON.stringify({ ok: true }));
    prefs.set("bad", "{not json");
    const p = await make();
    expect(await p.local.get(null)).toEqual({ good: { ok: true } });
  });

  it("does not write undefined values", async () => {
    const p = await make();
    await p.local.set({ a: undefined, b: 1 });
    expect([...prefs.keys()]).toEqual(["b"]);
  });

  it("keeps session data (the unlocked seed) in memory only", async () => {
    const p = await make();
    await p.session.set({ unlockedSeedHex: "00ff" });
    expect(prefs.size).toBe(0);
    expect(await (await make()).session.get(null)).toEqual({});
  });
});

describe("approval queue", () => {
  it("shows one approval at a time, oldest first, and the next when it's answered", async () => {
    const p = await make();
    const queued: string[] = [];
    const closed: string[] = [];
    p.onApprovalQueued((id) => queued.push(id));
    p.onApprovalClosed((id) => closed.push(id));
    await p.openApproval("a");
    await p.openApproval("b");
    await p.openApproval("a"); // the same approval again: not queued twice
    expect(p.approvalQueue()).toEqual(["a", "b"]);
    expect(p.currentApproval()).toBe("a");
    expect(window.location.hash).toBe("#/approve/a");
    expect(queued).toEqual(["a", "b"]);

    p.closeApproval("a");
    expect(window.location.hash).toBe("#/approve/b");
    p.closeApproval("b");
    expect(window.location.hash).toBe("");
    expect(closed).toEqual(["a", "b"]);
  });

  it("backing out of an approval rejects it and moves on", async () => {
    const p = await make();
    const dismissed: string[] = [];
    p.onApprovalDismissed((id) => dismissed.push(id));
    await p.openApproval("a");
    await p.openApproval("b");
    p.dismissCurrentApproval();
    expect(dismissed).toEqual(["a"]);
    expect(p.currentApproval()).toBe("b");
  });

  it('"Reject all" rejects every waiting approval', async () => {
    const p = await make();
    const dismissed: string[] = [];
    p.onApprovalDismissed((id) => dismissed.push(id));
    for (const id of ["a", "b", "c"]) await p.openApproval(id);
    p.dismissAllApprovals();
    expect(dismissed).toEqual(["a", "b", "c"]);
    expect(p.approvalQueue()).toEqual([]);
    expect(window.location.hash).toBe("");
  });

  it("a listener that throws doesn't break the queue", async () => {
    const p = await make();
    p.onApprovalQueued(() => {
      throw new Error("notification failed");
    });
    await p.openApproval("a");
    expect(p.currentApproval()).toBe("a");
  });
});

describe("returning to a deep-linking dApp", () => {
  it("returns once, after the user has finished every approval", async () => {
    const p = await make();
    p.expectReturnToCaller();
    await p.openApproval("a");
    expect(p.takeReturnToCaller()).toBe(false); // still deciding
    p.closeApproval("a");
    expect(p.takeReturnToCaller()).toBe(true);
    expect(p.takeReturnToCaller()).toBe(false); // only once
  });

  it("does not return if no approval happened", async () => {
    const p = await make();
    p.expectReturnToCaller();
    expect(p.takeReturnToCaller()).toBe(false);
  });

  it("forgets a stale link after two minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const p = await make();
    p.expectReturnToCaller();
    await p.openApproval("a");
    vi.setSystemTime(Date.now() + 121_000);
    p.closeApproval("a");
    expect(p.takeReturnToCaller()).toBe(false);
  });
});

describe("the rest of the host", () => {
  it("answers popup requests in-process, sanitized, and wraps errors", async () => {
    const p = await make();
    expect(await p.sendPopupRequest({ kind: "popup-get-lock-state" })).toEqual({ ok: true, result: { echoed: "popup-get-lock-state", big: "5" } });
    handlePopupRequest.mockRejectedValueOnce(new Error("Wallet is locked."));
    expect(await p.sendPopupRequest({ kind: "popup-lock" })).toEqual({ ok: false, error: "Wallet is locked." });
  });

  it("fans out broadcasts and site changes, surviving a failing listener, and unsubscribes", async () => {
    const p = await make();
    const got: unknown[] = [];
    p.onBroadcast(() => {
      throw new Error("bridge down");
    });
    const off = p.onBroadcast((m) => got.push(m));
    let sites = 0;
    p.onSitesChanged(() => sites++);
    await p.broadcast({ kind: "tari-network-changed", network: "igor" });
    p.sitesChanged?.();
    off();
    await p.broadcast({ kind: "tari-network-changed", network: "esmeralda" });
    expect(got).toEqual([{ kind: "tari-network-changed", network: "igor" }]);
    expect(sites).toBe(1);
  });

  it("reports its version and resolves bundled assets", async () => {
    const p = await make();
    expect(p.kind).toBe("android");
    expect(p.appVersion()).toBe("9.8.7");
    expect(p.assetUrl("icons/icon48.png")).toBe("/icons/icon48.png");
    expect(await p.requestHostPermission("https://x/*")).toBe(true);
  });

  it("uiReady resolves once the launch animation is done", async () => {
    const p = await make();
    let ready = false;
    void p.uiReady!().then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);
    p.markUiReady();
    await Promise.resolve();
    expect(ready).toBe(true);
  });
});
