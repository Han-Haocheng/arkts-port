import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测仓库里的 cli/gen-golden.ts；默认用假 kotlinc/kotlin（PATH 注入），真实编译器用例会自动 t.skip。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const genGoldenPath = join(repoRoot, 'cli', 'gen-golden.ts');

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface GenReport {
  ok: boolean;
  stage: string;
  message: string;
  lang: string;
  src: string | null;
  main: string | null;
  package: string | null;
  mainClass: string | null;
  classesDir: string | null;
  goldenPath: string | null;
  runs: number;
  stable: boolean;
  compile: { exitCode: number | null; durationMs: number };
  run: { exitCode: number | null; durationMs: number };
  warnings: string[];
  logPath: string | null;
  goldenSha256?: string | null;
  goldenBytes?: number | null;
  skeletonPath?: string;
  skeletonSource?: string;
  runDurations?: number[];
  nodeVersion?: string | null;
}

function makeTmp(t: TestHooks): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-port-golden-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 假工具链：kotlinc 可控退出码；kotlin 支持 stable/unstable/timestamp 三种输出模式。 */
function makeFakeToolchain(t: TestHooks): string {
  const bin = join(makeTmp(t), 'bin');
  mkdirSync(bin, { recursive: true });
  const kotlinc = [
    '#!/bin/sh',
    'echo "fake-kotlinc $@"',
    'if [ -n "$FAKE_KOTLINC_STDERR" ]; then echo "$FAKE_KOTLINC_STDERR" >&2; fi',
    'if [ -z "$FAKE_KOTLINC_EXIT" ]; then FAKE_KOTLINC_EXIT=0; fi',
    'exit $FAKE_KOTLINC_EXIT',
    '',
  ].join('\n');
  const kotlin = [
    '#!/bin/sh',
    'if [ -n "$FAKE_KOTLIN_ARGS" ]; then printf "%s" "$*" > "$FAKE_KOTLIN_ARGS"; fi',
    'if [ -n "$FAKE_KOTLIN_MODE" ]; then mode=$FAKE_KOTLIN_MODE; else mode=stable; fi',
    'if [ "$mode" = "unstable" ]; then',
    '  n=0',
    '  if [ -f "$FAKE_COUNTER" ]; then n=$(cat "$FAKE_COUNTER"); fi',
    '  n=$((n+1))',
    '  printf "%s" "$n" > "$FAKE_COUNTER"',
    '  printf "run-%s" "$n"',
    'elif [ "$mode" = "timestamp" ]; then',
    '  printf "%s" \'{"builtAt":"2026-11-09T18:30:00"}\'',
    'elif [ -n "$FAKE_KOTLIN_STDOUT" ]; then',
    '  printf "%s" "$FAKE_KOTLIN_STDOUT"',
    'else',
    '  printf "%s" \'{"scenario":"s1","pages":[]}\'',
    'fi',
    'if [ -n "$FAKE_KOTLIN_STDERR" ]; then echo "$FAKE_KOTLIN_STDERR" >&2; fi',
    'if [ -z "$FAKE_KOTLIN_EXIT" ]; then FAKE_KOTLIN_EXIT=0; fi',
    'exit $FAKE_KOTLIN_EXIT',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'kotlinc'), kotlinc, 'utf8');
  writeFileSync(join(bin, 'kotlin'), kotlin, 'utf8');
  chmodSync(join(bin, 'kotlinc'), 0o755);
  chmodSync(join(bin, 'kotlin'), 0o755);
  return bin;
}

function makeFixture(t: TestHooks, mainSource: string, mainFileName = 'Main.kt') {
  const root = makeTmp(t);
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  const main = join(src, mainFileName);
  writeFileSync(main, mainSource, 'utf8');
  return { root, src, main, out: join(root, 'out'), logs: join(root, 'logs') };
}

function runGen(
  args: string[],
  cwd: string,
  envOverride: Record<string, string> = {},
): RunResult {
  const res = spawnSync(process.execPath, [genGoldenPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...envOverride },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function fakeEnv(toolchainBin: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: toolchainBin + ':' + (process.env.PATH ?? ''), ...extra };
}

function baseArgs(fixture: { src: string; main: string; out: string; logs: string }): string[] {
  return [
    '--lang', 'jvm',
    '--src', fixture.src,
    '--main', fixture.main,
    '--out', fixture.out,
    '--logs', fixture.logs,
  ];
}

function readJson(path: string): GenReport {
  return JSON.parse(readFileSync(path, 'utf8')) as GenReport;
}

function humanLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.trim() !== '');
}

