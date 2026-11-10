/**
 * Kotlin 真值 harness 模板（templates/kotlin-harness/harness.kt）。
 *
 * 契约：
 *  - 编译：kotlinc harness.kt -d <classes>
 *  - 运行：kotlin -cp <classes> HarnessKt（文件名 harness.kt → 主类 HarnessKt）
 *  - stdout 只输出**一个 JSON 值**（一行）；函数体内的临时输出只能走 stderr。
 *  - 同输入两次运行必须逐字节相同（模板不打印时间戳/随机数/绝对路径；Map 输出前排序或用固定顺序）。
 *  - 编码约定（与 compare.mjs 配套）：
 *      Int        → JSON 数字（安全整数范围内）
 *      Long       → {"kind":"i64","value":"<十进制字符串>"}（BigInt 精确比较）
 *      Float      → {"kind":"f32","bits":"<无符号 32 位 raw bits 十进制>"}（NaN/-0/精度差异都能比）
 *      Double     → {"kind":"f64","bits":"<无符号 64 位 raw bits 十进制>"}
 *      Boolean/String → JSON 原生；数组/对象 → JSON 原生（对象键按固定顺序输出）
 *
 * 限制：
 *  - 内存 Fake（FakeChapterLengths 用 mutableMap 替代 DB/SharedPreferences；单线程、无 IO、无 Android 依赖）。
 *  - 不依赖真实字体度量/系统时间/网络；场景必须固定。
 *  - 浮点语义：Float/Double 一律按 raw bits 比较（见 README「Float/Long/round 语义」）。
 */

import java.lang.Double.doubleToRawLongBits
import java.lang.Float.floatToRawIntBits
import kotlin.math.round

/** 确定性 JSON 编码（不依赖第三方库，零依赖）。 */
object Json {
    private const val KIND_I64 = "i64"
    private const val KIND_F32 = "f32"
    private const val KIND_F64 = "f64"

    fun esc(value: String): String {
        val sb = StringBuilder()
        for (c in value) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c.code < 0x20) sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        return sb.toString()
    }

    fun str(value: String): String = "\"" + esc(value) + "\""
    fun bool(value: Boolean): String = if (value) "true" else "false"
    fun int(value: Int): String = value.toString()
    fun i64(value: Long): String = "{\"kind\":\"" + KIND_I64 + "\",\"value\":\"" + value.toString() + "\"}"
    fun f32(value: Float): String = "{\"kind\":\"" + KIND_F32 + "\",\"bits\":\"" + floatToRawIntBits(value).toUInt().toString() + "\"}"
    fun f64(value: Double): String = "{\"kind\":\"" + KIND_F64 + "\",\"bits\":\"" + doubleToRawLongBits(value).toULong().toString() + "\"}"
    fun arr(items: List<String>): String = items.joinToString(",", "[", "]")
    fun obj(pairs: List<Pair<String, String>>): String = pairs.joinToString(",", "{", "}") { str(it.first) + ":" + it.second }
}

/** 被测纯逻辑（模板示例）：Long 总量 + Float 缩放 + half-even 取整。 */
data class Estimate(val pages: Long, val scaled: Float, val ratio: Double)

fun estimate(chapterChars: Long, charsPerPage: Int, scale: Float): Estimate {
    val ratio = chapterChars.toDouble() / charsPerPage.toDouble()
    val scaled = ratio.toFloat() * scale
    val pages = round(ratio * scale.toDouble()).toLong()
    return Estimate(pages, scaled, ratio)
}

/** Kotlin round()：ties-to-even；Math.round()：ties-to-+infinity（两种语义都在输出里对照）。 */
fun halfEven(x: Double): Long = round(x).toLong()
fun halfUp(x: Double): Long = Math.round(x)

/** 内存 Fake：单线程、无 IO，替代 Android 的 DB/SharedPreferences。 */
class FakeChapterLengths(initial: Map<Long, Long>) {
    private val store = initial.toMutableMap()
    fun get(id: Long): Long = store[id] ?: 0L
    fun put(id: Long, value: Long) { store[id] = value }
    fun remove(id: Long) { store.remove(id) }
    fun size(): Int = store.size
}

fun main() {
    val fake = FakeChapterLengths(mapOf(1L to 12000L, 2L to 0L, 3L to 123456789012L))
    fake.put(4L, 7000L)
    fake.remove(3L)

    val scenarios = (1L..4L).map { id ->
        val chars = fake.get(id)
        val est = estimate(chars, charsPerPage = 800, scale = 1.1f)
        Json.obj(
            listOf(
                "chapterId" to Json.i64(id),
                "chars" to Json.i64(chars),
                "pages" to Json.i64(est.pages),
                "scaled" to Json.f32(est.scaled),
                "ratio" to Json.f64(est.ratio),
                "title" to Json.str("第" + id + "章"),
                "empty" to Json.bool(chars == 0L),
            ),
        )
    }

    val rounding = listOf(0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5).map { x ->
        Json.obj(
            listOf(
                "x" to Json.f64(x),
                "halfEven" to Json.i64(halfEven(x)),
                "halfUp" to Json.i64(halfUp(x)),
            ),
        )
    }

    val payload = Json.obj(
        listOf(
            "scenarios" to Json.arr(scenarios),
            "rounding" to Json.arr(rounding),
            "fakeSize" to Json.int(fake.size()),
            "labels" to Json.arr(listOf(Json.str("alpha"), Json.str("b\"eta"), Json.str("line\nbreak"))),
        ),
    )
    println(payload)
}