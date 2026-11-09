/**
 * cli/diff-gate.ts 的黑盒单测：临时目录里自造 before/after fixture，不依赖真实 .refs / out/accept。
 * 覆盖：type-only / import-path / 运行时改动 / 新增删除文件 / 多 hunk / 退出码 / --json / --report / 确定性。
 *
 * 跑法：node --test tests/diff-gate.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CLI = join(ROOT, 'cli', 'diff-gate.ts');
const TEMP_DIRS: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-gate-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const absolute = join(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

interface Pair {
  beforeDir: string;
  afterDir: string;
}

function makePair(before: Record<string, string>, after: Record<string, string>): Pair {
  const root = makeTempDir();
  const beforeDir = join(root, 'before');
  const afterDir = join(root, 'after');
  mkdirSync(beforeDir, { recursive: true });
  mkdirSync(afterDir, { recursive: true });
  writeTree(beforeDir, before);
  writeTree(afterDir, after);
  return { beforeDir, afterDir };
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runGate(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: result.status === null ? -1 : result.status,
    stdout: result.stdout === null ? '' : result.stdout,
    stderr: result.stderr === null ? '' : result.stderr,
  };
}

function runPair(pair: Pair, extra: string[] = []): CliRun {
  return runGate(['--before', pair.beforeDir, '--after', pair.afterDir, '--json', ...extra]);
}

function parse(run: CliRun): Record<string, unknown> {
  assert.ok(run.stdout.trim().startsWith('{'), '期望 JSON 输出，实际：' + run.stdout.slice(0, 200));
  return JSON.parse(run.stdout);
}

interface HunkView {
  line: number;
  kind: string;
  before: string | null;
  after: string | null;
}

interface FileView {
  path: string;
  status: string;
  hunks: HunkView[];
}

function fileOf(report: Record<string, unknown>, path: string): FileView {
  const files = report.files as FileView[];
  const found = files.filter((item) => item.path === path)[0];
  assert.ok(found !== undefined, '报告里没有文件 ' + path + '，实际：' + files.map((item) => item.path).join(','));
  return found;
}

test('type-only：interface 插入 / 构造器 Options / copy Patch / type 改名 / XMap / as const', () => {
  const before = {
    'lib/thing.ts': [
      'export type ThingKind = "A" | "B";',
      '',
      'export const ThingKind = {',
      '  A: "A",',
      '  B: "B",',
      '} as const;',
      '',
      'export class Thing {',
      '  readonly kind: ThingKind;',
      '',
      '  constructor(options: {',
      '    kind: ThingKind;',
      '  }) {',
      '    this.kind = options.kind;',
      '  }',
      '',
      '  copy(patch: Partial<Thing>): Thing {',
      '    return new Thing({',
      '      kind: patch.kind ?? this.kind,',
      '    });',
      '  }',
      '}',
      '',
    ].join('\n'),
  };
  const after = {
    'lib/thing.ts': [
      'export type ThingKindValue = "A" | "B";',
      '',
      '/** ThingKind 常量的声明类型。 */',
      'export interface ThingKindMap {',
      '  readonly A: ThingKindValue;',
      '  readonly B: ThingKindValue;',
      '}',
      '',
      'export const ThingKind: ThingKindMap = {',
      '  A: "A",',
      '  B: "B",',
      '};',
      '',
      '/** Thing 的构造参数。 */',
      'export interface ThingOptions {',
      '  kind: ThingKindValue;',
      '}',
      '',
      '/** Thing 的 copy 补丁。 */',
      'export interface ThingPatch {',
      '  kind?: ThingKindValue;',
      '}',
      '',
      'export class Thing {',
      '  readonly kind: ThingKindValue;',
      '',
      '  constructor(options: ThingOptions) {',
      '    this.kind = options.kind;',
      '  }',
      '',
      '  copy(patch: ThingPatch): Thing {',
      '    return new Thing({',
      '      kind: patch.kind ?? this.kind,',
      '    });',
      '  }',
      '}',
      '',
    ].join('\n'),
  };
  const pair = makePair(before, after);
  const run = runPair(pair);
  assert.equal(run.status, 0, run.stderr);
  const report = parse(run);
  assert.equal(report.ok, true);
  const counts = report.counts as Record<string, number>;
  assert.deepEqual(counts, { typeOnly: counts.typeOnly, importPath: 0, needsReview: 0, cannotPair: 0 });
  assert.ok(counts.typeOnly >= 5, 'type-only hunk 应该覆盖多类变换，实际 ' + counts.typeOnly);
  const file = fileOf(report, 'lib/thing.ts');
  assert.equal(file.status, 'modified');
  for (const hunk of file.hunks) assert.equal(hunk.kind, 'type-only');
});

