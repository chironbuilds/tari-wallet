import { beforeEach, describe, expect, it } from "vitest";
import {
  YAT_ESCROW_DECODERS,
  YAT_SWAP_DECODERS,
  decodeMethodCall,
  formatAmount,
  knownTemplateAddresses,
  registerRaddishTemplates,
  registerTemplateDecoders,
} from "./templateDecoders";

const SWAP = "template_1111111111111111111111111111111111111111111111111111111111111111";
const ESCROW = "template_2222222222222222222222222222222222222222222222222222222222222222";

describe("the registry", () => {
  beforeEach(() => registerRaddishTemplates({ yatSwap: SWAP, yatEscrow: ESCROW }));

  it("reports what it can explain, and nothing else", () => {
    expect(knownTemplateAddresses()).toEqual(expect.arrayContaining([SWAP, ESCROW]));
    expect(decodeMethodCall("template_unknown", "buy", { args: [] })).toBeUndefined();
    expect(decodeMethodCall(SWAP, "not_a_method", { args: [] })).toBeUndefined();
  });

  it("a decoder that does not recognise the arguments yields nothing, never a guess", () => {
    expect(decodeMethodCall(SWAP, "buy", { args: [{ workspace: "funds" }] })).toBeUndefined(); // no funds amount known
    expect(decodeMethodCall(SWAP, "list", { args: ["alloc", { workspace: "yat" }, "resource_x", "not-a-number"] })).toBeUndefined();
  });

  it("a decoder that throws is treated as unknown", () => {
    registerTemplateDecoders("template_throws", { name: "t", methods: { boom: () => { throw new Error("x"); } } });
    expect(decodeMethodCall("template_throws", "boom", { args: [] })).toBeUndefined();
  });
});

describe("yat_swap sentences", () => {
  it("buy and bid name the funds revealed into the call", () => {
    const funds = { amount: 50_000_000n, divisibility: 6, symbol: "XTR" };
    expect(YAT_SWAP_DECODERS.methods.buy!({ args: [{ workspace: "funds" }], funds })).toBe(
      "Buy the listed Yat for 50 XTR; the Yat comes back to you in this transaction."
    );
    expect(YAT_SWAP_DECODERS.methods.bid!({ args: [{ workspace: "funds" }], funds })).toMatch(/^Bid 50 XTR in the auction/);
  });

  it("list and auction read the price from the arguments", () => {
    expect(YAT_SWAP_DECODERS.methods.list!({ args: ["alloc", { workspace: "yat" }, "resource_x", "12500000", null] })).toMatch(/^List your Yat for sale at 12\.5 XTR/);
    expect(YAT_SWAP_DECODERS.methods.auction!({ args: ["alloc", { workspace: "yat" }, "resource_x", 1_000_000n, "100000", 42] })).toMatch(/^Put your Yat up for auction starting at 1 XTR/);
  });
});

describe("yat_escrow sentences", () => {
  it("pay states the escrow rule; new_sale names the Yat and the price", () => {
    const funds = { amount: 2_000_000n, divisibility: 6, symbol: "XTR" };
    expect(YAT_ESCROW_DECODERS.methods.pay!({ args: [{ workspace: "funds" }], funds })).toBe(
      "Pay 2 XTR into escrow. The seller is paid only after you confirm the Yat arrived."
    );
    expect(YAT_ESCROW_DECODERS.methods.new_sale!({ args: ["alloc", "😶👕👖👟", "resource_x", "otl_esm1buyer", "7500000", 10, 10] })).toBe(
      "Offer 😶👕👖👟 to one buyer for 7.5 XTR."
    );
    expect(YAT_ESCROW_DECODERS.methods.confirm_received!({ args: [] })).toMatch(/cannot be undone/);
  });
});

describe("formatAmount", () => {
  it("uses the divisibility and trims zeros", () => {
    expect(formatAmount(50_000_000n)).toBe("50 XTR");
    expect(formatAmount(12_500_000n, 6, "XTR")).toBe("12.5 XTR");
    expect(formatAmount(1n, 6, null)).toBe("0.000001");
    expect(formatAmount(-3_000_000n, 6, "XTR")).toBe("-3 XTR");
  });
});
