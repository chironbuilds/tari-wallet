// Any page request that needs the user's explicit say-so (connecting, signing) opens a small
// popup window and waits for it to resolve. The pending approval + its resolver live here, keyed
// by a random id; the popup window is given that id via its URL and fetches the details back
// through the normal message channel (it can't receive them directly since chrome.windows.create
// only takes a URL, not a message payload).
import type { PendingApproval, PendingApprovalInput } from "../lib/messages";
import { setTransactionRequestStatus } from "../lib/storage";

interface PendingEntry {
  approval: PendingApproval;
  resolve: (approved: boolean) => void;
  windowId?: number;
}

const pending = new Map<string, PendingEntry>();

function randomId(): string {
  return crypto.randomUUID();
}

/**
 * Opens an approval popup and resolves once the user approves or rejects (or closes the window).
 *
 * `id`, when supplied, lets a caller pre-generate the id (e.g. `createTransactionRequest` in
 * background/index.ts, so the approval id matches the persisted `TransactionRequestRecord`'s own
 * id -- `resolveApproval` then updates that record's status too, whether or not this promise is
 * ever awaited). Callers that don't need that (the "connect" approval kind) can omit it.
 */
export async function requestApproval(approval: PendingApprovalInput, id: string = randomId()): Promise<boolean> {
  const full = { ...approval, id } as PendingApproval;

  const approved = await new Promise<boolean>((resolve) => {
    pending.set(id, { approval: full, resolve });
    void openApprovalWindow(id);
  });

  pending.delete(id);
  return approved;
}

async function openApprovalWindow(id: string): Promise<void> {
  const url = chrome.runtime.getURL(`popup.html#/approve/${id}`);
  const win = await chrome.windows.create({ url, type: "popup", width: 380, height: 600 });
  const entry = pending.get(id);
  if (entry && win?.id !== undefined) entry.windowId = win.id;
}

export function getPendingApproval(id: string): PendingApproval | undefined {
  return pending.get(id)?.approval;
}

/**
 * Resolves a pending approval, returning whether it actually did anything -- either woke a live
 * in-memory waiter (the deprecated blocking RPCs, e.g. `tari_signAndSubmitTransaction`) or updated
 * a persisted `TransactionRequestRecord`'s status (the create/submit RPCs, e.g.
 * `tari_createTransactionRequest`), or both, since a single approval id can serve both at once.
 *
 * Only when *neither* happens does this genuinely mean "too late" — most commonly, the in-memory
 * `pending` Map (this file's own state) doesn't survive a service worker restart (Chrome tears MV3
 * workers down after ~30s idle), which used to always mean "the click did nothing, silently" for
 * *every* approval. It still means exactly that for a deprecated blocking call, whose own
 * `sendResponse` closure died in the same restart — there is no way to recover that specific
 * promise. But it's no longer true for a create/submit-based request: `setTransactionRequestStatus`
 * writes through `chrome.storage`, which survives the restart, so the click still lands and the
 * dApp can pick it up via `tari_getTransactionRequest`/`tari_submitTransactionRequest` after the
 * fact. The caller uses this return value to tell the user whether the click was lost outright.
 */
export async function resolveApproval(id: string, approved: boolean): Promise<boolean> {
  const entry = pending.get(id);
  if (entry) {
    entry.resolve(approved);
    if (entry.windowId !== undefined) {
      chrome.windows.remove(entry.windowId).catch(() => {});
    }
  }
  const persisted = await setTransactionRequestStatus(id, { status: approved ? "approved" : "rejected" });
  return entry !== undefined || persisted;
}

// If the user closes the approval window without clicking a button, treat it as a rejection.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, entry] of pending) {
    if (entry.windowId === windowId) {
      entry.resolve(false);
      pending.delete(id);
      void setTransactionRequestStatus(id, { status: "rejected" });
    }
  }
});
