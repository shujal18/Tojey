package com.tojey

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
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
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
      promise.resolve(supported)
    } catch (e: Exception) {
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
      val ratio = Rational(Math.max(1, width.toInt()), Math.max(1, height.toInt()))
      val builder = PictureInPictureParams.Builder().setAspectRatio(ratio)
      val action = if (playing) {
        remoteAction("Pause", "com.tojey.PIP_PAUSE", android.R.drawable.ic_media_pause, 71)
      } else {
        remoteAction("Play", "com.tojey.PIP_PLAY", android.R.drawable.ic_media_play, 72)
      }
      builder.setActions(listOf(action))
      activity.enterPictureInPictureMode(builder.build())
      promise.resolve(true)
    } catch (e: Exception) {
      android.util.Log.w("TojeyPip", "enterPip failed", e)
      promise.reject("pip-error", e.message ?: "pip error")
    }
  }

  private fun remoteAction(title: String, actionId: String, iconRes: Int, requestCode: Int): RemoteAction {
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
    val intent = Intent(actionId).setPackage(reactContext.packageName)
    val pendingIntent = PendingIntent.getBroadcast(reactContext, requestCode, intent, flags)
    return RemoteAction(Icon.createWithResource(reactContext, iconRes), title, title, pendingIntent)
  }
}
