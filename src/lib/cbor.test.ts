import { amountLiteral, resourceAddressLiteral } from "@tari-project/ootle";
import { describe, expect, it } from "vitest";
import { decodeCborHex } from "./cbor";

const lit = (a: unknown) => (a as { Literal: string }).Literal;
const utf8Hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

describe("decodeCborHex", () => {
  it("reads the literals @tari-project/ootle builds", () => {
    expect(decodeCborHex(lit(amountLiteral(50_000_000n)))).toBe(50_000_000);
    expect(decodeCborHex(lit(amountLiteral(0n)))).toBe(0);
    expect(decodeCborHex(lit(amountLiteral(1n << 60n)))).toBe(1n << 60n);
    const resource = "resource_0000000000000000000000000000000000000000000000000000000000000001";
    expect(decodeCborHex(lit(resourceAddressLiteral(resource)))).toBe(resource);
  });

  it("reads the plain shapes a template method takes: ints, text, bools, null, arrays, maps", () => {
    expect(decodeCborHex("f5")).toBe(true);
    expect(decodeCborHex("f6")).toBeNull();
    expect(decodeCborHex("20")).toBe(-1);
    expect(decodeCborHex("6b68656c6c6f20776f726c64")).toBe("hello world");
    expect(decodeCborHex("83010203")).toEqual([1, 2, 3]);
    expect(decodeCborHex("a26170016162820203")).toEqual({ p: 1, b: [2, 3] });
    expect(decodeCborHex("fb3ff8000000000000")).toBe(1.5);
    // emoji text, the shape of a Yat in yat_escrow's new_sale
    expect(() => decodeCborHex("6b" + utf8Hex("😶👕👖👟").slice(0, 22))).toThrow(); // truncated utf-8 is not silently accepted
    expect(decodeCborHex("70" + utf8Hex("😶👕👖👟"))).toBe("😶👕👖👟");
  });

  it("unwraps unknown tags over bytes to hex and other tags to their inner value", () => {
    expect(decodeCborHex("d82a4401020304")).toBe("01020304");
    expect(decodeCborHex("d82a0a")).toBe(10);
  });

  it("throws on malformed, indefinite or trailing input rather than guessing", () => {
    expect(() => decodeCborHex("1a02fa")).toThrow(/truncated/);
    expect(() => decodeCborHex("9f01ff")).toThrow(/indefinite/);
    expect(() => decodeCborHex("0101")).toThrow(/trailing/);
    expect(() => decodeCborHex("zz")).toThrow(/hex/);
  });
});
