package mw.tari.sapient;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps Sapient's process running while the user is in another app (typically the browser a dApp is
 * open in). WalletConnect runs inside the WebView: once Android freezes a backgrounded app, a dApp's
 * request sits in the relay and a reply that was still being prepared (a transaction waiting to
 * finalize) never goes out, so the dApp just waits. A foreground service keeps the relay connection
 * and the JS alive.
 *
 * Runs only while the app is in the background with at least one dApp connected (MainActivity
 * starts it in onPause, stops it in onResume), and stops itself after {@link MAX_RUN_MS} so a
 * forgotten session can't drain the battery.
 */
public class RelayKeepAliveService extends Service {

    static final String CHANNEL_ID = "dapp_connection";
    private static final int NOTIFICATION_ID = 0x5A91;
    private static final String ACTION_STOP = "mw.tari.sapient.STOP_KEEP_ALIVE";
    private static final long MAX_RUN_MS = 30 * 60 * 1000L;

    /** Notification text, set from JS (localized) through RelayKeepAlivePlugin. */
    static volatile String title = "Sapient is connected to your dApps";
    static volatile String body = "Requests from dApps reach your wallet while you're in another app.";
    static volatile String stopLabel = "Stop";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable timeout = this::stopSelf;

    static void start(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, RelayKeepAliveService.class));
        } catch (RuntimeException e) {
            // Not allowed to start a foreground service right now (e.g. already in the background):
            // the app simply behaves as before.
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, RelayKeepAliveService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        ensureChannel();
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
        } catch (RuntimeException e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, MAX_RUN_MS);
        // If Android kills the process anyway, don't resurrect a service with no WebView behind it.
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(
            this,
            NOTIFICATION_ID + 1,
            new Intent(this, RelayKeepAliveService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_sapient_foreground)
            .setColor(0xFFA259FF)
            .setContentTitle(title)
            .setContentText(body)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(tap)
            .addAction(0, stopLabel, stop)
            .build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "dApp connection", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Sapient stays reachable for connected dApps");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(timeout);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
