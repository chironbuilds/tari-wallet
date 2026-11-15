// Human-readable labels for dApp origins that aren't URLs. A WalletConnect session's origin is
// "wc:<topic>" (see wcNamespace.ts); the Android bridge registers what the dApp *claims* to be,
// plus Reown Verify's verdict on that claim, so approval screens can show it. In the extension
// every origin is a real URL and this is a pass-through.
//
// Everything but the Verify verdict is attacker-controlled: the name and URL come from the dApp's
// own session metadata. So the display never lets them imitate the verdict -- check-mark glyphs,
// control/bidi characters and quote marks are stripped from the name, which is quoted and capped,
// and the host shown is the Verify-attested origin when there is one, never the claimed URL.

export type VerifyStatus = "VALID" | "INVALID" | "UNKNOWN";

export interface OriginLabel {
  /** The dApp's self-reported name. */
  name: string;
  /** The dApp's self-reported URL. */
  url: string;
  verify: VerifyStatus;
  isScam?: boolean;
  /** The origin Reown Verify attested the request came from (meaningful when verify is VALID). */
  verifiedOrigin?: string;
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

const MAX_NAME_LENGTH = 40;

/** A dApp-supplied name made safe to show next to wallet-generated text. */
export function sanitizeDappName(name: string): string {
  const cleaned = name
    // Control and format characters, including bidi overrides/isolates (U+202A-202E, U+2066-2069)
    // and zero-width characters, which can visually reorder or hide surrounding text.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    // Anything that could pass for the wallet's own verified/warning markers.
    .replace(/[✓✔☑✅☐☒⚠\u{1F512}\u{1F6E1}]/gu, "")
    // Quote marks, so the name can't close the quotes it is shown in.
    .replace(/["“”„‘’«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Unnamed dApp";
  return cleaned.length > MAX_NAME_LENGTH ? `${cleaned.slice(0, MAX_NAME_LENGTH - 1)}…` : cleaned;
}

/** The host of a URL (punycode for international domains, so look-alike letters show as xn--). */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).host;
    return host || null;
  } catch {
    return null;
  }
}

/** One line for display: the origin itself, or for a labelled origin the quoted dApp name, its
 * host, and the verification verdict in wording the dApp cannot produce. */
export function originDisplay(origin: string): string {
  const label = labels.get(origin);
  if (!label) return origin;
  const name = `“${sanitizeDappName(label.name)}”`;
  if (label.isScam) return `${name} — flagged as a scam`;
  if (label.verify === "VALID") {
    const host = hostOf(label.verifiedOrigin) ?? hostOf(label.url) ?? "unknown site";
    return `${name} — ${host} ✓ verified`;
  }
  const claimed = hostOf(label.url) ?? "no website";
  if (label.verify === "INVALID") return `${name} — claims ${claimed} ⚠ domain mismatch`;
  return `${name} — claims ${claimed}, unverified`;
}
