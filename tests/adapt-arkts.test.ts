/**
 * cli/adapt-arkts.ts 的黑盒单测：只经由 CLI 契约（参数、退出码、产物、报告）断言。
 * fixture 全部自造（tests/fixtures/adapt-arkts/**），不依赖上游源码。
 *
 * 跑法：node --test tests/adapt-arkts.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'cli', 'adapt-arkts.ts');
const FIXTURES = join(HERE, 'fixtures', 'adapt-arkts');
const TEMP_DIRS: string[] = [];

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: result.status === null ? -1 : result.status,
    stdout: result.stdout === null ? '' : result.stdout,
    stderr: result.stderr === null ? '' : result.stderr,
  };
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapt-arkts-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function readTree(dir: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) {
      for (const [key, value] of readTree(absolute, rel)) files.set(key, value);
    } else if (entry.isFile()) {
      files.set(rel, readFileSync(absolute, 'utf8'));
    }
  }
  return files;
}

function fixtureDir(name: string, sub = 'src'): string {
  return join(FIXTURES, name, sub);
}

interface FixtureRun {
  result: CliRun;
  outDir: string;
  report: Record<string, unknown>;
  stdoutJson: Record<string, unknown>;
}

function runFixture(name: string, extraArgs: string[] = []): FixtureRun {
  const base = makeTempDir();
  const outDir = join(base, 'out');
  const reportPath = join(base, 'report.json');
  const result = runCli(['--src', fixtureDir(name), '--out', outDir, '--report', reportPath, '--json', ...extraArgs]);
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const stdoutJson = result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
  return { result, outDir, report, stdoutJson };
}

function summaryOf(report: Record<string, unknown>): Record<string, number> {
  return report.summary as Record<string, number>;
}

function codesOf(report: Record<string, unknown>): string[] {
  const residuals = report.residuals as Array<{ code: string }>;
  return residuals.map((item) => item.code).sort();
}

test('规则 1/2：多行构造器 + copy -> Options/Patch，插在类 JSDoc 之前', () => {
  const { result, outDir, report } = runFixture('options-basic');
  assert.equal(result.status, 0, result.stderr);
  const actual = readTree(outDir);
  const expected = readTree(fixtureDir('options-basic', 'expected'));
  assert.deepEqual([...actual.keys()].sort(), ['alpha.ts']);
  assert.equal(actual.get('alpha.ts'), expected.get('alpha.ts'));

  const summary = summaryOf(report);
  assert.equal(summary.filesScanned, 1);
  assert.equal(summary.filesChanged, 1);
  assert.equal(summary.options, 1);
  assert.equal(summary.patches, 1);
  assert.equal(summary.residuals, 0);

  const text = actual.get('alpha.ts');
  assert.ok(text.indexOf('/** AlphaStyle 的构造参数。 */') < text.indexOf('/** 一段文本的显示样式。 */'));
  assert.ok(text.includes('constructor(options: AlphaStyleOptions) {'));
  assert.ok(text.includes('copy(patch: AlphaStylePatch): AlphaStyle {'));
  assert.ok(!text.includes('copy(patch: Partial'), 'copy 签名里的 Partial 必须换掉');
});

test('规则 1：单行构造器 / 默认值 = {} / 非导出类 / 类之间没有空行也要正确插入', () => {
  const { result, outDir, report } = runFixture('options-variants');
  assert.equal(result.status, 0, result.stderr);
  const actual = readTree(outDir).get('beta.ts');
  const expected = readTree(fixtureDir('options-variants', 'expected')).get('beta.ts');
  assert.equal(actual, expected);
  assert.ok(actual.includes('export interface BetaPointOptions {\n  xPx: number;\n  yPx: number;\n}'));
  assert.ok(actual.includes('export interface BetaDefaultsOptions {'));
  assert.ok(actual.includes('constructor(options: BetaDefaultsOptions = {}) {'));
  assert.ok(actual.includes('\n}\n\n/** BetaPair 的构造参数。 */'), '类之间没有空行时插入块前要补一个空行');
  assert.equal(summaryOf(report).options, 3);
  assert.equal(summaryOf(report).patches, 0);
});

