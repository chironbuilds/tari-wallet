# Privacy Policy — Tari Wallet (Chrome extension)

_Last updated: 2026-07-22_

Tari Wallet is a self-custody browser extension. This policy describes what data it handles and where it goes.

## What this extension stores

Everything below is stored **only in your own browser**, using the standard Chrome extension storage API (`chrome.storage.local`). None of it is sent to any server operated by the developer of this extension — there is no backend collecting this data.

- **Your encrypted wallet vault** — your 24-word recovery phrase, encrypted with a key derived from your password (AES-256-GCM, PBKDF2 with 600,000 iterations). The extension never stores your password itself.
- **Account list and settings** — which accounts you've derived or added, which one is active, and which network (testnet) you're using.
- **Connected sites** — the list of websites you've approved to view your account address and request transaction signatures, so you don't have to reconnect every time.
- **Daemon connection details (if you use this optional feature)** — if you choose to connect this wallet to your own `tari_ootle_walletd` instance, the URL and an authentication token for that connection are stored locally so you don't have to reconnect every time. This information never leaves your device except in requests you send directly to that daemon.

## What this extension transmits, and to whom

- **The Tari Ootle network** — to read balances and submit transactions, this extension talks directly to a Tari Ootle indexer (a public node run by the Tari Project) or, if you've connected one, your own wallet daemon. These requests contain only the on-chain data needed to operate your wallet (account addresses, transaction data) — never your recovery phrase or password.
- **Websites you connect to (dApps)** — a website only ever learns your account address, and only after you explicitly approve a connection request. It can only request a transaction; every transaction still requires your explicit approval in this extension before anything is signed or submitted.
- **Nothing else.** This extension does not use analytics, telemetry, crash reporting, or any third-party tracking service. It does not use cookies. It makes no network requests other than the ones described above.

## Your recovery phrase

Your recovery phrase is generated on your device and is never transmitted anywhere, in any form, at any time. Anyone with access to your recovery phrase or your unlocked browser profile can access your funds — treat it the same way you would treat a password to your bank account.

## Uninstalling

Uninstalling the extension, or using its "Reset wallet" option, deletes all locally stored data described above. If you have not backed up your recovery phrase separately, this is unrecoverable.

## Changes to this policy

If this policy changes, the updated version will be published at this same URL with a new "Last updated" date.

## Contact

Open an issue on this project's GitHub repository for any privacy-related questions.
