import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * CLI 健壮性 P0 验收（spawn 真实 cli/*.ts）：
 * - --help exit 0 且不误扫；未知参数/缺取值/缺前置 exit 2
 * - lint/probe 把 WARN 级 arkts 规则计入门禁；干净工程仍 0/PASS
 * - verify-fidelity 缺失场景算 FAIL 且不崩溃
 * - build-hap 摘要含 BUILD SUCCESSFUL/失败摘要，原始日志落盘
 * 全部用临时目录 + 假 hvigor，不依赖真实 SDK/工程。
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Env {
  dir: string;
  project: string;
  sdk: string;
  hvigor: string;
}

function makeTmp(t: TestHooks, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(name: string, args: string[], cwd: string): RunResult {
  const res = spawnSync(process.execPath, [join(repoRoot, 'cli', name + '.ts'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function parseJson(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>;
}

function writeFakeHvigor(hvigor: string, stdout: string, exitCode = 0): void {
  const script = 'process.stdout.write(' + JSON.stringify(stdout) + ');\n' +
    'process.exit(' + exitCode + ');\n';
  writeFileSync(join(hvigor, '@ohos', 'hvigor', 'bin', 'hvigor.js'), script, 'utf8');
}

/** 最小工程 + SDK 26.0.0/ets + 假 hvigor（默认构建成功） */
function makeEnv(t: TestHooks, prefix = 'arkts-cli-'): Env {
  const dir = makeTmp(t, prefix);
  const project = join(dir, 'project');
  mkdirSync(join(project, 'entry', 'src', 'main', 'ets', 'pages'), { recursive: true });
  writeFileSync(
    join(project, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'),
    'export const index = 1;\n',
    'utf8',
  );
  const sdk = join(dir, 'sdk');
  mkdirSync(join(sdk, '26.0.0', 'ets'), { recursive: true });
  const hvigor = join(dir, 'hvigor');
  mkdirSync(join(hvigor, '@ohos', 'hvigor', 'bin'), { recursive: true });
  writeFakeHvigor(hvigor, 'BUILD SUCCESSFUL in 1 ms\n', 0);
  return { dir, project, sdk, hvigor };
}

// ---------------------------------------------------------------------------
// analyze-coupling
// ---------------------------------------------------------------------------

test('analyze-coupling: --help exit 0 且不扫描 cwd（P0 实测 bug）', () => {
  const res = runCli('analyze-coupling', ['--help'], repoRoot);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /node cli\/analyze-coupling\.ts/);
  assert.match(res.stdout, /退出码/);
  assert.doesNotMatch(res.stdout, /文件 \d+，总行数/);
  assert.doesNotMatch(res.stdout, /模块级耦合率/);
});

test('analyze-coupling: 未知/位置参数/缺取值/坏 root 一律 exit 2', () => {
  const cases: string[][] = [
    ['--bogus'],
    ['oops'],
    ['--root'],
    ['--lang', 'cobol'],
    ['--top', '0'],
    ['--top', 'abc'],
    ['--root', join(tmpdir(), 'arkts-no-such-root-xyz')],
  ];
  for (const args of cases) {
    const res = runCli('analyze-coupling', args, repoRoot);
    assert.equal(res.code, 2, '应 exit 2：' + args.join(' '));
    assert.match(res.stderr, /analyze-coupling: /);
  }
});

