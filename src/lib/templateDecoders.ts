// Readable approvals for a short list of known templates. `instructionSummary.ts` deliberately
// never decodes a method's argument bytes, because a wrong-but-plausible amount is worse than
// none. This module is the one place where decoding is allowed: an allowlist of template
// addresses, each with a hand-written, tested decoder per method, so the approval popup can say
// "Buy 😶👕👖👟 for 50 XTR; the Yat comes back in this transaction" for a template it knows, and
// keep today's "Call method buy on component_…" for everything else.
//
// A decoder sees only what the request already carries: the CBOR-decoded arguments (bor.ts) and,
// for a `withdrawStealthAndExecute` request, the amount being revealed into the call. It returns
// one plain sentence or `undefined` when the arguments are not the shape it expects, in which case
// the popup falls back to the generic summary -- a decoder never guesses.
//
// Which template a component runs is read from the chain (its substate's `template_address`) by
// the approval preview, never from the dApp's request, so a site cannot dress one template up as
// another.

export interface DecodeContext {
  /** The method's arguments, CBOR-decoded in order. A `Workspace` argument (a value from earlier in
   * the transaction, typically the bucket of funds) appears as `{ workspace: string }`. */
  args: unknown[];
  /** For `withdrawStealthAndExecute`: the amount revealed into the call, in the resource's smallest
   * unit, with the resource's divisibility and symbol when known. */
  funds?: { amount: bigint; divisibility?: number; symbol?: string | null };
}

export type MethodDecoder = (ctx: DecodeContext) => string | undefined;

export interface TemplateDecoders {
  /** A short name for the template, shown beside the sentence ("raddish yat_swap"). */
  name: string;
  methods: Record<string, MethodDecoder>;
}

const registry = new Map<string, TemplateDecoders>();

/** "template_<hex>" however the address was spelled: a substate's `template_address` is bare hex,
 * a dApp's or a README's carries the prefix. */
export function normalizeTemplateAddress(address: string): string {
  const hex = address.trim().toLowerCase().replace(/^template_/, "");
  return `template_${hex}`;
}

/** Register decoders for one template address. Later registrations replace earlier ones. */
export function registerTemplateDecoders(templateAddress: string, decoders: TemplateDecoders): void {
  registry.set(normalizeTemplateAddress(templateAddress), decoders);
}

/** Forget every registration (tests). */
export function clearTemplateDecoders(): void {
  registry.clear();
}

/** The template addresses the popup can explain -- what `tari_getCapabilities` reports as
 * `approvalDecoders`. */
export function knownTemplateAddresses(): string[] {
  return [...registry.keys()];
}

/** The sentence for one method call, or `undefined` when the template or method is unknown or the
 * arguments do not fit. */
export function decodeMethodCall(templateAddress: string, method: string, ctx: DecodeContext): { name: string; summary: string } | undefined {
  const t = registry.get(normalizeTemplateAddress(templateAddress));
  const decoder = t?.methods[method];
  if (!t || !decoder) return undefined;
  let summary: string | undefined;
  try {
    summary = decoder(ctx);
  } catch {
    return undefined;
  }
  return summary === undefined ? undefined : { name: t.name, summary };
}

