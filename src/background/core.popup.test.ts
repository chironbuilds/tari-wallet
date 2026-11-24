// The wallet's own lifecycle through handlePopupRequest: creating and importing, the backup step,
// lock/unlock, auto-lock timing, reset, accounts and networks. Same in-memory harness as the page
// tests; the network is stubbed out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAutoLock, onHostStartup, setPendingUpdateVersion } from "./core";
import { PASSWORD, SITE, OTHER_SITE, connect, createWallet, setupHarness, type Harness } from "./testHarness";
import { getState } from "../lib/storage";

let h: Harness;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network disabled in unit tests"))));
  h = setupHarness();
});

afterEach(() => {
  h.cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type LockState = { hasWallet: boolean; isUnlocked: boolean; backupPending: boolean };
const lockState = () => h.popup<LockState>({ kind: "popup-get-lock-state" });
const popupError = async (message: Parameters<Harness["popup"]>[0]) => {
  try {
    await h.popup(message);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("creating a wallet", () => {
  it("starts with no wallet", async () => {
    expect(await lockState()).toEqual({ hasWallet: false, isUnlocked: false, backupPending: false });
  });

  it("creates an unlocked wallet with a 24-word phrase awaiting backup", async () => {
    const { mnemonic } = await h.popup<{ mnemonic: string }>({ kind: "popup-create-wallet", password: PASSWORD });
    expect(mnemonic.split(" ")).toHaveLength(24);
    expect(await lockState()).toEqual({ hasWallet: true, isUnlocked: true, backupPending: true });
    // A reopened popup can show the phrase again until it's verified...
    expect(await h.popup({ kind: "popup-get-pending-mnemonic" })).toEqual({ mnemonic });
    await h.popup({ kind: "popup-confirm-backup" });
    expect((await lockState()).backupPending).toBe(false);
    // ...and not after.
    expect(await popupError({ kind: "popup-get-pending-mnemonic" })).toMatch(/No recovery phrase/);
  });

  it("does not show the pending phrase while locked", async () => {
    await h.popup({ kind: "popup-create-wallet", password: PASSWORD });
    await h.popup({ kind: "popup-lock" });
    expect(await popupError({ kind: "popup-get-pending-mnemonic" })).toMatch(/locked/i);
  });

  it("never overwrites an existing wallet", async () => {
    await createWallet(h);
    expect(await popupError({ kind: "popup-create-wallet", password: PASSWORD })).toMatch(/already exists/);
    expect(await popupError({ kind: "popup-import-wallet", mnemonic: "x", password: PASSWORD })).toMatch(/already exists/);
  });

  it("does not store the seed or phrase in plain text", async () => {
    const mnemonic = await createWallet(h);
    const persisted = JSON.stringify([...(h.platform.local as unknown as { map: Map<string, unknown> }).map.entries()]);
    expect(persisted).not.toContain(mnemonic.split(" ").slice(0, 4).join(" "));
    expect(persisted).not.toContain(PASSWORD);
  });

  it("each new wallet is different", async () => {
    const first = await createWallet(h);
    await h.popup({ kind: "popup-reset-wallet" });
    const second = await createWallet(h);
    expect(second).not.toBe(first);
  });
});

describe("recovery", () => {
  it("importing the phrase restores the same account", async () => {
    const mnemonic = await createWallet(h);
    const original = await connect(h);

    const fresh = setupHarness(); // a different device
    await fresh.popup({ kind: "popup-import-wallet", mnemonic, password: "Another-Pass-9z!" });
    expect(await fresh.popup<LockState>({ kind: "popup-get-lock-state" })).toEqual({ hasWallet: true, isUnlocked: true, backupPending: false });
    expect(await connect(fresh)).toBe(original);
    fresh.cleanup();
  });

  it("refuses an invalid phrase and leaves no wallet behind", async () => {
    expect(await popupError({ kind: "popup-import-wallet", mnemonic: "abandon ".repeat(24).trim(), password: PASSWORD })).toBeTruthy();
    expect(await popupError({ kind: "popup-import-wallet", mnemonic: "not words", password: PASSWORD })).toBeTruthy();
    expect((await lockState()).hasWallet).toBe(false);
  });

  it("reveals the phrase only with the right password", async () => {
    const mnemonic = await createWallet(h);
    expect(await h.popup({ kind: "popup-reveal-mnemonic", password: PASSWORD })).toEqual({ mnemonic });
    expect(await popupError({ kind: "popup-reveal-mnemonic", password: "Wrong-Pass-1!" })).toBeTruthy();
  });
});

describe("lock and unlock", () => {
  beforeEach(async () => {
    await createWallet(h);
  });

  it("locking clears the unlocked seed from session memory", async () => {
    await h.popup({ kind: "popup-lock" });
    expect((await lockState()).isUnlocked).toBe(false);
    expect(Object.keys(await h.platform.session.get(null))).not.toContain("unlockedSeedHex");
  });

  it("a wrong password does not unlock", async () => {
    await h.popup({ kind: "popup-lock" });
    expect(await popupError({ kind: "popup-unlock", password: "Wrong-Pass-1!" })).toBeTruthy();
    expect(await popupError({ kind: "popup-unlock", password: "" })).toBeTruthy();
    expect((await lockState()).isUnlocked).toBe(false);
  });

  it("the right password unlocks", async () => {
    await h.popup({ kind: "popup-lock" });
    await h.popup({ kind: "popup-unlock", password: PASSWORD });
    expect((await lockState()).isUnlocked).toBe(true);
  });

  it("unlocking with no wallet fails clearly", async () => {
    await h.popup({ kind: "popup-reset-wallet" });
    expect(await popupError({ kind: "popup-unlock", password: PASSWORD })).toMatch(/No wallet/);
  });
});

describe("auto-lock", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
    await createWallet(h);
  });

  const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000);

  it("locks after the chosen idle time, not before", async () => {
    await h.popup({ kind: "popup-set-auto-lock-minutes", minutes: 5 });
    minutes(4);
    expect(await checkAutoLock()).toBe(false);
    expect((await lockState()).isUnlocked).toBe(true);
    minutes(2);
    expect(await checkAutoLock()).toBe(true);
    expect((await lockState()).isUnlocked).toBe(false);
  });

  it("using the wallet resets the countdown", async () => {
    await h.popup({ kind: "popup-set-auto-lock-minutes", minutes: 5 });
    minutes(4);
    await h.popup({ kind: "popup-get-connected-sites" }); // the user doing something
    minutes(4);
    expect(await checkAutoLock()).toBe(false);
  });

  it("background polling does not keep the wallet unlocked", async () => {
    await h.popup({ kind: "popup-set-auto-lock-minutes", minutes: 5 });
    for (let i = 0; i < 6; i++) {
      minutes(1);
      await h.popup({ kind: "popup-get-lock-state" });
    }
    expect(await checkAutoLock()).toBe(true);
  });

  it("dApp requests do not keep the wallet unlocked", async () => {
    await h.popup({ kind: "popup-set-auto-lock-minutes", minutes: 5 });
    await connect(h);
    await h.popup({ kind: "popup-get-lock-state" });
    minutes(3);
    await h.page("tari_getAccounts");
    await h.page("tari_getNetwork");
    minutes(3);
    expect(await checkAutoLock()).toBe(true);
  });

  it('"Never" never locks', async () => {
    await h.popup({ kind: "popup-set-auto-lock-minutes", minutes: 0 });
    minutes(60 * 24 * 30);
    expect(await checkAutoLock()).toBe(false);
  });

  it("does nothing when already locked", async () => {
    await h.popup({ kind: "popup-lock" });
    minutes(120);
    expect(await checkAutoLock()).toBe(false);
  });
});

