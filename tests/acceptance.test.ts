import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测仓库里的 scripts/acceptance.mjs；CLI/证据/案例全部用沙箱里的假实现，不依赖真实 .refs/SDK。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const realAcceptance = join(repoRoot, 'scripts', 'acceptance.mjs');

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface StageReport {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  exitCode: number | null;
  durationMs: number;
  summary: string;
  logPath: string;
  metrics?: Record<string, unknown>;
}

interface Report {
  ok: boolean;
  stages: StageReport[];
  refs: string;
  out: string;
  counts: { pass: number; fail: number; skip: number };
  stoppedEarly: boolean;
  remaining: string[];
  skipBuild: boolean;
}

function makeTmp(t: TestHooks): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-port-acceptance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function fakeCli(cliDir: string, name: string, body: string): void {
  write(join(cliDir, name + '.ts'), body);
}

const STAGE_FAKE = [
  "import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const argv = process.argv.slice(2);",
  "const get = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };",
  "const dest = get('--dest', 'out/ts');",
  "const ctl = existsSync('control.json') ? JSON.parse(readFileSync('control.json', 'utf8')) : {};",
  "const c = Object.assign({ files: 22, loc: 4925, checkOk: true, stageOk: true }, ctl.stage || {});",
  "if (argv.includes('--check')) {",
  "  const ok = c.checkOk;",
  "  console.log(JSON.stringify({ ok: ok, files: c.files, loc: c.loc, dest: dest, source: 'fake-refs', mismatches: ok ? [] : [{ file: 'layout/A.ts', kind: 'hash' }] }));",
  "  process.exit(ok ? 0 : 1);",
  "}",
  "if (!c.stageOk) { console.log('stage-case: fake failure'); process.exit(1); }",
  "mkdirSync(join(dest, 'layout'), { recursive: true });",
  "mkdirSync(join(dest, 'model'), { recursive: true });",
  "mkdirSync(join(dest, 'style'), { recursive: true });",
  "for (let i = 0; i < 22; i++) {",
  "  writeFileSync(join(dest, 'layout', 'File' + i + '.ts'), 'export const a = ' + i + ';');",
  "}",
  "console.log(JSON.stringify({ ok: true, files: c.files, loc: c.loc, dest: dest, source: 'fake-refs', mismatches: [] }));",
  "process.exit(0);",
  '',
].join('\n');

const GEN_GOLDEN_FAKE = [
  "import { createHash } from 'node:crypto';",
  "import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const argv = process.argv.slice(2);",
  "const get = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };",
  "const out = get('--out', 'out/golden');",
  "const reportPath = get('--report', '');",
  "const ctl = existsSync('control.json') ? JSON.parse(readFileSync('control.json', 'utf8')) : {};",
  "const c = Object.assign({ corrupt: false }, ctl.golden || {});",
  "const source = readFileSync(join('cases', 'legado', 'golden.json'));",
  "const payload = c.corrupt ? Buffer.concat([source, Buffer.from(' ')]) : source;",
  "mkdirSync(out, { recursive: true });",
  "writeFileSync(join(out, 'golden.json'), payload);",
  "const sha = createHash('sha256').update(payload).digest('hex');",
  "const report = { ok: true, stable: true, goldenSha256: sha, goldenBytes: payload.length, compile: { exitCode: 0, durationMs: 1 }, run: { exitCode: 0, durationMs: 1 } };",
  "if (reportPath !== '') { const dir = reportPath.slice(0, reportPath.lastIndexOf('/')); if (dir !== '' && dir !== reportPath) mkdirSync(dir, { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2)); }",
  "console.log(JSON.stringify(report));",
  "process.exit(0);",
  '',
].join('\n');

const FIDELITY_FAKE = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "const ctl = existsSync('control.json') ? JSON.parse(readFileSync('control.json', 'utf8')) : {};",
  "const c = Object.assign({ pass: true, fidelityPct: 100, sameItems: 62, totalItems: 62, sameScenarios: 16, totalScenarios: 16, missingScenarios: 0 }, ctl.fidelity || {});",
  "console.log(JSON.stringify(c));",
  "process.exit(c.pass ? 0 : 1);",
  '',
].join('\n');

