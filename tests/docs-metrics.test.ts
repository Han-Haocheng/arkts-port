import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测仓库里的 cli/docs-metrics.ts；case/refs/文档全部是临时目录里的自造真值。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const docsMetricsPath = join(repoRoot, 'cli', 'docs-metrics.ts');

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Report {
  ok: boolean;
  case: {
    dir: string;
    golden: { scenarios: number; pages: number };
    actual: { scenarios: number; pages: number };
    fidelityPct: number;
    fidelityEqual: boolean;
    actualMd5: string;
  };
  refs: null | {
    dir: string;
    baseline: null | { files: number; lines: number };
    ts: null | { files: number; lines: number };
    src: null | { files: number; lines: number; moduleFiles: number; moduleLines: number };
    errors: null | {
      file: string;
      total: number;
      hard: number;
      warn: number;
      byCode: { code: string; count: number }[];
    };
    codemod: null | {
      options: number;
      patches: number;
      asConst: number;
      renamePairs: number;
      renamedValueTypes: number;
    };
  };
  coverage: null | { files: number; totalLoc: number; autoConvertiblePct: number; verdict: string };
  check: null | {
    files: string[];
    linesScanned: number;
    claims: number;
    mismatches: {
      file: string;
      line: number;
      group: string;
      label: string;
      expected: number | string;
      actual: number | string;
      snippet: string;
    }[];
    groupsHit: string[];
    groupsMismatched: string[];
    skipped: string[];
  };
}

function makeTmp(t: TestHooks): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-port-metrics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function repeatedLines(count: number): string {
  let text = '';
  for (let index = 0; index < count; index++) text += 'line ' + index + '\n';
  return text;
}

const GOLDEN = [
  { scenario: 's1', pageCount: 2, pages: [{ text: 'a' }, { text: 'b' }] },
  { scenario: 's2', pageCount: 1, pages: [{ text: 'c' }] },
];
const ACTUAL = [
  { scenario: 's1', pageCount: 2, pages: [{ text: 'a' }, { text: 'b' }] },
  { scenario: 's2', pageCount: 1, pages: [{ text: 'c' }] },
];

function makeCase(t: TestHooks, actual = ACTUAL) {
  const dir = join(makeTmp(t), 'case');
  write(join(dir, 'golden.json'), JSON.stringify(GOLDEN));
  write(join(dir, 'actual.json'), JSON.stringify(actual));
  return dir;
}

/**
 * 自造 refs 真值：
 * baseline 2 文件/10 行，options=1 patches=1 asConst=2 renamePairs=2
 * ts 2 文件/2 行，renamedValueTypes=2
 * src 3 文件/302 行（模块 2 文件/299 行）
 * errors 3 条 = 硬 2 + WARN 1（file="?" 的 arkts-no-globalthis）
 */
function makeRefs(t: TestHooks): { dir: string } {
  const root = join(makeTmp(t), 'refs');
  const baseline = join(root, 'arkts-adapt-baseline');
  write(join(baseline, 'layout', 'A.ts'), [
    'export type Mode = { a: number };',
    '// 历史写法：copy(patch: Partial<Foo>) 已改成手写，注释体里的这处不算代码',
    'export const Mode = {',
    '  a: 1,',
    '} as const;',
    'export class Foo {',
    '  constructor(options: { x: number }) {}',
    '  copy(patch: Partial<Foo>) { return patch; }',
    '}',
    '',
  ].join('\n'));
  write(join(baseline, 'model', 'B.ts'), [
    'export type Other = { b: number };',
    'export const Other = { b: 2 } as const;',
    '',
  ].join('\n'));

  const ts = join(root, 'pag-exp', 'ts');
  write(join(ts, 'layout', 'Alpha.ts'), 'export type AlphaValue = { a: number };\n');
  write(join(ts, 'model', 'Beta.ts'), 'export type BetaValue = { b: number };\n');
  write(join(ts, 'model', 'Gamma.ts'), 'export interface GammaValue { g: number; }\n');

  const src = join(root, 'pag-exp', 'src');
  write(join(src, 'Main.kt'), repeatedLines(3));
  write(join(src, 'layout', 'ModuleA.kt'), repeatedLines(200));
  write(join(src, 'model', 'ModuleB.kt'), repeatedLines(99));

  write(join(root, 'arkts-adapt-errors-with-full-reachability.json'), JSON.stringify([
    { code: 'arkts-no-typecasts', file: 'parity/a.ets', line: 1, col: 1 },
    { code: 'arkts-no-untyped-obj-literals', file: 'parity/b.ets', line: 2, col: 2 },
    { code: 'arkts-no-globalthis', file: '?', line: 0, col: 0 },
  ]));
  return { dir: root };
}

