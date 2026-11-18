import { describe, expect, it } from "vitest";
import { describeNft, flattenNftData, nftIdCandidates } from "./nftDetails";

describe("nftDetails", () => {
  it("uses a canonical id as the substate suffix", () => {
    expect(nftIdCandidates("u64_86")).toEqual(["u64_86"]);
    expect(nftIdCandidates(`uuid_${"a".repeat(64)}`)).toEqual([`uuid_${"a".repeat(64)}`]);
  });

  it("guesses the id type from a bare id's shape, spelling U256 as the engine does", () => {
    expect(nftIdCandidates("4d638be55185fd3b7b80b4f09147abe5")).toEqual(["str_4d638be55185fd3b7b80b4f09147abe5"]);
    expect(nftIdCandidates("7")[0]).toBe("u64_7");
    expect(nftIdCandidates("a".repeat(64))[0]).toBe(`uuid_${"a".repeat(64)}`);
  });

  it("unwraps cbor tags and drops empty values", () => {
    const data = { "@cbor": "tag", tag: 129, value: { name: "Malinox Protocol", parents: "", variant: "2" } };
    expect(flattenNftData(data)).toEqual([["name", "Malinox Protocol"], ["variant", "2"]]);
  });

  it("returns nothing for non-object data", () => {
    expect(flattenNftData([])).toEqual([]);
    expect(flattenNftData(null)).toEqual([]);
  });

  it("shows both the fixed and the changeable data, and finds the name", () => {
    const d = describeNft({ data: { original_minter: "abc" }, mutable_data: { name: "Sapient Test NFT", description: "Hi" } });
    expect(d.name).toBe("Sapient Test NFT");
    expect(d.attributes).toEqual([["original_minter", "abc"], ["name", "Sapient Test NFT"], ["description", "Hi"]]);
    expect(describeNft(undefined)).toEqual({ name: null, attributes: [] });
  });
});
