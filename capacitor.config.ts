import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "mw.tari.sapient",
  appName: "Sapient",
  webDir: "dist-mobile",
  // Capacitor's debug logging prints every plugin call's arguments and results -- including each
  // stored value Preferences returns (the encrypted vault, connected sites). Off in every build.
  loggingBehavior: "none",
  plugins: {
    // The wallet UI is always dark: light status/navigation bar icons regardless of system theme.
    SystemBars: { style: "DARK" },
  },
  // webContentsDebuggingEnabled is left unset: Capacitor then enables WebView remote debugging
  // only for debuggable (debug) builds, never for release, where it would expose the unlocked
  // wallet's JS to anyone with USB access.
};

export default config;