function logOf(fixtureRoot: string, report: GenReport): string {
  const path = String(report.logPath);
  return isAbsolute(path) ? path : join(fixtureRoot, path);
}

const TOP_LEVEL_MAIN = [
  'package fixture',
  '',
  'fun main() {',
  '    println("hello")',
  '}',
  '',
].join('\n');

const OBJECT_MAIN = [
  'package fixture',
  '',
  'object Main {',
  '    @JvmStatic',
  '    fun main(args: Array<String>) {',
  '        println("hello")',
  '    }',
  '}',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// 参数校验 / 缺 harness
// ---------------------------------------------------------------------------

test('参数校验：缺 --lang、非 jvm、缺 --src、目录不存在、未知参数 → exit 2', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const badArgs: string[][] = [
    [],
    ['--lang', 'dart', '--src', fixture.src],
    ['--lang', 'jvm'],
    ['--lang', 'jvm', '--src', join(fixture.root, 'nope')],
    ['--lang', 'jvm', '--src', fixture.src, '--bogus'],
    ['--lang', 'jvm', '--src', fixture.src, '--main'],
    ['--lang', 'jvm', '--src', fixture.src, '--main', fixture.main, '--timeout', 'abc'],
  ];
  for (const args of badArgs) {
    const res = runGen(args, fixture.root);
    assert.equal(res.code, 2, '应报用法错误：' + JSON.stringify(args));
    assert.match(res.stderr, /gen-golden: /);
  }
});

test('越界防护：--out 在 --src 内 / 等于 --src / --logs 在 --src 内 → exit 2 且不写文件', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const before = readdirSync(fixture.src).sort();
  const cases: string[][] = [
    ['--out', join(fixture.src, 'generated'), '--logs', fixture.logs],
    ['--out', fixture.src, '--logs', fixture.logs],
    ['--out', fixture.out, '--logs', join(fixture.src, 'logs')],
  ];
  for (const extra of cases) {
    const res = runGen(['--lang', 'jvm', '--src', fixture.src, '--main', fixture.main, ...extra], fixture.root);
    assert.equal(res.code, 2, '越界应 exit 2：' + JSON.stringify(extra) + '\n' + res.stdout + res.stderr);
    assert.match(res.stderr, /不能等于或位于 --src 内|不能位于 --src 内/);
  }
  assert.deepEqual(readdirSync(fixture.src).sort(), before, '--src 目录内容不得变化');
  assert.equal(existsSync(join(fixture.src, 'generated')), false);
  assert.equal(existsSync(join(fixture.src, 'logs')), false);
});

test('越界防护优先于缺 harness：--out 在 --src 内时 exit 2、不写骨架', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const res = runGen(
    ['--lang', 'jvm', '--src', fixture.src, '--out', join(fixture.src, 'out'), '--logs', fixture.logs],
    fixture.root,
  );
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.equal(existsSync(join(fixture.src, 'out', 'Main.kt')), false);
});

test('--src . 时默认 --out 落在 src 内 → exit 2；显式指到外部才可运行', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);

  const blocked = runGen(
    ['--lang', 'jvm', '--src', '.', '--main', fixture.main, '--logs', fixture.logs],
    fixture.root,
  );
  assert.equal(blocked.code, 2, blocked.stdout + blocked.stderr);
  assert.match(blocked.stderr, /--out 不能等于或位于 --src 内/);

  // --src . 时 src 覆盖整个 cwd，out/logs 必须显式指到 cwd 之外
  const outside = makeTmp(t);
  const allowed = runGen(
    ['--lang', 'jvm', '--src', '.', '--main', fixture.main,
      '--out', join(outside, 'out'), '--logs', join(outside, 'logs')],
    fixture.root,
    fakeEnv(toolchain),
  );
  assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
});

