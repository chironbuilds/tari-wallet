import { describe, expect, it } from "vitest";
import { extractAddress } from "./address";

const MAIN = "otl_1czejphjcmua40mnajz00jvpzz4mrtvf7n522nks9seawdg4ep993c3d3ze3u3gj2ed06ru0wx6k5mhe7dqfm8haxyw9rx5re34h92fcgf8d3f";
const ESM = "otl_esm_1czejphjcmua40mnajz00jvpzz4mrtvf7n522nks9seawdg4ep993c3d3ze3u3gj2ed06ru0wx6k5mhe7dqfm8haxyw9rx5re34h92fcgsl652";
const COMP = "component_743e76ac8782af021788ff2d61e26edd65fc722e763cb0d7d0a8e4764ab1cf25";

describe("extractAddress", () => {
  it("accepts bare mainnet, testnet and component addresses", () => {
    expect(extractAddress(MAIN)).toBe(MAIN);
    expect(extractAddress(`  ${ESM}
`)).toBe(ESM);
    expect(extractAddress(COMP)).toBe(COMP);
  });

  it("finds an address inside a URI or a sentence", () => {
    expect(extractAddress(`tari:${MAIN}?amount=5`)).toBe(MAIN);
    expect(extractAddress(`Send to ${ESM} please`)).toBe(ESM);
  });

  it("returns null for anything else", () => {
    for (const s of ["", "hello", "otl_", "component_xyz", "wc:abc@2?symKey=00", "0x1234"]) expect(extractAddress(s)).toBeNull();
  });
});
