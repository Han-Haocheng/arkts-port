package com.acme.app.platform

import android.os.Bundle

/** 平台耦合但没人引用：不得出现在报告的任何角色里。 */
object UnusedPlatform {
    fun value(bundle: Bundle): Int = bundle.size()
}
