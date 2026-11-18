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

describe("NFT images", async () => {
  const { loadNftImage, sniffRaster, imageSourceOf } = await import("./nftDetails");
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');

  it("knows the four raster formats by their bytes, and nothing else", () => {
    expect(sniffRaster(PNG)).toBe("png");
    expect(sniffRaster(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffRaster(new TextEncoder().encode("GIF89a...."))).toBe("gif");
    expect(sniffRaster(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffRaster(new TextEncoder().encode("<svg"))).toBeNull();
    expect(sniffRaster(new TextEncoder().encode("<html>"))).toBeNull();
  });

  it("accepts an embedded raster picture, re-labelled from its bytes", async () => {
    expect(await loadNftImage(`data:image/png;base64,${b64(PNG)}`)).toBe(`data:image/png;base64,${b64(PNG)}`);
    // A PNG labelled as something else is still shown as what it is.
    expect(await loadNftImage(`data:image/gif;base64,${b64(PNG)}`)).toBe(`data:image/png;base64,${b64(PNG)}`);
  });

  it("refuses SVG and anything that isn't a raster picture, however it is labelled", async () => {
    expect(await loadNftImage(`data:image/svg+xml;base64,${svg}`)).toBeNull();
    expect(await loadNftImage(`data:image/png;base64,${svg}`)).toBeNull();
    expect(await loadNftImage("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(await loadNftImage("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
    expect(await loadNftImage("javascript:alert(1)")).toBeNull();
    expect(await loadNftImage("http://example.com/a.png")).toBeNull(); // only https
    expect(await loadNftImage("not a url")).toBeNull();
    expect(await loadNftImage(null)).toBeNull();
  });

  it("checks a downloaded picture's bytes, not the server's word", async () => {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(atob(svg), { headers: { "content-type": "image/png" } })) as typeof fetch;
      expect(await loadNftImage("https://example.com/a.png")).toBeNull();
      globalThis.fetch = (async () => new Response(PNG, { headers: { "content-type": "text/plain" } })) as typeof fetch;
      expect(await loadNftImage("https://example.com/a")).toBe(`data:image/png;base64,${b64(PNG)}`);
      globalThis.fetch = (async () => new Response(PNG, { headers: { "content-length": "9999999" } })) as typeof fetch;
      expect(await loadNftImage("https://example.com/huge.png")).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
  });

  it("finds the picture field", () => {
    expect(imageSourceOf([["name", "x"], ["image", "https://a/b.png"]])).toBe("https://a/b.png");
    expect(imageSourceOf([["Image_URL", "ipfs://cid"]])).toBe("ipfs://cid");
    expect(imageSourceOf([["name", "x"]])).toBeNull();
  });
});
