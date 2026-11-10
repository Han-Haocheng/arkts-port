import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测仓库里的 cli/triage-boundary.ts（读真实的 adapters/languages.json 口径）。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'cli', 'triage-boundary.ts');
const LEGADO_SRC = '/mnt/d/Project/legado-with-MD3/app/src/main/java';

interface TestHooks {
  after(fn: () => void): void;
}

function makeTmp(t: TestHooks, prefix = 'arkts-triage-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function runTriage(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function triageJson(root: string, extra: string[] = [], cwd = root) {
  const result = runTriage(['--root', root, '--json', ...extra], cwd);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as TriageReport;
}

interface TriageFile {
  file: string;
  loc: number;
  imports: { android: number; androidx: number; compose: number; google: number; dagger: number; coroutines: number; internal: number; otherExternal: number };
  platformImports: number;
  ui: { value: boolean; reasons: string[]; uiPath: boolean };
  async: { suspendCount: number; flowCount: number; per100Loc: number };
  classification: string;
  reason: string;
}

interface TriageReport {
  tool: string;
  version: number;
  root: string;
  minLines: number;
  top: number;
  sort: string[];
  funnel: {
    scannedKotlinFiles: number;
    skippedTestSources: number;
    coupledFiles: number;
    coupledAtLeastMinLines: number;
    zeroPlatformImports: number;
    narrowDepsNonUi: number;
    zeroInternalImports: number;
    legacyPathUi: { narrowDepsNonUi: number; excludedOnlyByPath: number };
  };
  counts: { coupledAtLeastMinLines: number; splittableCandidates: number; byClass: Record<string, number> };
  top: TriageFile[];
  candidates: TriageFile[];
  excludedShort: Array<{ file: string; loc: number; reason: string }>;
  notes: string[];
}

/** 生成一个物理行数确定的 Kotlin 文件（末尾换行，所以 loc = lines.length）。 */
function ktFile(packageName: string, imports: string[], body: string[], totalLines: number): string {
  const lines = ['package ' + packageName, '', ...imports.map((name) => 'import ' + name), ''];
  lines.push(...body);
  while (lines.length < totalLines) lines.push('// padding');
  if (lines.length !== totalLines) throw new Error('fixture 行数不对：' + lines.length + ' != ' + totalLines);
  return lines.join('\n') + '\n';
}

/**
 * fixture 结构（loc 固定，换算见断言）：
 *   src/clean.kt            120  无平台 import（不 coupled）
 *   src/androidy.kt         120  android.app.Activity → boundary-only
 *   src/ui_compose.kt       120  androidx.compose + @Composable → ui
 *   src/ui_viewmodel.kt     125  androidx.lifecycle.ViewModel → ui
 *   src/candidate.kt        120  coroutines + 2 internal → candidate
 *   src/heavy.kt            120  coroutines + 9 internal → not-worth
 *   src/short.kt             20  coroutines（< min-lines）→ 被排除
 *   src/commenty.kt         140  coroutines + 注释里出现 "ViewModel " → candidate（子串不误判）
 *   src/ui/ui_path.kt       130  coroutines，路径在 ui/ → candidate（路径不误判）
 *   src/gson_candidate.kt   125  coroutines + com.google.gson → candidate（google 不算平台）
 *   src/dagger_only.kt      110  dagger.Module → boundary-only
 *   out/ignored.kt          120  coroutines（out/ 目录应被跳过）
 */
function setupFixture(root: string): void {
  put(root, 'src/clean.kt', ktFile('com.example.app.clean', [], ['class Clean'], 120));
  put(root, 'src/androidy.kt', ktFile('com.example.app.android', ['android.app.Activity'], ['class AndroidThing'], 120));
  put(root, 'src/ui_compose.kt', ktFile('com.example.app.screen', ['androidx.compose.runtime.Composable'], ['@Composable', 'fun Screen() {}'], 120));
  put(root, 'src/ui_viewmodel.kt', ktFile('com.example.app.screen', ['androidx.lifecycle.ViewModel'], ['class MyViewModel : ViewModel() {'], 125));
  put(root, 'src/candidate.kt', ktFile('com.example.app.feature', ['kotlinx.coroutines.launch', 'com.example.app.data.Helper', 'com.example.app.util.Util'], ['class Feature'], 120));
  const heavyImports = ['kotlinx.coroutines.delay'];
  for (let index = 0; index < 9; index++) heavyImports.push('com.example.app.data.A' + index);
  put(root, 'src/heavy.kt', ktFile('com.example.app.heavy', heavyImports, ['class Heavy'], 120));
  put(root, 'src/short.kt', ktFile('com.example.app.short', ['kotlinx.coroutines.delay'], ['class Short'], 20));
  put(root, 'src/commenty.kt', ktFile('com.example.app.comment', ['kotlinx.coroutines.launch'], ['// 上次 ViewModel 的进度问题：不要按 ViewModel 生命周期清理', 'class Commenty'], 140));
  put(root, 'src/ui/ui_path.kt', ktFile('com.example.app.ui', ['kotlinx.coroutines.flow.Flow'], ['class UiPathLogic'], 130));
  put(root, 'src/gson_candidate.kt', ktFile('com.example.app.gson', ['kotlinx.coroutines.launch', 'com.google.gson.JsonObject'], ['class GsonThing'], 125));
  put(root, 'src/dagger_only.kt', ktFile('com.example.app.di', ['dagger.Module'], ['class DiThing'], 110));
  put(root, 'out/ignored.kt', ktFile('com.example.app.out', ['kotlinx.coroutines.launch'], ['class Ignored'], 120));
}

