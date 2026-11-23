package com.tojey

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.pm.ActivityInfo
import android.os.Build
import android.view.View
import android.view.WindowManager

class TojeyOrientationModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TojeyOrientation"

  @ReactMethod
  fun lock(kind: String, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    try {
      activity.requestedOrientation = when (kind) {
        "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun unlock(promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    try {
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun setImmersive(enabled: Boolean, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    try {
      val window = activity.window
      val decor = window.decorView
      if (enabled) {
        decor.systemUiVisibility = (
          View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          val params = window.attributes
          params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
          window.attributes = params
        }
      } else {
        decor.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          val params = window.attributes
          params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER
          window.attributes = params
        }
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }
}
