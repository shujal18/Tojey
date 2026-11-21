package com.tojey

import android.annotation.TargetApi
import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational

@TargetApi(Build.VERSION_CODES.O)
object TojeyPipApi26 {

  @JvmStatic
  fun enter(activity: Activity, width: Double, height: Double, playing: Boolean): Boolean {
    val ratio = Rational(Math.max(1, width.toInt()), Math.max(1, height.toInt()))
    val builder = PictureInPictureParams.Builder().setAspectRatio(ratio)
    val action = if (playing) {
      remoteAction(activity, "Pause", "com.tojey.PIP_PAUSE", android.R.drawable.ic_media_pause, 71)
    } else {
      remoteAction(activity, "Play", "com.tojey.PIP_PLAY", android.R.drawable.ic_media_play, 72)
    }
    builder.setActions(listOf(action))
    activity.enterPictureInPictureMode(builder.build())
    return true
  }

  private fun remoteAction(activity: Activity, title: String, actionId: String, iconRes: Int, requestCode: Int): RemoteAction {
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
    val intent = Intent(actionId).setPackage("com.tojey")
    val pendingIntent = PendingIntent.getBroadcast(activity, requestCode, intent, flags)
    return RemoteAction(Icon.createWithResource(activity, iconRes), title, title, pendingIntent)
  }
}
