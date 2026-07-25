# Patched `@tari-project/ootle-secret-key-wallet` (temporary, remove once upstream releases a fix)

The published `@tari-project/ootle-secret-key-wallet@0.1.0` has a one-line bug in its own build
config (`vite.config.js`'s `rolldownOptions.external` array): it externalizes
`@tari-project/ootle` but **not** `@tari-project/ootle-wasm`. That means Vite/rollup bundles the
entire wasm-bindgen glue and the `.wasm` module itself directly into this package's own
`dist/index.js` (confirmed: the published bundle is ~1.5MB and contains its own
`WebAssembly.instantiate`/`fetch` loading code), instead of importing the shared
`@tari-project/ootle-wasm` module the rest of the app already uses.

The practical effect: any consumer that uses **both** `@tari-project/ootle` (for `WasmStealthCrypto`,
`StealthTransfer`, etc.) **and** `@tari-project/ootle-secret-key-wallet` (for `SecretKeyWallet`,
the actual signer) — which is every real wallet built on this SDK — ends up with **two
completely separate `WebAssembly.Instance` objects** compiled from the same binary, each with
its own isolated linear memory. This was the root cause of an intermittent
`"JSON deserialization failed: data did not match any variant of untagged enum TransactionInput"`
error when signing stealth transfers specifically (plain, non-stealth signing happened to be
less sensitive to it, which is why regular sends worked fine) — see
[tari-project/ootle.ts#117](https://github.com/tari-project/ootle.ts/issues/117) for the full
investigation.

This is a locally-built `dist/` from `tari-project/ootle.ts`'s `main` branch (commit `2bc5e93e`)
with one line changed in `packages/ootle-secret-key-wallet/vite.config.js`: added
`"@tari-project/ootle-wasm"` to the `external` array (and its corresponding `output.globals`
entry), matching what `packages/ootle/vite.config.js` already correctly does. Confirmed the fix
worked: the built bundle shrank from ~1.5MB to ~4KB and no longer contains any
`WebAssembly.instantiate` calls of its own.

Wired in via `pnpm-workspace.yaml`'s
`overrides: '@tari-project/ootle-secret-key-wallet': 'file:./vendor/ootle-secret-key-wallet-patched'`
in the main project, alongside the sibling `@tari-project/ootle` patch in
`vendor/ootle-patched/` (same reasoning, same removal plan: delete both vendor directories and
overrides once upstream ships fixed releases for both packages, then re-verify shield/unshield
against whatever ships).
