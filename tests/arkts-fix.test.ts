import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测仓库里的 cli/arkts-fix.ts（黑盒：临时目录 + 子进程）。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(repoRoot, 'cli', 'arkts-fix.ts');

interface TestHooks {
  after(fn: () => void): void;
}

function makeTmp(t: TestHooks, prefix = 'arkts-fix-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function runFix(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function runJson(args: string[], cwd: string) {
  const res = runFix([...args, '--json'], cwd);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout) as {
    ok: boolean;
    dryRun: boolean;
    rules: Record<string, number>;
    files: Array<{ path: string; changed: boolean; sha256In: string; rules: Array<{ rule: string; count: number; members?: number }>; skips: Array<{ rule: string; line: number; reason: string }> }>;
    totals: { files: number; changed: number; transforms: number; skips: number };
  };
}

function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      out.set(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return out;
}

const ENUM_FIXTURE = [
  '// 非目标注释：保持原样',
  'export const Color = {',
  '  Red: 0,',
  '  Green: 1,',
  '} as const',
  '/** 配对类型别名（注释在中间也要能识别） */',
  'export type Color = (typeof Color)[keyof typeof Color]',
  '',
  'export function paint(c: Color): string {',
  '  return c === Color.Red ? "red" : "green"',
  '}',
  '',
].join('\n');
test('规则 1：as const 对象 + typeof/keyof → export enum（数值字面量），源目录不动', (t) => {
  const dir = makeTmp(t);
  const src = join(dir, 'adapt');
  const out = join(dir, 'fixed');
  put(src, 'yoga/enums.ets', ENUM_FIXTURE);
  const report = runJson(['--src', 'adapt', '--out', 'fixed'], dir);
  assert.equal(report.ok, true);
  assert.deepEqual(report.rules, { 'as-const-object-to-enum': 1 });
  assert.equal(report.totals.files, 1);
  assert.equal(report.totals.changed, 1);
  assert.equal(report.files[0].rules[0].members, 2);
  assert.equal(typeof report.files[0].sha256In, 'string');

  const source = readFileSync(join(src, 'yoga/enums.ets'), 'utf8');
  assert.equal(source, ENUM_FIXTURE, '输入目录必须保持原样');
  const fixed = readFileSync(join(out, 'yoga/enums.ets'), 'utf8');
  assert.ok(fixed.includes('export enum Color {'));
  assert.ok(fixed.includes('  Red = 0,'));
  assert.ok(fixed.includes('  Green = 1,'));
  assert.equal(fixed.includes('as const'), false);
  assert.equal(fixed.includes('typeof Color'), false);
  assert.ok(fixed.includes('export function paint(c: Color): string {'));
  assert.ok(fixed.includes('  return c === Color.Red ? "red" : "green"'));
});

test('规则 1：字符串字面量成员 → enum（引号与值保留）', (t) => {
  const dir = makeTmp(t);
  put(dir, 'adapt/m.ets', [
    'export const Mode = {',
    "  A: 'alpha',",
    "  B: 'beta',",
    '} as const',
    'export type Mode = (typeof Mode)[keyof typeof Mode]',
    '',
  ].join('\n'));
  const report = runJson(['--src', 'adapt', '--out', 'fixed'], dir);
  assert.deepEqual(report.rules, { 'as-const-object-to-enum': 1 });
  const fixed = readFileSync(join(dir, 'fixed/m.ets'), 'utf8');
  assert.ok(fixed.includes('export enum Mode {'));
  assert.ok(fixed.includes("  A = 'alpha',"));
  assert.ok(fixed.includes("  B = 'beta',"));
});

test('规则 1：非目标不动（没有配对类型别名 / 非字面量成员 / 别名不匹配）', (t) => {
  const dir = makeTmp(t);
  const src = [
    'export const NoAlias = {',
    '  A: 0,',
    '} as const',
    '',
    'export const NonLiteral = {',
    '  A: 1 + 1,',
    '} as const',
    'export type NonLiteral = (typeof NonLiteral)[keyof typeof NonLiteral]',
    '',
    'export const WrongAlias = {',
    '  A: 0,',
    '} as const',
    'export type WrongAlias = number',
    '',
  ].join('\n');
  put(dir, 'adapt/keep.ets', src);
  const report = runJson(['--src', 'adapt', '--out', 'fixed'], dir);
  assert.deepEqual(report.rules, {});
  assert.equal(report.totals.changed, 0);
  assert.ok(report.totals.skips >= 3, '每条非目标都应记录 skip：' + report.totals.skips);
  const reasons = report.files[0].skips.map((skip) => skip.reason).join('；');
  assert.match(reasons, /没有紧跟配对/);
  assert.match(reasons, /成员不是字面量/);
  assert.match(reasons, /不是 \(typeof WrongAlias\)/);
  assert.equal(readFileSync(join(dir, 'fixed/keep.ets'), 'utf8'), src, '非目标文件必须逐字节不变');
});

