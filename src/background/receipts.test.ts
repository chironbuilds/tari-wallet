// syncPublicReceipts: turning public payments into the account's vaults into "received" History
// entries, from the indexer's per-vault events (served here by a fake fetch).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tari-project/ootle", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getVaultIdsForAccount: vi.fn(async () => ["vault_" + "1".repeat(64)]),
}));

const { syncPublicReceipts } = await import("./receipts");
const { setPlatform } = await import("../platform");
const { memoryArea } = await import("../platform/memoryArea");
const { addTransactionHistoryEntry, listTransactionHistory } = await import("../lib/storage");

const VAULT = "vault_" + "1".repeat(64);
const TARI = "resource_" + "01".repeat(32);
const ME = "component_" + "a".repeat(64);
const ACCOUNT_ID = "local:0";

type Ev = [string, { topic: string; payload: { amount?: number | string } }];
let events: Ev[];
let recent: Array<{ transaction_id: string; created_at?: string }>;
let indexerDown: boolean;
let requests: string[];

const account = {
  getComponentAddress: async () => ME,
  getProvider: async () => ({
    fetchSubstates: async () => ({ substates: { [VAULT]: { value: { Vault: { resource_container: { Stealth: { address: TARI } } } } } } }),
  }),
  getBalances: async () => [{ resourceAddress: TARI, divisibility: 6, symbol: "TARI" }],
} as never;

const deposit = (tx: string, amount: number | string): Ev => [tx, { topic: "std.vault.deposit", payload: { amount } }];
const withdraw = (tx: string, amount: number): Ev => [tx, { topic: "std.vault.withdraw", payload: { amount } }];
const fee = (tx: string): Ev => [tx, { topic: "std.vault.pay_fee", payload: { amount: 10 } }];
const sync = (network: "esmeralda" | "mainnet" = "esmeralda", busy = () => false) => syncPublicReceipts(ACCOUNT_ID, account, network, busy);
const history = (network: "esmeralda" | "mainnet" = "esmeralda") => listTransactionHistory(ACCOUNT_ID, network);

beforeEach(() => {
  setPlatform({ local: memoryArea(), session: memoryArea() } as never);
  events = [];
  recent = [];
  indexerDown = false;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      if (indexerDown) return { ok: false, status: 503, json: async () => ({}) };
      const u = new URL(url);
      if (u.pathname.endsWith("/transactions/events")) {
        const offset = Number(u.searchParams.get("offset"));
        const limit = Number(u.searchParams.get("limit"));
        return { ok: true, json: async () => ({ events: events.slice(offset, offset + limit) }) };
      }
      if (u.pathname.endsWith("/transactions/recent")) return { ok: true, json: async () => ({ transactions: recent }) };
      throw new Error(`unexpected ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("syncPublicReceipts", () => {
  it("records a public payment in as received, with its amount, token and time", async () => {
    events = [deposit("tx1", 2_500_000)];
    recent = [{ transaction_id: "tx1", created_at: "2026-11-20 09:06:40.0" }];
    expect(await sync()).toBe(1);
    expect(await history()).toEqual([
      expect.objectContaining({
        kind: "received",
        amount: "2500000",
        resourceAddress: TARI,
        transactionId: "tx1",
        divisibility: 6,
        symbol: "TARI",
        status: "confirmed",
        network: "esmeralda",
        createdAt: Date.parse("2026-11-20T09:06:40.0Z"),
      }),
    ]);
  });

  it("ignores the account's own spends and transactions whose fee it paid", async () => {
    events = [withdraw("send", 100), deposit("change", 50), fee("change"), deposit("in", 7)];
    expect(await sync()).toBe(1);
    expect((await history()).map((e) => e.transactionId)).toEqual(["in"]);
  });

  it("nets several events of one transaction", async () => {
    events = [deposit("tx", 10), deposit("tx", 5), withdraw("tx", 3)];
    await sync();
    expect((await history())[0]).toMatchObject({ amount: "12" });
  });

  it("doesn't duplicate a transaction already in History", async () => {
    await addTransactionHistoryEntry({ id: "x", accountId: ACCOUNT_ID, network: "esmeralda", kind: "claim", transactionId: "tx1", status: "confirmed", createdAt: 1 });
    events = [deposit("tx1", 5)];
    expect(await sync()).toBe(0);
    expect(await history()).toHaveLength(1);
  });

  it("records each receipt once across passes", async () => {
    events = [deposit("tx1", 5)];
    expect(await sync()).toBe(1);
    expect(await sync()).toBe(0);
    events = [deposit("tx2", 6), deposit("tx1", 5)];
    expect(await sync()).toBe(1);
    expect((await history()).map((e) => e.transactionId)).toEqual(["tx2", "tx1"]);
  });

  it("dates old receipts found on the first pass as 'earlier', and later undated ones as now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
    events = [deposit("old", 1)];
    await sync();
    expect((await history())[0]).toMatchObject({ transactionId: "old", createdAt: 0 });
    events = [deposit("new", 2), deposit("old", 1)];
    await sync();
    expect((await history())[0]).toMatchObject({ transactionId: "new", createdAt: Date.parse("2026-11-25T12:00:00Z") });
  });

  it("waits while one of the wallet's own operations is in flight", async () => {
    events = [deposit("tx1", 5)];
    expect(await sync("esmeralda", () => true)).toBe(0);
    expect(requests).toEqual([]);
    expect(await sync()).toBe(1);
  });

  it("an unreachable indexer changes nothing, and the next pass catches up", async () => {
    events = [deposit("tx1", 5)];
    indexerDown = true;
    expect(await sync()).toBe(0);
    expect(await history()).toEqual([]);
    indexerDown = false;
    expect(await sync()).toBe(1);
  });

  it("keeps mainnet receipts apart from testnet ones", async () => {
    events = [deposit("tx1", 5)];
    await sync("esmeralda");
    expect(await sync("mainnet")).toBe(1);
    expect(await history("mainnet")).toHaveLength(1);
    expect(requests.some((u) => u.includes("ootle.tari.com") || u.includes("tari.com"))).toBe(true);
  });

  it("reads more than one page of events", async () => {
    events = [...Array.from({ length: 100 }, (_, i) => withdraw(`spend${i}`, 1)), deposit("deep", 9)];
    expect(await sync()).toBe(1);
    expect(requests.filter((u) => u.includes("/transactions/events"))).toHaveLength(2);
  });

  it("treats a malformed amount as nothing", async () => {
    events = [deposit("bad", "1.5"), deposit("ok", 3)];
    await sync();
    expect((await history()).map((e) => e.transactionId)).toEqual(["ok"]);
  });
});
