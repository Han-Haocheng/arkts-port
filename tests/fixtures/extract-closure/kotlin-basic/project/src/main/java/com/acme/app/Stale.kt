package com.acme.app

/** 同 package 内没人引用的纯逻辑文件：只有 package 补全模式会纳入。 */
class Stale {
    fun touch(): Int = 7
}
