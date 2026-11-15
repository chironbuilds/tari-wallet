import { describe, expect, it } from "vitest";
import { originDisplay, sanitizeDappName, setOriginLabel } from "./originLabels";

const origin = (n: number) => `wc:${String(n).repeat(64).slice(0, 64)}`;

describe("sanitizeDappName", () => {
  it("strips fake verification markers, quotes and bidi/zero-width characters", () => {
    expect(sanitizeDappName('Uniswap (app.uniswap.org, ✓ verified)')).toBe("Uniswap (app.uniswap.org, verified)");
    expect(sanitizeDappName("Evil‮gro.paws‬")).toBe("Evilgro.paws");
    expect(sanitizeDappName("Zero​width")).toBe("Zerowidth");
    expect(sanitizeDappName('He said "hi" ✅⚠')).toBe("He said hi");
  });

  it("collapses whitespace, caps length, and names the nameless", () => {
    expect(sanitizeDappName("  a \n\t b  ")).toBe("a b");
    expect(sanitizeDappName("x".repeat(100))).toHaveLength(40);
    expect(sanitizeDappName("‮​ ✓ ")).toBe("Unnamed dApp");
  });
});

describe("originDisplay", () => {
  it("passes real URLs through", () => {
    expect(originDisplay("https://voting.tari.mw")).toBe("https://voting.tari.mw");
  });

  it("shows the Verify-attested host, not the claimed URL, when verified", () => {
    setOriginLabel(origin(1), { name: "Demo", url: "https://claimed.example", verify: "VALID", verifiedOrigin: "https://real.example" });
    expect(originDisplay(origin(1))).toBe("“Demo” — real.example ✓ verified");
  });

  it("marks a claim as unverified, and a domain mismatch as a warning", () => {
    setOriginLabel(origin(2), { name: "Demo", url: "https://demo.tari.mw", verify: "UNKNOWN" });
    expect(originDisplay(origin(2))).toBe("“Demo” — claims demo.tari.mw, unverified");
    setOriginLabel(origin(3), { name: "Demo", url: "https://app.uniswap.org", verify: "INVALID" });
    expect(originDisplay(origin(3))).toBe("“Demo” — claims app.uniswap.org ⚠ domain mismatch");
  });

  it("never shows a verified mark for an unverified dApp, whatever its name says", () => {
    setOriginLabel(origin(4), { name: "Uniswap — app.uniswap.org ✓ verified", url: "https://evil.example", verify: "UNKNOWN" });
    const shown = originDisplay(origin(4));
    expect(shown).not.toContain("✓");
    expect(shown.endsWith("claims evil.example, unverified")).toBe(true);
  });

  it("shows look-alike domains as punycode", () => {
    setOriginLabel(origin(5), { name: "Demo", url: "https://аpple.com", verify: "UNKNOWN" });
    expect(originDisplay(origin(5))).toContain("xn--");
  });

  it("calls out scams above everything else", () => {
    setOriginLabel(origin(6), { name: "Demo", url: "https://x.example", verify: "VALID", isScam: true });
    expect(originDisplay(origin(6))).toBe("“Demo” — flagged as a scam");
  });
});
