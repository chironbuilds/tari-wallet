// HD key derivation: master seed (from the 24-word mnemonic) + account index -> a deterministic
// (ownerSecret, viewSecret) Ristretto scalar pair, matching the shape `SecretKeyWallet.fromSecretKey`
// expects (owner/spend key + view-only key, same two-key model the wallet daemon calls the
// "account" / "view_only_key" branches).
//
// IMPORTANT: this is this extension's OWN derivation scheme (BLAKE2b, domain-separated by branch
// name and account index, reduced mod the Ristretto group order) — not a reimplementation of
// Tari's official CipherSeed/tari_key_manager algorithm. A recovery phrase generated here will
// recover the same accounts *in this extension*, but will NOT import into (or be exported from)
// the official Tari wallet daemon/Aurora/desktop wallet. We didn't find a WASM-ready build of the
// official derivation crate to depend on instead (see project notes) — reimplementing it by hand
// byte-for-byte from the Rust source would be a much larger, higher-risk undertaking than a
// clean-room scheme with the same security properties (uniform, domain-separated, deterministic).
import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// The Ristretto255 / Ed25519 group order l = 2^252 + 27742317777372353535851937790883648493.
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

const DOMAIN = "tari-wallet-extension/ootle/v1";

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** Reduce a 64-byte wide value mod the group order and re-encode as a 32-byte little-endian scalar. */
function scalarFromWideBytes(wide: Uint8Array): Uint8Array {
  let n = 0n;
  for (let i = wide.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(wide[i] ?? 0);
  n %= GROUP_ORDER;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function deriveScalar(masterSeed: Uint8Array, branch: string, index: number): Uint8Array {
  const input = concatBytes(masterSeed, utf8ToBytes(`${DOMAIN}/${branch}/`), u32le(index));
  const wide = blake2b(input, { dkLen: 64 });
  return scalarFromWideBytes(wide);
}

export interface DerivedAccountKeys {
  ownerSecret: Uint8Array;
  viewSecret: Uint8Array;
}

export function deriveAccountKeys(masterSeed: Uint8Array, index: number): DerivedAccountKeys {
  return {
    ownerSecret: deriveScalar(masterSeed, "account", index),
    viewSecret: deriveScalar(masterSeed, "view_only_key", index),
  };
}