test('缺 harness：exit 4，复制骨架到 <out>/Main.kt，未生成 golden', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const reportPath = join(fixture.root, 'report.json');
  const res = runGen(
    ['--lang', 'jvm', '--src', fixture.src, '--out', fixture.out, '--logs', fixture.logs, '--json', '--report', reportPath],
    fixture.root,
  );
  assert.equal(res.code, 4, res.stdout + res.stderr);

  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'harness');
  assert.equal(report.goldenPath, null);
  assert.ok(report.skeletonPath !== undefined && report.skeletonPath.endsWith(join('out', 'Main.kt')));
  assert.ok(existsSync(join(fixture.out, 'Main.kt')), '骨架应复制到 <out>/Main.kt');
  assert.equal(existsSync(join(fixture.out, 'golden.json')), false);
  assert.deepEqual(readJson(reportPath), report);
  assert.match(readFileSync(join(fixture.out, 'Main.kt'), 'utf8'), /object Main|fun main/);
});

test('缺 harness（人类输出）：exit 4 且给出骨架路径与 TODO', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const missingMain = join(fixture.src, 'NotThere.kt');
  const res = runGen(
    ['--lang', 'jvm', '--src', fixture.src, '--main', missingMain, '--out', fixture.out, '--logs', fixture.logs],
    fixture.root,
    fakeEnv(makeFakeToolchain(t)),
  );
  assert.equal(res.code, 4, res.stdout + res.stderr);
  assert.match(res.stdout, /harness/);
  assert.match(res.stdout, /TODO/);
  assert.match(res.stdout, /HARNESS/);
  assert.ok(existsSync(join(fixture.out, 'Main.kt')));
});

// ---------------------------------------------------------------------------
// 成功路径 / 报告字段 / golden 字节
// ---------------------------------------------------------------------------

test('成功：exit 0，报告字段完整，golden 与 stdout 逐字节一致', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);
  const reportPath = join(fixture.root, 'report.json');
  const expectedOutput = '{"scenario":"s1","pages":[]}';
  const argsPath = join(fixture.root, 'kotlin-args.txt');

  const res = runGen(
    [...baseArgs(fixture), '--json', '--report', reportPath],
    fixture.root,
    fakeEnv(toolchain, {
      FAKE_KOTLIN_STDOUT: expectedOutput,
      FAKE_KOTLIN_ARGS: argsPath,
    }),
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);

  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, true);
  assert.equal(report.lang, 'jvm');
  assert.equal(report.package, 'fixture');
  assert.equal(report.mainClass, 'MainKt');
  assert.equal(report.runs, 2);
  assert.equal(report.stable, true);
  assert.equal(report.compile.exitCode, 0);
  assert.equal(typeof report.compile.durationMs, 'number');
  assert.equal(report.run.exitCode, 0);
  assert.equal(typeof report.run.durationMs, 'number');
  assert.deepEqual(report.warnings, []);
  assert.equal(typeof report.classesDir, 'string');
  assert.equal(typeof report.goldenPath, 'string');
  assert.equal(report.goldenBytes, Buffer.byteLength(expectedOutput));
  assert.equal(typeof report.goldenSha256, 'string');
  assert.match(String(report.logPath), /gen-golden\.log$/);
  assert.ok(existsSync(join(fixture.out, 'golden.json')));
  assert.equal(readFileSync(join(fixture.out, 'golden.json'), 'utf8'), expectedOutput);

  // 主类名按 Kotlin 约定推出（顶层 fun main → MainKt）
  assert.match(readFileSync(argsPath, 'utf8'), /fixture\.MainKt/);

  // 日志落盘：编译 + 两次运行
  const log = readFileSync(logOf(fixture.root, report), 'utf8');
  assert.match(log, /# 编译（kotlinc）/);
  assert.match(log, /# 运行 #1（kotlin）/);
  assert.match(log, /# 运行 #2（kotlin）/);

  // --json 与 --report 是同一份
  assert.deepEqual(readJson(reportPath), report);
});

test('成功（人类输出）：≤10 行，含包名/耗时/一致/golden/日志', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);
  const res = runGen(baseArgs(fixture), fixture.root, fakeEnv(toolchain));
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const lines = humanLines(res.stdout);
  assert.ok(lines.length <= 10, '人类摘要应 ≤10 行，实际 ' + lines.length);
  assert.match(res.stdout, /fixture\.MainKt/);
  assert.match(res.stdout, /编译\s+kotlinc/);
  assert.match(res.stdout, /运行\s+kotlin 两次/);
  assert.match(res.stdout, /逐字节一致/);
  assert.match(res.stdout, /golden/);
  assert.match(res.stdout, /日志/);
  assert.match(res.stdout, /结果: OK/);
});

