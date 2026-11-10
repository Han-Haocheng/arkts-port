/**
 * 边界拆分 adapter 模板（templates/kotlin-adapters/adapters.kt）。
 *
 * 目标：把 Kotlin 侧「平台依赖」收窄成 9 类窄接口 + 内存 Fake：
 *   CoroutineRuntime  协程/调度面：nowNanos / launch / withContext / async(Deferred) / Job / JobScope
 *   KeyValueStore     Prefs 面：String/Long 的 get/put/remove/keys
 *   SettingsStore     设置面：Int/Boolean/String 的带默认值读写
 *   ChapterRowStore   RDB 面：按 (bookUrl, chapterId) 的 load/upsert/delete/list
 *   Metrics           指标面：counter/gauge/timing（只记录，不发送）
 *   FileBytesStore    W2A 回灌：二进制文件树（继承 FileStore，补 15 个方法）
 *   ByteSource/Closeable/LeaseRegistry  W2A 回灌：InputStream / Closeable / pin-close 租约
 *   StateCell         W2B 回灌：MutableStateFlow 语义（value/set/collect/update），与 StateFlowLike 兼容
 *
 * 约定：
 *  - 单线程、确定性：FakeRuntime 用虚拟时钟（每次操作 += 1_000_000 ns），launch 入 FIFO 队列、drain() 依次执行；
 *    不读真实时间/线程/随机数；同一场景两次运行逐字节相同。
 *  - 真实实现（Android）只需实现同一组接口：nowNanos 用 System.nanoTime，launch 用协程/线程池，
 *    KeyValueStore 用 SharedPreferences，ChapterRowStore 用 Room/DB，Metrics 用埋点 SDK。
 *  - 本模板不依赖 kotlinx-coroutines（保持零依赖）：真实实现里再把 interface 方法映射到 suspend/Dispatcher；
 *    harness 只关心「调用顺序 + 结果」，不关心真实并发。
 */

class CancelledError(message: String = "cancelled") : RuntimeException(message)

interface JobScope {
    val isActive: Boolean
    fun cancel()
}

interface JobHandle {
    val isActive: Boolean
    fun cancel()
}

interface Deferred<T> {
    val isActive: Boolean
    fun await(): T
    fun cancel()
}

/** 协程/调度面的最窄接口（harness 只依赖这些）。 */
interface CoroutineRuntime {
    fun nowNanos(): Long
    fun launch(scope: JobScope, block: () -> Unit): JobHandle
    fun <T> withContext(scope: JobScope, block: () -> T): T
    fun <T> async(scope: JobScope, block: () -> T): Deferred<T>
    fun ensureActive(scope: JobScope)
}

/** Prefs 面：只保留 String/Long（真实实现可加 Float/Boolean，但 harness 用不到就不加）。 */
interface KeyValueStore {
    fun getString(key: String): String?
    fun getLong(key: String): Long?
    fun putString(key: String, value: String)
    fun putLong(key: String, value: Long)
    fun remove(key: String)
    fun keys(): List<String>
}

/** 设置面：带默认值的类型化读写。 */
interface SettingsStore {
    fun getInt(key: String, fallback: Int): Int
    fun putInt(key: String, value: Int)
    fun getBoolean(key: String, fallback: Boolean): Boolean
    fun putBoolean(key: String, value: Boolean)
    fun getString(key: String, fallback: String): String
    fun putString(key: String, value: String)
    fun keys(): List<String>
}

data class ChapterRow(
    val bookUrl: String,
    val chapterId: String,
    val pages: Long,
    val updatedAtNanos: Long,
)

/** RDB 面：按 (bookUrl, chapterId) 的窄 DAO。 */
interface ChapterRowStore {
    fun load(bookUrl: String, chapterId: String): ChapterRow?
    fun upsert(row: ChapterRow)
    fun delete(bookUrl: String, chapterId: String)
    fun list(bookUrl: String): List<ChapterRow>
}

