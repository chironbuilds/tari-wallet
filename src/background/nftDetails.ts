import { defaultIndexerUrl } from "@tari-project/ootle";
import { toOotleNetwork, type NetworkName } from "@chironbuilder/ootle-sdk";
import { decodeSubstateValue } from "../lib/bor";

export type NftDetail = { tokenId: string; attributes: Array<[string, string]> };

const MAX_TOKENS = 50;
const FETCH_TIMEOUT_MS = 10_000;

/** The SDK flattens a NonFungibleId to a bare string, losing its type, but the indexer's substate id
 * wants the type spelled out (`nft_<resource>_str_<id>`), so recover the likeliest ones from shape. */
export function nftIdCandidates(tokenId: string): string[] {
  if (/^[0-9a-f]{64}$/i.test(tokenId)) return [`u256_${tokenId}`, `str_${tokenId}`];
  if (/^\d+$/.test(tokenId)) return [`u32_${tokenId}`, `u64_${tokenId}`, `str_${tokenId}`];
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
  const base = defaultIndexerUrl(toOotleNetwork(network));
  return Promise.all(
    tokenIds.slice(0, MAX_TOKENS).map(async (tokenId): Promise<NftDetail> => {
      for (const candidate of nftIdCandidates(tokenId)) {
        const json = (await fetchJson(`${base}/substates/nft_${hex}_${candidate}`).catch(() => null)) as {
          state?: { up?: { substate?: unknown } };
        } | null;
        // The value is base64 CBOR from Ootle 0.48, serde JSON before; decodeSubstateValue takes either.
        const value = decodeSubstateValue<{ NonFungible?: { data?: unknown } } | undefined>(json?.state?.up?.substate);
        const data = value?.NonFungible?.data;
        if (data !== undefined) return { tokenId, attributes: flattenNftData(data) };
      }
      return { tokenId, attributes: [] };
    })
  );
}
