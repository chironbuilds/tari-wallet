package mw.tari.sapient;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Edge-to-edge from the very first frame. Otherwise the system-bars plugin switches the
        // window to edge-to-edge midway through the launch screen, and Android re-centres the splash
        // icon (a visible ~40px drop). The web UI already pads itself with the safe-area insets.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        registerPlugin(BiometricVaultPlugin.class);
        registerPlugin(ApprovalNotifierPlugin.class);
        super.onCreate(savedInstanceState);
        // The wallet shows recovery phrases and balances: block screenshots, screen recording and
        // the recent-apps thumbnail. Debug builds skip it so UI tests can capture the screen.
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable) getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}
