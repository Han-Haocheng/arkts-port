# Kotlin/TS 边界拆分 adapter 模板

把 Kotlin 侧的「平台依赖」收窄成 **9 类窄接口**（协程/数据/文件·Uri/Flow·StateFlow/HTTP/生命周期 + 指标
+ W2A 回灌的 FileBytesStore·LeaseRegistry + W2B 回灌的 StateCell）+ 内存 Fake（Kotlin）+ TS 镜像，让每个边界拆分文件的 adapter 从
「手写 4 个类」变成「填一张表 + 复用 Fake」，并用 `templates/kotlin-harness/compare.mjs` 做逐字段验证。

## 文件

| 文件 | 作用 |
| --- | --- |
| `adapters.kt` | 9 类窄接口 + Kotlin 内存 Fake（`CoroutineRuntime`/`KeyValueStore`/`SettingsStore`/`ChapterRowStore`/`Metrics`/`FileStore`/`UriResolver`/`FlowLike`/`StateFlowLike`/`HttpTransport`/`AbilityLifecycle` + `FileBytesStore`/`ByteSource`/`Closeable`/`LeaseRegistry`/`StateCell`） |
| `harness.kt` | demo 纯逻辑 `ProgressRecorder` + 固定场景 + 确定性 JSON（编码同 `templates/kotlin-harness`） |
| `adapters.ts` | TS 镜像：同样的 Fake + `ProgressRecorder`（调用顺序与 Kotlin 逐条一致） |
| `harness.example.ts` | TS 侧 demo（与 `harness.kt` 场景一致，默认对比对象） |
| `run.mjs` | 编译 `adapters.kt + harness.kt`，再委托 `templates/kotlin-harness/compare.mjs` 比较 |

```bash
# 编译 + 比较（首次自动 kotlinc，之后复用 classes）
node templates/kotlin-adapters/run.mjs --out out/kotlin-adapters

# 只编译/运行 Kotlin 侧
kotlinc templates/kotlin-adapters/adapters.kt templates/kotlin-adapters/harness.kt -d /tmp/ka
kotlin -cp /tmp/ka HarnessKt | sha256sum
```

退出码沿用 `compare.mjs`：0 一致且两次运行稳定；1 不一致/不稳定/编译失败；2 用法错误。

## 接口形态（只保留边界真正需要的）

### CoroutineRuntime（协程/调度面）

```kotlin
interface CoroutineRuntime {
    fun nowNanos(): Long                                            // System.nanoTime 的替身（虚拟时钟）
    fun launch(scope: JobScope, block: () -> Unit): JobHandle       // Dispatchers.Default/IO + launch
    fun <T> withContext(scope: JobScope, block: () -> T): T         // withContext(IO) { }（模板里同步执行）
    fun <T> async(scope: JobScope, block: () -> T): Deferred<T>     // async + await，drain() 时完成
    fun ensureActive(scope: JobScope)                               // ensureActive()/CoroutineScope.isActive
}
```

- `JobScope`：`isActive` + `cancel()`（对应 `CoroutineScope`/`Job`）；`JobHandle`：`isActive` + `cancel()`；
- `Deferred<T>`：`await()`/`cancel()`，模板里由 `drain()` 完成；
- 模板**不依赖 kotlinx-coroutines**（零依赖）：真实实现里把 interface 方法映射到 `suspend`/`Dispatchers`，
  harness 只看调用顺序与结果。

### File/Uri（文件与 Uri 面）

```kotlin
interface FileStore {                       // java.io.File / FileInputStream / FileOutputStream
    fun readText(path: String): String?
    fun writeText(path: String, content: String)
    fun exists(path: String): Boolean
    fun list(dir: String): List<String>     // 直接子项，字典序
    fun delete(path: String): Boolean
    fun tempFile(prefix: String): String
}

interface UriResolver {                     // Uri.parse / ContentResolver / FileProvider
    fun resolve(uri: String): UriRef?       // file:// / content://；未知 scheme → null
    fun toFileUri(path: String): String
}
```

### Flow/StateFlow（观察面）

