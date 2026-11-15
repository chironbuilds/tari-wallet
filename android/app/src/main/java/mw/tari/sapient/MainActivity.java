package mw.tari.sapient;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BiometricVaultPlugin.class);
        registerPlugin(ApprovalNotifierPlugin.class);
        super.onCreate(savedInstanceState);
        // The wallet shows recovery phrases and balances: block screenshots, screen recording and
        // the recent-apps thumbnail. Debug builds skip it so UI tests can capture the screen.
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable) getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}
