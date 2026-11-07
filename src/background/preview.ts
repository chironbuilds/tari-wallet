// Simulates a pending dApp transaction request so the approval screen can show what it actually
// does to the signing account -- the approval summary itself never decodes instruction arguments
// (see instructionSummary.ts), so without this a site-authored transaction is signed blind.
import { getVaultIdsForAccount } from "@tari-project/ootle";
import { OotleAccount, type WalletAccountApi } from "@chironbuilder/ootle-sdk";
import type { ExecuteResult, Instruction, InstructionArg } from "@tari-project/ootle-ts-bindings";
import type { TransactionRequestOperation } from "../lib/messages";
import { decodeSubstateValue } from "../lib/bor";
import { decodeCborHex } from "../lib/cbor";
import { decodeMethodCall, knownTemplateAddresses, type DecodeContext } from "../lib/templateDecoders";

const SIMULATION_TIMEOUT_MS = 45_000;

export interface RawPreview {
  simulated: boolean;
  error?: string;
  wouldFail?: string;
  /** Net change per resource across the account's existing vaults (negative = leaves the account). */
  changes: Map<string, bigint>;
  ownAccountCalls: string[];
  /** Plain sentences for method calls on components whose template the wallet knows (see
   * templateDecoders.ts), e.g. "Buy the listed Yat for 50 XTR". Empty for everything else. */
  explained: string[];
  htlc?: { value: bigint | null; problems: string[] };
}

/** A method call's arguments as a decoder sees them: literals CBOR-decoded, workspace and blob
 * references marked as such. Throws when a literal is not CBOR this wallet reads. */
export function decodeCallArgs(args: InstructionArg[]): unknown[] {
  return args.map((a) => {
    if ("Literal" in a) return decodeCborHex(a.Literal);
    if ("Workspace" in a) return { workspace: String((a.Workspace as { id?: unknown }).id ?? a.Workspace) };
    return { blob: (a as { Blob: number }).Blob };
  });
}

/** The template address recorded in a component's own substate, or `undefined`. Read from the
 * chain, never from the request: a site cannot dress one template up as another. */
export async function templateOfComponent(account: OotleAccount, component: string): Promise<string | undefined> {
  const provider = await account.getProvider();
  const response = (await provider.getSubstate(component, null)) as { state?: { up?: { substate?: unknown } } } | undefined;
  const value = decodeSubstateValue<unknown>(response?.state?.up?.substate);
  return findTemplateAddress(value);
}

function findTemplateAddress(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.template_address === "string") return rec.template_address;
  for (const v of Object.values(rec)) {
    const found = findTemplateAddress(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * One sentence per `CallMethod` on a component whose template has registered decoders. Calls on
 * other components, unknown methods, and arguments a decoder does not recognise yield nothing.
 * `lookupTemplate` is asked once per distinct component; a lookup that throws drops that component.
 */
export async function explainCalls(
  instructions: Instruction[],
  lookupTemplate: (component: string) => Promise<string | undefined>,
  funds?: DecodeContext["funds"]
): Promise<string[]> {
  if (knownTemplateAddresses().length === 0) return [];
  const templates = new Map<string, Promise<string | undefined>>();
  const out: string[] = [];
  for (const instr of instructions) {
    if (typeof instr === "string" || !("CallMethod" in instr)) continue;
    const { call, method, args } = instr.CallMethod as { call: { Address?: string }; method: string; args: InstructionArg[] };
    if (!call?.Address) continue;
    if (!templates.has(call.Address)) templates.set(call.Address, lookupTemplate(call.Address).catch(() => undefined));
    const template = await templates.get(call.Address)!;
    if (!template) continue;
    let decodedArgs: unknown[];
    try {
      decodedArgs = decodeCallArgs(args ?? []);
    } catch {
      continue;
    }
    const explained = decodeMethodCall(template, String(method), { args: decodedArgs, funds });
    if (explained) out.push(`${explained.name}: ${explained.summary}`);
  }
  return out;
}

/** Methods a request calls on the account's own component, other than deposits into it. */
export function ownAccountCalls(instructions: Instruction[], accountComponent: string): string[] {
  const out: string[] = [];
  for (const instr of instructions) {
    if (typeof instr === "string" || !("CallMethod" in instr)) continue;
    const { call, method } = instr.CallMethod as unknown as { call: { Address?: string }; method: string };
    if (call?.Address === accountComponent && !String(method).startsWith("deposit")) out.push(String(method));
  }
  return out;
}

/** Sums `std.vault.withdraw` / `std.vault.deposit` events on the given vaults, per resource. */
export function accountBalanceChanges(result: ExecuteResult, vaultResources: Map<string, string>): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const ev of result.finalize.events) {
    const sign = ev.topic === "std.vault.withdraw" ? -1n : ev.topic === "std.vault.deposit" ? 1n : 0n;
    if (sign === 0n || !ev.substate_id) continue;
    const resource = vaultResources.get(String(ev.substate_id));
    if (!resource) continue;
    let amount: bigint;
    try {
      amount = BigInt(String((ev.payload as Record<string, unknown>).amount ?? 0));
    } catch {
      continue;
    }
    net.set(resource, (net.get(resource) ?? 0n) + sign * amount);
  }
  for (const [resource, delta] of net) if (delta === 0n) net.delete(resource);
  return net;
}

