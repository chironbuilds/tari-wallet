// Pulling a Tari Ootle address out of scanned or pasted text (pure, unit-tested).

// otl_ / otl_<net>_ addresses use the bech32 alphabet after the "1" separator (no 1, b, i, o);
// component addresses are "component_" + 64 hex.
const ADDRESS_RE = /(otl_(?:[a-z]+_)?1[02-9ac-hj-np-z]{20,}|component_[0-9a-f]{64})/i;

/** The address in a scanned QR or pasted text: a bare address, or one inside a URI / sentence. */
export function extractAddress(text: string): string | null {
  const m = text.trim().match(ADDRESS_RE);
  return m ? m[1]! : null;
}
