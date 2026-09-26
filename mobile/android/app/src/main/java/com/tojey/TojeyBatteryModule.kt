package com.tojey

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

class TojeyBatteryModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TojeyBattery"

  override fun getConstants(): Map<String, Any> {
    return mapOf(
      "manufacturer" to (Build.MANUFACTURER ?: ""),
      "model" to (Build.MODEL ?: ""),
      "androidVersion" to Build.VERSION.SDK_INT
    )
  }

  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    try {
      val pm = reactContext.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager
      promise.resolve(pm.isIgnoringBatteryOptimizations(reactContext.packageName))
    } catch (e: Exception) {
      android.util.Log.w("TojeyBattery", "isIgnoringBatteryOptimizations failed", e)
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun requestIgnoreBatteryOptimizations() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val i = Intent(
          Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
          Uri.parse("package:" + reactContext.packageName)
        )
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        reactContext.startActivity(i)
        android.util.Log.w("TojeyBattery", "requestIgnoreBatteryOptimizations intent launched")
      }
    } catch (e: Exception) {
      android.util.Log.w("TojeyBattery", "requestIgnoreBatteryOptimizations failed", e)
    }
  }
}