package com.tojey

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DeviceEventManagerModule

class TojeyPipReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = when (intent.action) {
      "com.tojey.PIP_PLAY" -> "play"
      "com.tojey.PIP_PAUSE" -> "pause"
      else -> return
    }
    val app = context.applicationContext as? ReactApplication ?: return
    val reactContext = app.reactNativeHost.reactInstanceManager.currentReactContext ?: return
    try {
      reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("TojeyPipAction", action)
    } catch (e: Exception) {
      android.util.Log.w("TojeyPip", "Pip action emit failed", e)
    }
  }
}