const COVERAGE = { files: 100, totalLoc: 2000, autoConvertiblePct: 50, verdict: 'high' };

function makeCoverage(t: TestHooks): string {
  const path = join(makeTmp(t), 'coverage.json');
  write(path, JSON.stringify(COVERAGE));
  return path;
}

const CLEAN_DOC = [
  '# 假文档（正确版）',
  '覆盖率 100 个文件 / 2,000 行，可自动覆盖率 50%。',
  '保真度 100%（3/3 页，2 场景逐字全等）',
  '闭包 2 个文件 / 约 299 行',
  'TS 转写产物 2 文件 / 11 行',
  '适配产物（ets）3 文件 / 3 行',
  '| ArkTS 错误（全量） | 3 |',
  '3 条原始（硬 2 + 1 WARN）',
  '机械修复 1 个 XxxOptions + 1 个 XxxPatch + 2 处 as const',
  '3 对类型改名（2 个 XxxValue type alias + 1 个 XxxValue interface）',
  '│ build-hap 构建（unsigned HAP，不签名）',
  '',
].join('\n');

const DIRTY_DOC = [
  '# 假文档（漂移版）',
  '| 上游可自动覆盖率 | 13%（9 个文件 / 1,000 行中，87% 直接耦合） |',
  '保真 62/62 页，16 场景逐字全等',
  '| Kotlin 闭包 | 21 文件 / 约 2,900 行 |',
  '| TS 转写产物 | 22 文件 / 4,925 行 |',
  '| 适配产物（ets） | 22 文件 / 9,999 行 |',
  '| ArkTS 错误（全量 22 模块可达） | 177 |',
  '177 处错误全是机械的：43 个 XxxOptions + 41 个 XxxPatch + 9 处 as const',
  '9 组类型改名',
  '│ build-hap 构建 + 签名',
  '',
].join('\n');

