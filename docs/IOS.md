# Sapient for iOS / iPadOS

The iOS app is the same Capacitor app as Android (`src/mobile/`), in `ios/App`. Native pieces:

| File | What it does | Android counterpart |
|---|---|---|
| `ios/App/App/BiometricVaultPlugin.swift` | Face ID / Touch ID unlock: Secure Enclave P-256 key (`.biometryCurrentSet`), ECIES-encrypted unlock secret | `BiometricVaultPlugin.java` |
| `ios/App/App/ApprovalNotifierPlugin.swift` | Immediate approval notifications | `ApprovalNotifierPlugin.java` |
| `ios/App/App/SapientViewController.swift` | Registers the two plugins | `MainActivity.java` |
| `ios/App/App/SceneDelegate.swift` | Covers the wallet in the app switcher | `FLAG_SECURE` |

`Info.plist` registers the `sapient:` and `wc:` URL schemes, the camera (QR) and Face ID usage texts.

## Building (no Mac needed)

The **iOS build** GitHub Actions workflow (`.github/workflows/ios.yml`) runs on a macOS runner
on every push to the `ios` branch, on `ios-v*` tags, or by hand (Actions → iOS build → Run
workflow). It produces an **unsigned** `Sapient-<version>-unsigned.ipa` artifact.

## Installing on your own iPhone/iPad from Windows (free Apple ID)

1. Install iTunes from apple.com (not the Microsoft Store: Sideloadly needs its USB drivers) and
   [Sideloadly](https://sideloadly.io).
2. Download the `sapient-ios-unsigned` artifact from the workflow run and unzip it.
3. Connect the device by USB, drop the `.ipa` into Sideloadly, sign in with an Apple ID
   (a separate one is wiser) and Start.
4. On the device: Settings → General → VPN & Device Management → trust your Apple ID; then
   Settings → Privacy & Security → Developer Mode → On (restart).

A free Apple ID signature lasts 7 days; re-run Sideloadly to refresh (the wallet data stays).

## Later: TestFlight / App Store

Needs the Apple Developer Program. Add the distribution certificate (.p12), provisioning profile
and an App Store Connect API key as repository secrets and extend the workflow with signing and
upload.

## Known iOS differences

- iOS suspends a backgrounded app within seconds, so WalletConnect requests sent while Sapient
  is closed wait until it is opened (no push server).
- An app cannot send itself to the background: after approving a request a phone dApp sent,
  use the system "◀ Safari" link at the top left to go back.
- Screenshots cannot be blocked on iOS; the app-switcher snapshot is covered.
