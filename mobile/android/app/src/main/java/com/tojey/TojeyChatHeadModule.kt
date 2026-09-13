package com.tojey

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.net.Uri

class TojeyChatHeadModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TojeyChatHead"

  @ReactMethod
  fun canDrawOverlay(promise: com.facebook.react.bridge.Promise) {
    val ctx = reactContext
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      promise.resolve(true)
      return
    }
    var can = try { Settings.canDrawOverlays(ctx) } catch (ignored: Exception) { false }
    if (!can) {
      can = try {
        ctx.packageManager.checkPermission(
          android.Manifest.permission.SYSTEM_ALERT_WINDOW,
          ctx.packageName
        ) == PackageManager.PERMISSION_GRANTED
      } catch (ignored: Exception) {
        false
      }
    }
    if (!can) {
      can = try {
        val appOps = ctx.getSystemService(android.content.Context.APP_OPS_SERVICE) as android.app.AppOpsManager
        @Suppress("DEPRECATION")
        appOps.checkOpNoThrow(
          android.app.AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW,
          android.os.Process.myUid(),
          ctx.packageName
        ) == android.app.AppOpsManager.MODE_ALLOWED
      } catch (ignored: Exception) {
        false
      }
    }
    android.util.Log.w("TojeyChatHead", "canDrawOverlay=$can pkg=${ctx.packageName}")
    promise.resolve(can)
  }

  @ReactMethod
  fun openOverlaySettings() {
    try {
      val i = Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.parse("package:" + reactContext.packageName)
      )
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(i)
    } catch (e: Exception) {
    }
  }

  @ReactMethod
  fun showChatHead(avatar: String, name: String, unread: Int) {
    try {
      val s = Intent(reactContext, ChatHeadService::class.java)
      s.action = "SHOW"
      s.putExtra("avatar", avatar)
      s.putExtra("name", name)
      s.putExtra("unread", unread)
      reactContext.startService(s)
    } catch (e: Exception) {
    }
  }

  @ReactMethod
  fun hideChatHead() {
    try {
      val s = Intent(reactContext, ChatHeadService::class.java)
      s.action = "HIDE"
      reactContext.startService(s)
    } catch (e: Exception) {
    }
  }

  @ReactMethod
  fun vibrate(patternStr: String) {
    val run = Runnable {
      try {
        var pattern: LongArray?
        pattern = try {
          val parts = patternStr.split(",")
          LongArray(parts.size) { parts[it].trim().toLong() }
        } catch (e: Exception) {
          null
        }
        if (pattern == null || pattern.size < 1) {
          pattern = longArrayOf(0, 350, 120, 350, 120, 350)
        }
        val vib: Vibrator? = if (Build.VERSION.SDK_INT >= 31) {
          val vm = reactContext.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
          vm.defaultVibrator
        } else {
          @Suppress("DEPRECATION")
          reactContext.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        if (vib != null && vib.hasVibrator()) {
          if (Build.VERSION.SDK_INT >= 26) {
            val amplitudes = IntArray(pattern.size) { if (pattern[it] > 0) 255 else 0 }
            vib.vibrate(VibrationEffect.createWaveform(pattern as LongArray, amplitudes, -1))
          } else {
            @Suppress("DEPRECATION")
            vib.vibrate(pattern as LongArray, -1)
          }
          android.util.Log.w("TojeyChatHead", "vibrate pattern=${patternStr}")
        } else {
          android.util.Log.w("TojeyChatHead", "vibrate skipped no vibrator")
        }
      } catch (e: Exception) {
      }
    }
    val activity = reactContext.currentActivity
    if (activity != null) activity.runOnUiThread(run) else run.run()
  }
}