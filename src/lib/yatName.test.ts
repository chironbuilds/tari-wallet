import { describe, expect, it } from "vitest";
import { canonicalYat, foldGrapheme, looksLikeYat, toGraphemes, toTokens, validateYat, yatPathId } from "./yatName";

describe("graphemes", () => {
  it("splits by extended grapheme cluster, so ZWJ sequences, skin tones and flags stay whole", () => {
    expect(toGraphemes("👨‍👩‍👧🦄🇺🇸👍🏽")).toEqual(["👨‍👩‍👧", "🦄", "🇺🇸", "👍🏽"]);
  });

  it("order is identity", () => {
    expect(toTokens("🦄🚀")).not.toEqual(toTokens("🚀🦄"));
  });
});

describe("folding (Yat's sibling rules)", () => {
  it("drops variation selectors and folds colour hearts onto the red heart", () => {
    expect(foldGrapheme("❤️")).toBe("❤");
    expect(foldGrapheme("💜")).toBe("❤");
    expect(canonicalYat("💜💜💜")).toBe(canonicalYat("❤️❤️❤️"));
  });

  it("folds the other sibling groups and leaves everything else alone", () => {
    expect(foldGrapheme("🦙")).toBe("🐑");
    expect(foldGrapheme("💶")).toBe("💵");
    expect(foldGrapheme("🏉")).toBe("🏈");
    expect(foldGrapheme("🦕")).toBe("🦖");
    expect(foldGrapheme("🦄")).toBe("🦄");
  });

  it("yatPathId is the folded name, percent-encoded for a URL path", () => {
    expect(decodeURIComponent(yatPathId("❤️🦙"))).toBe("❤🐑");
    expect(yatPathId("🦄")).toBe(encodeURIComponent("🦄"));
  });
});

describe("validateYat", () => {
  it("accepts 1 to 6 emoji", () => {
    expect(validateYat("🦄")).toEqual({ ok: true, length: 1 });
    expect(validateYat("😶👕👖👟")).toEqual({ ok: true, length: 4 });
    expect(validateYat(" 🦄🚀🌙💎🔑🎼 ")).toEqual({ ok: true, length: 6 });
  });

  it("refuses empty, over-long and non-emoji strings, saying why", () => {
    expect(validateYat("")).toMatchObject({ ok: false, reason: "empty" });
    expect(validateYat("🦄🦄🦄🦄🦄🦄🦄")).toMatchObject({ ok: false, reason: "too long", length: 7 });
    expect(validateYat("otl_esm_1abc")).toMatchObject({ ok: false, reason: "not emoji" });
    expect(validateYat("🦄 rocket")).toMatchObject({ ok: false, reason: "not emoji" });
  });

  it("accepts keycaps and flags, which are emoji but not single pictographs", () => {
    expect(validateYat("1️⃣🇺🇸").ok).toBe(true);
  });
});

describe("looksLikeYat", () => {
  it("tells a name from an address", () => {
    expect(looksLikeYat("🦄🚀")).toBe(true);
    expect(looksLikeYat("otl_esm_1v3sn000000000000000000000")).toBe(false);
    expect(looksLikeYat("")).toBe(false);
    expect(looksLikeYat("🦄x")).toBe(false);
  });
});
