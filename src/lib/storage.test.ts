import { describe, expect, it } from "vitest";
import { daemonAccountId, localAccountId, parseAccountId } from "./storage";

describe("localAccountId / parseAccountId round-trip", () => {
  it("round-trips a local account id", () => {
    const id = localAccountId(3);
    expect(id).toBe("local:3");
    expect(parseAccountId(id)).toEqual({ type: "local", index: 3 });
  });

  it("round-trips index 0", () => {
    expect(parseAccountId(localAccountId(0))).toEqual({ type: "local", index: 0 });
  });
});

describe("daemonAccountId / parseAccountId round-trip", () => {
  it("round-trips a daemon account id", () => {
    const id = daemonAccountId("conn-1", "component_abc123");
    expect(id).toBe("daemon:conn-1:component_abc123");
    expect(parseAccountId(id)).toEqual({ type: "daemon", connectionId: "conn-1", componentAddress: "component_abc123" });
  });

  it("handles a component address that itself contains colons safely", () => {
    // Component addresses never actually contain colons, but the parser splits on the *first*
    // colon after "daemon:<connectionId>" — verifying it doesn't truncate the component address if
    // the connection id or address ever did contain one.
    const id = daemonAccountId("conn-1", "component_abc:def");
    expect(parseAccountId(id)).toEqual({ type: "daemon", connectionId: "conn-1", componentAddress: "component_abc:def" });
  });
});

describe("parseAccountId", () => {
  it("throws on a malformed id", () => {
    expect(() => parseAccountId("garbage")).toThrow("Malformed account id");
  });

  it("throws on an empty string", () => {
    expect(() => parseAccountId("")).toThrow("Malformed account id");
  });
});
