// Pure display-formatting and input-parsing logic used by the popup UI, kept separate from
// main.ts (which has DOM side effects on import — it calls main() at module load) specifically so
// this file can be unit tested directly.

export type Balance = { resourceAddress: string; kind: string; amount: string; divisibility: number; symbol: string | null; name: string | null };

// Mirrors `TARI_RESOURCE_ADDRESS` from `@tari-project/ootle` (not imported directly here — that
// would pull the whole wasm-backed SDK into the popup bundle just for one constant string).
export const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";

export function shortAddr(addr: string, n = 10): string {
  return addr.length > n * 2 + 3 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr;
}

// Exactly one optional whole part, exactly one optional ".frac" part, at least one digit
// somewhere — anchored, so "1.2.3" or "1.2abc" are rejected outright instead of silently taking
// only the first two dot-separated segments (`"1.2.3".split(".")` would otherwise destructure to
// `["1", "2"]` and quietly drop the trailing ".3", accepting a malformed amount as "1.2").
const DECIMAL_AMOUNT_PATTERN = /^(\d+)?(?:\.(\d+))?$/;

/** Parses a decimal string (e.g. "12.5") into raw resource-native units for a given divisibility.
 * Truncates (does not round) anything past `divisibility` places, mirroring on-chain behavior. */
export function parseDecimalToRaw(input: string, divisibility: number): bigint {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter an amount.");
  const match = DECIMAL_AMOUNT_PATTERN.exec(trimmed);
  if (!match || (!match[1] && !match[2])) throw new Error("Enter a valid amount.");
  const [, wholeStr = "", fracStr = ""] = match;
  const whole = wholeStr ? BigInt(wholeStr) : 0n;
  const frac = fracStr.slice(0, divisibility).padEnd(divisibility, "0");
  const raw = whole * 10n ** BigInt(divisibility) + (frac ? BigInt(frac) : 0n);
  if (raw <= 0n) throw new Error("Amount must be greater than zero.");
  return raw;
}

export function resourceLabel(resourceAddress: string, symbol: string | null): string {
  if (resourceAddress === TARI_RESOURCE_ADDRESS) return "XTR";
  return symbol ?? shortAddr(resourceAddress);
}

// Each balance carries its resource's real on-chain `divisibility` (see OotleAccount.getBalances()
// in wallet.ts) — not a guessed convention. Confirmed empirically to actually vary: XTR is 6, a
// typical DemoToken-style test token defaults to 8; formatting everything as 6 would silently show
// amounts two orders of magnitude too small for those.
export function formatBalanceAmount(rawAmount: string, divisibility: number): string {
  const unit = 10n ** BigInt(divisibility);
  const raw = BigInt(rawAmount);
  const whole = raw / unit;
  const frac = (raw % unit).toString().padStart(divisibility, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function tokenInitial(resourceAddress: string, symbol: string | null): string {
  const label = resourceLabel(resourceAddress, symbol);
  return label.slice(0, 1).toUpperCase();
}

/** The daemon's JSON-RPC endpoint is conventionally at this fixed sub-path — confirmed empirically
 * that posting to the bare base URL instead serves the daemon's own web UI HTML and silently fails
 * every RPC call. Appending it when a user's URL is missing it turns that footgun into a no-op. */
const DAEMON_JSON_RPC_SUFFIX = "/json_rpc";

/** Parses and normalizes a user-entered daemon URL, appending the JSON-RPC suffix if missing.
 * Throws with a clear message for anything that isn't a plain http(s) URL. */
export function normalizeDaemonUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter the daemon's URL.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid URL, e.g. http://127.0.0.1:5100.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The daemon URL must start with http:// or https://.");
  }
  const normalized = parsed.toString().replace(/\/$/, "");
  return normalized.endsWith(DAEMON_JSON_RPC_SUFFIX) ? normalized : `${normalized}${DAEMON_JSON_RPC_SUFFIX}`;
}

export const MAX_DAEMON_LABEL_LENGTH = 60;

/** A component address is `component_` + 64 hex chars (a 32-byte hash) — exact length, not just
 * "looks hex-ish", so a truncated or mistyped address is caught immediately instead of surfacing as
 * a much more confusing on-chain rejection later. */
export function isValidComponentAddress(address: string): boolean {
  return /^component_[0-9a-f]{64}$/i.test(address);
}
