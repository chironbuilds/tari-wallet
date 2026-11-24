import { it } from "vitest";

// Runs scripts/test-crypto.ts (CipherSeed, key-derivation and component-address golden vectors)
// under vitest rather than plain tsx: the derivation helpers now come from @chironbuilder/ootle-sdk,
// whose @tari-project/ootle >= 0.19 dependency plain Node can't load (see vitest.config.ts). The
// script throws on the first failing assertion, which fails this test.
it("crypto golden vectors", async () => {
  await import("../../scripts/test-crypto");
});
