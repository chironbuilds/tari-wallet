import { describe, expect, it } from "vitest";
import { crc32 } from "./crc32";

describe("crc32", () => {
  it("matches the standard CRC-32/ISO-HDLC check value for the ASCII digits check string", () => {
    // The canonical check value for this polynomial, used by every CRC-32 implementation's own
    // test suite (e.g. Rust's crc32fast) to confirm they picked the right variant.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("returns 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});
