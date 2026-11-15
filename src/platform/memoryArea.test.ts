import { describe, expect, it } from "vitest";
import { memoryArea } from "./memoryArea";

describe("memoryArea", () => {
  it("gets single keys, key lists, and everything", async () => {
    const area = memoryArea();
    await area.set({ a: 1, b: { x: [1, 2] } });
    expect(await area.get("a")).toEqual({ a: 1 });
    expect(await area.get(["a", "missing"])).toEqual({ a: 1 });
    expect(await area.get(null)).toEqual({ a: 1, b: { x: [1, 2] } });
    expect(await area.get()).toEqual({ a: 1, b: { x: [1, 2] } });
  });

  it("drops an explicit undefined on write, like chrome.storage", async () => {
    const area = memoryArea();
    await area.set({ a: 1 });
    await area.set({ a: undefined });
    expect(await area.get("a")).toEqual({ a: 1 });
  });

  it("returns copies, so callers can't mutate stored values", async () => {
    const area = memoryArea();
    const value = { list: [1] };
    await area.set({ v: value });
    value.list.push(2);
    const got = (await area.get("v")).v as { list: number[] };
    got.list.push(3);
    expect((await area.get("v")).v).toEqual({ list: [1] });
  });

  it("removes and clears", async () => {
    const area = memoryArea();
    await area.set({ a: 1, b: 2, c: 3 });
    await area.remove("a");
    await area.remove(["b"]);
    expect(await area.get(null)).toEqual({ c: 3 });
    await area.clear();
    expect(await area.get(null)).toEqual({});
  });
});
