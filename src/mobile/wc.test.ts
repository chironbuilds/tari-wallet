// The WalletConnect bridge (wc.ts) end to end: a fake WalletKit on one side, the real Android
// platform and wallet core on the other. Covers what a dApp connected over WalletConnect can and
// can't do: proposals, the connect prompt, per-session origins, method/chain checks, scam flags,
// disconnects in either direction, network changes and deep links.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- fakes for the native and WalletConnect pieces ----
const prefs = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    keys: async () => ({ keys: [...prefs.keys()] }),
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void prefs.delete(key),
    clear: async () => prefs.clear(),
  },
}));
vi.mock("./biometric", () => ({ createBiometric: () => undefined }));
vi.mock("./pairUi", () => ({ installPairingUi: vi.fn(), showPairingNotice: vi.fn() }));
vi.mock("./notifications", () => ({ requestNotificationPermissionIfUndecided: vi.fn(async () => {}) }));
const app = vi.hoisted(() => ({ active: true, launchUrl: undefined as string | undefined, listeners: new Map<string, (e: { url: string }) => void>() }));
vi.mock("@capacitor/app", () => ({
  App: {
    getState: async () => ({ isActive: app.active }),
    addListener: (name: string, l: (e: { url: string }) => void) => app.listeners.set(name, l),
    getLaunchUrl: async () => (app.launchUrl ? { url: app.launchUrl } : undefined),
    minimizeApp: vi.fn(async () => {}),
  },
}));
vi.mock("@capacitor/core", async (orig) => ({
  ...(await orig<object>()),
  registerPlugin: () => ({ setEnabled: vi.fn(async () => {}) }),
}));
vi.mock("@walletconnect/core", () => ({ Core: class {} }));
vi.mock("@walletconnect/utils", () => ({ getSdkError: (key: string, message?: string) => ({ code: 5000, message: message ?? key }) }));

interface Session {
  topic: string;
  peer: { metadata: { name: string; url: string } };
  namespaces: { tari: { chains: string[]; accounts: string[] } };
}
/** A WalletConnect topic: 32 random bytes as hex in real life; derived from the proposal id here. */
const topicFor = vi.hoisted(() => (id: number) => id.toString(16).padStart(64, "0"));
const kit = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown) => void>(),
  sessions: {} as Record<string, unknown>,
  responses: [] as Array<{ topic: string; response: { id: number; result?: unknown; error?: { code: number; message: string } } }>,
  approved: [] as unknown[],
  rejected: [] as unknown[],
  disconnected: [] as string[],
  events: [] as Array<{ topic: string; chainId: string; event: { name: string; data: unknown } }>,
  updates: [] as unknown[],
  paired: [] as string[],
}));
vi.mock("@reown/walletkit", () => ({
  WalletKit: {
    init: async () => ({
      on: (name: string, h: (e: unknown) => void) => kit.handlers.set(name, h),
      getActiveSessions: () => kit.sessions,
      getPendingSessionRequests: () => [],
      approveSession: async ({ id, namespaces }: { id: number; namespaces: Session["namespaces"] }) => {
        const topic = topicFor(id);
        const session: Session = { topic, peer: { metadata: { name: "Test dApp", url: "https://dapp.example" } }, namespaces };
        kit.sessions[topic] = session;
        kit.approved.push({ id, namespaces });
        return session;
      },
      rejectSession: async (r: unknown) => void kit.rejected.push(r),
      respondSessionRequest: async (r: (typeof kit.responses)[number]) => void kit.responses.push(r),
      disconnectSession: async ({ topic }: { topic: string }) => {
        kit.disconnected.push(topic);
        delete kit.sessions[topic];
      },
      updateSession: async (u: { topic: string; namespaces: Session["namespaces"] }) => {
        kit.updates.push(u);
        (kit.sessions[u.topic] as Session).namespaces = u.namespaces;
      },
      emitSessionEvent: async (e: (typeof kit.events)[number]) => void kit.events.push(e),
      pair: async ({ uri }: { uri: string }) => void kit.paired.push(uri),
    }),
  },
}));