test('import-path：只有相对 import 的 .ts 后缀变化（含多行 import 的 from 行）', () => {
  const before = {
    'lib/a.ts': [
      'import { one } from "./one.ts";',
      'import type {',
      '  Shape,',
      '} from "../lib/shape.ts";',
      '',
      'export function a(shape: Shape): number {',
      '  return one(shape);',
      '}',
      '',
    ].join('\n'),
  };
  const after = {
    'lib/a.ts': [
      'import { one } from "./one";',
      'import type {',
      '  Shape,',
      '} from "../lib/shape";',
      '',
      'export function a(shape: Shape): number {',
      '  return one(shape);',
      '}',
      '',
    ].join('\n'),
  };
  const pair = makePair(before, after);
  const run = runPair(pair);
  assert.equal(run.status, 0, run.stderr);
  const report = parse(run);
  const counts = report.counts as Record<string, number>;
  assert.equal(counts.needsReview, 0);
  assert.equal(counts.importPath, 2, '两个 import 区域都应该被识别为 import-path');
  const file = fileOf(report, 'lib/a.ts');
  for (const hunk of file.hunks) assert.equal(hunk.kind, 'import-path');
});

test('配对：before .ts 与 after .ets 按去扩展名配对，不算无法配对', () => {
  const content = 'import { x } from "./x.ts";\n\nexport const y = x;\n';
  const pair = makePair({ 'lib/a.ts': content }, { 'lib/a.ets': content.replace('./x.ts', './x') });
  const run = runPair(pair);
  assert.equal(run.status, 0, run.stderr);
  const report = parse(run);
  const counts = report.counts as Record<string, number>;
  assert.equal(counts.cannotPair, 0);
  assert.equal(counts.importPath, 1);
  assert.equal(fileOf(report, 'lib/a.ets').status, 'modified');
});

test('运行时改动：函数体/语句变化 -> needs-review，exit 3；--strict -> 1', () => {
  const before = {
    'lib/now.ts': [
      'export function now(): number {',
      '  return Date.now();',
      '}',
      '',
    ].join('\n'),
  };
  const after = {
    'lib/now.ts': [
      'export function now(timer: { now(): number }): number {',
      '  return timer.now();',
      '}',
      '',
    ].join('\n'),
  };
  const pair = makePair(before, after);
  const run = runPair(pair);
  assert.equal(run.status, 3, run.stderr);
  const report = parse(run);
  assert.equal(report.ok, false);
  const counts = report.counts as Record<string, number>;
  assert.ok(counts.needsReview >= 1);
  const file = fileOf(report, 'lib/now.ts');
  assert.ok(file.hunks.some((hunk) => hunk.kind === 'needs-review'));

  const strict = runPair(pair, ['--strict']);
  assert.equal(strict.status, 1, '--strict 时 needs-review 应该 exit 1');
});

test('同一区域里混入运行时改动 -> 整个区域 needs-review（不吃掉告警）', () => {
  const before = {
    'lib/mixed.ts': [
      'export class Mixed {',
      '  readonly kind: Kind;',
      '  readonly value: number = compute();',
      '}',
      '',
    ].join('\n'),
  };
  const after = {
    'lib/mixed.ts': [
      'export class Mixed {',
      '  readonly kind: KindValue;',
      '  readonly value: number = compute() + 1;',
      '}',
      '',
    ].join('\n'),
  };
  const pair = makePair(before, after);
  const run = runPair(pair);
  assert.equal(run.status, 3, run.stderr);
  const report = parse(run);
  const counts = report.counts as Record<string, number>;
  assert.ok(counts.needsReview >= 1);
  const file = fileOf(report, 'lib/mixed.ts');
  const merged = file.hunks.filter((hunk) => hunk.kind === 'needs-review');
  assert.ok(merged.length >= 1);
});

test('值位置用生成名 -> needs-review（不会被类型名归一化吞掉）', () => {
  const before = { 'lib/v.ts': 'export const pick = FooOptions;\n' };
  const after = { 'lib/v.ts': 'export const pick = Foo;\n' };
  const pair = makePair(before, after);
  const run = runPair(pair);
  assert.equal(run.status, 3, run.stderr);
  const report = parse(run);
  assert.ok((report.counts as Record<string, number>).needsReview >= 1);
});