function makeDoc(t: TestHooks, name: string, content: string): string {
  const dir = makeTmp(t);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function runDocs(args: string[], cwd: string): RunResult {
  const res = spawnSync(process.execPath, [docsMetricsPath, ...args], { cwd, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function readJson(path: string): Report {
  return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

function humanLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.trim() !== '');
}

function lineNumberOf(docPath: string, needle: string): number {
  const lines = readFileSync(docPath, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, '文档里应有：' + needle);
  return index + 1;
}

// ---------------------------------------------------------------------------
// canonical metrics：case / refs / coverage
// ---------------------------------------------------------------------------

test('必算项：场景/页数/保真/md5，无 --refs/--coverage 时输出 null 且 exit 0', (t) => {
  const caseDir = makeCase(t);
  const root = makeTmp(t);
  const res = runDocs(['--case', caseDir, '--json'], root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.equal(report.ok, true);
  assert.deepEqual(report.case.golden, { scenarios: 2, pages: 3 });
  assert.deepEqual(report.case.actual, { scenarios: 2, pages: 3 });
  assert.equal(report.case.fidelityPct, 100);
  assert.equal(report.case.fidelityEqual, true);
  assert.match(report.case.actualMd5, /^[0-9a-f]{32}$/);
  assert.equal(report.refs, null);
  assert.equal(report.coverage, null);
  assert.equal(report.check, null);
});

test('保真度有差异时 fidelityPct 反映逐项全等比例', (t) => {
  const caseDir = makeCase(t, [
    { scenario: 's1', pageCount: 2, pages: [{ text: 'a' }, { text: 'X' }] },
    { scenario: 's2', pageCount: 1, pages: [{ text: 'c' }] },
  ]);
  const res = runDocs(['--case', caseDir, '--json'], makeTmp(t));
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.equal(report.case.fidelityPct, 66.67);
  assert.equal(report.case.fidelityEqual, false);
});

test('--refs：baseline/adapted/closure/errors(WARN 拆分)/codemod 全部按 wc 口径算出', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const reportPath = join(makeTmp(t), 'report.json');
  const res = runDocs(['--case', caseDir, '--refs', refs.dir, '--json', '--report', reportPath], makeTmp(t));
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.deepEqual(report.refs?.baseline, { files: 2, lines: 11 });
  assert.deepEqual(report.refs?.adapted, { files: 3, lines: 3 });
  assert.deepEqual(report.refs?.src, { files: 3, lines: 302, moduleFiles: 2, moduleLines: 299 });
  assert.equal(report.refs?.errors?.total, 3);
  assert.equal(report.refs?.errors?.hard, 2);
  assert.equal(report.refs?.errors?.warn, 1);
  assert.deepEqual(report.refs?.errors?.byCode, [
    { code: 'arkts-no-globalthis', count: 1 },
    { code: 'arkts-no-typecasts', count: 1 },
    { code: 'arkts-no-untyped-obj-literals', count: 1 },
  ]);
  // patches 只数代码行：fixture 里 2 处 copy(patch: Partial<)，其中 1 处在注释里
  assert.deepEqual(report.refs?.codemod, {
    options: 1,
    patches: 1,
    asConst: 2,
    renamePairs: 2,
    renamedTypeAliases: 2,
    renamedValueDeclarations: 3,
  });
  assert.deepEqual(readJson(reportPath), report);
});

test('--coverage：透传 analyze-coupling 的四个字段', (t) => {
  const caseDir = makeCase(t);
  const coveragePath = makeCoverage(t);
  const res = runDocs(['--case', caseDir, '--coverage', coveragePath, '--json'], makeTmp(t));
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.deepEqual(report.coverage, COVERAGE);
});

// ---------------------------------------------------------------------------
// --check：命中 / 不命中 / 跳过 / 退出码
// ---------------------------------------------------------------------------

test('--check 正确文档：exit 0，有声明但 0 处不一致', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const coveragePath = makeCoverage(t);
  const doc = makeDoc(t, 'CLEAN.md', CLEAN_DOC);
  const res = runDocs(
    ['--case', caseDir, '--refs', refs.dir, '--coverage', coveragePath, '--check', doc, '--json'],
    makeTmp(t),
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.equal(report.ok, true);
  assert.equal(report.check?.mismatches.length, 0);
  assert.ok((report.check?.claims ?? 0) >= 10, '应扫描到多处声明');
  // claims>0 时 groupsHit 必须非空（reviewer 发现的 bug：全是正确声明时 groupsHit 为空）
  assert.ok((report.check?.groupsHit.length ?? 0) >= 5, 'groupsHit 应按命中组计数：' + JSON.stringify(report.check?.groupsHit));
  assert.deepEqual(report.check?.groupsMismatched, []);
  assert.deepEqual(report.check?.skipped, []);
});

test('覆盖率阈值/策略行不误报（<15% 不做自动转换、verdict=low）', (t) => {
  const caseDir = makeCase(t);
  const coveragePath = makeCoverage(t);
  const doc = makeDoc(t, 'POLICY.md', [
    '- 覆盖率 <15% 不做自动转换（只做人写移植）。',
    'verdict=low（<15%）→ 停。',
    '可自动覆盖率 50%。',
    '',
  ].join('\n'));
  const res = runDocs(
    ['--case', caseDir, '--coverage', coveragePath, '--check', doc, '--json'],
    makeTmp(t),
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  const check = report.check as NonNullable<Report['check']>;
  assert.equal(check.mismatches.length, 0);
  assert.deepEqual(check.groupsMismatched, []);
  assert.ok(check.groupsHit.includes('coverage'), '真正的覆盖率声明仍应被检查');
});

test('--check 漂移文档：exit 1，file:line/expected/actual 准确，命中 8 组', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const coveragePath = makeCoverage(t);
  const doc = makeDoc(t, 'DIRTY.md', DIRTY_DOC);
  const res = runDocs(
    ['--case', caseDir, '--refs', refs.dir, '--coverage', coveragePath, '--check', doc, '--json'],
    makeTmp(t),
  );
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  assert.equal(report.ok, false);
  assert.ok(report.check !== null);
  const check = report.check as NonNullable<Report['check']>;
  assert.deepEqual(check.groupsHit, ['closure', 'codemod', 'coverage', 'errors', 'fidelity', 'rename', 'sign', 'ts']);
  assert.deepEqual(check.groupsMismatched, ['closure', 'codemod', 'coverage', 'errors', 'fidelity', 'rename', 'sign', 'ts']);

  const find = (needle: string, label: string) => {
    const target = check.mismatches.find((mismatch) =>
      mismatch.snippet.includes(needle) && mismatch.label === label);
    assert.ok(target, '应有 mismatch：' + needle + ' / ' + label);
    return target;
  };

  const coverageFiles = find('13%（9 个文件', '覆盖率文件数');
  assert.equal(coverageFiles.line, lineNumberOf(doc, '上游可自动覆盖率'));
  assert.equal(coverageFiles.expected, 100);
  assert.equal(coverageFiles.actual, 9);

  const coverageLines = find('13%（9 个文件', '覆盖率行数');
  assert.equal(coverageLines.expected, 2000);
  assert.equal(coverageLines.actual, 1000);

  const coveragePct = find('87% 直接耦合', '自动覆盖率');
  assert.equal(coveragePct.expected, 50);
  assert.equal(coveragePct.actual, 13);

  const closureFiles = find('Kotlin 闭包', '闭包文件数');
  assert.equal(closureFiles.expected, 2);
  assert.equal(closureFiles.actual, 21);

  // 「转写产物」对 baseline（2 文件 / 11 行），不是 adapted（3 文件 / 3 行）
  const transcriptionLines = find('TS 转写产物', '转写产物行数');
  assert.equal(transcriptionLines.line, lineNumberOf(doc, 'TS 转写产物'));
  assert.equal(transcriptionLines.expected, 11);
  assert.equal(transcriptionLines.actual, 4925);

  const adaptedLines = find('适配产物', '适配产物行数');
  assert.equal(adaptedLines.line, lineNumberOf(doc, '适配产物'));
  assert.equal(adaptedLines.expected, 3);
  assert.equal(adaptedLines.actual, 9999);

  const errors = find('ArkTS 错误（全量', '全量 ArkTS 错误数');
  assert.equal(errors.expected, 3);
  assert.equal(errors.actual, 177);

  const patch = find('XxxPatch', 'XxxPatch 数');
  assert.equal(patch.expected, 1);
  assert.equal(patch.actual, 41);

  const rename = find('9 组类型改名', '类型改名组数');
  assert.equal(rename.expected, 3);
  assert.equal(rename.actual, 9);

  const sign = find('构建 + 签名', '构建产物是否签名');
  assert.equal(sign.group, 'sign');
  assert.match(String(sign.expected), /unsigned|不签名/);

  const fidelity = find('62/62', '保真页数');
  assert.equal(fidelity.expected, '3/3');
  assert.equal(fidelity.actual, '62/62');
});

test('口径校正：patches 排除注释 / 转写产物对 baseline / 改名 3 声明 / 同行 total-hard-WARN 可解析', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const coveragePath = makeCoverage(t);
  const doc = makeDoc(t, 'CALIBER.md', [
    'TS 转写产物 2 文件 / 5,597 行',
    '适配产物（ets）3 文件 / 3 行',
    '2 个 XxxPatch',
    '8 组类型改名',
    '3 条原始（硬 2 + 1 WARN）',
    '9 条原始（硬 2 + 1 WARN）',
    '3 条原始（硬 9 + 1 WARN）',
    '3 条原始（硬 2 + 5 WARN）',
    '',
  ].join('\n'));
  const res = runDocs(
    ['--case', caseDir, '--refs', refs.dir, '--coverage', coveragePath, '--check', doc, '--json'],
    makeTmp(t),
  );
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  const check = report.check as NonNullable<Report['check']>;
  const find = (needle: string, label: string) => {
    const target = check.mismatches.find((mismatch) =>
      mismatch.snippet.includes(needle) && mismatch.label === label);
    assert.ok(target, '应有 mismatch：' + needle + ' / ' + label);
    return target;
  };

  // 1) 转写产物行数按 baseline（11），不是 adapted（3）
  const transcription = find('TS 转写产物', '转写产物行数');
  assert.equal(transcription.expected, 11);
  assert.equal(transcription.actual, 5597);
  assert.equal(transcription.line, lineNumberOf(doc, 'TS 转写产物'));

  // 2) 适配产物仍按 adapted 校验，这里是对的，不应出现在 mismatch 里
  assert.ok(!check.mismatches.some((mismatch) => mismatch.label === '适配产物行数'));

  // 3) patches：注释里那处不算，canonical 1；文档写 2 要报
  const patch = find('2 个 XxxPatch', 'XxxPatch 数');
  assert.equal(patch.expected, 1);
  assert.equal(patch.actual, 2);

  // 4) 改名组按 3 个 XxxValue 声明（type + interface）校验
  const rename = find('8 组类型改名', '类型改名组数');
  assert.equal(rename.expected, 3);
  assert.equal(rename.actual, 8);

  // 5) 同一行「178 条原始（硬 177 + 1 WARN）」分别解析 total / hard / warn
  assert.ok(!check.mismatches.some((mismatch) => mismatch.snippet.includes('3 条原始（硬 2 + 1 WARN）')));
  const total = find('9 条原始', '全量 ArkTS 错误数');
  assert.equal(total.expected, 3);
  assert.equal(total.actual, 9);
  const hard = find('硬 9', '硬错误数');
  assert.equal(hard.expected, 2);
  assert.equal(hard.actual, 9);
  const warn = find('5 WARN', 'WARN 数');
  assert.equal(warn.expected, 1);
  assert.equal(warn.actual, 5);
  assert.equal(total.line, lineNumberOf(doc, '9 条原始'));
  assert.equal(hard.line, lineNumberOf(doc, '硬 9'));
  assert.equal(warn.line, lineNumberOf(doc, '5 WARN'));
});

test('groupsHit 统计被检查到的组，groupsMismatched 只统计有差异的组', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const coveragePath = makeCoverage(t);
  const doc = makeDoc(t, 'MIX.md', [
    '覆盖率 9 个文件 / 2,000 行，可自动覆盖率 50%。',
    '保真度 100%（3/3 页，2 场景逐字全等）',
    '闭包 2 个文件 / 约 299 行',
    '',
  ].join('\n'));
  const res = runDocs(
    ['--case', caseDir, '--refs', refs.dir, '--coverage', coveragePath, '--check', doc, '--json'],
    makeTmp(t),
  );
  assert.equal(res.code, 1);
  const check = (JSON.parse(res.stdout) as Report).check as NonNullable<Report['check']>;
  assert.ok(check.groupsHit.includes('coverage'));
  assert.ok(check.groupsHit.includes('closure'));
  assert.ok(check.groupsHit.includes('fidelity'));
  assert.deepEqual(check.groupsMismatched, ['coverage']);
  assert.equal(check.mismatches.length, 1);
});

test('--check 不带 --refs/--coverage：相关组跳过，不误报', (t) => {
  const caseDir = makeCase(t);
  const doc = makeDoc(t, 'CLEAN.md', CLEAN_DOC);
  const res = runDocs(['--case', caseDir, '--check', doc, '--json'], makeTmp(t));
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Report;
  const check = report.check as NonNullable<Report['check']>;
  assert.equal(check.mismatches.length, 0);
  assert.ok(check.skipped.some((item) => item.startsWith('coverage')), '应跳过 coverage 组');
  assert.ok(check.skipped.some((item) => item.startsWith('closure')), '应跳过 closure 组');
  assert.ok(check.skipped.some((item) => item.startsWith('errors')), '应跳过 errors 组');
});

test('约数容差：约 300 行对上 canonical 299 行不报，精确 300 行要报', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const okDoc = makeDoc(t, 'OK.md', '闭包 2 个文件 / 约 300 行\n');
  const ok = runDocs(['--case', caseDir, '--refs', refs.dir, '--check', okDoc, '--json'], makeTmp(t));
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);

  const strictDoc = makeDoc(t, 'STRICT.md', '闭包 2 个文件 / 300 行\n');
  const strict = runDocs(['--case', caseDir, '--refs', refs.dir, '--check', strictDoc, '--json'], makeTmp(t));
  assert.equal(strict.code, 1, strict.stdout + strict.stderr);
  const report = JSON.parse(strict.stdout) as Report;
  assert.equal(report.check?.mismatches[0]?.label, '闭包行数');
  assert.equal(report.check?.mismatches[0]?.expected, 299);
  assert.equal(report.check?.mismatches[0]?.actual, 300);
});

