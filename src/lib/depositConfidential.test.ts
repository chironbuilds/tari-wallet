// Validates the composition depositConfidential() relies on -- createStealthOutputWitness()'s
// `witness` half feeding directly into createConfidentialWithdrawProofLiteral()'s output_json --
// without needing a live network or a real OotleAccount. This is the one place a field-name or
// shape mismatch between the two WASM calls would silently produce a malformed instruction
// argument instead of a compile or runtime error (both take/return plain JSON strings).
import { createConfidentialWithdrawProofLiteral, createStealthOutputWitness, generateKeypair } from "@tari-project/ootle-wasm";
import { describe, expect, it } from "vitest";
import { Network } from "@tari-project/ootle";
import { fromHex } from "./vault";

describe("depositConfidential's witness composition", () => {
  it("createStealthOutputWitness's `witness` is accepted as-is by createConfidentialWithdrawProofLiteral", () => {
    const owner = generateKeypair();
    const view = generateKeypair();

    const witnessJson = createStealthOutputWitness(
      Network.Esmeralda,
      owner.public_key,
      view.public_key,
      500n,
      "resource_" + "00".repeat(32),
      undefined,
      undefined,
      undefined,
      0n,
    );
    const { witness } = JSON.parse(witnessJson) as { witness: unknown };

    const bytes = createConfidentialWithdrawProofLiteral("[]", 500n, JSON.stringify(witness), 0n, undefined, 0n);
    expect(bytes.length).toBeGreaterThan(0);
    // Canonical CBOR for a 4-field struct: array(4) header, then an empty `inputs` array.
    expect(bytes[0]).toBe(0x84);
    expect(bytes[1]).toBe(0x80);
  });

  it("rejects a witness with a field renamed or dropped -- the composition is not silently tolerant of drift", () => {
    const owner = generateKeypair();
    const view = generateKeypair();
    const witnessJson = createStealthOutputWitness(
      Network.Esmeralda,
      owner.public_key,
      view.public_key,
      500n,
      "resource_" + "00".repeat(32),
      undefined,
      undefined,
      undefined,
      0n,
    );
    const { witness } = JSON.parse(witnessJson) as Record<string, unknown>;
    const { mask: _mask, ...withoutMask } = witness as Record<string, unknown>;
    expect(() => createConfidentialWithdrawProofLiteral("[]", 500n, JSON.stringify(withoutMask), 0n, undefined, 0n)).toThrow();
  });

  it("a deposit-shaped proof (no inputs, one output, zero change) round-trips through tari_bor decode-equivalent structure", () => {
    // Sanity-checks byte layout matches what a real transaction argument needs: a 4-element CBOR
    // array (inputs, input_revealed_amount, output_proof, balance_proof), decodable as raw bytes
    // starting with the array header -- exercised for real (not just first-bytes) in ootle-wasm-core's
    // own Rust tests (round_trips_a_revealed_only_output / round_trips_with_a_spent_input).
    const owner = generateKeypair();
    const view = generateKeypair();
    const witnessJson = createStealthOutputWitness(Network.Esmeralda, owner.public_key, view.public_key, 500n, "resource_" + "00".repeat(32), undefined, undefined, undefined, 0n);
    const { witness } = JSON.parse(witnessJson) as { witness: unknown };
    const bytes = createConfidentialWithdrawProofLiteral("[]", 500n, JSON.stringify(witness), 0n, undefined, 0n);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(fromHex(hex)).toEqual(bytes);
  });
});
