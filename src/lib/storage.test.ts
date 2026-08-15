import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAddressBookEntry,
  addTransactionRequest,
  daemonAccountId,
  getState,
  getTransactionRequest,
  localAccountId,
  parseAccountId,
  removeAddressBookEntry,
  setTransactionRequestStatus,
  type TransactionRequestRecord,
} from "./storage";

/** A minimal in-memory stand-in for chrome.storage.local -- get/set semantics only (get returns
 * whichever requested keys exist, set shallow-merges), enough for storage.ts's own usage. Not used
 * elsewhere in this suite (see vitest.config.ts's own comment on why chrome APIs normally aren't
 * mocked here) -- added specifically to exercise the read-modify-write race fix below, which is
 * exactly the kind of bug a future refactor could silently reintroduce without a real regression
 * test catching it. */
function installChromeStorageStub(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
        },
        clear: async () => {
          for (const k of Object.keys(store)) delete store[k];
        },
      },
    },
  });
  return store;
}

describe("localAccountId / parseAccountId round-trip", () => {
  it("round-trips a local account id", () => {
    const id = localAccountId(3);
    expect(id).toBe("local:3");
    expect(parseAccountId(id)).toEqual({ type: "local", index: 3 });
  });

  it("round-trips index 0", () => {
    expect(parseAccountId(localAccountId(0))).toEqual({ type: "local", index: 0 });
  });
});

describe("daemonAccountId / parseAccountId round-trip", () => {
  it("round-trips a daemon account id", () => {
    const id = daemonAccountId("conn-1", "component_abc123");
    expect(id).toBe("daemon:conn-1:component_abc123");
    expect(parseAccountId(id)).toEqual({ type: "daemon", connectionId: "conn-1", componentAddress: "component_abc123" });
  });

  it("handles a component address that itself contains colons safely", () => {
    // Component addresses never actually contain colons, but the parser splits on the *first*
    // colon after "daemon:<connectionId>" — verifying it doesn't truncate the component address if
    // the connection id or address ever did contain one.
    const id = daemonAccountId("conn-1", "component_abc:def");
    expect(parseAccountId(id)).toEqual({ type: "daemon", connectionId: "conn-1", componentAddress: "component_abc:def" });
  });
});

describe("parseAccountId", () => {
  it("throws on a malformed id", () => {
    expect(() => parseAccountId("garbage")).toThrow("Malformed account id");
  });

  it("throws on an empty string", () => {
    expect(() => parseAccountId("")).toThrow("Malformed account id");
  });
});

describe("concurrent mutations serialize instead of losing updates", () => {
  beforeEach(() => installChromeStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  it("two concurrent addAddressBookEntry calls both survive (neither read-modify-write clobbers the other)", async () => {
    await Promise.all([
      addAddressBookEntry({ id: "a", label: "Alice", address: "otl_esm_a" }),
      addAddressBookEntry({ id: "b", label: "Bob", address: "otl_esm_b" }),
    ]);
    const { addressBook } = await getState();
    expect(addressBook.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("many concurrent adds all survive, not just two", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => addAddressBookEntry({ id: `entry-${i}`, label: `Entry ${i}`, address: `otl_esm_${i}` }))
    );
    const { addressBook } = await getState();
    expect(addressBook).toHaveLength(20);
    expect(new Set(addressBook.map((e) => e.id)).size).toBe(20);
  });

  it("an add racing a remove resolves to a consistent, non-clobbered state", async () => {
    await addAddressBookEntry({ id: "keep", label: "Keep", address: "otl_esm_keep" });
    await Promise.all([
      addAddressBookEntry({ id: "new", label: "New", address: "otl_esm_new" }),
      removeAddressBookEntry("keep"),
    ]);
    const { addressBook } = await getState();
    expect(addressBook.map((e) => e.id).sort()).toEqual(["new"]);
  });
});

describe("transaction requests", () => {
  beforeEach(() => installChromeStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  function pendingRecord(overrides: Partial<TransactionRequestRecord> = {}): TransactionRequestRecord {
    const now = Date.now();
    return {
      id: "req-1",
      origin: "https://dapp.example",
      accountId: "local:0",
      operation: { kind: "instructions", instructions: [] },
      note: "",
      status: "pending",
      createdAt: now,
      expiresAt: now + 60_000,
      ...overrides,
    };
  }

  it("round-trips a stored record", async () => {
    await addTransactionRequest(pendingRecord());
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("pending");
    expect(record?.origin).toBe("https://dapp.example");
  });

  it("returns undefined for an unknown id", async () => {
    expect(await getTransactionRequest("does-not-exist")).toBeUndefined();
  });

  it("transitions pending -> approved -> submitted, carrying the result", async () => {
    await addTransactionRequest(pendingRecord());
    expect(await setTransactionRequestStatus("req-1", { status: "approved" })).toBe(true);
    expect((await getTransactionRequest("req-1"))?.status).toBe("approved");

    await setTransactionRequestStatus("req-1", { status: "submitted", result: { transactionId: "tx-123" } });
    const submitted = await getTransactionRequest("req-1");
    expect(submitted?.status).toBe("submitted");
    expect(submitted?.result).toEqual({ transactionId: "tx-123" });
  });

  it("transitions to failed, carrying the error", async () => {
    await addTransactionRequest(pendingRecord({ status: "approved" }));
    await setTransactionRequestStatus("req-1", { status: "failed", error: "insufficient funds" });
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("failed");
    expect(record?.error).toBe("insufficient funds");
  });

  it("setTransactionRequestStatus returns false for an unknown id, without throwing", async () => {
    expect(await setTransactionRequestStatus("does-not-exist", { status: "approved" })).toBe(false);
  });

  it("a stale pending request reads back as rejected/expired instead of staying approvable forever", async () => {
    await addTransactionRequest(pendingRecord({ expiresAt: Date.now() - 1000 }));
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("rejected");
    expect(record?.error).toMatch(/expired/i);
  });

  it("a stale approved (but never submitted) request also reads back as expired", async () => {
    await addTransactionRequest(pendingRecord({ status: "approved", expiresAt: Date.now() - 1000 }));
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("rejected");
  });

  it("an already-submitted request never reads back as expired, however old", async () => {
    await addTransactionRequest(pendingRecord({ status: "submitted", result: { ok: true }, expiresAt: Date.now() - 1000 }));
    const record = await getTransactionRequest("req-1");
    expect(record?.status).toBe("submitted");
  });

  it("expiry is derived on read, never written back to storage", async () => {
    await addTransactionRequest(pendingRecord({ expiresAt: Date.now() - 1000 }));
    await getTransactionRequest("req-1"); // trigger the lazy-expiry read path
    // A fresh read still sees the original "pending" status in storage -- setTransactionRequestStatus
    // would still succeed against it (an approval that arrives just as a request goes stale should
    // still be honored, not silently dropped because a read happened to observe it as expired first).
    expect(await setTransactionRequestStatus("req-1", { status: "approved" })).toBe(true);
  });

  it("many concurrent addTransactionRequest calls all survive", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => addTransactionRequest(pendingRecord({ id: `req-${i}` }))));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => getTransactionRequest(`req-${i}`)));
    expect(results.every((r) => r !== undefined)).toBe(true);
  });
});
