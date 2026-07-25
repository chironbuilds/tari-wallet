// Run this YOURSELF, locally: `npx tsx scripts/local-shield-test.ts`
// Prompts for your mnemonic locally (never sent anywhere, never logged). Then builds a FRESH
// stealth-transfer JSON and signs it with your REAL key, in a loop, all within the SAME process
// (same wasm module instance) -- testing whether repeated calls within one long-lived instance
// degrade over time (which would explain "always fails in the long-lived browser service worker,
// sometimes succeeds in a fresh Node process each time").
// Only progress messages and pass/fail per iteration are printed -- never your mnemonic or keys.
import * as readline from "node:readline/promises";
import { Network, OotleWallet, StealthTransfer, WalletStealthAuthorizer, WasmStealthCrypto, createOutput, serializeUnsignedTx } from "@tari-project/ootle";
import { addTransactionSigner, generateKeypair } from "@tari-project/ootle-wasm";
import { importWalletSeed } from "../src/lib/cipherSeed";
import { OotleAccount } from "../src/lib/wallet";

const TARI_RESOURCE_ADDRESS = "resource_0101010101010101010101010101010101010101010101010101010101010101";
const ITERATIONS = 15;

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const mnemonic = await rl.question("Mnemonic (typed here, never sent to anyone): ");
  const indexStr = await rl.question("Account index [0]: ");
  const amountStr = await rl.question("Amount to shield, in whole XTR (e.g. 1) [1]: ");
  rl.close();

  const index = indexStr.trim() === "" ? 0 : parseInt(indexStr, 10);
  const wholeXtr = amountStr.trim() === "" ? 1n : BigInt(amountStr.trim());
  const amount = wholeXtr * 1_000_000n;

  console.log("\nDeriving account locally...");
  const seed = await importWalletSeed(mnemonic);
  const account = OotleAccount.fromSeed(seed.entropy, index, "esmeralda");
  const componentAddress = await account.getComponentAddress();
  const provider = await account.getProvider();
  // @ts-expect-error -- local-only, never logged
  const ownerSecretKey: Uint8Array = account.signer.ownerSecretKey;
  const walletAddress = await account.getWalletAddress();

  console.log(`\nRunning ${ITERATIONS} iterations in the SAME process (same wasm instance)...\n`);
  const results: boolean[] = [];
  for (let i = 1; i <= ITERATIONS; i++) {
    try {
      const spec = await new StealthTransfer(provider, TARI_RESOURCE_ADDRESS)
        .spendRevealedInput(componentAddress, amount)
        .toStealthOutput(createOutput({ destination: walletAddress, amount, resourceAddress: TARI_RESOURCE_ADDRESS }))
        .payFeeFromRevealed(5000n)
        .prepare();
      const wallet = new OotleWallet().registerKeyProvider(componentAddress, account.signer).setDefaultSigner(componentAddress);
      const authorized = await WalletStealthAuthorizer.fromSpec(wallet, spec, { crypto: new WasmStealthCrypto(Network.Esmeralda) }).prepare(
        provider
      );
      const json = serializeUnsignedTx(authorized.getSpec().unsignedTx);
      const sealKp = generateKeypair();
      addTransactionSigner(json, ownerSecretKey, sealKp.public_key);
      console.log(`  [${i}/${ITERATIONS}] ✅ SUCCESS`);
      results.push(true);
    } catch (e) {
      console.log(`  [${i}/${ITERATIONS}] ❌ FAIL: ${e instanceof Error ? e.message : e}`);
      results.push(false);
    }
  }

  const successCount = results.filter(Boolean).length;
  console.log(`\n=== Summary: ${successCount}/${ITERATIONS} succeeded ===`);
  console.log("Pattern (S=success, F=fail):", results.map((r) => (r ? "S" : "F")).join(""));
}

main().catch((e) => {
  console.error("Script error:", e);
  process.exit(1);
});
