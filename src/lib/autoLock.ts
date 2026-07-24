// Pure decision logic for locking the wallet after a period of inactivity — kept free of any
// chrome.* API so it's testable without mocking (see the existing pattern in format.ts etc.).
// The wallet had no auto-lock at all before this: once unlocked, it stayed unlocked until the
// whole browser closed (chrome.storage.session's own lifetime), no matter how long the popup or
// an open tab sat idle. That's a real exposure window for a self-custody wallet on a shared or
// unattended machine.

/** 0 disables auto-lock entirely ("Never"). */
export const AUTO_LOCK_DISABLED = 0;
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

/** Options surfaced in the settings UI, minutes. */
export const AUTO_LOCK_OPTIONS = [1, 5, 15, 30, 60, AUTO_LOCK_DISABLED] as const;

export function shouldAutoLock(lastActivityMs: number, nowMs: number, autoLockMinutes: number): boolean {
  if (autoLockMinutes <= AUTO_LOCK_DISABLED) return false;
  return nowMs - lastActivityMs >= autoLockMinutes * 60_000;
}

export function formatAutoLockOption(minutes: number): string {
  if (minutes <= AUTO_LOCK_DISABLED) return "Never";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
