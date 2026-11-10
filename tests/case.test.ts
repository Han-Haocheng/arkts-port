import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测 cli/case.ts：fixture manifest + 假 CLI/fake runner；另含 3 个真实 case smoke。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const casePath = join(repoRoot, 'cli', 'case.ts');
const LEGADO_REFS = '/mnt/d/Project/legado-with-MD3/.refs';
const JS_TS_SOURCES = [
  '/mnt/d/Project/legado-with-MD3/.refs/js-ts/src/utils/chapterProgress.ts',
  '/mnt/d/Project/legado-with-MD3/modules/web/src/utils/chapterProgress.ts',
];
const YOGA_SOURCE = process.env.ARKTS_PORT_YOGA_SRC || '/mnt/d/Project/dsh-TUI/src/native-ts/yoga-layout';

interface TestHooks {
  after(fn: () => void): void;
}

interface Stage {
  name: string;
  title: string;
  status: string;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  logPath: string;
  reportPath?: string;
  optional: boolean;
  metrics?: Record<string, unknown>;
}

interface Report {
  schemaVersion: number;
  case: string;
  mode: string;
  requested: string[];
  stages: Stage[];
  pass: boolean;
  counts: { pass: number; warn: number; fail: number; skip: number };
  stoppedEarly: boolean;
  remaining: string[];
  refs: string | null;
  skippedNonOptional: number;
  skipReason: string | null;
  reportPath: string;
}

