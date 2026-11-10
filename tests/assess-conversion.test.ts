import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * cli/assess-conversion.ts 契约测试：
 * 四类覆盖（含混合文件按主导角色）、分母排除（test/build/generated/隐藏目录）、XML 单列、
 * empty、--json/--md/--out、非法参数、同输入两次逐字节相同、analyze-coupling 一致性、子报告对比。
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const assessPath = join(repoRoot, 'cli', 'assess-conversion.ts');
const rulesPath = join(repoRoot, 'rules', 'conversion-share.json');
const NL = String.fromCharCode(10);
const FENCE = String.fromCharCode(96, 96, 96);

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function makeTmp(t: TestHooks, prefix = 'arkts-assess-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join(NL) + NL, 'utf8');
}

function runAssess(args: string[], cwd: string, profile: 'broad' | 'conservative' | 'default' = 'broad'): RunResult {
  const fullArgs = profile === 'default' ? args : [...args, '--profile', profile];
  const res = spawnSync(process.execPath, [assessPath, ...fullArgs], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function parseJson(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>;
}

/** 混合 fixture：覆盖 4 类 + 主导角色 + 分母排除 + XML；返回 { dir, root, out } */
function makeFixture(t: TestHooks): { dir: string; root: string; out: string } {
  const dir = makeTmp(t);
  const root = join(dir, 'repo');
  const out = join(dir, 'out');
  const main = join(root, 'app', 'src', 'main');

  writeFile(join(main, 'Pure.kt'), [
    'package io.legado.app.pure',
    '',
    'fun add(a: Int, b: Int): Int = a + b',
  ]);
  writeFile(join(main, 'Cor.kt'), [
    'package io.legado.app.cor',
    '',
    'import kotlinx.coroutines.flow.Flow',
    'import io.legado.app.core.Util',
    '',
    'fun f(x: Flow<Int>) = x',
  ]);
  writeFile(join(main, 'NarrowAndroid.kt'), [
    'package io.legado.app.narrow',
    '',
    'import android.app.C1',
    'import android.app.C2',
    'import io.legado.app.core.Util',
    '',
    'fun n() = 1',
  ]);
  const broad = ['package io.legado.app.broad', ''];
  for (let i = 1; i <= 9; i++) broad.push('import android.app.C' + i);
  broad.push('', 'fun b() = 1');
  writeFile(join(main, 'BroadAndroid.kt'), broad);
  writeFile(join(main, 'Ui.kt'), [
    'package io.legado.app.ui',
    '',
    'import androidx.compose.runtime.Composable',
    '',
    '@Composable',
    'fun Screen() {}',
  ]);
  writeFile(join(main, 'MixedActivity.kt'), [
    'package io.legado.app.mixed',
    '',
    'import android.app.Activity',
    '',
    'class MixedActivity : Activity() {',
    '  fun pure(): Int = 1',
    '}',
  ]);
  writeFile(join(main, 'NonConv.kt'), [
    'package io.legado.app.native',
    '',
    'class Native {',
    '  fun load() { System.loadLibrary("x") }',
    '}',
  ]);
  writeFile(join(main, 'MixedNonConv.kt'), [
    'package io.legado.app.mixed2',
    '',
    'import androidx.compose.runtime.Composable',
    '',
    '@Composable',
    'fun X() { System.loadLibrary("y") }',
  ]);
  writeFile(join(main, 'JvmOnly.kt'), [
    'package io.legado.app.js',
    '',
    'import org.mozilla.javascript.Context',
    '',
    'fun js() = Context()',
  ]);
  const wideInternal = ['package io.legado.app.wide', '', 'import kotlinx.coroutines.flow.Flow'];
  for (let i = 1; i <= 9; i++) wideInternal.push('import io.legado.app.internal.C' + i);
  wideInternal.push('', 'fun w(x: Flow<Int>) = x');
  writeFile(join(main, 'WideInternal.kt'), wideInternal);

  // 分母排除：test / testComic / androidTest / build / generated file / 隐藏目录 / XML
  writeFile(join(root, 'app', 'src', 'test', 'Test.kt'), ['package t', '', 'class T']);
  writeFile(join(root, 'app', 'src', 'androidTest', 'AT.kt'), ['package t', '', 'class AT']);
  writeFile(join(root, 'app', 'src', 'testComic', 'TC.kt'), ['package t', '', 'class TC']);
  writeFile(join(root, 'build', 'Gen.kt'), ['package g', '', 'class Gen']);
  writeFile(join(root, 'app', 'src', 'main', 'R.java'), ['package io.legado.app;', 'public final class R {}']);
  writeFile(join(root, '.refs', 'Evidence.kt'), ['package e', '', 'class E']);
  writeFile(join(root, 'res', 'layout', 'main.xml'), ['<resources/>']);
  writeFile(join(root, 'README.md'), ['# not source']);
  return { dir, root, out };
}

// ---------------------------------------------------------------------------
// 四类覆盖 / 混合文件 / 排除 / XML
// ---------------------------------------------------------------------------

test('四类覆盖：files/lines/percent/samples/置信度齐全，合计 100%，unclassified=0', (t) => {
  const fixture = makeFixture(t);
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = parseJson(res.stdout);
  assert.equal(report.lang, 'jvm');
  assert.equal(report.denominator.files, 10, '分母只应含 10 个主源码文件');
  assert.equal(report.unclassified, 0);
  assert.equal(report.checks.totalFilesMatch, true);
  assert.equal(report.checks.percentFilesTotal, 100);
  assert.equal(report.checks.percentLinesTotal, 100);
  assert.equal(report.ok, true);
  assert.equal(report.empty, false);

  const categories = report.categories;
  assert.equal(categories.automated.files, 1, 'Pure.kt 应 automated');
  assert.deepEqual(categories.automated.samples.map((sample: any) => sample.path), ['app/src/main/Pure.kt']);
  assert.match(String(categories.automated.disclaimer), /不代表已实证|能力上限/);

  assert.equal(categories.semiAutomated.files, 4);
  assert.equal(categories.semiAutomated.narrowFiles, 2, 'Cor + NarrowAndroid 应 narrow');
  assert.equal(categories.semiAutomated.broadFiles, 2, 'BroadAndroid + WideInternal 应 broad');
  assert.equal(typeof categories.semiAutomated.disclaimer, 'string', 'semiAutomated.disclaimer 不能为 null（B-10）');
  assert.ok(String(categories.semiAutomated.disclaimer).length > 0);
  assert.match(String(categories.semiAutomated.disclaimer), /不代表已实现半自动/);
  assert.match(String(categories.semiAutomated.disclaimer), /1,670/);
  assert.match(String(categories.semiAutomated.disclaimer), /6,436/);
  assert.match(String(categories.semiAutomated.disclaimer), /top 8|待人工转写/);
  assert.notEqual(categories.automated.disclaimer, null);
  assert.equal(categories.manual.disclaimer, null);
  assert.equal(categories.nonConvertible.disclaimer, null);

  assert.equal(categories.manual.files, 2, 'Ui + MixedActivity 应 manual（混合文件按主导角色）');
  assert.ok(categories.manual.samples.some((sample: any) => sample.path === 'app/src/main/MixedActivity.kt'));

  assert.equal(categories.nonConvertible.files, 3);
  assert.ok(categories.nonConvertible.samples.some((sample: any) => sample.path === 'app/src/main/MixedNonConv.kt'),
    '非可转优先级高于 UI');

  for (const key of ['automated', 'semiAutomated', 'manual', 'nonConvertible']) {
    const summary = categories[key];
    assert.equal(typeof summary.definition, 'string');
    assert.ok(summary.definition.length > 0);
    assert.equal(typeof summary.confidence, 'number');
    assert.ok(summary.confidence > 0 && summary.confidence <= 1);
    assert.ok(Array.isArray(summary.samples));
  }
  const totalPercent = ['automated', 'semiAutomated', 'manual', 'nonConvertible']
    .reduce((sum, key) => sum + categories[key].percentFiles, 0);
  assert.equal(Math.round(totalPercent * 100) / 100, 100);
});

test('分母排除与 XML：test/testComic/androidTest/build/generated/hidden 不进分母，XML 单列', (t) => {
  const fixture = makeFixture(t);
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = parseJson(res.stdout);
  assert.equal(report.denominator.files, 10);
  const byReason = new Map(report.denominator.excluded.byReason.map((bucket: any) => [bucket.reason, bucket.files]));
  assert.equal(byReason.get('test'), 2, 'src/test + src/androidTest');
  assert.equal(byReason.get('test-variant'), 1, 'src/testComic');
  assert.equal(byReason.get('generated'), 1, 'R.java');
  assert.equal(report.xml.files, 1);
  assert.equal(report.xml.lines, 2);
  assert.ok(report.xml.samples.includes('res/layout/main.xml'));
  assert.ok(report.denominator.excluded.skippedDirs.some((entry: string) => entry.includes('build/')));
});

// ---------------------------------------------------------------------------
// 一致性 / 子报告对比 / 规则版本
// ---------------------------------------------------------------------------

test('analyze-coupling 一致性：automated ⊆ auto；差异按类计数并给样本', (t) => {
  const fixture = makeFixture(t);
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir);
  const report = parseJson(res.stdout);
  const consistency = report.consistency.analyzeCoupling;
  assert.equal(consistency.automatedNotInAnalyzeAuto.length, 0);
  assert.equal(consistency.automatedInAnalyzeAuto, consistency.automatedFiles);
  assert.equal(consistency.analyzeAutoFiles, 3, 'Pure + Native + JvmOnly（MixedNonConv 有 androidx import，属 analyze 耦合）');
  assert.equal(consistency.analyzeAutoNotAutomatedFiles, 2);
  assert.equal(consistency.analyzeAutoNotAutomatedByCategory.nonConvertible, 2);
  assert.ok(Array.isArray(consistency.analyzeAutoNotAutomatedSamples));
  assert.equal(report.checks.automatedNotInAnalyzeAuto, 0);
});

test('子智能体 REPORT.md 存在：解析 JSON 块并列出差异；不存在：记录说明', (t) => {
  const fixture = makeFixture(t);
  mkdirSync(fixture.out, { recursive: true });
  const fenced = [
    FENCE + 'json',
    JSON.stringify({
      categories: {
        automated: { files: 2, percent: 20 },
        semiAutomated: { files: 4, percent: 40 },
        manual: { files: 2, percent: 20 },
        nonConvertible: { files: 2, percent: 20 },
      },
    }),
    FENCE,
  ].join(NL);
  writeFileSync(join(fixture.out, 'REPORT.md'), '# subagent' + NL + fenced + NL, 'utf8');
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir);
  const report = parseJson(res.stdout);
  assert.equal(report.comparison.present, true);
  assert.equal(report.comparison.parsed, true);
  assert.equal(report.comparison.diffs.length, 4);
  assert.ok(report.comparison.diffs.some((diff: any) => diff.category === 'automated' && diff.filesDelta === -1));
  assert.ok(report.comparison.reasons.length >= 1);
  const md = readFileSync(join(fixture.out, 'tool-report.md'), 'utf8');
  assert.match(md, /与子智能体报告对比/);
  assert.match(md, /原因:/);

  // 无 REPORT.md 的分支
  const fixture2 = makeFixture(t);
  const res2 = runAssess(['--root', fixture2.root, '--lang', 'jvm', '--out', fixture2.out, '--json'], fixture2.dir);
  const report2 = parseJson(res2.stdout);
  assert.equal(report2.comparison.present, false);
  assert.match(String(report2.comparison.note), /未找到子智能体报告/);
});