```kotlin
interface FlowLike<T> { fun collect(collector: (T) -> Unit) }            // Flow<T>.collect
interface StateFlowLike<T> {                                            // MutableStateFlow
    fun value(): T
    fun set(value: T)
    fun collect(collector: (T) -> Unit)
}
```

- 模板是**单线程同步**版本：`InMemoryFlow` collect 时重放固定序列；`InMemoryStateFlow` collect 先发当前值、set 时同步通知；
- 真实实现：`collect` → 协程 `collect`/`collectLatest`（配合 `CoroutineRuntime` 的语义记录）；没有回压/缓冲/去重模拟。

### FileBytesStore / ByteSource / Closeable / LeaseRegistry（W2A 回灌）

```kotlin
interface ByteSource { fun read(buffer: ByteArray): Int }      // InputStream.read(buffer)：字节数 / -1=EOF
interface Closeable { fun close() }                            // java.io.Closeable

interface FileBytesStore : FileStore {                         // java.io.File + java.nio.Files + Properties
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
    fun move(source: String, target: String): Boolean           // 覆盖目标 + 原子 rename
    fun walkTopDown(root: String): List<String>                 // 含根，按字典序
    fun readProperties(path: String): Map<String, String>       // 非法 \u 转义 → MalformedPropertiesException
    fun writeProperties(path: String, properties: Map<String, String>)
    fun fsync(path: String)                                     // fd.sync()：内存实现空操作
}

interface LeaseRegistry {                                       // W2A pin/close 的窄面
    fun pin(path: String): Closeable
    fun isPinned(path: String): Boolean
    fun hasLeaseUnder(path: String): Boolean                    // 自身或后代有租约（prefix 判定）
}
```

- `FileBytesStore` 继承 `FileStore` 的 `exists`/`delete`，其余 15 个方法补齐 W2A 的 17 个文件方法；旧的 `FileStore`（文本 6 方法）保持不变。
- `InMemoryFileBytesStore` 是文件/目录树：支持二进制读写、目录创建、原子 move、`walkTopDown`、Properties 解析；`readProperties` 对非法 `\u` 转义抛 `MalformedPropertiesException`（对齐 `java.util.Properties.load` 的 `IllegalArgumentException`）。
- `LeaseRegistry` 只做引用计数与 prefix 判定；`pin` 返回的 `Closeable` 幂等，重复 `close()` 不会重复扣减。

### StateCell（W2B 回灌）

```kotlin
interface StateCell<T> : StateFlowLike<T> {   // MutableStateFlow：value/set/collect + update
    fun update(transform: (T) -> T)
}
```

- `InMemoryStateCell.collect` 先发当前值，`set`/`update` 同步通知；`StateCell` 继承 `StateFlowLike`，可以直接当 `StateFlowLike` 用。
- `get()` 是 `value()` 的别名：TS 侧把 Kotlin StateCell 转写成 `get/update` 命名时（W2B 现有 TS 接口）可直接复用同一个 Fake。

### OkHttp/HTTP（网络面）

```kotlin
data class HttpRequest(val method: String, val url: String, val headers: List<Pair<String, String>> = emptyList(), val body: String? = null)
data class HttpResponse(val code: Int, val body: String, val headers: List<Pair<String, String>> = emptyList())
interface HttpTransport { fun execute(request: HttpRequest): HttpResponse }   // OkHttpClient.newCall().execute()
```

- `FixedResponseTransport`：按 url 查表、未知 url 返回 404、记录调用顺序；不模拟 TLS/重试/序列化。

### Ability/lifecycle（生命周期面）

```kotlin
interface AbilityLifecycleListener { fun onCreate(); fun onForeground(); fun onDestroy() }
interface AbilityLifecycle {
    val isActive: Boolean
    fun onCreate()
    fun onForeground()
    fun onDestroy()
}
```

- `RecordingLifecycle`：按调用顺序记录事件并转发给 listener（Fake 生命周期）；真实实现对应 UIAbility/AbilityStage 回调。

### 数据面（Store/Prefs/RDB/Settings）

