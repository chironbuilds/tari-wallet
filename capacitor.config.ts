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
    // Keep the native launch screen up until the first real screen has rendered (src/mobile/main.ts
    // hides it), instead of flashing an empty "Loading…" page while the wallet code starts.
    // launchFadeOutDuration 0: the splash is removed instantly when the app is ready (a fade makes
    // Android re-attach and re-centre the splash view, which shows as a visible jump); the app's own
    // rise-and-fade in src/mobile/main.ts carries the transition.
    SplashScreen: { launchAutoHide: false, launchFadeOutDuration: 0, backgroundColor: "#08060C", showSpinner: false },
    // Status-bar icon for approval notifications: the eye silhouette, tinted Sapient purple.
    LocalNotifications: { smallIcon: "ic_sapient_foreground", iconColor: "#A259FF" },
  },
  // webContentsDebuggingEnabled is left unset: Capacitor then enables WebView remote debugging
  // only for debuggable (debug) builds, never for release, where it would expose the unlocked
  // wallet's JS to anyone with USB access.
};

export default config;