const ADAPT_FAKE = [
  "import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const argv = process.argv.slice(2);",
  "const get = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };",
  "const out = get('--out', 'out/ets');",
  "const reportPath = get('--report', '');",
  "const ctl = existsSync('control.json') ? JSON.parse(readFileSync('control.json', 'utf8')) : {};",
  "const c = Object.assign({ exit: 0, summary: { filesScanned: 22, filesChanged: 22, options: 43, patches: 41, renames: 9, asConst: 9, residuals: 7 } }, ctl.adapt || {});",
  "mkdirSync(join(out, 'layout'), { recursive: true });",
  "mkdirSync(join(out, 'model'), { recursive: true });",
  "mkdirSync(join(out, 'style'), { recursive: true });",
  "for (let i = 0; i < 22; i++) {",
  "  writeFileSync(join(out, 'layout', 'File' + i + '.ets'), '// codemod output');",
  "}",
  "const report = { summary: c.summary, changes: [], residuals: [] };",
  "if (reportPath !== '') { writeFileSync(reportPath, JSON.stringify(report, null, 2)); }",
  "console.log(JSON.stringify(report));",
  "process.exit(c.exit);",
  '',
].join('\n');

const DIFF_GATE_FAKE = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "const ctl = existsSync('control.json') ? JSON.parse(readFileSync('control.json', 'utf8')) : {};",
  "const c = Object.assign({ needsReview: 0, typeOnly: 169, importPath: 14, exit: 0 }, ctl.diff || {});",
  "const report = { ok: c.needsReview === 0, counts: { typeOnly: c.typeOnly, importPath: c.importPath, needsReview: c.needsReview, cannotPair: 0 } };",
  "console.log(JSON.stringify(report));",
  "process.exit(c.exit);",
  '',
].join('\n');

const REACH_FAKE = [
  "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const argv = process.argv.slice(2);",
  "const get = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };",
  "const project = get('--project', '.');",
  "const ctl = existsSync('control.json') ? JSON.parse(readFileSync('control.json', 'utf8')) : {};",
  "const c = Object.assign({ codemodModules: 45, codemodErrors: 9, codemodWarn: 1, referenceModules: 45, referenceErrors: 0 }, ctl.reach || {});",
  "const parity = join(project, 'entry', 'src', 'main', 'ets', 'parity');",
  "let marker = 'reference';",
  "if (existsSync(parity)) {",
  "  for (const entry of readdirSync(parity, { recursive: true })) {",
  "    const rel = String(entry);",
  "    if (!rel.endsWith('.ets')) continue;",
  "    if (readFileSync(join(parity, rel), 'utf8').includes('codemod')) { marker = 'codemod'; break; }",
  "  }",
  "}",
  "const report = marker === 'codemod' ? { probeModules: c.codemodModules, arktsErrors: c.codemodErrors, warnArktsErrors: c.codemodWarn, pass: c.codemodErrors === 0 } : { probeModules: c.referenceModules, arktsErrors: c.referenceErrors, warnArktsErrors: 0, pass: c.referenceErrors === 0 };",
  "console.log(JSON.stringify(report));",
  "process.exit(report.pass ? 0 : 1);",
  '',
].join('\n');

const LINT_FAKE = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "const ctl = existsSync('control.json') ? JSON.parse(readFileSync('control.json', 'utf8')) : {};",
  "const c = Object.assign({ pass: true, arktsErrors: 0 }, ctl.lint || {});",
  "console.log(JSON.stringify(c));",
  "process.exit(c.pass ? 0 : 1);",
  '',
].join('\n');

const BUILD_FAKE = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "const ctl = existsSync('control.json') ? JSON.parse(readFileSync('control.json', 'utf8')) : {};",
  "const c = Object.assign({ exit: 0, output: 'BUILD SUCCESSFUL' }, ctl.build || {});",
  "console.log(c.output);",
  "process.exit(c.exit);",
  '',
].join('\n');