test('规则版本：报告 ruleVersion/ruleSha256 与 rules/conversion-share.json 一致', (t) => {
  const fixture = makeFixture(t);
  const rules = parseJson(readFileSync(rulesPath, 'utf8'));
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir);
  const report = parseJson(res.stdout);
  assert.equal(report.ruleVersion, rules.version);
  assert.match(String(report.ruleSha256), /^[0-9a-f]{64}$/);
  assert.equal(report.tool, 'assess-conversion');
});

// ---------------------------------------------------------------------------
// 输出模式 / 空目录 / 确定性 / 非法参数
// ---------------------------------------------------------------------------

test('输出：--out 写 json+md；--json/--md stdout 模式；默认人类摘要 ≤12 行', (t) => {
  const fixture = makeFixture(t);
  const jsonRun = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir);
  assert.equal(jsonRun.code, 0);
  assert.ok(readdirSync(fixture.out).includes('tool-report.json'));
  assert.ok(readdirSync(fixture.out).includes('tool-report.md'));

  const mdRun = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--md'], fixture.dir);
  assert.equal(mdRun.code, 0);
  assert.match(mdRun.stdout, /^# 四类转换占比评估/);
  assert.doesNotMatch(mdRun.stdout, /^\{/);

  // B-10：md 表格与定义处必须标注 semiAutomated 免责声明
  const mdText = readFileSync(join(fixture.out, 'tool-report.md'), 'utf8');
  assert.match(mdText, /semi-automated.*candidate.*不代表已实现/);
  assert.match(mdText, /不代表已实现半自动/);
  assert.match(mdText, /- 免责声明:/);
  assert.match(mdText, /1,670/);
  assert.match(mdText, /6,436/);

  const both = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json', '--md'], fixture.dir);
  assert.equal(both.code, 0);
  assert.ok(both.stdout.indexOf('"tool": "assess-conversion"') < both.stdout.indexOf('# 四类转换占比评估'));

  const human = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out], fixture.dir);
  assert.equal(human.code, 0);
  const lines = human.stdout.split(NL).filter((line) => line.trim() !== '');
  assert.ok(lines.length <= 12, '人类摘要应 ≤12 行，实际 ' + lines.length);
  assert.match(human.stdout, /automated/);
  assert.match(human.stdout, /non-convertible/);
  assert.match(human.stdout, /合计 100\.00%/);
});

