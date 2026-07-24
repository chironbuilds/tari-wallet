import { describe, expect, it } from "vitest";
import { qrCodeSvg } from "./qr";

const ADDR = "component_ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab";

describe("qrCodeSvg", () => {
  it("produces well-formed, scalable SVG markup", () => {
    const svg = qrCodeSvg(ADDR);
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain("viewBox=");
    const openingTag = svg.slice(0, svg.indexOf(">") + 1);
    expect(openingTag).not.toContain("width=");
    expect(svg).toContain("</svg>");
  });

  it("is deterministic for the same input", () => {
    expect(qrCodeSvg(ADDR)).toBe(qrCodeSvg(ADDR));
  });

  it("differs for different input", () => {
    expect(qrCodeSvg(ADDR)).not.toBe(qrCodeSvg(ADDR + "x"));
  });

  it("never throws for an empty string", () => {
    expect(() => qrCodeSvg("")).not.toThrow();
  });
});
