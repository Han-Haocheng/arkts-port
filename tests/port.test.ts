import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测仓库里的 cli/port.ts；涉及子工具的用例全部用临时目录 + 假工具，不依赖真实 SDK。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const portPath = join(repoRoot, 'cli', 'port.ts');

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function makeTmp(t: TestHooks, prefix = 'arkts-port-port-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runPort(args: string[], cwd: string, scriptPath = portPath): RunResult {
  const res = spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stageByName(report: Record<string, unknown>, name: string): Record<string, unknown> {
  const stage = asArray(report.stages).find((item) => {
    const record = item as Record<string, unknown>;
    return record.name === name;
  });
  assert.ok(stage, '报告里应有阶段：' + name);
  return stage as Record<string, unknown>;
}

/** 写一个假子工具：记录 argv/env，按需输出内容或写 --report 文件。 */
function writeFakeTool(
  cliDir: string,
  toolName: string,
  behavior: {
    stdout?: string;
    stderr?: string;
    exit?: number;
    writeReport?: boolean;
    report?: Record<string, unknown>;
    /** 模拟 adapt-arkts：有 residual 且传了 --fail-on-residual 时 exit 3 */
    exitOnFailOnResidual?: boolean;
  },
): void {
  const lines: string[] = [
    'import { mkdirSync, writeFileSync } from \'node:fs\';',
    'import { join } from \'node:path\';',
    'const argv = process.argv.slice(2);',
    'mkdirSync(\'calls\', { recursive: true });',
    'writeFileSync(join(\'calls\', ' + JSON.stringify(toolName + '.json') + '), JSON.stringify({',
    '  argv,',
    '  env: {',
    '    OHOS_BASE_SDK_HOME: process.env.OHOS_BASE_SDK_HOME ?? null,',
    '    NODE_PATH: process.env.NODE_PATH ?? null,',
    '    NODE_HOME: process.env.NODE_HOME ?? null,',
    '  },',
    '}));',
  ];
  if (behavior.writeReport) {
    const payload = behavior.report ?? { summary: { filesScanned: 3, filesChanged: 2, residuals: 1 } };
    lines.push(
      'const reportIndex = argv.indexOf(\'--report\');',
      'if (reportIndex >= 0) {',
      '  writeFileSync(argv[reportIndex + 1], ' + JSON.stringify(JSON.stringify(payload)) + ');',
      '}',
    );
    if (behavior.exitOnFailOnResidual === true) {
      const summary = (payload as { summary?: { residuals?: number } }).summary;
      const residuals = typeof summary?.residuals === 'number' ? summary.residuals : 0;
      if (residuals > 0) {
        lines.push(
          'if (argv.indexOf(\'--fail-on-residual\') >= 0) process.exit(3);',
        );
      }
    }
  }
  if (behavior.stdout !== undefined) lines.push('process.stdout.write(' + JSON.stringify(behavior.stdout) + ');');
  if (behavior.stderr !== undefined) lines.push('process.stderr.write(' + JSON.stringify(behavior.stderr) + ');');
  lines.push('process.exit(' + String(behavior.exit ?? 0) + ');');
  writeFileSync(join(cliDir, toolName + '.ts'), lines.join('\n') + '\n', 'utf8');
}

/**
 * 沙箱：cli/port.ts 的副本 + 6 个假子工具 + 最小工程/SDK/hvigor/案例目录。
 * port.ts 用自身路径定位兄弟工具，所以必须复制到沙箱的 cli/ 下。
 */
function makeSandbox(t: TestHooks): string {
  const dir = makeTmp(t);
  const cliDir = join(dir, 'cli');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  cpSync(portPath, join(cliDir, 'port.ts'));

  writeFakeTool(cliDir, 'analyze-coupling', {
    stdout: JSON.stringify({ files: 3, totalLoc: 120, autoConvertiblePct: 50, verdict: 'high' }),
  });
  writeFakeTool(cliDir, 'adapt-arkts', {
    writeReport: true,
    report: { summary: { filesScanned: 3, filesChanged: 2, residuals: 0 } },
    exitOnFailOnResidual: true,
  });
  writeFakeTool(cliDir, 'verify-fidelity', {
    stdout: JSON.stringify({
      totalItems: 4, sameItems: 4, fidelityPct: 100,
      sameScenarios: 2, totalScenarios: 2, missingScenarios: 0, pass: true,
    }),
  });
  writeFakeTool(cliDir, 'lint-arkts', {
    stdout: JSON.stringify({ pass: true, arktsErrors: 0, warnArktsErrors: 0 }),
  });
  writeFakeTool(cliDir, 'reachability-probe', {
    stdout: JSON.stringify({ pass: true, probeModules: 45, arktsErrors: 0, warnArktsErrors: 0 }),
  });
  writeFakeTool(cliDir, 'diff-gate', {
    stdout: JSON.stringify({
      ok: true,
      files: [],
      counts: { typeOnly: 7, importPath: 0, needsReview: 0, cannotPair: 0 },
    }),
  });
  writeFakeTool(cliDir, 'build-hap', { stdout: 'BUILD SUCCESSFUL\n' });
  writeFakeTool(cliDir, 'device-test', {
    stdout: JSON.stringify({
      ok: true, exitCode: 0, target: '10.0.0.1:1',
      check: { ok: true, connected: true, model: 'FakeDevice', message: 'connected' },
      install: { status: 'skipped' },
      launch: { status: 'skipped' },
      screenshot: { status: 'skipped', path: null },
      logPath: 'out/logs/device-test.log',
    }),
  });
  writeFakeTool(cliDir, 'arkts-fix', {
    writeReport: true,
    report: {
      ok: true,
      rules: {},
      files: [],
      totals: { files: 2, changed: 0, transforms: 0, skips: 0 },
    },
    stdout: JSON.stringify({ ok: true, rules: {}, totals: { files: 2, changed: 0, transforms: 0, skips: 0 } }),
  });

  // 最小前置：工程 + 入口页 / SDK 26.0.0 / hvigor / 源码 / 案例
  mkdirSync(join(dir, 'project', 'entry', 'src', 'main', 'ets', 'pages'), { recursive: true });
  writeFileSync(join(dir, 'project', 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), '\n', 'utf8');
  mkdirSync(join(dir, 'sdk', '26.0.0', 'ets'), { recursive: true });
  mkdirSync(join(dir, 'hvigor', '@ohos', 'hvigor', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'hvigor', '@ohos', 'hvigor', 'bin', 'hvigor.js'), '\n', 'utf8');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  mkdirSync(join(dir, 'adapted'), { recursive: true });
  mkdirSync(join(dir, 'case'), { recursive: true });
  const golden = [{ scenario: 's1', pages: [{ text: 'a' }] }];
  writeFileSync(join(dir, 'case', 'golden.json'), JSON.stringify(golden), 'utf8');
  writeFileSync(join(dir, 'case', 'actual.json'), JSON.stringify(golden), 'utf8');
  return dir;
}

function callOf(sandbox: string, toolName: string): { argv: string[]; env: Record<string, string | null> } {
  return readJson(join(sandbox, 'calls', toolName + '.json')) as {
    argv: string[];
    env: Record<string, string | null>;
  };
}

// ---------------------------------------------------------------------------
// --help 与参数校验
// ---------------------------------------------------------------------------

test('--help 打印用法并 exit 0', () => {
  const res = runPort(['--help'], repoRoot);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /node cli\/port\.ts/);
  assert.match(res.stdout, /退出码：0 = 没有 FAIL 且没有 SKIP（PASS\/WARN 通过）/);
  assert.match(res.stdout, /--strict-diff/);
  for (const flag of ['--device', '--signed-hap', '--bundle', '--ability', '--hdc', '--device-timeout',
    '--autofix', '--no-autofix', '--arkts-fix-out',
    '--fidelity-key', '--fidelity-items', '--fidelity-field']) {
    assert.ok(res.stdout.includes(flag), '--help 应包含 ' + flag);
  }
  assert.match(res.stdout, /fixed 目录只影响 diff/);
  assert.match(res.stdout, /lint\/reach\/build 仍按 --project/);
  assert.match(res.stdout, /WARN/);
  assert.match(res.stdout, /--stages/);
});

test('用法错误一律 exit 2', () => {
  const cases: string[][] = [
    ['--bogus'],
    ['--stages', 'bogus'],
    ['--stages', ''],
    ['--project'],
    ['--mode', 'fast'],
    ['--timeout', '-1'],
    ['--lang', 'cobol'],
    ['plain-arg'],
  ];
  for (const args of cases) {
    const res = runPort(args, repoRoot);
    assert.equal(res.code, 2, '参数应报用法错误：' + args.join(' '));
    assert.match(res.stderr, /port: /);
  }
});