test('规则 2：无构造参数时 Patch 取 readonly 实例字段（static 与 getter 不计入）', () => {
  const { result, outDir, report } = runFixture('patch-fields');
  assert.equal(result.status, 0, result.stderr);
  const text = readTree(outDir).get('gamma.ts');
  assert.equal(text, readTree(fixtureDir('patch-fields', 'expected')).get('gamma.ts'));
  assert.ok(text.includes('export interface GammaRectPatch {\n  left?: number;\n  top?: number;\n  right?: number;\n  bottom?: number;\n}'));
  assert.ok(!text.includes('ZERO?: GammaRect'));
  assert.ok(!text.includes('widthPx?: number'), 'getter 不能进 Patch');
  assert.ok(text.includes('export interface GammaMarginOptions'));
  assert.ok(!text.includes('GammaMarginPatch'), '没有 copy 的类不生成 Patch');
  assert.equal(summaryOf(report).patches, 1);
});

test('规则 3：同名 type + as const -> 类型改名 + XMap + 删 as const，值访问与 typeof 保持', () => {
  const { result, outDir, report } = runFixture('pairs');
  assert.equal(result.status, 0, result.stderr);
  const actual = readTree(outDir);
  const expected = readTree(fixtureDir('pairs', 'expected'));
  assert.equal(actual.get('pairs.ts'), expected.get('pairs.ts'));

  const pairs = actual.get('pairs.ts');
  assert.ok(pairs.includes('export type GammaAlignValue = "START" | "CENTER";'));
  assert.ok(pairs.includes('export interface GammaAlignMap {\n  readonly START: GammaAlignValue;\n  readonly CENTER: GammaAlignValue;\n}'));
  assert.ok(pairs.includes('export const GammaAlign: GammaAlignMap = {'));
  assert.ok(!pairs.includes('} as const;'), 'as const 必须删掉');
  assert.ok(pairs.includes('export interface GammaVisualValue {'), '对象类型别名要变成 interface');
  assert.ok(pairs.includes('readonly visual: GammaVisualValue;'));
  assert.ok(pairs.includes('GammaVisual.TEXT;'), '值访问 X.KEY 保持');
  assert.ok(!pairs.includes('GammaVisualValue.TEXT'));

  // 文件内值访问一律保持（跨文件的值 import 场景见 pairs-crossfile-value）
  assert.ok(pairs.includes('GammaAlign.CENTER') && pairs.includes('GammaVisual.TEXT') && pairs.includes('GammaAlign.START'), '值位置不能改名');
  assert.ok(!pairs.includes('GammaAlignValue.CENTER'), '成员访问不能改名');
  assert.ok(!pairs.includes('GammaVisualValue.TEXT'), '成员访问不能改名');

  const summary = summaryOf(report);
  assert.equal(summary.renames, 2);
  assert.equal(summary.asConst, 2);
});

test('规则 3：跨文件引用无法安全判定时只报告，不把它改坏', () => {
  const { result, outDir, report } = runFixture('pairs-unsafe');
  assert.equal(result.status, 0, result.stderr);
  const actual = readTree(outDir);
  const source = readTree(fixtureDir('pairs-unsafe'));
  assert.deepEqual(actual, source, '不可安全判定时产物必须与输入逐字相同');
  assert.equal(summaryOf(report).renames, 0);
  assert.equal(summaryOf(report).asConst, 0);
  assert.deepEqual(codesOf(report), ['crossfile-type-ref']);
  const residual = (report.residuals as Array<{ hint: string }>)[0];
  assert.ok(residual.hint.includes('re-export') || residual.hint.includes('无法'), residual.hint);
});

test('规则 4：未配对的 as const 只报告，不改内容', () => {
  const { result, outDir, report } = runFixture('asconst-unpaired');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readTree(outDir), readTree(fixtureDir('asconst-unpaired')));
  assert.deepEqual(codesOf(report), ['as-const-unpaired', 'as-const-unpaired', 'as-const-unpaired']);
  assert.equal(summaryOf(report).filesChanged, 0);
});

test('残留清单：globalThis / as unknown / any / 索引取类型 / 内联对象类型 / 剩余 Partial / 嵌套构造器', () => {
  const { result, outDir, report } = runFixture('residuals');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readTree(outDir), readTree(fixtureDir('residuals')));
  const codes = codesOf(report);
  for (const code of ['globalThis', 'as-unknown', 'any-unknown', 'indexed-type-access', 'inline-object-type', 'partial-remaining', 'unsupported-constructor', 'as-const-unpaired']) {
    assert.ok(codes.indexOf(code) >= 0, '缺少残留类型 ' + code + '：' + codes.join(','));
  }
  assert.ok(codes.filter((code) => code === 'any-unknown').length === 2, 'any 与 unknown 各报 1 处');
  assert.ok(codes.filter((code) => code === 'as-const-unpaired').length === 1);
  const residuals = report.residuals as Array<{ file: string; line: number; code: string; hint: string; snippet: string }>;
  for (const item of residuals) {
    assert.equal(item.file, 'zeta.ts');
    assert.ok(Number.isInteger(item.line) && item.line > 0);
    assert.ok(item.hint.length > 0);
    assert.ok(item.snippet.length > 0);
  }
});

