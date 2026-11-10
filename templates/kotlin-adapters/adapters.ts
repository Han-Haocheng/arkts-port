/**
 * 边界拆分 adapter 模板的 TS 侧（templates/kotlin-adapters/adapters.ts）。
 *
 * 与 adapters.kt 一一对应：同样的窄接口 + 确定性单线程 Fake（含 W2A 回灌的 FileBytesStore/LeaseRegistry、W2B 回灌的 StateCell）。
 * TS 侧没有强类型接口（模板不引入领域类型时用结构类型即可）；要点是**调用顺序和结果与 Kotlin 完全一致**。
 */

export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export class FakeJobScope {
  active = true;
  get isActive() { return this.active; }
  cancel() { this.active = false; }
}

export class FakeJob {
  active = true;
  constructor(scope) { this.scope = scope; }
  get isActive() { return this.active && this.scope.isActive; }
  cancel() { this.active = false; }
}

export class FakeDeferred {
  hasValue = false;
  value = undefined;
  active = true;
  constructor(scope) { this.scope = scope; }
  get isActive() { return this.active && this.scope.isActive; }
  complete(result) { this.value = result; this.hasValue = true; }
  await() {
    if (!this.hasValue) throw new Error('deferred 尚未完成：先 runtime.drain() 再 await()');
    return this.value;
  }
  cancel() { this.active = false; }
}

/** 被测纯逻辑：只依赖 adapter 接口（与 harness.kt 的 ProgressRecorder 逐调用一致）。 */
export class ProgressRecorder {
  constructor(runtime, prefs, settings, rows, metrics, scope) {
    this.runtime = runtime;
    this.prefs = prefs;
    this.settings = settings;
    this.rows = rows;
    this.metrics = metrics;
    this.scope = scope;
  }

  record(bookUrl, chapterId, pages) {
    const startedAt = this.runtime.nowNanos();
    this.metrics.counter('record.start', 1n);
    this.runtime.ensureActive(this.scope);
    this.runtime.launch(this.scope, () => {
      this.prefs.putLong('lastChapter.pages', pages);
      this.prefs.putString('lastChapter.id', chapterId);
      this.metrics.counter('prefs.persist', 1n);
    });
    const row = { bookUrl, chapterId, pages, updatedAtNanos: this.runtime.nowNanos() };
    this.runtime.withContext(this.scope, () => {
      this.rows.upsert(row);
      this.metrics.gauge('rows.count', BigInt(this.rows.list(bookUrl).length));
    });
    this.prefs.putString('lastBook', bookUrl);
    this.metrics.timing('record', this.runtime.nowNanos() - startedAt);
    return pages;
  }

  pageSize() {
    return this.settings.getInt('pageSize', 800);
  }

  nightMode() {
    return this.settings.getBoolean('nightMode', false);
  }
}

/** 确定性单线程调度器：虚拟时钟 + FIFO 队列 + drain()，与 FakeRuntime 逐事件一致。 */
export class FakeRuntime {
  constructor(stepNanos = 1_000_000) {
    this.clock = 0;
    this.stepNanos = stepNanos;
    this.nextJobId = 0;
    this.events = [];
    this.queue = [];
  }

  advance() {
    this.clock += this.stepNanos;
    return this.clock;
  }

  nowNanos() {
    const at = this.advance();
    this.events.push({ op: 'now', detail: '', atNanos: at });
    return at;
  }

  launch(scope, block) {
    const job = new FakeJob(scope);
    this.nextJobId += 1;
    const label = 'job=' + this.nextJobId;
    const at = this.advance();
    this.events.push({ op: 'launch', detail: label, atNanos: at });
    this.queue.push({ label, job, scope, block });
    return job;
  }

  withContext(scope, block) {
    const at = this.advance();
    this.events.push({ op: 'withContext', detail: 'active=' + scope.isActive, atNanos: at });
    if (!scope.isActive) throw new CancelledError();
    return block();
  }

  async(scope, block) {
    const deferred = new FakeDeferred(scope);
    const at = this.advance();
    this.events.push({ op: 'async', detail: '', atNanos: at });
    this.queue.push({ label: 'async', job: null, scope, block: () => deferred.complete(block()) });
    return deferred;
  }

  ensureActive(scope) {
    if (!scope.isActive) throw new CancelledError();
  }

  drain() {
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      const at = this.advance();
      if ((task.job !== null && !task.job.isActive) || !task.scope.isActive) {
        this.events.push({ op: 'skip', detail: task.label, atNanos: at });
        continue;
      }
      this.events.push({ op: 'run', detail: task.label, atNanos: at });
      task.block();
    }
  }

  timeline() {
    return this.events.slice();
  }
}

export class InMemoryKeyValueStore {
  constructor() { this.values = new Map(); }

