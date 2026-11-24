// The Chrome host glue (chrome.ts) against a fake `chrome` global: where approval windows open,
// the off-screen retry, closing a window counting as a rejection, broadcasts, storage and messaging.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "./types";

interface FakeChrome {
  created: Array<Record<string, unknown>>;
  removed: number[];
  sentToTabs: Array<[number, unknown]>;
  closeWindow(id: number): void;
  chrome: Record<string, unknown>;
  lastFocused: Record<string, unknown> | Error;
  createFailsWithBounds: boolean;
  lastError?: { message: string };
  respond: (message: unknown) => unknown;
}

function fakeChrome(): FakeChrome {
  const removedListeners: Array<(id: number) => void> = [];
  let nextId = 100;
  const f: FakeChrome = {
    created: [],
    removed: [],
    sentToTabs: [],
    closeWindow: (id) => removedListeners.forEach((l) => l(id)),
    lastFocused: { left: 100, top: 50, width: 1200 },
    createFailsWithBounds: false,
    respond: () => ({ ok: true, result: "pong" }),
    chrome: {},
  };
  const store = new Map<string, unknown>();
  const storageArea = {
    get: async (keys: string | string[] | null) => {
      const ks = keys === null ? [...store.keys()] : typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(ks.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
    },
    set: async (items: Record<string, unknown>) => Object.entries(items).forEach(([k, v]) => store.set(k, v)),
    remove: async (keys: string | string[]) => (typeof keys === "string" ? [keys] : keys).forEach((k) => store.delete(k)),
    clear: async () => store.clear(),
  };
  f.chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      getManifest: () => ({ version: "1.2.3" }),
      reload: vi.fn(),
      connect: vi.fn(),
      get lastError() {
        return f.lastError;
      },
      sendMessage: (message: unknown, cb: (r: unknown) => void) => setTimeout(() => cb(f.respond(message)), 0),
    },
    windows: {
      getLastFocused: async () => {
        if (f.lastFocused instanceof Error) throw f.lastFocused;
        return f.lastFocused;
      },
      create: async (opts: Record<string, unknown>) => {
        f.created.push(opts);
        if (f.createFailsWithBounds && opts.left !== undefined) throw new Error("Invalid value for bounds.");
        return { id: nextId++ };
      },
      remove: async (id: number) => {
        f.removed.push(id);
      },
      onRemoved: { addListener: (l: (id: number) => void) => removedListeners.push(l) },
    },
    tabs: {
      query: async () => [{ id: 1 }, { id: undefined }, { id: 2 }, { id: 3 }],
      sendMessage: async (tabId: number, message: unknown) => {
        if (tabId === 2) throw new Error("Receiving end does not exist.");
        f.sentToTabs.push([tabId, message]);
      },
    },
    permissions: { request: vi.fn(async () => true) },
    storage: { local: storageArea, session: storageArea },
  };
  return f;
}

let f: FakeChrome;
let platform: Platform;

beforeEach(async () => {
  vi.resetModules(); // chrome.ts keeps module state (open windows, the onRemoved listener)
  f = fakeChrome();
  vi.stubGlobal("chrome", f.chrome);
  const { chromePlatform } = await import("./chrome");
  platform = chromePlatform();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("approval windows", () => {
  it("opens a popup-sized window at the top right of the focused browser window", async () => {
    await platform.openApproval("a1");
    expect(f.created[0]).toEqual({
      url: "chrome-extension://abc/popup.html#/approve/a1",
      type: "popup",
      width: 320,
      height: 600,
      left: 100 + 1200 - 320 - 16,
      top: 50 + 16,
    });
  });

  it("falls back to Chrome's placement when the focused window is unknown", async () => {
    f.lastFocused = new Error("No window");
    await platform.openApproval("a1");
    expect(f.created[0]).toMatchObject({ left: undefined, top: undefined });
  });

  it("retries without a position when Chrome refuses off-screen bounds", async () => {
    f.createFailsWithBounds = true;
    await platform.openApproval("a1");
    expect(f.created).toHaveLength(2);
    expect(f.created[1]).not.toHaveProperty("left");
  });

  it("closing the window without deciding counts as dismissing that approval only", async () => {
    const dismissed: string[] = [];
    platform.onApprovalDismissed((id) => dismissed.push(id));
    await platform.openApproval("a1");
    await platform.openApproval("a2");
    f.closeWindow(100);
    expect(dismissed).toEqual(["a1"]);
    f.closeWindow(999); // some unrelated window
    expect(dismissed).toEqual(["a1"]);
  });

  it("closing an approval after a decision removes its window, and doesn't report a dismissal", async () => {
    const dismissed: string[] = [];
    platform.onApprovalDismissed((id) => dismissed.push(id));
    await platform.openApproval("a1");
    platform.closeApproval("a1");
    expect(f.removed).toEqual([100]);
    f.closeWindow(100); // Chrome then reports the removal
    expect(dismissed).toEqual([]);
    platform.closeApproval("a1"); // already closed: nothing more
    expect(f.removed).toEqual([100]);
  });
});

describe("broadcasts", () => {
  it("reach every tab, tolerating tabs without the content script", async () => {
    const message = { kind: "tari-network-changed", network: "igor" } as const;
    await platform.broadcast(message);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.sentToTabs).toEqual([
      [1, message],
      [3, message],
    ]);
  });
});

describe("popup messaging", () => {
  it("returns the background's response envelope", async () => {
    await expect(platform.sendPopupRequest({ kind: "popup-get-lock-state" })).resolves.toEqual({ ok: true, result: "pong" });
  });

  it("rejects with Chrome's error when the background can't be reached", async () => {
    f.lastError = { message: "Could not establish connection. Receiving end does not exist." };
    await expect(platform.sendPopupRequest({ kind: "popup-get-lock-state" })).rejects.toThrow(/Receiving end/);
  });
});

describe("the rest of the host", () => {
  it("stores and reads values through chrome.storage", async () => {
    await platform.local.set({ a: 1, b: { c: 2 } });
    expect(await platform.local.get(["a", "b"])).toEqual({ a: 1, b: { c: 2 } });
    await platform.local.remove("a");
    expect(await platform.local.get(null)).toEqual({ b: { c: 2 } });
    await platform.local.clear();
    expect(await platform.local.get(null)).toEqual({});
  });

  it("reports the manifest version, resolves asset URLs and asks for host permissions", async () => {
    expect(platform.kind).toBe("extension");
    expect(platform.appVersion()).toBe("1.2.3");
    expect(platform.assetUrl("icons/icon48.png")).toBe("chrome-extension://abc/icons/icon48.png");
    expect(await platform.requestHostPermission("https://node.example/*")).toBe(true);
    expect((f.chrome.permissions as { request: ReturnType<typeof vi.fn> }).request).toHaveBeenCalledWith({ origins: ["https://node.example/*"] });
  });

  it("keeps the worker alive with a named port while an approval shows", () => {
    platform.keepAliveWhileApproving();
    expect((f.chrome.runtime as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalledWith({ name: "approval-keepalive" });
  });
});
