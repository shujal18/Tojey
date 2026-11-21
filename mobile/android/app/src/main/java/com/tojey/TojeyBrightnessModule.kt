package com.tojey

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.view.WindowManager

class TojeyBrightnessModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TojeyBrightness"

  @ReactMethod
  fun setBrightness(value: Double) {
    try {
      val activity = reactContext.currentActivity ?: return
      val params = activity.window.attributes
      params.screenBrightness = value.toFloat().coerceIn(0.01f, 1f)
      activity.window.attributes = params
    } catch (e: Exception) {
      android.util.Log.w("TojeyBrightness", "setBrightness failed", e)
    }
  }

  @ReactMethod
  fun resetBrightness() {
    try {
      val activity = reactContext.currentActivity ?: return
      val params = activity.window.attributes
      params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
      activity.window.attributes = params
    } catch (e: Exception) {
      android.util.Log.w("TojeyBrightness", "resetBrightness failed", e)
    }
  }
}