```kotlin
interface KeyValueStore {           // SharedPreferences 的窄面（模板只用 String/Long）
    fun getString(key: String): String?
    fun getLong(key: String): Long?
    fun putString(key: String, value: String)
    fun putLong(key: String, value: Long)
    fun remove(key: String)
    fun keys(): List<String>
}

interface SettingsStore {           // 带默认值的设置面（Int/Boolean/String）
    fun getInt(key: String, fallback: Int): Int
    fun putInt(key: String, value: Int)
    fun getBoolean(key: String, fallback: Boolean): Boolean
    fun putBoolean(key: String, value: Boolean)
    fun getString(key: String, fallback: String): String
    fun putString(key: String, value: String)
    fun keys(): List<String>
}

interface ChapterRowStore {         // Room/DB 的窄 DAO（按 bookUrl + chapterId）
    fun load(bookUrl: String, chapterId: String): ChapterRow?
    fun upsert(row: ChapterRow)
    fun delete(bookUrl: String, chapterId: String)
    fun list(bookUrl: String): List<ChapterRow>
}

interface Metrics {                 // 埋点面的最小集合
    fun counter(name: String, delta: Long)
    fun gauge(name: String, value: Long)
    fun timing(name: String, nanos: Long)
}
```

原则：**接口里不出现 Android/协程框架类型**（不出现 `Context`/`SharedPreferences`/`Room`/`CoroutineScope`），
这样 harness 能在纯 JVM 里跑，TS 侧也能一一映射。

## Kotlin Fake 与 TS 镜像

| 接口 | Kotlin Fake（`adapters.kt`） | TS 镜像（`adapters.ts`） |
| --- | --- | --- |
| `CoroutineRuntime` | `FakeRuntime`：虚拟时钟（每次操作 +1 ms）、FIFO `drain()`、`skip` 记录取消 | `FakeRuntime`：同一时钟/队列/事件序列 |
| `KeyValueStore` | `InMemoryKeyValueStore`：`LinkedHashMap` + 按 key 排序快照 | `InMemoryKeyValueStore`：`Map` + 同格式快照 |
| `SettingsStore` | `InMemorySettingsStore`：Int/Boolean/String + 排序快照 | `InMemorySettingsStore` |
| `ChapterRowStore` | `InMemoryChapterRowStore`：`(bookUrl, chapterId)` 键 + 排序 | `InMemoryChapterRowStore` |
| `Metrics` | `RecordingMetrics`：`counter|name|delta` 文本行 | `RecordingMetrics` |
| `FileStore` | `InMemoryFileStore`：`Map<path,content>` + `list` 直接子项 + 递增临时文件名 | `InMemoryFileStore` |
| `UriResolver` | `InMemoryUriResolver`：`file://`/`content://` 拆 scheme/authority/path | `InMemoryUriResolver` |
| `FlowLike`/`StateFlowLike` | `InMemoryFlow`（重放）/`InMemoryStateFlow`（当前值 + 同步通知） | `InMemoryFlow`/`InMemoryStateFlow` |
| `HttpTransport` | `FixedResponseTransport`：url→固定响应 + 404 + 调用记录 | `FixedResponseTransport` |
| `AbilityLifecycle` | `RecordingLifecycle`：事件顺序 + 转发 listener + active | `RecordingLifecycle` |
| `FileBytesStore` | `InMemoryFileBytesStore`：文件/目录树 + 二进制读写 + 原子 move + walkTopDown + Properties | `InMemoryFileBytesStore`：同语义 |
| `ByteSource` | `InMemoryByteSource`：按顺序读，EOF 返回 -1 | `InMemoryByteSource` |
| `LeaseRegistry` | `InMemoryLeaseRegistry`：引用计数 + 幂等 close + prefix 判定 | `InMemoryLeaseRegistry` |
| `StateCell` | `InMemoryStateCell`：value/set/collect/update/get | `InMemoryStateCell` |

Fake 的快照是有意「字符串化」的：`key=long:12`、`counter|record.start|1` —— 逐字段比较时路径稳定，
排序后输出保证确定性。

## 线程/协程语义（模板的显式简化）

