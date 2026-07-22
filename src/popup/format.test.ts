import { describe, expect, it } from "vitest";
import {
  TARI_RESOURCE_ADDRESS,
  deriveWebUiApiKeysUrl,
  formatBalanceAmount,
  isValidComponentAddress,
  normalizeDaemonUrl,
  parseDecimalToRaw,
  resourceLabel,
  shortAddr,
  tokenInitial,
} from "./format";

describe("parseDecimalToRaw", () => {
  it("parses a plain integer", () => {
    expect(parseDecimalToRaw("12", 6)).toBe(12_000_000n);
  });

  it("parses a decimal with a fractional part", () => {
    expect(parseDecimalToRaw("12.5", 6)).toBe(12_500_000n);
  });

  it("parses a leading-dot decimal", () => {
    expect(parseDecimalToRaw(".5", 6)).toBe(500_000n);
  });

  it("truncates (does not round) fractional digits beyond divisibility", () => {
    expect(parseDecimalToRaw("1.23456789", 4)).toBe(12345n);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDecimalToRaw("  3.14  ", 6)).toBe(3_140_000n);
  });

  it("handles zero divisibility", () => {
    expect(parseDecimalToRaw("5", 0)).toBe(5n);
  });

  it("rejects a second decimal point instead of silently dropping it", () => {
    // Regression test: split(".") + destructuring used to accept "1.2.3" as "1.2".
    expect(() => parseDecimalToRaw("1.2.3", 6)).toThrow("Enter a valid amount.");
  });

  it("rejects trailing garbage after digits", () => {
    expect(() => parseDecimalToRaw("1.2abc", 6)).toThrow("Enter a valid amount.");
  });

  it("rejects a bare trailing dot", () => {
    expect(() => parseDecimalToRaw("1.", 6)).toThrow("Enter a valid amount.");
  });

  it("rejects non-numeric input", () => {
    expect(() => parseDecimalToRaw("abc", 6)).toThrow("Enter a valid amount.");
  });

  it("rejects an empty string", () => {
    expect(() => parseDecimalToRaw("", 6)).toThrow("Enter an amount.");
  });

  it("rejects a whitespace-only string", () => {
    expect(() => parseDecimalToRaw("   ", 6)).toThrow("Enter an amount.");
  });

  it("rejects zero", () => {
    expect(() => parseDecimalToRaw("0", 6)).toThrow("Amount must be greater than zero.");
  });

  it("rejects zero with a decimal part", () => {
    expect(() => parseDecimalToRaw("0.0", 6)).toThrow("Amount must be greater than zero.");
  });

  it("rejects a negative sign", () => {
    expect(() => parseDecimalToRaw("-5", 6)).toThrow("Enter a valid amount.");
  });

  it("handles arbitrarily large amounts via BigInt", () => {
    expect(parseDecimalToRaw("999999999999999999999", 6)).toBe(999999999999999999999_000000n);
  });
});

describe("normalizeDaemonUrl", () => {
  it("appends /json_rpc when missing", () => {
    expect(normalizeDaemonUrl("http://127.0.0.1:5100")).toBe("http://127.0.0.1:5100/json_rpc");
  });

  it("strips a trailing slash before appending", () => {
    expect(normalizeDaemonUrl("http://127.0.0.1:5100/")).toBe("http://127.0.0.1:5100/json_rpc");
  });

  it("is idempotent when the suffix is already present", () => {
    expect(normalizeDaemonUrl("http://127.0.0.1:5100/json_rpc")).toBe("http://127.0.0.1:5100/json_rpc");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDaemonUrl("  http://localhost:5100  ")).toBe("http://localhost:5100/json_rpc");
  });

  it("accepts https", () => {
    expect(normalizeDaemonUrl("https://example.com:443")).toBe("https://example.com/json_rpc");
  });

  it("rejects garbage that isn't a URL at all", () => {
    expect(() => normalizeDaemonUrl("not a url")).toThrow("Enter a valid URL");
  });

  it("rejects non-http(s) protocols", () => {
    expect(() => normalizeDaemonUrl("ftp://example.com")).toThrow("must start with http:// or https://");
  });

  it("rejects an empty string", () => {
    expect(() => normalizeDaemonUrl("")).toThrow("Enter the daemon's URL.");
  });
});

