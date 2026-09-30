# Privacy Policy — Sapient (Chrome extension)

_Last updated: September 2026_

Sapient is a self-custody wallet: it is built to work **without** a server of ours sitting in the middle. This policy covers two separate things: the Sapient browser extension, and the website at sapient.tari.mw, since they collect different things (the extension: essentially nothing; the site: only what a static page loads by default).

## The short version

- Sapient has no backend. There is no Sapient server that ever sees your seed phrase, your keys, your balances, or your transactions.
- Your recovery phrase and derived keys are generated on-device and stored only in this browser's encrypted local storage, protected by the password you set.
- The extension talks directly to the Tari Ootle network (an indexer/validator you're connected to) and, only with your explicit approval, to sites you choose to connect a wallet account to.
- Nothing is sent to any analytics, advertising, or tracking service, whether by the extension or by the website.

## The extension

**What's generated and stored, and where:**

- A 24-word recovery phrase is generated (or imported) entirely on-device. It, and the keys derived from it, are encrypted with the password you set and stored only in this browser's local extension storage (`chrome.storage.local`), never transmitted anywhere, including to us, since there is nowhere for it to be transmitted *to*.
- Wallet metadata that isn't secret on its own (account labels, an optional address book, cached substate versions, a locally-recorded transaction history, your display-language preference, and (if you use one) a connected wallet daemon's API key) is also kept only in local extension storage. None of it leaves the browser except to the network destinations described below.
- If the extension's service worker or popup ever throws an error, that error stays in your own browser's console. Sapient does not run any crash- or usage-reporting service.

**What leaves your browser, and to whom:**

- **The Ootle network.** To check balances, resolve substates, and submit transactions, the extension talks directly to an Ootle indexer (by default a testnet indexer for the esmeralda/igor network), the same way any blockchain wallet talks to a node. That indexer sees the on-chain addresses and transactions it's serving, the same information any node operator can see for requests it handles; it is not operated by us.
- **Sites you connect to.** A web page only ever learns your wallet exists, or gets access to a specific account, after you approve a connection request in the extension's own popup, the same explicit-approval model used by other browser-extension wallets. A site you haven't connected to cannot see your accounts, balances, or activity.
- **A wallet daemon, if you choose to connect one.** Connecting to a self-hosted or third-party `tari_ootle_walletd` is optional and off by default; if you use it, requests for that account go to whatever daemon URL you configured, not to us.

The extension requests browser permissions for local storage (`storage`), its auto-lock timer (`alarms`), and network access to the hosts above, plus, only when you initiate a connection to a new site, that one site's origin (`optional_host_permissions`), granted per-site through Chrome's own permission prompt rather than assumed up front.

## The website

sapient.tari.mw is a static page with no account system, no analytics, and no advertising or tracking scripts. It sets no cookies and reads/writes nothing to your browser's storage. The one third-party request it makes is to **Google Fonts** (fonts.googleapis.com / fonts.gstatic.com) to load its typefaces. Like any site using Google Fonts, that exposes your IP address and browser's user agent to Google as part of that request. No other outbound request is made by this page.

## Data you control

Because everything sensitive lives only in this browser's local storage, you control it directly: uninstalling the extension or using its own "Erase wallet" action deletes it. There is no remote account for us to delete anything from, because none exists.

> Sapient is testnet software under active development. This policy describes the code's current behavior as accurately as we can; if you find a discrepancy, please open an issue on [GitHub](https://github.com/chironbuilds/tari-wallet).

## Changes to this policy

If Sapient's data handling changes (for example, adding an optional feature that talks to a new third party), this page will be updated to reflect it, and the "Last updated" date above will change accordingly. The canonical, always-current version is published at https://sapient.tari.mw/privacy.html.

## Contact

Open an issue on this project's GitHub repository for any privacy-related questions.