test('analyze-coupling: --json 排序确定（loc+path，不受 readdir 顺序影响）', (t) => {
  const dir = makeTmp(t, 'arkts-analyze-');
  mkdirSync(join(dir, 'src'), { recursive: true });
  // 反序创建：若实现依赖 readdir 顺序，b.ts 会排在 a.ts 前
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

  const first = runCli('analyze-coupling', ['--root', 'src', '--json'], dir);
  const second = runCli('analyze-coupling', ['--root', 'src', '--json'], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, second.stdout, '同输入两次 --json 必须逐字相同');

  const json = parseJson(first.stdout);
  assert.equal(json.files, 2);
  assert.equal(json.root, 'src');
  assert.deepEqual(json.languages, ['js-ts']);
  assert.deepEqual(json.largestPureFiles.map((f: any) => f.path), ['a.ts', 'b.ts']);
  assert.deepEqual(json.topModules.map((m: any) => m.pkg), ['a.ts', 'b.ts']);

  const human = runCli('analyze-coupling', ['--root', 'src'], dir);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /文件 2，总行数 4/);
  assert.match(human.stdout, /可自动转写 4 行 = 100%/);
});

// ---------------------------------------------------------------------------
// verify-fidelity
// ---------------------------------------------------------------------------

function writeFidelityFixtures(dir: string, golden: unknown, actual: unknown): void {
  writeFileSync(join(dir, 'golden.json'), JSON.stringify(golden), 'utf8');
  writeFileSync(join(dir, 'actual.json'), JSON.stringify(actual), 'utf8');
}

test('verify-fidelity: --help / 未知参数 / 缺参数 / 文件缺失', (t) => {
  const dir = makeTmp(t, 'arkts-fidelity-');
  const help = runCli('verify-fidelity', ['--help'], dir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /node cli\/verify-fidelity\.ts/);

  for (const args of [['--bogus'], ['plain'], ['--golden'], []]) {
    const res = runCli('verify-fidelity', args, dir);
    assert.equal(res.code, 2, '应 exit 2：' + args.join(' '));
    assert.match(res.stderr, /verify-fidelity: /);
  }

  const missing = runCli('verify-fidelity', ['--golden', 'nope.json', '--actual', 'nope.json'], dir);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /无法读取 --golden/);
});

test('verify-fidelity: 缺失场景算 FAIL（MISSING，不崩溃）', (t) => {
  const dir = makeTmp(t, 'arkts-fidelity-');
  writeFidelityFixtures(
    dir,
    [{ scenario: 'A', pages: [{ text: 'a' }] }, { scenario: 'B', pages: [{ text: 'b' }] }],
    [{ scenario: 'A', pages: [{ text: 'a' }] }],
  );

  const human = runCli('verify-fidelity', ['--golden', 'golden.json', '--actual', 'actual.json'], dir);
  assert.equal(human.code, 1, '缺失场景必须 exit 1');
  assert.match(human.stdout, /MISSING B/);
  assert.doesNotMatch(human.stdout, /TypeError|undefined\/undefined/);
  assert.equal(human.stderr, '');
  assert.match(human.stdout, /门禁: FAIL/);

  const json = runCli('verify-fidelity', ['--golden', 'golden.json', '--actual', 'actual.json', '--json'], dir);
  assert.equal(json.code, 1);
  const parsed = parseJson(json.stdout);
  assert.equal(parsed.pass, false);
  assert.equal(parsed.missingScenarios, 1);
  assert.equal(parsed.sameScenarios, 1);
  assert.equal(parsed.totalScenarios, 2);
});

test('verify-fidelity: 一致 PASS / 逐字不等 DIFF FAIL（回归）', (t) => {
  const dir = makeTmp(t, 'arkts-fidelity-');
  const golden = [{ scenario: 'A', pages: [{ text: 'a' }] }];
  writeFidelityFixtures(dir, golden, golden);
  const pass = runCli('verify-fidelity', ['--golden', 'golden.json', '--actual', 'actual.json'], dir);
  assert.equal(pass.code, 0);
  assert.match(pass.stdout, /保真度: 100%/);
  assert.match(pass.stdout, /门禁: PASS/);

  writeFidelityFixtures(dir, golden, [{ scenario: 'A', pages: [{ text: 'A' }] }]);
  const diff = runCli('verify-fidelity', ['--golden', 'golden.json', '--actual', 'actual.json'], dir);
  assert.equal(diff.code, 1);
  assert.match(diff.stdout, /DIFF A/);
  assert.match(diff.stdout, /门禁: FAIL/);
});

