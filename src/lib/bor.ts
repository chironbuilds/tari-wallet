// Decoders for the base64 CBOR engine values the Ootle 0.48 indexer serves (it served serde JSON
// before). A non-string passes through untouched, so an older indexer still reads the same way.
import { decodeEvent as wasmDecodeEvent, decodeSubstateValue as wasmDecodeSubstateValue } from "@tari-project/ootle-wasm-bor";

export const decodeSubstateValue = <T = unknown>(v: unknown): T => (typeof v === "string" ? (JSON.parse(wasmDecodeSubstateValue(v)) as T) : (v as T));
export const decodeEvent = <T = unknown>(v: unknown): T => (typeof v === "string" ? (JSON.parse(wasmDecodeEvent(v)) as T) : (v as T));