// ---------------------------------------------------------------------------
// 缺前置 → SKIP（不算 PASS），并落日志/报告
// ---------------------------------------------------------------------------

test('缺 --case：fidelity SKIP，报告 pass=false 且默认路径落盘', (t) => {
  const dir = makeTmp(t);
  const res = runPort(['--stages', 'fidelity'], dir);
  assert.equal(res.code, 1, 'SKIP 不算通过，退出码应为 1');
  assert.match(res.stdout, /SKIP\s+fidelity/);
  assert.match(res.stdout, /缺少 --case/);
  assert.match(res.stdout, /INCOMPLETE/);

  const report = readJson(join(dir, 'out', 'port-report.json'));
  assert.equal(report.pass, false);

  const stage = stageByName(report, 'fidelity');
  assert.equal(stage.status, 'SKIP');
  assert.equal(stage.exitCode, null);
  assert.equal(stage.durationMs, 0);
  assert.equal(stage.logPath, 'out/logs/fidelity.log');
  assert.equal(typeof stage.summary, 'string');
  assert.match(String(stage.summary), /--case/);

  const log = readFileSync(join(dir, 'out', 'logs', 'fidelity.log'), 'utf8');
  assert.match(log, /# 状态: SKIP/);
  assert.match(log, /# 原因: .*--case/);
  assert.match(log, /# 命令: 未执行/);
});

test('缺 SDK：lint SKIP 且原因里说清缺什么', (t) => {
  const dir = makeTmp(t);
  mkdirSync(join(dir, 'project'), { recursive: true });
  const res = runPort(['--project', 'project', '--stages', 'lint', '--logs', join(dir, 'logs')], dir);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /SKIP\s+lint/);
  assert.match(res.stdout, /缺少 SDK/);
  const report = readJson(join(dir, 'out', 'port-report.json'));
  assert.equal(stageByName(report, 'lint').status, 'SKIP');
});

test('adapt 未就绪或缺参数 → SKIP，不自己重写适配逻辑', (t) => {
  const dir = makeTmp(t);
  const res = runPort(['--stages', 'adapt'], dir);
  assert.equal(res.code, 1);
  const report = readJson(join(dir, 'out', 'port-report.json'));
  const stage = stageByName(report, 'adapt');
  assert.equal(stage.status, 'SKIP');
  assert.match(String(stage.summary), /没|未就绪|缺少/);
});

// ---------------------------------------------------------------------------
// 失败即停 vs --continue
// ---------------------------------------------------------------------------

/** 造一个「源码目录存在但没有可分析文件」的场景：analyze-coupling 会 exit 2 → FAIL。 */
function makeFailingAnalyzeCase(t: TestHooks): { dir: string; caseArgs: string[] } {
  const dir = makeTmp(t);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'notes.txt'), 'not a source file\n', 'utf8');
  mkdirSync(join(dir, 'case'), { recursive: true });
  const golden = [{ scenario: 's1', pages: [{ text: 'a' }] }];
  writeFileSync(join(dir, 'case', 'golden.json'), JSON.stringify(golden), 'utf8');
  writeFileSync(join(dir, 'case', 'actual.json'), JSON.stringify(golden), 'utf8');
  return { dir, caseArgs: ['--src', 'src', '--case', 'case', '--stages', 'analyze,fidelity'] };
}

test('失败即停：analyze FAIL 后不再跑 fidelity，remaining 记录未运行阶段', (t) => {
  const { dir, caseArgs } = makeFailingAnalyzeCase(t);
  const args = [...caseArgs, '--logs', join(dir, 'logs'), '--report', join(dir, 'report.json')];
  const res = runPort(args, dir);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /FAIL\s+analyze/);
  assert.doesNotMatch(res.stdout, /^(?:PASS|FAIL|SKIP)\s+fidelity/m, 'fidelity 不应被执行');

  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.pass, false);
  assert.equal(report.stoppedEarly, true);
  assert.deepEqual(report.remaining, ['fidelity']);
  assert.equal(asArray(report.stages).length, 1);
  assert.equal(stageByName(report, 'analyze').status, 'FAIL');
  assert.notEqual(stageByName(report, 'analyze').exitCode, 0);
});

test('--continue：FAIL 后继续跑完后继阶段，整体仍判 FAIL', (t) => {
  const { dir, caseArgs } = makeFailingAnalyzeCase(t);
  const args = [...caseArgs, '--continue', '--logs', join(dir, 'logs'), '--report', join(dir, 'report.json')];
  const res = runPort(args, dir);
  assert.equal(res.code, 1);

  const report = readJson(join(dir, 'report.json'));
  assert.equal(report.pass, false);
  assert.equal(report.stoppedEarly, false);
  assert.deepEqual(report.remaining, []);
  assert.deepEqual(asArray(report.stages).map((item) => (item as Record<string, unknown>).name), ['analyze', 'fidelity']);
  assert.equal(stageByName(report, 'analyze').status, 'FAIL');
  assert.equal(stageByName(report, 'fidelity').status, 'PASS');
  assert.equal((report.counts as Record<string, number>).fail, 1);
  assert.equal((report.counts as Record<string, number>).pass, 1);
});

// ---------------------------------------------------------------------------
// 真实验收 + 报告字段
// ---------------------------------------------------------------------------

