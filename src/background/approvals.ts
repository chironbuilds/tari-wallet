// Any page request that needs the user's explicit say-so (connecting, signing) opens a small
// popup window and waits for it to resolve. The pending approval + its resolver live here, keyed
// by a random id; the popup window is given that id via its URL and fetches the details back
// through the normal message channel (it can't receive them directly since chrome.windows.create
// only takes a URL, not a message payload).
import type { PendingApproval, PendingApprovalInput } from "../lib/messages";

interface PendingEntry {
  approval: PendingApproval;
  resolve: (approved: boolean) => void;
  windowId?: number;
}

const pending = new Map<string, PendingEntry>();

function randomId(): string {
  return crypto.randomUUID();
}

/** Opens an approval popup and resolves once the user approves or rejects (or closes the window). */
export async function requestApproval(approval: PendingApprovalInput): Promise<boolean> {
  const id = randomId();
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

export function resolveApproval(id: string, approved: boolean): void {
  const entry = pending.get(id);
  if (!entry) return;
  entry.resolve(approved);
  if (entry.windowId !== undefined) {
    chrome.windows.remove(entry.windowId).catch(() => {});
  }
}

// If the user closes the approval window without clicking a button, treat it as a rejection.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, entry] of pending) {
    if (entry.windowId === windowId) {
      entry.resolve(false);
      pending.delete(id);
    }
  }
});
