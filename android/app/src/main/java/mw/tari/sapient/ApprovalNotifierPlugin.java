package mw.tari.sapient;

import android.app.PendingIntent;
import android.content.Intent;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Posts approval notifications immediately. The generic local-notifications plugin routes even
 * "now" notifications through AlarmManager, which Android defers for a backgrounded app -- exactly
 * when an approval notification is needed. This posts straight to NotificationManager instead.
 * The channel ("approvals", private visibility) and the runtime permission are set up from JS.
 */
@CapacitorPlugin(name = "ApprovalNotifier")
public class ApprovalNotifierPlugin extends Plugin {

    private static final String CHANNEL_ID = "approvals";

    @PluginMethod
    public void show(PluginCall call) {
        Integer id = call.getInt("id");
        String title = call.getString("title", "Sapient");
        String body = call.getString("body", "");
        if (id == null) {
            call.reject("id is required", "BAD_ARGS");
            return;
        }
        NotificationManagerCompat manager = NotificationManagerCompat.from(getContext());
        if (!manager.areNotificationsEnabled()) {
            call.resolve();
            return;
        }
        Intent open = new Intent(getContext(), MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(getContext(), id, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_sapient_foreground)
            .setColor(0xFFA259FF)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // Lock screen: only "Sapient", never which dApp or what it asks.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(new NotificationCompat.Builder(getContext(), CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_sapient_foreground)
                .setColor(0xFFA259FF)
                .setContentTitle("Sapient")
                .setContentText("A request is waiting for your approval")
                .build())
            .setAutoCancel(true)
            .setContentIntent(tap);
        try {
            manager.notify(id, builder.build());
        } catch (SecurityException e) {
            // Permission revoked between the check and the post: nothing to show.
        }
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Integer id = call.getInt("id");
        if (id != null) NotificationManagerCompat.from(getContext()).cancel(id);
        call.resolve();
    }
}