// ---------------------------------------------------------------------------
// 输出 / 确定性 / 退出码
// ---------------------------------------------------------------------------

test('人类摘要 ≤15 行；--report 单独使用时写文件且 stdout 仍是摘要', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const coveragePath = makeCoverage(t);
  const doc = makeDoc(t, 'DIRTY.md', DIRTY_DOC);
  const reportPath = join(makeTmp(t), 'report.json');
  const res = runDocs(
    ['--case', caseDir, '--refs', refs.dir, '--coverage', coveragePath, '--check', doc, '--report', reportPath],
    makeTmp(t),
  );
  assert.equal(res.code, 1);
  const lines = humanLines(res.stdout);
  assert.ok(lines.length <= 15, '人类摘要应 ≤15 行，实际 ' + lines.length);
  assert.match(res.stdout, /docs-metrics  case=/);
  assert.match(res.stdout, /保真/);
  assert.match(res.stdout, /结果: MISMATCH/);
  const report = readJson(reportPath);
  assert.equal(report.ok, false);
  assert.ok((report.check?.mismatches.length ?? 0) > 0);
});

test('确定性：同输入两次运行，报告 JSON 完全相等', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const coveragePath = makeCoverage(t);
  const doc = makeDoc(t, 'DIRTY.md', DIRTY_DOC);
  const cwd = makeTmp(t);
  const first = join(cwd, 'a.json');
  const second = join(cwd, 'b.json');
  const args = ['--case', caseDir, '--refs', refs.dir, '--coverage', coveragePath, '--check', doc, '--report'];
  const runA = runDocs([...args, first], cwd);
  const runB = runDocs([...args, second], cwd);
  assert.equal(runA.code, 1);
  assert.equal(runB.code, 1);
  assert.deepEqual(readJson(first), readJson(second));
});

