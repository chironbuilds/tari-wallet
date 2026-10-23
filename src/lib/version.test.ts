import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./version";

describe("isNewerVersion", () => {
  it("compares numerically, not as strings", () => {
    expect(isNewerVersion("0.6.12", "0.6.9")).toBe(true);
    expect(isNewerVersion("0.6.9", "0.6.12")).toBe(false);
  });
  it("is false for the same version, so a finished update stops being offered", () => {
    expect(isNewerVersion("0.6.12", "0.6.12")).toBe(false);
    expect(isNewerVersion("0.6", "0.6.0")).toBe(false);
  });
});
