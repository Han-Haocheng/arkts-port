package com.acme.app

import com.acme.app.model.Annotated
import com.acme.app.model.*
import com.acme.app.platform.Clock
import com.acme.app.util.Helper
import com.acme.app.ghost.Ghost
import java.util.List

fun run(): Int {
    val local = Local()
    val helperValue = Helper.twice(local.value)
    val widget = Widget(1)
    val annotated = Annotated(2)
    return helperValue + widget.size + annotated.value + EngineState.READY.ordinal + Clock.nowMs().toInt()
}
