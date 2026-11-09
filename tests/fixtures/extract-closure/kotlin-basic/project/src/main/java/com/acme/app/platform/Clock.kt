package com.acme.app.platform

import android.os.SystemClock

object Clock {
    fun nowMs(): Long = SystemClock.elapsedRealtime()
}
