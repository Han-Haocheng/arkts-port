import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsAndStrings, countLines, scanProject, extractClosure } from '../cli/extract-closure.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../cli/extract-closure.ts');
const FIXTURES = resolve(HERE, 'fixtures/extract-closure');
const KOTLIN_ROOT = join(FIXTURES, 'kotlin-basic/project');
const JAVA_ROOT = join(FIXTURES, 'java-basic/project');
const INVALID_ROOT = join(FIXTURES, 'invalid/project');
const KOTLIN_ENTRY = 'src/main/java/com/acme/app/Entry.kt';
const KOTLIN_TEST_ENTRY = 'src/test/java/com/acme/app/EntryTest.kt';
const JAVA_ENTRY = 'src/main/java/com/acme/japp/App.java';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface ReportFile {
  path: string;
  loc: number;
  role: string;
  coupled: boolean;
  pkg: string;
  vias: string[];
}

interface Boundary {
  file: string;
  reason: string;
  evidence: string[];
  patterns: number[];
  symbols: { name: string; kind: string; line: number }[];
  neededBy: { file: string; symbols: string[] }[];
}

interface Unresolved {
  symbol: string;
  fromFile: string;
  reason: string;
  kind: string;
  alias?: string;
  target?: string;
}

interface AliasHit {
  specifier: string;
  alias: string;
  target: string;
  fromFile: string;
  source: string;
}

interface ManualExtraction {
  symbol: string;
  kind: string;
  declaredIn: string;
  neededBy: string[];
  reason: string;
}

interface Report {
  entry: string;
  entryPackage: string;
  root: string;
  lang: string;
  packageComplete: boolean;
  scannedFiles: number;
  files: ReportFile[];
  totals: {
    files: number;
    loc: number;
    include: number;
    coupled: number;
    test: number;
    includeLoc: number;
    coupledLoc: number;
  };
  boundaries: Boundary[];
  unresolved: Unresolved[];
  removableImports: { symbol: string; fromFile: string; usage: string }[];
  manualExtractions: ManualExtraction[];
  aliasesEnabled: boolean;
  aliases: AliasHit[];
  aliasConfigs: string[];
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function reportOf(root: string, entry: string, extra: string[] = []): Report {
  const result = runCli(['--root', root, '--entry', entry, '--json', ...extra]);
  assert.equal(result.status, 0, 'CLI 退出码应为 0，stderr：' + result.stderr);
  return JSON.parse(result.stdout) as Report;
}

function pathsOf(report: Report, role: string): string[] {
  return report.files.filter((file) => file.role === role).map((file) => file.path).sort();
}

function findFile(report: Report, suffix: string): ReportFile {
  const found = report.files.find((file) => file.path.endsWith(suffix));
  assert.ok(found, '报告里应包含 ' + suffix);
  return found as ReportFile;
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-extract-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('stripCommentsAndStrings：清空注释与字符串，保留带花括号的模板表达式', () => {
  const bracedTemplate = 'val c = "v=' + '$' + '{ value }"';
  const source = [
    'val a = "x // 不是注释" // 真注释',
    'val b = """raw $name 也清空"""',
    bracedTemplate,
    '/* 外层 /* 内层 */ 还在注释里 */',
    'val d = 1',
  ].join('\n');
  const code = stripCommentsAndStrings(source);
  assert.equal(code.includes('不是注释'), false);
  assert.equal(code.includes('也清空'), false);
  assert.equal(code.includes('还在注释里'), false);
  assert.equal(code.includes('value'), true);
  assert.equal(code.includes('val d = 1'), true);
});

test('countLines：与 wc -l 对齐', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb\n'), 2);
});

test('--help：退出码 0，包含用法与全部分类说明', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('用法'));
  assert.ok(result.stdout.includes('--no-package-complete'));
  assert.ok(result.stdout.includes('include'));
  assert.ok(result.stdout.includes('coupled'));
});

test('参数校验：缺参/未知参数/未知语言/out 指向 root → 2；entry 不存在或越界 → 1', () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['--root', KOTLIN_ROOT]).status, 2);
  assert.equal(runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--bogus']).status, 2);
  assert.equal(runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--lang', 'dart']).status, 2);
  assert.equal(runCli(['--root', join(KOTLIN_ROOT, 'no-such-dir'), '--entry', KOTLIN_ENTRY]).status, 2);
  assert.equal(runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--out', KOTLIN_ROOT]).status, 2);
  const missing = runCli(['--root', KOTLIN_ROOT, '--entry', 'src/main/java/com/acme/app/Nope.kt']);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes('entry 不存在'));
  const outside = runCli(['--root', KOTLIN_ROOT, '--entry', join(JAVA_ROOT, JAVA_ENTRY)]);
  assert.equal(outside.status, 1);
  const unparseable = runCli(['--root', INVALID_ROOT, '--entry', 'src/main/java/Broken.kt']);
  assert.equal(unparseable.status, 1);
  assert.ok(unparseable.stderr.includes('package'));
});