describe("reset", () => {
  it("wipes the wallet, its connections and secrets", async () => {
    await createWallet(h);
    await connect(h);
    await h.popup({ kind: "popup-reset-wallet" });
    expect(await lockState()).toEqual({ hasWallet: false, isUnlocked: false, backupPending: false });
    expect(await h.popup({ kind: "popup-get-connected-sites" })).toEqual([]);
    expect(h.sitesChanged).toHaveBeenCalled();
    expect(await h.page("tari_getAccounts")).toEqual([]);
    const session = Object.keys(await h.platform.session.get(null));
    expect(session).not.toContain("unlockedSeedHex");
    expect(session).not.toContain("pendingMnemonic");
  });
});

describe("accounts", () => {
  beforeEach(async () => {
    await createWallet(h);
  });

  it("adding an account makes it active with a different address", async () => {
    const first = await connect(h);
    expect(await h.popup({ kind: "popup-add-account" })).toEqual({ index: 1 });
    expect((await getState()).activeAccountId).toBe("local:1");
    await h.popup({ kind: "popup-set-active-account", accountId: "local:0" });
    await h.popup({ kind: "popup-set-active-account", accountId: "local:1" });
    const second = await connect(h);
    expect(second).not.toBe(first);
  });

  it("re-selecting the active account keeps connections", async () => {
    await connect(h);
    await h.popup({ kind: "popup-set-active-account", accountId: "local:0" });
    expect(await h.popup<unknown[]>({ kind: "popup-get-connected-sites" })).toHaveLength(1);
    expect(h.broadcasts).toEqual([]);
  });
});

