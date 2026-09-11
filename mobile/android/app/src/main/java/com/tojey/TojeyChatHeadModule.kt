package com.tojey

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.content.Intent
import android.provider.Settings
import android.net.Uri

class TojeyChatHeadModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TojeyChatHead"

  @ReactMethod
  fun canDrawOverlay(): Boolean {
    return try {
      Settings.canDrawOverlays(reactContext)
    } catch (e: Exception) {
      false
    }
  }

  @ReactMethod
  fun openOverlaySettings() {
    try {
      val i = Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.parse("package:" + reactContext.packageName)
      )
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(i)
    } catch (e: Exception) {
    }
  }

  @ReactMethod
  fun showChatHead(avatar: String, name: String, unread: Int) {
    try {
      val s = Intent(reactContext, ChatHeadService::class.java)
      s.action = "SHOW"
      s.putExtra("avatar", avatar)
      s.putExtra("name", name)
      s.putExtra("unread", unread)
      reactContext.startService(s)
    } catch (e: Exception) {
    }
  }

  @ReactMethod
  fun hideChatHead() {
    try {
      val s = Intent(reactContext, ChatHeadService::class.java)
      s.action = "HIDE"
      reactContext.startService(s)
    } catch (e: Exception) {
    }
  }
}