// ---------------------------------------------------------------------------
// lint-arkts
// ---------------------------------------------------------------------------

test('lint-arkts: --help / 未知参数 / 工程不存在 exit 2，绝不输出假 0', (t) => {
  const help = runCli('lint-arkts', ['--help'], repoRoot);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /node cli\/lint-arkts\.ts/);

  const bogus = runCli('lint-arkts', ['--bogus'], repoRoot);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /lint-arkts: /);

  const noProject = runCli('lint-arkts', ['--project', join(tmpdir(), 'arkts-no-project-xyz')], repoRoot);
  assert.equal(noProject.code, 2);
  assert.doesNotMatch(noProject.stdout, /ArkTS 错误数: 0/);
});

test('lint-arkts: 缺 SDK / 缺 hvigor 前置校验 exit 2（对齐 build-hap）', (t) => {
  const dir = makeTmp(t, 'arkts-lint-');
  mkdirSync(join(dir, 'project'), { recursive: true });

  const noSdk = runCli('lint-arkts', ['--project', 'project'], dir);
  assert.equal(noSdk.code, 2);
  assert.match(noSdk.stderr, /SDK/);

  mkdirSync(join(dir, 'sdk', '26.0.0', 'ets'), { recursive: true });
  const noHvigor = runCli('lint-arkts', ['--project', 'project', '--sdk', 'sdk'], dir);
  assert.equal(noHvigor.code, 2);
  assert.match(noHvigor.stderr, /hvigor/);
});

test('lint-arkts: 干净构建 0/PASS，默认日志写 out/logs 而非工程内', (t) => {
  const env = makeEnv(t, 'arkts-lint-');
  writeFakeHvigor(env.hvigor, 'BUILD SUCCESSFUL in 1 ms\n', 0);
  const res = runCli('lint-arkts', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor,
  ], env.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /ArkTS 错误数: 0/);
  assert.match(res.stdout, /门禁: PASS/);
  assert.ok(existsSync(join(env.dir, 'out', 'logs', 'lint-arkts.log')), '默认日志应在 cwd/out/logs');
  assert.equal(existsSync(join(env.project, '.arkts-lint.log')), false, '默认不应写工程内');
});

test('lint-arkts: WARN 级 arkts 规则计入错误数并 FAIL（globalThis 实测）', (t) => {
  const env = makeEnv(t, 'arkts-lint-');
  const warnLog = [
    '\u001b[33m1 WARN: \u001b[33m\u001b[33mArkTS:WARN File: /abs/proj/entry/src/main/ets/pages/Index.ets:5:9',
    ' "globalThis" is not supported (arkts-no-globalthis)',
    '\u001b[39m\u001b[39m',
    '\u001b[32mBUILD SUCCESSFUL in 1 ms',
  ].join('\n') + '\n';
  writeFakeHvigor(env.hvigor, warnLog, 0);

  const res = runCli('lint-arkts', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor,
  ], env.dir);
  assert.equal(res.code, 1, 'WARN 级 arkts 违规必须 FAIL');
  assert.match(res.stdout, /ArkTS 错误数: 1/);
  assert.match(res.stdout, /其中 WARN 级: 1/);
  assert.match(res.stdout, /门禁: FAIL/);

  const reportPath = join(env.dir, 'lint-report.json');
  const jsonRun = runCli('lint-arkts', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor,
    '--json', '--report', reportPath,
  ], env.dir);
  assert.equal(jsonRun.code, 1);
  const json = parseJson(jsonRun.stdout);
  assert.equal(json.arktsErrors, 1);
  assert.equal(json.warnArktsErrors, 1);
  assert.equal(json.pass, false);
  assert.equal(json.errors[0].level, 'WARN');
  assert.equal(parseJson(readFileSync(reportPath, 'utf8')).arktsErrors, 1);
});