test('Kotlin 严格闭包：package/import/同包引用/star import/循环依赖', () => {
  const report = reportOf(KOTLIN_ROOT, KOTLIN_ENTRY, ['--no-package-complete']);
  assert.equal(report.entry, KOTLIN_ENTRY);
  assert.equal(report.entryPackage, 'com.acme.app');
  assert.equal(report.packageComplete, false);
  assert.equal(report.lang, 'jvm');
  assert.deepEqual(pathsOf(report, 'include'), [
    'src/main/java/com/acme/app/Entry.kt',
    'src/main/java/com/acme/app/Local.kt',
    'src/main/java/com/acme/app/cycle/CycleA.kt',
    'src/main/java/com/acme/app/cycle/CycleB.kt',
    'src/main/java/com/acme/app/model/Annotated.kt',
    'src/main/java/com/acme/app/model/Widget.kt',
    'src/main/java/com/acme/app/util/Helper.kt',
  ]);
  // 同 package 内没被引用的纯逻辑文件：严格模式不得纳入
  assert.equal(pathsOf(report, 'include').includes('src/main/java/com/acme/app/Stale.kt'), false);
  assert.equal(pathsOf(report, 'include').includes('src/main/java/com/acme/app/model/UnusedModel.kt'), false);
  // via 记录来源
  assert.ok(findFile(report, '/Local.kt').vias.includes('same-package'));
  assert.ok(findFile(report, '/model/Widget.kt').vias.includes('star-import'));
  assert.ok(findFile(report, '/util/Helper.kt').vias.includes('import'));
  assert.deepEqual(findFile(report, KOTLIN_ENTRY).vias, ['entry']);
  // 循环依赖：A↔B 各出现一次，不重复、不丢
  assert.equal(report.files.filter((file) => file.path.includes('/cycle/')).length, 2);
  const perPath = new Map<string, number>();
  for (const file of report.files) perPath.set(file.path, (perPath.get(file.path) ?? 0) + 1);
  for (const count of perPath.values()) assert.equal(count, 1);
});

test('耦合边界：命中 platformPatterns 的文件记为 boundary，带证据与需要的声明', () => {
  const report = reportOf(KOTLIN_ROOT, KOTLIN_ENTRY, ['--no-package-complete']);
  assert.deepEqual(pathsOf(report, 'coupled'), ['src/main/java/com/acme/app/platform/Clock.kt']);
  assert.equal(report.boundaries.length, 1);
  const boundary = report.boundaries[0];
  assert.equal(boundary.file, 'src/main/java/com/acme/app/platform/Clock.kt');
  assert.ok(boundary.reason.includes('android.os.SystemClock'));
  assert.ok(boundary.evidence.some((line) => line.includes('import android.os.SystemClock')));
  assert.deepEqual(boundary.patterns, [0]);
  assert.deepEqual(boundary.symbols.map((symbol) => symbol.name), ['Clock']);
  assert.deepEqual(boundary.neededBy, [{ file: KOTLIN_ENTRY, symbols: ['Clock'] }]);
  // 手工抽取模块的来源映射：耦合文件里被闭包需要的声明 → 声明名 + 来源文件 + 需要方
  assert.deepEqual(report.manualExtractions.map((item) => item.symbol), ['Clock']);
  assert.equal(report.manualExtractions[0].declaredIn, boundary.file);
  assert.deepEqual(report.manualExtractions[0].neededBy, [KOTLIN_ENTRY]);
});

test('只用于注解的平台 import 不算耦合，记入 removableImports', () => {
  const report = reportOf(KOTLIN_ROOT, KOTLIN_ENTRY, ['--no-package-complete']);
  const annotated = findFile(report, '/model/Annotated.kt');
  assert.equal(annotated.role, 'include');
  assert.equal(annotated.coupled, false);
  assert.deepEqual(report.removableImports, [
    {
      symbol: 'androidx.compose.runtime.Stable',
      fromFile: 'src/main/java/com/acme/app/model/Annotated.kt',
      usage: 'annotation-only',
    },
  ]);
  assert.equal(report.unresolved.some((row) => row.symbol.includes('androidx')), false);
});

test('unresolved：外部依赖记 external，缺失内部符号记 internal，内部可解析符号不得出现', () => {
  const report = reportOf(KOTLIN_ROOT, KOTLIN_ENTRY, ['--no-package-complete']);
  const internal = report.unresolved.filter((row) => row.kind === 'internal');
  const external = report.unresolved.filter((row) => row.kind === 'external');
  assert.deepEqual(internal.map((row) => row.symbol), ['com.acme.app.ghost.Ghost']);
  assert.deepEqual(external.map((row) => row.symbol), ['java.util.List']);
  const symbols = report.unresolved.map((row) => row.symbol);
  for (const symbol of ['com.acme.app.util.Helper', 'com.acme.app.model.Widget', 'Clock', 'com.acme.app.Local']) {
    assert.equal(symbols.includes(symbol), false, '内部可解析符号不应进 unresolved：' + symbol);
  }
});

test('默认 package 补全：纳入同 package 纯逻辑 peer，但不碰未被引用的耦合文件', () => {
  const report = reportOf(KOTLIN_ROOT, KOTLIN_ENTRY);
  assert.equal(report.packageComplete, true);
  const include = pathsOf(report, 'include');
  assert.ok(include.includes('src/main/java/com/acme/app/Stale.kt'));
  assert.ok(include.includes('src/main/java/com/acme/app/model/UnusedModel.kt'));
  assert.equal(include.length, 9);
  assert.equal(report.totals.include, 9);
  assert.equal(report.totals.coupled, 1);
  assert.equal(report.totals.test, 0);
  assert.ok(findFile(report, '/Stale.kt').vias.includes('package-peer'));
  assert.equal(report.files.some((file) => file.path.endsWith('UnusedPlatform.kt')), false);
});

