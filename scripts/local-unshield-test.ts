// Run this YOURSELF, locally: `npx tsx scripts/local-unshield-test.ts`
// Prompts for your mnemonic locally (never sent anywhere, never logged). Then calls the REAL
// `OotleAccount.shield()` and `OotleAccount.unshield()` production methods end-to-end against the
// live esmeralda testnet -- not a hand-rolled repro of the stealth-transfer building logic (see
// local-shield-test.ts for that kind of low-level repro). This exists because README/the
// project's history confirms shield() was verified working live, but unshield() -- which shares
// the same fixes (wasm-dedup, covenant_claims, fee bump) -- was never explicitly re-verified
// end-to-end after them.
//
// Since `OotleAccount`/`storage.ts` normally run inside a Chrome extension (chrome.storage.local
// backs the ShieldedOutputRecord ledger unshield() reads from), this installs a minimal in-memory
// stand-in for chrome.storage.local before touching any wallet code, so the exact same production
// code path runs unmodified under plain Node.
//
// Only progress messages and pass/fail are printed -- never your mnemonic, keys, or the in-memory
// store's contents.
import * as readline from "node:readline/promises";

const memoryStore: Record<string, unknown> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = {
  storage: {
    local: {
      async get(keys: string[]) {
        const result: Record<string, unknown> = {};
        for (const k of keys) if (k in memoryStore) result[k] = memoryStore[k];
        return result;
      },
      async set(patch: Record<string, unknown>) {
        Object.assign(memoryStore, patch);
      },
      async clear() {
        for (const k of Object.keys(memoryStore)) delete memoryStore[k];
      },
    },
  },
};

// Imported after the chrome shim above is installed -- storage.ts only touches chrome.storage.local
// inside async function bodies (never at module load), but keeping this order is the safe default.
const { importWalletSeed } = await import("../src/lib/cipherSeed");
const { OotleAccount } = await import("../src/lib/wallet");

const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const mnemonic = await rl.question("Mnemonic (typed here, never sent to anyone): ");
  const indexStr = await rl.question("Account index [0]: ");
  const amountStr = await rl.question("Amount to shield THEN partially unshield, in whole XTR (e.g. 2) [2]: ");
  rl.close();

  const index = indexStr.trim() === "" ? 0 : parseInt(indexStr, 10);
  const wholeXtr = amountStr.trim() === "" ? 2n : BigInt(amountStr.trim());
  const shieldAmount = wholeXtr * 1_000_000n;
  const revealAmount = shieldAmount / 2n; // leaves the other half as private remainder

  console.log("\nDeriving account locally...");
  const seed = await importWalletSeed(mnemonic);
  const account = OotleAccount.fromSeed(seed.entropy, index, "esmeralda");

  console.log(`\nStep 1/2: shield(${shieldAmount} units)...`);
  const before = await account.getBalances();
  const xtrBefore = before.find((b) => b.resourceAddress === TARI_RESOURCE_ADDRESS);
  console.log(`  confidential balance before: ${xtrBefore?.confidentialAmount ?? 0n}`);

  try {
    const { transactionId: shieldTxId } = await account.shield(TARI_RESOURCE_ADDRESS, shieldAmount);
    console.log(`  ✅ shield() succeeded, tx ${shieldTxId}`);
  } catch (e) {
    console.log(`  ❌ shield() FAILED: ${e instanceof Error ? e.message : e}`);
    console.log("\nCan't proceed to unshield without a successful shield. Stopping.");
    return;
  }

  console.log(`\nStep 2/2: unshield(${revealAmount} units revealed, ${shieldAmount - revealAmount} remains private)...`);
  try {
    const { transactionId: unshieldTxId } = await account.unshield(TARI_RESOURCE_ADDRESS, revealAmount);
    console.log(`  ✅ unshield() succeeded, tx ${unshieldTxId}`);
  } catch (e) {
    console.log(`  ❌ unshield() FAILED: ${e instanceof Error ? e.message : e}`);
    console.log("\n=== RESULT: shield OK, unshield FAILED ===");
    return;
  }

  const after = await account.getBalances();
  const xtrAfter = after.find((b) => b.resourceAddress === TARI_RESOURCE_ADDRESS);
  console.log(`\n  revealed (public) balance after:     ${xtrAfter?.amount ?? 0n}`);
  console.log(`  confidential balance after:           ${xtrAfter?.confidentialAmount ?? 0n}`);
  console.log("\n=== RESULT: shield AND unshield both succeeded live end-to-end ===");
}

main().catch((e) => {
  console.error("Script error:", e);
  process.exit(1);
});