test('退出码 3：--fail-on-residual 且有残留', () => {
  const { result } = runFixture('residuals', ['--fail-on-residual']);
  assert.equal(result.status, 3, result.stderr);
});

test('变换异常：已有同名 interface 必须报错（exit 1）而不是覆盖', () => {
  const base = makeTempDir();
  const outDir = join(base, 'out');
  const result = runCli(['--src', fixtureDir('conflict-options'), '--out', outDir]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('OmegaBoxOptions'), result.stderr);
  assert.ok(result.stderr.includes('拒绝覆盖'), result.stderr);
  assert.ok(!existsSync(outDir), '变换异常时不能写出半成品');
});

test('--ets：输出 .ets 且相对 import 去掉 .ts 后缀（含 side-effect / 默认导入 / 子目录）', () => {
  const { result, outDir, report } = runFixture('ets-imports', ['--ets']);
  assert.equal(result.status, 0, result.stderr);
  const actual = readTree(outDir);
  const expected = readTree(fixtureDir('ets-imports', 'expected'));
  assert.deepEqual(actual, expected);
  assert.deepEqual([...actual.keys()].sort(), ['helper.ets', 'imports.ets', 'other/helper2.ets', 'side-effect.ets']);
  const imports = actual.get('imports.ets');
  assert.ok(imports.includes('from "./helper";'));
  assert.ok(imports.includes('import "./side-effect";'));
  assert.ok(imports.includes('from "../other/helper2";'));
  assert.ok(!imports.includes('.ts"'), '不能残留 .ts 说明符');
  assert.equal(summaryOf(report).filesChanged, 4);
});

test('不加 --ets 时保持 .ts 与说明符后缀（供 Node 重放）', () => {
  const { result, outDir } = runFixture('ets-imports');
  assert.equal(result.status, 0, result.stderr);
  const actual = readTree(outDir);
  assert.deepEqual([...actual.keys()].sort(), ['helper.ts', 'imports.ts', 'other/helper2.ts', 'side-effect.ts']);
  assert.ok(actual.get('imports.ts').includes('from "./helper.ts";'));
});

test('幂等：对输出再跑一次 filesChanged=0、changes 为空且逐字节相同', () => {
  const first = runFixture('options-basic');
  assert.equal(first.result.status, 0, first.result.stderr);
  const secondBase = makeTempDir();
  const secondOut = join(secondBase, 'out');
  const secondReport = join(secondBase, 'report.json');
  const second = runCli(['--src', first.outDir, '--out', secondOut, '--report', secondReport, '--json']);
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(readFileSync(secondReport, 'utf8'));
  assert.equal(report.summary.filesChanged, 0);
  assert.equal(report.summary.options, 0);
  assert.equal(report.summary.patches, 0);
  assert.deepEqual(report.changes, []);
  assert.deepEqual(readTree(secondOut), readTree(first.outDir));
});

test('幂等：--ets 产物再跑一次也无变化', () => {
  const first = runFixture('ets-imports', ['--ets']);
  const secondBase = makeTempDir();
  const secondOut = join(secondBase, 'out');
  const second = runCli(['--src', first.outDir, '--out', secondOut, '--ets', '--json']);
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(second.stdout);
  assert.equal(report.summary.filesChanged, 0);
  assert.deepEqual(report.changes, []);
  assert.deepEqual(readTree(secondOut), readTree(first.outDir));
});

test('确定性：两次独立运行产物与报告逐字节相同', () => {
  const first = runFixture('pairs');
  const second = runFixture('pairs');
  assert.deepEqual(readTree(first.outDir), readTree(second.outDir));
  const normalize = (report: Record<string, unknown>): string => JSON.stringify(report);
  assert.equal(normalize(first.report), normalize(second.report));
  assert.equal(first.result.stdout, second.result.stdout);
});

