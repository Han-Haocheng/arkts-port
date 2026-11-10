import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * 测 templates/kotlin-adapters：编译 adapters.kt + harness.kt、Kotlin/TS 逐字段一致、
 * 虚拟时钟/Store/Metrics 不一致能被 compare 报出、两次运行确定性、用法错误。
 * Kotlin 只编译一次（run.mjs 的 --classes 复用）。
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = join(repoRoot, 'templates', 'kotlin-adapters');
const RUN = join(TEMPLATE, 'run.mjs');
const EXAMPLE = join(TEMPLATE, 'harness.example.ts');
const workRoot = mkdtempSync(join(tmpdir(), 'kotlin-adapters-test-'));
const classes = join(workRoot, 'classes');
const variants = join(workRoot, 'variants');
after(() => rmSync(workRoot, { recursive: true, force: true }));

function runTemplate(args: string[]) {
  const res = spawnSync(process.execPath, [RUN, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 300000 });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface CompareReport {
  ok: boolean;
  kotlin: { bytes: number; sha256: string; runs: number };
  ts: { bytes: number; sha256: string; runs: number };
  diffs: Array<{ path: string; kind: string; kotlin: string; ts: string }>;
  comparedNodes: number;
}

function runJson(args: string[]): CompareReport {
  const res = runTemplate([...args, '--classes', classes, '--json']);
  assert.equal(res.code, 0, res.stderr + res.stdout);
  return JSON.parse(res.stdout) as CompareReport;
}

function writeVariant(name: string, harnessPatch: ((source: string) => string) | null, adaptersPatch?: (source: string) => string): string {
  mkdirSync(variants, { recursive: true });
  const adaptersSource = readFileSync(join(TEMPLATE, 'adapters.ts'), 'utf8');
  const adaptersPatched = adaptersPatch === undefined ? adaptersSource : adaptersPatch(adaptersSource);
  if (adaptersPatch !== undefined) assert.notEqual(adaptersPatched, adaptersSource, 'adapters.ts 变体补丁没有生效：' + name);
  writeFileSync(join(variants, 'adapters.ts'), adaptersPatched, 'utf8');
  const harnessPath = join(variants, name);
  const original = readFileSync(join(TEMPLATE, 'harness.example.ts'), 'utf8');
  const patched = harnessPatch === null ? original : harnessPatch(original);
  if (harnessPatch !== null) assert.notEqual(patched, original, '变体补丁没有生效：' + name);
  writeFileSync(harnessPath, patched, 'utf8');
  return harnessPath;
}

test('一致：Kotlin/TS 逐字段一致（CoroutineRuntime/Store/Settings/Metrics），golden 逐字节相同', () => {
  const out = join(workRoot, 'out-consistent');
  const report = runJson(['--ts', EXAMPLE, '--out', out]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.diffs, []);
  assert.ok(report.comparedNodes > 50, '节点数应覆盖 timeline/rows/prefs/settings/metrics：' + report.comparedNodes);
  assert.equal(report.kotlin.runs, 2);
  assert.equal(report.ts.runs, 2);
  assert.equal(report.kotlin.sha256, report.ts.sha256, '两侧输出应逐字节相同');
  assert.equal(readFileSync(join(out, 'golden.kotlin.json'), 'utf8'), readFileSync(join(out, 'golden.ts.json'), 'utf8'));
});

test('不一致：虚拟时钟步长不同 → timeline 路径报 value', () => {
  const bad = writeVariant('clock.mjs', (source) => source.replace('const runtime = new FakeRuntime();', 'const runtime = new FakeRuntime(2_000_000);'));
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  assert.equal(report.ok, false);
  const diff = report.diffs.find((item) => item.path === 'timeline[0].atNanos');
  assert.ok(diff, '应报 timeline[0].atNanos：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.equal(diff.kind, 'value');
});

test('不一致：Store 初始值不同 → prefs 路径报 value', () => {
  const bad = writeVariant('store.mjs', (source) => source.replace("prefs.putString('bookUrl', 'book://a');", "prefs.putString('bookUrl', 'book://b');"));
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  const diff = report.diffs.find((item) => item.path === 'prefs[0]');
  assert.ok(diff, '应报 prefs[0]：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.equal(diff.kind, 'value');
  assert.match(diff.kotlin, /bookUrl=string:book:\/\/a/);
});

test('不一致：Metrics 计数不同 → metrics 路径报 value', () => {
  const bad = writeVariant(
    'metrics.mjs',
    null,
    (source) => source.replace("this.metrics.counter('record.start', 1n);", "this.metrics.counter('record.start', 2n);"),
  );
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  const diff = report.diffs.find((item) => item.path === 'metrics[0]');
  assert.ok(diff, '应报 metrics[0]：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.match(diff.kotlin, /counter\|record\.start\|1/);
  assert.match(diff.ts, /counter\|record\.start\|2/);
});

test('确定性：同参数跑两次 --json 输出相同；两次 --out golden 逐字节相同', () => {
  const first = runTemplate(['--ts', EXAMPLE, '--classes', classes, '--json']);
  const second = runTemplate(['--ts', EXAMPLE, '--classes', classes, '--json']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, '两次 --json 输出必须逐字节相同');
  const out1 = join(workRoot, 'det1');
  const out2 = join(workRoot, 'det2');
  assert.equal(runTemplate(['--ts', EXAMPLE, '--classes', classes, '--out', out1]).code, 0);
  assert.equal(runTemplate(['--ts', EXAMPLE, '--classes', classes, '--out', out2]).code, 0);
  for (const name of ['golden.kotlin.json', 'golden.ts.json']) {
    assert.equal(readFileSync(join(out1, name), 'utf8'), readFileSync(join(out2, name), 'utf8'));
  }
  assert.ok(existsSync(join(classes, 'HarnessKt.class')), 'classes 目录应已有编译产物');
});

test('Kotlin 侧与 TS 侧各自单跑两次逐字节相同', () => {
  const kotlinA = spawnSync('kotlin', ['-cp', classes, 'HarnessKt'], { encoding: 'utf8' });
  const kotlinB = spawnSync('kotlin', ['-cp', classes, 'HarnessKt'], { encoding: 'utf8' });
  assert.equal(kotlinA.status, 0, kotlinA.stderr);
  assert.equal(kotlinA.stdout, kotlinB.stdout);
  const tsA = spawnSync(process.execPath, [EXAMPLE], { encoding: 'utf8' });
  const tsB = spawnSync(process.execPath, [EXAMPLE], { encoding: 'utf8' });
  assert.equal(tsA.status, 0, tsA.stderr);
  assert.equal(tsA.stdout, tsB.stdout);
});

test('用法错误 exit 2：--ts 不存在 / 未知参数', () => {
  const missing = join(workRoot, 'no-such-harness.mjs');
  const a = runTemplate(['--ts', missing, '--classes', classes]);
  assert.equal(a.code, 2, a.stderr + a.stdout);
  assert.match(a.stderr, /compare: /);
  const b = runTemplate(['--bogus']);
  assert.equal(b.code, 2);
  assert.match(b.stderr, /run: /);
});

test('模板文件齐全（README/adapters.kt/harness.kt/adapters.ts/harness.example.ts/run.mjs）', () => {
  for (const name of ['README.md', 'adapters.kt', 'harness.kt', 'adapters.ts', 'harness.example.ts', 'run.mjs']) {
    assert.ok(existsSync(join(TEMPLATE, name)), '缺少文件：' + name);
  }
});

// ---------------------------------------------------------------- 新增 4 类 adapter（File/Uri、Flow/StateFlow、OkHttp/HTTP、Ability/lifecycle）

interface GoldenPayload {
  files: string[];
  flow: string[];
  state: string[];
  http: string[];
  lifecycle: { events: string[]; component: string[]; active: boolean };
}

test('契约：File/Uri、Flow/StateFlow、HTTP、lifecycle 的 Kotlin/TS 值逐项符合约定', () => {
  const out = join(workRoot, 'out-contract');
  const report = runJson(['--ts', EXAMPLE, '--out', out]);
  assert.equal(report.ok, true);
  const payload = JSON.parse(readFileSync(join(out, 'golden.kotlin.json'), 'utf8')) as GoldenPayload;

  // File/Uri
  assert.ok(payload.files.includes('exists.a=true'));
  assert.ok(payload.files.includes('read.a=alpha'));
  assert.ok(payload.files.includes('read.missing=null'));
  assert.ok(payload.files.includes('list.docs=a.txt,b.txt'));
  assert.ok(payload.files.includes('delete.b=true'));
  assert.ok(payload.files.includes('list.docs.after=a.txt'));
  assert.ok(payload.files.includes('temp=/tmp/ka-1'));
  assert.ok(payload.files.includes('temp.read=tmp'));
  assert.ok(payload.files.includes('uri.file=file||/docs/a.txt'));
  assert.ok(payload.files.includes('uri.content=content|com.example.provider|/books/1'));
  assert.ok(payload.files.includes('uri.unknown=null'));
  assert.ok(payload.files.includes('toFileUri=file:///docs/a.txt'));

  // Flow/StateFlow：先重放当前值，再按 set 顺序通知
  assert.deepEqual(payload.flow, ['flow|one', 'flow|two', 'flow|three']);
  assert.deepEqual(payload.state, ['state|1', 'state|2', 'state|3', 'value|3']);

  // HTTP：固定响应 + 未知 url 404 + 调用顺序
  assert.deepEqual(payload.http, [
    'r1=200|{"id":1}',
    'r2=500|boom',
    'r3=404|not-found',
    'calls=GET https://api.example/books/1;POST https://api.example/books/2;GET https://api.example/missing',
  ]);

  // lifecycle：事件顺序 + 转发 + 销毁后 active=false
  assert.deepEqual(payload.lifecycle.events, ['create', 'foreground', 'destroy']);
  assert.deepEqual(payload.lifecycle.component, ['component.create', 'component.foreground', 'component.destroy']);
  assert.equal(payload.lifecycle.active, false);
});

test('不一致：File 内容不同 → files 路径报 value', () => {
  const bad = writeVariant('file.mjs', (source) => source.replace("files.writeText('/docs/a.txt', 'alpha');", "files.writeText('/docs/a.txt', 'ALPHA');"));
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  const diff = report.diffs.find((item) => item.path === 'files[1]');
  assert.ok(diff, '应报 files[1]：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.equal(diff.kind, 'value');
});

test('不一致：Flow 发射顺序不同（adapters.ts 变体）→ flow 路径报 value', () => {
  const bad = writeVariant(
    'flow.mjs',
    null,
    (source) => source.replace(
      'for (const item of this.emissions) collector(item);',
      'for (const item of this.emissions.slice().reverse()) collector(item);',
    ),
  );
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  const diff = report.diffs.find((item) => item.path === 'flow[0]');
  assert.ok(diff, '应报 flow[0]：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.equal(diff.kind, 'value');
});

test('不一致：HTTP 响应码不同 → http 路径报 value', () => {
  const bad = writeVariant(
    'http.mjs',
    (source) => source.replace("code: 200, body: '{\"id\":1}'", "code: 201, body: '{\"id\":1}'"),
  );
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  const diff = report.diffs.find((item) => item.path === 'http[0]');
  assert.ok(diff, '应报 http[0]：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.match(diff.kotlin, /r1=200/);
  assert.match(diff.ts, /r1=201/);
});

test('不一致：lifecycle 顺序不同 → lifecycle.events 路径报 value', () => {
  const bad = writeVariant(
    'lifecycle.mjs',
    (source) => source.replace('lifecycle.onCreate();\n  lifecycle.onForeground();', 'lifecycle.onForeground();\n  lifecycle.onCreate();'),
  );
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  const diff = report.diffs.find((item) => item.path === 'lifecycle.events[0]');
  assert.ok(diff, '应报 lifecycle.events[0]：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.equal(diff.kind, 'value');
});
// ---------------------------------------------------------------- 回灌：FileBytesStore / StateCell（W2A/W2B）

import {
  FileStoreException,
  InMemoryByteSource,
  InMemoryFileBytesStore,
  InMemoryLeaseRegistry,
  InMemoryStateCell,
  InMemoryStateFlow,
  MalformedPropertiesException,
} from '../templates/kotlin-adapters/adapters.ts';

test('契约：FileBytesStore 17 个文件方法 + ByteSource/LeaseRegistry 的边界语义', () => {
  const fs = new InMemoryFileBytesStore();
  assert.equal(fs.mkdirs('/a'), true);
  assert.equal(fs.isDirectory('/a'), true);
  assert.equal(fs.createFile('/a/f1.bin'), true);
  assert.equal(fs.createFile('/a/f1.bin'), false, '已存在时 createFile=false');
  assert.equal(fs.exists('/a/f1.bin'), true);
  assert.equal(fs.isFile('/a/f1.bin'), true);
  assert.equal(fs.length('/a/f1.bin'), 0);
  assert.equal(fs.setLastModified('/a/f1.bin', 111), true);
  assert.equal(fs.lastModified('/a/f1.bin'), 111);
  assert.equal(fs.setLastModified('/a/missing', 1), false);
  assert.equal(fs.lastModified('/a/missing'), 0);

  fs.writeBytes('/a/f1.bin', Uint8Array.from([1, 2, 3]));
  assert.deepEqual([...fs.readBytes('/a/f1.bin')], [1, 2, 3]);
  assert.equal(fs.length('/a/f1.bin'), 3);
  assert.throws(() => fs.writeBytes('/a', Uint8Array.from([1])), FileStoreException, '写目录应抛 FileStoreException');

  // move：覆盖目标、源丢失/目标是目录都返回 false
  fs.writeBytes('/a/f2.bin', Uint8Array.from([9]));
  assert.equal(fs.move('/a/f1.bin', '/a/f2.bin'), true);
  assert.equal(fs.exists('/a/f1.bin'), false);
  assert.deepEqual([...fs.readBytes('/a/f2.bin')], [1, 2, 3]);
  assert.equal(fs.move('/a/missing', '/a/f2.bin'), false);
  assert.equal(fs.move('/a/f2.bin', '/a'), false, '目标是目录应拒绝');

  // delete：非空目录 false、空目录 true、缺失 false
  assert.equal(fs.delete('/a'), false);
  assert.equal(fs.delete('/a/f2.bin'), true);
  assert.equal(fs.delete('/a'), true);
  assert.equal(fs.delete('/a'), false);
  assert.deepEqual(fs.walkTopDown('/nope'), []);

  // 目录树 + 临时文件
  fs.mkdirs('/b/c');
  const temp = fs.createTempFile('/b/c', 'tmp-', '.part');
  assert.equal(temp, '/b/c/tmp-1.part');
  assert.equal(fs.exists(temp), true);
  assert.deepEqual(fs.list('/b/c'), ['tmp-1.part']);
  fs.writeText('/b/c/note.txt', 'hello');
  assert.equal(fs.readText('/b/c/note.txt'), 'hello');
  assert.deepEqual(fs.walkTopDown('/b'), ['/b', '/b/c', '/b/c/note.txt', '/b/c/tmp-1.part']);

  // Properties：排序写、可读；非法 \\u 转义抛 MalformedPropertiesException
  fs.writeProperties('/b/c/x.props', new Map([['version', '1'], ['chapter.ch1', 'explicit']]));
  const props = fs.readProperties('/b/c/x.props');
  assert.equal(props.get('version'), '1');
  assert.equal(props.get('chapter.ch1'), 'explicit');
  fs.writeBytes('/b/c/bad.props', new TextEncoder().encode('chapter.ch1=\\uZZZZ'));
  assert.throws(() => fs.readProperties('/b/c/bad.props'), MalformedPropertiesException);
  try {
    fs.readProperties('/b/c/bad.props');
    assert.fail('应当抛异常');
  } catch (error) {
    assert.equal(error.name, 'MalformedPropertiesException');
  }

  // ByteSource：分块读、EOF=-1
  const source = new InMemoryByteSource([0x10, 0x20, 0x30]);
  const buffer = new Uint8Array(2);
  assert.equal(source.read(buffer), 2);
  assert.deepEqual([...buffer], [0x10, 0x20]);
  assert.equal(source.read(buffer), 1);
  assert.deepEqual([...buffer], [0x30, 0x20]);
  assert.equal(source.read(buffer), -1);

  // LeaseRegistry：引用计数 + 幂等 close + prefix 判定
  const leases = new InMemoryLeaseRegistry();
  const first = leases.pin('/b/c/note.txt');
  const second = leases.pin('/b/c/note.txt');
  assert.equal(leases.isPinned('/b/c/note.txt'), true);
  assert.equal(leases.hasLeaseUnder('/b'), true);
  first.close();
  first.close();
  assert.equal(leases.isPinned('/b/c/note.txt'), true, '还有第二个租约');
  second.close();
  assert.equal(leases.isPinned('/b/c/note.txt'), false);
  assert.equal(leases.hasLeaseUnder('/b'), false);
  assert.equal(fs.fsync('/b/c/note.txt'), undefined, 'fsync 是无返回值的空实现');
});

test('契约：StateCell 对齐 MutableStateFlow（collect 当前值 + set/update 通知），兼容 StateFlowLike', () => {
  const cell = new InMemoryStateCell(0);
  const seen = [];
  cell.collect((value) => seen.push(value));
  assert.deepEqual(seen, [0], 'collect 先收到当前值');
  cell.set(1);
  cell.update((value) => value + 1);
  assert.deepEqual(seen, [0, 1, 2], 'set/update 同步通知');
  assert.equal(cell.value(), 2);

  // 与现有 StateFlowLike 兼容：赋值给 InMemoryStateFlow / 作为 FlowLike 使用
  const asStateFlow = cell;
  const stateFlowSeen = [];
  asStateFlow.collect((value) => stateFlowSeen.push(value));
  assert.deepEqual(stateFlowSeen, [2]);
  const flowLike = new InMemoryStateFlow(5);
  const flowSeen = [];
  flowLike.collect((value) => flowSeen.push(value));
  assert.deepEqual(flowSeen, [5]);
});

test('契约：demo 追加的 FileBytesStore/Lease/StateCell 场景值逐项符合约定', () => {
  const out = join(workRoot, 'out-w2-contract');
  const report = runJson(['--ts', EXAMPLE, '--out', out]);
  assert.equal(report.ok, true);
  assert.ok(report.comparedNodes > 150, '节点数应包含回灌场景：' + report.comparedNodes);
  const payload = JSON.parse(readFileSync(join(out, 'golden.kotlin.json'), 'utf8')) as {
    fileBytes: string[];
    leases: string[];
    stateCell: string[];
  };
  assert.deepEqual(payload.fileBytes, [
    'moved=true',
    'source.exists=false',
    'isFile.b=true',
    'length.b=3',
    'read.b=1,2,3',
    'walk=/imgs,/imgs/b.jpg,/imgs/b.jpg.index,/imgs/bad.props,/imgs/note.txt,/imgs/tmp-1.part',
    'list=b.jpg,b.jpg.index,bad.props,note.txt,tmp-1.part',
    'temp=/imgs/tmp-1.part',
    'temp.length=2',
    'props.version=1',
    'props.ch1=explicit',
    'props.ch2=null',
    'props.corrupt=MalformedPropertiesException',
    'mtime=1234',
    'text=hello',
    'delete.missing=false',
    'delete.dir=false',
    'snapshot=/imgs/b.jpg=1,2,3;/imgs/b.jpg.index=99,104,97,112,116,101,114,46,99,104,49,61,101,120,112,108,105,99,105,116,10,118,101,114,115,105,111,110,61,49,10;/imgs/bad.props=99,104,97,112,116,101,114,46,99,104,49,61,92,117,90,90,90,90;/imgs/note.txt=104,101,108,108,111;/imgs/tmp-1.part=10,11',
  ]);
  assert.deepEqual(payload.leases, [
    'pinned=true',
    'under.dir=true',
    'released=false',
    'source=2|16,32|1|48|-1',
  ]);
  assert.deepEqual(payload.stateCell, [
    'cell|0',
    'cell|1',
    'cell|2',
    'value|2',
    'flowlike|2',
  ]);
});

test('不一致：FileBytesStore 内容不同 → fileBytes 路径报 value', () => {
  const bad = writeVariant(
    'filebytes.mjs',
    (source) => source.replace("bytesFs.writeBytes('/imgs/a.jpg', Uint8Array.from([0x01, 0x02, 0x03]));", "bytesFs.writeBytes('/imgs/a.jpg', Uint8Array.from([0x01, 0x02, 0x04]));"),
  );
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  const diff = report.diffs.find((item) => item.path === 'fileBytes[4]');
  assert.ok(diff, '应报 fileBytes[4]：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.equal(diff.kind, 'value');
  assert.match(diff.kotlin, /read\.b=1,2,3/);
});

test('不一致：StateCell set 值不同 → stateCell 路径报 value', () => {
  const bad = writeVariant('statecell.mjs', (source) => source.replace('cell.set(1);', 'cell.set(2);'));
  const res = runTemplate(['--ts', bad, '--classes', classes, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as CompareReport;
  const diff = report.diffs.find((item) => item.path === 'stateCell[1]');
  assert.ok(diff, '应报 stateCell[1]：' + JSON.stringify(report.diffs.slice(0, 3)));
  assert.equal(diff.kind, 'value');
});

// ---------------------------------------------------------------- 覆盖验证：W2A/W2B 真实 adapter 可被模板替换

const WAVE2 = join(repoRoot, 'out', 'boundary-wave2');

test('覆盖：W2A BookImageFileStore 用模板 FileBytesStore 跑出与 wave2 真值一致的结果', { skip: !existsSync(WAVE2) }, async () => {
  const w2a = join(WAVE2, 'w2a-book-image-store');
  const { BookImageFileStore } = await import(join(w2a, 'ts', 'src', 'book-image-file-store.ts'));
  const fs = new InMemoryFileBytesStore();
  const store = new BookImageFileStore({
    fs,
    validate: (path) => {
      const bytes = fs.readBytes(path);
      return bytes !== null && bytes.length > 0 && bytes[0] === 0x01;
    },
    now: () => 1_700_000_000_000,
  });
  fs.mkdirs('/root');
  fs.writeBytes('/root/r.jpg', Uint8Array.from([0x01, 0x02, 0x03]));
  store.retainDownload('/root/r.jpg', 'ch1');
  assert.equal(store.isExplicitDownload('/root/r.jpg'), true);
  assert.equal(store.hasDownloadChapter('/root/r.jpg', 'ch1'), true);
  assert.equal(store.hasDownloadChapter('/root/r.jpg', 'ch2'), false);
  store.setOnline('/root/r.jpg', true);
  assert.equal(store.isOnline('/root/r.jpg'), false, '显式下载不允许标在线');
  assert.equal(store.isValid('/root/r.jpg'), true);
  fs.writeBytes('/root/bad.jpg', Uint8Array.from([0x02]));
  assert.equal(store.isValid('/root/bad.jpg'), false);
  store.write('/root/w.jpg', new InMemoryByteSource([0x01, 0x01]));
  assert.equal(fs.length('/root/w.jpg'), 2);
  let erase = '';
  try {
    store.write('/root/w.jpg', new InMemoryByteSource([0x02, 0x02]));
  } catch (error) {
    erase = error.name;
  }
  assert.equal(erase, 'IOException');
  assert.equal(fs.length('/root/w.jpg'), 2, '失败保留原文件');

  // trimOnlineCache：走模板 FileStore 的 walkTopDown/length/delete/move
  fs.mkdirs('/trim/img/.online');
  fs.writeBytes('/trim/img/t0.jpg', new Uint8Array(100).fill(0x01));
  fs.writeBytes('/trim/img/.online/t0.jpg', Uint8Array.from([0x31]));
  fs.setLastModified('/trim/img/.online/t0.jpg', 1_000);
  fs.writeBytes('/trim/img/t1.jpg', new Uint8Array(200).fill(0x01));
  fs.writeBytes('/trim/img/.online/t1.jpg', Uint8Array.from([0x31]));
  fs.setLastModified('/trim/img/.online/t1.jpg', 2_000);
  store.trimOnlineCache('/trim', 250);
  assert.equal(fs.exists('/trim/img/t0.jpg'), false, '超出预算先淘汰最旧');
  assert.equal(fs.exists('/trim/img/t1.jpg'), true, '预算内保留');

  // 与 wave2 真值（golden.kotlin.json）逐项对照
  const golden = JSON.parse(readFileSync(join(w2a, 'golden.kotlin.json'), 'utf8')) as {
    checks: Array<{ name: string; value: boolean | number | string | null }>;
  };
  const expected = new Map(golden.checks.map((item) => [item.name, item.value]));
  assert.equal(expected.get('download.explicit'), true);
  assert.equal(expected.get('download.hasCh1'), true);
  assert.equal(expected.get('isValid.valid'), true);
  assert.equal(expected.get('write.invalid.exception'), 'IOException');
});

test('覆盖：W2B CacheDownloadStateStore 用模板 StateCell 复现 wave2 前三步状态', { skip: !existsSync(WAVE2) }, async () => {
  const w2b = join(WAVE2, 'w2b-cache-download-state');
  const { CacheDownloadStateStore } = await import(join(w2b, 'ts', 'src', 'store.ts'));
  const { emptyDownloadState, chapterFraction } = await import(join(w2b, 'ts', 'src', 'models.ts'));
  const cell = new InMemoryStateCell(emptyDownloadState());
  const store = new CacheDownloadStateStore(cell);
  const golden = JSON.parse(readFileSync(join(w2b, 'golden.kotlin.json'), 'utf8')) as {
    steps: Array<{ op: string; state: unknown }>;
  };

  function f32Bits(value: number): string {
    const buffer = new ArrayBuffer(4);
    new Float32Array(buffer)[0] = value;
    return String(new Uint32Array(buffer)[0]);
  }
  function toGolden(state: {
    books: Map<string, { bookUrl: string; waitingCount: number; runningIndices: Set<number>; pausedIndices: Set<number>; failedIndices: Set<number>; successCount: number; failureMessage: string | null; chapterProgress: Map<number, { phase: string; completed: number; total: number }> }>;
    isRunning: boolean; totalWaiting: number; totalRunning: number; totalPaused: number; totalSuccess: number; totalFailure: number;
  }): unknown {
    const books: Record<string, unknown> = {};
    for (const key of [...state.books.keys()].sort()) {
      const book = state.books.get(key);
      const progress: Record<string, unknown> = {};
      for (const index of [...book.chapterProgress.keys()].sort((a, b) => a - b)) {
        const value = book.chapterProgress.get(index);
        progress[String(index)] = {
          phase: value.phase,
          completed: value.completed,
          total: value.total,
          fraction: { kind: 'f32', bits: f32Bits(chapterFraction(value)) },
        };
      }
      books[key] = {
        bookUrl: book.bookUrl,
        waitingCount: book.waitingCount,
        runningIndices: [...book.runningIndices].sort((a, b) => a - b),
        pausedIndices: [...book.pausedIndices].sort((a, b) => a - b),
        failedIndices: [...book.failedIndices].sort((a, b) => a - b),
        successCount: book.successCount,
        failureMessage: book.failureMessage,
        chapterProgress: progress,
      };
    }
    return {
      isRunning: state.isRunning, totalWaiting: state.totalWaiting, totalRunning: state.totalRunning,
      totalPaused: state.totalPaused, totalSuccess: state.totalSuccess, totalFailure: state.totalFailure,
      books,
    };
  }

  assert.deepEqual(toGolden(store.state), golden.steps[0].state, 'initial');
  store.updateBookQueue('book-a', 3, new Set([1, 2]));
  assert.deepEqual(toGolden(store.state), golden.steps[1].state, 'queue book-a');
  store.markSuccess('book-a', 1);
  assert.deepEqual(toGolden(store.state), golden.steps[2].state, 'success a/1');
  store.markFailed('book-a', 2);
  assert.deepEqual(toGolden(store.state), golden.steps[3].state, 'failed a/2');
});

