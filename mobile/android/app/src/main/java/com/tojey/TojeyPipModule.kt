package com.tojey

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class TojeyPipModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TojeyPip"

  @ReactMethod
  fun isSupported(promise: Promise) {
    try {
      val activity = reactContext.currentActivity
      val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        activity != null &&
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
      promise.resolve(supported)
    } catch (e: Throwable) {
      android.util.Log.w("TojeyPip", "isSupported failed", e)
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun enterPip(width: Double, height: Double, playing: Boolean, promise: Promise) {
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
      val helper = Class.forName("com.tojey.TojeyPipApi26")
      val method = helper.getMethod(
        "enter",
        Activity::class.java,
        java.lang.Double::class.javaPrimitiveType,
        java.lang.Double::class.javaPrimitiveType,
        java.lang.Boolean::class.javaPrimitiveType
      )
      val result = method.invoke(null, activity, width, height, playing) as? Boolean
      promise.resolve(result == true)
    } catch (e: Throwable) {
      android.util.Log.w("TojeyPip", "enterPip failed", e)
      promise.resolve(false)
    }
  }
}
