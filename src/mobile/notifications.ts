// Phone notifications for approvals that arrive while Sapient is in the background (e.g. a desktop
// dApp paired with the phone). Posted on a private channel, so a locked screen shows only that
// Sapient wants attention, never what; the text names the dApp and the kind of request, never
// amounts or addresses. Removed as soon as the approval is decided or dismissed.
//
// Delivery depends on the app still being alive in the background: Android eventually freezes a
// backgrounded app and its relay connection, after which requests wait at the relay until it is
// opened again (true push would need a push server; see SECURITY_AUDIT.md residual risk).
import { App } from "@capacitor/app";
import { registerPlugin } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { getPendingApproval } from "../background/approvals";
import { originShort } from "../lib/originLabels";
import { t } from "../lib/i18n";
import type { AndroidPlatform } from "./platform";
import type { PendingApproval } from "../lib/messages";

const CHANNEL_ID = "approvals";

/** Native immediate poster (ApprovalNotifierPlugin.java); LocalNotifications only handles the
 * permission prompt and the channel, since its "post now" goes through deferrable alarms. */
const Notifier = registerPlugin<{
  show(options: { id: number; title: string; body: string }): Promise<void>;
  cancel(options: { id: number }): Promise<void>;
}>("ApprovalNotifier");
let appActive = true;

/** Notification ids are 32-bit ints; derive a stable one from the approval's UUID. */
export function notificationId(approvalId: string): number {
  let h = 2166136261;
  for (let i = 0; i < approvalId.length; i++) {
    h ^= approvalId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 1) || 1;
}

function bodyFor(kind: PendingApproval["kind"]): string {
  switch (kind) {
    case "connect":
      return t("notify.connect");
    case "transaction":
      return t("notify.transaction");
    case "switchNetwork":
      return t("notify.switchNetwork");
    case "viewAccess":
      return t("notify.viewAccess");
    default:
      return t("notify.signature");
  }
}

/** Asks for notification permission once it is clearly useful (after the first dApp connects).
 * Android shows its own dialog only while the answer is undecided; afterwards this is a no-op. */
export async function requestNotificationPermissionIfUndecided(): Promise<void> {
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display === "prompt" || display === "prompt-with-rationale") await LocalNotifications.requestPermissions();
  } catch {
    // Not fatal: approvals still appear in the app.
  }
}

export async function initApprovalNotifications(host: AndroidPlatform): Promise<void> {
  try {
    appActive = (await App.getState()).isActive;
  } catch {
    appActive = true;
  }
  App.addListener("appStateChange", ({ isActive }) => {
    appActive = isActive;
  });
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: t("notify.channelName"),
      description: t("notify.channelDescription"),
      importance: 4,
      // Private: the lock screen shows "Sapient" with the content hidden.
      visibility: 0,
      vibration: true,
    });
  } catch {
    // Channel creation can fail on unusual builds; notifications then simply don't show.
  }

  host.onApprovalQueued((id) => {
    if (appActive) return;
    void (async () => {
      // No permission check here: a plugin's reply can't reach a backgrounded WebView until it is
      // resumed, so awaiting one would hold the notification back. The native side checks itself.
      const approval = getPendingApproval(id);
      if (!approval) return;
      await Notifier.show({
        id: notificationId(id),
        title: t("notify.title", { site: originShort(approval.origin) }),
        body: bodyFor(approval.kind),
      });
    })().catch(() => {});
  });

  host.onApprovalClosed((id) => {
    void Notifier.cancel({ id: notificationId(id) }).catch(() => {});
  });
}
