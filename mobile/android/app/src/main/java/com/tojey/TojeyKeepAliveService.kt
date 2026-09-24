package com.tojey

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

// WhatsApp/Facebook-style keep-alive: a low-visibility foreground service keeps the
// process alive when the user swipes the app away or backgrounds it. On aggressive
// OEMs (OPPO/ColorOS, Xiaomi, etc.) a foreground-service app is far less likely to be
// dangling-state-killed, which is exactly when FCM messages stopped rendering.
class TojeyKeepAliveService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      startForegroundCompat()
    } catch (ignored: Exception) {
      // If the OS refuses (e.g. no POST_NOTIFICATIONS on 13+), keep going anyway.
    }
    return START_STICKY
  }

  private fun startForegroundCompat() {
    val icon = resources.getIdentifier("ic_stat_tojey", "drawable", packageName)
      .takeIf { it != 0 } ?: android.R.drawable.stat_notify_chat
    val notif = buildNotification(icon)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun buildNotification(icon: Int): Notification {
    val pi = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(CHANNEL_ID) == null) {
        val ch = NotificationChannel(
          CHANNEL_ID,
          "Message alerts",
          NotificationManager.IMPORTANCE_MIN
        )
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
      }
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    builder.setSmallIcon(icon)
      .setContentTitle("Tojey")
      .setContentText("New message alerts are on")
      .setContentIntent(pi)
      .setOngoing(true)
      .setShowWhen(false)
    @Suppress("DEPRECATION")
    builder.setPriority(Notification.PRIORITY_MIN)
    return builder.build()
  }

  override fun onDestroy() {
    super.onDestroy()
    try {
      stopForeground(true)
    } catch (ignored: Exception) {
    }
  }

  companion object {
    private const val NOTIF_ID = 9017
    private const val CHANNEL_ID = "tojey-keepalive"
  }
}