test('src 永不被修改', () => {
  const before = readTree(fixtureDir('pairs'));
  const beforeKeys = [...before.keys()].sort();
  runFixture('pairs');
  const after = readTree(fixtureDir('pairs'));
  assert.deepEqual([...after.keys()].sort(), beforeKeys);
  for (const [key, value] of before) assert.equal(after.get(key), value, 'src 被改动了：' + key);
});

test('报告结构：summary 只含约定的 7 个计数，changes/residuals 字段齐全', () => {
  const { report, stdoutJson } = runFixture('pairs');
  assert.deepEqual(Object.keys(report).sort(), ['changes', 'residuals', 'summary']);
  assert.deepEqual(Object.keys(report.summary).sort(), ['asConst', 'filesChanged', 'filesScanned', 'options', 'patches', 'renames', 'residuals']);
  assert.deepEqual(stdoutJson, report, '--json 的 stdout 必须等于 --report 写出的 JSON');

  const changes = report.changes as Array<{ file: string; line: number; rule: string }>;
  assert.ok(changes.length > 0);
  for (const change of changes) {
    assert.ok(typeof change.file === 'string' && change.file.length > 0);
    assert.ok(Number.isInteger(change.line) && change.line > 0);
    assert.ok(['constructor-options', 'copy-patch', 'type-rename', 'type-ref', 'map-interface', 'ets-import', 'extension-rename'].indexOf(change.rule) >= 0);
  }
  const ruleCount = (rule: string): number => changes.filter((item) => item.rule === rule).length;
  assert.equal(ruleCount('constructor-options'), 1);
  assert.equal(ruleCount('type-rename'), 2);
  assert.equal(ruleCount('map-interface'), 2);
});

test('用法错误 -> 退出码 2；--help -> 0 且打印用法', () => {
  const base = makeTempDir();
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--src'));
  assert.ok(help.stdout.includes('退出码'));

  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['--out', join(base, 'out')]).status, 2);
  assert.equal(runCli(['--src', fixtureDir('pairs')]).status, 2);
  assert.equal(runCli(['--src', fixtureDir('pairs'), '--out', join(base, 'out'), '--nope']).status, 2);
  assert.equal(runCli(['--src', fixtureDir('pairs'), '--out']).status, 2);
  assert.equal(runCli(['--src', join(base, 'missing'), '--out', join(base, 'out')]).status, 2);

  const equal = runCli(['--src', fixtureDir('pairs'), '--out', fixtureDir('pairs')]);
  assert.equal(equal.status, 2);
  assert.ok(equal.stderr.includes('--src'), equal.stderr);

  const nested = runCli(['--src', fixtureDir('pairs'), '--out', join(fixtureDir('pairs'), 'generated')]);
  assert.equal(nested.status, 2);
});

test('嵌套相对路径保留', () => {
  const { outDir } = runFixture('ets-imports', ['--ets']);
  assert.ok(existsSync(join(outDir, 'other', 'helper2.ets')));
  const rel = relative(outDir, join(outDir, 'other', 'helper2.ets')).split(sep).join('/');
  assert.equal(rel, 'other/helper2.ets');
});

test('规则 3 P0 回归：值位置一律不改名，产物 node 运行无 ReferenceError', () => {
  const { result, outDir, report } = runFixture('pairs-values');
  assert.equal(result.status, 0, result.stderr);
  const actual = readTree(outDir);
  const expected = readTree(fixtureDir('pairs-values', 'expected'));
  assert.equal(actual.get('tone.ts'), expected.get('tone.ts'));

  const text = actual.get('tone.ts');
  // 类型位置：改名
  assert.ok(text.includes('export type ToneValue'));
  assert.ok(text.includes('export interface ToneMap'));
  assert.ok(text.includes('export const Tone: ToneMap = {'));
  assert.ok(text.includes('export const typed: ToneValue = "A";'));
  assert.ok(text.includes('viaParam(value: ToneValue): ToneValue'));
  // 值位置：一律保持 Tone
  const valueLines = [
    'export const alias = Tone;',
    'export const shorthand = { Tone };',
    'export const keyed = { Tone: 1 };',
    'export const member = Tone.A;',
    'export const arg = String(Tone);',
    'export const arrayed = [Tone, Tone];',
    '  return Tone;',
    'export const negated = !Tone;',
  ];
  for (const line of valueLines) assert.ok(text.includes(line), '值位置被误改：' + line);
  assert.ok(!text.includes('ToneValue.A'), '成员访问不能改名');
  assert.ok(!text.includes('{ ToneValue }'), '对象简写不能改名');

  // 运行时：产物能被 node 直接跑（类型语法可擦除），不能 ReferenceError
  const run = spawnSync(process.execPath, [join(outDir, 'tone.ts')], { encoding: 'utf8' });
  assert.equal(run.status, 0, 'node 运行产物失败：' + (run.stderr === null ? '' : run.stderr));
  assert.ok(!String(run.stderr).includes('ReferenceError'));

  assert.equal(summaryOf(report).renames, 1);
  assert.equal(summaryOf(report).residuals, 0);
});

