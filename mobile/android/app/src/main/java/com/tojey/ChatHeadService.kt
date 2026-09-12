package com.tojey

import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.core.graphics.drawable.RoundedBitmapDrawableFactory
import java.net.HttpURLConnection
import java.net.URL

class ChatHeadService : Service() {

  private var wm: WindowManager? = null
  private var head: FrameLayout? = null
  private var avatarTv: TextView? = null
  private var avatarImg: ImageView? = null
  private var badgeTv: TextView? = null
  private var avatarUrl: String? = null
  private var params: WindowManager.LayoutParams? = null
  private var closeZone: View? = null
  private var overClose = false
  private var downX = 0f
  private var downY = 0f
  private var startX = 0
  private var startY = 0
  private var moved = false

  override fun onBind(intent: Intent): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (wm == null) wm = getSystemService(WINDOW_SERVICE) as? WindowManager

    if (intent == null || "HIDE" == intent.action) {
      removeHead()
      stopSelf()
      return START_NOT_STICKY
    }

    val avatar = intent.getStringExtra("avatar")
    val name = intent.getStringExtra("name")
    val unread = intent.getIntExtra("unread", 0)

    if (head == null) createHead(avatar, name)
    updateHead(avatar, unread)
    return START_STICKY
  }

  private fun dp(v: Float): Int = Math.round(v * resources.displayMetrics.density)

  private fun overlayType(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    else
      WindowManager.LayoutParams.TYPE_PHONE

  private fun ensureCloseZone() {
    if (closeZone != null) return
    val x = TextView(this)
    x.text = "✕"
    x.setTextColor(Color.WHITE)
    x.textSize = 20f
    x.gravity = Gravity.CENTER
    val bg = GradientDrawable()
    bg.shape = GradientDrawable.OVAL
    bg.setColor(0xFFEA4335.toInt())
    x.background = bg
    val p = WindowManager.LayoutParams(
      dp(56f), dp(56f), overlayType(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT
    )
    p.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
    p.y = dp(28f)
    try {
      wm?.addView(x, p)
      closeZone = x
      closeZone?.visibility = View.GONE
    } catch (ignored: Exception) {
    }
  }

  private fun showClose(show: Boolean) {
    if (!show && closeZone != null) {
      closeZone?.visibility = View.GONE
      setHover(false)
      return
    }
    ensureCloseZone()
    closeZone?.visibility = View.VISIBLE
  }

  private fun setHover(hover: Boolean) {
    overClose = hover
    if (closeZone != null) {
      val s = if (hover) 1.3f else 1f
      closeZone?.scaleX = s
      closeZone?.scaleY = s
    }
    head?.alpha = if (hover) 0.55f else 1f
  }

  private fun isOverClose(rawX: Float, rawY: Float): Boolean {
    val cz = closeZone ?: return false
    if (cz.visibility != View.VISIBLE) return false
    val l = IntArray(2)
    cz.getLocationOnScreen(l)
    val pad = dp(14f)
    return rawX >= l[0] - pad && rawX <= l[0] + cz.width + pad &&
      rawY >= l[1] - pad && rawY <= l[1] + cz.height + pad
  }

  private fun createHead(avatar: String?, name: String?) {
    val h = FrameLayout(this)

    val bg = GradientDrawable()
    bg.shape = GradientDrawable.OVAL
    bg.colors = intArrayOf(0xFF00A884.toInt(), 0xFF005C4B.toInt())
    bg.orientation = GradientDrawable.Orientation.TL_BR
    h.background = bg

    val size = dp(56f)
    val p = WindowManager.LayoutParams(
      size, size, overlayType(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT
    )
    p.gravity = Gravity.TOP or Gravity.START
    p.x = dp(12f)
    p.y = dp(120f)
    params = p

    // Letter/emoji fallback (shown until a profile picture loads, or when there is none).
    val av = TextView(this)
    av.text = if (avatar.isNullOrEmpty()) "👤" else avatar
    av.textSize = 26f
    av.gravity = Gravity.CENTER
    h.addView(
      av,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
    )
    avatarTv = av

    // Real profile picture (circular), loaded from URL, drawn on top of the letter.
    val img = ImageView(this)
    img.scaleType = ImageView.ScaleType.CENTER_CROP
    img.visibility = View.GONE
    h.addView(
      img,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
    )
    avatarImg = img

    // Small red badge with the unread count (Messenger-style), top-right over the avatar.
    val badge = TextView(this)
    badge.setTextColor(Color.WHITE)
    badge.textSize = 11f
    badge.setTypeface(null, Typeface.BOLD)
    badge.gravity = Gravity.CENTER
    badge.visibility = View.GONE
    val badgeBg = GradientDrawable()
    badgeBg.shape = GradientDrawable.OVAL
    badgeBg.setColor(0xFFEA4335.toInt())
    badge.background = badgeBg
    val bLp = FrameLayout.LayoutParams(dp(20f), dp(20f))
    bLp.gravity = Gravity.TOP or Gravity.END
    bLp.topMargin = dp(-2f)
    bLp.rightMargin = dp(-2f)
    h.addView(badge, bLp)
    badgeTv = badge

    h.setOnTouchListener(object : View.OnTouchListener {
      override fun onTouch(v: View, event: MotionEvent): Boolean {
        val prm = params ?: return true
        when (event.action) {
          MotionEvent.ACTION_DOWN -> {
            downX = event.rawX
            downY = event.rawY
            startX = prm.x
            startY = prm.y
            moved = false
            overClose = false
            return true
          }
          MotionEvent.ACTION_MOVE -> {
            val dx = event.rawX - downX
            val dy = event.rawY - downY
            if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true
            if (moved) {
              prm.x = startX + dx.toInt()
              prm.y = startY + dy.toInt()
              try {
                wm?.updateViewLayout(h, prm)
              } catch (ignored: Exception) {
              }
              showClose(true)
              setHover(isOverClose(event.rawX, event.rawY))
            }
            return true
          }
          MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
            val dropOnClose = overClose && moved
            showClose(false)
            if (dropOnClose) {
              removeHead()
              stopSelf()
              return true
            }
            if (!moved && event.action == MotionEvent.ACTION_UP) openApp()
            return true
          }
        }
        return false
      }
    })

    try {
      wm?.addView(h, p)
      head = h
    } catch (ignored: Exception) {
    }
  }

  // Fetch the profile picture off the main thread and show it as a circular avatar.
  private fun loadAvatar(url: String) {
    val me = this
    Thread {
      var bmp: Bitmap? = null
      try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.instanceFollowRedirects = true
        val ins = conn.inputStream
        bmp = BitmapFactory.decodeStream(ins)
        ins.close()
        conn.disconnect()
      } catch (ignored: Exception) {
      }
      Handler(Looper.getMainLooper()).post {
        if (me.head == null) return@post
        if (url != me.avatarUrl) return@post
        if (bmp != null) {
          val d = RoundedBitmapDrawableFactory.create(resources, bmp)
          d.isCircular = true
          avatarImg?.setImageDrawable(d)
          avatarImg?.visibility = View.VISIBLE
          avatarTv?.visibility = View.INVISIBLE
        }
      }
    }.start()
  }

  private fun updateHead(avatar: String?, unread: Int) {
    if (head == null) return
    if (avatar != null) {
      if (avatar.startsWith("http")) {
        avatarUrl = avatar
        avatarTv?.visibility = View.INVISIBLE
        loadAvatar(avatar)
      } else {
        avatarUrl = null
        avatarImg?.visibility = View.GONE
        avatarTv?.visibility = View.VISIBLE
        avatarTv?.text = avatar
      }
    }
    val badge = badgeTv ?: return
    if (unread > 0) {
      badge.text = if (unread > 99) "99+" else unread.toString()
      badge.visibility = View.VISIBLE
    } else {
      badge.visibility = View.GONE
    }
  }

  private fun removeHead() {
    val h = head ?: return
    avatarUrl = null
    try {
      wm?.removeView(h)
    } catch (ignored: Exception) {
    }
    head = null
    avatarTv = null
    avatarImg = null
    badgeTv = null
  }

  private fun openApp() {
    removeHead()
    stopSelf()
    val i = Intent(this, MainActivity::class.java)
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    i.putExtra("from_head", "true")
    try {
      startActivity(i)
    } catch (ignored: Exception) {
    }
  }

  override fun onDestroy() {
    removeHead()
    val cz = closeZone
    if (cz != null && wm != null) {
      try {
        wm?.removeView(cz)
      } catch (ignored: Exception) {
      }
      closeZone = null
    }
    super.onDestroy()
  }
}