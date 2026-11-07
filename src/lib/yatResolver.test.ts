import { describe, expect, it } from "vitest";
import { NameResolutionError, ootleAddressesIn, resolveYatName } from "./yatResolver";

const ESM = "otl_esm_1krg63v0jxsh0j000000000000000000000000000000";
const MAIN = "otl_1aj4kgg35qjl2uvarl0000000000000000000000000000";

type Route = (url: URL) => { status: number; body?: unknown } | Error;

/** A fetch double keyed by host: `yat` answers a.y.at, `raddish` answers raddish.io. */
function fakeFetch(routes: { yat?: Route; raddish?: Route }, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const route = url.hostname === "a.y.at" ? routes.yat : routes.raddish;
    const answer = route ? route(url) : { status: 404 };
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const code = (p: Promise<unknown>) => p.then(() => "resolved", (e) => (e instanceof NameResolutionError ? e.code : `other:${String(e)}`));

describe("ootleAddressesIn", () => {
  it("finds otl_ strings anywhere in a JSON value, in order, and nothing else", () => {
    const doc = { result: { "0x0104": { address: "f2a9…", tag: "0x0104" }, "0x0101": { address: ESM }, notes: ["x", MAIN] } };
    expect(ootleAddressesIn(doc)).toEqual([ESM, MAIN]);
    expect(ootleAddressesIn({ a: "otl_esm_short" })).toEqual([]);
    expect(ootleAddressesIn(null)).toEqual([]);
  });
});

describe("resolveYatName", () => {
  it("takes the address from y.at's payment records first, folded and canonical", async () => {
    const calls: string[] = [];
    const fetch = fakeFetch({ yat: () => ({ status: 200, body: { result: { "0x0101": { address: ESM } } } }) }, calls);
    const r = await resolveYatName("💜🦙", "esmeralda", { fetch });
    expect(r).toEqual({ name: "💜🦙", canonical: "❤🐑", walletAddress: ESM, network: "esmeralda", source: "yat" });
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0]!)).toBe("https://a.y.at/emoji_id/❤🐑/payment");
  });

  it("falls back to raddish's owner-set route when y.at has no Ootle address", async () => {
    const calls: string[] = [];
    const fetch = fakeFetch(
      {
        yat: () => ({ status: 200, body: { result: { "0x0104": { address: "f2a9…" } } } }),
        raddish: (u) => (u.searchParams.get("category") === "ootle" ? { status: 200, body: { found: true, disclosed: true, value: ESM, visibility: "public" } } : { status: 400 }),
      },
      calls
    );
    const r = await resolveYatName("🦄🚀", "esmeralda", { fetch });
    expect(r.source).toBe("raddish");
    expect(r.walletAddress).toBe(ESM);
    expect(calls[1]).toMatch(/^https:\/\/raddish\.io\/api\/resolve\/.*\?category=ootle$/);
  });

  it("refuses an address on another network rather than paying it", async () => {
    const fetch = fakeFetch({ yat: () => ({ status: 200, body: { address: MAIN } }) });
    await expect(code(resolveYatName("🦄", "esmeralda", { fetch }))).resolves.toBe("wrong-network");
    await expect(resolveYatName("🦄", "mainnet", { fetch })).resolves.toMatchObject({ walletAddress: MAIN, network: "mainnet" });
  });

  it("picks the candidate on the wallet's network when records hold several", async () => {
    const fetch = fakeFetch({ yat: () => ({ status: 200, body: [MAIN, ESM] }) });
    await expect(resolveYatName("🦄", "esmeralda", { fetch })).resolves.toMatchObject({ walletAddress: ESM });
  });

  it("distinguishes not found, not disclosed, unreachable and invalid", async () => {
    await expect(code(resolveYatName("🦄", "esmeralda", { fetch: fakeFetch({}) }))).resolves.toBe("not-found");
    await expect(
      code(resolveYatName("🦄", "esmeralda", { fetch: fakeFetch({ raddish: () => ({ status: 200, body: { found: true, disclosed: false, visibility: "private" } }) }) }))
    ).resolves.toBe("not-disclosed");
    await expect(code(resolveYatName("🦄", "esmeralda", { fetch: fakeFetch({ yat: () => new Error("down"), raddish: () => ({ status: 503 }) }) }))).resolves.toBe("unreachable");
    // One source down and the other says no: that is "not found", since the one that answered is authoritative for its own records.
    await expect(code(resolveYatName("🦄", "esmeralda", { fetch: fakeFetch({ yat: () => new Error("down") }) }))).resolves.toBe("not-found");
    await expect(code(resolveYatName("otl_esm_1abc", "esmeralda", { fetch: fakeFetch({}) }))).resolves.toBe("invalid-name");
    await expect(code(resolveYatName("", "esmeralda", { fetch: fakeFetch({}) }))).resolves.toBe("invalid-name");
  });

  it("never trusts a raddish value that is not an address", async () => {
    const fetch = fakeFetch({ raddish: () => ({ status: 200, body: { found: true, disclosed: true, value: "javascript:alert(1)" } }) });
    await expect(code(resolveYatName("🦄", "esmeralda", { fetch }))).resolves.toBe("not-found");
  });
});
