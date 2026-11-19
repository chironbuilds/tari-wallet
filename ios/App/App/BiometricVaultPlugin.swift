import Foundation
import LocalAuthentication
import Security
import Capacitor

/// Biometric unlock for Sapient on iOS (BiometricVaultPlugin.java on Android; same JS contract,
/// see src/mobile/biometric.ts).
///
/// A P-256 key is generated inside the Secure Enclave with an access control of
/// `.privateKeyUsage + .biometryCurrentSet`: the private key never leaves the enclave, and the
/// enclave only uses it right after a Face ID / Touch ID match of the *currently enrolled*
/// biometrics -- enrolling another face or finger invalidates it for good. The wallet's unlock
/// secret is encrypted to that key with ECIES (X9.63-SHA256 + AES-GCM) and only decrypts after a
/// match. The device passcode is deliberately not accepted as a fallback.
@objc(BiometricVaultPlugin)
public class BiometricVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BiometricVaultPlugin"
    public let jsName = "BiometricVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "encrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "decrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private static let tag = "mw.tari.sapient.biometric-unlock.v1".data(using: .utf8)!
    private static let algorithm: SecKeyAlgorithm = .eciesEncryptionCofactorVariableIVX963SHA256AESGCM

    /// The authentication in progress, if any, so the app can dismiss it (unlocked by password).
    private var activeContext: LAContext?

    @objc func status(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        // Mirror Android's BiometricManager codes where it matters: 11 = nothing enrolled.
        var code = available ? 0 : 1
        if let e = error, e.code == LAError.biometryNotEnrolled.rawValue { code = 11 }
        call.resolve(["available": available, "code": code, "hasKey": Self.loadKey(context: nil) != nil])
    }

    /// Creates a fresh enclave key (replacing any old one), then encrypts `secret` after a match.
    @objc func encrypt(_ call: CAPPluginCall) {
        guard let secret = call.getString("secret"), let plain = Data(base64Encoded: secret) else {
            call.reject("secret is required", "BAD_ARGS")
            return
        }
        // Prove a biometric match first, like the Android prompt on enable; then create the key.
        let context = LAContext()
        context.localizedCancelTitle = call.getString("cancel", "Use password")
        activeContext = context
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason(call)) { ok, error in
            self.activeContext = nil
            guard ok else {
                self.rejectAuth(call, error)
                return
            }
            do {
                let key = try Self.createKey()
                guard let publicKey = SecKeyCopyPublicKey(key) else {
                    call.reject("No public key", "ERROR")
                    return
                }
                var cfError: Unmanaged<CFError>?
                guard let ct = SecKeyCreateEncryptedData(publicKey, Self.algorithm, plain as CFData, &cfError) as Data? else {
                    call.reject(cfError?.takeRetainedValue().localizedDescription ?? "Encryption failed", "ERROR")
                    return
                }
                // ECIES carries its own ephemeral key and nonce; `iv` is kept for the shared JS contract.
                call.resolve(["ciphertext": ct.base64EncodedString(), "iv": ""])
            } catch {
                call.reject(error.localizedDescription, "ERROR")
            }
        }
    }

    /// Decrypts a secret produced by encrypt(), after a biometric match.
    @objc func decrypt(_ call: CAPPluginCall) {
        guard let b64 = call.getString("ciphertext"), let ct = Data(base64Encoded: b64) else {
            call.reject("ciphertext is required", "BAD_ARGS")
            return
        }
        let context = LAContext()
        context.localizedCancelTitle = call.getString("cancel", "Use password")
        context.localizedReason = reason(call)
        guard let key = Self.loadKey(context: context) else {
            // Gone, or invalidated by a biometric enrollment change (.biometryCurrentSet).
            call.reject("No biometric key on this device", "NO_KEY")
            return
        }
        activeContext = context
        // SecKeyCreateDecryptedData shows the Face ID / Touch ID sheet; keep it off the main thread.
        DispatchQueue.global(qos: .userInitiated).async {
            var cfError: Unmanaged<CFError>?
            let plain = SecKeyCreateDecryptedData(key, Self.algorithm, ct as CFData, &cfError) as Data?
            self.activeContext = nil
            guard var plain = plain else {
                self.rejectAuth(call, cfError?.takeRetainedValue() as Error?)
                return
            }
            call.resolve(["secret": plain.base64EncodedString()])
            plain.resetBytes(in: 0..<plain.count)
        }
    }

    /// Dismisses the biometric sheet if one is showing; its pending call rejects as CANCELLED.
    @objc func cancel(_ call: CAPPluginCall) {
        activeContext?.invalidate()
        activeContext = nil
        call.resolve()
    }

    @objc func deleteKey(_ call: CAPPluginCall) {
        Self.deleteKeyQuietly()
        call.resolve()
    }

    private func reason(_ call: CAPPluginCall) -> String {
        let title = call.getString("title", "Unlock Sapient")
        let subtitle = call.getString("subtitle", "")
        return subtitle.isEmpty ? title : "\(title). \(subtitle)"
    }

    private func rejectAuth(_ call: CAPPluginCall, _ error: Error?) {
        let ns = error as NSError?
        let message = ns?.localizedDescription ?? "Authentication failed"
        if let ns = ns, ns.domain == LAErrorDomain {
            switch LAError.Code(rawValue: ns.code) {
            case .userCancel, .userFallback, .systemCancel, .appCancel, .invalidContext:
                call.reject(message, "CANCELLED")
            case .biometryLockout:
                call.reject(message, "LOCKOUT")
            default:
                call.reject(message, "ERROR")
            }
            return
        }
        if ns?.code == Int(errSecUserCanceled) {
            call.reject(message, "CANCELLED")
        } else if ns?.code == Int(errSecItemNotFound) || ns?.code == Int(errSecInvalidKeyRef) {
            Self.deleteKeyQuietly()
            call.reject("Biometrics on this device changed", "INVALIDATED")
        } else {
            call.reject(message, "ERROR")
        }
    }

    private static func createKey() throws -> SecKey {
        deleteKeyQuietly()
        var acError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet],
            &acError
        ) else {
            throw acError!.takeRetainedValue() as Error
        }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag,
                kSecAttrAccessControl as String: access,
            ],
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw error!.takeRetainedValue() as Error
        }
        return key
    }

    /// The enclave key reference. Fetching the reference never prompts; using it does.
    private static func loadKey(context: LAContext?) -> SecKey? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
        ]
        if let context = context { query[kSecUseAuthenticationContext as String] = context }
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item = item else { return nil }
        return (item as! SecKey)
    }

    private static func deleteKeyQuietly() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