test('--out：只复制 include 文件，保持原相对路径且内容不变', () => {
  withTempDir((dir) => {
    const outDir = join(dir, 'src');
    const result = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--out', outDir, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as Report;
    const include = pathsOf(report, 'include');
    assert.equal(include.length, 9);
    for (const rel of include) assert.ok(existsSync(join(outDir, rel)), '缺少复制产物：' + rel);
    assert.equal(existsSync(join(outDir, 'src/main/java/com/acme/app/platform/Clock.kt')), false);
    const source = readFileSync(join(KOTLIN_ROOT, KOTLIN_ENTRY), 'utf8');
    assert.equal(readFileSync(join(outDir, KOTLIN_ENTRY), 'utf8'), source);
  });
});

test('--report 写出的 JSON 与 --json 的 stdout 完全一致', () => {
  withTempDir((dir) => {
    const reportPath = join(dir, 'nested/report.json');
    const result = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--report', reportPath, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(reportPath, 'utf8'), result.stdout);
  });
});

test('确定性输出：同输入两次 --json 完全一致', () => {
  const first = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--json']);
  const second = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--json']);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);
});

test('Java：import 与同包引用解析，外部依赖进 unresolved', () => {
  const report = reportOf(JAVA_ROOT, JAVA_ENTRY);
  assert.deepEqual(pathsOf(report, 'include'), [
    'src/main/java/com/acme/japp/App.java',
    'src/main/java/com/acme/japp/Local.java',
    'src/main/java/com/acme/japp/util/Tool.java',
  ]);
  assert.deepEqual(report.boundaries, []);
  assert.deepEqual(report.manualExtractions, []);
  const external = report.unresolved.filter((row) => row.kind === 'external');
  assert.deepEqual(external.map((row) => row.symbol), ['java.util.List']);
  assert.equal(report.unresolved.some((row) => row.kind === 'internal'), false);
});

test('测试源集：生产 entry 的闭包不含 test 文件；以 test 文件为 entry 时角色记 test', () => {
  const production = reportOf(KOTLIN_ROOT, KOTLIN_ENTRY);
  assert.equal(production.totals.test, 0);
  assert.equal(production.files.some((file) => file.path.includes('/src/test/')), false);
  const fromTest = reportOf(KOTLIN_ROOT, KOTLIN_TEST_ENTRY, ['--no-package-complete']);
  assert.equal(fromTest.entry, KOTLIN_TEST_ENTRY);
  const entryRow = fromTest.files.find((file) => file.path === KOTLIN_TEST_ENTRY);
  assert.ok(entryRow, 'test entry 应出现在报告里');
  assert.equal((entryRow as ReportFile).role, 'test');
  assert.equal(fromTest.totals.test, 1);
  assert.ok(pathsOf(fromTest, 'include').includes('src/main/java/com/acme/app/util/Helper.kt'));
});

test('--out 越界：等于/位于 --root 内 → exit 2 且不落盘；父目录也拒绝；root 外正常', () => {
  withTempDir((dir) => {
    const insideRoot = join(KOTLIN_ROOT, 'nested-out');
    const insideResult = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--out', insideRoot]);
    assert.equal(insideResult.status, 2);
    assert.ok(insideResult.stderr.includes('--root'));
    assert.equal(existsSync(insideRoot), false, '--out 越界时不应创建目录');

    const equalResult = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--out', KOTLIN_ROOT]);
    assert.equal(equalResult.status, 2);
    const parentResult = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--out', dirname(KOTLIN_ROOT)]);
    assert.equal(parentResult.status, 2);

    // root 之外正常写入
    const outside = join(dir, 'src');
    const ok = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--out', outside]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(outside, KOTLIN_ENTRY)));
  });
});