test('新增文件 / 删除文件 -> cannotPair，记 needs-review，exit 3', () => {
  const pair = makePair(
    { 'lib/keep.ts': 'export const keep = 1;\n', 'lib/gone.ts': 'export const gone = 2;\n' },
    { 'lib/keep.ts': 'export const keep = 1;\n', 'lib/fresh.ts': 'export const fresh = 3;\n' },
  );
  const run = runPair(pair);
  assert.equal(run.status, 3, run.stderr);
  const report = parse(run);
  const counts = report.counts as Record<string, number>;
  assert.equal(counts.cannotPair, 2);
  assert.equal(counts.needsReview, 2);
  const added = fileOf(report, 'lib/fresh.ts');
  assert.equal(added.status, 'added');
  assert.equal(added.hunks[0].kind, 'needs-review');
  assert.equal(added.hunks[0].before, null);
  assert.equal(added.hunks[0].after, 'export const fresh = 3;');
  const removed = fileOf(report, 'lib/gone.ts');
  assert.equal(removed.status, 'removed');
  assert.equal(removed.hunks[0].after, null);
  assert.equal(removed.hunks[0].before, 'export const gone = 2;');
});

test('多 hunk：一个文件里多段分离的类型层改动各算一个 hunk，行号取自 after', () => {
  const before = {
    'lib/multi.ts': [
      'export type Kind = "A";',
      '',
      'const filler1 = 1;',
      '',
      'export class Box {',
      '  readonly kind: Kind;',
      '',
      '  constructor(options: { kind: Kind }) {',
      '    this.kind = options.kind;',
      '  }',
      '',
      '  copy(patch: Partial<Box>): Box {',
      '    return new Box({ kind: patch.kind ?? this.kind });',
      '  }',
      '}',
      '',
    ].join('\n'),
  };
  const after = {
    'lib/multi.ts': [
      'export type KindValue = "A";',
      '',
      'const filler1 = 1;',
      '',
      'export class Box {',
      '  readonly kind: KindValue;',
      '',
      '  constructor(options: BoxOptions) {',
      '    this.kind = options.kind;',
      '  }',
      '',
      '  copy(patch: BoxPatch): Box {',
      '    return new Box({ kind: patch.kind ?? this.kind });',
      '  }',
      '}',
      '',
    ].join('\n'),
  };
  const pair = makePair(before, after);
  const run = runPair(pair);
  assert.equal(run.status, 0, run.stderr);
  const file = fileOf(parse(run), 'lib/multi.ts');
  assert.ok(file.hunks.length >= 4, '应该有 type 改名 / 字段类型 / 构造器 / copy 4 段 hunk，实际 ' + file.hunks.length);
  const lines = file.hunks.map((hunk) => hunk.line);
  assert.deepEqual(lines.slice().sort((a, b) => a - b), lines, 'hunk 按行号升序');
  for (const hunk of file.hunks) {
    assert.ok(Number.isInteger(hunk.line) && hunk.line > 0);
    assert.ok(['type-only', 'import-path', 'needs-review'].indexOf(hunk.kind) >= 0);
  }
});

test('--json 报告结构：ok/before/after/files/counts，file 与 hunk 字段齐全', () => {
  const pair = makePair({ 'a.ts': 'const x = 1;\n' }, { 'a.ts': 'const x = 2;\n' });
  const run = runPair(pair);
  const report = parse(run);
  assert.deepEqual(Object.keys(report).sort(), ['after', 'before', 'counts', 'files', 'ok']);
  assert.equal(report.before, pair.beforeDir);
  assert.equal(report.after, pair.afterDir);
  assert.deepEqual(Object.keys(report.counts as Record<string, number>).sort(), ['cannotPair', 'importPath', 'needsReview', 'typeOnly']);
  const files = report.files as FileView[];
  assert.equal(files.length, 1);
  assert.deepEqual(Object.keys(files[0]).sort(), ['hunks', 'path', 'status']);
  assert.deepEqual(Object.keys(files[0].hunks[0]).sort(), ['after', 'before', 'kind', 'line']);
});

test('--report 写文件且与 --json 内容一致', () => {
  const pair = makePair({ 'a.ts': 'const x = 1;\n' }, { 'a.ts': 'const x = 2;\n' });
  const reportPath = join(makeTempDir(), 'nested', 'report.json');
  const run = runGate(['--before', pair.beforeDir, '--after', pair.afterDir, '--json', '--report', reportPath]);
  assert.equal(run.status, 3, run.stderr);
  assert.equal(existsSync(reportPath), true);
  const fromFile = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.deepEqual(fromFile, parse(run));
});