/** Formats a raw amount with its divisibility, e.g. 50_000_000 at 6 -> "50". */
export function formatAmount(amount: bigint, divisibility = 6, symbol: string | null = "XTR"): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(divisibility);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(divisibility, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}${symbol ? ` ${symbol}` : ""}`;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const asBigInt = (v: unknown): bigint | undefined => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return undefined;
};
const fundsText = (ctx: DecodeContext): string | undefined =>
  ctx.funds ? formatAmount(ctx.funds.amount, ctx.funds.divisibility ?? 6, ctx.funds.symbol ?? "XTR") : undefined;

// ---- raddish's two templates (yat-market/ootle-template) ------------------------------------
// Method shapes from their READMEs; the template addresses are set once each is published, by
// `registerRaddishTemplates`. Until then nothing is registered and the popup stays generic.

/** `yat_swap`: the contract holds the Yat; a sale is one transaction. */
export const YAT_SWAP_DECODERS: TemplateDecoders = {
  name: "raddish yat_swap",
  methods: {
    // buy(payment: Bucket) -> Yat
    buy: (ctx) => {
      const funds = fundsText(ctx);
      return funds ? `Buy the listed Yat for ${funds}; the Yat comes back to you in this transaction.` : undefined;
    },
    // bid(payment: Bucket)
    bid: (ctx) => {
      const funds = fundsText(ctx);
      return funds ? `Bid ${funds} in the auction. It stays locked until you are outbid or the auction ends.` : undefined;
    },
    // list(alloc, yat: Bucket, pay_resource, price, only_buyer?)
    list: (ctx) => {
      const price = asBigInt(ctx.args[3]);
      return price !== undefined ? `List your Yat for sale at ${formatAmount(price)}. The Yat leaves your account until it sells or you cancel.` : undefined;
    },
    auction: (ctx) => {
      const start = asBigInt(ctx.args[3]);
      return start !== undefined ? `Put your Yat up for auction starting at ${formatAmount(start)}. The Yat leaves your account until it sells or you cancel.` : undefined;
    },
    withdraw_refund: () => "Take back your outbid amount.",
    close: () => "Close the auction (anyone may, once bidding has ended).",
    claim_yat: () => "Claim the Yat you won.",
    withdraw_proceeds: () => "Withdraw what your Yat sold for.",
    cancel: () => "Cancel the sale and take your Yat back.",
  },
};

/** `yat_escrow`: the money is held; the Yat moves at Yat Labs, and the buyer confirms it arrived. */
export const YAT_ESCROW_DECODERS: TemplateDecoders = {
  name: "raddish yat_escrow",
  methods: {
    post_bond: (ctx) => {
      const funds = fundsText(ctx);
      return funds ? `Post a bond of ${funds} to bid. Losers get it back; a winner who never pays loses it.` : undefined;
    },
    bid: (ctx) => {
      const amount = asBigInt(ctx.args[0]);
      return amount !== undefined ? `Bid ${formatAmount(amount)} in the auction.` : undefined;
    },
    pay: (ctx) => {
      const funds = fundsText(ctx);
      return funds ? `Pay ${funds} into escrow. The seller is paid only after you confirm the Yat arrived.` : undefined;
    },
    confirm_received: () => "Confirm the Yat arrived. This releases the payment to the seller and cannot be undone.",
    withdraw_bond: () => "Take back your bond.",
    withdraw_proceeds: () => "Withdraw the payment for your Yat.",
    seller_refund: () => "Refund the buyer. They can then claim the money back.",
    claim_refund: () => "Claim your refund from the escrow.",
    claim_default: () => "Claim the bond of a winner who never paid.",
    close: () => "Close the auction (anyone may, once bidding has ended).",
    cancel: () => "Cancel the escrow.",
    new_auction: (ctx) => {
      const yat = asString(ctx.args[1]);
      return yat ? `Open an auction for ${yat}.` : undefined;
    },
    new_sale: (ctx) => {
      const yat = asString(ctx.args[1]), price = asBigInt(ctx.args[4]);
      return yat && price !== undefined ? `Offer ${yat} to one buyer for ${formatAmount(price)}.` : undefined;
    },
  },
};

/** Call once with the published template addresses (per network) to turn the decoders on. */
export function registerRaddishTemplates(addresses: { yatSwap?: string; yatEscrow?: string }): void {
  if (addresses.yatSwap) registerTemplateDecoders(addresses.yatSwap, YAT_SWAP_DECODERS);
  if (addresses.yatEscrow) registerTemplateDecoders(addresses.yatEscrow, YAT_ESCROW_DECODERS);
}