function makeTmp(t: TestHooks): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-port-case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function runCase(args: string[], cwd: string): { code: number | null; stdout: string; stderr: string } {
  const sandboxCopy = join(cwd, 'cli', 'case.ts');
  const script = existsSync(sandboxCopy) ? sandboxCopy : casePath;
  const res = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function reportOf(stdout: string): Report {
  return JSON.parse(stdout) as Report;
}

function stageOf(report: Report, name: string): Stage {
  const found = report.stages.find((stage) => stage.name === name);
  assert.ok(found, '报告里应有 stage：' + name);
  return found;
}

const PLACEHOLDER_REFS = '$' + '{refs}';

const FAKE_CLI = [
  "import { mkdirSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const argv = process.argv.slice(2);",
  "const modeIndex = argv.indexOf('--mode');",
  "const mode = modeIndex >= 0 ? argv[modeIndex + 1] : 'ok';",
  "mkdirSync('calls', { recursive: true });",
  "writeFileSync(join('calls', 'fake-cli-' + mode + '.json'), JSON.stringify({ argv }));",
  "if (mode === 'ok') { console.log(JSON.stringify({ files: 22, loc: 4925, pass: true })); process.exit(0); }",
  "if (mode === 'warn') { console.log(JSON.stringify({ files: 21, loc: 4000 })); process.exit(0); }",
  "if (mode === 'fail') { console.error('boom: fake failure'); process.exit(1); }",
  "if (mode === 'slow') { setTimeout(() => { console.log('{}'); process.exit(0); }, 500); }",
  "",
].join('\n');

const FAKE_RUN = [
  "import { mkdirSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const argv = process.argv.slice(2);",
  "const modeIndex = argv.indexOf('--mode');",
  "const mode = modeIndex >= 0 ? argv[modeIndex + 1] : 'pass';",
  "const stageIndex = argv.indexOf('--stage');",
  "const stage = stageIndex >= 0 ? argv[stageIndex + 1] : 'all';",
  "mkdirSync('calls', { recursive: true });",
  "writeFileSync(join('calls', 'fake-run.json'), JSON.stringify({ argv }));",
  "const gates = mode === 'fail'",
  "  ? [{ gate: 'g1', title: 'golden', status: 'FAIL', detail: 'boom', metrics: {} },",
  "     { gate: 'g2', title: 'fidelity', status: 'PASS', detail: 'ok', metrics: { fidelityPct: 100 } }]",
  "  : [{ gate: 'g1', title: 'golden', status: 'PASS', detail: 'stable', metrics: { goldenSha256: 'abc', scenarios: 2 } },",
  "     { gate: 'g2', title: 'fidelity', status: 'INFO', detail: 'info only', metrics: { fidelityPct: 100 } }];",
  "const evidence = { case: 'runner-demo', selected: stage === 'all' ? ['g1', 'g2'] : [stage], pass: mode !== 'fail', gates };",
  "mkdirSync('out', { recursive: true });",
  "writeFileSync(join('out', 'runner-evidence.json'), JSON.stringify(evidence, null, 2) + String.fromCharCode(10));",
  "console.log(JSON.stringify(evidence));",
  "process.exit(mode === 'fail' ? 1 : 0);",
  "",
].join('\n');

function stageDef(name: string, mode: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return Object.assign({
    name,
    title: name + ' title',
    argv: ['node', 'tests/fixtures/case-runner/fake-cli.mjs', '--mode', mode],
    optional: false,
  }, extra ?? {});
}

function makeSandbox(t: TestHooks): { root: string; cases: string } {
  const root = makeTmp(t);
  write(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(root, 'cli'), { recursive: true });
  cpSync(casePath, join(root, 'cli', 'case.ts'));
  write(join(root, 'tests', 'fixtures', 'case-runner', 'fake-cli.mjs'), FAKE_CLI);
  write(join(root, 'tests', 'fixtures', 'case-runner', 'fake-run.mjs'), FAKE_RUN);
  const cases = join(root, 'cases');

  write(join(cases, 'stages-demo', 'case.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'stages-demo',
    title: 'stages fixture',
    lang: 'jvm',
    mode: 'stages',
    upstream: { paths: ['tests/fixtures/case-runner'] },
    external: { refsEnv: 'CASE_TEST_REFS', refsDefault: '/nonexistent-refs' },
    stages: [
      stageDef('s1', 'ok', { expect: { exit: 0, report: { files: 22, loc: 4925 } } }),
      stageDef('s2', 'ok'),
      stageDef('s3', 'ok'),
    ],
  }, null, 2));

  write(join(cases, 'stages-fail', 'case.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'stages-fail',
    title: 'failing stage fixture',
    lang: 'jvm',
    mode: 'stages',
    upstream: { paths: ['tests/fixtures/case-runner'] },
    stages: [
      stageDef('s1', 'ok'),
      stageDef('s2', 'fail'),
      stageDef('s3', 'ok'),
    ],
  }, null, 2));

  write(join(cases, 'stages-optional', 'case.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'stages-optional',
    title: 'optional skip fixture',
    lang: 'jvm',
    mode: 'stages',
    external: { refsEnv: 'CASE_TEST_REFS', refsDefault: '/nonexistent-refs' },
    stages: [
      stageDef('needs-refs', 'ok', { optional: true, argv: ['node', 'tests/fixtures/case-runner/fake-cli.mjs', '--mode', 'ok', '--refs', PLACEHOLDER_REFS] }),
    ],
  }, null, 2));

  write(join(cases, 'stages-notready', 'case.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'stages-notready',
    title: 'required missing fixture',
    lang: 'jvm',
    mode: 'stages',
    external: { refsEnv: 'CASE_TEST_REFS', refsDefault: '/nonexistent-refs' },
    stages: [
      stageDef('needs-refs', 'ok', { argv: ['node', 'tests/fixtures/case-runner/fake-cli.mjs', '--mode', 'ok', '--refs', PLACEHOLDER_REFS] }),
    ],
  }, null, 2));

  write(join(cases, 'stages-stdout', 'case.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'stages-stdout',
    title: 'stdoutFile fixture',
    lang: 'jvm',
    mode: 'stages',
    upstream: { paths: ['tests/fixtures/case-runner'] },
    stages: [
      stageDef('emit', 'ok', { stdoutFile: 'out/case/stages-stdout/actual.json' }),
    ],
  }, null, 2));

  write(join(cases, 'runner-demo', 'case.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'runner-demo',
    title: 'runner fixture',
    lang: 'js-ts',
    mode: 'runner',
    upstream: { paths: ['tests/fixtures/case-runner'] },
    runner: {
      cmd: ['node', 'tests/fixtures/case-runner/fake-run.mjs', '--mode', 'pass'],
      jsonFlag: '--json',
      stageFlag: '--stage',
      updateFlag: '--update',
      stages: ['g1', 'g2'],
      evidence: 'out/runner-evidence.json',
    },
  }, null, 2));

  write(join(cases, 'runner-fail', 'case.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'runner-fail',
    title: 'runner fail fixture',
    lang: 'js-ts',
    mode: 'runner',
    upstream: { paths: ['tests/fixtures/case-runner'] },
    runner: {
      cmd: ['node', 'tests/fixtures/case-runner/fake-run.mjs', '--mode', 'fail'],
      stageFlag: '--stage',
      stages: ['g1', 'g2'],
      evidence: 'out/runner-evidence.json',
    },
  }, null, 2));

  write(join(cases, 'runner-noupdate', 'case.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'runner-noupdate',
    title: 'runner without update fixture',
    lang: 'js-ts',
    mode: 'runner',
    upstream: { paths: ['tests/fixtures/case-runner'] },
    runner: {
      cmd: ['node', 'tests/fixtures/case-runner/fake-run.mjs', '--mode', 'pass'],
      stageFlag: '--stage',
      stages: ['g1'],
      evidence: 'out/runner-evidence.json',
    },
  }, null, 2));

  write(join(cases, 'invalid', 'case.json'), JSON.stringify({ schemaVersion: 2, id: 'invalid' }, null, 2));
  return { root, cases };
}