test('空目录：exit 0、empty=true、四类 0，不崩溃', (t) => {
  const dir = makeTmp(t);
  const root = join(dir, 'empty');
  mkdirSync(root, { recursive: true });
  const out = join(dir, 'out');
  const res = runAssess(['--root', root, '--lang', 'jvm', '--out', out, '--json'], dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = parseJson(res.stdout);
  assert.equal(report.empty, true);
  assert.equal(report.denominator.files, 0);
  assert.equal(report.unclassified, 0);
  assert.equal(report.percentTotal.files, 0);
  assert.equal(report.ok, true);
});

test('确定性：同输入两次 tool-report.json/.md 逐字节相同', (t) => {
  const fixture = makeFixture(t);
  const args = ['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out];
  assert.equal(runAssess(args, fixture.dir).code, 0);
  const json1 = readFileSync(join(fixture.out, 'tool-report.json'), 'utf8');
  const md1 = readFileSync(join(fixture.out, 'tool-report.md'), 'utf8');
  assert.equal(runAssess(args, fixture.dir).code, 0);
  const json2 = readFileSync(join(fixture.out, 'tool-report.json'), 'utf8');
  const md2 = readFileSync(join(fixture.out, 'tool-report.md'), 'utf8');
  assert.equal(json1, json2, '同输入两次 JSON 必须逐字节相同');
  assert.equal(md1, md2, '同输入两次 Markdown 必须逐字节相同');
  assert.doesNotMatch(json1, /timestamp|generatedAt|durationMs/);
});

test('非法参数：缺 root / root 不存在 / 缺 lang / 未知 lang / 未知参数 / out 越界 → exit 2', (t) => {
  const fixture = makeFixture(t);
  const cases: string[][] = [
    ['--lang', 'jvm'],
    ['--root', join(fixture.root, 'nope'), '--lang', 'jvm'],
    ['--root', fixture.root],
    ['--root', fixture.root, '--lang', 'dart'],
    ['--root', fixture.root, '--lang', 'jvm', '--bogus'],
    ['--root', fixture.root, '--lang', 'jvm', '--out', join(fixture.root, 'out')],
    ['--root', fixture.root, '--lang', 'jvm', '--out'],
  ];
  for (const args of cases) {
    const res = runAssess(args, fixture.dir);
    assert.equal(res.code, 2, '应 exit 2：' + JSON.stringify(args) + '\n' + res.stdout + res.stderr);
    assert.match(res.stderr, /assess-conversion: /);
  }
  const badProfile = runAssess(['--root', fixture.root, '--lang', 'jvm', '--profile', 'dart'], fixture.dir, 'default');
  assert.equal(badProfile.code, 2);
  assert.match(badProfile.stderr, /--profile 只支持 broad \| conservative/);
  assert.equal(runAssess(['--help'], fixture.dir).code, 0);
});


// ---------------------------------------------------------------------------
// conservative profile（默认）：严格口径 + production-only + broad 不回归
// ---------------------------------------------------------------------------

interface ConservativeFixture {
  dir: string;
  root: string;
  out: string;
}

function makeConservativeFixture(t: TestHooks): ConservativeFixture {
  const dir = makeTmp(t);
  const root = join(dir, 'repo');
  const out = join(dir, 'out');
  const main = join(root, 'app', 'src', 'main');

  writeFile(join(main, 'Pure.kt'), ['package io.legado.app.pure', '', 'fun add(a: Int, b: Int): Int = a + b']);
  writeFile(join(main, 'data', 'dao', 'BookDao.kt'), [
    'package io.legado.app.data.dao',
    '',
    'import androidx.room.Dao',
    '',
    '@Dao',
    'interface BookDao',
  ]);
  writeFile(join(main, 'data', 'dao', 'Plain.kt'), [
    'package io.legado.app.data.dao',
    '',
    'import java.io.File',
    '',
    'fun bean(file: File): String = file.name',
  ]);
  writeFile(join(main, 'Ui.kt'), [
    'package io.legado.app.ui',
    '',
    'import androidx.compose.runtime.Composable',
    '',
    '@Composable',
    'fun Screen() {}',
  ]);
  writeFile(join(main, 'Native.kt'), [
    'package io.legado.app.native',
    '',
    'class Native {',
    '  fun load() { System.loadLibrary("x") }',
    '}',
  ]);
  writeFile(join(main, 'MixedNativeUi.kt'), [
    'package io.legado.app.mixed',
    '',
    'import androidx.compose.runtime.Composable',
    '',
    '@Composable',
    'fun X() { System.loadLibrary("y") }',
  ]);
  writeFile(join(main, 'data', 'dao', 'MixedUiDao.kt'), [
    'package io.legado.app.data.dao',
    '',
    'import androidx.compose.runtime.Composable',
    '',
    '@Composable',
    'fun daoUi() {}',
  ]);
  writeFile(join(root, 'app', 'src', 'testComic', 'TC.kt'), ['package t', '', 'class TC']);
  writeFile(join(root, 'baselineProfile', 'src', 'main', 'java', 'B.kt'), ['package b', '', 'class B']);
  writeFile(join(root, 'app', 'src', 'test', 'T.kt'), ['package t', '', 'class T']);
  writeFile(join(root, 'res', 'layout', 'a.xml'), ['<resources/>']);
  return { dir, root, out };
}

function readProfileReport(out: string, profile: 'broad' | 'conservative'): Record<string, any> {
  const name = profile === 'conservative' ? 'conservative-report.json' : 'tool-report.json';
  return parseJson(readFileSync(join(out, name), 'utf8'));
}

test('conservative 默认：分母含 test-variant/baseline、四类、XML 单列、S 免责声明', (t) => {
  const fixture = makeConservativeFixture(t);
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir, 'default');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = parseJson(res.stdout);
  assert.equal(report.profile, 'conservative');
  assert.equal(report.productionOnly, false);
  assert.equal(report.denominator.files, 9, '9 个主源码 + testComic + baselineProfile');
  assert.ok(readdirSync(fixture.out).includes('conservative-report.json'));
  assert.ok(readdirSync(fixture.out).includes('conservative-report.md'));

  assert.equal(report.categories.automated.files, 1, 'Pure 纯逻辑');
  assert.equal(report.categories.semiAutomated.files, 2, 'BookDao + Plain（java.io → S）');
  assert.equal(report.categories.manual.files, 2, 'Ui + MixedUiDao（UI 优先于 S）');
  assert.equal(report.categories.nonConvertible.files, 4, 'Native + MixedNativeUi + testComic + baselineProfile');

  assert.equal(report.unclassified, 0);
  assert.equal(report.checks.percentFilesTotal, 100);
  assert.equal(report.checks.percentLinesTotal, 100);
  assert.equal(report.ok, true);
  assert.equal(typeof report.categories.semiAutomated.disclaimer, 'string');
  assert.match(String(report.categories.semiAutomated.disclaimer), /不代表已实现半自动/);
  assert.equal(report.xml.files, 1);
  const reasons = new Map(report.denominator.excluded.byReason.map((bucket: any) => [bucket.reason, bucket.files]));
  assert.equal(reasons.get('test'), 1);
  assert.equal(reasons.get('test-macrobenchmark'), undefined, '默认应含 test-variant/baseline');
});

test('conservative --production-only：分母排除 test-variant + baselineProfile', (t) => {
  const fixture = makeConservativeFixture(t);
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--production-only', '--out', fixture.out, '--json'], fixture.dir, 'conservative');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = parseJson(res.stdout);
  assert.equal(report.productionOnly, true);
  assert.equal(report.denominator.files, 7);
  const reasons = new Map(report.denominator.excluded.byReason.map((bucket: any) => [bucket.reason, bucket.files]));
  assert.equal(reasons.get('test'), 1);
  assert.equal(reasons.get('test-macrobenchmark'), 2);
  assert.equal(report.comparison.productionOnly, true);
  assert.equal(report.comparison.classReferenceApplicable, false);
  assert.equal(report.comparison.withinTolerance, true);
});

test('broad 不回归：同 fixture 仍 tool-report，Plain 归 A、分母排除 test-variant/baseline', (t) => {
  const fixture = makeConservativeFixture(t);
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir, 'broad');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = parseJson(res.stdout);
  assert.equal(report.profile, 'broad');
  assert.equal(report.denominator.files, 8, 'broad 排除 testComic，但保留 baselineProfile（v1.0 口径）');
  assert.ok(readdirSync(fixture.out).includes('tool-report.json'));
  assert.equal(report.categories.automated.files, 3, 'Pure + Plain + baselineProfile B（宽口径无 java.io 限制）');
  assert.equal(report.categories.semiAutomated.files, 1, 'BookDao');
  assert.equal(report.categories.manual.files, 2);
  assert.equal(report.categories.nonConvertible.files, 2, 'Native + MixedNativeUi');
  assert.equal(report.ruleVersion, parseJson(readFileSync(rulesPath, 'utf8')).version);
});