/** 指标面：只记录（counter/gauge/timing），真实实现再转发到埋点 SDK。 */
interface Metrics {
    fun counter(name: String, delta: Long)
    fun gauge(name: String, value: Long)
    fun timing(name: String, nanos: Long)
}

// ---------------------------------------------------------------- Fake 实现

class FakeJobScope : JobScope {
    private var active = true
    override val isActive: Boolean get() = active
    override fun cancel() { active = false }
}

class FakeJob(private val scope: JobScope) : JobHandle {
    private var active = true
    override val isActive: Boolean get() = active && scope.isActive
    override fun cancel() { active = false }
}

class FakeDeferred<T>(private val scope: JobScope) : Deferred<T> {
    private var value: T? = null
    private var hasValue = false
    private var active = true
    override val isActive: Boolean get() = active && scope.isActive
    fun complete(result: T) { value = result; hasValue = true }
    @Suppress("UNCHECKED_CAST")
    override fun await(): T {
        if (!hasValue) throw IllegalStateException("deferred 尚未完成：先 runtime.drain() 再 await()")
        return value as T
    }
    override fun cancel() { active = false }
}

/** 内存 Prefs：单线程、按 key 排序输出。 */
class InMemoryKeyValueStore : KeyValueStore {
    private val values = linkedMapOf<String, Long>()
    private val strings = linkedMapOf<String, String>()
    override fun getString(key: String): String? = strings[key]
    override fun getLong(key: String): Long? = values[key]
    override fun putString(key: String, value: String) { values.remove(key); strings[key] = value }
    override fun putLong(key: String, value: Long) { strings.remove(key); values[key] = value }
    override fun remove(key: String) { values.remove(key); strings.remove(key) }
    override fun keys(): List<String> = (values.keys + strings.keys).sorted()
    /** 确定性快照：每行 "key=string:value" / "key=long:value"（按 key 排序）。 */
    fun snapshot(): List<String> = keys().map { key ->
        val str = strings[key]
        if (str != null) key + "=string:" + str else key + "=long:" + values[key].toString()
    }
}

/** 内存 Settings：单线程、按 key 排序输出。 */
class InMemorySettingsStore : SettingsStore {
    private val values = linkedMapOf<String, Any>()
    override fun getInt(key: String, fallback: Int): Int = (values[key] as Int?) ?: fallback
    override fun putInt(key: String, value: Int) { values[key] = value }
    override fun getBoolean(key: String, fallback: Boolean): Boolean = (values[key] as Boolean?) ?: fallback
    override fun putBoolean(key: String, value: Boolean) { values[key] = value }
    override fun getString(key: String, fallback: String): String = (values[key] as String?) ?: fallback
    override fun putString(key: String, value: String) { values[key] = value }
    override fun keys(): List<String> = values.keys.sorted()
    fun snapshot(): List<String> = keys().map { key ->
        val value = values[key]
        when (value) {
            is Int -> key + "=int:" + value
            is Boolean -> key + "=bool:" + value
            else -> key + "=string:" + value.toString()
        }
    }
}

/** 内存 RDB：按 (bookUrl, chapterId) 排序输出。 */
class InMemoryChapterRowStore : ChapterRowStore {
    private val rows = linkedMapOf<String, ChapterRow>()
    private fun key(bookUrl: String, chapterId: String) = bookUrl + "\u0000" + chapterId
    override fun load(bookUrl: String, chapterId: String): ChapterRow? = rows[key(bookUrl, chapterId)]
    override fun upsert(row: ChapterRow) { rows[key(row.bookUrl, row.chapterId)] = row }
    override fun delete(bookUrl: String, chapterId: String) { rows.remove(key(bookUrl, chapterId)) }
    override fun list(bookUrl: String): List<ChapterRow> = rows.values
        .filter { row -> row.bookUrl == bookUrl }
        .sortedBy { row -> row.chapterId }
    fun snapshot(): List<ChapterRow> = rows.values.sortedWith(compareBy({ it.bookUrl }, { it.chapterId }))
}

