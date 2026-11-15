import type { StorageArea } from "./types";

/** Copies a value the way chrome.storage does (JSON-shaped data only), so callers can never mutate
 * what is stored through a reference they got back from `get`. */
function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function keyList(keys: string | string[] | null | undefined, all: Iterable<string>): string[] {
  if (keys === null || keys === undefined) return [...all];
  return typeof keys === "string" ? [keys] : keys;
}

/** A `StorageArea` kept in memory only -- the Android stand-in for `chrome.storage.session`, and a
 * building block for the persisted area. */
export function memoryArea(map: Map<string, unknown> = new Map()): StorageArea & { readonly map: Map<string, unknown> } {
  return {
    map,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keyList(keys, map.keys())) if (map.has(k)) out[k] = clone(map.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        // chrome.storage drops an explicit undefined on write; match it.
        if (v === undefined) continue;
        map.set(k, clone(v));
      }
    },
    async remove(keys) {
      for (const k of typeof keys === "string" ? [keys] : keys) map.delete(k);
    },
    async clear() {
      map.clear();
    },
  };
}