test('object Main：主类名是 Main（不是 MainKt）', (t) => {
  const fixture = makeFixture(t, OBJECT_MAIN);
  const toolchain = makeFakeToolchain(t);
  const res = runGen([...baseArgs(fixture), '--json'], fixture.root, fakeEnv(toolchain));
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.mainClass, 'Main');
});

test('--package 覆盖 Main.kt 里的 package', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);
  const argsPath = join(fixture.root, 'kotlin-args.txt');
  const res = runGen(
    [...baseArgs(fixture), '--package', 'other.pkg', '--json'],
    fixture.root,
    fakeEnv(toolchain, { FAKE_KOTLIN_ARGS: argsPath }),
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.package, 'other.pkg');
  assert.match(readFileSync(argsPath, 'utf8'), /other\.pkg\.MainKt/);
});

// ---------------------------------------------------------------------------
// 失败路径：不稳定 / 运行失败 / 编译失败 / 旧 golden 清理
// ---------------------------------------------------------------------------

test('输出不稳定：exit 3，两次不一致，不写 golden', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);
  const counter = join(fixture.root, 'counter.txt');
  const reportPath = join(fixture.root, 'report.json');
  const res = runGen(
    [...baseArgs(fixture), '--json', '--report', reportPath],
    fixture.root,
    fakeEnv(toolchain, { FAKE_KOTLIN_MODE: 'unstable', FAKE_COUNTER: counter }),
  );
  assert.equal(res.code, 3, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'stability');
  assert.equal(report.stable, false);
  assert.equal(report.runs, 2);
  assert.equal(existsSync(join(fixture.out, 'golden.json')), false);
  assert.deepEqual(readJson(reportPath), report);
});

test('运行失败：exit 1，报告 stage=run 且 run.exitCode 可见，stderr 进日志', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);
  const res = runGen(
    [...baseArgs(fixture), '--json'],
    fixture.root,
    fakeEnv(toolchain, { FAKE_KOTLIN_EXIT: '7', FAKE_KOTLIN_STDERR: 'boom-from-kotlin' }),
  );
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'run');
  assert.equal(report.run.exitCode, 7);
  assert.equal(report.runs, 1);
  const log = readFileSync(logOf(fixture.root, report), 'utf8');
  assert.match(log, /boom-from-kotlin/);
  assert.equal(existsSync(join(fixture.out, 'golden.json')), false);
});

test('编译失败：exit 1，stage=compile，日志保留编译器输出', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);
  const res = runGen(
    [...baseArgs(fixture), '--json'],
    fixture.root,
    fakeEnv(toolchain, { FAKE_KOTLINC_EXIT: '2', FAKE_KOTLINC_STDERR: 'expected ; at line 3' }),
  );
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.stage, 'compile');
  assert.equal(report.compile.exitCode, 2);
  assert.equal(report.runs, 0);
  const log = readFileSync(logOf(fixture.root, report), 'utf8');
  assert.match(log, /expected ; at line 3/);
  assert.match(report.message, /退出码 2/);

  // 人类输出也要说清「编译失败 + 日志路径」
  const human = runGen(
    baseArgs(fixture),
    fixture.root,
    fakeEnv(toolchain, { FAKE_KOTLINC_EXIT: '2', FAKE_KOTLINC_STDERR: 'expected ; at line 3' }),
  );
  assert.equal(human.code, 1);
  assert.match(human.stdout, /编译失败/);
  assert.match(human.stdout, /日志\s+logs\/gen-golden\.log/);
  assert.match(human.stdout, /结果: FAIL/);
});

test('旧 golden 不冒充新结果：先有 golden.json，编译失败后应被清掉', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);
  mkdirSync(fixture.out, { recursive: true });
  writeFileSync(join(fixture.out, 'golden.json'), 'stale-golden', 'utf8');
  const res = runGen(
    baseArgs(fixture),
    fixture.root,
    fakeEnv(toolchain, { FAKE_KOTLINC_EXIT: '1' }),
  );
  assert.equal(res.code, 1);
  assert.equal(existsSync(join(fixture.out, 'golden.json')), false);
});

