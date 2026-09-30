package com.tojey

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.app.PictureInPictureParams
import android.os.Build
import android.util.Rational

class TojeyPipModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TojeyPip"

  @ReactMethod
  fun isSupported(promise: Promise) {
    try {
      val activity = reactContext.currentActivity
      val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        activity != null &&
        activity.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)
      promise.resolve(supported)
    } catch (e: Exception) {
      android.util.Log.w("TojeyPip", "isSupported failed", e)
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun enterPip(width: Double, height: Double, promise: Promise) {
    try {
      val activity = reactContext.currentActivity
      if (activity == null) {
        promise.reject("no-activity", "no current activity")
        return
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.resolve(false)
        return
      }
      val w = Rational(Math.max(1, width.toInt()), Math.max(1, height.toInt()))
      val params = PictureInPictureParams.Builder().setAspectRatio(w).build()
      activity.enterPictureInPictureMode(params)
      promise.resolve(true)
    } catch (e: Exception) {
      android.util.Log.w("TojeyPip", "enterPip failed", e)
      promise.reject("pip-error", e.message ?: "pip error")
    }
  }
}