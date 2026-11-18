import { indexerUrlFor, parseNonFungibleId, toOotleNetwork, type NetworkName } from "@chironbuilder/ootle-sdk";
import { decodeSubstateValue } from "../lib/bor";

/**
 * One NFT's on-chain record, for display: its `data` (set when minted, fixed) and `mutable_data`
 * (which the resource's owner may change later), flattened to label/value pairs, and a display name
 * when either carries one.
 */
export type NftDetail = {
  tokenId: string;
  name: string | null;
  attributes: Array<[string, string]>;
  /** The token's picture as a checked `data:image/(png|jpeg|gif|webp);base64,` URL, or null: see loadNftImage. */
  image: string | null;
};

const MAX_TOKENS = 50;
const FETCH_TIMEOUT_MS = 10_000;
/** Attribute keys taken as the token's own name, in order of preference. */
const NAME_KEYS = ["name", "title"];
/** Attribute keys taken as the token's picture, in order of preference. */
export const IMAGE_KEYS = ["image", "image_url", "imageurl", "image_uri", "imageuri"];
const MAX_IMAGE_BYTES = 2_000_000;
const IMAGE_TIMEOUT_MS = 10_000;
/** Where an `ipfs://` picture is fetched from. */
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export type RasterType = "png" | "jpeg" | "gif" | "webp";

/**
 * The image type from a file's first bytes, or null. Only these four raster formats are accepted:
 * the type is read from the content itself, never from a file name, a `data:` label or a server's
 * Content-Type, so an SVG (which can carry script) or anything else can't pass as a picture.
 */
export function sniffRaster(b: Uint8Array): RasterType | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A checked picture as a data URL the UI can show, built from the bytes themselves. */
function asDataUrl(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const type = sniffRaster(bytes);
  return type ? `data:image/${type};base64,${toBase64(bytes)}` : null;
}

/** Where a token's picture comes from: its data's image field, as given (or null). */
export function imageSourceOf(attributes: Array<[string, string]>): string | null {
  for (const key of IMAGE_KEYS) {
    const hit = [...attributes].reverse().find(([k]) => k.toLowerCase() === key);
    if (hit && hit[1].trim()) return hit[1].trim();
  }
  return null;
}

/** Reads a response body, giving up past MAX_IMAGE_BYTES rather than downloading all of it. */
async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The token's picture, checked: a `data:` image embedded in its data, or one fetched from an
 * `https://` or `ipfs://` link (no cookies, no referrer, 2 MB and 10 s at most). Either way the
 * bytes must be a PNG, JPEG, GIF or WebP by their own signature (sniffRaster), and only those
 * bytes are handed to the UI, re-encoded as a data URL, never the original link. Anything else
 * (SVG, HTML, an unknown scheme, a failed or oversized download) gives null, and the UI keeps its
 * generated tile.
 */
export async function loadNftImage(source: string | null): Promise<string | null> {
  if (!source) return null;
  if (source.startsWith("data:")) {
    const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(source);
    const bytes = m ? fromBase64(m[1]!.replace(/\s+/g, "")) : null;
    return bytes ? asDataUrl(bytes) : null;
  }
  let url: URL;
  try {
    url = new URL(source.startsWith("ipfs://") ? IPFS_GATEWAY + source.slice("ipfs://".length).replace(/^ipfs\//, "") : source);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url.href, { signal: ctl.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "force-cache" });
    if (!res.ok) return null;
    const bytes = await readCapped(res);
    return bytes ? asDataUrl(bytes) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
export function describeNft(record: { data?: unknown; mutable_data?: unknown } | undefined): Omit<NftDetail, "tokenId" | "image"> {
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
        if (value?.NonFungible) {
          const described = describeNft(value.NonFungible);
          return { tokenId, ...described, image: await loadNftImage(imageSourceOf(described.attributes)) };
        }
      }
      return { tokenId, name: null, attributes: [], image: null };
    })
  );
}
