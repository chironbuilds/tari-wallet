package mw.tari.sapient;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS tells native whether any dApp is connected (and the localized notification text). The service
 * itself is started and stopped by MainActivity's lifecycle, because Android only allows starting a
 * foreground service while the app is still in the foreground -- i.e. from onPause, not from a JS
 * callback that may run after the app has already gone to the background.
 */
@CapacitorPlugin(name = "RelayKeepAlive")
public class RelayKeepAlivePlugin extends Plugin {

    static volatile boolean enabled = false;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        String title = call.getString("title");
        String body = call.getString("body");
        String stop = call.getString("stopLabel");
        if (title != null) RelayKeepAliveService.title = title;
        if (body != null) RelayKeepAliveService.body = body;
        if (stop != null) RelayKeepAliveService.stopLabel = stop;
        // The last dApp disconnected while we were in the background: no reason to keep running.
        if (!enabled) RelayKeepAliveService.stop(getContext());
        call.resolve();
    }
}