test('规则 3 跨文件：import type 且全是类型用法 -> 两边都改名（含 import 说明符）', () => {
  const { result, outDir, report } = runFixture('pairs-crossfile-type');
  assert.equal(result.status, 0, result.stderr);
  const actual = readTree(outDir);
  const expected = readTree(fixtureDir('pairs-crossfile-type', 'expected'));
  assert.equal(actual.get('tone.ts'), expected.get('tone.ts'));
  assert.equal(actual.get('consumer.ts'), expected.get('consumer.ts'));

  const consumer = actual.get('consumer.ts');
  assert.ok(consumer.includes('import type { ToneValue } from "./tone.ts";'));
  assert.ok(consumer.includes('export const typed: ToneValue = "A";'));
  assert.ok(consumer.includes('pick(value: ToneValue): ToneValue'));
  assert.equal(summaryOf(report).renames, 1);
  assert.equal(summaryOf(report).residuals, 0);
});

test('规则 3 跨文件：值 import -> 不改，诚实上报 crossfile-type-ref', () => {
  const { result, outDir, report } = runFixture('pairs-crossfile-value');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readTree(outDir), readTree(fixtureDir('pairs-crossfile-value')));
  assert.deepEqual(codesOf(report), ['crossfile-type-ref']);
  const residual = (report.residuals as Array<{ hint: string }>)[0];
  assert.ok(residual.hint.includes('值 import'), residual.hint);
  assert.equal(summaryOf(report).renames, 0);
  assert.equal(summaryOf(report).asConst, 0);
});

test('fixture 目录里没有受版权限制的上游源码（自造标记）', () => {
  const files = readTree(FIXTURES);
  for (const [key, value] of files) {
    if (!key.endsWith('.ts') && !key.endsWith('.ets')) continue;
    assert.ok(value.includes('自造 fixture'), 'fixture 缺少自造标记：' + key);
  }
  assert.ok(files.size >= 20);
});

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

test('--ets：只改扩展名的文件以 extension-rename 计入 changes[]，filesChanged 与 changes[] 一致', () => {
  const dir = makeTempDir();
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'main.ts'), 'import { helper } from "./helper.ts";\nexport const value = helper();\n', 'utf8');
  writeFileSync(join(src, 'helper.ts'), 'export const helper = () => 1;\n', 'utf8');
  const outDir = join(dir, 'out');
  const result = runCli(['--src', src, '--out', outDir, '--ets', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    summary: { filesChanged: number };
    changes: Array<{ file: string; line: number; rule: string }>;
  };
  assert.equal(summaryOf(report as unknown as Record<string, unknown>).filesChanged, 2);
  // 回归 #7：两个变更文件各 1 条 change（main.ts 的 ets-import + helper.ts 的 extension-rename），数量必须对得上
  assert.equal(report.changes.length, report.summary.filesChanged);
  assert.equal(new Set(report.changes.map((change) => change.file)).size, report.summary.filesChanged);
  const byRule = new Map(report.changes.map((change) => [change.rule, change.file]));
  assert.equal(byRule.get('ets-import'), 'main.ts');
  assert.equal(byRule.get('extension-rename'), 'helper.ts');
  const renameRow = report.changes.find((change) => change.rule === 'extension-rename');
  assert.ok(renameRow !== undefined);
  assert.equal(renameRow!.line, 1);
  assert.ok(existsSync(join(outDir, 'main.ets')) && existsSync(join(outDir, 'helper.ets')));
  // 幂等：对 .ets 产物再跑一次应无变更
  const second = runCli(['--src', outDir, '--out', join(dir, 'out2'), '--ets', '--json']);
  const secondReport = JSON.parse(second.stdout) as { summary: { filesChanged: number }; changes: unknown[] };
  assert.equal(secondReport.summary.filesChanged, 0);
  assert.deepEqual(secondReport.changes, []);
});
