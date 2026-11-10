/**
 * 边界拆分 adapter 模板的 demo harness（templates/kotlin-adapters/harness.kt）。
 *
 * 被测纯逻辑 = ProgressRecorder（只依赖 adapters.kt 里的 4 个窄接口 + CoroutineRuntime），
 * 场景固定、单线程 Fake、虚拟时钟 → 输出确定性 JSON。
 *
 * 编译（两个文件一起）：kotlinc adapters.kt harness.kt -d <classes>
 * 运行：kotlin -cp <classes> HarnessKt
 *
 * 输出编码与 templates/kotlin-harness 相同（复用它的 compare.mjs）：
 *   Long → {"kind":"i64","value":"..."}；Float → {"kind":"f32","bits":"..."}；
 *   Double → {"kind":"f64","bits":"..."}；Int/String/Boolean/数组/对象 → 原生 JSON。
 */

import java.lang.Double.doubleToRawLongBits
import java.lang.Float.floatToRawIntBits

object Json {
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
    fun i64(value: Long): String = "{\"kind\":\"i64\",\"value\":\"" + value.toString() + "\"}"
    fun f32(value: Float): String = "{\"kind\":\"f32\",\"bits\":\"" + floatToRawIntBits(value).toUInt().toString() + "\"}"
    fun f64(value: Double): String = "{\"kind\":\"f64\",\"bits\":\"" + doubleToRawLongBits(value).toULong().toString() + "\"}"
    fun arr(items: List<String>): String = items.joinToString(",", "[", "]")
    fun obj(pairs: List<Pair<String, String>>): String = pairs.joinToString(",", "{", "}") { str(it.first) + ":" + it.second }
}

/** 被测纯逻辑：只依赖 adapter 接口（不碰 Android/协程库）。 */
class ProgressRecorder(
    private val runtime: CoroutineRuntime,
    private val prefs: KeyValueStore,
    private val settings: SettingsStore,
    private val rows: ChapterRowStore,
    private val metrics: Metrics,
    private val scope: JobScope,
) {
    fun record(bookUrl: String, chapterId: String, pages: Long): Long {
        val startedAt = runtime.nowNanos()
        metrics.counter("record.start", 1L)
        runtime.ensureActive(scope)
        runtime.launch(scope) {
            prefs.putLong("lastChapter.pages", pages)
            prefs.putString("lastChapter.id", chapterId)
            metrics.counter("prefs.persist", 1L)
        }
        val row = ChapterRow(bookUrl, chapterId, pages, runtime.nowNanos())
        runtime.withContext(scope) {
            rows.upsert(row)
            metrics.gauge("rows.count", rows.list(bookUrl).size.toLong())
        }
        prefs.putString("lastBook", bookUrl)
        metrics.timing("record", runtime.nowNanos() - startedAt)
        return pages
    }

    fun pageSize(): Int = settings.getInt("pageSize", 800)
    fun nightMode(): Boolean = settings.getBoolean("nightMode", false)
}

