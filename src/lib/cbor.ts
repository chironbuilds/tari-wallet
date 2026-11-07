// A small CBOR reader for a method call's `Literal` arguments (tari_bor: CBOR with a few tagged
// types), so `templateDecoders.ts` can read "price 12.5 XTR" out of the bytes a dApp sent. It is
// read-only and deliberately plain: definite lengths, the major types, floats, and tags. Anything
// it does not understand throws, and the caller treats the argument as unknown.
//
// Tagged values are unwrapped to what a decoder wants to compare against:
//   - tag 131 (0x83), a ResourceAddress      -> "resource_<hex>"
//   - tag 130 (0x82), a ComponentAddress      -> "component_<hex>"
//   - tag 134 (0x86), a TemplateAddress       -> "template_<hex>"
//   - any other tag over a byte string        -> lowercase hex
//   - any other tag                           -> the inner value
// Integers come back as `number` when safe and `bigint` above 2^53; byte strings as hex.

export type CborValue = number | bigint | string | boolean | null | undefined | CborValue[] | { [key: string]: CborValue };

const TAG_COMPONENT_ADDRESS = 130;
const TAG_RESOURCE_ADDRESS = 131;
const TAG_TEMPLATE_ADDRESS = 134;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error("not hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.bytes.length) throw new Error("truncated");
    return this.bytes[this.pos++]!;
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error("truncated");
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  uint(info: number): bigint {
    if (info < 24) return BigInt(info);
    const len = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (len < 0) throw new Error("indefinite lengths are not supported");
    let v = 0n;
    for (const b of this.take(len)) v = (v << 8n) | BigInt(b);
    return v;
  }
  done(): boolean {
    return this.pos >= this.bytes.length;
  }
}

const asNumberOrBigint = (v: bigint): number | bigint => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);

function readFloat(r: Reader, info: number): number {
  if (info === 25) {
    const h = (r.byte() << 8) | r.byte();
    const sign = h & 0x8000 ? -1 : 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
    if (exp === 0) return sign * frac * 2 ** -24;
    if (exp === 31) return frac ? NaN : sign * Infinity;
    return sign * (1 + frac / 1024) * 2 ** (exp - 15);
  }
  const view = new DataView(r.take(info === 26 ? 4 : 8).slice().buffer);
  return info === 26 ? view.getFloat32(0) : view.getFloat64(0);
}

function readItem(r: Reader, depth: number): CborValue {
  if (depth > 64) throw new Error("too deeply nested");
  const initial = r.byte();
  const major = initial >> 5, info = initial & 0x1f;
  switch (major) {
    case 0:
      return asNumberOrBigint(r.uint(info));
    case 1:
      return asNumberOrBigint(-1n - r.uint(info));
    case 2:
      return toHex(r.take(Number(r.uint(info))));
    case 3:
      return new TextDecoder("utf-8", { fatal: true }).decode(r.take(Number(r.uint(info))));
    case 4: {
      const n = Number(r.uint(info));
      const out: CborValue[] = [];
      for (let i = 0; i < n; i++) out.push(readItem(r, depth + 1));
      return out;
    }
    case 5: {
      const n = Number(r.uint(info));
      const out: { [key: string]: CborValue } = {};
      for (let i = 0; i < n; i++) {
        const k = readItem(r, depth + 1);
        out[typeof k === "string" ? k : String(k)] = readItem(r, depth + 1);
      }
      return out;
    }
    case 6: {
      const tag = Number(r.uint(info));
      const inner = readItem(r, depth + 1);
      if (typeof inner === "string" && /^[0-9a-f]*$/.test(inner)) {
        if (tag === TAG_RESOURCE_ADDRESS) return `resource_${inner}`;
        if (tag === TAG_COMPONENT_ADDRESS) return `component_${inner}`;
        if (tag === TAG_TEMPLATE_ADDRESS) return `template_${inner}`;
      }
      return inner;
    }
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info >= 25 && info <= 27) return readFloat(r, info);
      throw new Error(`unsupported simple value ${info}`);
    default:
      throw new Error("unreachable");
  }
}

/** Decode one CBOR item from hex. Throws on anything malformed or unsupported, or on trailing bytes. */
export function decodeCborHex(hex: string): CborValue {
  const r = new Reader(hexToBytes(hex));
  const v = readItem(r, 0);
  if (!r.done()) throw new Error("trailing bytes");
  return v;
}
