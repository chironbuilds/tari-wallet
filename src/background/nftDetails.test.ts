import { describe, expect, it } from "vitest";
import { flattenNftData, nftIdCandidates } from "./nftDetails";

describe("nftDetails", () => {
  it("guesses the id type from its shape", () => {
    expect(nftIdCandidates("4d638be55185fd3b7b80b4f09147abe5")).toEqual(["str_4d638be55185fd3b7b80b4f09147abe5"]);
    expect(nftIdCandidates("7")[0]).toBe("u32_7");
    expect(nftIdCandidates("a".repeat(64))[0]).toBe(`u256_${"a".repeat(64)}`);
  });

  it("unwraps cbor tags and drops empty values", () => {
    const data = { "@cbor": "tag", tag: 129, value: { name: "Malinox Protocol", parents: "", variant: "2" } };
    expect(flattenNftData(data)).toEqual([["name", "Malinox Protocol"], ["variant", "2"]]);
  });

  it("returns nothing for non-object data", () => {
    expect(flattenNftData([])).toEqual([]);
    expect(flattenNftData(null)).toEqual([]);
  });
});
