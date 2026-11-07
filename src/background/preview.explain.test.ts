// `explainCalls` against the real literal encoders (no mocks: the point is reading real CBOR).
import { amountLiteral, resourceAddressLiteral } from "@tari-project/ootle";
import type { Instruction, InstructionArg } from "@tari-project/ootle-ts-bindings";
import { afterEach, describe, expect, it } from "vitest";
import { clearTemplateDecoders, registerRaddishTemplates } from "../lib/templateDecoders";
import { decodeCallArgs, explainCalls } from "./preview";

const SWAP_HEX = "1".repeat(64);
const SWAP = `template_${SWAP_HEX}`;
const LISTING = `component_${"a".repeat(64)}`;
const OTHER = `component_${"b".repeat(64)}`;
const XTR = `resource_${"0".repeat(63)}1`;
const WS0: InstructionArg = { Workspace: { id: 0, offset: null } as never };

const call = (component: string, method: string, args: InstructionArg[]): Instruction =>
  ({ CallMethod: { call: { Address: component }, method, args } }) as unknown as Instruction;

afterEach(() => clearTemplateDecoders());

describe("decodeCallArgs", () => {
  it("decodes literals and marks workspace and blob references", () => {
    expect(decodeCallArgs([amountLiteral(12_500_000n), resourceAddressLiteral(XTR), WS0, { Blob: 2 }])).toEqual([12_500_000, XTR, { workspace: "0" }, { blob: 2 }]);
  });
});

describe("explainCalls", () => {
  it("does nothing, and fetches nothing, while no template is registered", async () => {
    let lookups = 0;
    const out = await explainCalls([call(LISTING, "buy", [WS0])], async () => (lookups++, SWAP));
    expect(out).toEqual([]);
    expect(lookups).toBe(0);
  });

  it("puts a known template's call into words from the chain-side template address, bare hex included", async () => {
    registerRaddishTemplates({ yatSwap: SWAP });
    const lookups: string[] = [];
    const lookup = async (c: string) => (lookups.push(c), c === LISTING ? SWAP_HEX : undefined);
    const out = await explainCalls(
      [
        call(LISTING, "buy", [WS0]),
        call(OTHER, "buy", [WS0]),
        call(LISTING, "list", [amountLiteral(0n), { Workspace: { id: 1, offset: null } as never }, resourceAddressLiteral(XTR), amountLiteral(12_500_000n), { Literal: "f6" }]),
      ],
      lookup,
      { amount: 50_000_000n, divisibility: 6, symbol: "XTR" }
    );
    expect(out).toEqual([
      "raddish yat_swap: Buy the listed Yat for 50 XTR; the Yat comes back to you in this transaction.",
      "raddish yat_swap: List your Yat for sale at 12.5 XTR. The Yat leaves your account until it sells or you cancel.",
    ]);
    expect(lookups).toEqual([LISTING, OTHER]); // once per component
  });

  it("drops a call whose arguments are not CBOR it reads, and a component whose lookup throws", async () => {
    registerRaddishTemplates({ yatSwap: SWAP });
    const out = await explainCalls(
      [call(LISTING, "list", [{ Literal: "9f01ff" }]), call(OTHER, "buy", [WS0])],
      async (c) => {
        if (c === OTHER) throw new Error("indexer down");
        return SWAP;
      },
      { amount: 1n }
    );
    expect(out).toEqual([]);
  });
});
