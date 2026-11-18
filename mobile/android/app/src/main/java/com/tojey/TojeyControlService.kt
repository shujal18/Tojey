package com.tojey

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.util.DisplayMetrics
import android.view.accessibility.AccessibilityEvent

class TojeyControlService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: TojeyControlService? = null
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    private fun point(x: Double, y: Double): Pair<Float, Float> {
        val metrics: DisplayMetrics = resources.displayMetrics
        val px = (x.coerceIn(0.0, 1.0) * metrics.widthPixels).toFloat()
        val py = (y.coerceIn(0.0, 1.0) * metrics.heightPixels).toFloat()
        return Pair(px, py)
    }

    fun tap(x: Double, y: Double): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val (px, py) = point(x, y)
        val path = Path().apply { moveTo(px, py); lineTo(px + 0.01f, py + 0.01f) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 60)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, duration: Long): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val (sx, sy) = point(x1, y1)
        val (ex, ey) = point(x2, y2)
        val path = Path().apply { moveTo(sx, sy); lineTo(ex, ey) }
        val safeDuration = duration.coerceIn(80L, 2000L)
        val stroke = GestureDescription.StrokeDescription(path, 0, safeDuration)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }
}