// ---------------------------------------------------------------------------
// 清单 / --list
// ---------------------------------------------------------------------------

test('--list：稳定列出 case（含 invalid），--json 可解析', (t) => {
  const sandbox = makeSandbox(t);
  const human = runCase(['--list'], sandbox.root);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /stages-demo/);
  assert.match(human.stdout, /runner-demo/);
  assert.match(human.stdout, /invalid/);

  const json = runCase(['--list', '--json'], sandbox.root);
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.stdout) as { schemaVersion: number; cases: Array<Record<string, unknown>> };
  assert.equal(payload.schemaVersion, 1);
  const byId = new Map(payload.cases.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('stages-demo')?.mode, 'stages');
  assert.deepEqual(byId.get('stages-demo')?.stages, ['s1', 's2', 's3']);
  assert.equal(byId.get('runner-demo')?.mode, 'runner');
  assert.deepEqual(byId.get('runner-demo')?.stages, ['g1', 'g2']);
  assert.equal(byId.get('stages-notready')?.ready, false);
});

test('清单非法/未知 case/未知 stage/--update（stages）→ exit 2', (t) => {
  const sandbox = makeSandbox(t);
  const cases: string[][] = [
    ['--case', 'cases/invalid'],
    ['--case', 'no-such-case'],
    ['--case', 'stages-demo', '--stage', 'nope'],
    ['--case', 'stages-demo', '--update'],
    ['--case', 'stages-demo', '--stage'],
  ];
  for (const args of cases) {
    const res = runCase(args, sandbox.root);
    assert.equal(res.code, 2, '应 exit 2：' + JSON.stringify(args) + '\n' + res.stdout + res.stderr);
    assert.match(res.stderr, /case: /);
  }
});

// ---------------------------------------------------------------------------
// stages 模式
// ---------------------------------------------------------------------------

