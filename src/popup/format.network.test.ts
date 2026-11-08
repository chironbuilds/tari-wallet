import { describe, expect, it } from "vitest";
import { isOotleWalletAddressOn, isValidOotleWalletAddress, networkOfOotleWalletAddress } from "./format";

// Real addresses, one per network (tari-ootle hrp.rs: "otl_" mainnet, "otl_esm_" Esmeralda,
// "otl_igr_" Igor), produced by ootle-wasm for the SDK's ownership-proof vectors.
const ESME = "otl_esm_1krg63v0jxsh0jms30qsev6sdt5mzm92uyx6d334a9ehyqfu37alhpjs59lkrcvp924dpafxl98lhde79had2f9fgp4vs3r8szp7x79cgc6jgc";
const IGOR = "otl_igr_17mz62pkftmspfu40ka99y4u3ksk2utgux0ye4rwskccrjaegpg6g4udmnsspksdvrmym68cjz8vrqml3gnqqc2m6estezap0stvfz0qjswh3r";
const MAIN = "otl_1aj4kgg35qjl2uvarlhthsuf48texw7xcw5wkg2wwn2t3l4czwuteugfkxteg2ul4af40l8a7uz5ksphwg4w5f6qd2efj9amfg6r5w7qny6m8w";

describe("Ootle wallet addresses across networks", () => {
  it("accepts mainnet's untagged prefix as well as the testnet ones", () => {
    expect(isValidOotleWalletAddress(MAIN)).toBe(true);
    expect(isValidOotleWalletAddress(ESME)).toBe(true);
    expect(isValidOotleWalletAddress(IGOR)).toBe(true);
    expect(isValidOotleWalletAddress(`  ${ESME}  `)).toBe(true);
  });

  it("refuses shapes that aren't addresses", () => {
    expect(isValidOotleWalletAddress("otl_esm_short")).toBe(false);
    expect(isValidOotleWalletAddress("component_" + "a".repeat(64))).toBe(false);
    expect(isValidOotleWalletAddress("otl_esm_" + "x".repeat(40))).toBe(false); // no bech32 "1" separator
  });

  it("reads the network from the prefix", () => {
    expect(networkOfOotleWalletAddress(MAIN)).toBe("mainnet");
    expect(networkOfOotleWalletAddress(ESME)).toBe("esmeralda");
    expect(networkOfOotleWalletAddress(IGOR)).toBe("igor");
    expect(networkOfOotleWalletAddress("otl_loc_1" + "q".repeat(40))).toBeUndefined();
    expect(networkOfOotleWalletAddress("nonsense")).toBeUndefined();
  });

  it("only treats an address on the wallet's own network as sendable", () => {
    expect(isOotleWalletAddressOn(MAIN, "mainnet")).toBe(true);
    expect(isOotleWalletAddressOn(ESME, "mainnet")).toBe(false);
    expect(isOotleWalletAddressOn(MAIN, "esmeralda")).toBe(false);
    expect(isOotleWalletAddressOn(ESME, "esmeralda")).toBe(true);
  });
});