/** 记录式 Metrics：只追加确定性文本行。 */
class RecordingMetrics : Metrics {
    private val lines = mutableListOf<String>()
    override fun counter(name: String, delta: Long) { lines.add("counter|" + name + "|" + delta) }
    override fun gauge(name: String, value: Long) { lines.add("gauge|" + name + "|" + value) }
    override fun timing(name: String, nanos: Long) { lines.add("timing|" + name + "|" + nanos) }
    fun snapshot(): List<String> = lines.toList()
}

data class RuntimeEvent(val op: String, val detail: String, val atNanos: Long)

/** 确定性单线程调度器：虚拟时钟 + FIFO 队列 + drain()。 */
class FakeRuntime(private val stepNanos: Long = 1_000_000L) : CoroutineRuntime {
    private var clock = 0L
    private var nextJobId = 0
    private val events = mutableListOf<RuntimeEvent>()
    private val queue = ArrayDeque<QueuedTask>()

    private class QueuedTask(val label: String, val job: FakeJob?, val scope: JobScope, val block: () -> Unit)

    private fun advance(): Long {
        clock += stepNanos
        return clock
    }

    override fun nowNanos(): Long {
        val at = advance()
        events.add(RuntimeEvent("now", "", at))
        return at
    }

    override fun launch(scope: JobScope, block: () -> Unit): JobHandle {
        val job = FakeJob(scope)
        nextJobId++
        val label = "job=" + nextJobId
        val at = advance()
        events.add(RuntimeEvent("launch", label, at))
        queue.addLast(QueuedTask(label, job, scope, block))
        return job
    }

    override fun <T> withContext(scope: JobScope, block: () -> T): T {
        val at = advance()
        events.add(RuntimeEvent("withContext", "active=" + scope.isActive, at))
        if (!scope.isActive) throw CancelledError()
        return block()
    }

    override fun <T> async(scope: JobScope, block: () -> T): Deferred<T> {
        val deferred = FakeDeferred<T>(scope)
        val at = advance()
        events.add(RuntimeEvent("async", "", at))
        queue.addLast(QueuedTask("async", null, scope) { deferred.complete(block()) })
        return deferred
    }

    override fun ensureActive(scope: JobScope) { if (!scope.isActive) throw CancelledError() }

    /** 执行队列到空：已取消的 job 记录 skip；async 任务完成 Deferred。 */
    fun drain() {
        while (queue.isNotEmpty()) {
            val task = queue.removeFirst()
            val at = advance()
            if ((task.job != null && !task.job.isActive) || !task.scope.isActive) {
                events.add(RuntimeEvent("skip", task.label, at))
                continue
            }
            events.add(RuntimeEvent("run", task.label, at))
            task.block()
        }
    }

    fun timeline(): List<RuntimeEvent> = events.toList()
}

// ---------------------------------------------------------------- File/Uri
// 窄面：读/写/存在/列目录/临时文件 + Uri 解析。真实实现：File/ContentResolver/FileProvider。

data class UriRef(val scheme: String, val authority: String, val path: String)

interface FileStore {
    fun readText(path: String): String?
    fun writeText(path: String, content: String)
    fun exists(path: String): Boolean
    /** 只列直接子项（名字，按字典序）；目录不存在返回空。 */
    fun list(dir: String): List<String>
    fun delete(path: String): Boolean
    /** 返回一个临时文件路径（内容由调用方再 writeText 写入）。 */
    fun tempFile(prefix: String): String
}

interface UriResolver {
    /** 只认 file:// 与 content://；未知 scheme 返回 null（真实实现里对应 IllegalArgumentException）。 */
    fun resolve(uri: String): UriRef?
    fun toFileUri(path: String): String
}

