import { describe, expect, it } from "vitest";
import { isSecureDappOrigin } from "./dappOrigin";

describe("isSecureDappOrigin", () => {
  it("accepts https and loopback http", () => {
    for (const o of ["https://voting.tari.mw", "http://localhost:5173", "http://127.0.0.1:8080", "http://[::1]:3000", "http://app.localhost"]) {
      expect(isSecureDappOrigin(o)).toBe(true);
    }
  });

  it("refuses plain http elsewhere, opaque origins and other schemes", () => {
    for (const o of ["http://example.com", "http://192.168.1.5", "http://localhost.evil.com", "null", "file://", "ftp://x.com"]) {
      expect(isSecureDappOrigin(o)).toBe(false);
    }
  });

  it("accepts only well-formed WalletConnect session origins", () => {
    expect(isSecureDappOrigin("wc:" + "ab".repeat(32))).toBe(true);
    for (const o of ["wc:", "wc:abc", "wc:" + "AB".repeat(32), "wc:" + "ab".repeat(32) + "x", "wc:https://evil.com"]) {
      expect(isSecureDappOrigin(o)).toBe(false);
    }
  });
});