  getString(key) { const entry = this.values.get(key); return entry !== undefined && entry.type === 'string' ? entry.value : null; }
  getLong(key) { const entry = this.values.get(key); return entry !== undefined && entry.type === 'long' ? entry.value : null; }
  putString(key, value) { this.values.set(key, { type: 'string', value }); }
  putLong(key, value) { this.values.set(key, { type: 'long', value }); }
  remove(key) { this.values.delete(key); }
  keys() { return [...this.values.keys()].sort(); }

  /** 确定性快照：key=string:value / key=long:value（按 key 排序）。 */
  snapshot() {
    return this.keys().map((key) => {
      const entry = this.values.get(key);
      return entry.type === 'string' ? key + '=string:' + entry.value : key + '=long:' + entry.value.toString();
    });
  }
}

export class InMemorySettingsStore {
  constructor() { this.values = new Map(); }

  getInt(key, fallback) { const entry = this.values.get(key); return entry !== undefined && entry.type === 'int' ? entry.value : fallback; }
  putInt(key, value) { this.values.set(key, { type: 'int', value }); }
  getBoolean(key, fallback) { const entry = this.values.get(key); return entry !== undefined && entry.type === 'bool' ? entry.value : fallback; }
  putBoolean(key, value) { this.values.set(key, { type: 'bool', value }); }
  getString(key, fallback) { const entry = this.values.get(key); return entry !== undefined && entry.type === 'string' ? entry.value : fallback; }
  putString(key, value) { this.values.set(key, { type: 'string', value }); }
  keys() { return [...this.values.keys()].sort(); }

  snapshot() {
    return this.keys().map((key) => {
      const entry = this.values.get(key);
      if (entry.type === 'int') return key + '=int:' + entry.value;
      if (entry.type === 'bool') return key + '=bool:' + entry.value;
      return key + '=string:' + entry.value;
    });
  }
}

export class InMemoryChapterRowStore {
  constructor() { this.rows = new Map(); }

  key(row) { return row.bookUrl + '\u0000' + row.chapterId; }
  load(bookUrl, chapterId) { return this.rows.get(bookUrl + '\u0000' + chapterId) ?? undefined; }
  upsert(row) { this.rows.set(this.key(row), row); }
  delete(bookUrl, chapterId) { this.rows.delete(bookUrl + '\u0000' + chapterId); }
  list(bookUrl) {
    return [...this.rows.values()].filter((row) => row.bookUrl === bookUrl).sort((a, b) => (a.chapterId < b.chapterId ? -1 : a.chapterId > b.chapterId ? 1 : 0));
  }
  snapshot() {
    return [...this.rows.values()].sort((a, b) => (a.bookUrl !== b.bookUrl ? (a.bookUrl < b.bookUrl ? -1 : 1) : a.chapterId < b.chapterId ? -1 : a.chapterId > b.chapterId ? 1 : 0));
  }
}

export class RecordingMetrics {
  constructor() { this.lines = []; }
  counter(name, delta) { this.lines.push('counter|' + name + '|' + delta); }
  gauge(name, value) { this.lines.push('gauge|' + name + '|' + value); }
  timing(name, nanos) { this.lines.push('timing|' + name + '|' + nanos); }
  snapshot() { return this.lines.slice(); }
}

// ---------------------------------------------------------------- File/Uri

export class InMemoryFileStore {
  constructor() {
    this.files = new Map();
    this.tempCounter = 0;
  }

  readText(path) { return this.files.get(path) ?? null; }
  writeText(path, content) { this.files.set(path, content); }
  exists(path) { return this.files.has(path); }
  list(dir) {
    const prefix = dir.replace(/\/+$/, '') + '/';
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter((rest) => !rest.includes('/'))
      .sort();
  }
  delete(path) { return this.files.delete(path); }
  tempFile(prefix) {
    this.tempCounter += 1;
    return '/tmp/' + prefix + this.tempCounter;
  }
  snapshot() {
    return [...this.files.keys()].sort().map((key) => key + '=' + this.files.get(key));
  }
}

export class InMemoryUriResolver {
  resolve(uri) {
    const scheme = uri.split('://')[0] ?? '';
    if (scheme !== 'file' && scheme !== 'content') return null;
    const rest = uri.slice((scheme + '://').length);
    const slash = rest.indexOf('/');
    return {
      scheme,
      authority: slash < 0 ? '' : rest.slice(0, slash),
      path: slash < 0 ? '/' : rest.slice(slash),
    };
  }

  toFileUri(path) { return 'file://' + path; }
}

// ---------------------------------------------------------------- Flow/StateFlow

export class InMemoryFlow {
  constructor(emissions) { this.emissions = emissions; }
  collect(collector) {
    for (const item of this.emissions) collector(item);
  }
}