test('用法/读取错误一律 exit 2', (t) => {
  const caseDir = makeCase(t);
  const refs = makeRefs(t);
  const root = makeTmp(t);
  const missingDoc = join(root, 'nope.md');
  const badCoverage = join(root, 'bad-coverage.json');
  writeFileSync(badCoverage, '{"files": "x"}', 'utf8');
  const cases: string[][] = [
    [],
    ['--bogus'],
    ['--case'],
    ['--case', join(root, 'nope')],
    ['--case', caseDir, '--refs', join(root, 'nope')],
    ['--case', caseDir, '--coverage', join(root, 'nope.json')],
    ['--case', caseDir, '--coverage', badCoverage],
    ['--case', caseDir, '--check', missingDoc],
    ['--case', caseDir, '--refs', refs.dir, '--check', ''],
  ];
  for (const args of cases) {
    const res = runDocs(args, root);
    assert.equal(res.code, 2, '应报用法/读取错误：' + JSON.stringify(args) + ' → ' + res.code);
    assert.match(res.stderr, /docs-metrics: /);
  }
});

test('--help 打印用法并 exit 0', () => {
  const res = runDocs(['--help'], repoRoot);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /node cli\/docs-metrics\.ts/);
  assert.match(res.stdout, /退出码：0 = 计算成功/);
});
