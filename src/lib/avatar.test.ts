import { describe, expect, it } from "vitest";
import { avatarSvg } from "./avatar";

const ADDR_A = "component_ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab";
const ADDR_B = "component_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("avatarSvg", () => {
  it("is deterministic: the same address always produces the same SVG", () => {
    expect(avatarSvg(ADDR_A)).toBe(avatarSvg(ADDR_A));
  });

  it("produces a different SVG for a different address", () => {
    expect(avatarSvg(ADDR_A)).not.toBe(avatarSvg(ADDR_B));
  });

  it("changes even for a one-character difference (avalanche, not just length-sensitive)", () => {
    const a = "component_ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab";
    const b = "component_ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56aa";
    expect(avatarSvg(a)).not.toBe(avatarSvg(b));
  });

  it("produces valid, well-formed SVG markup", () => {
    const svg = avatarSvg(ADDR_A, 40);
    expect(svg).toMatch(/^<svg viewBox="0 0 40 40" xmlns="http:\/\/www\.w3\.org\/2000\/svg">/);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<rect");
  });

  it("respects the requested size", () => {
    expect(avatarSvg(ADDR_A, 64)).toContain('viewBox="0 0 64 64"');
  });

  it("never throws or produces empty output for an empty seed", () => {
    expect(() => avatarSvg("")).not.toThrow();
    expect(avatarSvg("")).toContain("<svg");
  });

  it("rarely produces a blank (pattern-less) grid across many hex addresses", () => {
    // Regression test: an earlier version of the internal hash had a strong LSB correlation for
    // hex-alphabet input specifically (exactly what every real address looks like), causing ~44%
    // of addresses to render as an all-background circle with no visible pattern at all.
    const hex = "0123456789abcdef";
    let x = 12345;
    const next = () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x;
    };
    let blank = 0;
    const n = 500;
    for (let addrIdx = 0; addrIdx < n; addrIdx++) {
      let addr = "component_";
      for (let k = 0; k < 64; k++) addr += hex[next() % 16];
      const svg = avatarSvg(addr, 40);
      if (!svg.includes("<rect x=")) blank++;
    }
    expect(blank).toBeLessThan(n * 0.02);
  });

  it("is left-right symmetric (every rect has a mirrored counterpart, or sits on the center column)", () => {
    const size = 50;
    const cell = size / 5;
    const svg = avatarSvg(ADDR_A, size);
    const xs = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+"/g)].map((m) => Number(m[1]));
    const centerX = 2 * cell;
    for (const x of xs) {
      const mirroredX = size - cell - x;
      // Either this rect IS its own mirror (center column), or the mirrored x also appears.
      expect(Math.abs(x - centerX) < 0.01 || xs.some((other) => Math.abs(other - mirroredX) < 0.01)).toBe(true);
    }
  });
});
