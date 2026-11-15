package mw.tari.sapient;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Biometric unlock for Sapient. A 256-bit AES-GCM key lives in the Android Keystore and can only
 * be used for a single operation right after a successful *strong* biometric match (the cipher is
 * handed to BiometricPrompt as a CryptoObject, so the hardware enforces it -- not a JS callback).
 * The key is invalidated when a new biometric is enrolled. The JS side encrypts the wallet's unlock
 * secret with it once (enable) and decrypts it on each biometric unlock; the secret never touches
 * disk in the clear and the key never leaves secure hardware.
 */
@CapacitorPlugin(name = "BiometricVault")
public class BiometricVaultPlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "sapient_biometric_unlock_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    /** The prompt on screen, if any, so the app can dismiss it (e.g. unlocked by password instead). */
    private BiometricPrompt activePrompt;

    private interface CipherStep {
        JSObject run(Cipher cipher) throws Exception;
    }

    @PluginMethod
    public void status(PluginCall call) {
        int code = BiometricManager.from(getContext()).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        JSObject out = new JSObject();
        out.put("available", code == BiometricManager.BIOMETRIC_SUCCESS);
        // NONE_ENROLLED (11): hardware present but nothing enrolled -- the UI can say so.
        out.put("code", code);
        out.put("hasKey", loadKey() != null);
        call.resolve(out);
    }

    /** Creates a fresh key (replacing any old one), then encrypts `secret` after a biometric match. */
    @PluginMethod
    public void encrypt(PluginCall call) {
        String secret = call.getString("secret");
        if (secret == null) {
            call.reject("secret is required", "BAD_ARGS");
            return;
        }
        try {
            SecretKey key = createKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key);
            authenticate(call, cipher, c -> {
                byte[] plain = Base64.decode(secret, Base64.NO_WRAP);
                byte[] ct = c.doFinal(plain);
                java.util.Arrays.fill(plain, (byte) 0);
                JSObject out = new JSObject();
                out.put("ciphertext", Base64.encodeToString(ct, Base64.NO_WRAP));
                out.put("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP));
                return out;
            });
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()), "ERROR");
        }
    }

    /** Decrypts a secret produced by encrypt(), after a biometric match. */
    @PluginMethod
    public void decrypt(PluginCall call) {
        String ciphertext = call.getString("ciphertext");
        String iv = call.getString("iv");
        if (ciphertext == null || iv == null) {
            call.reject("ciphertext and iv are required", "BAD_ARGS");
            return;
        }
        SecretKey key = loadKey();
        if (key == null) {
            call.reject("No biometric key on this device", "NO_KEY");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, Base64.decode(iv, Base64.NO_WRAP)));
            authenticate(call, cipher, c -> {
                JSObject out = new JSObject();
                byte[] plain = c.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP));
                out.put("secret", Base64.encodeToString(plain, Base64.NO_WRAP));
                java.util.Arrays.fill(plain, (byte) 0);
                return out;
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            // A fingerprint/face was added or removed since enabling: the key is gone for good.
            deleteKeyQuietly();
            call.reject("Biometrics on this device changed", "INVALIDATED");
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()), "ERROR");
        }
    }

    /** Dismisses the biometric prompt if one is showing; its pending call rejects as CANCELLED. */
    @PluginMethod
    public void cancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (activePrompt != null) {
                activePrompt.cancelAuthentication();
                activePrompt = null;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void deleteKey(PluginCall call) {
        deleteKeyQuietly();
        call.resolve();
    }

    private void authenticate(PluginCall call, Cipher cipher, CipherStep step) {
        String title = call.getString("title", "Unlock Sapient");
        String subtitle = call.getString("subtitle", "");
        String cancel = call.getString("cancel", "Use password");
        FragmentActivity activity = (FragmentActivity) getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setNegativeButtonText(cancel)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setConfirmationRequired(false);
            if (!subtitle.isEmpty()) info.setSubtitle(subtitle);
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(getContext()),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        activePrompt = null;
                        BiometricPrompt.CryptoObject crypto = result.getCryptoObject();
                        if (crypto == null || crypto.getCipher() == null) {
                            call.reject("No cipher after authentication", "ERROR");
                            return;
                        }
                        try {
                            call.resolve(step.run(crypto.getCipher()));
                        } catch (Exception e) {
                            call.reject(String.valueOf(e.getMessage()), "ERROR");
                        }
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence message) {
                        activePrompt = null;
                        boolean cancelled = code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                            || code == BiometricPrompt.ERROR_USER_CANCELED
                            || code == BiometricPrompt.ERROR_CANCELED;
                        boolean lockedOut = code == BiometricPrompt.ERROR_LOCKOUT || code == BiometricPrompt.ERROR_LOCKOUT_PERMANENT;
                        call.reject(message.toString(), cancelled ? "CANCELLED" : lockedOut ? "LOCKOUT" : "ERROR");
                    }
                    // onAuthenticationFailed (one non-matching attempt): the prompt stays up and
                    // lets the user retry; nothing to report yet.
                });
            activePrompt = prompt;
            prompt.authenticate(info.build(), new BiometricPrompt.CryptoObject(cipher));
        });
    }

    private SecretKey createKey() throws Exception {
        deleteKeyQuietly();
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
            KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Every use needs a fresh strong-biometric match (no time window, no device PIN).
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(spec.build());
        return generator.generateKey();
    }

    private SecretKey loadKey() {
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            return (SecretKey) ks.getKey(KEY_ALIAS, null);
        } catch (Exception e) {
            return null;
        }
    }

    private void deleteKeyQuietly() {
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // Nothing to delete.
        }
    }
}
