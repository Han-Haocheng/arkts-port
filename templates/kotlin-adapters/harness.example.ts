/**
 * 边界拆分 adapter 模板的 TS 镜像（templates/kotlin-adapters/harness.example.ts）。
 * 与 harness.kt 场景/调用顺序/编码完全一致；运行：node templates/kotlin-adapters/harness.example.ts
 */
import {
  FakeJobScope,
  FakeRuntime,
  FixedResponseTransport,
  InMemoryChapterRowStore,
  InMemoryByteSource,
  InMemoryFileBytesStore,
  InMemoryFileStore,
  InMemoryFlow,
  InMemoryLeaseRegistry,
  InMemoryStateCell,
  InMemoryKeyValueStore,
  InMemorySettingsStore,
  InMemoryStateFlow,
  InMemoryUriResolver,
  ProgressRecorder,
  RecordingLifecycle,
  RecordingMetrics,
} from './adapters.ts';

function f32(value) {
  const view = new Uint32Array(new Float32Array([value]).buffer);
  return { kind: 'f32', bits: String(view[0]) };
}

function f64(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return { kind: 'f64', bits: view.getBigUint64(0).toString() };
}

function i64(value) {
  return { kind: 'i64', value: value.toString() };
}

function main() {
  const runtime = new FakeRuntime();
  const prefs = new InMemoryKeyValueStore();
  const settings = new InMemorySettingsStore();
  const rows = new InMemoryChapterRowStore();
  const metrics = new RecordingMetrics();
  const scope = new FakeJobScope();
  const recorder = new ProgressRecorder(runtime, prefs, settings, rows, metrics, scope);

  settings.putInt('pageSize', 800);
  settings.putBoolean('nightMode', true);
  prefs.putString('bookUrl', 'book://a');

  const pages1 = recorder.record('book://a', 'ch-1', 12n);
  const pages2 = recorder.record('book://a', 'ch-2', 7n);

  const deferred = runtime.async(scope, () => pages1 + pages2);
  runtime.drain();
  const asyncTotal = deferred.await();

  const cancelledJob = runtime.launch(scope, () => metrics.counter('should.not.run', 1n));
  cancelledJob.cancel();
  runtime.drain();

  rows.upsert({ bookUrl: 'book://a', chapterId: 'ch-2', pages: 9n, updatedAtNanos: runtime.nowNanos() });
  rows.delete('book://a', 'ch-0');

  // ---- File/Uri
  const files = new InMemoryFileStore();
  const uris = new InMemoryUriResolver();
  files.writeText('/docs/a.txt', 'alpha');
  files.writeText('/docs/b.txt', 'beta');
  const tempPath = files.tempFile('ka-');
  files.writeText(tempPath, 'tmp');
  const fileLines = [
    'exists.a=' + files.exists('/docs/a.txt'),
    'read.a=' + (files.readText('/docs/a.txt') ?? 'null'),
    'read.missing=' + (files.readText('/docs/missing.txt') ?? 'null'),
    'list.docs=' + files.list('/docs').join(','),
    'delete.b=' + files.delete('/docs/b.txt'),
    'list.docs.after=' + files.list('/docs').join(','),
    'temp=' + tempPath,
    'temp.read=' + (files.readText(tempPath) ?? 'null'),
    'uri.file=' + (() => {
      const uri = uris.resolve('file:///docs/a.txt');
      return uri === null ? 'null' : uri.scheme + '|' + uri.authority + '|' + uri.path;
    })(),
    'uri.content=' + (() => {
      const uri = uris.resolve('content://com.example.provider/books/1');
      return uri === null ? 'null' : uri.scheme + '|' + uri.authority + '|' + uri.path;
    })(),
    'uri.unknown=' + (() => {
      const uri = uris.resolve('http://example.com/x');
      return uri === null ? 'null' : uri.path;
    })(),
    'toFileUri=' + uris.toFileUri('/docs/a.txt'),
  ];

  // ---- Flow/StateFlow
  const flowLines = [];
  new InMemoryFlow(['one', 'two', 'three']).collect((item) => flowLines.push('flow|' + item));
  const state = new InMemoryStateFlow(1);
  const stateLines = [];
  const stateCollector = (value) => stateLines.push('state|' + value);
  state.collect(stateCollector);
  state.set(2);
  state.set(3);
  stateLines.push('value|' + state.value());

  // ---- OkHttp/HTTP
  const http = new FixedResponseTransport(new Map([
    ['https://api.example/books/1', { code: 200, body: '{"id":1}', headers: [['x-source', 'fake']] }],
    ['https://api.example/books/2', { code: 500, body: 'boom', headers: [] }],
  ]));
  const response1 = http.execute({ method: 'GET', url: 'https://api.example/books/1', headers: [['accept', 'application/json']], body: null });
  const response2 = http.execute({ method: 'POST', url: 'https://api.example/books/2', headers: [], body: '{}' });
  const response3 = http.execute({ method: 'GET', url: 'https://api.example/missing', headers: [], body: null });
  const httpLines = [
    'r1=' + response1.code + '|' + response1.body,
    'r2=' + response2.code + '|' + response2.body,
    'r3=' + response3.code + '|' + response3.body,
    'calls=' + http.callLog().join(';'),
  ];

  // ---- Ability/lifecycle
  const componentLog = [];
  const lifecycle = new RecordingLifecycle({
    onCreate() { componentLog.push('component.create'); },
    onForeground() { componentLog.push('component.foreground'); },
    onDestroy() { componentLog.push('component.destroy'); },
  });
  lifecycle.onCreate();
  lifecycle.onForeground();
  lifecycle.onDestroy();

  // ---- W2A 回灌：FileBytesStore / ByteSource / Closeable / LeaseRegistry
  const bytesFs = new InMemoryFileBytesStore();
  bytesFs.mkdirs('/imgs');
  bytesFs.writeBytes('/imgs/a.jpg', Uint8Array.from([0x01, 0x02, 0x03]));
  const moved = bytesFs.move('/imgs/a.jpg', '/imgs/b.jpg');
  const temp = bytesFs.createTempFile('/imgs', 'tmp-', '.part');
  bytesFs.writeBytes(temp, Uint8Array.from([0x0a, 0x0b]));
  bytesFs.writeProperties('/imgs/b.jpg.index', new Map([['version', '1'], ['chapter.ch1', 'explicit']]));
  const propsRead = bytesFs.readProperties('/imgs/b.jpg.index');
  bytesFs.writeBytes('/imgs/bad.props', new TextEncoder().encode('chapter.ch1=\\uZZZZ'));
  let corrupt = 'none';
  try {
    bytesFs.readProperties('/imgs/bad.props');
  } catch (error) {
    corrupt = error.name;
  }
  bytesFs.setLastModified('/imgs/b.jpg', 1234);
  bytesFs.writeText('/imgs/note.txt', 'hello');
  const fileByteLines = [
    'moved=' + moved,
    'source.exists=' + bytesFs.exists('/imgs/a.jpg'),
    'isFile.b=' + bytesFs.isFile('/imgs/b.jpg'),
    'length.b=' + bytesFs.length('/imgs/b.jpg'),
    'read.b=' + (bytesFs.readBytes('/imgs/b.jpg') ?? new Uint8Array(0)).join(','),
    'walk=' + bytesFs.walkTopDown('/imgs').join(','),
    'list=' + bytesFs.list('/imgs').join(','),
    'temp=' + temp,
    'temp.length=' + bytesFs.length(temp),
    'props.version=' + propsRead.get('version'),
    'props.ch1=' + propsRead.get('chapter.ch1'),
    'props.ch2=' + (propsRead.get('chapter.ch2') ?? 'null'),
    'props.corrupt=' + corrupt,
    'mtime=' + bytesFs.lastModified('/imgs/b.jpg'),
    'text=' + (bytesFs.readText('/imgs/note.txt') ?? 'null'),
    'delete.missing=' + bytesFs.delete('/imgs/nope'),
    'delete.dir=' + bytesFs.delete('/imgs/empty'),
    'snapshot=' + bytesFs.snapshot().join(';'),
  ];

  const leaseRegistry = new InMemoryLeaseRegistry();
  const leaseLines = [];
  const lease = leaseRegistry.pin('/imgs/b.jpg');
  leaseLines.push('pinned=' + leaseRegistry.isPinned('/imgs/b.jpg'));
  leaseLines.push('under.dir=' + leaseRegistry.hasLeaseUnder('/imgs'));
  lease.close();
  lease.close();
  leaseLines.push('released=' + leaseRegistry.isPinned('/imgs/b.jpg'));
  const byteSource = new InMemoryByteSource([0x10, 0x20, 0x30]);
  const readBuffer = new Uint8Array(2);
  const firstRead = byteSource.read(readBuffer);
  const firstBytes = [...readBuffer.slice(0, Math.max(firstRead, 0))].join(',');
  const secondRead = byteSource.read(readBuffer);
  const secondBytes = [...readBuffer.slice(0, Math.max(secondRead, 0))].join(',');
  const thirdRead = byteSource.read(readBuffer);
  leaseLines.push('source=' + firstRead + '|' + firstBytes + '|' + secondRead + '|' + secondBytes + '|' + thirdRead);

  // ---- W2B 回灌：StateCell（MutableStateFlow 语义 + 与 StateFlowLike 兼容）
  const cell = new InMemoryStateCell(0);
  const cellLines = [];
  cell.collect((value) => cellLines.push('cell|' + value));
  cell.set(1);
  cell.update((value) => value + 1);
  cellLines.push('value|' + cell.value());
  const asFlowLike = cell;
  asFlowLike.collect((value) => cellLines.push('flowlike|' + value));

  const payload = {
    timeline: runtime.timeline().map((event) => ({
      op: event.op,
      detail: event.detail,
      atNanos: i64(event.atNanos),
    })),
    rows: rows.snapshot().map((row) => ({
      bookUrl: row.bookUrl,
      chapterId: row.chapterId,
      pages: i64(row.pages),
      updatedAtNanos: i64(row.updatedAtNanos),
    })),
    prefs: prefs.snapshot(),
    settings: settings.snapshot(),
    metrics: metrics.snapshot(),
    asyncTotal: i64(asyncTotal),
    pagesPerChar: f32(Math.fround(19 / 26)),
    ratio: f64(7 / 9),
    ui: {
      pageSize: recorder.pageSize(),
      nightMode: recorder.nightMode(),
    },
    files: fileLines,
    flow: flowLines,
    state: stateLines,
    http: httpLines,
    lifecycle: {
      events: lifecycle.snapshot(),
      component: componentLog,
      active: lifecycle.isActive,
    },
    fileBytes: fileByteLines,
    leases: leaseLines,
    stateCell: cellLines,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

main();