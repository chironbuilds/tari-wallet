// Pay a name: turn a Yat (1 to 6 emoji) into an `otl_` wallet address.
//
// Two public sources, in order:
//   1. y.at's own payment records (`GET https://a.y.at/emoji_id/{yat}/payment`, open, no login).
//      Yat Labs' record table has no Ootle-address tag yet, so any record whose value is an
//      `otl_` address counts, whatever its tag; the owner sets records through Yat Labs, which
//      makes this the authoritative answer when it exists.
//   2. raddish's owner-set routes (`GET https://raddish.io/api/resolve/{yat}?category=ootle`),
//      which an owner publishes after signing in to raddish with this wallet. A route the owner
//      marked private or authorized is reported as "not disclosed" and never guessed at.
//
// Either source answers in a few hundred milliseconds; both are tried, y.at first, and the first
// address found wins. The caller passes the wallet's network: an address for another network is
// refused outright, because a mainnet wallet must never send to a testnet address or the reverse.
//
// Nothing here is cached: a name can change hands, and a stale address would pay the old owner.

import { networkOfOotleWalletAddress, isValidOotleWalletAddress } from "../popup/format";
import { canonicalYat, validateYat, yatPathId } from "./yatName";

export type ResolveNetwork = "mainnet" | "esmeralda" | "igor";

export interface ResolvedName {
  /** The name as given, trimmed. */
  name: string;
  /** The canonical spelling y.at resolves (siblings folded, variation selectors dropped). */
  canonical: string;
  walletAddress: string;
  network: ResolveNetwork;
  source: "yat" | "raddish";
}

export interface ResolveNameOptions {
  /** Test seam; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  yatApiBase?: string;
  raddishApiBase?: string;
}

export const YAT_API_BASE = "https://a.y.at";
export const RADDISH_API_BASE = "https://raddish.io/api";
const DEFAULT_TIMEOUT_MS = 6_000;

export class NameResolutionError extends Error {
  constructor(
    message: string,
    readonly code: "invalid-name" | "not-found" | "not-disclosed" | "wrong-network" | "unreachable"
  ) {
    super(message);
    this.name = "NameResolutionError";
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Every string anywhere in a JSON value that has the shape of an `otl_` address, in document
 * order. y.at's payment response nests records by tag, and the field names have changed before,
 * so the walk is shape-agnostic on purpose. */
export function ootleAddressesIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (isValidOotleWalletAddress(value)) out.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const v of value) ootleAddressesIn(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) ootleAddressesIn(v, out);
  }
  return out;
}

/** raddish's `/api/resolve` answer, narrowed to what the wallet uses. */
interface RaddishResolve {
  found?: boolean;
  disclosed?: boolean;
  value?: unknown;
  visibility?: string;
}

/** raddish's API wraps every answer as `{ ok: true, data: … }` (yat-market/api/contracts.mjs); an
 * error is `{ ok: false, error }`. Unwraps the envelope, tolerating a bare body. */
function raddishData(body: unknown): RaddishResolve | null {
  if (!body || typeof body !== "object") return null;
  const env = body as { ok?: unknown; data?: unknown };
  if (env.ok === false) return null;
  const data = "data" in env ? env.data : body;
  return data && typeof data === "object" ? (data as RaddishResolve) : null;
}

/**
 * Resolve a Yat to a wallet address on `network`. Throws `NameResolutionError`; never returns an
 * address for a different network.
 */
export async function resolveYatName(name: string, network: ResolveNetwork, options: ResolveNameOptions = {}): Promise<ResolvedName> {
  const trimmed = name.trim();
  const check = validateYat(trimmed);
  if (!check.ok) {
    const why = check.reason === "empty" ? "Enter an emoji name." : check.reason === "too long" ? "An emoji name has at most 6 emoji." : "An emoji name is made only of emoji.";
    throw new NameResolutionError(why, "invalid-name");
  }
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const id = yatPathId(trimmed);
  const canonical = canonicalYat(trimmed);

  const candidates: Array<{ address: string; source: ResolvedName["source"] }> = [];
  let unreachable = 0;
  let notDisclosed = false;

  try {
    const payment = await fetchJson(fetchImpl, `${options.yatApiBase ?? YAT_API_BASE}/emoji_id/${id}/payment`, timeoutMs);
    for (const address of ootleAddressesIn(payment)) candidates.push({ address, source: "yat" });
  } catch {
    unreachable++;
  }

  if (candidates.length === 0) {
    try {
      const r = raddishData(await fetchJson(fetchImpl, `${options.raddishApiBase ?? RADDISH_API_BASE}/resolve/${id}?category=ootle`, timeoutMs));
      if (r?.found && r.disclosed && typeof r.value === "string" && isValidOotleWalletAddress(r.value)) {
        candidates.push({ address: r.value.trim(), source: "raddish" });
      } else if (r?.found && r.disclosed === false) {
        notDisclosed = true;
      }
    } catch {
      unreachable++;
    }
  }

  if (candidates.length === 0) {
    if (unreachable === 2) throw new NameResolutionError("Could not reach y.at or raddish.io to look the name up. Check your connection and try again.", "unreachable");
    if (notDisclosed) throw new NameResolutionError(`${canonical} has an Ootle address, but its owner has not made it public.`, "not-disclosed");
    throw new NameResolutionError(`${canonical} has no Ootle address on record. Ask its owner to set one on y.at or raddish.io.`, "not-found");
  }

  // The first address on the wallet's network wins; one on another network is a hard error, since a
  // dApp or a stale record must never redirect a mainnet payment to a testnet address.
  const onNetwork = candidates.find((c) => networkOfOotleWalletAddress(c.address) === network);
  if (!onNetwork) {
    const other = networkOfOotleWalletAddress(candidates[0]!.address) ?? "an unknown network";
    throw new NameResolutionError(`${canonical} resolves to an address on ${other}, but this account is on ${network}.`, "wrong-network");
  }
  return { name: trimmed, canonical, walletAddress: onNetwork.address, network, source: onNetwork.source };
}
