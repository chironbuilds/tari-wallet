// The two content scripts that give every page `window.tari`: inject.ts (page world, the provider
// object) and content-script.ts (isolated world, the relay to the background). Both run here against
// a simulated window and a fake chrome.runtime, wired together exactly as in a real tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TariProvider } from "./inject";

const ORIGIN = "https://dapp.example";

/** A window "message" event. Built by hand: Node's MessageEvent only accepts a MessagePort as source. */
function msg(data: unknown, origin: string, source: unknown): Event {
  return Object.assign(new Event("message"), { data, origin, source });
}

type BackgroundHandler = (message: Record<string, unknown>) => unknown;

interface Env {
  win: EventTarget & { tari?: TariProvider; tariProviders?: TariProvider[]; location: { origin: string } };
  /** Messages the relay sent to the background. */
  sent: Array<Record<string, unknown>>;
  /** Decides what the background answers (default: echoes `{ ok: method }`). */
  setBackground(handler: BackgroundHandler): void;
  /** Simulates the background pushing a broadcast to the tab. */
  push(message: unknown): void;
  events: string[];
}

async function load(): Promise<Env> {
  vi.resetModules();
  const win = new EventTarget() as Env["win"];
  win.location = { origin: ORIGIN };
  // window.postMessage delivers asynchronously, from this window, with its origin.
  (win as unknown as { postMessage: (data: unknown, target: string) => void }).postMessage = (data, target) => {
    if (target !== ORIGIN && target !== "*") return;
    setTimeout(() => win.dispatchEvent(msg(data, ORIGIN, win)), 0);
  };
  const events: string[] = [];
  for (const name of ["tari:announceProvider", "tari#initialized", "tari#accountsChanged", "tari#networkChanged"]) {
    win.addEventListener(name, (e) => events.push(`${name}:${JSON.stringify((e as CustomEvent).detail ?? null)}`));
  }

  const sent: Array<Record<string, unknown>> = [];
  let background: BackgroundHandler = (m) => ({ kind: "tari-page-response", id: m.id, result: { ok: m.method } });
  const pushListeners: Array<(m: unknown) => void> = [];
  const runtime = {
    lastError: undefined as { message: string } | undefined,
    sendMessage(message: Record<string, unknown>, callback: (response: unknown) => void) {
      sent.push(message);
      setTimeout(() => {
        let response: unknown;
        try {
          response = background(message);
          runtime.lastError = undefined;
        } catch (e) {
          runtime.lastError = { message: (e as Error).message };
        }
        callback(response);
        runtime.lastError = undefined;
      }, 0);
    },
    onMessage: { addListener: (l: (m: unknown) => void) => pushListeners.push(l) },
  };

  vi.stubGlobal("window", win);
  vi.stubGlobal("chrome", { runtime });
  await import("./content-script");
  await import("./inject");
  return {
    win,
    sent,
    setBackground: (h) => {
      background = h;
    },
    push: (m) => pushListeners.forEach((l) => l(m)),
    events,
  };
}

let env: Env;
let tari: TariProvider;