const { createAndroidPlatform } = await import("./platform");
const { setPlatform } = await import("../platform");
const core = await import("../background/core");
const { startWalletConnect, wcUriFromDeepLink, pairWithUri } = await import("./wc");

const PASSWORD = "Unit-Test-Pass-7q!";
let host: Awaited<ReturnType<typeof createAndroidPlatform>>;
let decide: "approve" | "reject" | "hold" = "approve";
let nextId = 1;
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(async () => {
  prefs.clear();
  Object.assign(kit, { sessions: {}, responses: [], approved: [], rejected: [], disconnected: [], events: [], updates: [], paired: [] });
  kit.handlers.clear();
  app.active = true;
  app.launchUrl = undefined;
  decide = "approve";
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network disabled in unit tests"))));
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { hash: "", reload: () => {} } }));
  vi.stubGlobal("HashChangeEvent", class extends Event {});
  vi.stubEnv("VITE_REOWN_PROJECT_ID", "test-project");

  host = await createAndroidPlatform({ handlePopupRequest: core.handlePopupRequest, sanitize: core.sanitizeForMessage });
  setPlatform(host);
  core.initCore();
  // The approval screen: answer whatever shows up, per `decide`.
  host.onApprovalQueued((id) => {
    if (decide === "hold") return;
    setTimeout(() => void core.handlePopupRequest({ kind: "popup-resolve-approval", approvalId: id, approve: decide === "approve" }), 0);
  });
  await core.handlePopupRequest({ kind: "popup-create-wallet", password: PASSWORD });
  await core.handlePopupRequest({ kind: "popup-confirm-backup" });
  await startWalletConnect(host);
});