test('验收：--case cases/legado --stages fidelity → PASS（100%）且报告字段完整', (t) => {
  const dir = makeTmp(t);
  const reportPath = join(dir, 'report.json');
  const logsDir = join(dir, 'logs');
  const res = runPort(
    ['--case', 'cases/legado', '--stages', 'fidelity', '--logs', logsDir, '--report', reportPath, '--json'],
    repoRoot,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /^#/m, '--json 只输出 JSON，不混人类摘要');

  const report = JSON.parse(res.stdout) as Record<string, unknown>;
  const fileReport = readJson(reportPath);
  assert.deepEqual(report, fileReport, '--json 输出应与报告文件一致');
  assert.equal(report.pass, true);

  const stage = stageByName(report, 'fidelity');
  assert.equal(stage.status, 'PASS');
  assert.equal(stage.exitCode, 0);
  assert.equal(typeof stage.durationMs, 'number');
  assert.ok((stage.durationMs as number) >= 0);
  assert.equal(typeof stage.summary, 'string');
  assert.match(String(stage.summary), /保真度 100%/);
  assert.equal(typeof stage.logPath, 'string');
  assert.equal(stage.logPath, join(logsDir, 'fidelity.log'));

  const metrics = stage.metrics as Record<string, unknown>;
  assert.equal(metrics.fidelityPct, 100);
  assert.equal(metrics.sameItems, 62);
  assert.equal(metrics.totalItems, 62);
  assert.ok(['case/actual.json', 'replay.ts'].includes(String(metrics.actualSource)));

  const log = readFileSync(join(logsDir, 'fidelity.log'), 'utf8');
  assert.match(log, /# arkts-port 阶段: fidelity/);
  assert.match(log, /# 状态: PASS/);
  assert.match(log, /# 退出码: 0/);
  assert.match(log, /verify-fidelity\.ts/);
});

// ---------------------------------------------------------------------------
// B-11：fidelity schema 假 PASS（replacement-rule 默认 items=pages/field=text）
// ---------------------------------------------------------------------------

function useRealFidelity(sandbox: string): void {
  cpSync(join(repoRoot, 'cli', 'verify-fidelity.ts'), join(sandbox, 'cli', 'verify-fidelity.ts'));
}

function writeResultCase(sandbox: string, goldenValue: number, actualValue: number): void {
  writeFileSync(
    join(sandbox, 'case', 'golden.json'),
    JSON.stringify([{ scenario: 's1', result: [{ value: goldenValue }] }]),
    'utf8',
  );
  writeFileSync(
    join(sandbox, 'case', 'actual.json'),
    JSON.stringify([{ scenario: 's1', result: [{ value: actualValue }] }]),
    'utf8',
  );
}

function fidelityArgs(sandbox: string, extra: string[] = []): string[] {
  return [
    '--case', 'case', '--stages', 'fidelity', ...extra,
    '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'report.json'),
  ];
}

test('fidelity schema：golden 用 result、未显式 items/field → FAIL（不再 NO_ITEMS 假 PASS）', (t) => {
  const sandbox = makeSandbox(t);
  useRealFidelity(sandbox);
  writeResultCase(sandbox, 1, 2);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');

  const res = runPort(fidelityArgs(sandbox), sandbox, sandboxPort);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /FAIL\s+fidelity/);
  assert.match(res.stdout, /--fidelity-items result/);
  assert.match(res.stdout, /--fidelity-field value/);

  const report = readJson(join(sandbox, 'report.json'));
  assert.equal(report.pass, false);
  const stage = stageByName(report, 'fidelity');
  assert.equal(stage.status, 'FAIL');
  assert.equal(stage.exitCode, 1);
  assert.equal((stage.metrics as Record<string, unknown>).schemaMismatch, 'true');
  assert.equal(existsSync(join(sandbox, 'calls', 'verify-fidelity.json')), false, 'schema guard 应在 spawn 前 FAIL');
});

test('fidelity schema：显式 --fidelity-items result --fidelity-field value 后 PASS 1/1', (t) => {
  const sandbox = makeSandbox(t);
  useRealFidelity(sandbox);
  writeResultCase(sandbox, 1, 1);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');

  const res = runPort(fidelityArgs(sandbox, ['--fidelity-items', 'result', '--fidelity-field', 'value']), sandbox, sandboxPort);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /PASS\s+fidelity/);

  const report = readJson(join(sandbox, 'report.json'));
  const stage = stageByName(report, 'fidelity');
  assert.equal(stage.status, 'PASS');
  const metrics = stage.metrics as Record<string, unknown>;
  assert.equal(metrics.fidelityPct, 100);
  assert.equal(metrics.sameItems, 1);
  assert.equal(metrics.totalItems, 1);
});

test('fidelity schema：显式 items/field 后按真实值比较（1 vs 2 → FAIL 0/1）', (t) => {
  const sandbox = makeSandbox(t);
  useRealFidelity(sandbox);
  writeResultCase(sandbox, 1, 2);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');

  const res = runPort(fidelityArgs(sandbox, ['--fidelity-items', 'result', '--fidelity-field', 'value']), sandbox, sandboxPort);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = readJson(join(sandbox, 'report.json'));
  const stage = stageByName(report, 'fidelity');
  assert.equal(stage.status, 'FAIL');
  const metrics = stage.metrics as Record<string, unknown>;
  assert.equal(metrics.fidelityPct, 0);
  assert.equal(metrics.sameItems, 0);
  assert.equal(metrics.totalItems, 1);
});

// ---------------------------------------------------------------------------
// 全链参数映射：假子工具记录 argv/env，验证「不复制逻辑、只 spawn」
// ---------------------------------------------------------------------------

test('全链 all：7 个阶段全 PASS，子工具参数与环境变量映射正确', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  const reportPath = join(sandbox, 'out', 'report.json');
  const logsDir = join(sandbox, 'out', 'logs');
  const res = runPort(
    [
      '--project', 'project',
      '--src', 'src',
      '--adapted', 'adapted',
      '--case', 'case',
      '--sdk', 'sdk',
      '--hvigor', 'hvigor',
      '--stages', 'all',
      '--logs', logsDir,
      '--report', reportPath,
    ],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);

  const report = readJson(reportPath);
  assert.equal(report.pass, true);
  assert.deepEqual(asArray(report.stages).map((item) => (item as Record<string, unknown>).status), [
    'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS',
  ]);
  assert.deepEqual(report.counts, { pass: 7, warn: 0, fail: 0, skip: 0 });
  assert.deepEqual(report.requested, ['analyze', 'adapt', 'diff', 'fidelity', 'lint', 'reach', 'build']);
  assert.equal(report.stoppedEarly, false);

  // 每个阶段都真的 spawn 了对应 CLI，参数符合契约
  assert.deepEqual(callOf(sandbox, 'analyze-coupling').argv, ['--root', 'src', '--json']);
  assert.deepEqual(callOf(sandbox, 'diff-gate').argv, ['--before', 'src', '--after', 'adapted', '--json']);
  assert.deepEqual(callOf(sandbox, 'adapt-arkts').argv, [
    '--src', 'src', '--out', 'adapted', '--report', join(logsDir, 'adapt-report.json'), '--ets',
    '--fail-on-residual',
  ]);
  assert.deepEqual(callOf(sandbox, 'verify-fidelity').argv, [
    '--golden', join('case', 'golden.json'), '--actual', join('case', 'actual.json'), '--json',
  ]);
  assert.deepEqual(callOf(sandbox, 'lint-arkts').argv, [
    '--project', 'project', '--sdk', 'sdk', '--hvigor', 'hvigor', '--json',
  ]);
  assert.deepEqual(callOf(sandbox, 'reachability-probe').argv, [
    '--project', 'project', '--src', 'entry/src/main/ets', '--entry', 'pages/Index.ets',
    '--sdk', 'sdk', '--hvigor', 'hvigor', '--json',
  ]);
  assert.deepEqual(callOf(sandbox, 'build-hap').argv, [
    '--project', 'project', '--mode', 'debug', '--sdk', 'sdk', '--hvigor', 'hvigor',
  ]);

  // 环境变量映射与 cli/build-hap.ts 一致
  for (const toolName of ['analyze-coupling', 'adapt-arkts', 'diff-gate', 'fidelity', 'lint-arkts', 'reachability-probe', 'build-hap']) {
    const name = toolName === 'fidelity' ? 'verify-fidelity' : toolName;
    const call = callOf(sandbox, name);
    assert.equal(call.env.OHOS_BASE_SDK_HOME, 'sdk', name + ' 应收到 OHOS_BASE_SDK_HOME');
    assert.equal(call.env.NODE_PATH, 'hvigor', name + ' 应收到 NODE_PATH');
    assert.equal(call.env.NODE_HOME, '/usr/bin', name + ' 应收到 NODE_HOME');
  }

  // 干净工程（全 PASS）不应触发自动 explain
  assert.equal(existsSync(join(sandbox, 'calls', 'explain-errors.json')), false);

  // 摘要数字来自子工具报告/输出
  assert.equal((stageByName(report, 'analyze').metrics as Record<string, unknown>).autoConvertiblePct, 50);
  assert.match(String(stageByName(report, 'diff').summary), /0 needs-review/);
  assert.match(String(stageByName(report, 'adapt').summary), /残留 0 处/);
  assert.match(String(stageByName(report, 'lint').summary), /ArkTS 错误 0/);
  assert.match(String(stageByName(report, 'reach').summary), /探针模块 45/);
  assert.match(String(stageByName(report, 'build').summary), /BUILD SUCCESSFUL/);

  for (const stageName of ['analyze', 'adapt', 'diff', 'fidelity', 'lint', 'reach', 'build']) {
    const log = readFileSync(join(logsDir, stageName + '.log'), 'utf8');
    assert.match(log, new RegExp('# arkts-port 阶段: ' + stageName));
  }
});

test('--stages 默认 all；显式子集按固定顺序执行（与书写顺序无关）', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  const baseArgs = [
    '--project', 'project', '--src', 'src', '--adapted', 'adapted', '--case', 'case',
    '--sdk', 'sdk', '--hvigor', 'hvigor',
    '--logs', join(sandbox, 'logs'),
  ];

  const all = runPort([...baseArgs, '--report', join(sandbox, 'all.json')], sandbox, sandboxPort);
  assert.equal(all.code, 0, all.stdout + all.stderr);
  const allReport = readJson(join(sandbox, 'all.json'));
  assert.deepEqual(allReport.requested, ['analyze', 'adapt', 'diff', 'fidelity', 'lint', 'reach', 'build']);

  const subset = runPort(
    [...baseArgs, '--stages', 'build,analyze,lint', '--report', join(sandbox, 'subset.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(subset.code, 0, subset.stdout + subset.stderr);
  const subsetReport = readJson(join(sandbox, 'subset.json'));
  assert.deepEqual(subsetReport.requested, ['analyze', 'lint', 'build']);
  assert.deepEqual(
    asArray(subsetReport.stages).map((item) => (item as Record<string, unknown>).name),
    ['analyze', 'lint', 'build'],
  );
});

test('--timeout：子工具超时 → FAIL 且摘要说明超时', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  // 覆盖 analyze-coupling：超过 5s 才退出，--timeout 100 应把它杀掉
  writeFileSync(
    join(cliDir, 'analyze-coupling.ts'),
    'const end = Date.now() + 5000;\nwhile (Date.now() < end) { /* busy wait */ }\n',
    'utf8',
  );
  const sandboxPort = join(cliDir, 'port.ts');
  const res = runPort(
    [
      '--src', 'src', '--stages', 'analyze', '--timeout', '100',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'report.json'),
    ],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1);
  const report = readJson(join(sandbox, 'report.json'));
  const stage = stageByName(report, 'analyze');
  assert.equal(stage.status, 'FAIL');
  assert.match(String(stage.summary), /超时/);
  assert.equal(stage.exitCode, null);
});

test('--adapt-src 解耦输入目录；adapt 扫描 0 个文件 → FAIL 而不是假 PASS', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  mkdirSync(join(sandbox, 'ts'), { recursive: true });
  writeFileSync(join(sandbox, 'ts', 'a.ts'), 'export const a = 1;\n', 'utf8');

  const baseArgs = [
    '--src', 'src', '--adapt-src', 'ts', '--adapted', 'adapted', '--stages', 'adapt',
    '--logs', join(sandbox, 'logs'),
  ];
  let res = runPort([...baseArgs, '--report', join(sandbox, 'r1.json')], sandbox, sandboxPort);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(callOf(sandbox, 'adapt-arkts').argv.slice(0, 2), ['--src', 'ts']);

  // 报告说扫描 0 个文件：几乎一定是路径指错，不能算 PASS
  writeFakeTool(cliDir, 'adapt-arkts', {
    writeReport: true,
    report: { summary: { filesScanned: 0, filesChanged: 0, residuals: 0 } },
  });
  res = runPort([...baseArgs, '--report', join(sandbox, 'r2.json')], sandbox, sandboxPort);
  assert.equal(res.code, 1);
  const report = readJson(join(sandbox, 'r2.json'));
  const stage = stageByName(report, 'adapt');
  assert.equal(stage.status, 'FAIL');
  assert.match(String(stage.summary), /扫描 0 个/);
});