class InMemoryFileStore : FileStore {
    private val files = linkedMapOf<String, String>()
    private var tempCounter = 0
    override fun readText(path: String): String? = files[path]
    override fun writeText(path: String, content: String) { files[path] = content }
    override fun exists(path: String): Boolean = files.containsKey(path)
    override fun list(dir: String): List<String> {
        val prefix = dir.trimEnd('/') + "/"
        return files.keys
            .filter { path -> path.startsWith(prefix) }
            .map { path -> path.removePrefix(prefix) }
            .filter { rest -> !rest.contains("/") }
            .sorted()
    }
    override fun delete(path: String): Boolean = files.remove(path) != null
    override fun tempFile(prefix: String): String {
        tempCounter++
        return "/tmp/" + prefix + tempCounter
    }
    /** 确定性快照：path=content（按 path 排序）。 */
    fun snapshot(): List<String> = files.toSortedMap().map { entry -> entry.key + "=" + entry.value }
}

class InMemoryUriResolver : UriResolver {
    override fun resolve(uri: String): UriRef? {
        val scheme = uri.substringBefore("://", "")
        if (scheme != "file" && scheme != "content") return null
        val rest = uri.removePrefix(scheme + "://")
        return UriRef(scheme, rest.substringBefore('/', ""), "/" + rest.substringAfter('/', ""))
    }
    override fun toFileUri(path: String): String = "file://" + path
}

// ---------------------------------------------------------------- Flow/StateFlow
// 窄面：collect/emit/状态快照。真实实现：Flow/StateFlow/SharedFlow + 协程调度；模板是单线程同步版本。

interface FlowLike<T> {
    fun collect(collector: (T) -> Unit)
}

interface StateFlowLike<T> {
    fun value(): T
    fun set(value: T)
    fun collect(collector: (T) -> Unit)
}

/** 固定发射序列的 Flow Fake：collect 时按顺序重放。 */
class InMemoryFlow<T>(private val emissions: List<T>) : FlowLike<T> {
    override fun collect(collector: (T) -> Unit) {
        for (item in emissions) collector(item)
    }
}

/** StateFlow Fake：collect 时先发当前值，之后每次 set 同步通知。 */
class InMemoryStateFlow<T>(initial: T) : StateFlowLike<T> {
    private var current = initial
    private val collectors = mutableListOf<(T) -> Unit>()
    override fun value(): T = current
    override fun set(value: T) {
        current = value
        for (collector in collectors.toList()) collector(value)
    }
    override fun collect(collector: (T) -> Unit) {
        collectors.add(collector)
        collector(current)
    }
}

// ---------------------------------------------------------------- OkHttp/HTTP
// 窄面：request/response + execute。真实实现：OkHttpClient.newCall(...).execute()（或协程封装）。

data class HttpRequest(
    val method: String,
    val url: String,
    val headers: List<Pair<String, String>> = emptyList(),
    val body: String? = null,
)

data class HttpResponse(
    val code: Int,
    val body: String,
    val headers: List<Pair<String, String>> = emptyList(),
)

interface HttpTransport {
    fun execute(request: HttpRequest): HttpResponse
}

/** 固定响应 Fake：按 url 查表；未知 url 返回 404；记录调用顺序。 */
class FixedResponseTransport(private val responses: Map<String, HttpResponse>) : HttpTransport {
    private val calls = mutableListOf<String>()
    override fun execute(request: HttpRequest): HttpResponse {
        calls.add(request.method + " " + request.url)
        return responses[request.url] ?: HttpResponse(404, "not-found")
    }
    fun callLog(): List<String> = calls.toList()
}

// ---------------------------------------------------------------- Ability/lifecycle
// 窄面：onCreate/onForeground/onDestroy。真实实现：UIAbility/AbilityStage 的生命周期回调。

interface AbilityLifecycleListener {
    fun onCreate()
    fun onForeground()
    fun onDestroy()
}

interface AbilityLifecycle {
    val isActive: Boolean
    fun onCreate()
    fun onForeground()
    fun onDestroy()
}

