/**
 * Whether this account can send NFTs of a collection, read from the chain before Send is offered.
 *
 * A collection decides who may move its tokens through its resource access rules: `withdraw` (out of
 * the holder's vault) and `deposit` (into the recipient's), and optionally an `auth_hook` contract
 * that approves each transfer. A holder's own vault can also be frozen (`freeze_flags`). Anything
 * other than "allow all" with no hook is treated as not sendable from here: a restricted rule needs a
 * proof this wallet doesn't hold, and a hook's answer can't be known in advance, so offering Send would
 * only lead to a rejected transaction.
 */

export type NftSendability = { canSend: true } | { canSend: false; reason: "rules" | "frozen" | "unknown" };

/** The decoded `Resource` substate fields this looks at. */
export interface ResourceRules {
  access_rules?: { withdraw?: unknown; deposit?: unknown };
  auth_hook?: unknown;
}

/** The decoded `Vault` substate fields this looks at. */
export interface VaultState {
  freeze_flags?: unknown;
}

export function nftSendability(resource: ResourceRules | undefined, vault: VaultState | undefined): NftSendability {
  const rules = resource?.access_rules;
  if (!rules) return { canSend: false, reason: "unknown" };
  if (rules.withdraw !== "AllowAll" || rules.deposit !== "AllowAll") return { canSend: false, reason: "rules" };
  if (resource.auth_hook !== null && resource.auth_hook !== undefined) return { canSend: false, reason: "rules" };
  const flags = vault?.freeze_flags;
  if (flags !== undefined && flags !== null && flags !== 0 && flags !== "0") return { canSend: false, reason: "frozen" };
  return { canSend: true };
}