export class InMemoryStateFlow {
  constructor(initial) {
    this.current = initial;
    this.collectors = [];
  }

  value() { return this.current; }

  set(value) {
    this.current = value;
    for (const collector of this.collectors.slice()) collector(value);
  }

  collect(collector) {
    this.collectors.push(collector);
    collector(this.current);
  }
}

// ---------------------------------------------------------------- OkHttp/HTTP

export class FixedResponseTransport {
  constructor(responses) {
    this.responses = responses;
    this.calls = [];
  }

  execute(request) {
    this.calls.push(request.method + ' ' + request.url);
    return this.responses.get(request.url) ?? { code: 404, body: 'not-found', headers: [] };
  }

  callLog() { return this.calls.slice(); }
}

// ---------------------------------------------------------------- Ability/lifecycle

export class RecordingLifecycle {
  constructor(listener) {
    this.listener = listener;
    this.events = [];
    this.active = false;
  }

  get isActive() { return this.active; }
  onCreate() { this.active = true; this.events.push('create'); this.listener.onCreate(); }
  onForeground() { this.events.push('foreground'); this.listener.onForeground(); }
  onDestroy() { this.active = false; this.events.push('destroy'); this.listener.onDestroy(); }
  snapshot() { return this.events.slice(); }
}

// ---------------------------------------------------------------- FileBytesStore（W2A 回灌）

/** Properties 解析失败（对齐 java.util.Properties.load 的 IllegalArgumentException）。 */
export class MalformedPropertiesException extends Error {
  constructor(message = 'Malformed \\uxxxx encoding') {
    super(message);
    this.name = 'MalformedPropertiesException';
  }
}

export class FileStoreException extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileStoreException';
  }
}

/** 内存字节文件树：与 adapters.kt 的 InMemoryFileBytesStore 逐方法一致。 */
export class InMemoryFileBytesStore {
  constructor() {
    this.nodes = new Map([['/', { kind: 'dir' }]]);
    this.tempCounter = 0;
  }

  parentOf(path) {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
  }

  nameOf(path) {
    const index = path.lastIndexOf('/');
    return index < 0 ? path : path.slice(index + 1);
  }

  ensureParentDirs(path) {
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = '';
    for (let index = 0; index < segments.length - 1; index++) {
      current += '/' + segments[index];
      const node = this.nodes.get(current);
      if (node === undefined) this.nodes.set(current, { kind: 'dir' });
      else if (node.kind === 'file') throw new FileStoreException('父路径是文件：' + current);
    }
  }

  directChildren(dir) {
    const node = this.nodes.get(dir);
    if (node === undefined || node.kind !== 'dir') return [];
    const prefix = dir === '/' ? '/' : dir.replace(/\/+$/, '') + '/';
    return [...this.nodes.keys()]
      .filter((key) => key !== dir && key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((rest) => !rest.includes('/'))
      .filter((value, index, array) => array.indexOf(value) === index)
      .sort();
  }

  isFile(path) { return this.nodes.get(path)?.kind === 'file'; }
  isDirectory(path) { return this.nodes.get(path)?.kind === 'dir'; }
  exists(path) { return this.nodes.has(path); }

  length(path) {
    const node = this.nodes.get(path);
    return node !== undefined && node.kind === 'file' ? node.bytes.length : 0;
  }

  lastModified(path) {
    const node = this.nodes.get(path);
    return node !== undefined && node.kind === 'file' ? node.mtime : 0;
  }

  setLastModified(path, millis) {
    const node = this.nodes.get(path);
    if (node === undefined || node.kind !== 'file') return false;
    node.mtime = millis;
    return true;
  }

  delete(path) {
    const node = this.nodes.get(path);
    if (node === undefined) return false;
    if (node.kind === 'dir') {
      const prefix = path === '/' ? '/' : path.replace(/\/+$/, '') + '/';
      for (const key of this.nodes.keys()) {
        if (key !== path && key.startsWith(prefix)) return false;
      }
    }
    this.nodes.delete(path);
    return true;
  }

  mkdirs(path) {
    const existing = this.nodes.get(path);
    if (existing !== undefined && existing.kind === 'dir') return true;
    if (existing !== undefined && existing.kind === 'file') return false;
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = '';
    for (const segment of segments) {
      current += '/' + segment;
      const node = this.nodes.get(current);
      if (node === undefined) this.nodes.set(current, { kind: 'dir' });
      else if (node.kind === 'file') return false;
    }
    return true;
  }

  createFile(path) {
    if (this.nodes.has(path)) return false;
    this.ensureParentDirs(path);
    this.nodes.set(path, { kind: 'file', bytes: new Uint8Array(0), mtime: 0 });
    return true;
  }

  readBytes(path) {
    const node = this.nodes.get(path);
    return node !== undefined && node.kind === 'file' ? node.bytes.slice() : null;
  }

  writeBytes(path, bytes) {
    const existing = this.nodes.get(path);
    if (existing !== undefined && existing.kind === 'dir') throw new FileStoreException('无法写入目录：' + path);
    this.ensureParentDirs(path);
    const mtime = existing !== undefined && existing.kind === 'file' ? existing.mtime : 0;
    this.nodes.set(path, { kind: 'file', bytes: Uint8Array.from(bytes), mtime });
  }

  createTempFile(directory, prefix, suffix) {
    this.mkdirs(directory);
    this.tempCounter += 1;
    const path = directory.replace(/\/+$/, '') + '/' + prefix + this.tempCounter + suffix;
    this.writeBytes(path, new Uint8Array(0));
    return path;
  }

  move(source, target) {
    const node = this.nodes.get(source);
    if (node === undefined || node.kind === 'dir') return false;
    const targetNode = this.nodes.get(target);
    if (targetNode !== undefined && targetNode.kind === 'dir') return false;
    this.ensureParentDirs(target);
    this.nodes.delete(target);
    this.nodes.set(target, node);
    this.nodes.delete(source);
    return true;
  }

  walkTopDown(root) {
    if (!this.nodes.has(root)) return [];
    const prefix = root === '/' ? '/' : root.replace(/\/+$/, '') + '/';
    return [...this.nodes.keys()]
      .filter((key) => key === root || key.startsWith(prefix))
      .sort();
  }

  readProperties(path) {
    const bytes = this.readBytes(path);
    if (bytes === null) throw new FileStoreException('索引不存在：' + path);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (/\\u(?![0-9a-fA-F]{4})/.test(text)) throw new MalformedPropertiesException('Malformed \\uxxxx encoding');
    const properties = new Map();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.trim() === '') continue;
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const separator = line.search(/[=:]/);
      if (separator < 0) {
        properties.set(line.trim(), '');
        continue;
      }
      properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    return properties;
  }

