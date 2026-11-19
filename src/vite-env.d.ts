/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Reown (WalletConnect) Cloud project id, from .env.local. Absent: the Android app runs without WalletConnect. */
  readonly VITE_REOWN_PROJECT_ID?: string;
  /** CI only: URL of scripts/ios-e2e-server.mjs; bundles the screenshot tour (src/mobile/e2e.ts). */
  readonly VITE_E2E_SHOTS?: string;
}
