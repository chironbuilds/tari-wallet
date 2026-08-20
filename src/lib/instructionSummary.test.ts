import { describe, expect, it } from "vitest";
import type { Instruction } from "@tari-project/ootle-ts-bindings";
import { summarizeArgs, summarizeInstruction } from "./instructionSummary";

const LONG_ADDR = "component_abcdef0123456789abcdef0123456789abcdef0123456789";

describe("summarizeInstruction", () => {
  it("handles the string-only DropAllProofsInWorkspace variant", () => {
    expect(summarizeInstruction("DropAllProofsInWorkspace")).toEqual({ title: "Drop all proofs" });
  });

  it("summarizes CallMethod with a plain, non-guessed target address (no CBOR decoding)", () => {
    const instr: Instruction = { CallMethod: { call: { Address: LONG_ADDR }, method: "transfer", args: [] } };
    const summary = summarizeInstruction(instr);
    expect(summary.title).toBe('Call method "transfer"');
    // Shortened, not the full raw address, and never anything derived from `args`.
    expect(summary.detail).not.toBe(`on ${LONG_ADDR}`);
    expect(summary.detail).toMatch(/^on .+….+$/);
  });

  it("summarizes CallMethod targeting a workspace value instead of a fixed address", () => {
    const instr: Instruction = { CallMethod: { call: { Workspace: 3 }, method: "deposit", args: [] } };
    expect(summarizeInstruction(instr).detail).toBe("on a value from earlier in this transaction");
  });

  it("summarizes CallFunction with the function name and template address", () => {
    const instr: Instruction = { CallFunction: { address: LONG_ADDR, function: "new", args: [] } };
    const summary = summarizeInstruction(instr);
    expect(summary.title).toBe('Call function "new"');
    expect(summary.detail).toContain("template");
  });

  it("summarizes PutIntoBucket", () => {
    const instr: Instruction = { PutIntoBucket: { src: { id: 0, offset: null }, dest: { id: 1, offset: null } } };
    expect(summarizeInstruction(instr)).toEqual({ title: "Move a value into a bucket" });
  });

  it("falls back to the raw variant name for anything not explicitly handled", () => {
    // AllocateAddress is handled, but this documents the fallback shape stays sane if the SDK
    // ever adds a new variant this function doesn't know about yet.
    const instr = { SomeFutureVariant: { foo: "bar" } } as unknown as Instruction;
    expect(summarizeInstruction(instr)).toEqual({ title: "SomeFutureVariant" });
  });
});

describe("summarizeArgs", () => {
  it("returns an empty list for instructions with no args field", () => {
    expect(summarizeArgs("DropAllProofsInWorkspace")).toEqual([]);
    expect(summarizeArgs({ CreateAccount: { owner_public_key: "x", owner_rule: null, access_rules: null, bucket_workspace_id: null } })).toEqual([]);
  });

  it("describes each arg by kind, never by decoded value", () => {
    const instr: Instruction = {
      CallMethod: {
        call: { Address: LONG_ADDR },
        method: "transfer",
        args: [{ Workspace: { id: 1, offset: null } }, { Blob: 0 }, { Literal: "deadbeef" }],
      },
    };
    expect(summarizeArgs(instr)).toEqual([
      "a value from earlier in this transaction",
      "attached data blob #0",
      "an encoded value",
    ]);
  });
});