fun main() {
    val runtime = FakeRuntime()
    val prefs = InMemoryKeyValueStore()
    val settings = InMemorySettingsStore()
    val rows = InMemoryChapterRowStore()
    val metrics = RecordingMetrics()
    val scope = FakeJobScope()
    val recorder = ProgressRecorder(runtime, prefs, settings, rows, metrics, scope)

    settings.putInt("pageSize", 800)
    settings.putBoolean("nightMode", true)
    prefs.putString("bookUrl", "book://a")

    val pages1 = recorder.record("book://a", "ch-1", 12L)
    val pages2 = recorder.record("book://a", "ch-2", 7L)

    val deferred = runtime.async(scope) { pages1 + pages2 }
    runtime.drain()
    val asyncTotal = deferred.await()

    val cancelledJob = runtime.launch(scope) { metrics.counter("should.not.run", 1L) }
    cancelledJob.cancel()
    runtime.drain()

    rows.upsert(ChapterRow("book://a", "ch-2", 9L, runtime.nowNanos()))
    rows.delete("book://a", "ch-0")

    // ---- File/Uri（内存文件系统 + Uri 解析）
    val files = InMemoryFileStore()
    val uris = InMemoryUriResolver()
    files.writeText("/docs/a.txt", "alpha")
    files.writeText("/docs/b.txt", "beta")
    val tempPath = files.tempFile("ka-")
    files.writeText(tempPath, "tmp")
    val fileLines = listOf(
        "exists.a=" + files.exists("/docs/a.txt"),
        "read.a=" + (files.readText("/docs/a.txt") ?: "null"),
        "read.missing=" + (files.readText("/docs/missing.txt") ?: "null"),
        "list.docs=" + files.list("/docs").joinToString(","),
        "delete.b=" + files.delete("/docs/b.txt"),
        "list.docs.after=" + files.list("/docs").joinToString(","),
        "temp=" + tempPath,
        "temp.read=" + (files.readText(tempPath) ?: "null"),
        "uri.file=" + (uris.resolve("file:///docs/a.txt")?.let { uri -> uri.scheme + "|" + uri.authority + "|" + uri.path } ?: "null"),
        "uri.content=" + (uris.resolve("content://com.example.provider/books/1")?.let { uri -> uri.scheme + "|" + uri.authority + "|" + uri.path } ?: "null"),
        "uri.unknown=" + (uris.resolve("http://example.com/x")?.let { uri -> uri.path } ?: "null"),
        "toFileUri=" + uris.toFileUri("/docs/a.txt"),
    )

    // ---- Flow/StateFlow（单线程同步 Fake）
    val flowLines = mutableListOf<String>()
    InMemoryFlow(listOf("one", "two", "three")).collect { item -> flowLines.add("flow|" + item) }
    val state = InMemoryStateFlow(1)
    val stateLines = mutableListOf<String>()
    val stateCollector: (Int) -> Unit = { value -> stateLines.add("state|" + value) }
    state.collect(stateCollector)
    state.set(2)
    state.set(3)
    stateLines.add("value|" + state.value())

    // ---- OkHttp/HTTP（固定响应 + 调用记录）
    val http = FixedResponseTransport(
        mapOf(
            "https://api.example/books/1" to HttpResponse(200, "{\"id\":1}", listOf("x-source" to "fake")),
            "https://api.example/books/2" to HttpResponse(500, "boom"),
        ),
    )
    val response1 = http.execute(HttpRequest("GET", "https://api.example/books/1", listOf("accept" to "application/json")))
    val response2 = http.execute(HttpRequest("POST", "https://api.example/books/2", body = "{}"))
    val response3 = http.execute(HttpRequest("GET", "https://api.example/missing"))
    val httpLines = listOf(
        "r1=" + response1.code + "|" + response1.body,
        "r2=" + response2.code + "|" + response2.body,
        "r3=" + response3.code + "|" + response3.body,
        "calls=" + http.callLog().joinToString(";"),
    )

    // ---- Ability/lifecycle（onCreate → onForeground → onDestroy）
    val component = object : AbilityLifecycleListener {
        val log = mutableListOf<String>()
        override fun onCreate() { log.add("component.create") }
        override fun onForeground() { log.add("component.foreground") }
        override fun onDestroy() { log.add("component.destroy") }
    }
    val lifecycle = RecordingLifecycle(component)
    lifecycle.onCreate()
    lifecycle.onForeground()
    lifecycle.onDestroy()
    val lifecycleJson = Json.obj(
        listOf(
            "events" to Json.arr(lifecycle.snapshot().map { line -> Json.str(line) }),
            "component" to Json.arr(component.log.map { line -> Json.str(line) }),
            "active" to Json.bool(lifecycle.isActive),
        ),
    )

    // ---- W2A 回灌：FileBytesStore / ByteSource / Closeable / LeaseRegistry（17+2 个窄接口）
    val bytesFs = InMemoryFileBytesStore()
    bytesFs.mkdirs("/imgs")
    bytesFs.writeBytes("/imgs/a.jpg", byteArrayOf(0x01, 0x02, 0x03))
    val moved = bytesFs.move("/imgs/a.jpg", "/imgs/b.jpg")
    val temp = bytesFs.createTempFile("/imgs", "tmp-", ".part")
    bytesFs.writeBytes(temp, byteArrayOf(0x0A, 0x0B))
    bytesFs.writeProperties("/imgs/b.jpg.index", linkedMapOf("version" to "1", "chapter.ch1" to "explicit"))
    val propsRead = bytesFs.readProperties("/imgs/b.jpg.index")
    bytesFs.writeBytes("/imgs/bad.props", "chapter.ch1=\\uZZZZ".toByteArray(Charsets.UTF_8))
    val corrupt = runCatching { bytesFs.readProperties("/imgs/bad.props") }
        .exceptionOrNull()?.let { error -> error::class.simpleName } ?: "none"
    bytesFs.setLastModified("/imgs/b.jpg", 1234L)
    bytesFs.writeText("/imgs/note.txt", "hello")
    val fileByteLines = listOf(
        "moved=" + moved,
        "source.exists=" + bytesFs.exists("/imgs/a.jpg"),
        "isFile.b=" + bytesFs.isFile("/imgs/b.jpg"),
        "length.b=" + bytesFs.length("/imgs/b.jpg"),
        "read.b=" + (bytesFs.readBytes("/imgs/b.jpg") ?: ByteArray(0)).joinToString(",") { byte -> (byte.toInt() and 0xff).toString() },
        "walk=" + bytesFs.walkTopDown("/imgs").joinToString(","),
        "list=" + bytesFs.list("/imgs").joinToString(","),
        "temp=" + temp,
        "temp.length=" + bytesFs.length(temp),
        "props.version=" + propsRead["version"],
        "props.ch1=" + propsRead["chapter.ch1"],
        "props.ch2=" + (propsRead["chapter.ch2"] ?: "null"),
        "props.corrupt=" + corrupt,
        "mtime=" + bytesFs.lastModified("/imgs/b.jpg"),
        "text=" + (bytesFs.readText("/imgs/note.txt") ?: "null"),
        "delete.missing=" + bytesFs.delete("/imgs/nope"),
        "delete.dir=" + bytesFs.delete("/imgs/empty"),
        "snapshot=" + bytesFs.snapshot().joinToString(";"),
    )

    val leaseRegistry = InMemoryLeaseRegistry()
    val leaseLines = mutableListOf<String>()
    val lease = leaseRegistry.pin("/imgs/b.jpg")
    leaseLines.add("pinned=" + leaseRegistry.isPinned("/imgs/b.jpg"))
    leaseLines.add("under.dir=" + leaseRegistry.hasLeaseUnder("/imgs"))
    lease.close()
    lease.close()
    leaseLines.add("released=" + leaseRegistry.isPinned("/imgs/b.jpg"))
    val byteSource = InMemoryByteSource(byteArrayOf(0x10, 0x20, 0x30))
    val readBuffer = ByteArray(2)
    val firstRead = byteSource.read(readBuffer)
    val firstBytes = readBuffer.copyOfRange(0, maxOf(firstRead, 0)).joinToString(",") { byte -> (byte.toInt() and 0xff).toString() }
    val secondRead = byteSource.read(readBuffer)
    val secondBytes = readBuffer.copyOfRange(0, maxOf(secondRead, 0)).joinToString(",") { byte -> (byte.toInt() and 0xff).toString() }
    val thirdRead = byteSource.read(readBuffer)
    leaseLines.add("source=" + firstRead + "|" + firstBytes + "|" + secondRead + "|" + secondBytes + "|" + thirdRead)

    // ---- W2B 回灌：StateCell（MutableStateFlow 语义 + 与 StateFlowLike 兼容）
    val cell = InMemoryStateCell(0)
    val cellLines = mutableListOf<String>()
    cell.collect { value -> cellLines.add("cell|" + value) }
    cell.set(1)
    cell.update { value -> value + 1 }
    cellLines.add("value|" + cell.value())
    val asFlowLike: StateFlowLike<Int> = cell
    asFlowLike.collect { value -> cellLines.add("flowlike|" + value) }

    val payload = Json.obj(
        listOf(
            "timeline" to Json.arr(runtime.timeline().map { event ->
                Json.obj(
                    listOf(
                        "op" to Json.str(event.op),
                        "detail" to Json.str(event.detail),
                        "atNanos" to Json.i64(event.atNanos),
                    ),
                )
            }),
            "rows" to Json.arr(rows.snapshot().map { row ->
                Json.obj(
                    listOf(
                        "bookUrl" to Json.str(row.bookUrl),
                        "chapterId" to Json.str(row.chapterId),
                        "pages" to Json.i64(row.pages),
                        "updatedAtNanos" to Json.i64(row.updatedAtNanos),
                    ),
                )
            }),
            "prefs" to Json.arr(prefs.snapshot().map { line -> Json.str(line) }),
            "settings" to Json.arr(settings.snapshot().map { line -> Json.str(line) }),
            "metrics" to Json.arr(metrics.snapshot().map { line -> Json.str(line) }),
            "asyncTotal" to Json.i64(asyncTotal),
            "pagesPerChar" to Json.f32(19.0f / 26.0f),
            "ratio" to Json.f64(7.0 / 9.0),
            "ui" to Json.obj(
                listOf(
                    "pageSize" to Json.int(recorder.pageSize()),
                    "nightMode" to Json.bool(recorder.nightMode()),
                ),
            ),
            "files" to Json.arr(fileLines.map { line -> Json.str(line) }),
            "flow" to Json.arr(flowLines.map { line -> Json.str(line) }),
            "state" to Json.arr(stateLines.map { line -> Json.str(line) }),
            "http" to Json.arr(httpLines.map { line -> Json.str(line) }),
            "lifecycle" to lifecycleJson,
            "fileBytes" to Json.arr(fileByteLines.map { line -> Json.str(line) }),
            "leases" to Json.arr(leaseLines.map { line -> Json.str(line) }),
            "stateCell" to Json.arr(cellLines.map { line -> Json.str(line) }),
        ),
    )
    println(payload)
}