test('--force：允许 --out 位于 --root 内（打警告），但等于 --root / 源码目录仍拒绝', () => {
  withTempDir((dir) => {
    const project = join(dir, 'project');
    const entryRel = 'src/main/java/demo/A.kt';
    mkdirSync(dirname(join(project, entryRel)), { recursive: true });
    writeFileSync(join(project, entryRel), 'package demo\n\nfun run(): Int = 1\n', 'utf8');

    // 非安全子目录默认拒绝
    const refused = runCli(['--root', project, '--entry', entryRel, '--out', join(project, 'nested-out')]);
    assert.equal(refused.status, 2);
    assert.equal(existsSync(join(project, 'nested-out')), false);

    // --force 在安全子目录上仍可用（打警告）
    const forced = runCli(['--root', project, '--entry', entryRel, '--out', join(project, 'out'), '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(forced.stderr.includes('警告'));
    assert.ok(existsSync(join(project, 'out', entryRel)));

    // --force 也允许非安全子目录（前提是目录里没有源码文件）
    const forcedNested = runCli(['--root', project, '--entry', entryRel, '--out', join(project, 'nested-out'), '--force']);
    assert.equal(forcedNested.status, 0, forcedNested.stderr);
    assert.ok(forcedNested.stderr.includes('警告'));

    const stillRefused = runCli(['--root', project, '--entry', entryRel, '--out', project, '--force']);
    assert.equal(stillRefused.status, 2);

    // 源码目录即使 --force 也拒绝（fail-closed）
    const sourceRefused = runCli(['--root', project, '--entry', entryRel, '--out', join(project, 'src'), '--force']);
    assert.equal(sourceRefused.status, 2);
    assert.match(sourceRefused.stderr, /源码目录/);
  });
});

test('安全子目录默认可用：--out 位于 --root 内的 .refs/out/dist/build 不再需要 --force', () => {
  withTempDir((dir) => {
    const project = join(dir, 'project');
    const entryRel = 'src/main/java/demo/A.kt';
    mkdirSync(dirname(join(project, entryRel)), { recursive: true });
    writeFileSync(join(project, entryRel), 'package demo\n\nfun run(): Int = 1\n', 'utf8');
    for (const sub of ['.refs/closure', 'out', 'dist', 'build']) {
      const outDir = join(project, sub);
      const res = runCli(['--root', project, '--entry', entryRel, '--out', outDir]);
      assert.equal(res.status, 0, sub + ': ' + res.stderr);
      assert.ok(existsSync(join(outDir, entryRel)), sub + ' 应复制 include 文件');
    }
  });
});

test('--allow-out-in-root：放行非安全子目录，但已有源码文件的目录仍 fail-closed', () => {
  withTempDir((dir) => {
    const project = join(dir, 'project');
    const entryRel = 'src/main/java/demo/A.kt';
    const source = 'package demo\n\nfun run(): Int = 1\n';
    mkdirSync(dirname(join(project, entryRel)), { recursive: true });
    writeFileSync(join(project, entryRel), source, 'utf8');

    const nested = join(project, 'nested-out');
    const refused = runCli(['--root', project, '--entry', entryRel, '--out', nested]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--allow-out-in-root/);
    assert.equal(existsSync(nested), false);

    const allowed = runCli(['--root', project, '--entry', entryRel, '--out', nested, '--allow-out-in-root']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.ok(allowed.stderr.includes('警告'));
    assert.ok(existsSync(join(nested, entryRel)));

    const sourceRefused = runCli(['--root', project, '--entry', entryRel, '--out', join(project, 'src'), '--allow-out-in-root']);
    assert.equal(sourceRefused.status, 2);
    assert.match(sourceRefused.stderr, /源码目录/);
    assert.equal(readFileSync(join(project, entryRel), 'utf8'), source, '源码文件不应被覆盖');
  });
});

test('--out 清理受管目录：删旧产物、保留用户文件；没有清单的目录不动任何文件', () => {
  withTempDir((dir) => {
    const outDir = join(dir, 'src');
    const first = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--out', outDir]);
    assert.equal(first.status, 0, first.stderr);
    const manifestPath = join(outDir, '.extract-closure-manifest.json');
    assert.ok(existsSync(manifestPath), '应写入受管清单');
    const manifest1 = JSON.parse(readFileSync(manifestPath, 'utf8')) as { tool: string; version: number; files: string[] };
    assert.equal(manifest1.tool, 'extract-closure');
    assert.equal(manifest1.version, 1);
    assert.equal(manifest1.files.length, 9);
    assert.ok(manifest1.files.includes('src/main/java/com/acme/app/Stale.kt'));

    // 用户在输出目录里放自己的文件（不在清单里）
    writeFileSync(join(outDir, 'notes.txt'), 'keep me', 'utf8');
    mkdirSync(join(outDir, 'user'), { recursive: true });
    writeFileSync(join(outDir, 'user/Own.kt'), 'package user\n\nclass Own\n', 'utf8');

    // 第二次运行：--no-package-complete 后 Stale.kt / UnusedModel.kt 不再 include → 旧产物应被清理
    const second = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--no-package-complete', '--out', outDir]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(existsSync(join(outDir, 'src/main/java/com/acme/app/Stale.kt')), false, '旧产物应被清理');
    assert.equal(existsSync(join(outDir, 'src/main/java/com/acme/app/model/UnusedModel.kt')), false, '旧产物应被清理');
    assert.ok(existsSync(join(outDir, 'notes.txt')), '用户文件不能被删');
    assert.ok(existsSync(join(outDir, 'user/Own.kt')), '用户目录里的文件不能被删');
    const manifest2 = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: string[] };
    assert.equal(manifest2.files.length, 7);
    assert.equal(manifest2.files.includes('src/main/java/com/acme/app/Stale.kt'), false);

    // 没有清单的目录：不删任何已有文件（即使同名 .kt）
    const freshDir = join(dir, 'fresh');
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(freshDir, 'Legacy.kt'), 'package legacy\n\nclass Legacy\n', 'utf8');
    const third = runCli(['--root', KOTLIN_ROOT, '--entry', KOTLIN_ENTRY, '--out', freshDir]);
    assert.equal(third.status, 0, third.stderr);
    assert.ok(existsSync(join(freshDir, 'Legacy.kt')), '无清单目录不得删文件');
  });
});

test('identCache 以 root 作用域化：同一进程连续跑两个工程，结果不串味', () => {
  withTempDir((dir) => {
    const rootA = join(dir, 'projectA');
    const rootB = join(dir, 'projectB');
    const writeProject = (root: string, entryBody: string, sharedBody: string): void => {
      mkdirSync(join(root, 'pkg'), { recursive: true });
      writeFileSync(join(root, 'pkg/Entry.kt'), 'package demo\n\n' + entryBody + '\n', 'utf8');
      writeFileSync(join(root, 'pkg/Shared.kt'), 'package demo\n\n' + sharedBody + '\n', 'utf8');
    };
    writeProject(rootA, 'fun run(): Int = Shared.value()', 'object Shared { val value: Int = 1 }');
    writeProject(rootB, 'fun run(): Int = 2', 'object Shared { val value: Int = 9 }');

    const includePaths = (report: { files: { path: string; role: string }[] }): string[] =>
      report.files.filter((file) => file.role === 'include').map((file) => file.path).sort();

    const indexA = scanProject(rootA, 'jvm');
    const reportA = extractClosure(indexA, 'pkg/Entry.kt', { root: rootA, entry: 'pkg/Entry.kt', packageComplete: false });
    assert.deepEqual(includePaths(reportA), ['pkg/Entry.kt', 'pkg/Shared.kt']);

    const indexB = scanProject(rootB, 'jvm');
    assert.notEqual(indexA.identCache, indexB.identCache, '每个工程应有独立缓存');
    const reportB = extractClosure(indexB, 'pkg/Entry.kt', { root: rootB, entry: 'pkg/Entry.kt', packageComplete: false });
    // 旧实现用模块级缓存（key 只有相对路径），这里会把 A 工程 Entry.kt 的引用带进来
    assert.deepEqual(includePaths(reportB), ['pkg/Entry.kt']);

    // 同一个 index 重复抽取结果稳定（缓存命中不改变结果）
    const reportA2 = extractClosure(indexA, 'pkg/Entry.kt', { root: rootA, entry: 'pkg/Entry.kt', packageComplete: false });
    assert.deepEqual(includePaths(reportA2), ['pkg/Entry.kt', 'pkg/Shared.kt']);
    assert.ok(indexA.identCache.size > 0);
  });
});

// ---------------------------------------------------------------- js-ts

const WEB_ROOT = '/mnt/d/Project/legado-with-MD3/modules/web';

const JS_FIXTURE: { path: string; content: string }[] = [
  {
    path: 'src/a.js',
    content: [
      "import b from './b'",
      "import { utilA, utilB } from './lib/util'",
      "import { isNative } from './platform/native'",
      "import { aValue } from './cycle/a'",
      "import { consumer } from './next/consumer'",
      "const legacy = require('./cjs/legacy')",
      '',
      'export async function loadWidget() {',
      "  const m = await import('./dynamic/widget')",
      '  return m.widgetValue',
      '}',
      '',
      'export default function run() {',
      '  return b() + utilA() + utilB() + legacy.value + (isNative ? 1 : 0) + aValue + consumer',
      '}',
      '',
    ].join('\n'),
  },
  {
    path: 'src/b.js',
    content: [
      "import { helper } from './lib/helpers'",
      "import lodash from 'lodash'",
      "import ghost from './missing/mod'",
      '',
      'export default function b() {',
      '  return helper() + (lodash ? 1 : 0) + (ghost ? 1 : 0)',
      '}',
      '',
    ].join('\n'),
  },
  { path: 'src/lib/util.ts', content: ["import { format } from 'date-fns'", '', 'export function utilA(): number { return 2 }', 'export const utilB = (): number => 3', ''].join('\n') },
  { path: 'src/lib/helpers/index.ts', content: 'export function helper(): number { return 1 }\n' },
  { path: 'src/dynamic/widget.ts', content: 'export const widgetValue = 42\n' },
  { path: 'src/cjs/legacy.js', content: 'module.exports = { value: 2 }\n' },
  {
    path: 'src/platform/native.ts',
    content: ["import { Platform } from 'react-native'", '', "export const isNative = Platform.OS === 'ios'", ''].join('\n'),
  },
  { path: 'src/platform/unreferenced.js', content: 'const href = window.location.href\nmodule.exports = { href }\n' },
  { path: 'src/cycle/a.ts', content: ["import { bValue } from './b'", '', 'export const aValue = bValue + 1', ''].join('\n') },
  { path: 'src/cycle/b.ts', content: ["import { aValue } from './a'", '', 'export const bValue = aValue + 1', ''].join('\n') },
  { path: 'src/next/consumer.ts', content: ["import { impl } from './impl.js'", '', 'export const consumer = impl', ''].join('\n') },
  { path: 'src/next/impl.ts', content: 'export const impl = 1\n' },
];

function withJsFixture(fn: (root: string, workDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'arkts-jsfix-'));
  // workDir 放在工程外（默认路径）；--out 在 --root 内只允许 .refs/out/dist/build 等安全子目录
  const workDir = mkdtempSync(join(tmpdir(), 'arkts-jswork-'));
  for (const file of JS_FIXTURE) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  try {
    fn(root, workDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function jsReport(root: string, entry: string, extra: string[] = []): Report {
  const result = runCli(['--root', root, '--lang', 'js-ts', '--entry', entry, '--json', ...extra]);
  assert.equal(result.status, 0, 'js-ts CLI 退出码应为 0，stderr：' + result.stderr);
  return JSON.parse(result.stdout) as Report;
}

test('js-ts 闭包：ESM/CJS/动态 import/循环依赖/目录 index/扩展名互换 + 耦合边界', () => {
  withJsFixture((root) => {
    const report = jsReport(root, 'src/a.js');
    assert.equal(report.lang, 'js-ts');
    assert.equal(report.entryPackage, '');
    assert.equal(report.packageComplete, false);
    assert.deepEqual(pathsOf(report, 'include'), [
      'src/a.js',
      'src/b.js',
      'src/cjs/legacy.js',
      'src/cycle/a.ts',
      'src/cycle/b.ts',
      'src/dynamic/widget.ts',
      'src/lib/helpers/index.ts',
      'src/lib/util.ts',
      'src/next/consumer.ts',
      'src/next/impl.ts',
    ]);
    // 命中 react-native 的文件是 coupled boundary，不深入；没人引用的耦合文件不出现
    assert.deepEqual(pathsOf(report, 'coupled'), ['src/platform/native.ts']);
    assert.equal(report.files.some((file) => file.path === 'src/platform/unreferenced.js'), false);
    assert.equal(report.totals.include, 10);
    assert.equal(report.totals.coupled, 1);
    // 循环依赖各出现一次
    const perPath = new Map<string, number>();
    for (const file of report.files) perPath.set(file.path, (perPath.get(file.path) ?? 0) + 1);
    for (const count of perPath.values()) assert.equal(count, 1);
    // 未解析：相对导入断链记 internal，npm 包记 external
    assert.deepEqual(report.unresolved.map((row) => row.kind + ':' + row.symbol).sort(), [
      'external:date-fns',
      'external:lodash',
      'internal:./missing/mod',
    ]);
    // boundary 证据 + 被需要的导出名
    assert.equal(report.boundaries.length, 1);
    const boundary = report.boundaries[0];
    assert.equal(boundary.file, 'src/platform/native.ts');
    assert.ok(boundary.reason.includes('react-native'));
    assert.ok(boundary.evidence.some((line) => line.includes("from 'react-native'")));
    assert.deepEqual(boundary.symbols.map((symbol) => symbol.name), ['isNative']);
    assert.deepEqual(boundary.neededBy, [{ file: 'src/a.js', symbols: ['isNative'] }]);
  });
});

test('js-ts 的 --out：复制 include、保留越界守卫与受管清单，不复制 boundary', () => {
  withJsFixture((root, workDir) => {
    const outDir = join(workDir, 'copy');
    const result = runCli(['--root', root, '--lang', 'js-ts', '--entry', 'src/a.js', '--out', outDir]);
    assert.equal(result.status, 0, result.stderr);
    const report = jsReport(root, 'src/a.js');
    for (const rel of pathsOf(report, 'include')) assert.ok(existsSync(join(outDir, rel)), '缺少复制产物 ' + rel);
    assert.equal(existsSync(join(outDir, 'src/platform/native.ts')), false, 'boundary 不应被复制');
    const manifest = JSON.parse(readFileSync(join(outDir, '.extract-closure-manifest.json'), 'utf8')) as { files: string[] };
    assert.equal(manifest.files.length, 10);
    // 越界守卫对 js-ts 同样生效：非安全子目录仍拒绝
    const inside = runCli(['--root', root, '--lang', 'js-ts', '--entry', 'src/a.js', '--out', join(root, 'nested-out')]);
    assert.equal(inside.status, 2);
    assert.equal(existsSync(join(root, 'nested-out')), false);
    // 安全子目录（out/）默认允许，不再需要 --force
    const safe = runCli(['--root', root, '--lang', 'js-ts', '--entry', 'src/a.js', '--out', join(root, 'out')]);
    assert.equal(safe.status, 0, safe.stderr);
    assert.ok(existsSync(join(root, 'out', 'src/a.js')), 'out/ 安全子目录应复制 include 文件');
  });
});

test('js-ts 确定性 + 语言参数校验：两次 --json 逐字节相同；不支持的语言 exit 2、.kt 入口 exit 1', () => {
  withJsFixture((root) => {
    const first = runCli(['--root', root, '--lang', 'js-ts', '--entry', 'src/a.js', '--json']);
    const second = runCli(['--root', root, '--lang', 'js-ts', '--entry', 'src/a.js', '--json']);
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(first.stdout, second.stdout);
    assert.equal(runCli(['--root', root, '--lang', 'dart', '--entry', 'src/a.js']).status, 2);
    writeFileSync(join(root, 'src/NotJs.kt'), 'package demo\n\nclass NotJs\n', 'utf8');
    assert.equal(runCli(['--root', root, '--lang', 'js-ts', '--entry', 'src/NotJs.kt']).status, 1);
  });
});

test('js-ts smoke：modules/web 真实入口（缺目录时跳过）', { skip: !existsSync(WEB_ROOT) }, () => {
  const result = runCli(['--root', WEB_ROOT, '--lang', 'js-ts', '--entry', 'src/utils/souce.ts', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Report;
  assert.equal(report.lang, 'js-ts');
  const include = pathsOf(report, 'include');
  assert.ok(include.includes('src/utils/souce.ts'));
  assert.ok(include.includes('src/utils/utils.ts'), '相对导入 ./utils 应解析到 src/utils/utils.ts');
  assert.ok(include.includes('src/source.d.ts'), '相对导入 ../source 应解析到 src/source.d.ts');
  // 真实工程里不应出现「内部可解析符号混进 unresolved」；npm 包按契约记 external
  assert.equal(report.unresolved.filter((row) => row.kind === 'internal').length, 0);
  assert.ok(report.unresolved.some((row) => row.kind === 'external'));
  for (const rel of include) assert.ok(existsSync(join(WEB_ROOT, rel)), '报告路径应真实存在：' + rel);
});

// ---------------------------------------------------------------- js-ts 别名（tsconfig paths / vite alias）

function withJsProject(files: { path: string; content: string }[], fn: (root: string, workDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'arkts-jsalias-'));
  const workDir = mkdtempSync(join(tmpdir(), 'arkts-jsalias-work-'));
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  try {
    fn(root, workDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

const TSCONFIG_FILES: { path: string; content: string }[] = [
  {
    path: 'tsconfig.json',
    content: [
      '{',
      '  // solution 风格：真正的 paths 在 tsconfig.app.json（顺带验证 JSONC 注释/尾逗号）',
      '  "files": [],',
      '  "references": [',
      '    { "path": "./tsconfig.app.json" },',
      '  ],',
      '}',
      '',
    ].join('\n'),
  },
  {
    path: 'tsconfig.app.json',
    content: [
      '{',
      '  "compilerOptions": {',
      '    "baseUrl": ".",',
      '    "paths": {',
      '      "@/*": ["./src/*"],',
      '      "@api": ["./src/api"],',
      '      "@utils/*": ["./src/utils/*"],',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n'),
  },
  {
    path: 'src/main.ts',
    content: [
      "import { add } from '@/utils/math'",
      "import { api } from '@api'",
      "import { nope } from '@/missing/thing'",
      '',
      'export const total = add(1, 2) + api.length + (nope ? 1 : 0)',
      '',
    ].join('\n'),
  },
  { path: 'src/utils/math.ts', content: 'export function add(a: number, b: number): number { return a + b }\n' },
  { path: 'src/api/index.ts', content: 'export const api = [1, 2, 3]\n' },
];

test('js-ts 别名：tsconfig.json references + JSONC + baseUrl/paths 解析 @/ 与 @api', () => {
  withJsProject(TSCONFIG_FILES, (root) => {
    const report = jsReport(root, 'src/main.ts');
    assert.deepEqual(pathsOf(report, 'include'), ['src/api/index.ts', 'src/main.ts', 'src/utils/math.ts']);
    assert.equal(report.aliasesEnabled, true);
    assert.equal(report.totals.include, 3);
    assert.ok(report.aliasConfigs.includes('tsconfig.json'));
    assert.ok(report.aliasConfigs.includes('tsconfig.app.json'));
    assert.deepEqual(report.aliases, [
      { specifier: '@/utils/math', alias: '@/*', target: 'src/utils/math', fromFile: 'src/main.ts', source: 'tsconfig' },
      { specifier: '@api', alias: '@api', target: 'src/api', fromFile: 'src/main.ts', source: 'tsconfig' },
    ]);
    // alias 断链：kind=external，但带 alias/target 并单独说明
    const broken = report.unresolved.filter((row) => row.alias !== undefined);
    assert.equal(broken.length, 1);
    assert.equal(broken[0].symbol, '@/missing/thing');
    assert.equal(broken[0].kind, 'external');
    assert.equal(broken[0].alias, '@/*');
    assert.equal(broken[0].target, 'src/missing/thing');
    assert.ok(broken[0].reason.includes('alias 断链'));
    assert.equal(report.unresolved.filter((row) => row.kind === 'internal').length, 0);
  });
});

test('js-ts 别名：vite resolve.alias 对象写法（fileURLToPath / path.resolve / 根相对）', () => {
  const files: { path: string; content: string }[] = [
    {
      path: 'vite.config.ts',
      content: [
        "import { fileURLToPath, URL } from 'node:url'",
        "import path from 'node:path'",
        '',
        'export default {',
        '  resolve: {',
        '    alias: {',
        "      '@': fileURLToPath(new URL('./app', import.meta.url)),",
        "      '~': path.resolve(__dirname, 'legacy'),",
        "      '@css': '/styles',",
        '      ignored: someExpression,',
        '    },',
        '  },',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'app/main.js',
      content: [
        "import { helper } from '@/lib/helper'",
        "import { old } from '~/old'",
        "import { theme } from '@css/theme'",
        "import { x } from 'ignored/x'",
        '',
        'export const value = helper + old + theme + (x ? 1 : 0)',
        '',
      ].join('\n'),
    },
    { path: 'app/lib/helper.js', content: 'export const helper = 1\n' },
    { path: 'legacy/old.js', content: 'export const old = 2\n' },
    { path: 'styles/theme.js', content: 'export const theme = 3\n' },
  ];
  withJsProject(files, (root) => {
    const report = jsReport(root, 'app/main.js');
    assert.deepEqual(pathsOf(report, 'include'), ['app/lib/helper.js', 'app/main.js', 'legacy/old.js', 'styles/theme.js']);
    assert.equal(report.aliases.length, 3);
    const bySpecifier = new Map(report.aliases.map((hit) => [hit.specifier, hit]));
    assert.deepEqual(bySpecifier.get('@/lib/helper'), { specifier: '@/lib/helper', alias: '@', target: 'app/lib/helper', fromFile: 'app/main.js', source: 'vite' });
    assert.deepEqual(bySpecifier.get('~/old'), { specifier: '~/old', alias: '~', target: 'legacy/old', fromFile: 'app/main.js', source: 'vite' });
    assert.deepEqual(bySpecifier.get('@css/theme'), { specifier: '@css/theme', alias: '@css', target: 'styles/theme', fromFile: 'app/main.js', source: 'vite' });
    assert.ok(report.aliasConfigs.includes('vite.config.ts'));
    // 解析不了的 alias 值不猜：ignored/x 仍记 external（无 alias 信息）
    const ignored = report.unresolved.find((row) => row.symbol === 'ignored/x');
    assert.ok(ignored);
    assert.equal(ignored!.kind, 'external');
    assert.equal(ignored!.alias, undefined);
  });
});

test('js-ts 别名：--no-alias 关闭解析；确定性', () => {
  withJsProject(TSCONFIG_FILES, (root) => {
    const off = jsReport(root, 'src/main.ts', ['--no-alias']);
    assert.equal(off.aliasesEnabled, false);
    assert.deepEqual(off.aliases, []);
    assert.deepEqual(off.aliasConfigs, []);
    assert.deepEqual(pathsOf(off, 'include'), ['src/main.ts']);
    const external = off.unresolved.filter((row) => row.kind === 'external');
    assert.deepEqual(external.map((row) => row.symbol).sort(), ['@/missing/thing', '@/utils/math', '@api']);
    for (const row of external) assert.equal(row.alias, undefined);

    const first = runCli(['--root', root, '--lang', 'js-ts', '--entry', 'src/main.ts', '--json']);
    const second = runCli(['--root', root, '--lang', 'js-ts', '--entry', 'src/main.ts', '--json']);
    assert.equal(first.status, 0);
    assert.equal(first.stdout, second.stdout);
  });
});

test('js-ts 别名：vite alias 数组写法（find/replacement）', () => {
  const files: { path: string; content: string }[] = [
    {
      path: 'vite.config.js',
      content: [
        'export default {',
        '  resolve: {',
        '    alias: [',
        "      { find: '@lib', replacement: '/lib' },",
        '    ],',
        '  },',
        '}',
        '',
      ].join('\n'),
    },
    { path: 'app.ts', content: ["import { util } from '@lib/util'", '', 'export const v = util', ''].join('\n') },
    { path: 'lib/util.js', content: 'export const util = 1\n' },
  ];
  withJsProject(files, (root) => {
    const report = jsReport(root, 'app.ts');
    assert.deepEqual(pathsOf(report, 'include'), ['app.ts', 'lib/util.js']);
    assert.deepEqual(report.aliases, [
      { specifier: '@lib/util', alias: '@lib', target: 'lib/util', fromFile: 'app.ts', source: 'vite' },
    ]);
  });
});

test('js-ts 别名：配置解析失败不猜（坏 JSON）→ alias 关掉、记 external', () => {
  const files: { path: string; content: string }[] = [
    { path: 'tsconfig.json', content: '{ 这不是合法 JSON ' },
    { path: 'src/main.ts', content: ["import { a } from '@/a'", '', 'export const v = a', ''].join('\n') },
    { path: 'src/a.ts', content: 'export const a = 1\n' },
  ];
  withJsProject(files, (root) => {
    const report = jsReport(root, 'src/main.ts');
    assert.deepEqual(pathsOf(report, 'include'), ['src/main.ts']);
    assert.deepEqual(report.aliasConfigs, []);
    assert.deepEqual(report.aliases, []);
    assert.equal(report.aliasesEnabled, true);
    assert.equal(report.unresolved.length, 1);
    assert.equal(report.unresolved[0].kind, 'external');
    assert.equal(report.unresolved[0].symbol, '@/a');
    assert.equal(report.unresolved[0].alias, undefined);
  });
});

test('js-ts 别名 smoke：modules/web 真实入口（@/ 命中、alias 断链标注、external 减少）', { skip: !existsSync(WEB_ROOT) }, () => {
  const withAlias = runCli(['--root', WEB_ROOT, '--lang', 'js-ts', '--entry', 'src/api/index.ts', '--json']);
  assert.equal(withAlias.status, 0, withAlias.stderr);
  const report = JSON.parse(withAlias.stdout) as Report;
  assert.ok(report.aliases.length >= 2, '真实入口应命中 @/ 与 @ 等 alias');
  assert.ok(report.aliasConfigs.includes('vite.config.ts'));
  assert.ok(report.aliasConfigs.some((config) => config.startsWith('tsconfig')));
  assert.ok(pathsOf(report, 'include').includes('src/utils/utils.ts'), '@/utils/utils 应解析到 src/utils/utils.ts');
  assert.equal(report.unresolved.filter((row) => row.kind === 'internal').length, 0);
  const broken = report.unresolved.filter((row) => row.alias !== undefined);
  assert.ok(broken.some((row) => row.symbol === '@/App.vue' && row.reason.includes('alias 断链')));

  const withoutAlias = runCli(['--root', WEB_ROOT, '--lang', 'js-ts', '--entry', 'src/api/index.ts', '--no-alias', '--json']);
  assert.equal(withoutAlias.status, 0, withoutAlias.stderr);
  const plain = JSON.parse(withoutAlias.stdout) as Report;
  const externalWith = report.unresolved.filter((row) => row.kind === 'external').length;
  const externalWithout = plain.unresolved.filter((row) => row.kind === 'external').length;
  assert.ok(externalWith < externalWithout, 'alias 打开后 external 应减少：' + externalWith + ' vs ' + externalWithout);
  assert.ok(plain.totals.include <= report.totals.include);
});