test('--actual：覆盖 case/actual.json 并透传给 verify-fidelity；不存在则 SKIP', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  writeFileSync(
    join(sandbox, 'case', 'alt.json'),
    JSON.stringify([{ scenario: 's1', pages: [{ text: 'a' }] }]),
    'utf8',
  );

  const res = runPort(
    [
      '--case', 'case', '--actual', join('case', 'alt.json'), '--stages', 'fidelity',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r1.json'),
    ],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(callOf(sandbox, 'verify-fidelity').argv, [
    '--golden', join('case', 'golden.json'), '--actual', join('case', 'alt.json'), '--json',
  ]);

  const missing = runPort(
    [
      '--case', 'case', '--actual', join('case', 'missing.json'), '--stages', 'fidelity',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r2.json'),
    ],
    sandbox,
    sandboxPort,
  );
  assert.equal(missing.code, 1);
  const stage = stageByName(readJson(join(sandbox, 'r2.json')), 'fidelity');
  assert.equal(stage.status, 'SKIP');
  assert.match(String(stage.summary), /--actual 不存在/);
});

test('fidelity：--fidelity-key/--fidelity-items/--fidelity-field 按需透传（默认不传）', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  const baseArgs = ['--case', 'case', '--stages', 'fidelity'];

  const defaults = runPort(
    [...baseArgs, '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r1.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(defaults.code, 0, defaults.stdout + defaults.stderr);
  assert.deepEqual(callOf(sandbox, 'verify-fidelity').argv, [
    '--golden', join('case', 'golden.json'), '--actual', join('case', 'actual.json'), '--json',
  ], '默认不传 --key/--items/--field');

  const explicit = runPort(
    [
      ...baseArgs,
      '--fidelity-key', 'scenario', '--fidelity-items', 'result', '--fidelity-field', 'content',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r2.json'),
    ],
    sandbox,
    sandboxPort,
  );
  assert.equal(explicit.code, 0, explicit.stdout + explicit.stderr);
  assert.deepEqual(callOf(sandbox, 'verify-fidelity').argv, [
    '--golden', join('case', 'golden.json'), '--actual', join('case', 'actual.json'), '--json',
    '--key', 'scenario', '--items', 'result', '--field', 'content',
  ], '三个选项都提供时应逐一透传给 verify-fidelity');

  const onlyItems = runPort(
    [
      ...baseArgs, '--fidelity-items', 'result',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r3.json'),
    ],
    sandbox,
    sandboxPort,
  );
  assert.equal(onlyItems.code, 0, onlyItems.stdout + onlyItems.stderr);
  assert.deepEqual(callOf(sandbox, 'verify-fidelity').argv, [
    '--golden', join('case', 'golden.json'), '--actual', join('case', 'actual.json'), '--json',
    '--items', 'result',
  ], '只提供 --fidelity-items 时不能顺手传 --key/--field');
});

test('fidelity：verify-fidelity FAIL → port FAIL（透传参数不改变门禁结论）', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  writeFakeTool(cliDir, 'verify-fidelity', {
    exit: 1,
    stdout: JSON.stringify({
      totalItems: 0, sameItems: 0, fidelityPct: 0,
      sameScenarios: 0, totalScenarios: 2, missingScenarios: 2, pass: false,
    }),
  });
  const res = runPort(
    [
      '--case', 'case', '--stages', 'fidelity',
      '--fidelity-key', 'scenario', '--fidelity-items', 'result', '--fidelity-field', 'content',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json'),
    ],
    sandbox,
    join(cliDir, 'port.ts'),
  );
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = readJson(join(sandbox, 'r.json'));
  assert.equal(report.pass, false);
  const stage = stageByName(report, 'fidelity');
  assert.equal(stage.status, 'FAIL');
  assert.equal(stage.exitCode, 1);
  assert.match(String(stage.summary), /缺失 2 场景/);
  assert.equal((stage.metrics as Record<string, unknown>).missingScenarios, 2);

  const argv = callOf(sandbox, 'verify-fidelity').argv;
  assert.equal(argv[argv.indexOf('--key') + 1], 'scenario');
  assert.equal(argv[argv.indexOf('--items') + 1], 'result');
  assert.equal(argv[argv.indexOf('--field') + 1], 'content');
});

