package com.tojey

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.Intent
import android.os.Build

class TojeyKeepAliveModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TojeyKeepAlive"

  @ReactMethod
  fun start() {
    try {
      val i = Intent(reactContext, TojeyKeepAliveService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(i)
      } else {
        reactContext.startService(i)
      }
      android.util.Log.i("TojeyKeepAlive", "keep-alive service started")
    } catch (e: Exception) {
      android.util.Log.w("TojeyKeepAlive", "start keep-alive failed: " + e.message)
    }
  }

  @ReactMethod
  fun stop() {
    try {
      reactContext.stopService(Intent(reactContext, TojeyKeepAliveService::class.java))
      android.util.Log.i("TojeyKeepAlive", "keep-alive service stopped")
    } catch (e: Exception) {
      android.util.Log.w("TojeyKeepAlive", "stop keep-alive failed: " + e.message)
    }
  }
}