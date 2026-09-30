# Chrome Web Store listing draft

## Short description (max 132 characters)

Sapient: a self-custody wallet for Tari Ootle. Your seed never leaves your device — no wallet daemon required.

(110 characters)

## Detailed description

**Sapient** is a self-custody browser extension wallet for [Tari Ootle](https://github.com/tari-project/tari-ootle) — Tari's second-layer smart-contract network.

Your recovery phrase is generated and encrypted on your own device. It is never sent anywhere, and by default this extension talks directly to the Tari Ootle network — no wallet daemon required.

**Features:**
- Create a new wallet or import an existing 24-word recovery phrase
- Multiple accounts per wallet, switchable at any time
- Send and receive any token on Tari Ootle
- Claim free testnet TARI from the network's built-in faucet
- Connect to websites (dApps) with a MetaMask-style approval flow — every connection request and every transaction requires your explicit sign-off
- Optionally connect to your own running `tari_ootle_walletd` daemon as an additional account type, alongside your self-custody accounts — similar to how a hardware wallet coexists with regular accounts in other wallets
- Token balances shown with real on-chain decimal precision and names, not guessed values
- Full English and Chinese (中文) interface, switchable anytime from Settings — every screen, including dApp approval prompts

**Security model:**
- Your recovery phrase is encrypted with your password (AES-256-GCM, PBKDF2 with 600,000 iterations) and stored only in this browser
- Nothing is transmitted to any server operated by the developer of this extension — there is no backend
- Every transaction is shown to you in full before you approve it
- This extension currently targets the Tari Ootle testnet

**Currently testnet-only.** This wallet is under active development. Use it to explore Tari Ootle, not to hold real value.

## Category

Productivity → (or Google's specific "Cryptocurrency" sub-classification if offered during submission)

## Permission justifications (for the review questionnaire)

- `storage` — stores your encrypted wallet vault, account list, and settings locally in the browser; nothing leaves the device through this permission.
- `alarms` — drives the auto-lock timer (locks the wallet after your chosen period of inactivity). Not used for anything else.
- `host_permissions` for the Tari indexer domain — needed to read on-chain balances and submit transactions directly to the Tari Ootle network.
- `host_permissions` for `localhost`/`127.0.0.1` — needed only if you choose to connect this wallet to your own locally-running `tari_ootle_walletd` daemon (an optional feature). Not used otherwise.
- `optional_host_permissions` (any site, granted per-site) — requested only when you initiate a connection to a new `tari_ootle_walletd` daemon that isn't on localhost, through Chrome's own permission prompt at that moment, never assumed up front.
- Content scripts injected on all `http(s)` pages — needed to provide the `window.tari` provider (the same MetaMask-style pattern every browser-extension crypto wallet uses) so any Tari Ootle dApp can detect the wallet and request a connection. The injected script cannot read or modify page content beyond relaying wallet requests/responses; it has no access to your seed, keys, or password, which never leave the background service worker.