/** 生命周期 Fake：按调用顺序记录事件并转发给 listener。 */
class RecordingLifecycle(private val listener: AbilityLifecycleListener) : AbilityLifecycle {
    private val events = mutableListOf<String>()
    private var active = false
    override val isActive: Boolean get() = active
    override fun onCreate() { active = true; events.add("create"); listener.onCreate() }
    override fun onForeground() { events.add("foreground"); listener.onForeground() }
    override fun onDestroy() { active = false; events.add("destroy"); listener.onDestroy() }
    fun snapshot(): List<String> = events.toList()
}

// ---------------------------------------------------------------- FileBytesStore（W2A 回灌）
// W2A BookImageFileStore 的 17 个文件方法：前 2 个（exists/delete）继承自 FileStore，
// 这里补其余 15 个：isFile/isDirectory/length/lastModified/setLastModified/mkdirs/createFile/
// readBytes/writeBytes/createTempFile/move/walkTopDown/readProperties/writeProperties/fsync。
// 真实实现：java.io.File + java.nio.Files + java.util.Properties；本模板用内存树等价实现。

interface ByteSource {
    /** 与 InputStream.read(buffer) 一致：返回读取字节数，-1 = EOF。 */
    fun read(buffer: ByteArray): Int
}

interface Closeable {
    fun close()
}

/** Properties 解析失败（真实实现对应 java.util.Properties.load 的 IllegalArgumentException）。 */
class MalformedPropertiesException(message: String) : IllegalArgumentException(message)

class FileStoreException(message: String) : RuntimeException(message)

interface FileBytesStore : FileStore {
    fun isFile(path: String): Boolean
    fun isDirectory(path: String): Boolean
    fun length(path: String): Long
    fun lastModified(path: String): Long
    fun setLastModified(path: String, millis: Long): Boolean
    fun mkdirs(path: String): Boolean
    fun createFile(path: String): Boolean
    fun readBytes(path: String): ByteArray?
    fun writeBytes(path: String, bytes: ByteArray)
    fun createTempFile(directory: String, prefix: String, suffix: String): String
    fun move(source: String, target: String): Boolean
    /** 含根与所有后代，按字典序（与 Files.walk 的集合语义一致，顺序固定便于 golden）。 */
    fun walkTopDown(root: String): List<String>
    fun readProperties(path: String): Map<String, String>
    fun writeProperties(path: String, properties: Map<String, String>)
    fun fsync(path: String)
}

/** 内存字节文件树：文件/目录都按绝对路径存；覆盖写、原子 move 用“先删目标再换名”模拟。 */
class InMemoryFileBytesStore : FileBytesStore {
    private sealed interface Node {
        class Dir : Node
        class File(val bytes: ByteArray, var mtime: Long) : Node
    }

    private val nodes = linkedMapOf<String, Node>("/" to Node.Dir())
    private var tempCounter = 0

    private fun parentOf(path: String): String {
        val index = path.lastIndexOf('/')
        return if (index <= 0) "/" else path.substring(0, index)
    }

    private fun nameOf(path: String): String {
        val index = path.lastIndexOf('/')
        return if (index < 0) path else path.substring(index + 1)
    }

    private fun ensureParentDirs(path: String) {
        val segments = path.trim('/').split('/').filter { it.isNotEmpty() }
        var current = ""
        for (index in 0 until segments.size - 1) {
            current += "/" + segments[index]
            val node = nodes[current]
            if (node == null) nodes[current] = Node.Dir()
            else if (node is Node.File) throw FileStoreException("父路径是文件：" + current)
        }
    }

    private fun directChildren(dir: String): List<String> {
        if (nodes[dir] !is Node.Dir) return emptyList()
        val prefix = if (dir == "/") "/" else dir.trimEnd('/') + "/"
        return nodes.keys
            .filter { key -> key != dir && key.startsWith(prefix) }
            .map { key -> key.removePrefix(prefix) }
            .filter { rest -> !rest.contains("/") }
            .distinct()
            .sorted()
    }