const ACTUAL_JSON = '[{"scenario":"s1","pageCount":1,"pages":[{"pageIndex":0,"text":"a"}]}]\n';

function makeSandbox(t: TestHooks) {
  const root = makeTmp(t);
  write(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(realAcceptance, join(root, 'scripts', 'acceptance.mjs'));
  write(join(root, 'scripts', 'stage-case.mjs'), STAGE_FAKE);
  mkdirSync(join(root, 'cli'), { recursive: true });
  fakeCli(join(root, 'cli'), 'gen-golden', GEN_GOLDEN_FAKE);
  fakeCli(join(root, 'cli'), 'verify-fidelity', FIDELITY_FAKE);
  fakeCli(join(root, 'cli'), 'adapt-arkts', ADAPT_FAKE);
  fakeCli(join(root, 'cli'), 'diff-gate', DIFF_GATE_FAKE);
  fakeCli(join(root, 'cli'), 'reachability-probe', REACH_FAKE);
  fakeCli(join(root, 'cli'), 'lint-arkts', LINT_FAKE);
  fakeCli(join(root, 'cli'), 'build-hap', BUILD_FAKE);

  mkdirSync(join(root, 'cases', 'legado'), { recursive: true });
  write(join(root, 'cases', 'legado', 'golden.json'), '{"scenario":"s1"}\n');
  write(join(root, 'cases', 'legado', 'actual.json'), ACTUAL_JSON);
  write(join(root, 'cases', 'legado', 'replay.ts'),
    "import { readFileSync } from 'node:fs'; process.stdout.write(readFileSync('cases/legado/actual.json'));");

  const refs = join(root, '.refs');
  mkdirSync(join(refs, 'pag-exp', 'src'), { recursive: true });
  write(join(refs, 'pag-exp', 'src', 'Main.kt'), 'package fixture\n');
  mkdirSync(join(refs, 'arkts-adapt-baseline', 'layout'), { recursive: true });
  write(join(refs, 'arkts-adapt-baseline', 'layout', 'A.ts'), 'export type A = {};\n');

  const project = join(refs, 'arkts-check');
  mkdirSync(join(project, 'AppScope'), { recursive: true });
  write(join(project, 'AppScope', 'app.json5'), '{"app":{}}\n');
  write(join(project, 'build-profile.json5'), '{"app":{}}\n');
  mkdirSync(join(project, 'entry', 'src', 'main', 'ets', 'pages'), { recursive: true });
  write(join(project, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), '\n');
  mkdirSync(join(project, 'entry', 'build', 'stale'), { recursive: true });
  write(join(project, 'entry', 'build', 'stale', 'sentinel.txt'), 'should-not-be-copied\n');
  for (let i = 0; i < 22; i++) {
    const dir = i < 11 ? 'layout' : 'model';
    mkdirSync(join(project, 'entry', 'src', 'main', 'ets', 'parity', dir), { recursive: true });
    write(join(project, 'entry', 'src', 'main', 'ets', 'parity', dir, 'Ref' + i + '.ets'), '// reference parity\n');
  }

  mkdirSync(join(root, 'sdk', '26.0.0', 'ets'), { recursive: true });
  mkdirSync(join(root, 'hvigor', '@ohos', 'hvigor', 'bin'), { recursive: true });
  write(join(root, 'hvigor', '@ohos', 'hvigor', 'bin', 'hvigor.js'), '\n');

  const control = join(root, 'control.json');
  writeFileSync(control, '{}\n', 'utf8');
  return { root, refs, control, acceptance: join(root, 'scripts', 'acceptance.mjs') };
}

function setControl(sandbox: { control: string }, patch: Record<string, unknown>): void {
  writeFileSync(sandbox.control, JSON.stringify(patch, null, 2) + '\n', 'utf8');
}

function runAcceptance(args: string[], cwd: string, acceptance: string): RunResult {
  const res = spawnSync(process.execPath, [acceptance, ...args], { cwd, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function baseArgs(extra: string[] = []): string[] {
  return ['--refs', '.refs', '--out', 'out', ...extra];
}

function readReport(path: string): Report {
  return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

function humanLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.trim() !== '');
}

function stageOf(report: Report, name: string): StageReport {
  const found = report.stages.find((stage) => stage.name === name);
  assert.ok(found, '报告里应有阶段：' + name);
  return found;
}

function sanitize(report: Report): unknown {
  return {
    ok: report.ok,
    refs: report.refs,
    out: report.out,
    counts: report.counts,
    stoppedEarly: report.stoppedEarly,
    remaining: report.remaining,
    skipBuild: report.skipBuild,
    stages: report.stages.map((stage) => ({
      name: stage.name,
      status: stage.status,
      exitCode: stage.exitCode,
      summary: stage.summary,
      metrics: stage.metrics,
    })),
  };
}

// ---------------------------------------------------------------------------
// 编排 / SKIP / --json
// ---------------------------------------------------------------------------

test('无 SDK：stage/golden/replay/adapt PASS + arkts-gate SKIP，exit 0，摘要 ≤15 行', (t) => {
  const sandbox = makeSandbox(t);
  const res = runAcceptance(baseArgs(['--json']), sandbox.root, sandbox.acceptance);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.deepEqual(report.stages.map((stage) => stage.status), ['PASS', 'PASS', 'PASS', 'PASS', 'SKIP']);
  assert.deepEqual(report.counts, { pass: 4, fail: 0, skip: 1 });
  assert.equal(report.ok, true);
  assert.equal(report.refs, '.refs');
  assert.equal(report.out, 'out');
  for (const stage of report.stages) {
    assert.equal(typeof stage.logPath, 'string');
    assert.ok(existsSync(join(sandbox.root, stage.logPath)), '日志应存在：' + stage.logPath);
  }
  const written = readReport(join(sandbox.root, 'out', 'acceptance.json'));
  assert.deepEqual(written, report);

  const human = runAcceptance(baseArgs(), sandbox.root, sandbox.acceptance);
  assert.equal(human.code, 0);
  const lines = humanLines(human.stdout);
  assert.ok(lines.length <= 15, '人类摘要应 ≤15 行，实际 ' + lines.length);
  assert.match(human.stdout, /SKIP\s+arkts-gate/);
  assert.match(human.stdout, /结果: PASS（PASS 4 \/ FAIL 0 \/ SKIP 1）/);
});

test('FAIL 即停：golden sha256 不符 → golden FAIL，后续阶段不跑并记 remaining', (t) => {
  const sandbox = makeSandbox(t);
  setControl(sandbox, { golden: { corrupt: true } });
  const res = runAcceptance(baseArgs(['--json']), sandbox.root, sandbox.acceptance);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.deepEqual(report.stages.map((stage) => stage.name), ['stage', 'golden']);
  assert.equal(stageOf(report, 'golden').status, 'FAIL');
  assert.match(stageOf(report, 'golden').summary, /golden sha256 与 cases\/legado\/golden\.json 不一致/);
  assert.deepEqual(report.remaining, ['replay', 'adapt', 'arkts-gate']);
  assert.equal(report.stoppedEarly, true);
  assert.equal(report.ok, false);
});

test('--skip-build：即使给了 SDK 也 SKIP arkts-gate', (t) => {
  const sandbox = makeSandbox(t);
  const res = runAcceptance(
    baseArgs(['--sdk', 'sdk', '--hvigor', 'hvigor', '--skip-build', '--json']),
    sandbox.root,
    sandbox.acceptance,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  const gate = stageOf(report, 'arkts-gate');
  assert.equal(gate.status, 'SKIP');
  assert.match(gate.summary, /--skip-build/);
  assert.equal(report.skipBuild, true);
});

// ---------------------------------------------------------------------------
// arkts-gate：两种口径分开报告
// ---------------------------------------------------------------------------

test('带 SDK：5 阶段全 PASS；arkts-gate 分开报告 codemod 残留口径与参考产物口径', (t) => {
  const sandbox = makeSandbox(t);
  const res = runAcceptance(
    baseArgs(['--sdk', 'sdk', '--hvigor', 'hvigor', '--json']),
    sandbox.root,
    sandbox.acceptance,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.deepEqual(report.stages.map((stage) => stage.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  const gate = stageOf(report, 'arkts-gate');
  const metrics = gate.metrics as Record<string, unknown>;
  assert.equal(metrics.codemodProbeModules, 45);
  assert.equal(metrics.codemodErrors, 9);
  assert.equal(metrics.codemodHard, 8);
  assert.equal(metrics.codemodWarn, 1);
  assert.equal(metrics.referenceProbeModules, 45);
  assert.equal(metrics.referenceErrors, 0);
  assert.equal(metrics.lintErrors, 0);
  assert.equal(metrics.buildSuccessful, true);
  assert.match(gate.summary, /codemod 产物 45 模块 \/ 9 诊断（8 硬 \+ 1 WARN/);
  assert.match(gate.summary, /参考适配产物 45 模块 \/ 0 错误/);
  assert.equal(existsSync(join(sandbox.root, 'out', 'harmony')), false);
});

test('--keep：保留 harmony 工程副本，且不带上 entry/build 的 stale 产物', (t) => {
  const sandbox = makeSandbox(t);
  const res = runAcceptance(
    baseArgs(['--sdk', 'sdk', '--hvigor', 'hvigor', '--keep', '--json']),
    sandbox.root,
    sandbox.acceptance,
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.ok(existsSync(join(sandbox.root, 'out', 'harmony')));
  assert.ok(existsSync(join(sandbox.root, 'out', 'reference-parity')));
  assert.equal(
    existsSync(join(sandbox.root, 'out', 'harmony', 'entry', 'build', 'stale', 'sentinel.txt')),
    false,
  );
});

test('arkts-gate FAIL：codemod 残留口径不符（9→8）时 FAIL 并写清差异', (t) => {
  const sandbox = makeSandbox(t);
  setControl(sandbox, { reach: { codemodErrors: 8 } });
  const res = runAcceptance(
    baseArgs(['--sdk', 'sdk', '--hvigor', 'hvigor', '--json']),
    sandbox.root,
    sandbox.acceptance,
  );
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  const gate = stageOf(report, 'arkts-gate');
  assert.equal(gate.status, 'FAIL');
  assert.match(gate.summary, /expected 45 模块 \/ 9 诊断/);
  assert.match(gate.summary, /actual 45 模块 \/ 8 诊断/);
  assert.equal(report.stoppedEarly, true);
});

// ---------------------------------------------------------------------------
// 用法错误 / 确定性
// ---------------------------------------------------------------------------

test('用法错误 exit 2（未知参数/缺值/refs 不存在/out 指到 refs 内）', (t) => {
  const sandbox = makeSandbox(t);
  const cases: string[][] = [
    ['--bogus'],
    ['--refs'],
    ['--refs', '.refs', '--out'],
    ['--refs', 'missing-refs'],
    ['--refs', '.refs', '--out', '.refs/out'],
  ];
  for (const args of cases) {
    const res = runAcceptance(args, sandbox.root, sandbox.acceptance);
    assert.equal(res.code, 2, '应报用法错误：' + JSON.stringify(args) + '\n' + res.stdout + res.stderr);
    assert.match(res.stderr, /acceptance: /);
  }
});

test('确定性：同输入两次运行，去掉 durationMs 后报告完全相等', (t) => {
  const sandbox = makeSandbox(t);
  const args = baseArgs(['--json']);
  const first = runAcceptance(args, sandbox.root, sandbox.acceptance);
  const second = runAcceptance(args, sandbox.root, sandbox.acceptance);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.deepEqual(
    sanitize(JSON.parse(first.stdout) as Report),
    sanitize(JSON.parse(second.stdout) as Report),
  );
});

test('--help 打印用法并 exit 0', (t) => {
  const sandbox = makeSandbox(t);
  const res = runAcceptance(['--help'], sandbox.root, sandbox.acceptance);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /node scripts\/acceptance\.mjs/);
  assert.match(res.stdout, /退出码：0 = 全部 PASS（SKIP 不算失败）/);
});
