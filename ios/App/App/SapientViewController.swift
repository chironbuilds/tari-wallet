import UIKit
import Capacitor

/// Sapient's web view controller: Capacitor's bridge plus the app's own native plugins (the
/// Android equivalents are registered in MainActivity.java).
class SapientViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BiometricVaultPlugin())
        bridge?.registerPluginInstance(ApprovalNotifierPlugin())
    }

    // The wallet UI is always dark: light status-bar text.
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}