test('conservative 确定性：两次 conservative-report.json/.md 逐字节相同', (t) => {
  const fixture = makeConservativeFixture(t);
  const args = ['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out];
  assert.equal(runAssess(args, fixture.dir, 'conservative').code, 0);
  const json1 = readFileSync(join(fixture.out, 'conservative-report.json'), 'utf8');
  const md1 = readFileSync(join(fixture.out, 'conservative-report.md'), 'utf8');
  assert.equal(runAssess(args, fixture.dir, 'conservative').code, 0);
  const json2 = readFileSync(join(fixture.out, 'conservative-report.json'), 'utf8');
  const md2 = readFileSync(join(fixture.out, 'conservative-report.md'), 'utf8');
  assert.equal(json1, json2);
  assert.equal(md1, md2);
  assert.doesNotMatch(json1, /timestamp|generatedAt|durationMs/);
});

test('conservative 报告：与严格口径 reference 的逐类 diff 字段完整', (t) => {
  const fixture = makeConservativeFixture(t);
  const res = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir, 'conservative');
  const report = parseJson(res.stdout);
  const comparison = report.comparison;
  assert.equal(comparison.source.length > 0, true);
  assert.equal(comparison.tolerancePt, 0.5);
  assert.equal(comparison.categories.length, 4);
  for (const diff of comparison.categories) {
    assert.equal(typeof diff.oursFiles, 'number');
    assert.equal(typeof diff.refFiles, 'number');
    assert.equal(typeof diff.deltaFiles, 'number');
    assert.equal(typeof diff.deltaPt, 'number');
    assert.equal(typeof diff.pass, 'boolean');
  }
  assert.equal(typeof comparison.fileDiffTop.automated.length, 'number');
  assert.equal(comparison.perFileReferenceAvailable, false);
  const md = readFileSync(join(fixture.out, 'conservative-report.md'), 'utf8');
  assert.match(md, /与独立子智能体严格口径对比/);
  assert.match(md, /Δpt/);
  const mdStdout = runAssess(['--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--md'], fixture.dir, 'conservative');
  assert.equal(mdStdout.code, 0);
  assert.match(mdStdout.stdout, /与独立子智能体严格口径对比/);
  assert.match(mdStdout.stdout, /withinTolerance/);
});


