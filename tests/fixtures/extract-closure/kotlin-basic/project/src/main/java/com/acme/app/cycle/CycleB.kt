package com.acme.app.cycle

import com.acme.app.cycle.CycleA

object CycleB {
    fun depth(): Int = 2
    fun other(): Int = CycleA.depth()
}