test('人类摘要 <=15 行；--max 限制 needs-review 明细条数', () => {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  for (let i = 0; i < 12; i++) {
    beforeLines.push('const v' + i + ' = ' + i + ';', '');
    afterLines.push('const v' + i + ' = ' + (i + 100) + ';', '');
  }
  const pair = makePair({ 'many.ts': beforeLines.join('\n') }, { 'many.ts': afterLines.join('\n') });
  const human = runGate(['--before', pair.beforeDir, '--after', pair.afterDir]);
  assert.equal(human.status, 3, human.stderr);
  const lines = human.stdout.trim().split('\n');
  assert.ok(lines.length <= 15, '人类摘要必须 <= 15 行，实际 ' + lines.length + ' 行：\n' + human.stdout);
  assert.ok(human.stdout.includes('needs-review'));
  assert.ok(human.stdout.includes('many.ts:'));

  const limited = runGate(['--before', pair.beforeDir, '--after', pair.afterDir, '--max', '2']);
  assert.equal(limited.status, 3, limited.stderr);
  const limitedLines = limited.stdout.trim().split('\n');
  assert.ok(limitedLines.length <= 15);
  assert.ok(limited.stdout.includes('其余'), '超出 --max 时应提示其余条数：\n' + limited.stdout);
});

test('确定性：同一输入两次运行输出逐字节相同', () => {
  const pair = makePair(
    { 'a.ts': 'export type T = "A";\n\nexport const x = 1;\n' },
    { 'a.ts': 'export type TValue = "A";\n\nexport const x = 2;\n' },
  );
  const first = runPair(pair);
  const second = runPair(pair);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.status, second.status);
});

test('无变更：files 为空，counts 全 0，exit 0', () => {
  const tree = { 'a.ts': 'export const a = 1;\n', 'b/c.ts': 'export const c = 2;\n' };
  const pair = makePair(tree, tree);
  const run = runPair(pair);
  assert.equal(run.status, 0, run.stderr);
  const report = parse(run);
  assert.deepEqual(report.files, []);
  assert.deepEqual(report.counts, { typeOnly: 0, importPath: 0, needsReview: 0, cannotPair: 0 });
  assert.equal(report.ok, true);
});

test('用法错误 -> exit 2；--help -> 0', () => {
  const pair = makePair({ 'a.ts': 'a\n' }, { 'a.ts': 'b\n' });
  assert.equal(runGate([]).status, 2);
  assert.equal(runGate(['--before', pair.beforeDir]).status, 2);
  assert.equal(runGate(['--after', pair.afterDir]).status, 2);
  assert.equal(runGate(['--before', pair.beforeDir, '--after', pair.afterDir, '--nope']).status, 2);
  assert.equal(runGate(['--before', pair.beforeDir, '--after', pair.afterDir, '--max', '0']).status, 2);
  assert.equal(runGate(['--before', pair.beforeDir, '--after', pair.afterDir, '--max', 'abc']).status, 2);
  assert.equal(runGate(['--before']).status, 2);

  const help = runGate(['--help']);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--before'));
  assert.ok(help.stdout.includes('退出码'));
});

test('读取错误 -> exit 1（目录不存在 / 不是目录）', () => {
  const pair = makePair({ 'a.ts': 'a\n' }, { 'a.ts': 'a\n' });
  const missing = runGate(['--before', join(pair.beforeDir, 'nope'), '--after', pair.afterDir]);
  assert.equal(missing.status, 1, missing.stderr);
  const missingAfter = runGate(['--before', pair.beforeDir, '--after', join(pair.afterDir, 'nope')]);
  assert.equal(missingAfter.status, 1, missingAfter.stderr);
  const fileAsDir = runGate(['--before', join(pair.beforeDir, 'a.ts'), '--after', pair.afterDir]);
  assert.equal(fileAsDir.status, 1, fileAsDir.stderr);
  assert.ok(missing.stderr.includes('不是目录'), missing.stderr);
});

test('只比较 .ts/.ets：其它扩展名与隐藏文件不参与配对', () => {
  const pair = makePair(
    { 'a.ts': 'const a = 1;\n', 'notes.md': 'before\n', 'data.json': '{}\n' },
    { 'a.ts': 'const a = 1;\n', 'notes.md': 'after\n', 'data.json': '{"x":1}\n' },
  );
  const run = runPair(pair);
  assert.equal(run.status, 0, run.stderr);
  const report = parse(run);
  assert.deepEqual(report.files, []);
});

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});
