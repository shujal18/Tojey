package com.tojey

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

class TojeyMediaModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  private val executor = Executors.newSingleThreadExecutor()

  override fun getName() = "TojeyMedia"

  @ReactMethod
  fun getVideoThumbnail(path: String, promise: Promise) {
    executor.execute {
      var retriever: MediaMetadataRetriever? = null
      var frame: Bitmap? = null
      try {
        if (path.isBlank()) {
          resolve(promise, null)
          return@execute
        }

        val uri = Uri.parse(path)
        val scheme = uri.scheme?.lowercase()
        retriever = MediaMetadataRetriever()
        if (scheme == "content" || scheme == "file") {
          retriever.setDataSource(reactContext, uri)
        } else {
          retriever.setDataSource(path)
        }

        val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        var width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
        var height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0

        val original = try {
          retriever.getFrameAtTime(500000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } catch (e: Exception) {
          null
        } ?: try {
          retriever.getFrameAtTime(0)
        } catch (e: Exception) {
          null
        }

        if (original == null || original.width <= 0 || original.height <= 0) {
          resolve(promise, null)
          return@execute
        }

        frame = scaleDown(original, 512)
        if (frame !== original) {
          try {
            original.recycle()
          } catch (e: Exception) {
          }
        }

        if (width <= 0) width = frame!!.width
        if (height <= 0) height = frame!!.height

        val dir = File(reactContext.cacheDir, "tojey-thumbs")
        if (!dir.exists() && !dir.mkdirs()) {
          resolve(promise, null)
          return@execute
        }
        val out = File(dir, "thumb_${System.currentTimeMillis()}_${(Math.random() * 1000000).toInt()}.jpg")
        FileOutputStream(out).use { stream ->
          if (!frame!!.compress(Bitmap.CompressFormat.JPEG, 80, stream)) {
            throw IllegalStateException("JPEG compression failed")
          }
        }

        val result = Arguments.createMap().apply {
          putString("uri", out.absolutePath)
          putInt("width", width)
          putInt("height", height)
          putDouble("durationMs", durationMs.toDouble())
        }
        resolve(promise, result)
      } catch (t: Throwable) {
        resolve(promise, null)
      } finally {
        try {
          retriever?.release()
        } catch (t: Throwable) {
        }
        try {
          frame?.let { if (!it.isRecycled) it.recycle() }
        } catch (t: Throwable) {
        }
      }
    }
  }

  private fun scaleDown(bitmap: Bitmap, maxDimension: Int): Bitmap {
    val width = bitmap.width
    val height = bitmap.height
    val longest = maxOf(width, height)
    if (longest <= maxDimension) return bitmap
    val scale = maxDimension.toFloat() / longest.toFloat()
    val newWidth = maxOf(1, (width.toFloat() * scale).toInt())
    val newHeight = maxOf(1, (height.toFloat() * scale).toInt())
    return Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true)
  }

  private fun resolve(promise: Promise, value: Any?) {
    try {
      reactContext.runOnUiQueueThread {
        try {
          promise.resolve(value)
        } catch (t: Throwable) {
        }
      }
    } catch (t: Throwable) {
      try {
        promise.resolve(value)
      } catch (ignored: Throwable) {
      }
    }
  }

  override fun onCatalystInstanceDestroy() {
    try {
      executor.shutdownNow()
    } catch (t: Throwable) {
    }
    super.onCatalystInstanceDestroy()
  }
}