    override fun isFile(path: String): Boolean = nodes[path] is Node.File
    override fun isDirectory(path: String): Boolean = nodes[path] is Node.Dir
    override fun exists(path: String): Boolean = nodes.containsKey(path)

    override fun length(path: String): Long {
        val node = nodes[path]
        return if (node is Node.File) node.bytes.size.toLong() else 0L
    }

    override fun lastModified(path: String): Long {
        val node = nodes[path]
        return if (node is Node.File) node.mtime else 0L
    }

    override fun setLastModified(path: String, millis: Long): Boolean {
        val node = nodes[path] as? Node.File ?: return false
        node.mtime = millis
        return true
    }

    override fun delete(path: String): Boolean {
        val node = nodes[path] ?: return false
        if (node is Node.Dir) {
            val prefix = if (path == "/") "/" else path.trimEnd('/') + "/"
            if (nodes.keys.any { key -> key != path && key.startsWith(prefix) }) return false
        }
        nodes.remove(path)
        return true
    }

    override fun mkdirs(path: String): Boolean {
        val existing = nodes[path]
        if (existing is Node.Dir) return true
        if (existing is Node.File) return false
        val segments = path.trim('/').split('/').filter { it.isNotEmpty() }
        var current = ""
        for (segment in segments) {
            current += "/" + segment
            val node = nodes[current]
            if (node == null) nodes[current] = Node.Dir()
            else if (node is Node.File) return false
        }
        return true
    }

    override fun createFile(path: String): Boolean {
        if (nodes.containsKey(path)) return false
        ensureParentDirs(path)
        nodes[path] = Node.File(ByteArray(0), 0L)
        return true
    }

    override fun readBytes(path: String): ByteArray? = (nodes[path] as? Node.File)?.bytes?.copyOf()

    override fun writeBytes(path: String, bytes: ByteArray) {
        if (nodes[path] is Node.Dir) throw FileStoreException("无法写入目录：" + path)
        ensureParentDirs(path)
        val mtime = (nodes[path] as? Node.File)?.mtime ?: 0L
        nodes[path] = Node.File(bytes.copyOf(), mtime)
    }

    override fun createTempFile(directory: String, prefix: String, suffix: String): String {
        mkdirs(directory)
        tempCounter++
        val path = directory.trimEnd('/') + "/" + prefix + tempCounter + suffix
        writeBytes(path, ByteArray(0))
        return path
    }

    override fun move(source: String, target: String): Boolean {
        val node = nodes[source] ?: return false
        if (node is Node.Dir) return false
        if (nodes[target] is Node.Dir) return false
        ensureParentDirs(target)
        nodes.remove(target)
        nodes[target] = node
        nodes.remove(source)
        return true
    }

    override fun walkTopDown(root: String): List<String> {
        if (!nodes.containsKey(root)) return emptyList()
        val prefix = if (root == "/") "/" else root.trimEnd('/') + "/"
        return nodes.keys.filter { key -> key == root || key.startsWith(prefix) }.sorted()
    }

    override fun readProperties(path: String): Map<String, String> {
        val bytes = readBytes(path) ?: throw FileStoreException("索引不存在：" + path)
        val text = bytes.toString(Charsets.UTF_8)
        if (Regex("\\\\u(?![0-9a-fA-F]{4})").containsMatchIn(text)) {
            throw MalformedPropertiesException("Malformed \\uxxxx encoding")
        }
        val properties = linkedMapOf<String, String>()
        for (rawLine in text.split('\n')) {
            val line = rawLine.removeSuffix("\r")
            if (line.isBlank()) continue
            val trimmed = line.trimStart()
            if (trimmed.startsWith("#") || trimmed.startsWith("!")) continue
            val separator = line.indexOfFirst { ch -> ch == '=' || ch == ':' }
            if (separator < 0) {
                properties[line.trim()] = ""
                continue
            }
            properties[line.substring(0, separator).trim()] = line.substring(separator + 1).trim()
        }
        return properties
    }

