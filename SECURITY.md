# Security Policy

Sapient is a self-custody wallet: it holds your recovery phrase and signs transactions for you. We
take reports about anything that could put keys or funds at risk seriously, and we appreciate the
time people spend finding them.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/chironbuilds/tari-wallet/security) of this repository.
2. Click **Report a vulnerability**.
3. Fill in the form. It is visible only to you and the maintainers.

A good report includes:

- the affected platform (Chrome extension, Firefox add-on, Android, iOS) and version,
- the network (mainnet or Esmeralda),
- step-by-step reproduction, or a proof of concept,
- what an attacker gains, and what they need to already have (a malicious web page, a connected
  dApp, physical access, a compromised indexer, and so on),
- any fix you would suggest.

Please test only against your own wallets and accounts, and use Esmeralda (testnet) wherever the
bug reproduces there.

## What to expect

- We aim to acknowledge a report within **5 business days**.
- We will tell you whether we can reproduce it and how severe we think it is, and keep you updated
  while we work on a fix.
- Once a fix is released we will publish a GitHub security advisory and credit you by name or
  handle, unless you prefer to stay anonymous.
- We ask that you give us a reasonable chance to ship a fix before you disclose publicly. We will
  agree on a disclosure date with you; 90 days from the report is the default.

This is a small, independent project, so these are goals rather than guarantees.

## Rewards

**Sapient does not run a bug bounty program.** Reports are not paid by default and there is no
fixed reward schedule.

That said, a finding we rate **Critical** may be considered for a discretionary reward. Whether
to give one, and how much, is at the maintainers' sole discretion, and depends on the impact, the
quality of the report and whether it was disclosed responsibly. Reports that are duplicates,
already known, out of scope, or disclosed publicly before a fix will not be considered.

As a rough guide, we treat as Critical anything that lets an attacker, without the user knowingly
approving it:

- read or extract the recovery phrase, private keys or view keys,
- move, spend or lock the user's funds,
- get the user to sign something materially different from what the approval screen showed them,
- bypass the wallet password or PIN to sign transactions.

## Scope

In scope:

- the Sapient browser extension (Chrome and Firefox) in this repository,
- the Sapient Android and iOS apps built from this repository,
- the `window.tari` provider and the WalletConnect integration,
- how the wallet stores, encrypts and handles keys, passwords and seed phrases.

Out of scope (please report these to the right project instead):

- the Tari Ootle network, validators, indexers, templates or the `@tari-project/*` packages:
  report to the [Tari project](https://github.com/tari-project/tari-ootle/security),
- third-party dApps that integrate with Sapient,
- attacks that need an already-compromised device, browser or operating system, or physical
  access to an unlocked wallet,
- social engineering, phishing of users, or fake copies of the extension,
- denial of service through excessive traffic,
- missing best-practice headers or similar findings with no demonstrated impact,
- issues only present in old releases that are fixed in the latest one.

## Supported versions

Only the **latest release** receives security fixes. Please check that the issue still exists in
the newest version on the [releases page](https://github.com/chironbuilds/tari-wallet/releases)
before reporting.

## Safe harbor

We will not take legal action against anyone who, in good faith, finds and reports a
vulnerability in line with this policy: testing only their own wallets, not touching other
people's funds or data, not degrading the network or our services, and keeping the details private
until a fix is out.