test('adapt 默认严格：residual>0 → FAIL；--allow-residuals → PASS 且摘要写「已放行」', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  writeFakeTool(cliDir, 'adapt-arkts', {
    writeReport: true,
    report: { summary: { filesScanned: 3, filesChanged: 2, residuals: 1 } },
    exitOnFailOnResidual: true,
  });
  const baseArgs = ['--src', 'src', '--adapted', 'adapted', '--stages', 'adapt', '--logs', join(sandbox, 'logs')];

  const strict = runPort([...baseArgs, '--report', join(sandbox, 'strict.json')], sandbox, sandboxPort);
  assert.equal(strict.code, 1, strict.stdout + strict.stderr);
  assert.ok(callOf(sandbox, 'adapt-arkts').argv.includes('--fail-on-residual'));
  const strictStage = stageByName(readJson(join(sandbox, 'strict.json')), 'adapt');
  assert.equal(strictStage.status, 'FAIL');
  assert.equal(strictStage.exitCode, 3);
  assert.match(String(strictStage.summary), /适配有残留 1 处/);

  const relaxed = runPort(
    [...baseArgs, '--allow-residuals', '--report', join(sandbox, 'relaxed.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(relaxed.code, 0, relaxed.stdout + relaxed.stderr);
  assert.ok(callOf(sandbox, 'adapt-arkts').argv.includes('--fail-on-residual') === false);
  const relaxedStage = stageByName(readJson(join(sandbox, 'relaxed.json')), 'adapt');
  assert.equal(relaxedStage.status, 'PASS');
  assert.match(String(relaxedStage.summary), /残留 1 处已放行/);
  assert.equal((relaxedStage.metrics as Record<string, unknown>).residuals, 1);
});

test('replay：stderr 的 Node 警告不能污染 stdout（方括号/普通警告都要 PASS）', (t) => {
  const stderrCases = [
    '[MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file is not specified',
    'Warning: something noisy on stderr',
  ];
  for (const stderrLine of stderrCases) {
    const sandbox = makeSandbox(t);
    const sandboxPort = join(sandbox, 'cli', 'port.ts');
    writeFileSync(
      join(sandbox, 'case', 'replay.ts'),
      'console.log(JSON.stringify([{ scenario: \'s1\', pages: [{ text: \'a\' }] }]));\n' +
      'console.error(' + JSON.stringify(stderrLine) + ');\n',
      'utf8',
    );
    const res = runPort(
      ['--case', 'case', '--stages', 'fidelity', '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json')],
      sandbox,
      sandboxPort,
    );
    assert.equal(res.code, 0, 'stderr 警告不应导致失败：' + stderrLine + '\n' + res.stdout + res.stderr);
    const stage = stageByName(readJson(join(sandbox, 'r.json')), 'fidelity');
    assert.equal(stage.status, 'PASS');
    assert.equal((stage.metrics as Record<string, unknown>).actualSource, 'replay.ts');
    assert.doesNotMatch(String(stage.summary), /replay 失败已回退/);
    // 只比较/落盘 stdout：重放产物里不应出现 stderr 警告
    const replayedFile = readFileSync(join(sandbox, 'logs', 'fidelity-replay.json'), 'utf8');
    assert.doesNotMatch(replayedFile, /Warning/);
    const log = readFileSync(join(sandbox, 'logs', 'fidelity.log'), 'utf8');
    assert.match(log, /replay stderr 1 行/);
  }
});

test('fidelity FAIL 时不显示「保真度 100%」：缺场景单独写清', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  writeFakeTool(cliDir, 'verify-fidelity', {
    exit: 1,
    stdout: JSON.stringify({
      pass: false,
      fidelityPct: 100,
      totalItems: 4,
      sameItems: 4,
      sameScenarios: 1,
      totalScenarios: 2,
      missingScenarios: 1,
      details: [{ scenario: 's2', status: 'missing' }],
    }),
  });
  const res = runPort(
    ['--case', 'case', '--stages', 'fidelity', '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1);
  const stage = stageByName(readJson(join(sandbox, 'r.json')), 'fidelity');
  assert.equal(stage.status, 'FAIL');
  assert.match(String(stage.summary), /缺失 1 场景/);
  assert.doesNotMatch(String(stage.summary), /保真度 100%/);
  assert.equal((stage.metrics as Record<string, unknown>).missingScenarios, 1);
});

test('lint：以子工具 --json 的 pass 为准（WARN 级违规 → FAIL），并保留中文标签兜底', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  const args = ['--project', 'project', '--sdk', 'sdk', '--hvigor', 'hvigor', '--stages', 'lint',
    '--logs', join(sandbox, 'logs')];

  // JSON pass=false：即使看了标签也应按 JSON 判 FAIL（hardening 后 globalThis WARN 会这样）
  writeFakeTool(cliDir, 'lint-arkts', {
    exit: 1,
    stdout: JSON.stringify({ pass: false, arktsErrors: 1, warnArktsErrors: 1 }),
  });
  let res = runPort([...args, '--report', join(sandbox, 'r1.json')], sandbox, sandboxPort);
  assert.equal(res.code, 1);
  let stage = stageByName(readJson(join(sandbox, 'r1.json')), 'lint');
  assert.equal(stage.status, 'FAIL');
  assert.match(String(stage.summary), /ArkTS 错误 1/);
  assert.match(String(stage.summary), /WARN 级 1/);

  // pass=false 但 exit 0：fail-closed，仍判 FAIL
  writeFakeTool(cliDir, 'lint-arkts', {
    exit: 0,
    stdout: JSON.stringify({ pass: false, arktsErrors: 0, warnArktsErrors: 0 }),
  });
  res = runPort([...args, '--report', join(sandbox, 'r2.json')], sandbox, sandboxPort);
  assert.equal(res.code, 1);
  stage = stageByName(readJson(join(sandbox, 'r2.json')), 'lint');
  assert.equal(stage.status, 'FAIL');

  // 旧版子工具（无 JSON，只有中文标签）仍能兜底解析
  writeFakeTool(cliDir, 'lint-arkts', { exit: 0, stdout: 'ArkTS 错误数: 0\n门禁: PASS\n' });
  res = runPort([...args, '--report', join(sandbox, 'r3.json')], sandbox, sandboxPort);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  stage = stageByName(readJson(join(sandbox, 'r3.json')), 'lint');
  assert.equal(stage.status, 'PASS');
  assert.match(String(stage.summary), /ArkTS 错误 0/);
});

test('autofix 默认关闭：--stages all 无 autofix；显式选用但无 --autofix → exit 2；--arkts-fix-out 也需 --autofix', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  const logsDir = join(sandbox, 'logs');
  const base = ['--project', 'project', '--src', 'src', '--adapted', 'adapted', '--case', 'case',
    '--sdk', 'sdk', '--hvigor', 'hvigor', '--stages', 'all', '--logs', logsDir, '--report', join(sandbox, 'r.json')];
  const res = runPort(base, sandbox, sandboxPort);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = readJson(join(sandbox, 'r.json'));
  assert.deepEqual(report.requested, ['analyze', 'adapt', 'diff', 'fidelity', 'lint', 'reach', 'build']);
  assert.equal(existsSync(join(sandbox, 'calls', 'arkts-fix.json')), false);

  const explicit = runPort(['--stages', 'autofix', '--adapted', 'adapted', '--logs', logsDir], sandbox, sandboxPort);
  assert.equal(explicit.code, 2);
  assert.match(explicit.stderr, /autofix/);

  const orphan = runPort(['--arkts-fix-out', 'out/fix', '--stages', 'diff', '--src', 'src', '--adapted', 'adapted'], sandbox, sandboxPort);
  assert.equal(orphan.code, 2);
  assert.match(orphan.stderr, /--arkts-fix-out/);
});

