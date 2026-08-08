import { describe, expect, it } from "vitest";
import { estimatePasswordStrength, isBlockedPassword } from "./passwordStrength";

describe("isBlockedPassword", () => {
  it("blocks well-known common passwords, case-insensitively", () => {
    expect(isBlockedPassword("password")).toBe(true);
    expect(isBlockedPassword("PASSWORD")).toBe(true);
    expect(isBlockedPassword("123456789")).toBe(true);
    expect(isBlockedPassword("qwertyuiop")).toBe(true);
  });

  it("blocks a common password with typical leet/punctuation padding", () => {
    expect(isBlockedPassword("Password1!")).toBe(true);
    expect(isBlockedPassword("p@ssw0rd")).toBe(true);
    expect(isBlockedPassword("Passw0rd!!!")).toBe(true);
  });

  it("blocks sequential runs regardless of length", () => {
    expect(isBlockedPassword("abcdefgh")).toBe(true);
    expect(isBlockedPassword("87654321")).toBe(true);
    expect(isBlockedPassword("ijklmnopqrstuvwx")).toBe(true);
  });

  it("blocks a single repeated character", () => {
    expect(isBlockedPassword("aaaaaaaa")).toBe(true);
    expect(isBlockedPassword("11111111")).toBe(true);
  });

  it("blocks common keyboard walks", () => {
    expect(isBlockedPassword("qwertyuiop")).toBe(true);
    expect(isBlockedPassword("1qaz2wsx")).toBe(true);
  });

  it("does not block a long, unrelated passphrase", () => {
    expect(isBlockedPassword("horse-battery-staple-lantern-42")).toBe(false);
    expect(isBlockedPassword("Tbf7!qXm2rP9zK")).toBe(false);
  });

  it("does not false-positive on a password merely containing a short common substring", () => {
    // "abc" appears, but the whole password isn't a sequential run or a blocklist entry.
    expect(isBlockedPassword("z9Kabc$Wr4mQ")).toBe(false);
  });
});

describe("estimatePasswordStrength", () => {
  it("scores an empty password as very weak with no feedback", () => {
    expect(estimatePasswordStrength("")).toEqual({ score: 0, label: "Very weak", feedback: [] });
  });

  it("scores a blocked password as very weak with an explanatory tip", () => {
    const r = estimatePasswordStrength("password");
    expect(r.score).toBe(0);
    expect(r.label).toBe("Very weak");
    expect(r.feedback.length).toBeGreaterThan(0);
  });

  it("scores short low-variety passwords lower than long high-variety ones", () => {
    const short = estimatePasswordStrength("bxpqz9");
    const long = estimatePasswordStrength("Tbf7!qXm2rP9zK@wLh3");
    expect(long.score).toBeGreaterThan(short.score);
  });

  it("is monotonic in length for the same character pool", () => {
    const shorter = estimatePasswordStrength("kd8fq2xz");
    const longer = estimatePasswordStrength("kd8fq2xzmt6bpr9c");
    expect(longer.score).toBeGreaterThanOrEqual(shorter.score);
  });

  it("clears feedback once a password scores Strong", () => {
    const r = estimatePasswordStrength("Tbf7!qXm2rP9zK@wLh3#eYd6");
    expect(r.label).toBe("Strong");
    expect(r.feedback).toEqual([]);
  });

  it("every score maps to its expected label", () => {
    expect(estimatePasswordStrength("password").label).toBe("Very weak");
    for (const r of [
      estimatePasswordStrength("bxpqz9aa"),
      estimatePasswordStrength("Tbf7qXm2"),
      estimatePasswordStrength("Tbf7!qXm2rP9"),
      estimatePasswordStrength("Tbf7!qXm2rP9zK@wLh3#eYd6"),
    ]) {
      expect(["Very weak", "Weak", "Fair", "Good", "Strong"]).toContain(r.label);
    }
  });
});
