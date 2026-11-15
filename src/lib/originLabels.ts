// Human-readable labels for dApp origins that aren't URLs. A WalletConnect session's origin is
// "wc:<topic>" (see wcNamespace.ts); the Android bridge registers what the dApp *claims* to be,
// plus Reown Verify's verdict on that claim, so approval screens can show it. In the extension
// every origin is a real URL and this is a pass-through.

export type VerifyStatus = "VALID" | "INVALID" | "UNKNOWN";

export interface OriginLabel {
  /** The dApp's self-reported name. */
  name: string;
  /** The dApp's self-reported URL. */
  url: string;
  verify: VerifyStatus;
  isScam?: boolean;
}

const labels = new Map<string, OriginLabel>();

export function setOriginLabel(origin: string, label: OriginLabel): void {
  labels.set(origin, label);
}

export function removeOriginLabel(origin: string): void {
  labels.delete(origin);
}

export function getOriginLabel(origin: string): OriginLabel | undefined {
  return labels.get(origin);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One line for display: the origin itself, or for a labelled origin "Name (host)" with a marker
 * saying whether WalletConnect verified the host claim. */
export function originDisplay(origin: string): string {
  const label = labels.get(origin);
  if (!label) return origin;
  const marker = label.verify === "VALID" && !label.isScam ? "✓ verified" : "unverified";
  return `${label.name} (${hostOf(label.url)}, ${marker})`;
}