describe("networks", () => {
  beforeEach(async () => {
    await createWallet(h);
  });

  it("defaults to Esmeralda", async () => {
    expect((await getState()).network).toBe("esmeralda");
  });

  it("refuses an unknown network", async () => {
    expect(await popupError({ kind: "popup-set-network", network: "bitcoin" as never })).toMatch(/Unknown network/);
  });

  it("refuses mainnet while its indexer can't be reached", async () => {
    expect(await popupError({ kind: "popup-set-network", network: "mainnet" })).toBeTruthy();
    expect((await getState()).network).toBe("esmeralda");
    expect(await h.popup({ kind: "popup-network-live", network: "esmeralda" })).toEqual({ live: true });
  });

  it("switching networks disconnects sites and tells them", async () => {
    await connect(h, SITE);
    await connect(h, OTHER_SITE);
    await h.popup({ kind: "popup-set-network", network: "igor" });
    expect((await getState()).network).toBe("igor");
    expect(await h.popup({ kind: "popup-get-connected-sites" })).toEqual([]);
    expect(h.broadcasts.some((b) => b.kind === "tari-network-changed")).toBe(true);
    // A reconnected site gets an address for the new network.
    await connect(h, SITE);
    expect(await h.page<string>("tari_getWalletAddress")).toMatch(/^otl_igr_1/);
  });
});

describe("settings and bookkeeping", () => {
  beforeEach(async () => {
    await createWallet(h);
  });

  it("stores the auto-lock and fee-privacy choices", async () => {
    await h.popup({ kind: "popup-set-auto-lock-minutes", minutes: 30 });
    await h.popup({ kind: "popup-set-fee-privacy-default", feeType: "private" });
    expect(await getState()).toMatchObject({ autoLockMinutes: 30, feePrivacyDefault: "private" });
  });

  it("adds and removes address book entries", async () => {
    const entry = await h.popup<{ id: string; label: string; address: string }>({
      kind: "popup-add-address-book-entry",
      label: "Alice",
      address: "otl_esm_1example",
    });
    expect(entry).toMatchObject({ label: "Alice", address: "otl_esm_1example" });
    expect((await getState()).addressBook).toContainEqual(entry);
    await h.popup({ kind: "popup-remove-address-book-entry", id: entry.id });
    expect((await getState()).addressBook).not.toContainEqual(entry);
  });

  it("records a downloaded update for the reload banner", async () => {
    await setPendingUpdateVersion("9.9.9");
    expect((await getState()).pendingUpdateVersion).toBe("9.9.9");
  });

  it("host restart drops cached accounts without locking", async () => {
    onHostStartup();
    expect((await lockState()).isUnlocked).toBe(true);
  });

  it("rejects an unknown popup message", async () => {
    expect(await popupError({ kind: "popup-format-disk" } as never)).toMatch(/Unknown popup message/);
  });

  it("approval ids that don't exist resolve to nothing", async () => {
    expect(await h.popup({ kind: "popup-get-pending-approval", approvalId: "nope" })).toBeNull();
    expect(await h.popup({ kind: "popup-resolve-approval", approvalId: "nope", approve: true })).toEqual({ resolved: false });
  });
});
