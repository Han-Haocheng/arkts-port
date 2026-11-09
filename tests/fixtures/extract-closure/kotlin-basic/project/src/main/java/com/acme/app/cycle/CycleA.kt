package com.acme.app.cycle

import com.acme.app.cycle.CycleB

object CycleA {
    fun depth(): Int = CycleB.depth() + 1
}
