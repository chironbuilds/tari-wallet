# Patched `@tari-project/ootle` (temporary, remove once upstream releases a fix)

The published `@tari-project/ootle@0.1.0` (frozen since 2026-06-01 — see
[tari-project/ootle.ts#117](https://github.com/tari-project/ootle.ts/issues/117)) sends a
`StealthTransferStatement` missing the `covenant_claims` field, which the current protocol's
wire struct requires. Omitting it makes the whole transaction fail server-side deserialization
with a generic `"data did not match any variant of untagged enum TransactionInput"` — the
missing-field error on the deeply-nested statement isn't surfaced directly.

This is a locally-built `dist/` from `tari-project/ootle.ts`'s `main` branch (commit
`2bc5e93e`) with one line changed in `packages/ootle/src/stealth/statements.ts`:
`StealthTransferStatement.toCompactJson()` now always includes `"covenant_claims":[]` (correct
for every transfer this wallet builds, since none of them spend an input gated by a `Script`
spend condition). Built against `@tari-project/ootle-wasm@0.37.0` (via a local
`pnpm-workspace.yaml` catalog override), not the `^0.32.0` the published package pins
internally — see the same issue thread for why that version gap mattered too (a JSON wrapper
key inside stealth output witnesses renamed `spend_condition` -> `auth` between those versions).

Wired in via `pnpm-workspace.yaml`'s `overrides: '@tari-project/ootle': 'file:./vendor/ootle-patched'`
in the main project. Delete this directory and that override once
`@tari-project/ootle` publishes a release past 2026-06-01 that includes this fix (or once the
PR upstreaming this change, if one is opened, merges) — re-verify shield/unshield against
whatever version ships, since the fix here is a targeted patch, not a full upgrade to the
current protocol.
