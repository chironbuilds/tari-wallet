// The published template addresses whose method calls the approval popup can explain
// (templateDecoders.ts). A template address is the hash of the template's code, so one entry
// serves every network the same build is published on.
//
// raddish (raddish.io) publishes its two Yat-market templates from yat-market/ootle-template;
// fill the addresses in from that package's README when each is published. Until then nothing is
// registered and the popup shows its generic "Call method … on component_…" line.

export const RADDISH_TEMPLATES: { yatSwap?: string; yatEscrow?: string } = {
  // yatSwap: "template_…",
  // yatEscrow: "template_…",
};