test('规则 2：对象类型别名 → interface（export/非 export/单行），同名值声明或不纯时跳过', (t) => {
  const dir = makeTmp(t);
  const src = [
    'export type Value = {',
    '  unit: number',
    '  value: number',
    '}',
    '',
    'type Layout = {',
    '  left: number',
    '  top: number',
    '}',
    '',
    'export type Size = { width: number; height: number }',
    '',
    'export const Taken = 1',
    'export type Taken = { x: number }',
    '',
    'export type Union = { a: number } | null',
    '',
  ].join('\n');
  put(dir, 'adapt/types.ets', src);
  const report = runJson(['--src', 'adapt', '--out', 'fixed'], dir);
  assert.equal(report.rules['object-type-alias-to-interface'], 3);
  const fixed = readFileSync(join(dir, 'fixed/types.ets'), 'utf8');
  assert.ok(fixed.includes('export interface Value {'));
  assert.ok(fixed.includes('interface Layout {'));
  assert.ok(fixed.includes('export interface Size {\n  width: number\n  height: number\n}'));
  assert.equal(fixed.includes('export interface Taken'), false, '同名值声明必须跳过');
  assert.equal(fixed.includes('export interface Union'), false, '联合类型不是纯对象别名，必须跳过');
  assert.ok(fixed.includes('export type Taken = { x: number }'), '被跳过的别名保持原样');
  assert.ok(fixed.includes('export type Union = { a: number } | null'));
  const reasons = report.files[0].skips.map((skip) => skip.reason).join('；');
  assert.match(reasons, /同名值声明/);
  assert.match(reasons, /不是单个对象字面量/);
});

test('--no-obj-type-alias：只做规则 1', (t) => {
  const dir = makeTmp(t);
  put(dir, 'adapt/a.ets', [
    'export const Color = {',
    '  Red: 0,',
    '} as const',
    'export type Color = (typeof Color)[keyof typeof Color]',
    '',
    'export type Box = {',
    '  width: number',
    '}',
    '',
  ].join('\n'));
  const report = runJson(['--src', 'adapt', '--out', 'fixed', '--no-obj-type-alias'], dir);
  assert.deepEqual(report.rules, { 'as-const-object-to-enum': 1 });
  const fixed = readFileSync(join(dir, 'fixed/a.ets'), 'utf8');
  assert.ok(fixed.includes('export enum Color {'));
  assert.ok(fixed.includes('export type Box = {'), '规则 2 关闭时别名不动');
});

test('--dry-run：不落盘但报告命中', (t) => {
  const dir = makeTmp(t);
  put(dir, 'adapt/a.ets', ENUM_FIXTURE);
  const report = runJson(['--src', 'adapt', '--dry-run'], dir);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.rules, { 'as-const-object-to-enum': 1 });
  assert.equal(existsSync(join(dir, 'fixed')), false);
});

test('--report 与 --json 一致；确定性（两次运行逐字节相同）', (t) => {
  const dir = makeTmp(t);
  put(dir, 'adapt/sub/a.ets', ENUM_FIXTURE);
  const first = runFix(['--src', 'adapt', '--out', 'fixed1', '--json', '--report', 'r1.json'], dir);
  assert.equal(first.code, 0, first.stderr);
  const second = runFix(['--src', 'adapt', '--out', 'fixed1', '--json', '--report', 'r2.json'], dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, '同参数两次 --json 输出必须逐字节相同');
  assert.equal(readFileSync(join(dir, 'r1.json'), 'utf8'), first.stdout);
  assert.equal(readFileSync(join(dir, 'r2.json'), 'utf8'), first.stdout);
  // 不同 --out 目录只影响报告里的 out 字段，产物内容必须相同
  const third = runFix(['--src', 'adapt', '--out', 'fixed2', '--json'], dir);
  assert.equal(third.code, 0, third.stderr);
  assert.deepEqual(readTree(join(dir, 'fixed1')), readTree(join(dir, 'fixed2')));
});

test('用法错误 exit 2：缺 --src / 缺 --out / --out 位于 --src 内 / src 不存在 / 未知参数', (t) => {
  const dir = makeTmp(t);
  put(dir, 'adapt/a.ets', 'export const A = 1\n');
  const cases: string[][] = [
    [],
    ['--src', 'adapt'],
    ['--src', 'adapt', '--out', 'adapt/fixed'],
    ['--src', 'no-such-dir', '--out', 'fixed'],
    ['--bogus'],
  ];
  for (const args of cases) {
    const res = runFix(args, dir);
    assert.equal(res.code, 2, '应 exit 2：' + args.join(' '));
    assert.match(res.stderr, /arkts-fix: /);
  }
});

test('空目录 / 非 .ets 文件：成功且 0 命中', (t) => {
  const dir = makeTmp(t);
  mkdirSync(join(dir, 'adapt'), { recursive: true });
  writeFileSync(join(dir, 'adapt/readme.md'), 'not code\n', 'utf8');
  const report = runJson(['--src', 'adapt', '--out', 'fixed'], dir);
  assert.equal(report.totals.files, 0);
  assert.deepEqual(report.rules, {});
});