test('lint-arkts: ERROR+WARN 混合计数，--log-in-project 才写工程内', (t) => {
  const env = makeEnv(t, 'arkts-lint-');
  const mixed = [
    '\u001b[31mError Message: Object literal must correspond to some explicitly declared class or interface (arkts-no-untyped-obj-literals) At File: /abs/p/Index.ets:3:5',
    '\u001b[33m1 WARN: \u001b[33m\u001b[33mArkTS:WARN File: /abs/p/Index.ets:5:9',
    ' "globalThis" is not supported (arkts-no-globalthis)',
    '\u001b[39m\u001b[39m',
  ].join('\n') + '\n';
  writeFakeHvigor(env.hvigor, mixed, 1);

  const res = runCli('lint-arkts', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor, '--log-in-project',
  ], env.dir);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /ArkTS 错误数: 2/);
  assert.match(res.stdout, /其中 WARN 级: 1/);
  assert.ok(existsSync(join(env.project, '.arkts-lint.log')), '--log-in-project 应写工程内');
});

// ---------------------------------------------------------------------------
// reachability-probe
// ---------------------------------------------------------------------------

test('reachability-probe: --help / 未知参数 / 缺工程 / 缺入口 exit 2', (t) => {
  const help = runCli('reachability-probe', ['--help'], repoRoot);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /node cli\/reachability-probe\.ts/);

  const bogus = runCli('reachability-probe', ['--bogus'], repoRoot);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /reachability-probe: /);

  const noProject = runCli('reachability-probe', ['--project', join(tmpdir(), 'arkts-no-probe-xyz')], repoRoot);
  assert.equal(noProject.code, 2);

  const env = makeEnv(t, 'arkts-probe-');
  rmSync(join(env.project, 'entry'), { recursive: true, force: true });
  const noEntry = runCli('reachability-probe', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor,
  ], env.dir);
  assert.equal(noEntry.code, 2);
  assert.match(noEntry.stderr, /找不到源目录或入口页/);
});

test('reachability-probe: 干净工程 0/PASS + --json/--report 结构', (t) => {
  const env = makeEnv(t, 'arkts-probe-');
  mkdirSync(join(env.project, 'entry', 'src', 'main', 'ets', 'model'), { recursive: true });
  writeFileSync(join(env.project, 'entry', 'src', 'main', 'ets', 'model', 'Extra.ets'),
    'export const extra = 1;\n', 'utf8');
  writeFakeHvigor(env.hvigor, 'BUILD SUCCESSFUL in 1 ms\n', 0);

  const res = runCli('reachability-probe', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor,
  ], env.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /探针模块数: 1/);
  assert.match(res.stdout, /ArkTS 错误数: 0/);
  assert.match(res.stdout, /门禁: PASS/);

  const reportPath = join(env.dir, 'reach.json');
  const jsonRun = runCli('reachability-probe', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor,
    '--json', '--report', reportPath,
  ], env.dir);
  assert.equal(jsonRun.code, 0);
  const json = parseJson(jsonRun.stdout);
  assert.equal(json.probeModules, 1);
  assert.equal(json.arktsErrors, 0);
  assert.equal(json.pass, true);
  assert.equal(parseJson(readFileSync(reportPath, 'utf8')).probeModules, 1);
});

test('reachability-probe: WARN 级 arkts 规则计入错误数并 FAIL', (t) => {
  const env = makeEnv(t, 'arkts-probe-');
  mkdirSync(join(env.project, 'entry', 'src', 'main', 'ets', 'model'), { recursive: true });
  writeFileSync(join(env.project, 'entry', 'src', 'main', 'ets', 'model', 'Extra.ets'),
    'export const extra = 1;\n', 'utf8');
  const warnLog = [
    '\u001b[33m1 WARN: \u001b[33m\u001b[33mArkTS:WARN File: /tmp/arkts-probe-123/entry/src/main/ets/model/Extra.ets:1:1',
    ' "globalThis" is not supported (arkts-no-globalthis)',
    '\u001b[39m\u001b[39m',
    '\u001b[32mBUILD SUCCESSFUL in 1 ms',
  ].join('\n') + '\n';
  writeFakeHvigor(env.hvigor, warnLog, 0);

  const res = runCli('reachability-probe', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor,
  ], env.dir);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /ArkTS 错误数: 1/);
  assert.match(res.stdout, /其中 WARN 级: 1/);
  assert.match(res.stdout, /门禁: FAIL/);
});

