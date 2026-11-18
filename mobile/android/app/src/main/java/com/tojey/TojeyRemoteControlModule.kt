package com.tojey

import android.content.Intent
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class TojeyRemoteControlModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "TojeyRemoteControl"

    @ReactMethod
    fun isEnabled(promise: Promise) {
        try {
            val enabled = Settings.Secure.getString(
                reactContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            )?.contains("${reactContext.packageName}/${TojeyControlService::class.java.name}") == true
            promise.resolve(enabled)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openSettings() {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
        } catch (e: Exception) {
        }
    }

    @ReactMethod
    fun tap(x: Double, y: Double, promise: Promise) {
        val ok = TojeyControlService.instance?.tap(x, y) == true
        promise.resolve(ok)
    }

    @ReactMethod
    fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, duration: Double, promise: Promise) {
        val ok = TojeyControlService.instance?.swipe(x1, y1, x2, y2, duration.toLong()) == true
        promise.resolve(ok)
    }
}