describe("deriveWebUiApiKeysUrl", () => {
  it("points at the /api-keys route on the same origin", () => {
    expect(deriveWebUiApiKeysUrl("http://127.0.0.1:5100")).toBe("http://127.0.0.1:5100/api-keys");
  });

  it("strips a /json_rpc suffix down to the origin", () => {
    expect(deriveWebUiApiKeysUrl("http://127.0.0.1:5100/json_rpc")).toBe("http://127.0.0.1:5100/api-keys");
  });

  it("falls back to the default daemon URL when the input is empty", () => {
    expect(deriveWebUiApiKeysUrl("")).toBe("http://127.0.0.1:5100/api-keys");
  });

  it("falls back to the default daemon URL when the input isn't a valid URL yet", () => {
    expect(deriveWebUiApiKeysUrl("still typin")).toBe("http://127.0.0.1:5100/api-keys");
  });

  it("respects a custom host/port", () => {
    expect(deriveWebUiApiKeysUrl("https://example.com:8443")).toBe("https://example.com:8443/api-keys");
  });
});

describe("isValidComponentAddress", () => {
  const valid = "component_44066f512439abf4baa18bf5d357b190b631f1cc8be9bd4912ab97396ac7eb29";

  it("accepts a real 64-hex-char component address", () => {
    expect(isValidComponentAddress(valid)).toBe(true);
  });

  it("accepts uppercase hex", () => {
    expect(isValidComponentAddress(valid.toUpperCase())).toBe(true);
  });

  it("rejects a truncated address", () => {
    expect(isValidComponentAddress("component_44066f512439abf4baa18bf5d357b190b631f1c")).toBe(false);
  });

  it("rejects the wrong prefix", () => {
    expect(isValidComponentAddress(valid.replace("component_", "resource_"))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidComponentAddress(`component_${"g".repeat(64)}`)).toBe(false);
  });
});

describe("resourceLabel", () => {
  it("labels the native XTR resource specially, ignoring any symbol", () => {
    expect(resourceLabel(TARI_RESOURCE_ADDRESS, "should be ignored")).toBe("XTR");
  });

  it("uses the symbol when present", () => {
    expect(resourceLabel("resource_abc", "dUSD")).toBe("dUSD");
  });

  it("falls back to a shortened address when there is no symbol", () => {
    const address = `resource_${"a".repeat(64)}`;
    expect(resourceLabel(address, null)).toBe(shortAddr(address));
  });
});

describe("formatBalanceAmount", () => {
  it("formats a whole-number balance with no fractional part", () => {
    expect(formatBalanceAmount("1000000", 6)).toBe("1");
  });

  it("formats a fractional balance, trimming trailing zeros", () => {
    expect(formatBalanceAmount("1500000", 6)).toBe("1.5");
  });

  it("formats zero", () => {
    expect(formatBalanceAmount("0", 6)).toBe("0");
  });

  it("handles zero divisibility", () => {
    expect(formatBalanceAmount("42", 0)).toBe("42");
  });

  it("pads small fractional amounts with leading zeros", () => {
    expect(formatBalanceAmount("1", 6)).toBe("0.000001");
  });
});

describe("shortAddr", () => {
  it("leaves short strings untouched", () => {
    expect(shortAddr("abc")).toBe("abc");
  });

  it("truncates long strings with an ellipsis", () => {
    const long = "a".repeat(74);
    const result = shortAddr(long);
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(long.length);
  });
});

describe("tokenInitial", () => {
  it("uses the first letter of the resolved label, uppercased", () => {
    expect(tokenInitial("resource_abc", "dusd")).toBe("D");
  });

  it("uses X for the native XTR resource", () => {
    expect(tokenInitial(TARI_RESOURCE_ADDRESS, null)).toBe("X");
  });
});
