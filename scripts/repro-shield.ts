// Test whether OUR DERIVED key format (hash-then-reduce-mod-group-order, little-endian) --
// as opposed to a freshly wasm-generated keypair -- is what triggers the "TransactionInput"
// failure. Uses a PUBLIC, committed golden-vector key from scripts/test-crypto.ts (NOT a real
// secret) so this is safe to run and share.
import { generateKeypair, addTransactionSigner } from "@tari-project/ootle-wasm";

const REAL_JSON =
  '{"network":38,"fee_instructions":[{"CallMethod":{"call":{"Address":"component_685d150a0a5932c6669887ced345a42c1863f8825b88c58dcacde22c105407ae"},"method":"pay_fee","args":[{"Literal":"8219138800"}]}}],"instructions":[{"CallMethod":{"call":{"Address":"component_685d150a0a5932c6669887ced345a42c1863f8825b88c58dcacde22c105407ae"},"method":"withdraw","args":[{"Literal":"d88358200101010101010101010101010101010101010101010101010101010101010101"},{"Literal":"821a00a7d8c000"}]}},{"PutLastInstructionOutputOnWorkspace":{"key":0}},{"StealthTransfer":{"resource_address_ref":{"Address":"resource_0101010101010101010101010101010101010101010101010101010101010101"},"statement":{"inputs_statement":{"inputs":[],"revealed_amount":"11000000"},"outputs_statement":{"outputs":[{"output":{"commitment":"327fb1d313b625f9bb1ddfc7200b1b4e0743a9767490e6eaa8334428b9fe1d18","sender_public_nonce":"d6cd22c63d49c35ba5b712b0fd0715d95c9c02123ab780b8dfffabef232d3528","encrypted_data":"512b5065bcc61c8b942753960cae45273dd8ecfac727c739f94b551e3c72205027b51211f476c3562eee02ccfa24672e91a3a31481e88368d84b0369b4fae5b12d4f904859531a14f7fed04f66bf2ac8","minimum_value_promise":0,"viewable_balance_proof":null},"auth":{"Key":"b8d3f92568b230df98c420c13819e3255ce46efe31ce0baee792845efd7d6e0f"},"tag":1927696240}],"revealed_output_amount":"0","agg_range_proof":"018a1b26dd41ebef99281bd4dd9ed1513185cfa822a70830269b94fa2820a6ef0dacb08bbda0a0c92d445bd2324d8dbecde60ad4d1a8ade835b5bfa5242d92645bc88bff65810059896a6e7b86bf0c5cfb0e2af35aca754752a993e25c6ba71f1228d98f392b855497be115b726b047f1dd683256c6318099a935583c40f487427b97b2f05fac16b6800e7f57e9084c841c5d1a75336501f1a245c49dfe2488a0ec15f18c99717d763a0c83197cf793c17d0de30bda18c871c9a32d1216d1e370c348323f315b9a3b716828b5a732cf924719572aa91522aaf68a5305997e6cb4fdac98e03b67b94683fb7b6cba094bace0c7599a3bc68ff9119f7ddabd7b7f8116a5dfe5dd17a99ea6453dab27f5a59d9fd615f15ccde066bd6627156ee47ae4b720776962cee04362410dc2d1a4430ebde445ebbc33e4020d3e05a0ffb2de0072245ccda58cbaeb3b3f122919a29e92fe7943a1a1d141a3aa38a0de893e81847e40a6d806e3c37697d0afd673486fa06bd3081eecb4c2aa022814857577f0039ea5424eac06f617249692a84632ade8050d377797827bc6a775f617d15c32a5c9e79785c69cc0aa094253be189d70777517ed537f4e6e81727444cc5d49b3342d679db47589bcaf554587aff91b75870d903a407bf217f3a99dd2525a668bf26d65456581a7d84bd5a34ddcdd21b37ac8a24ed7b49b36ef830aec244db23830f7e58063188ab3c7576a0fb34ea2630ba0c1c0efbf3f6450e1e031d4448d57f7b1ce9f031c3c66dc4542bfdedc69d69aee848bebef8eeef52bd0fbb956e9f8038"},"covenant_claims":[],"balance_proof":{"public_nonce":"be25a1e40ab07c0ab3efe687da33593fc37d60b3c2717d0b62e572c2d6cbf857","signature":"cefdcd9b39468c9300294ce0f1588d74e736f655c4c04970b35cff38b594430e"}},"revealed_input_bucket":{"id":0,"offset":null}}}],"inputs":[{"substate_id":"component_685d150a0a5932c6669887ced345a42c1863f8825b88c58dcacde22c105407ae","version":0},{"substate_id":"vault_6868dd72ca6d27cf381e3f128cb04874f5d054207624dbafbbc9130c67798dcf","version":0}],"min_epoch":null,"max_epoch":null,"dry_run":false,"is_seal_signer_authorized":false,"blobs":[]}';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// PUBLIC golden-vector key from scripts/test-crypto.ts's cipherSeedVectors[0].account0 -- NOT a
// real secret, just a deterministic test value derived the same way our real keys are.
const GOLDEN_VECTOR_KEY_HEX = "66e5591b5dc48f82f7615dc4db2758da6ed9df4e8def7032cf052784c247000d";
const goldenKey = hexToBytes(GOLDEN_VECTOR_KEY_HEX);
console.log("golden key length:", goldenKey.length);

const sealKp = generateKeypair();

console.log("--- test 1: freshly-generated keypair (known to succeed) ---");
try {
  const kp = generateKeypair();
  const r = addTransactionSigner(REAL_JSON, kp.secret_key, sealKp.public_key);
  console.log("SUCCEEDED, length:", r.length);
} catch (e) {
  console.error("FAILED:", e);
}

console.log("--- test 2: golden-vector derived key (same derivation method as real account keys) ---");
try {
  const r = addTransactionSigner(REAL_JSON, goldenKey, sealKp.public_key);
  console.log("SUCCEEDED, length:", r.length);
} catch (e) {
  console.error("FAILED:", e);
}