    override fun writeProperties(path: String, properties: Map<String, String>) {
        val text = properties.keys.sorted().joinToString("\n") { key -> key + "=" + (properties[key] ?: "") } + "\n"
        writeBytes(path, text.toByteArray(Charsets.UTF_8))
    }

    override fun fsync(path: String) {
        // 内存实现没有落盘语义；真实实现：FileOutputStream.flush + fd.sync()
    }

    override fun readText(path: String): String? = readBytes(path)?.toString(Charsets.UTF_8)
    override fun writeText(path: String, content: String) = writeBytes(path, content.toByteArray(Charsets.UTF_8))
    override fun list(dir: String): List<String> = directChildren(dir)
    override fun tempFile(prefix: String): String = createTempFile("/tmp", prefix, "")

    /** 确定性快照：path=hex（按 path 排序），demo/契约测试用。 */
    fun snapshot(): List<String> = nodes.entries
        .filter { entry -> entry.value is Node.File }
        .sortedBy { entry -> entry.key }
        .map { entry ->
            val bytes = (entry.value as Node.File).bytes
            entry.key + "=" + bytes.joinToString(",") { byte -> (byte.toInt() and 0xff).toString() }
        }
}

/** 读取租约（W2A pin/close 的窄面）：单线程 Fake 等价于 synchronized(entries) 的引用计数。 */
interface LeaseRegistry {
    fun pin(path: String): Closeable
    fun isPinned(path: String): Boolean
    /** 与 W2A deleteIfIdle 的 prefix 判定一致：path 自身或其后代有租约。 */
    fun hasLeaseUnder(path: String): Boolean
}

class InMemoryLeaseRegistry : LeaseRegistry {
    private val users = linkedMapOf<String, Int>()

    override fun pin(path: String): Closeable {
        users[path] = (users[path] ?: 0) + 1
        var closed = false
        return object : Closeable {
            override fun close() {
                if (closed) return
                closed = true
                val current = users[path] ?: return
                if (current <= 1) users.remove(path) else users[path] = current - 1
            }
        }
    }

    override fun isPinned(path: String): Boolean = (users[path] ?: 0) > 0

    override fun hasLeaseUnder(path: String): Boolean =
        users.keys.any { key -> key == path || key.startsWith(path.trimEnd('/') + "/") }
}

/** 内存字节流（InputStream 的窄面）：按顺序读，EOF 返回 -1。 */
class InMemoryByteSource(private val bytes: ByteArray) : ByteSource {
    private var offset = 0

    override fun read(buffer: ByteArray): Int {
        if (offset >= bytes.size) return -1
        val count = minOf(buffer.size, bytes.size - offset)
        bytes.copyInto(buffer, 0, offset, offset + count)
        offset += count
        return count
    }
}

// ---------------------------------------------------------------- StateCell（W2B 回灌）
// W2B CacheDownloadStateStore 用到的 MutableStateFlow 语义：value 读写 + update + collect。
// 与现有 StateFlowLike 兼容（StateCell 继承它，可当 StateFlowLike 用）。

interface StateCell<T> : StateFlowLike<T> {
    /** 等价于 MutableStateFlow.update { }。 */
    fun update(transform: (T) -> T)
}

class InMemoryStateCell<T>(initial: T) : StateCell<T> {
    private val delegate = InMemoryStateFlow(initial)

    override fun value(): T = delegate.value()

    override fun set(value: T) = delegate.set(value)

    override fun collect(collector: (T) -> Unit) = delegate.collect(collector)

    override fun update(transform: (T) -> T) {
        set(transform(value()))
    }

    /** get() 是 value() 的别名：TS 侧把 Kotlin 的 StateCell 转写成 get/update 命名时用（W2B 现状）。 */
    fun get(): T = value()
}
