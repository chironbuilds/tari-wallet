# Introduction

**Sapient** is a self-custody Chrome extension wallet for [Tari Ootle](https://github.com/tari-project/tari-ootle) (L2 — not the Minotari L1 base layer). It generates and holds its own 24-word recovery phrase, derives keys, and signs and submits transactions directly to the network — no `tari_ootle_walletd` daemon required for its own accounts. It can also connect to a running daemon and relay to it, the same "self-custody accounts + hardware-wallet-style external accounts, side by side" split MetaMask uses for Ledger.

Pages get a MetaMask-style injected provider at `window.tari` — same spirit as `window.ethereum`, not the WalletConnect relay protocol.

This book has two parts:

- **[Architecture](architecture/README.md)** — how the extension itself is built: the three browser contexts it runs in, how an account signs and submits a transaction, how private (stealth) balances and the HTLC-locked outputs built on top of them work.
- **[Integration](integration/README.md)** — how to build a dApp against it: detecting and connecting to the provider, the full RPC method reference, the transaction-request flow, and what to actually expect (errors, timing, the security model) once you're live.

If you only need one page, start with [Getting Started](integration/README.md).

> Testnet only. Under active development. Do not use it to hold real value.