test('autofix 36 处：--autofix 启用，0 transforms 时 diff 直接用 adapt 产物（不复制）', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  const logsDir = join(sandbox, 'logs');
  const res = runPort(
    ['--project', 'project', '--src', 'src', '--adapted', 'adapted', '--case', 'case',
      '--sdk', 'sdk', '--hvigor', 'hvigor', '--autofix', '--stages', 'all',
      '--logs', logsDir, '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = readJson(join(sandbox, 'r.json'));
  assert.deepEqual(report.requested, ['analyze', 'adapt', 'autofix', 'diff', 'fidelity', 'lint', 'reach', 'build']);
  const stage = stageByName(report, 'autofix');
  assert.equal(stage.status, 'PASS');
  assert.match(String(stage.summary), /0 transforms/);
  const metrics = stage.metrics as Record<string, unknown>;
  assert.equal(metrics.transforms, 0);
  assert.equal(metrics.fixedDir, 'adapted');
  assert.equal(metrics.appliedToGates, false);
  assert.equal(metrics.gatesSource, 'project');
  assert.match(String(stage.summary), /仅 diff/);
  assert.match(String(stage.summary), /lint\/reach\/build 仍按 --project/);
  assert.deepEqual(callOf(sandbox, 'arkts-fix').argv, [
    '--src', 'adapted', '--out', join(logsDir, 'autofix'), '--json', '--report', join(logsDir, 'autofix-report.json'),
  ]);
  assert.deepEqual(callOf(sandbox, 'diff-gate').argv, ['--before', 'src', '--after', 'adapted', '--json']);
});

test('autofix transforms>0：下游 diff 用 fixed 目录，metrics 记录 rules/transforms/changed/skips/fixedDir', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  const logsDir = join(sandbox, 'logs');
  mkdirSync(join(logsDir, 'autofix'), { recursive: true });
  writeFakeTool(cliDir, 'arkts-fix', {
    writeReport: true,
    report: {
      ok: true,
      rules: { 'enum-from-as-const': 2, 'object-literal-to-interface': 1 },
      files: [],
      totals: { files: 2, changed: 1, transforms: 3, skips: 0 },
    },
    stdout: JSON.stringify({
      ok: true,
      rules: { 'enum-from-as-const': 2, 'object-literal-to-interface': 1 },
      totals: { files: 2, changed: 1, transforms: 3, skips: 0 },
    }),
  });
  const res = runPort(
    ['--project', 'project', '--src', 'src', '--adapted', 'adapted', '--case', 'case',
      '--sdk', 'sdk', '--hvigor', 'hvigor', '--autofix', '--stages', 'all',
      '--logs', logsDir, '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const stage = stageByName(readJson(join(sandbox, 'r.json')), 'autofix');
  assert.equal(stage.status, 'PASS');
  const metrics = stage.metrics as Record<string, unknown>;
  assert.equal(metrics.rules, 2);
  assert.equal(metrics.transforms, 3);
  assert.equal(metrics.changed, 1);
  assert.equal(metrics.skips, 0);
  assert.equal(metrics.fixedDir, 'logs/autofix');
  assert.equal(metrics.appliedToGates, false);
  assert.equal(metrics.gatesSource, 'project');
  assert.match(String(stage.summary), /修复 3 处/);
  assert.match(String(stage.summary), /仅 diff/);
  assert.match(String(stage.summary), /lint\/reach\/build 仍按 --project/);
  const diffArgv = callOf(sandbox, 'diff-gate').argv;
  assert.equal(diffArgv[diffArgv.indexOf('--after') + 1], join(logsDir, 'autofix'));
});

test('autofix exit 1 → FAIL（默认即停，diff 不跑）；工具缺失且启用 → FAIL + 提示；--no-autofix 不 spawn', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  const logsDir = join(sandbox, 'logs');
  writeFakeTool(cliDir, 'arkts-fix', {
    exit: 1,
    writeReport: true,
    report: { ok: false, rules: {}, totals: { files: 1, changed: 0, transforms: 0, skips: 0 } },
  });
  const failed = runPort(
    ['--src', 'src', '--adapted', 'adapted', '--autofix', '--stages', 'adapt,autofix,diff',
      '--logs', logsDir, '--report', join(sandbox, 'r1.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(failed.code, 1);
  const failedReport = readJson(join(sandbox, 'r1.json'));
  assert.equal(stageByName(failedReport, 'autofix').status, 'FAIL');
  assert.equal(existsSync(join(sandbox, 'calls', 'diff-gate.json')), false);

  rmSync(join(cliDir, 'arkts-fix.ts'), { force: true });
  const missing = runPort(
    ['--src', 'src', '--adapted', 'adapted', '--autofix', '--stages', 'autofix',
      '--logs', logsDir, '--report', join(sandbox, 'r2.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(missing.code, 1);
  assert.match(String(stageByName(readJson(join(sandbox, 'r2.json')), 'autofix').summary), /arkts-fix\.ts 不存在/);

  rmSync(join(sandbox, 'calls', 'arkts-fix.json'), { force: true });
  const disabled = runPort(
    ['--src', 'src', '--adapted', 'adapted', '--autofix', '--no-autofix', '--stages', 'all',
      '--logs', logsDir, '--report', join(sandbox, 'r3.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(disabled.code, 1, '缺少 project/sdk/hvigor 时 build/lint/reach 会 SKIP，整体 1');
  const disabledReport = readJson(join(sandbox, 'r3.json'));
  assert.equal(asArray(disabledReport.requested).includes('autofix'), false);
  assert.equal(existsSync(join(sandbox, 'calls', 'arkts-fix.json')), false);
});

test('device 默认不启用：--stages all 仍是 7 阶段；显式选 device 但无 --device → exit 2', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  const res = runPort(
    ['--project', 'project', '--src', 'src', '--adapted', 'adapted', '--case', 'case',
      '--sdk', 'sdk', '--hvigor', 'hvigor', '--stages', 'all',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = readJson(join(sandbox, 'r.json'));
  assert.deepEqual(report.requested, ['analyze', 'adapt', 'diff', 'fidelity', 'lint', 'reach', 'build']);
  assert.equal(asArray(report.stages).length, 7);
  assert.equal(asArray(report.stages).some((item) => (item as Record<string, unknown>).name === 'device'), false);
  assert.equal(existsSync(join(sandbox, 'calls', 'device-test.json')), false);

  const blocked = runPort(['--stages', 'device'], sandbox, sandboxPort);
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /device/);
  assert.match(blocked.stderr, /--device/);
});

test('device check-only PASS：--target --check 透传，metrics 记录 check，摘要一行', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  const logsDir = join(sandbox, 'logs');
  const res = runPort(
    ['--device', '10.0.0.1:1', '--stages', 'device', '--logs', logsDir, '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(callOf(sandbox, 'device-test').argv, [
    '--target', '10.0.0.1:1', '--json', '--log', join(logsDir, 'device-test.log'), '--check',
  ]);
  const report = readJson(join(sandbox, 'r.json'));
  const stage = stageByName(report, 'device');
  assert.equal(stage.status, 'PASS');
  const metrics = stage.metrics as Record<string, unknown>;
  assert.equal(metrics.mode, 'check-only');
  assert.equal(metrics.checkOk, true);
  assert.equal(metrics.installStatus, 'skipped');
  assert.match(String(stage.summary), /device check OK/);
  assert.match(String(stage.summary), /FakeDevice/);
  assert.equal(res.stdout.split('\n').filter((line) => line.includes('device')).length >= 1, true);
});

test('device install+launch PASS：--signed-hap/--bundle/--ability/--hdc/--device-timeout 全透传', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  const logsDir = join(sandbox, 'logs');
  writeFakeTool(cliDir, 'device-test', {
    stdout: JSON.stringify({
      ok: true, exitCode: 0, target: '10.0.0.1:1',
      check: { ok: true, connected: true, model: 'FakeDevice', message: 'connected' },
      install: { status: 'installed', message: 'install success' },
      launch: { status: 'started', message: 'aa start ok' },
      screenshot: { status: 'captured', path: join(logsDir, 'device.jpeg'), bytes: 12345 },
      logPath: join(logsDir, 'device-test.log'),
    }),
  });
  const res = runPort(
    ['--device', '10.0.0.1:1', '--signed-hap', 'signed.hap', '--bundle', 'com.example.app',
      '--ability', 'EntryAbility', '--hdc', 'fake-hdc', '--device-timeout', '1234',
      '--stages', 'device', '--logs', logsDir, '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(callOf(sandbox, 'device-test').argv, [
    '--target', '10.0.0.1:1', '--json', '--log', join(logsDir, 'device-test.log'),
    '--hdc', 'fake-hdc', '--timeout', '1234',
    '--hap', 'signed.hap', '--install', '--bundle', 'com.example.app', '--ability', 'EntryAbility',
    '--screenshot', join(logsDir, 'device.jpeg'),
  ]);
  const stage = stageByName(readJson(join(sandbox, 'r.json')), 'device');
  assert.equal(stage.status, 'PASS');
  const metrics = stage.metrics as Record<string, unknown>;
  assert.equal(metrics.mode, 'install');
  assert.equal(metrics.installStatus, 'installed');
  assert.equal(metrics.launchStatus, 'started');
  assert.equal(metrics.screenshotStatus, 'captured');
  assert.equal(metrics.screenshotPath, join(logsDir, 'device.jpeg'));
  assert.match(String(stage.summary), /install OK/);
  assert.match(String(stage.summary), /launch started/);
});

test('device-test exit 1 → FAIL；缺 --bundle 的 install 是用法错误 exit 2', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  writeFakeTool(cliDir, 'device-test', { exit: 1, stdout: 'check FAILED\n', stderr: 'no target\n' });
  const res = runPort(
    ['--device', '10.0.0.1:1', '--stages', 'device', '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1);
  const stage = stageByName(readJson(join(sandbox, 'r.json')), 'device');
  assert.equal(stage.status, 'FAIL');
  assert.match(String(stage.summary), /device-test 失败/);

  const missingBundle = runPort(['--device', '10.0.0.1:1', '--signed-hap', 'signed.hap', '--stages', 'device'], sandbox, sandboxPort);
  assert.equal(missingBundle.code, 2);
  assert.match(missingBundle.stderr, /--bundle/);
});

test('device-test exit 2/找不到 hdc → FAIL 且给可操作提示', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  writeFakeTool(cliDir, 'device-test', { exit: 2, stdout: '', stderr: 'device-test: 找不到 hdc（--hdc/$HDC/PATH）\n' });
  const res = runPort(
    ['--device', '10.0.0.1:1', '--stages', 'device', '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1);
  const stage = stageByName(readJson(join(sandbox, 'r.json')), 'device');
  assert.equal(stage.status, 'FAIL');
  assert.match(String(stage.summary), /用法\/前置错误/);
  assert.match(String(stage.summary), /hdc/);
});

test('device 与 --continue：前置阶段 FAIL 后，--continue 仍会跑 device', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  writeFakeTool(cliDir, 'analyze-coupling', { exit: 1, stdout: JSON.stringify({ files: 0 }) });

  const stop = runPort(
    ['--device', '10.0.0.1:1', '--src', 'src', '--stages', 'analyze,device',
      '--logs', join(sandbox, 'logs-stop'), '--report', join(sandbox, 'r-stop.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(stop.code, 1);
  const stopReport = readJson(join(sandbox, 'r-stop.json'));
  assert.deepEqual(asArray(stopReport.stages).map((item) => (item as Record<string, unknown>).name), ['analyze']);
  assert.deepEqual(stopReport.remaining, ['device']);
  assert.equal(existsSync(join(sandbox, 'calls', 'device-test.json')), false);

  const cont = runPort(
    ['--device', '10.0.0.1:1', '--src', 'src', '--stages', 'analyze,device', '--continue',
      '--logs', join(sandbox, 'logs-cont'), '--report', join(sandbox, 'r-cont.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(cont.code, 1);
  const contReport = readJson(join(sandbox, 'r-cont.json'));
  assert.deepEqual(asArray(contReport.stages).map((item) => (item as Record<string, unknown>).name), ['analyze', 'device']);
  assert.equal((asArray(contReport.stages)[1] as Record<string, unknown>).status, 'PASS');
  assert.equal(existsSync(join(sandbox, 'calls', 'device-test.json')), true);
});

test('lint FAIL：默认自动 explain-errors，摘要带规则+file:line，metrics.explain 非空', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  const logsDir = join(sandbox, 'logs');
  const rawErrors = [
    { rule: 'arkts-no-globalthis', file: 'entry/src/main/ets/parity/layout/ReaderPaginator.ets', line: 1624, col: 5, level: 'WARN', message: '"globalThis" is not supported (arkts-no-globalthis)' },
    { rule: 'arkts-no-obj-literals-as-types', file: 'entry/src/main/ets/parity/model/ReaderPage.ets', line: 12, col: 3, level: 'ERROR', message: 'Object literal must correspond to some explicitly declared class or interface' },
  ];
  writeFakeTool(cliDir, 'lint-arkts', {
    exit: 1,
    stdout: JSON.stringify({ pass: false, arktsErrors: 2, warnArktsErrors: 1, errors: rawErrors }),
  });
  writeFakeTool(cliDir, 'explain-errors', {
    stdout: JSON.stringify({
      total: 2,
      rules: [{ rule: 'arkts-no-globalthis', count: 1 }, { rule: 'arkts-no-obj-literals-as-types', count: 1 }],
      errors: [
        { rule: 'arkts-no-globalthis', sourcePath: 'parity/layout/ReaderPaginator.ets', line: 1624, col: 5, level: 'WARN', message: '"globalThis" is not supported (arkts-no-globalthis)' },
        { rule: 'arkts-no-obj-literals-as-types', sourcePath: 'parity/model/ReaderPage.ets', line: 12, col: 3, level: 'ERROR', message: 'Object literal must correspond to some explicitly declared class or interface' },
      ],
    }),
  });

  const res = runPort(
    ['--project', 'project', '--sdk', 'sdk', '--hvigor', 'hvigor', '--stages', 'lint',
      '--logs', logsDir, '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1, res.stdout + res.stderr);
  // 人类摘要：规则 + file:line，且 explain 行 ≤3
  assert.match(res.stdout, /arkts-no-globalthis/);
  assert.match(res.stdout, /ReaderPaginator\.ets:1624/);
  assert.ok(res.stdout.split('\n').filter((line) => line.includes('↳')).length <= 3);
  assert.match(res.stdout, /FAIL\s+lint/);

  const report = readJson(join(sandbox, 'r.json'));
  const stage = stageByName(report, 'lint');
  assert.equal(stage.status, 'FAIL');
  assert.equal(typeof stage.logPath, 'string');
  const explain = (stage.metrics as Record<string, unknown>).explain as Record<string, unknown>;
  assert.equal(explain.ok, true);
  assert.equal(explain.total, 2);
  assert.equal(explain.max, 5);
  assert.ok(String(explain.log).endsWith('lint-errors.json'));
  const top = explain.top as Array<Record<string, unknown>>;
  assert.equal(top.length, 2);
  assert.equal(top[0].rule, 'arkts-no-globalthis');
  assert.equal(top[0].line, 1624);
  assert.equal((stage.extraLines as string[]).length, 2);

  // explain 的输入是子工具 JSON 里的 errors 数组（落成 lint-errors.json）
  const explainCall = callOf(sandbox, 'explain-errors');
  const logIndex = explainCall.argv.indexOf('--log');
  assert.ok(logIndex >= 0);
  assert.ok(explainCall.argv[logIndex + 1].endsWith('lint-errors.json'));
  assert.equal(explainCall.argv[explainCall.argv.indexOf('--max') + 1], '5');
  assert.ok(explainCall.argv.includes('--json'));
  assert.equal(explainCall.argv[explainCall.argv.indexOf('--root') + 1], join(sandbox, 'project', 'entry', 'src', 'main', 'ets'));
  const written = readJson(join(logsDir, 'lint-errors.json'));
  assert.equal(Array.isArray(written), true);
});

test('--no-explain：lint FAIL 不跑 explain，摘要无 explain 行，metrics 无 explain', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  writeFakeTool(cliDir, 'lint-arkts', {
    exit: 1,
    stdout: JSON.stringify({
      pass: false, arktsErrors: 1, warnArktsErrors: 0,
      errors: [{ rule: 'arkts-no-any-unknown', file: 'entry/src/main/ets/x.ets', line: 7, col: 1, message: 'any' }],
    }),
  });
  writeFakeTool(cliDir, 'explain-errors', { stdout: JSON.stringify({ total: 1, errors: [] }) });
  const res = runPort(
    ['--project', 'project', '--sdk', 'sdk', '--hvigor', 'hvigor', '--stages', 'lint',
      '--logs', join(sandbox, 'logs'), '--no-explain', '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1);
  assert.equal(res.stdout.includes('↳'), false);
  assert.equal(existsSync(join(sandbox, 'calls', 'explain-errors.json')), false);
  const stage = stageByName(readJson(join(sandbox, 'r.json')), 'lint');
  assert.equal(stage.status, 'FAIL');
  assert.equal((stage.metrics as Record<string, unknown>).explain, undefined);
});

test('--explain-max：限制条数并透传，人类摘要仍 ≤3 行', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  const errors = [];
  for (let i = 0; i < 4; i++) {
    errors.push({ rule: 'arkts-rule-' + i, sourcePath: 'parity/x' + i + '.ets', line: i + 1, message: 'm' + i });
  }
  writeFakeTool(cliDir, 'lint-arkts', {
    exit: 1,
    stdout: JSON.stringify({ pass: false, arktsErrors: 4, warnArktsErrors: 0, errors }),
  });
  writeFakeTool(cliDir, 'explain-errors', { stdout: JSON.stringify({ total: 4, errors }) });
  const res = runPort(
    ['--project', 'project', '--sdk', 'sdk', '--hvigor', 'hvigor', '--stages', 'lint',
      '--logs', join(sandbox, 'logs'), '--explain-max', '2', '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1);
  const explain = (stageByName(readJson(join(sandbox, 'r.json')), 'lint').metrics as Record<string, unknown>)
    .explain as Record<string, unknown>;
  assert.equal(explain.max, 2);
  assert.equal((explain.top as unknown[]).length, 2);
  assert.ok(res.stdout.split('\n').filter((line) => line.includes('↳')).length <= 3);
  assert.equal(callOf(sandbox, 'explain-errors').argv[callOf(sandbox, 'explain-errors').argv.indexOf('--max') + 1], '2');
});

test(' explain 自身失败只记 WARN，阶段仍 FAIL、结论不变', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  writeFakeTool(cliDir, 'lint-arkts', {
    exit: 1,
    stdout: JSON.stringify({
      pass: false, arktsErrors: 1, warnArktsErrors: 0,
      errors: [{ rule: 'arkts-no-any-unknown', file: 'entry/src/main/ets/x.ets', line: 7, col: 1, message: 'any' }],
    }),
  });
  writeFakeTool(cliDir, 'explain-errors', { exit: 2, stderr: 'boom: cannot parse log\n' });
  const res = runPort(
    ['--project', 'project', '--sdk', 'sdk', '--hvigor', 'hvigor', '--stages', 'lint',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1);
  assert.match(res.stdout, /explain WARN/);
  const stage = stageByName(readJson(join(sandbox, 'r.json')), 'lint');
  assert.equal(stage.status, 'FAIL');
  const explain = (stage.metrics as Record<string, unknown>).explain as Record<string, unknown>;
  assert.equal(explain.ok, false);
});

test('reach FAIL：同样自动 explain（用 reach JSON 的 errors），摘要带规则+file:line', (t) => {
  const sandbox = makeSandbox(t);
  const cliDir = join(sandbox, 'cli');
  const sandboxPort = join(cliDir, 'port.ts');
  const reachErrors = [
    { rule: 'arkts-no-globalthis', file: 'entry/src/main/ets/parity/layout/ReaderPaginator.ets', line: 1624, col: 5, level: 'WARN', message: 'globalThis' },
  ];
  writeFakeTool(cliDir, 'reachability-probe', {
    exit: 1,
    stdout: JSON.stringify({ pass: false, probeModules: 45, arktsErrors: 9, warnArktsErrors: 1, errors: reachErrors }),
  });
  writeFakeTool(cliDir, 'explain-errors', {
    stdout: JSON.stringify({
      total: 9,
      errors: [{ rule: 'arkts-no-globalthis', sourcePath: 'parity/layout/ReaderPaginator.ets', line: 1624, level: 'WARN', message: 'globalThis' }],
    }),
  });
  const res = runPort(
    ['--project', 'project', '--sdk', 'sdk', '--hvigor', 'hvigor', '--stages', 'reach',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json')],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 1);
  assert.match(res.stdout, /arkts-no-globalthis/);
  assert.match(res.stdout, /ReaderPaginator\.ets:1624/);
  const explain = (stageByName(readJson(join(sandbox, 'r.json')), 'reach').metrics as Record<string, unknown>)
    .explain as Record<string, unknown>;
  assert.equal(explain.ok, true);
  assert.ok(String(explain.log).endsWith('reach-errors.json'));
  const explainCall = callOf(sandbox, 'explain-errors');
  assert.ok(explainCall.argv[explainCall.argv.indexOf('--log') + 1].endsWith('reach-errors.json'));
});

test('--explain-max 非法值 → exit 2', () => {
  for (const value of ['0', 'abc', '-1']) {
    const res = runPort(['--explain-max', value, '--stages', 'lint'], repoRoot);
    assert.equal(res.code, 2, '应 exit 2：' + value);
    assert.match(res.stderr, /explain-max/);
  }
});

test('--no-ets：adapt 不传 --ets；--mode release 透传给 build-hap', (t) => {
  const sandbox = makeSandbox(t);
  const sandboxPort = join(sandbox, 'cli', 'port.ts');
  const res = runPort(
    [
      '--project', 'project', '--src', 'src', '--adapted', 'adapted', '--case', 'case',
      '--sdk', 'sdk', '--hvigor', 'hvigor',
      '--stages', 'adapt,build', '--no-ets', '--mode', 'release',
      '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'report.json'),
    ],
    sandbox,
    sandboxPort,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const adaptArgv = callOf(sandbox, 'adapt-arkts').argv;
  assert.ok(adaptArgv.includes('--ets') === false, '--no-ets 时不应传 --ets');
  assert.deepEqual(callOf(sandbox, 'build-hap').argv, [
    '--project', 'project', '--mode', 'release', '--sdk', 'sdk', '--hvigor', 'hvigor',
  ]);
});
// ---------------------------------------------------------------------------
// diff 阶段：WARN 只告警、不阻断；--strict-diff 才失败
// ---------------------------------------------------------------------------

function makeDiffSandbox(t: TestHooks): { sandbox: string; portPath: string; baseArgs: string[] } {
  const sandbox = makeSandbox(t);
  mkdirSync(join(sandbox, 'adapted'), { recursive: true });
  return {
    sandbox,
    portPath: join(sandbox, 'cli', 'port.ts'),
    baseArgs: ['--src', 'src', '--adapted', 'adapted', '--logs', join(sandbox, 'logs')],
  };
}

function writeFakeDiffGate(sandbox: string, behavior: { exit: number; counts?: Record<string, number> }): void {
  const counts = behavior.counts ?? { typeOnly: 12, importPath: 0, needsReview: 0, cannotPair: 0 };
  writeFakeTool(join(sandbox, 'cli'), 'diff-gate', {
    exit: behavior.exit,
    stdout: JSON.stringify({ ok: behavior.exit === 0, files: [], counts }),
  });
}

test('diff：exit 0 -> PASS（0 needs-review），参数按契约透传', (t) => {
  const { sandbox, portPath, baseArgs } = makeDiffSandbox(t);
  writeFakeDiffGate(sandbox, { exit: 0, counts: { typeOnly: 12, importPath: 0, needsReview: 0, cannotPair: 0 } });
  const res = runPort([...baseArgs, '--stages', 'diff', '--report', join(sandbox, 'r.json')], sandbox, portPath);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = readJson(join(sandbox, 'r.json'));
  assert.equal(report.pass, true);
  assert.deepEqual(report.counts, { pass: 1, warn: 0, fail: 0, skip: 0 });
  const stage = stageByName(report, 'diff');
  assert.equal(stage.status, 'PASS');
  assert.equal(stage.exitCode, 0);
  assert.match(String(stage.summary), /0 needs-review/);
  assert.deepEqual(callOf(sandbox, 'diff-gate').argv, ['--before', 'src', '--after', 'adapted', '--json']);
  const metrics = stage.metrics as Record<string, unknown>;
  assert.equal(metrics.typeOnly, 12);
  assert.equal(metrics.needsReview, 0);
});

test('diff：exit 3 -> WARN（只告警），后续阶段继续跑，整体仍 exit 0', (t) => {
  const { sandbox, portPath, baseArgs } = makeDiffSandbox(t);
  writeFakeDiffGate(sandbox, { exit: 3, counts: { typeOnly: 9, importPath: 1, needsReview: 2, cannotPair: 0 } });
  const res = runPort(
    [...baseArgs, '--case', 'case', '--stages', 'diff,fidelity', '--report', join(sandbox, 'r.json')],
    sandbox,
    portPath,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /WARN\s+diff/);
  assert.match(res.stdout, /2 处 needs-review（只告警/);
  const report = readJson(join(sandbox, 'r.json'));
  assert.equal(report.pass, true, 'WARN 不改变 pass 真值');
  assert.deepEqual(report.counts, { pass: 1, warn: 1, fail: 0, skip: 0 });
  assert.equal(stageByName(report, 'diff').status, 'WARN');
  assert.equal(stageByName(report, 'fidelity').status, 'PASS', 'WARN 不能阻断后续阶段');
  assert.equal(report.stoppedEarly, false);
  const metrics = stageByName(report, 'diff').metrics as Record<string, unknown>;
  assert.equal(metrics.needsReview, 2);
  assert.equal(metrics.verdict, 'WARN');
});

test('diff：--strict-diff 把 WARN 视为 FAIL（exit 1）', (t) => {
  const { sandbox, portPath, baseArgs } = makeDiffSandbox(t);
  writeFakeDiffGate(sandbox, { exit: 3, counts: { typeOnly: 9, importPath: 0, needsReview: 1, cannotPair: 0 } });
  const res = runPort(
    [...baseArgs, '--stages', 'diff', '--strict-diff', '--report', join(sandbox, 'r.json')],
    sandbox,
    portPath,
  );
  assert.equal(res.code, 1);
  const report = readJson(join(sandbox, 'r.json'));
  assert.equal(report.pass, false);
  assert.deepEqual(report.counts, { pass: 0, warn: 0, fail: 1, skip: 0 });
  const stage = stageByName(report, 'diff');
  assert.equal(stage.status, 'FAIL');
  assert.match(String(stage.summary), /--strict-diff 视为失败/);
  assert.equal((stage.metrics as Record<string, unknown>).strictDiff, 'true');
});

test('diff：输入缺失/目录不存在 -> SKIP（不算 PASS）', (t) => {
  const sandbox = makeSandbox(t);
  const portPath = join(sandbox, 'cli', 'port.ts');

  let res = runPort(
    ['--src', 'src', '--stages', 'diff', '--logs', join(sandbox, 'l1'), '--report', join(sandbox, 'r1.json')],
    sandbox,
    portPath,
  );
  assert.equal(res.code, 1);
  let stage = stageByName(readJson(join(sandbox, 'r1.json')), 'diff');
  assert.equal(stage.status, 'SKIP');
  assert.match(String(stage.summary), /缺少 --adapted/);

  res = runPort(
    ['--adapted', 'adapted', '--stages', 'diff', '--logs', join(sandbox, 'l2'), '--report', join(sandbox, 'r2.json')],
    sandbox,
    portPath,
  );
  assert.equal(res.code, 1);
  stage = stageByName(readJson(join(sandbox, 'r2.json')), 'diff');
  assert.equal(stage.status, 'SKIP');
  assert.match(String(stage.summary), /缺少 --src/);

  res = runPort(
    ['--src', 'src', '--adapted', 'nope', '--stages', 'diff', '--logs', join(sandbox, 'l3'), '--report', join(sandbox, 'r3.json')],
    sandbox,
    portPath,
  );
  assert.equal(res.code, 1);
  stage = stageByName(readJson(join(sandbox, 'r3.json')), 'diff');
  assert.equal(stage.status, 'SKIP');
  assert.match(String(stage.summary), /--after 目录不存在/);
});

test('diff：子工具其它退出码（如 2）-> FAIL，且默认失败即停', (t) => {
  const { sandbox, portPath, baseArgs } = makeDiffSandbox(t);
  writeFakeTool(join(sandbox, 'cli'), 'diff-gate', { exit: 2, stderr: 'diff-gate 失败：参数错误\n' });
  const res = runPort(
    [...baseArgs, '--case', 'case', '--stages', 'diff,fidelity', '--report', join(sandbox, 'r.json')],
    sandbox,
    portPath,
  );
  assert.equal(res.code, 1);
  const report = readJson(join(sandbox, 'r.json'));
  assert.equal(report.pass, false);
  assert.equal(report.stoppedEarly, true, 'FAIL 默认停止后续阶段');
  assert.deepEqual(report.remaining, ['fidelity']);
  const stage = stageByName(report, 'diff');
  assert.equal(stage.status, 'FAIL');
  assert.match(String(stage.summary), /告警门禁失败/);
});

test('diff：diff-gate 未就绪 -> SKIP，不假装通过', (t) => {
  const sandbox = makeSandbox(t);
  rmSync(join(sandbox, 'cli', 'diff-gate.ts'), { force: true });
  const res = runPort(
    ['--src', 'src', '--adapted', 'adapted', '--stages', 'diff', '--logs', join(sandbox, 'logs'), '--report', join(sandbox, 'r.json')],
    sandbox,
    join(sandbox, 'cli', 'port.ts'),
  );
  assert.equal(res.code, 1);
  const stage = stageByName(readJson(join(sandbox, 'r.json')), 'diff');
  assert.equal(stage.status, 'SKIP');
  assert.match(String(stage.summary), /未就绪/);
});