// ---------------------------------------------------------------------------
// WARN（不阻塞）
// ---------------------------------------------------------------------------

test('输出含时间戳特征：WARN 但不失败（exit 0）', (t) => {
  const fixture = makeFixture(t, TOP_LEVEL_MAIN);
  const toolchain = makeFakeToolchain(t);
  const reportPath = join(fixture.root, 'report.json');
  const res = runGen(
    [...baseArgs(fixture), '--json', '--report', reportPath],
    fixture.root,
    fakeEnv(toolchain, { FAKE_KOTLIN_MODE: 'timestamp' }),
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, true);
  assert.ok(report.warnings.length >= 1, '应检测到时间戳特征');
  assert.match(report.warnings.join('；'), /时间戳/);
  assert.deepEqual(readJson(reportPath), report);
});

// ---------------------------------------------------------------------------
// 真实 kotlinc（无工具链时跳过；不依赖 .refs）
// ---------------------------------------------------------------------------

test('真实 kotlinc：小 fixture 编译跑两次并产出 golden', (t) => {
  const probe = spawnSync('kotlinc', ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('环境里没有 kotlinc，跳过真实编译用例');
    return;
  }
  const fixture = makeFixture(t, OBJECT_MAIN);
  const reportPath = join(fixture.root, 'report.json');
  const res = runGen(
    [...baseArgs(fixture), '--json', '--report', reportPath],
    fixture.root,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = readJson(reportPath);
  assert.equal(report.ok, true);
  assert.equal(report.stable, true);
  assert.equal(report.mainClass, 'Main');
  assert.equal(report.package, 'fixture');
  assert.equal(readFileSync(join(fixture.out, 'golden.json'), 'utf8'), 'hello\n');
});


// ---------------------------------------------------------------------------
// js-ts：node harness（无需编译；--main 所在目录作为源根做越界守卫）
// ---------------------------------------------------------------------------

interface JsFixture {
  root: string;
  harnessDir: string;
  main: string;
  out: string;
  logs: string;
}

function makeJsFixture(t: TestHooks, harnessSource: string, name = 'harness.mjs'): JsFixture {
  const root = makeTmp(t);
  const harnessDir = join(root, 'harness');
  mkdirSync(harnessDir, { recursive: true });
  const main = join(harnessDir, name);
  writeFileSync(main, harnessSource, 'utf8');
  return { root, harnessDir, main, out: join(root, 'out'), logs: join(root, 'logs') };
}

function jsArgs(f: JsFixture): string[] {
  return ['--lang', 'js-ts', '--main', f.main, '--out', f.out, '--logs', f.logs];
}

const STABLE_JS = [
  "const scenarios = [{ name: 's1', input: { n: 3 } }];",
  'const out = scenarios.map((s) => ({ scenario: s.name, result: s.input.n * 2 }));',
  'console.log(JSON.stringify(out));',
  '',
].join('\n');
const STABLE_JS_BYTES = '[{"scenario":"s1","result":6}]\n';

test('js-ts 参数校验：--src/--package/越界 out/logs/坏 timeout/未知参数 → exit 2', (t) => {
  const f = makeJsFixture(t, STABLE_JS);
  const cases: string[][] = [
    ['--lang', 'js-ts', '--main', f.main, '--src', f.harnessDir],
    ['--lang', 'js-ts', '--main', f.main, '--package', 'x'],
    ['--lang', 'js-ts', '--main', f.main, '--out', join(f.harnessDir, 'out')],
    ['--lang', 'js-ts', '--main', f.main, '--logs', join(f.harnessDir, 'logs')],
    ['--lang', 'js-ts', '--main', f.main, '--timeout', 'abc'],
    ['--lang', 'js-ts', '--main', f.main, '--bogus'],
    ['--lang', 'js-ts', '--main'],
  ];
  for (const args of cases) {
    const res = runGen(args, f.root);
    assert.equal(res.code, 2, '应 exit 2：' + JSON.stringify(args) + '\n' + res.stdout + res.stderr);
    assert.match(res.stderr, /gen-golden: /);
  }
  assert.equal(existsSync(join(f.harnessDir, 'out')), false, '越界不得写 --out');
  assert.equal(existsSync(join(f.harnessDir, 'logs')), false, '越界不得写 --logs');
});

test('js-ts 稳定输出：exit 0，golden 与 stdout 逐字节一致，报告字段完整', (t) => {
  const f = makeJsFixture(t, STABLE_JS);
  const reportPath = join(f.root, 'report.json');
  const res = runGen([...jsArgs(f), '--json', '--report', reportPath], f.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, true);
  assert.equal(report.lang, 'js-ts');
  assert.equal(report.src, null);
  assert.equal(report.main, join('harness', 'harness.mjs'));
  assert.equal(report.package, null);
  assert.equal(report.mainClass, null);
  assert.equal(report.classesDir, null);
  assert.match(String(report.nodeVersion), /^v\d+\./);
  assert.equal(report.runs, 2);
  assert.equal(report.stable, true);
  assert.equal(report.compile.exitCode, 0);
  assert.equal(typeof report.compile.durationMs, 'number');
  assert.equal(report.run.exitCode, 0);
  assert.equal(typeof report.run.durationMs, 'number');
  assert.ok(Array.isArray(report.runDurations) && report.runDurations.length === 2);
  assert.equal(report.goldenBytes, Buffer.byteLength(STABLE_JS_BYTES));
  assert.match(String(report.goldenPath), /golden\.json$/);
  assert.equal(readFileSync(join(f.out, 'golden.json'), 'utf8'), STABLE_JS_BYTES);
  assert.equal(readFileSync(join(f.out, 'golden.json')).length, Buffer.byteLength(STABLE_JS_BYTES));
  assert.equal(typeof report.goldenSha256, 'string');
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(readJson(reportPath), report);
  assert.deepEqual(readdirSync(f.harnessDir), ['harness.mjs'], '不得往 harness 源根写文件');
  const log = readFileSync(logOf(f.root, report), 'utf8');
  assert.match(log, /# 运行环境（node --version）/);
  assert.match(log, /# 运行 #1（node）/);
  assert.match(log, /# 运行 #2（node）/);
});

test('js-ts 人类输出：≤10 行，含 node/耗时/一致/golden/日志', (t) => {
  const f = makeJsFixture(t, STABLE_JS);
  const res = runGen(jsArgs(f), f.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const lines = humanLines(res.stdout);
  assert.ok(lines.length <= 10, '人类摘要应 ≤10 行，实际 ' + lines.length);
  assert.match(res.stdout, /lang=js-ts/);
  assert.match(res.stdout, /node v\d+\./);
  assert.match(res.stdout, /运行\s+node 两次/);
  assert.match(res.stdout, /逐字节一致/);
  assert.match(res.stdout, /golden/);
  assert.match(res.stdout, /日志/);
  assert.match(res.stdout, /结果: OK/);
});

test('js-ts 支持 .js harness（CommonJS 亦可）', (t) => {
  const f = makeJsFixture(t, "console.log(JSON.stringify([{ scenario: 's1', result: 'ok' }]));\n", 'harness.js');
  const res = runGen(jsArgs(f), f.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(readFileSync(join(f.out, 'golden.json'), 'utf8'), '[{"scenario":"s1","result":"ok"}]\n');
});

test('js-ts 输出不稳定：exit 3，两次不一致，不写 golden', (t) => {
  const f = makeJsFixture(t, "console.log(JSON.stringify([{ scenario: 's1', result: Math.random() }]));\n");
  const reportPath = join(f.root, 'report.json');
  const res = runGen([...jsArgs(f), '--json', '--report', reportPath], f.root);
  assert.equal(res.code, 3, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'stability');
  assert.equal(report.stable, false);
  assert.equal(report.runs, 2);
  assert.equal(existsSync(join(f.out, 'golden.json')), false);
  assert.deepEqual(readJson(reportPath), report);
});

test('js-ts 语法错误：exit 1，stage=run，日志保留 SyntaxError，不写 golden', (t) => {
  const f = makeJsFixture(t, "console.log('oops'\n");
  const res = runGen([...jsArgs(f), '--json'], f.root);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'run');
  assert.notEqual(report.run.exitCode, 0);
  assert.equal(report.runs, 1);
  assert.equal(existsSync(join(f.out, 'golden.json')), false);
  const log = readFileSync(logOf(f.root, report), 'utf8');
  assert.match(log, /SyntaxError|Unexpected/);
});

test('js-ts 缺 harness：exit 4，骨架复制到 <out>/harness.mjs，未生成 golden', (t) => {
  const f = makeJsFixture(t, STABLE_JS);
  const reportPath = join(f.root, 'report.json');
  const res = runGen(
    ['--lang', 'js-ts', '--out', f.out, '--logs', f.logs, '--json', '--report', reportPath],
    f.root,
  );
  assert.equal(res.code, 4, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'harness');
  assert.equal(report.goldenPath, null);
  assert.match(String(report.skeletonPath), /harness\.mjs$/);
  assert.equal(typeof report.skeletonSource, 'string');
  assert.ok(existsSync(join(f.out, 'harness.mjs')));
  assert.equal(existsSync(join(f.out, 'golden.json')), false);
  assert.match(readFileSync(join(f.out, 'harness.mjs'), 'utf8'), /console\.log\(JSON\.stringify\(out\)\)/);
  assert.deepEqual(readJson(reportPath), report);

  const human = runGen(['--lang', 'js-ts', '--out', join(f.root, 'out2'), '--logs', f.logs], f.root);
  assert.equal(human.code, 4);
  assert.match(human.stdout, /TODO/);
  assert.match(human.stdout, /HARNESS/);
});

test('js-ts 缺 harness（--main 不存在）→ exit 4；越界优先 → exit 2 且不写骨架', (t) => {
  const f = makeJsFixture(t, STABLE_JS);
  const missing = join(f.harnessDir, 'Nope.mjs');
  const ok = runGen(['--lang', 'js-ts', '--main', missing, '--out', f.out, '--logs', f.logs, '--json'], f.root);
  assert.equal(ok.code, 4, ok.stdout + ok.stderr);
  assert.ok(existsSync(join(f.out, 'harness.mjs')));

  const blocked = runGen(
    ['--lang', 'js-ts', '--main', missing, '--out', join(f.harnessDir, 'out'), '--logs', f.logs],
    f.root,
  );
  assert.equal(blocked.code, 2, blocked.stdout + blocked.stderr);
  assert.equal(existsSync(join(f.harnessDir, 'out', 'harness.mjs')), false);
});

test('js-ts 旧 golden 不冒充新结果：运行失败后应被清掉', (t) => {
  const f = makeJsFixture(t, "throw new Error('boom');\n");
  mkdirSync(f.out, { recursive: true });
  writeFileSync(join(f.out, 'golden.json'), 'stale-golden', 'utf8');
  const res = runGen(jsArgs(f), f.root);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.equal(existsSync(join(f.out, 'golden.json')), false);
});

test('js-ts 输出含时间戳：WARN 但不失败（exit 0）', (t) => {
  const f = makeJsFixture(t, "console.log(JSON.stringify([{ scenario: 's1', builtAt: '2026-11-09T18:30:00' }]));\n");
  const res = runGen([...jsArgs(f), '--json'], f.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as GenReport;
  assert.ok(report.warnings.length >= 1, '应检测到时间戳特征');
  assert.match(report.warnings.join('；'), /时间戳/);
});

test('js-ts 真实 node：3 行 harness 导入 .ts 纯逻辑并产出 golden', (t) => {
  const root = makeTmp(t);
  const srcDir = join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'math.ts'), 'export const double = (n: number): number => n * 2;\n', 'utf8');
  const harnessDir = join(root, 'harness');
  mkdirSync(harnessDir, { recursive: true });
  const main = join(harnessDir, 'harness.mjs');
  writeFileSync(main, [
    "import { double } from '../src/math.ts';",
    'const input = 21;',
    "console.log(JSON.stringify([{ scenario: 's1', result: double(input) }]));",
    '',
  ].join('\n'), 'utf8');
  const out = join(root, 'out');
  const res = runGen(['--lang', 'js-ts', '--main', main, '--out', out, '--logs', join(root, 'logs')], root);
  if (res.code !== 0 && /type stripp|Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED/i.test(res.stdout + res.stderr)) {
    t.skip('当前 node 不支持直接 import .ts（需 Node >=22.18 默认 type stripping）');
    return;
  }
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(readFileSync(join(out, 'golden.json'), 'utf8'), '[{"scenario":"s1","result":42}]\n');
});