/** The engine's verdict, or undefined when it accepted the whole transaction. */
export function rejectionOf(result: ExecuteResult): string | undefined {
  const outcome = result.finalize.result as unknown;
  if (outcome && typeof outcome === "object") {
    if ("Reject" in outcome) return JSON.stringify((outcome as { Reject: unknown }).Reject).slice(0, 300);
    if ("AcceptFeeRejectRest" in outcome) return JSON.stringify((outcome as { AcceptFeeRejectRest: unknown[] }).AcceptFeeRejectRest[1]).slice(0, 300);
  }
  return undefined;
}

async function vaultResources(account: OotleAccount, component: string): Promise<Map<string, string>> {
  const provider = await account.getProvider();
  const ids = await getVaultIdsForAccount(provider, component as Parameters<typeof getVaultIdsForAccount>[1]);
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { substates } = await provider.fetchSubstates(ids);
  for (const id of ids) {
    const value = decodeSubstateValue<{ Vault?: { resource_container: Record<string, { address?: string }> } } | undefined>(substates[id]?.value);
    const address = value?.Vault ? Object.values(value.Vault.resource_container)[0]?.address : undefined;
    if (address) map.set(String(id), address);
  }
  return map;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), SIMULATION_TIMEOUT_MS))]);
}

/** `null` for operation kinds the wallet builds itself, whose approval steps already state exactly what moves. */
export async function previewOperation(account: WalletAccountApi, operation: TransactionRequestOperation): Promise<RawPreview | null> {
  const followUps =
    operation.kind === "instructions"
      ? operation.instructions
      : operation.kind === "withdrawStealthAndExecute" ||
          operation.kind === "redeemStealthOutputAndExecute" ||
          operation.kind === "redeemStealthOutputWithPrivateFee"
        ? operation.followUpInstructions
        : null;
  if (followUps === null && operation.kind !== "htlcClaim") return null;

  const empty: RawPreview = { simulated: false, changes: new Map(), ownAccountCalls: [], explained: [] };
  if (!(account instanceof OotleAccount)) {
    return { ...empty, error: "only a local account can simulate it" };
  }
  const component = await account.getComponentAddress();

  if (operation.kind === "htlcClaim") {
    try {
      const v = await withTimeout(account.verifyHtlc(operation.resourceAddress, operation.commitment, operation.conditions, {}, operation.preimageHex));
      return { ...empty, htlc: { value: v.value, problems: v.problems } };
    } catch (e) {
      return { ...empty, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const calls = ownAccountCalls(followUps!, component);
  const maxFee = operation.maxFee !== undefined ? BigInt(operation.maxFee) : undefined;
  // Independent of the simulation: a request the engine would reject is still worth putting into
  // words, and a simulation that times out should not take the explanation with it.
  let funds: DecodeContext["funds"];
  if (operation.kind === "withdrawStealthAndExecute") {
    const meta = (await account.getBalances().catch(() => []) as Array<{ resourceAddress: string; divisibility?: number; symbol?: string | null }>).find(
      (b) => b.resourceAddress === operation.resourceAddress
    );
    funds = { amount: BigInt(operation.amount), divisibility: meta?.divisibility, symbol: meta?.symbol ?? undefined };
  }
  const explained = await explainCalls(followUps!, (c) => templateOfComponent(account, c), funds).catch(() => []);
  try {
    let result: ExecuteResult;
    if (operation.kind === "instructions") {
      const res = (await withTimeout(account.execute(operation.instructions, { maxFee, dryRun: true, inputs: operation.inputs }))) as { result: ExecuteResult };
      result = res.result;
    } else if (operation.kind === "withdrawStealthAndExecute") {
      result = await withTimeout(
        account.dryRunWithdrawStealthAndExecute(
          operation.resourceAddress,
          BigInt(operation.amount),
          operation.workspaceVarName,
          operation.followUpInstructions,
          operation.relatedComponents ?? [],
          maxFee
        )
      );
    } else {
      return { ...empty, ownAccountCalls: calls, explained, error: "this kind of request can't be simulated yet" };
    }
    const changes = accountBalanceChanges(result, await vaultResources(account, component));
    return { simulated: true, wouldFail: rejectionOf(result), changes, ownAccountCalls: calls, explained };
  } catch (e) {
    return { ...empty, ownAccountCalls: calls, explained, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
