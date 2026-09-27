package com.tojey

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.Intent
import android.os.Build

class TojeyKeepAliveModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

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
      android.util.Log.w("TojeyKeepAlive", "start requested")
    } catch (e: Exception) {
      android.util.Log.w("TojeyKeepAlive", "start failed", e)
    }
  }

  @ReactMethod
  fun stop() {
    try {
      val i = Intent(reactContext, TojeyKeepAliveService::class.java).setAction(TojeyKeepAliveService.ACTION_STOP)
      reactContext.startService(i)
      android.util.Log.w("TojeyKeepAlive", "stop requested")
    } catch (e: Exception) {
      android.util.Log.w("TojeyKeepAlive", "stop failed", e)
    }
  }

  @ReactMethod
  fun isRunning(promise: Promise) {
    try {
      promise.resolve(TojeyKeepAliveService.running)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }
}