beforeEach(async () => {
  env = await load();
  tari = env.win.tari!;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("provider setup", () => {
  it("installs window.tari with its identity", () => {
    expect(tari.isTariWallet).toBe(true);
    expect(tari.info).toEqual({ name: "Sapient", rdns: "mw.tari.sapient", embedded: false });
  });

  it("announces itself for multi-wallet pages", () => {
    expect(env.win.tariProviders).toContain(tari);
    expect(env.events.some((e) => e.startsWith("tari:announceProvider"))).toBe(true);
    expect(env.events).toContain("tari#initialized:null");
  });
});

describe("requests", () => {
  it("relays a request to the background with the page's real origin and returns the result", async () => {
    await expect(tari.request({ method: "tari_getNetwork" })).resolves.toEqual({ ok: "tari_getNetwork" });
    expect(env.sent[0]).toMatchObject({ kind: "tari-page-request", origin: ORIGIN, method: "tari_getNetwork" });
  });

  it("does not let a page choose its own origin", async () => {
    await tari.request({ method: "tari_getAccounts", params: { origin: "https://bank.example" } as never });
    expect(env.sent[0]!.origin).toBe(ORIGIN);
  });

  it("uses unguessable request ids", async () => {
    await Promise.all([tari.getNetwork(), tari.getNetwork()]);
    const [a, b] = env.sent.map((m) => m.id as string);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("turns a wallet error into a rejected promise with its code", async () => {
    env.setBackground((m) => ({ kind: "tari-page-response", id: m.id, error: { code: 4001, message: "Rejected by the user." } }));
    await expect(tari.request({ method: "tari_requestAccounts" })).rejects.toMatchObject({ message: "Rejected by the user.", code: 4001 });
  });

  it("reports a missing response as an internal error", async () => {
    env.setBackground(() => undefined);
    await expect(tari.getNetwork()).rejects.toMatchObject({ code: -32603, message: "No response from wallet extension" });
  });

  it("retries while the background is starting up", async () => {
    let calls = 0;
    env.setBackground((m) => {
      calls++;
      if (calls < 3) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { kind: "tari-page-response", id: m.id, result: "esmeralda" };
    });
    await expect(tari.getNetwork()).resolves.toBe("esmeralda");
    expect(calls).toBe(3);
  });

  it("gives up after a few start-up retries", async () => {
    env.setBackground(() => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    await expect(tari.getNetwork()).rejects.toMatchObject({ code: -32603 });
  }, 10_000);

  it("does not retry other failures", async () => {
    let calls = 0;
    env.setBackground(() => {
      calls++;
      throw new Error("Extension context invalidated.");
    });
    await expect(tari.getNetwork()).rejects.toThrow("Extension context invalidated.");
    expect(calls).toBe(1);
  });

  it("keeps concurrent requests apart", async () => {
    env.setBackground((m) => ({ kind: "tari-page-response", id: m.id, result: m.method }));
    const results = await Promise.all([tari.getNetwork(), tari.getAccounts(), tari.getBalances()]);
    expect(results).toEqual(["tari_getNetwork", "tari_getAccounts", "tari_getBalances"]);
  });
});

describe("message hygiene", () => {
  it("ignores a forged response from another window (an iframe or opener)", async () => {
    env.setBackground(() => new Promise(() => {}) as never); // the wallet never answers
    let settled = false;
    void tari.getNetwork().then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();
    const id = env.sent[0]!.id;
    const other = new EventTarget();
    env.win.dispatchEvent(
      msg({ target: "tari-wallet-page", type: "tari-response", id, result: "forged" }, ORIGIN, other),
    );
    env.win.dispatchEvent(
      msg({ target: "tari-wallet-page", type: "tari-response", id, result: "forged" }, "https://evil.example", env.win),
    );
    await settle();
    expect(settled).toBe(false);
  });

  it("the relay ignores requests posted from another window or origin", async () => {
    const forged = { target: "tari-wallet-content", type: "tari-request", id: "x", method: "tari_getAccounts" };
    env.win.dispatchEvent(msg(forged, ORIGIN, new EventTarget()));
    env.win.dispatchEvent(msg(forged, "https://evil.example", env.win));
    await settle();
    expect(env.sent).toEqual([]);
  });

  it("ignores unrelated page messages", async () => {
    for (const data of [null, "hello", { target: "something-else" }, { target: "tari-wallet-content", type: "other" }]) {
      env.win.dispatchEvent(msg(data, ORIGIN, env.win));
    }
    await settle();
    expect(env.sent).toEqual([]);
  });

  it("a response is used once; a replay of it is ignored", async () => {
    await tari.getNetwork();
    const id = env.sent[0]!.id;
    // Replaying the same response id must not throw or resolve anything else.
    env.win.dispatchEvent(
      msg({ target: "tari-wallet-page", type: "tari-response", id, result: "again" }, ORIGIN, env.win),
    );
    await settle();
  });
});

describe("events", () => {
  it("delivers accountsChanged and networkChanged both ways, and unsubscribes", async () => {
    const accounts: unknown[] = [];
    const networks: unknown[] = [];
    const off = tari.on("accountsChanged", (a) => accounts.push(a));
    tari.on("networkChanged", (n) => networks.push(n));

    env.push({ kind: "tari-accounts-changed", accounts: [] });
    env.push({ kind: "tari-network-changed", network: "igor" });
    await settle();
    expect(accounts).toEqual([[]]);
    expect(networks).toEqual(["igor"]);
    expect(env.events).toContain("tari#accountsChanged:[]");
    expect(env.events).toContain('tari#networkChanged:"igor"');

    off();
    env.push({ kind: "tari-accounts-changed", accounts: ["component_1"] });
    await settle();
    expect(accounts).toEqual([[]]);
  });

  it("a listener that throws doesn't stop the others", async () => {
    const seen: unknown[] = [];
    tari.on("networkChanged", () => {
      throw new Error("dApp bug");
    });
    tari.on("networkChanged", (n) => seen.push(n));
    env.push({ kind: "tari-network-changed", network: "esmeralda" });
    await settle();
    expect(seen).toEqual(["esmeralda"]);
  });

  it("ignores unknown or empty broadcasts", async () => {
    env.push(null);
    env.push({ kind: "something-else" });
    await settle();
    expect(env.events.filter((e) => e.startsWith("tari#accounts") || e.startsWith("tari#network"))).toEqual([]);
  });
});

describe("convenience methods", () => {
  it.each<[string, (t: TariProvider) => Promise<unknown>, string, unknown]>([
    ["requestAccounts", (t) => t.requestAccounts(), "tari_requestAccounts", undefined],
    ["switchNetwork", (t) => t.switchNetwork("igor"), "tari_switchNetwork", { network: "igor" }],
    ["getSubstate", (t) => t.getSubstate("component_1"), "tari_getSubstate", { substateId: "component_1", version: null }],
    ["getSubstate with version", (t) => t.getSubstate("component_1", 3), "tari_getSubstate", { substateId: "component_1", version: 3 }],
    ["getTransactionResult", (t) => t.getTransactionResult("tx"), "tari_getTransactionResult", { transactionId: "tx" }],
    ["disconnect", (t) => t.disconnect(), "tari_disconnect", undefined],
    ["getShieldedOutputs", (t) => t.getShieldedOutputs(), "tari_getShieldedOutputs", {}],
    ["getShieldedOutputs for a resource", (t) => t.getShieldedOutputs("r"), "tari_getShieldedOutputs", { resourceAddress: "r" }],
    ["scanForPrivatePayments", (t) => t.scanForPrivatePayments(), "tari_scanForPrivatePayments", {}],
    ["scanForPrivatePayments with pages", (t) => t.scanForPrivatePayments(4), "tari_scanForPrivatePayments", { maxPages: 4 }],
    ["claimPrivatePayment", (t) => t.claimPrivatePayment("r", "c"), "tari_claimPrivatePayment", { resourceAddress: "r", commitment: "c" }],
    [
      "signOwnershipChallenge",
      (t) => t.signOwnershipChallenge("r", "s", "c"),
      "tari_signOwnershipChallenge",
      { resourceAddress: "r", substateId: "s", challenge: "c" },
    ],
    ["signWalletOwnershipChallenge", (t) => t.signWalletOwnershipChallenge("c"), "tari_signWalletOwnershipChallenge", { challenge: "c" }],
    ["getTransactionRequest", (t) => t.getTransactionRequest("id"), "tari_getTransactionRequest", { requestId: "id" }],
    ["submitTransactionRequest", (t) => t.submitTransactionRequest("id"), "tari_submitTransactionRequest", { requestId: "id" }],
  ])("%s sends the right request", async (_name, call, method, params) => {
    await call(tari);
    expect(env.sent[0]).toMatchObject({ method });
    expect(env.sent[0]!.params).toEqual(params);
  });
});

describe("requestTransaction (create, wait for approval, submit)", () => {
  function scripted(statuses: string[], submitResult: unknown = "tx-hash") {
    env.setBackground((m) => {
      const reply = (result: unknown) => ({ kind: "tari-page-response", id: m.id, result });
      if (m.method === "tari_createTransactionRequest") return reply({ requestId: "r1" });
      if (m.method === "tari_getTransactionRequest") {
        const status = statuses.shift() ?? "pending";
        return reply({ status, result: status === "submitted" ? "already-submitted" : undefined, error: status === "failed" ? "boom" : undefined });
      }
      if (m.method === "tari_submitTransactionRequest") return reply(submitResult);
      throw new Error(`unexpected ${String(m.method)}`);
    });
  }

  it("waits while pending, then submits once approved", async () => {
    scripted(["pending", "pending", "approved"]);
    await expect(tari.requestTransaction({ kind: "instructions", instructions: [] }, 1)).resolves.toBe("tx-hash");
    expect(env.sent.filter((m) => m.method === "tari_submitTransactionRequest")).toHaveLength(1);
  });

  it("resolves with the result if it was already submitted", async () => {
    scripted(["submitted"]);
    await expect(tari.requestTransaction({}, 1)).resolves.toBe("already-submitted");
  });

  it("rejects when the user rejects it, without submitting", async () => {
    scripted(["pending", "rejected"]);
    await expect(tari.requestTransaction({}, 1)).rejects.toThrow(/not approved/);
    expect(env.sent.some((m) => m.method === "tari_submitTransactionRequest")).toBe(false);
  });

  it("rejects with the wallet's error when it fails", async () => {
    scripted(["failed"]);
    await expect(tari.requestTransaction({}, 1)).rejects.toThrow("boom");
  });
});
