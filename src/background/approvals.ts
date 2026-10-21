// Any page request that needs the user's explicit say-so (connecting, signing) opens a small
// popup window and waits for it to resolve. The pending approval + its resolver live here, keyed
// by a random id; the popup window is given that id via its URL and fetches the details back
// through the normal message channel (it can't receive them directly since chrome.windows.create
// only takes a URL, not a message payload).
import type { PendingApproval, PendingApprovalInput } from "../lib/messages";
import { recordTransactionRequestDecision } from "../lib/storage";

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
    openApprovalWindow(id).catch(() => {
      // chrome.windows.create() can reject (a blocked popup, or some other transient window-manager
      // failure) -- without this, the entry above sits in `pending` forever with no window to ever
      // resolve it, and every caller awaiting this promise (tari_requestAccounts, a transaction
      // approval, ...) hangs indefinitely instead of surfacing an error.
      const entry = pending.get(id);
      if (entry) {
        entry.resolve(false);
        pending.delete(id);
      }
    });
  });

  pending.delete(id);
  return approved;
}

async function openApprovalWindow(id: string): Promise<void> {
  const url = chrome.runtime.getURL(`popup.html#/approve/${id}`);
  // Match the action popup's own body size (styles.css: 320x560). The height carries an extra ~40px
  // over the 560 body for the popup window's title bar (a type:"popup" window has one; the toolbar
  // action popup does not); width needs no such allowance, so a 380 width just left ~60px of empty
  // background to the right of Sapient's 320-wide UI.
  const width = 320;
  const height = 600;
  // Anchor the window to the top-right of the active browser window -- where the toolbar icon and
  // the normal action popup appear -- instead of letting Chrome drop a type:"popup" window at an
  // arbitrary spot (which, on a multi-window/multi-monitor setup, often lands nowhere near where the
  // user clicked). A dApp-triggered approval genuinely can't attach to the toolbar icon the way the
  // action popup does, so top-right of the focused window is the closest it can sit to where Sapient
  // is expected to open.
  let top: number | undefined;
  let left: number | undefined;
  try {
    const focused = await chrome.windows.getLastFocused();
    if (typeof focused.left === "number" && typeof focused.top === "number" && typeof focused.width === "number") {
      const margin = 16;
      // No Math.max(0,...) clamp: a window on a secondary monitor can legitimately have negative or
      // large coordinates, and Chrome clips to the usable screen area on its own.
      left = Math.round(focused.left + focused.width - width - margin);
      top = Math.round(focused.top + margin);
    }
  } catch {
    // getLastFocused can reject (no open window, or it races one closing) -- fall back to Chrome's
    // default placement rather than failing the approval entirely.
  }
  const win = await chrome.windows.create({ url, type: "popup", width, height, top, left });
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
 * promise. But it's no longer true for a create/submit-based request: `recordTransactionRequestDecision`
 * writes through `chrome.storage`, which survives the restart, so the click still lands and the
 * dApp can pick it up via `tari_getTransactionRequest`/`tari_submitTransactionRequest` after the
 * fact. The caller uses this return value to tell the user whether the click was lost outright.
 */
/** `chosenFeeType`: the popup's live fee-type toggle at the moment of approval (absent for a
 * rejection, an enforced choice, or an approval with no `feeChoice` at all) -- see
 * `recordTransactionRequestDecision`'s doc comment for where it ends up. */
export async function resolveApproval(id: string, approved: boolean, chosenFeeType?: "private" | "transparent"): Promise<boolean> {
  const entry = pending.get(id);
  if (entry) {
    entry.resolve(approved);
    if (entry.windowId !== undefined) {
      chrome.windows.remove(entry.windowId).catch(() => {});
    }
  }
  // Guarded (pending-only) transition: if a submission already claimed this record moments after
  // the click resolved, writing "approved" here unconditionally would flip it back open and let a
  // second submit through -- see recordTransactionRequestDecision's doc comment.
  const persisted = await recordTransactionRequestDecision(id, approved, chosenFeeType);
  return entry !== undefined || persisted;
}

// If the user closes the approval window without clicking a button, treat it as a rejection.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, entry] of pending) {
    if (entry.windowId === windowId) {
      entry.resolve(false);
      pending.delete(id);
      void recordTransactionRequestDecision(id, false);
    }
  }
});