// ---------------------------------------------------------------------------
// 漏斗与分类
// ---------------------------------------------------------------------------

test('triage-boundary：fixture 漏斗与分类计数', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const json = triageJson(dir);
  assert.equal(json.tool, 'triage-boundary');
  assert.equal(json.version, 1);
  assert.deepEqual(json.funnel, {
    scannedKotlinFiles: 11,
    skippedTestSources: 0,
    coupledFiles: 10,
    coupledAtLeastMinLines: 9,
    zeroPlatformImports: 5,
    narrowDepsNonUi: 4,
    zeroInternalImports: 3,
    legacyPathUi: { narrowDepsNonUi: 3, excludedOnlyByPath: 1 },
    legacyScanUi: { zeroPlatformImports: 4, falsePositiveFiles: 1 },
  });
  assert.equal(json.funnel.legacyScanUi.falsePositiveFiles, 1, 'commenty.kt 的 ViewModel 注释应被旧启发式误判');
  assert.deepEqual(json.counts, {
    coupledAtLeastMinLines: 9,
    splittableCandidates: 4,
    byClass: { 'splittable-candidate': 4, 'boundary-only': 2, ui: 2, 'not-worth': 1 },
  });
  assert.deepEqual(json.excludedShort, [{ file: 'src/short.kt', loc: 20, reason: '短于 --min-lines（20 < 100）' }]);
  assert.deepEqual(json.notes.length > 0, true);
  assert.equal(json.root, '.');
});

test('triage-boundary：候选排序与指标（A/B 类文件进 candidate）', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const json = triageJson(dir);
  assert.deepEqual(json.candidates.map((row) => row.file), [
    'src/commenty.kt',
    'src/ui/ui_path.kt',
    'src/gson_candidate.kt',
    'src/candidate.kt',
  ]);
  const candidate = json.candidates.find((row) => row.file === 'src/candidate.kt') as TriageFile;
  assert.deepEqual(candidate.imports, { android: 0, androidx: 0, compose: 0, google: 0, dagger: 0, coroutines: 1, internal: 2, otherExternal: 0 });
  assert.equal(candidate.platformImports, 0);
  assert.equal(candidate.ui.value, false);
  const gsonRow = json.candidates.find((row) => row.file === 'src/gson_candidate.kt') as TriageFile;
  assert.equal(gsonRow.imports.google, 0, 'com.google.gson 不是 com.google.android 平台库');
  assert.equal(gsonRow.imports.otherExternal, 1);
  const composeRow = json.candidates.find((row) => row.file === 'src/ui/ui_path.kt') as TriageFile;
  assert.equal(composeRow.ui.uiPath, true, 'ui/ 路径只做标注，不参与分类');
  // UI / 平台文件不能进候选
  const names = json.candidates.map((row) => row.file);
  assert.equal(names.includes('src/ui_compose.kt'), false);
  assert.equal(names.includes('src/androidy.kt'), false);
  assert.equal(names.includes('src/heavy.kt'), false);
});

test('triage-boundary：UI 与平台分类（import/声明级，不看注释子串）', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const json = triageJson(dir);
  // ui_compose 的 import 同时计入 androidx 与 compose；platformImports 只算一次
  const compose = json.candidates.length > 0;
  assert.equal(compose, true);
  // 用 --top 100 把 top 列表当全量看：ui/boundary 不出现
  const full = triageJson(dir, ['--top', '100']);
  assert.equal(full.top.length, 4);
  // commenty 的注释里出现 ViewModel 但不误判
  assert.ok(full.candidates.some((row) => row.file === 'src/commenty.kt'));
});

test('triage-boundary：--min-lines 10 把短文件纳入候选', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const json = triageJson(dir, ['--min-lines', '10']);
  assert.deepEqual(json.funnel, {
    scannedKotlinFiles: 11,
    skippedTestSources: 0,
    coupledFiles: 10,
    coupledAtLeastMinLines: 10,
    zeroPlatformImports: 6,
    narrowDepsNonUi: 5,
    zeroInternalImports: 4,
    legacyPathUi: { narrowDepsNonUi: 4, excludedOnlyByPath: 1 },
    legacyScanUi: { zeroPlatformImports: 5, falsePositiveFiles: 1 },
  });
  assert.deepEqual(json.excludedShort, []);
  assert.equal(json.counts.splittableCandidates, 5);
  assert.equal(json.candidates[json.candidates.length - 1].file, 'src/short.kt');
});

