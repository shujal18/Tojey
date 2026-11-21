package com.tojey

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.MediaRecorder
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
import com.oney.WebRTCModule.WebRTCModuleOptions
import org.webrtc.audio.JavaAudioDeviceModule

class MainApplication : Application(), ReactApplication {

  private fun configureWebRtcAudio() {
    try {
      val builder = JavaAudioDeviceModule.builder(applicationContext)
      val builderClass = JavaAudioDeviceModule.Builder::class.java

      fun applyInt(name: String, value: Int) {
        try {
          builderClass.getMethod(name, Int::class.javaPrimitiveType).invoke(builder, value)
        } catch (ignored: Throwable) {
        }
      }

      fun applyBoolean(name: String, value: Boolean) {
        try {
          builderClass.getMethod(name, Boolean::class.javaPrimitiveType).invoke(builder, value)
        } catch (ignored: Throwable) {
        }
      }

      fun applyAttributes(name: String, value: AudioAttributes) {
        try {
          builderClass.getMethod(name, AudioAttributes::class.java).invoke(builder, value)
        } catch (ignored: Throwable) {
        }
      }

      applyInt("setAudioSource", MediaRecorder.AudioSource.VOICE_COMMUNICATION)
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      applyAttributes("setAudioAttributes", attributes)
      applyInt("setSampleRate", 48000)
      applyInt("setInputSampleRate", 48000)
      applyBoolean("setUseStereoInput", false)
      applyBoolean("setUseStereoOutput", false)
      applyBoolean("setUseHardwareAcousticEchoCanceler", true)
      applyBoolean("setUseHardwareNoiseSuppressor", true)
      applyBoolean("setUseSoftwareAcousticEchoCanceler", true)
      applyBoolean("setUseSoftwareNoiseSuppressor", true)
      WebRTCModuleOptions.getInstance().audioDeviceModule = builder.createAudioDeviceModule()
    } catch (t: Throwable) {
    }
  }

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> {
          val list = PackageList(this).packages.toMutableList()
          list.add(TojeyChatHeadPackage())
          list.add(TojeyBatteryPackage())
          list.add(TojeyPipPackage())
          list.add(TojeyBrightnessPackage())
          list.add(TojeyOrientationPackage())
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
    WebRTCModuleOptions.getInstance().enableMediaProjectionService = true
    configureWebRtcAudio()
    // Guarantee the chat notification channel exists from the very first process start
    // (API 26+). Background FCM messages are rendered by Android's system tray, and on
    // Android 8+ a notification is silently DROPPED if its channel does not exist yet.
    // Creating it natively here (instead of relying only on the JS/Notifee startup path)
    // ensures minimized notifications are never lost after a fresh install or force-stop.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        val nm = getSystemService(NotificationManager::class.java)
        val existing = nm.getNotificationChannel("tojey-messages")
        // If an OLDER build created this channel at default/low importance, Android 8+
        // will never promote it on its own and heads-up popups + sound stay silent.
        // Delete it once so it is re-created at IMPORTANCE_HIGH below.
        if (existing != null && existing.importance < NotificationManager.IMPORTANCE_HIGH) {
          try {
            nm.deleteNotificationChannel("tojey-messages")
          } catch (ignored: Exception) {
          }
        }
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