// ---------------------------------------------------------------------------
// build-hap
// ---------------------------------------------------------------------------

test('build-hap: --help / 未知参数 / 工程不存在 / 缺 SDK exit 2', (t) => {
  const help = runCli('build-hap', ['--help'], repoRoot);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /node cli\/build-hap\.ts/);

  const bogus = runCli('build-hap', ['--bogus'], repoRoot);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /build-hap: /);

  const noProject = runCli('build-hap', ['--project', join(tmpdir(), 'arkts-no-build-xyz')], repoRoot);
  assert.equal(noProject.code, 2);
  assert.match(noProject.stderr, /--project 目录不存在/);

  const env = makeEnv(t, 'arkts-build-');
  rmSync(join(env.sdk, '26.0.0'), { recursive: true, force: true });
  const noSdk = runCli('build-hap', ['--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor], env.dir);
  assert.equal(noSdk.code, 2);
  assert.match(noSdk.stderr, /SDK/);
});

test('build-hap: 成功只输出摘要（含 BUILD SUCCESSFUL），原始日志落盘', (t) => {
  const env = makeEnv(t, 'arkts-build-');
  const okLog = [
    '> hvigor Finished :entry:default@PreBuild... ',
    '> hvigor Finished :entry:default@CompileArkTS... ',
    '> hvigor UP-TO-DATE :entry:default@PackageHap... ',
    '> hvigor Finished :entry:default@SignHap... ',
    '> hvigor BUILD SUCCESSFUL in 826 ms ',
    '33 tasks in total: 14 executed, 19 up-to-date',
  ].join('\n') + '\n';
  writeFakeHvigor(env.hvigor, okLog, 0);

  const res = runCli('build-hap', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor,
  ], env.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /BUILD SUCCESSFUL/);
  assert.match(res.stdout, /任务: 33 total/);
  assert.match(res.stdout, /阶段: .*CompileArkTS=Finished/);
  assert.doesNotMatch(res.stdout, /^> hvigor/m, '默认 stdout 只留摘要');
  const logPath = join(env.dir, 'out', 'logs', 'build-hap.log');
  assert.ok(existsSync(logPath));
  assert.match(readFileSync(logPath, 'utf8'), /> hvigor .*CompileArkTS/);
});

test('build-hap: 失败摘要含错误行 + BUILD FAILED，--log 可覆盖路径', (t) => {
  const env = makeEnv(t, 'arkts-build-');
  const failLog = [
    '> hvigor Failed :entry:default@CompileArkTS... ',
    'Error Message: Object literals cannot be used as type declarations (arkts-no-obj-literals-as-types) At File: /x/Index.ets:13:24',
    '[2026-01-01T00:00:00.000] [ERROR] debug-file - BUILD FAILED in 4 s 449 ms',
  ].join('\n') + '\n';
  writeFakeHvigor(env.hvigor, failLog, 1);

  const customLog = join(env.dir, 'custom', 'build.log');
  const res = runCli('build-hap', [
    '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor, '--log', customLog,
  ], env.dir);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /错误摘要: .*arkts-no-obj-literals-as-types/);
  assert.match(res.stdout, /构建失败（exit 1）/);
  assert.doesNotMatch(res.stdout, /BUILD SUCCESSFUL/);
  assert.ok(existsSync(customLog));
  assert.match(readFileSync(customLog, 'utf8'), /BUILD FAILED/);
});