test('stages 全 PASS：顺序/报告 schema/expect 展示/日志', (t) => {
  const sandbox = makeSandbox(t);
  const reportPath = join(sandbox.root, 'out', 'r.json');
  const res = runCase(['--case', 'stages-demo', '--json', '--report', reportPath], sandbox.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = reportOf(res.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.case, 'stages-demo');
  assert.equal(report.mode, 'stages');
  assert.deepEqual(report.requested, ['s1', 's2', 's3']);
  assert.deepEqual(report.stages.map((stage) => stage.name), ['s1', 's2', 's3']);
  assert.deepEqual(report.counts, { pass: 3, warn: 0, fail: 0, skip: 0 });
  assert.equal(report.pass, true);
  assert.equal(report.stoppedEarly, false);
  assert.deepEqual(report.remaining, []);
  assert.equal(stageOf(report, 's1').status, 'PASS');
  assert.match(stageOf(report, 's1').summary, /files=22/);
  for (const stage of report.stages) {
    assert.ok(existsSync(join(sandbox.root, stage.logPath)), '日志应存在：' + stage.logPath);
    assert.equal(stage.logPath.startsWith('out/logs/'), true);
    assert.equal(typeof stage.durationMs, 'number');
  }
  assert.deepEqual(reportOf(readFileSync(reportPath, 'utf8')), report);
});

test('stages FAIL 即停 + remaining；--continue 继续跑完但整体 exit 1', (t) => {
  const sandbox = makeSandbox(t);
  const strict = runCase(['--case', 'stages-fail', '--json'], sandbox.root);
  assert.equal(strict.code, 1);
  const strictReport = reportOf(strict.stdout);
  assert.deepEqual(strictReport.stages.map((stage) => stage.name), ['s1', 's2']);
  assert.equal(stageOf(strictReport, 's2').status, 'FAIL');
  assert.deepEqual(strictReport.remaining, ['s3']);
  assert.equal(strictReport.stoppedEarly, true);

  const cont = runCase(['--case', 'stages-fail', '--continue', '--json'], sandbox.root);
  assert.equal(cont.code, 1);
  const contReport = reportOf(cont.stdout);
  assert.deepEqual(contReport.stages.map((stage) => stage.name), ['s1', 's2', 's3']);
  assert.deepEqual(contReport.remaining, []);
});

test('stage 子集按清单顺序执行（与书写顺序无关）', (t) => {
  const sandbox = makeSandbox(t);
  const res = runCase(['--case', 'stages-demo', '--stage', 's3,s1', '--json'], sandbox.root);
  assert.equal(res.code, 0);
  assert.deepEqual(reportOf(res.stdout).stages.map((stage) => stage.name), ['s1', 's3']);
});

test('optional SKIP → exit 0；非 optional SKIP → exit 3（带 reason）', (t) => {
  const sandbox = makeSandbox(t);
  const optional = runCase(['--case', 'stages-optional', '--refs', '/nonexistent-refs', '--json'], sandbox.root);
  assert.equal(optional.code, 0, optional.stdout + optional.stderr);
  const optionalReport = reportOf(optional.stdout);
  assert.equal(stageOf(optionalReport, 'needs-refs').status, 'SKIP');
  assert.equal(optionalReport.skippedNonOptional, 0);
  assert.match(String(stageOf(optionalReport, 'needs-refs').summary), /外部证据缺失/);

  const required = runCase(['--case', 'stages-notready', '--refs', '/nonexistent-refs', '--json'], sandbox.root);
  assert.equal(required.code, 3);
  const requiredReport = reportOf(required.stdout);
  assert.equal(requiredReport.skippedNonOptional, 1);
  assert.match(String(requiredReport.skipReason), /外部证据缺失/);
});

test('stdoutFile：stage stdout 落盘；超时 → FAIL', (t) => {
  const sandbox = makeSandbox(t);
  const res = runCase(['--case', 'stages-stdout', '--json'], sandbox.root);
  assert.equal(res.code, 0);
  const actualPath = join(sandbox.root, 'out', 'case', 'stages-stdout', 'actual.json');
  assert.ok(existsSync(actualPath));
  assert.match(readFileSync(actualPath, 'utf8'), /"files":22/);

  // 用 stages-demo 的 fake-cli slow 模式 + --timeout 10 验证超时记 FAIL
  const manifestPath = join(sandbox.cases, 'stages-demo', 'case.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.stages[0].argv = ['node', 'tests/fixtures/case-runner/fake-cli.mjs', '--mode', 'slow'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const timed = runCase(['--case', 'stages-demo', '--stage', 's1', '--timeout', '10', '--json'], sandbox.root);
  assert.equal(timed.code, 1);
  assert.equal(stageOf(reportOf(timed.stdout), 's1').status, 'FAIL');
  assert.match(String(stageOf(reportOf(timed.stdout), 's1').summary), /超时/);
});

// ---------------------------------------------------------------------------
// runner 模式
// ---------------------------------------------------------------------------

test('runner：gates 归一化（PASS/INFO→WARN），--stage all 一次委托', (t) => {
  const sandbox = makeSandbox(t);
  const res = runCase(['--case', 'runner-demo', '--stage', 'all', '--json'], sandbox.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = reportOf(res.stdout);
  assert.deepEqual(report.stages.map((stage) => stage.name), ['g1', 'g2']);
  assert.deepEqual(report.stages.map((stage) => stage.status), ['PASS', 'WARN']);
  assert.equal(report.counts.warn, 1);
  assert.equal(report.pass, true);
  assert.equal(stageOf(report, 'g1').metrics?.goldenSha256, 'abc');
  assert.equal(String(stageOf(report, 'g1').reportPath), 'out/runner-evidence.json');
  const call = JSON.parse(readFileSync(join(sandbox.root, 'calls', 'fake-run.json'), 'utf8')) as { argv: string[] };
  assert.ok(call.argv.includes('--json'));
  assert.ok(call.argv.includes('--stage'));
});

test('runner：--stage g1,g2 逐阶段委托；--update/--case-arg 透传', (t) => {
  const sandbox = makeSandbox(t);
  const res = runCase(['--case', 'runner-demo', '--stage', 'g1,g2', '--update', '--case-arg', '--no-fix', '--json'], sandbox.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = reportOf(res.stdout);
  assert.deepEqual(report.stages.map((stage) => stage.name), ['g1', 'g2']);
  const call = JSON.parse(readFileSync(join(sandbox.root, 'calls', 'fake-run.json'), 'utf8')) as { argv: string[] };
  assert.ok(call.argv.includes('--update'));
  assert.ok(call.argv.includes('--no-fix'));
  assert.ok(call.argv.includes('--stage'));
});

test('runner fail：evidence.pass=false → 整体 exit 1，gates FAIL 映射正确', (t) => {
  const sandbox = makeSandbox(t);
  const res = runCase(['--case', 'runner-fail', '--stage', 'g1', '--json'], sandbox.root);
  assert.equal(res.code, 1);
  const report = reportOf(res.stdout);
  assert.equal(report.pass, false);
  assert.equal(report.stages.some((stage) => stage.status === 'FAIL'), true);
  assert.equal(report.counts.fail >= 1, true);
});

test('runner 不支持 --update → exit 2', (t) => {
  const sandbox = makeSandbox(t);
  const res = runCase(['--case', 'runner-noupdate', '--update'], sandbox.root);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--update/);
});

// ---------------------------------------------------------------------------
// 真实 case smoke
// ---------------------------------------------------------------------------

test('真实 smoke：legado stages（stage,replay,fidelity）', (t) => {
  if (!existsSync(LEGADO_REFS)) {
    t.skip('缺少 ' + LEGADO_REFS);
    return;
  }
  const reportPath = join(makeTmp(t), 'legado.json');
  const res = runCase(['--case', 'cases/legado', '--stage', 'stage,replay,fidelity', '--json', '--report', reportPath], repoRoot);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  assert.deepEqual(report.stages.map((stage) => stage.name), ['stage', 'replay', 'fidelity']);
  assert.deepEqual(report.counts, { pass: 3, warn: 0, fail: 0, skip: 0 });
  assert.equal(report.pass, true);
  assert.match(String(stageOf(report, 'stage').summary), /files=22/);
  assert.match(String(stageOf(report, 'fidelity').summary), /sameItems=62/);
});

test('真实 smoke：js-ts runner（g1,g2）', (t) => {
  if (!JS_TS_SOURCES.some((path) => existsSync(path))) {
    t.skip('缺少 js-ts 上游 source');
    return;
  }
  const reportPath = join(makeTmp(t), 'js-ts.json');
  const res = runCase(['--case', 'js-ts', '--stage', 'g1,g2', '--json', '--report', reportPath], repoRoot);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  assert.deepEqual(report.stages.map((stage) => stage.name), ['g1', 'g2']);
  assert.deepEqual(report.stages.map((stage) => stage.status), ['PASS', 'PASS']);
  assert.equal(report.pass, true);
});

test('真实 smoke：js-ts-yoga runner（g1,g2,g4）', (t) => {
  if (!existsSync(YOGA_SOURCE)) {
    t.skip('缺少 yoga 源：' + YOGA_SOURCE);
    return;
  }
  const reportPath = join(makeTmp(t), 'yoga.json');
  const res = runCase(['--case', 'js-ts-yoga', '--stage', 'g1,g2,g4', '--json', '--report', reportPath], repoRoot);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  assert.deepEqual(report.stages.map((stage) => stage.name), ['g1', 'g2', 'g4']);
  assert.equal(report.pass, true);
});
