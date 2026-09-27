package com.tojey

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground keep-alive service. While it runs the OS (stock Doze AND OEM battery
 * killers like OPPO/ColorOS, MIUI, EMUI) is far less likely to cull the app process,
 * so the Socket.IO connection stays up and every message is delivered INSTANTLY over
 * the socket on every device - no Google Play Services / FCM / OEM cooperation needed.
 *
 * The ongoing tray entry uses its own low-importance, silent channel so it never
 * disturbs the user with sound/vibration and can be disabled independently in Settings.
 * FCM remains the backstop for force-stop / airplane mode / the harshest OEM freezes.
 */
class TojeyKeepAliveService : Service() {

  override fun onBind(intent: Intent): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "STOP") {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      ensureChannel(applicationContext)
      startForeground(NOTIF_ID, buildNotification())
      android.util.Log.w("TojeyKeepAlive", "foreground service active")
    } catch (e: Exception) {
      android.util.Log.w("TojeyKeepAlive", "startForeground failed", e)
    }
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    val pi = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_tojey)
      .setColor(resources.getColor(R.color.tojey_notification, null))
      .setContentTitle("Tojey")
      .setContentText("Notifications active")
      .setOngoing(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(pi)
    return builder.build()
  }

  companion object {
    const val CHANNEL_ID = "tojey-keepalive"
    const val CHANNEL_NAME = "Tojey connection"
    const val ACTION_STOP = "com.tojey.keeplive.STOP"
    private const val NOTIF_ID = 7193
    @Volatile var running: Boolean = false
      private set

    // Called from MainApplication.onCreate so the channel exists before the service is
    // ever started (API 26+: startForeground drops the notification if no channel).
    fun ensureChannel(context: android.content.Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      try {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
          val ch = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
          )
          ch.description = "Keeps Tojey connected so messages arrive instantly"
          ch.enableVibration(false)
          ch.setShowBadge(false)
          nm.createNotificationChannel(ch)
        }
      } catch (e: Exception) {
      }
    }
  }
}