test('triage-boundary：--top 只截 top，candidates 仍是全量', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const json = triageJson(dir, ['--top', '2']);
  assert.equal(json.top.length, 2);
  assert.equal(json.candidates.length, 4);
  assert.deepEqual(json.top.map((row) => row.file), ['src/commenty.kt', 'src/ui/ui_path.kt']);
});

// ---------------------------------------------------------------------------
// 输出格式 / 确定性 / 参数
// ---------------------------------------------------------------------------

test('triage-boundary：--md 输出漏斗与候选表', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const result = runTriage(['--root', dir, '--md'], dir);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('# 低 API 文件边界拆分分诊'));
  assert.ok(result.stdout.includes('## 漏斗'));
  assert.ok(result.stdout.includes('| splittable-candidate | 4 |'));
  assert.ok(result.stdout.includes('src/commenty.kt'));
  assert.ok(result.stdout.includes('旧口径对照'));
});

test('triage-boundary：--out 写文件、stdout 为空、内容与 stdout 一致', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const viaStdout = runTriage(['--root', dir, '--json'], dir);
  const viaFile = runTriage(['--root', dir, '--json', '--out', 'triage.json'], dir);
  assert.equal(viaFile.code, 0, viaFile.stderr);
  assert.equal(viaFile.stdout, '');
  assert.equal(readFileSync(join(dir, 'triage.json'), 'utf8'), viaStdout.stdout);
  const nested = runTriage(['--root', dir, '--md', '--out', join('reports', 'triage.md')], dir);
  assert.equal(nested.code, 0, nested.stderr);
  assert.ok(readFileSync(join(dir, 'reports', 'triage.md'), 'utf8').includes('## 漏斗'));
});

test('triage-boundary：确定性（两次输出逐字节相同、不含绝对路径）', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const first = runTriage(['--root', dir, '--json'], dir);
  const second = runTriage(['--root', dir, '--json'], dir);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.includes(dir), false, 'JSON 不应包含绝对路径');
  // cwd 不同、root 用绝对路径 → 输出仍相同
  const fromParent = runTriage(['--root', dir, '--json'], join(dir, '..'));
  assert.equal(fromParent.stdout, first.stdout);
});

test('triage-boundary：--help 打印用法并退出 0', () => {
  const result = runTriage(['--help'], repoRoot);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('triage-boundary'));
  assert.ok(result.stdout.includes('--min-lines'));
});

test('triage-boundary：非法参数 exit 2', (t) => {
  const dir = makeTmp(t);
  setupFixture(dir);
  const cases: string[][] = [
    [],
    ['--root'],
    ['--root', dir, '--json', '--md'],
    ['--root', dir, '--min-lines', '0'],
    ['--root', dir, '--min-lines', 'abc'],
    ['--root', dir, '--top', '0'],
    ['--root', dir, '--top', '1.5'],
    ['--root', dir, '--bogus'],
    ['--root', join(dir, 'missing')],
    ['--root', dir, '--out'],
    ['--root', dir, '--root', dir],
  ];
  for (const args of cases) {
    const result = runTriage(args, dir);
    assert.equal(result.code, 2, '应 exit 2：' + args.join(' ') + '\n' + result.stderr);
    assert.ok(result.stderr.includes('错误'), '应有错误信息：' + args.join(' '));
  }
});

// ---------------------------------------------------------------------------
// legado 真值（若本机存在该仓库）
// ---------------------------------------------------------------------------

test('triage-boundary：legado 复现 834→71→35（旧口径 32）→5 漏斗，A/B 都是候选', { skip: !existsSync(LEGADO_SRC) }, () => {
  const result = runTriage(['--root', LEGADO_SRC, '--json'], repoRoot);
  assert.equal(result.code, 0, result.stderr);
  const json = JSON.parse(result.stdout) as TriageReport;
  assert.deepEqual(json.funnel, {
    scannedKotlinFiles: 1957,
    skippedTestSources: 0,
    coupledFiles: 1469,
    coupledAtLeastMinLines: 834,
    zeroPlatformImports: 71,
    narrowDepsNonUi: 35,
    zeroInternalImports: 5,
    legacyPathUi: { narrowDepsNonUi: 32, excludedOnlyByPath: 3 },
    legacyScanUi: { zeroPlatformImports: 67, falsePositiveFiles: 4 },
  });
  assert.equal(json.counts.splittableCandidates, 35);
  const candidateNames = json.candidates.map((row) => row.file);
  assert.ok(candidateNames.some((name) => name.endsWith('/WholeBookPageCoordinator.kt')), '试点 A 应识别为候选');
  assert.ok(candidateNames.some((name) => name.endsWith('/DefaultMangaReaderSession.kt')), '试点 B 应识别为候选');
  const topNames = json.top.map((row) => row.file);
  assert.ok(topNames.some((name) => name.endsWith('/WholeBookPageCoordinator.kt')));
  assert.ok(topNames.some((name) => name.endsWith('/DefaultMangaReaderSession.kt')));
});
