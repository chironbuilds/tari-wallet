// The active host. Defaults to the Chrome extension, created lazily on first use; the Android
// entry point calls setPlatform() before anything else runs.
import { chromePlatform } from "./chrome";
import type { Platform } from "./types";

export type { Platform, PopupResponse, StorageArea, WalletBroadcast } from "./types";

let current: Platform | null = null;

export function setPlatform(platform: Platform): void {
  current = platform;
}

export function platform(): Platform {
  return (current ??= chromePlatform());
}