test('--production-only 解析矩阵：不传/传/与 --profile 组合/显式 true|false', (t) => {
  const fixture = makeConservativeFixture(t);
  const cases: Array<{ args: string[]; profile: string; prod: boolean; den: number; file: string }> = [
    { args: [], profile: 'conservative', prod: false, den: 9, file: 'conservative-report.json' },
    { args: ['--production-only'], profile: 'conservative', prod: true, den: 7, file: 'conservative-report.json' },
    { args: ['--profile', 'broad'], profile: 'broad', prod: false, den: 8, file: 'tool-report.json' },
    { args: ['--profile', 'broad', '--production-only'], profile: 'broad', prod: true, den: 7, file: 'tool-report.json' },
    { args: ['--profile', 'conservative', '--production-only'], profile: 'conservative', prod: true, den: 7, file: 'conservative-report.json' },
    { args: ['--production-only=false'], profile: 'conservative', prod: false, den: 9, file: 'conservative-report.json' },
    { args: ['--production-only=true'], profile: 'conservative', prod: true, den: 7, file: 'conservative-report.json' },
  ];
  for (const item of cases) {
    const res = runAssess([...item.args, '--root', fixture.root, '--lang', 'jvm', '--out', fixture.out, '--json'], fixture.dir, 'default');
    assert.equal(res.code, 0, '应成功：' + JSON.stringify(item.args) + '\n' + res.stdout + res.stderr);
    const report = parseJson(res.stdout);
    assert.equal(report.profile, item.profile, JSON.stringify(item.args));
    assert.equal(report.productionOnly, item.prod, JSON.stringify(item.args));
    assert.equal(report.denominator.files, item.den, JSON.stringify(item.args));
    assert.ok(readdirSync(fixture.out).includes(item.file));
  }
  const bad = runAssess(['--production-only=maybe', '--root', fixture.root, '--lang', 'jvm'], fixture.dir, 'default');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /只接受 true\/false/);
});
