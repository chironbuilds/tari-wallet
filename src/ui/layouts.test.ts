import { describe, expect, it } from "vitest";
import { twoDecimals } from "./layouts";

describe("twoDecimals (Home's balance display)", () => {
  it("cuts to two decimals and never rounds up", () => {
    expect(twoDecimals("2.459624")).toBe("2.45");
    expect(twoDecimals("2.999999")).toBe("2.99");
    expect(twoDecimals("1,234.5678")).toBe("1,234.56");
  });

  it("pads to two decimals", () => {
    expect(twoDecimals("0.5")).toBe("0.50");
    expect(twoDecimals("7")).toBe("7.00");
    expect(twoDecimals("0")).toBe("0.00");
  });

  it("shows a small positive amount as < 0.01, not 0.00", () => {
    expect(twoDecimals("0.004")).toBe("< 0.01");
    expect(twoDecimals("0.000001")).toBe("< 0.01");
  });

  it("leaves anything that isn't a plain number alone", () => {
    expect(twoDecimals("—")).toBe("—");
    expect(twoDecimals("3 NFTs")).toBe("3 NFTs");
  });
});