  writeProperties(path, properties) {
    const text = [...properties.keys()].sort().map((key) => key + '=' + (properties.get(key) ?? '')).join('\n') + '\n';
    this.writeBytes(path, new TextEncoder().encode(text));
  }

  fsync(_path) {
    // 内存实现没有落盘语义；真实实现：FileOutputStream.flush + fd.sync()
  }

  readText(path) {
    const bytes = this.readBytes(path);
    return bytes === null ? null : new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  writeText(path, content) {
    this.writeBytes(path, new TextEncoder().encode(content));
  }

  list(dir) { return this.directChildren(dir); }

  tempFile(prefix) { return this.createTempFile('/tmp', prefix, ''); }

  /** 确定性快照：path=hex（按 path 排序），demo/契约测试用。 */
  snapshot() {
    return [...this.nodes.entries()]
      .filter(([, node]) => node.kind === 'file')
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      .map(([path, node]) => path + '=' + [...node.bytes].join(','));
  }
}

/** 读取租约（W2A pin/close 的窄面）：引用计数 + 幂等 close。 */
export class InMemoryLeaseRegistry {
  constructor() { this.users = new Map(); }

  pin(path) {
    this.users.set(path, (this.users.get(path) ?? 0) + 1);
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        const current = this.users.get(path);
        if (current === undefined) return;
        if (current <= 1) this.users.delete(path);
        else this.users.set(path, current - 1);
      },
    };
  }

  isPinned(path) { return (this.users.get(path) ?? 0) > 0; }

  hasLeaseUnder(path) {
    const prefix = path.replace(/\/+$/, '') + '/';
    for (const key of this.users.keys()) {
      if (key === path || key.startsWith(prefix)) return true;
    }
    return false;
  }
}

/** 内存字节流（InputStream 的窄面）：按顺序读，EOF 返回 -1。 */
export class InMemoryByteSource {
  constructor(bytes) {
    this.bytes = Uint8Array.from(bytes);
    this.offset = 0;
  }

  read(buffer) {
    if (this.offset >= this.bytes.length) return -1;
    const count = Math.min(buffer.length, this.bytes.length - this.offset);
    buffer.set(this.bytes.subarray(this.offset, this.offset + count), 0);
    this.offset += count;
    return count;
  }
}

// ---------------------------------------------------------------- StateCell（W2B 回灌）

/** MutableStateFlow 语义的 StateCell：value()/set()/collect() + update()；与 InMemoryStateFlow 兼容。
 *  get() 是 value() 的别名，兼容把 Kotlin 侧 StateCell 转写成 get/update 命名的 TS 逻辑（W2B 的现状）。 */
export class InMemoryStateCell extends InMemoryStateFlow {
  get() {
    return this.value();
  }

  update(transform) {
    this.set(transform(this.value()));
  }
}
