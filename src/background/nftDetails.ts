import { indexerUrlFor, parseNonFungibleId, toOotleNetwork, type NetworkName } from "@chironbuilder/ootle-sdk";
import { decodeSubstateValue } from "../lib/bor";

/**
 * One NFT's on-chain record, for display: its `data` (set when minted, fixed) and `mutable_data`
 * (which the resource's owner may change later), flattened to label/value pairs, and a display name
 * when either carries one.
 */
export type NftDetail = { tokenId: string; name: string | null; attributes: Array<[string, string]> };

const MAX_TOKENS = 50;
const FETCH_TIMEOUT_MS = 10_000;
/** Attribute keys taken as the token's own name, in order of preference. */
const NAME_KEYS = ["name", "title"];

/**
 * The substate-id suffixes to try for a token. A canonical id (`u64_5`, `uuid_<hex>`; see the SDK's
 * nonFungibleId.ts) is the suffix itself. A bare display id (from before the SDK reported types) is
 * guessed from its shape; the engine spells a U256 id `uuid_`.
 */
export function nftIdCandidates(tokenId: string): string[] {
  if (parseNonFungibleId(tokenId)) return [tokenId];
  if (/^[0-9a-f]{64}$/i.test(tokenId)) return [`uuid_${tokenId}`, `str_${tokenId}`];
  if (/^\d+$/.test(tokenId)) return [`u64_${tokenId}`, `u32_${tokenId}`, `str_${tokenId}`];
  return [`str_${tokenId}`];
}

/** Unwraps the indexer's `{"@cbor":"tag","value":...}` envelopes and flattens to display pairs. */
export function flattenNftData(data: unknown): Array<[string, string]> {
  let node = data;
  while (node && typeof node === "object" && "@cbor" in node) {
    const env = node as { "@cbor": string; value?: unknown; entries?: Array<[unknown, unknown]> };
    if (env["@cbor"] === "map" && env.entries) {
      node = Object.fromEntries(env.entries.map(([k, v]) => [String(k), v]));
      break;
    }
    node = env.value;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  return Object.entries(node as Record<string, unknown>)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
}

/** Both halves of a token's record as one list (mutable data last, so a changed name wins), and its name. */
export function describeNft(record: { data?: unknown; mutable_data?: unknown } | undefined): Omit<NftDetail, "tokenId"> {
  const attributes = [...flattenNftData(record?.data), ...flattenNftData(record?.mutable_data)];
  let name: string | null = null;
  for (const key of NAME_KEYS) {
    const hit = [...attributes].reverse().find(([k]) => k.toLowerCase() === key);
    if (hit) {
      name = hit[1];
      break;
    }
  }
  return { name, attributes };
}

async function fetchJson(url: string): Promise<unknown | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNftDetails(network: NetworkName, resourceAddress: string, tokenIds: string[]): Promise<NftDetail[]> {
  const hex = /^resource_([0-9a-f]{64})$/.exec(resourceAddress)?.[1];
  if (!hex) throw new Error("Invalid resource address.");
  const base = indexerUrlFor(toOotleNetwork(network));
  return Promise.all(
    tokenIds.slice(0, MAX_TOKENS).map(async (tokenId): Promise<NftDetail> => {
      for (const candidate of nftIdCandidates(tokenId)) {
        const json = (await fetchJson(`${base}/substates/nft_${hex}_${candidate}`).catch(() => null)) as {
          state?: { up?: { substate?: unknown } };
        } | null;
        // The value is base64 CBOR from Ootle 0.48, serde JSON before; decodeSubstateValue takes either.
        const value = decodeSubstateValue<{ NonFungible?: { data?: unknown; mutable_data?: unknown } } | undefined>(json?.state?.up?.substate);
        if (value?.NonFungible) return { tokenId, ...describeNft(value.NonFungible) };
      }
      return { tokenId, name: null, attributes: [] };
    })
  );
}
