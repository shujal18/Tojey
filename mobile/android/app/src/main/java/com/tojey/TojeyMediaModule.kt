package com.tojey

import android.content.ContentValues
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
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

  @ReactMethod
  fun saveMediaToGallery(sourcePath: String, mimeType: String, displayName: String, kind: String, promise: Promise) {
    executor.execute {
      try {
        val src = File(sourcePath.removePrefix("file://"))
        if (!src.exists() || src.length() <= 0L) throw IllegalStateException("Downloaded file is missing")

        val savedPath: String
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val collection = when (kind) {
            "video" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            "image" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            else -> throw IllegalArgumentException("Unsupported media kind")
          }
          val relativePath = when (kind) {
            "video" -> "${Environment.DIRECTORY_MOVIES}/Tojey"
            else -> "${Environment.DIRECTORY_PICTURES}/Tojey"
          }
          val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
          }
          val uri = reactContext.contentResolver.insert(collection, values)
            ?: throw IllegalStateException("Could not create gallery entry")
          val output = reactContext.contentResolver.openOutputStream(uri)
            ?: throw IllegalStateException("Could not open gallery output")
          src.inputStream().use { input -> output.use { out -> input.copyTo(out) } }
          values.clear()
          values.put(MediaStore.MediaColumns.IS_PENDING, 0)
          reactContext.contentResolver.update(uri, values, null, null)
          savedPath = uri.toString()
        } else {
          val publicDir = Environment.getExternalStoragePublicDirectory(
            if (kind == "video") Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES
          )
          val dir = File(publicDir, "Tojey")
          if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("Could not create save folder")
          val dest = File(dir, displayName)
          src.copyTo(dest, overwrite = true)
          MediaScannerConnection.scanFile(reactContext, arrayOf(dest.absolutePath), arrayOf(mimeType), null)
          savedPath = dest.absolutePath
        }
        resolve(promise, savedPath)
      } catch (t: Throwable) {
        rejectSave(promise, t)
      }
    }
  }

  private fun rejectSave(promise: Promise, error: Throwable) {
    try {
      reactContext.runOnUiQueueThread {
        try {
          promise.reject("SAVE_FAILED", error.message ?: "Could not save media")
        } catch (t: Throwable) {
        }
      }
    } catch (t: Throwable) {
      try {
        promise.reject("SAVE_FAILED", error.message ?: "Could not save media")
      } catch (ignored: Throwable) {
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
