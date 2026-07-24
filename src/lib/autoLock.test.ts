import { describe, expect, it } from "vitest";
import { AUTO_LOCK_DISABLED, formatAutoLockOption, shouldAutoLock } from "./autoLock";

describe("shouldAutoLock", () => {
  it("does not lock before the configured window has elapsed", () => {
    const last = 1_000_000;
    expect(shouldAutoLock(last, last + 4 * 60_000, 5)).toBe(false);
  });

  it("locks once the configured window has fully elapsed", () => {
    const last = 1_000_000;
    expect(shouldAutoLock(last, last + 5 * 60_000, 5)).toBe(true);
  });

  it("locks well past the window too, not just exactly at the boundary", () => {
    const last = 1_000_000;
    expect(shouldAutoLock(last, last + 60 * 60_000, 5)).toBe(true);
  });

  it("never locks when set to 0 (\"Never\"), no matter how much time has passed", () => {
    const last = 1_000_000;
    expect(shouldAutoLock(last, last + 1000 * 60_000, AUTO_LOCK_DISABLED)).toBe(false);
  });

  it("never locks on a negative configured value either (defensive, same as 0)", () => {
    const last = 1_000_000;
    expect(shouldAutoLock(last, last + 1000 * 60_000, -5)).toBe(false);
  });
});

describe("formatAutoLockOption", () => {
  it("labels 0 as Never", () => {
    expect(formatAutoLockOption(0)).toBe("Never");
  });

  it("pluralizes minutes correctly", () => {
    expect(formatAutoLockOption(1)).toBe("1 minute");
    expect(formatAutoLockOption(5)).toBe("5 minutes");
    expect(formatAutoLockOption(15)).toBe("15 minutes");
  });

  it("switches to hours at 60+ and pluralizes those too", () => {
    expect(formatAutoLockOption(60)).toBe("1 hour");
    expect(formatAutoLockOption(120)).toBe("2 hours");
  });
});