afterEach(() => {
  host.dismissAllApprovals();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function propose(required: Record<string, unknown> = { tari: { chains: ["tari:esmeralda"] } }, extra: Record<string, unknown> = {}) {
  const id = nextId++;
  kit.handlers.get("session_proposal")!({
    id,
    params: { pairingTopic: `pair${id}`, requiredNamespaces: required, optionalNamespaces: {}, proposer: { metadata: { name: "Test dApp", url: "https://dapp.example" } } },
    verifyContext: { verified: { validation: "VALID", origin: "https://dapp.example", ...extra } },
  });
  return id;
}

async function connectSession(): Promise<string> {
  const id = propose();
  await vi.waitFor(() => expect(kit.approved.length + kit.rejected.length).toBeGreaterThan(0));
  return topicFor(id);
}

async function request(topic: string, method: string, params?: unknown, chainId = "tari:esmeralda", extra: Record<string, unknown> = {}) {
  const id = nextId++;
  kit.handlers.get("session_request")!({
    id,
    topic,
    params: { chainId, request: { method, params } },
    verifyContext: { verified: { validation: "VALID", origin: "https://dapp.example", ...extra } },
  });
  await vi.waitFor(() => expect(kit.responses.find((r) => r.response.id === id)).toBeDefined(), { timeout: 5000 });
  return kit.responses.find((r) => r.response.id === id)!.response;
}

describe("session proposals", () => {
  it("asks the user, then approves the session for this network with the active account", async () => {
    const topic = await connectSession();
    expect(kit.approved).toHaveLength(1);
    const ns = (kit.approved[0] as { namespaces: Session["namespaces"] }).namespaces.tari;
    expect(ns.chains).toEqual(["tari:esmeralda"]);
    expect(ns.accounts[0]).toMatch(/^tari:esmeralda:component_[0-9a-f]{64}$/);
    const sites = await core.handlePopupRequest({ kind: "popup-get-connected-sites" });
    expect(sites).toEqual([expect.objectContaining({ origin: `wc:${topic}`, accountId: "local:0" })]);
  });

  it("a rejected prompt rejects the session and connects nothing", async () => {
    decide = "reject";
    propose();
    await vi.waitFor(() => expect(kit.rejected).toHaveLength(1));
    expect(kit.approved).toEqual([]);
    expect(await core.handlePopupRequest({ kind: "popup-get-connected-sites" })).toEqual([]);
  });

  it.each([
    ["another chain family", { eip155: { chains: ["eip155:1"] } }],
    ["another Tari network", { tari: { chains: ["tari:mainnet"] } }],
    ["an unknown Tari network", { tari: { chains: ["tari:moon"] } }],
  ])("refuses a dApp that requires %s, without prompting", async (_label, required) => {
    propose(required);
    await vi.waitFor(() => expect(kit.rejected).toHaveLength(1));
    expect(host.approvalQueue()).toEqual([]);
  });

  it("refuses a site flagged as a scam, without prompting", async () => {
    propose(undefined, { isScam: true });
    await vi.waitFor(() => expect(kit.rejected).toHaveLength(1));
    expect(host.approvalQueue()).toEqual([]);
  });

  it("a locked wallet can't approve a session", async () => {
    decide = "hold";
    propose();
    await vi.waitFor(() => expect(host.approvalQueue()).toHaveLength(1));
    await core.handlePopupRequest({ kind: "popup-lock" });
    await core.handlePopupRequest({ kind: "popup-resolve-approval", approvalId: host.approvalQueue()[0]!, approve: true });
    await vi.waitFor(() => expect(kit.rejected).toHaveLength(1));
    expect(kit.approved).toEqual([]);
  });
});

describe("session requests", () => {
  let topic: string;
  beforeEach(async () => {
    topic = await connectSession();
  });

  it("answers through the core under the session's own origin", async () => {
    const accounts = await request(topic, "tari_getAccounts");
    expect(accounts.result).toEqual([expect.stringMatching(/^component_/)]);
    expect((await request(topic, "tari_getNetwork")).result).toBe("esmeralda");
  });

  it("a request on an unknown session topic gets nothing", async () => {
    const stranger = "f".repeat(64);
    expect((await request(stranger, "tari_getAccounts")).result).toEqual([]);
    expect((await request(stranger, "tari_getWalletAddress")).error?.message).toMatch(/not connected/i);
  });

  it("refuses methods outside the Tari set and requests for another chain", async () => {
    expect((await request(topic, "eth_sendTransaction")).error).toMatchObject({ code: 4200 });
    expect((await request(topic, "tari_getAccounts", undefined, "tari:mainnet")).error).toMatchObject({ code: 4200 });
    expect((await request(topic, "tari_getAccounts", undefined, "eip155:1")).error).toMatchObject({ code: 4200 });
  });

  it("signing needs the user's approval, and a rejection comes back as 4001", async () => {
    const signed = await request(topic, "tari_signWalletOwnershipChallenge", { challenge: "hi" });
    expect((signed.result as { signature: unknown }).signature).toBeTruthy();
    decide = "reject";
    expect((await request(topic, "tari_signWalletOwnershipChallenge", { challenge: "no" })).error).toMatchObject({ code: 4001 });
  });

  it("drops a session flagged as a scam on its next request", async () => {
    expect((await request(topic, "tari_getAccounts", undefined, "tari:esmeralda", { isScam: true })).error).toMatchObject({ code: 4100 });
    await vi.waitFor(async () => expect(await core.handlePopupRequest({ kind: "popup-get-connected-sites" })).toEqual([]));
    await vi.waitFor(() => expect(kit.disconnected).toContain(topic));
  });

  it("tari_disconnect from the dApp ends the WalletConnect session too", async () => {
    await request(topic, "tari_disconnect");
    await vi.waitFor(() => expect(kit.disconnected).toContain(topic));
  });

  it("disconnecting the site in the wallet ends the session", async () => {
    await core.handlePopupRequest({ kind: "popup-disconnect-site", origin: `wc:${topic}` });
    await vi.waitFor(() => expect(kit.disconnected).toContain(topic));
  });

  it("a session the dApp deleted removes the connected site", async () => {
    delete kit.sessions[topic];
    kit.handlers.get("session_delete")!({ topic });
    await vi.waitFor(async () => expect(await core.handlePopupRequest({ kind: "popup-get-connected-sites" })).toEqual([]));
  });

  it("an approved network switch moves the session to the new chain before replying", async () => {
    const res = await request(topic, "tari_switchNetwork", { network: "igor" });
    expect(res.result).toBe("igor");
    expect(kit.updates).toEqual([expect.objectContaining({ topic })]);
    expect((kit.sessions[topic] as Session).namespaces.tari.chains).toEqual(["tari:igor"]);
    expect(kit.events.some((e) => e.event.name === "networkChanged" && e.chainId === "tari:igor")).toBe(true);
    // The session keeps working on the new chain.
    expect((await request(topic, "tari_getNetwork", undefined, "tari:igor")).result).toBe("igor");
  });

  it("switching accounts tells the session its accounts changed", async () => {
    await core.handlePopupRequest({ kind: "popup-add-account" });
    await core.handlePopupRequest({ kind: "popup-set-active-account", accountId: "local:0" });
    await core.handlePopupRequest({ kind: "popup-set-active-account", accountId: "local:1" });
    // The switch drops every connection; the session is ended rather than left pointing at the old account.
    await vi.waitFor(() => expect(kit.disconnected).toContain(topic));
  });

  it("returns to a dApp that brought the app up from the background, once answered", async () => {
    app.active = false;
    decide = "approve";
    const { App } = await import("@capacitor/app");
    vi.mocked(App.minimizeApp).mockClear();
    await request(topic, "tari_signWalletOwnershipChallenge", { challenge: "from the browser" });
    await vi.waitFor(() => expect(App.minimizeApp).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it("stays in the app when the user started the request there", async () => {
    const { App } = await import("@capacitor/app");
    vi.mocked(App.minimizeApp).mockClear();
    await request(topic, "tari_signWalletOwnershipChallenge", { challenge: "in the app" });
    await new Promise((r) => setTimeout(r, 1200));
    expect(App.minimizeApp).not.toHaveBeenCalled();
  });
});

describe("deep links and pairing", () => {
  it("reads wc: URIs from sapient:// links", () => {
    expect(wcUriFromDeepLink("wc:abc@2?symKey=1")).toBe("wc:abc@2?symKey=1");
    expect(wcUriFromDeepLink("sapient://wc?uri=" + encodeURIComponent("wc:abc@2?symKey=1"))).toBe("wc:abc@2?symKey=1");
    expect(wcUriFromDeepLink("sapient://scan")).toBeNull();
    expect(wcUriFromDeepLink("https://evil.example/wc?uri=wc:x")).toBeNull();
    expect(wcUriFromDeepLink("not a url")).toBeNull();
  });

  it("pairs only with real WalletConnect URIs", async () => {
    await expect(pairWithUri("https://example.com")).rejects.toThrow(/Not a WalletConnect link/);
    await pairWithUri("wc:abc@2"); // a bare topic (brings the app up for a request): nothing to pair
    expect(kit.paired).toEqual([]);
    await pairWithUri("  wc:abc@2?relay-protocol=irn&symKey=00  ");
    expect(kit.paired).toEqual(["wc:abc@2?relay-protocol=irn&symKey=00"]);
  });

  it("an opened sapient://wc link pairs and arms the return to the dApp", async () => {
    app.listeners.get("appUrlOpen")!({ url: "sapient://wc?uri=" + encodeURIComponent("wc:t@2?symKey=1") });
    await tick();
    expect(kit.paired).toEqual(["wc:t@2?symKey=1"]);
  });
});