- **单线程**：`FakeRuntime.launch` 只入 FIFO 队列，`drain()` 依次执行；没有真实线程/抢占/并行。
- **虚拟时钟**：`nowNanos()` 每次 `+= 1_000_000`，所有时间字段可复现；真实实现用 `System.nanoTime()`。
- **withContext 同步**：模板把它当「切到 IO 取数」的同步调用；真实实现是 `withContext(Dispatchers.IO) { }`。
- **取消是粗粒度的**：`cancel()` 后 `drain()` 跳过该任务并记 `skip` 事件；不模拟协程在挂起点取消的细粒度行为。
- **async 在 drain 时完成**：`await()` 之前必须先 `drain()`；真实实现是 `async { }.await()`。
- 结论：模板验证「调用顺序 + 数据结果 + 指标顺序」，**不验证真实并发**。如果被测逻辑依赖真实并发/时序，
  应把它降维成纯函数再测，而不是在这里模拟线程。

## 确定性

- 无真实时间/随机数/线程/IO；空输入、固定场景；快照按 key / (bookUrl, chapterId) 排序；
- Kotlin 与 TS 两侧都由 `compare.mjs` 各跑两次，stdout 逐字节比较（不稳定直接 exit 1）；
- demo 场景下两份 golden 逐字节相同（回灌后 3677 B、171 个比较节点，sha256 由 `run.mjs` 打印）。

## 接入一个真实文件（把 Fake 换成真实实现）

1. 从目标 Kotlin 文件里找出它真正用到的平台 API，逐个映射到上面的窄接口；**不要**把 `Context`/`CoroutineScope`
   之类的框架类型透进被测逻辑。
2. 真实实现（Android 侧）新建 `AndroidAdapters.kt`：
   `nowNanos` → `System.nanoTime()`；`launch` → `scope.launch(Dispatchers.Default/IO)`；`withContext` → `withContext(Dispatchers.IO){}`；
   `KeyValueStore` → `SharedPreferences`；`ChapterRowStore` → Room DAO；`Metrics` → 埋点 SDK。
3. harness 里继续用 `adapters.kt` 的 Fake（JVM 可跑），场景覆盖边界：空 store、缺 key 的默认值、取消、async、重复 upsert。
4. 写 TS 镜像时只依赖 `adapters.ts` 的同名 Fake；调用顺序必须与 Kotlin 一致（这是逐字段比较能过的前提）。
5. `node templates/kotlin-adapters/run.mjs --out <dir>` 验证；失败会打印 `path/kind/kotlin/ts`。

## 限制

- 单线程 Fake，不模拟真实并发/协程调度；时序相关的 bug 不在覆盖范围。
- 取消只覆盖「入队后、执行前」的粗粒度取消；挂起点取消、异常传播、结构化并发都不模拟。
- Store 是内存快照：没有事务、没有 observe/Flow、没有磁盘失败注入；需要这些行为时在 Fake 上按需扩展（保持窄接口）。
- 指标只记录顺序，不代表真实采样/聚合。
- TS 侧是结构类型，不是领域类型检查；真正的类型一致性由 Kotlin 编译 + harness 场景保证。
- Flow/StateFlow 是同步 Fake：不模拟回压、缓冲、去重、异常传播；需要这些语义时把逻辑降维成纯函数再测。
- 旧的 `FileStore` 只有文本内容模型（没有权限/编码/流式读写）；W2A 用的二进制/临时文件/原子 move/Properties 在 `FileBytesStore` 里，但仍是内存树，没有真实磁盘失败注入。
- HTTP 没有 TLS/重试/序列化；Ability/lifecycle 只有回调顺序。
- Ability/lifecycle 只记录回调顺序：没有真实 Ability 上下文、配置变更、前后台切换竞态。
- 依赖外部 `kotlinc`/`kotlin`；零 npm 依赖。

## 测试

```bash
node --test tests/kotlin-adapters.test.ts
```

覆盖（20 个用例）：模板编译 + Kotlin/TS 逐字段一致（golden 逐字节相同）、虚拟时钟/Store/Metrics/File/Flow/HTTP/lifecycle 不一致、
两次运行确定性、run.mjs 用法错误、FileBytesStore/ByteSource/LeaseRegistry/StateCell 的边界契约、
以及「W2A/W2B 真实 adapter 可被模板替换」的覆盖测试（用 out/boundary-wave2 的 golden 对照，目录不存在时跳过）。