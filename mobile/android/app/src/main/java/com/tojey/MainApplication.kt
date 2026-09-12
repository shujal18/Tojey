package com.tojey

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.RingtoneManager
import android.os.Build
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> {
          val list = PackageList(this).packages.toMutableList()
          list.add(TojeyChatHeadPackage())
          return list
        }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // Guarantee the chat notification channel exists from the very first process start
    // (API 26+). Background FCM messages are rendered by Android's system tray, and on
    // Android 8+ a notification is silently DROPPED if its channel does not exist yet.
    // Creating it natively here (instead of relying only on the JS/Notifee startup path)
    // ensures minimized notifications are never lost after a fresh install or force-stop.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel("tojey-messages") == null) {
          val ch = NotificationChannel(
            "tojey-messages",
            "Chat notifications",
            NotificationManager.IMPORTANCE_HIGH
          )
          ch.description = "New Tojey chat messages"
          ch.enableVibration(true)
          try {
            ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), null)
          } catch (ignored: Exception) {
          }
          ch.setShowBadge(true)
          ch.lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
          nm.createNotificationChannel(ch)
        }
      } catch (e: Exception) {
        // Never let a channel setup issue crash app startup.
      }
    }
    SoLoader.init(this, false)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      load()
    }
  }
}
