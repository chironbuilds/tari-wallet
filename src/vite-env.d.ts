/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Reown (WalletConnect) Cloud project id, from .env.local. Absent: the Android app runs without WalletConnect. */
  readonly VITE_REOWN_PROJECT_ID?: string;
}
