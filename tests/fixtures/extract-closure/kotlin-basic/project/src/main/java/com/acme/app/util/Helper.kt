package com.acme.app.util

import com.acme.app.cycle.CycleA

object Helper {
    fun twice(value: Int): Int = value * 2 + CycleA.depth()
}
