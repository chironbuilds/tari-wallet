import { describe, expect, it } from "vitest";
import { extractMissingSubstateAddress, extractStaleLockVersion } from "./wallet";

describe("extractMissingSubstateAddress", () => {
  it("matches a plain call-target miss (address before 'not found')", () => {
    expect(extractMissingSubstateAddress("At instruction #1: component_44066f512439abf4baa18bf5d357b190b631f1cc8be9bd4912ab97396ac7eb29 not found")).toBe(
      "component_44066f512439abf4baa18bf5d357b190b631f1cc8be9bd4912ab97396ac7eb29"
    );
  });

  it("matches a template-internal reference (address after 'not found:')", () => {
    expect(
      extractMissingSubstateAddress("Template referenced substate but it was not found: resource_e9b9309fad4f89800d0ddf12c7754edeeb4bafa5418013a4c70a51cce26af8e7")
    ).toBe("resource_e9b9309fad4f89800d0ddf12c7754edeeb4bafa5418013a4c70a51cce26af8e7");
  });

  it("matches a quoted cross-template-call miss", () => {
    expect(
      extractMissingSubstateAddress(
        "Cross-template call failed for method 'swap' on component 'component_f61cab40bca62ba3e98ff9b4d64d3dacb4d390bc41ff526d01e0ad94b148ba41': Substate 'component_f61cab40bca62ba3e98ff9b4d64d3dacb4d390bc41ff526d01e0ad94b148ba41' not found or is not a transaction input"
      )
    ).toBe("component_f61cab40bca62ba3e98ff9b4d64d3dacb4d390bc41ff526d01e0ad94b148ba41");
  });

  it("returns null for a message with no recognizable missing-substate pattern", () => {
    expect(extractMissingSubstateAddress("Some unrelated error message")).toBeNull();
  });

  it("returns null for an unrelated rejection reason", () => {
    expect(extractMissingSubstateAddress("InsufficientFeesPaid: not enough balance")).toBeNull();
  });
});

describe("extractStaleLockVersion", () => {
  it("extracts the substate id and version from a lock-failure message", () => {
    expect(extractStaleLockVersion("Lock failure: Substate vault_44032dd6cfe5c099cb3de86b9a2341271f23a7c670f472cee08475117f42c6aa:8 is DOWN")).toEqual({
      substateId: "vault_44032dd6cfe5c099cb3de86b9a2341271f23a7c670f472cee08475117f42c6aa",
      version: 8,
    });
  });

  it("returns null when the message doesn't match the lock-failure shape", () => {
    expect(extractStaleLockVersion("Some other error")).toBeNull();
  });

  it("returns null for a lock failure message missing the version number", () => {
    expect(extractStaleLockVersion("Substate vault_44032dd6cfe5c099cb3de86b9a2341271f23a7c670f472cee08475117f42c6aa is DOWN")).toBeNull();
  });
});
