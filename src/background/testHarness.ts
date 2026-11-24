// Test-only harness for the host-independent wallet core (core.ts): an in-memory Platform whose
// approval "window" answers itself according to a per-test policy, plus helpers to drive the core
// the way the popup and a dApp would. Never imported by app code.
import { vi } from "vitest";
import { memoryArea } from "../platform/memoryArea";
import { setPlatform, type Platform, type WalletBroadcast } from "../platform";
import type { PageRequestMessage, PendingApproval, PopupRequest } from "../lib/messages";
import { getPendingApproval } from "./approvals";
import { handlePageRequest, handlePopupRequest, initCore } from "./core";

export const PASSWORD = "Unit-Test-Pass-7q!";
export const SITE = "https://dapp.example";
export const OTHER_SITE = "https://other.example";

/** What the fake approval window does when it opens. "hold" leaves it open until the test acts. */
export type ApprovalAction = "approve" | "reject" | "dismiss" | "fail-to-open" | "hold";

export interface Harness {
  platform: Platform;
  /** Every approval the core asked to show, in order, with its details. */
  shown: PendingApproval[];
  /** Everything broadcast to connected dApps. */
  broadcasts: WalletBroadcast[];
  sitesChanged: ReturnType<typeof vi.fn>;
  /** Sets how the next approval windows answer (default "approve"). */
  answerWith(action: ApprovalAction): void;
  /** Answers a held approval. */
  answer(id: string, approve: boolean): Promise<void>;
  /** Simulates the user closing a held approval window. */
  dismiss(id: string): void;
  popup<T = unknown>(message: PopupRequest): Promise<T>;
  page<T = unknown>(method: string, params?: unknown, origin?: string): Promise<T>;
  /** Like `page`, but resolves to the error message instead of throwing (undefined on success). */
  pageError(method: string, params?: unknown, origin?: string): Promise<string | undefined>;
  /** Closes every approval still open, so pending-approval caps don't leak into the next test. */
  cleanup(): void;
}

export function setupHarness(): Harness {
  let action: ApprovalAction = "approve";
  const shown: PendingApproval[] = [];
  const broadcasts: WalletBroadcast[] = [];
  const dismissHandlers: Array<(id: string) => void> = [];
  const sitesChanged = vi.fn();

  const answer = async (id: string, approve: boolean) => {
    await handlePopupRequest({ kind: "popup-resolve-approval", approvalId: id, approve });
  };
  const dismiss = (id: string) => dismissHandlers.forEach((h) => h(id));

  const platform: Platform = {
    kind: "extension",
    local: memoryArea(),
    session: memoryArea(),
    async openApproval(id) {
      const approval = getPendingApproval(id);
      if (approval) shown.push(approval);
      if (action === "fail-to-open") throw new Error("popup blocked");
      // Answer on a later tick, as a real window would, after requestApproval starts waiting.
      if (action === "hold") return;
      const decided = action;
      setTimeout(() => {
        if (decided === "dismiss") dismiss(id);
        else void answer(id, decided === "approve");
      }, 0);
    },
    closeApproval() {},
    onApprovalDismissed(handler) {
      dismissHandlers.push(handler);
    },
    sitesChanged,
    async broadcast(message) {
      broadcasts.push(message);
    },
    appVersion: () => "0.0.0-test",
    reload() {},
    async sendPopupRequest() {
      throw new Error("not used by the core tests");
    },
    assetUrl: (p) => p,
    async requestHostPermission() {
      return true;
    },
    keepAliveWhileApproving() {},
    closeApprovalView() {},
  };

  setPlatform(platform);
  initCore();

  const page = <T>(method: string, params?: unknown, origin = SITE) =>
    handlePageRequest({ kind: "tari-page-request", id: crypto.randomUUID(), origin, method, params } as PageRequestMessage) as Promise<T>;

  return {
    platform,
    shown,
    broadcasts,
    sitesChanged,
    answerWith: (a) => {
      action = a;
    },
    answer,
    dismiss,
    popup: <T>(message: PopupRequest) => handlePopupRequest(message) as Promise<T>,
    page,
    async pageError(method, params, origin) {
      try {
        await page(method, params, origin);
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    cleanup() {
      for (const a of shown) dismiss(a.id);
    },
  };
}

/** Creates a wallet (and confirms its backup), leaving it unlocked. Returns the recovery phrase. */
export async function createWallet(h: Harness): Promise<string> {
  const { mnemonic } = await h.popup<{ mnemonic: string }>({ kind: "popup-create-wallet", password: PASSWORD });
  await h.popup({ kind: "popup-confirm-backup" });
  return mnemonic;
}

/** Connects `origin` (approving the prompt) and returns the component address it was given. */
export async function connect(h: Harness, origin = SITE): Promise<string> {
  h.answerWith("approve");
  const [address] = await h.page<string[]>("tari_requestAccounts", undefined, origin);
  return address!;
}

/** Lets pending timers (the fake approval window's answer) run. */
export const tick = () => new Promise((r) => setTimeout(r, 0));
