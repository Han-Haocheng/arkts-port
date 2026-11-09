import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../cli/pack-context.ts');
const FENCE = String.fromCharCode(96, 96, 96);

const ALPHA_KT = [
  'package demo.alpha',
  '',
  '/** 顶层数据类：多行构造参数 + 默认值 + 字符串默认值 */',
  'data class Alpha(',
  '    val id: Int,',
  '    val label: String = "x",',
  ') : Base() {',
  '    val computed: Int',
  '        get() = id * 2',
  '',
  '    fun memberVisible(): Int = 1',
  '',
  '    fun bodyOnly() {',
  '        println("BODY_ONLY_MARKER")',
  '    }',
  '',
  '    companion object {',
  '        fun from(id: Int): Alpha = Alpha(id)',
  '    }',
  '}',
  '',
  'object AlphaUtil {',
  '    fun twice(value: Int): Int = value * 2',
  '}',
  '',
  'sealed interface Shape',
  '',
  'fun topLevel(value: Int): Int = value + 1',
  '',
  'val topValue: Int = 3',
  '',
  'private fun hiddenHelper(): Int = 0',
  '',
  'private class HiddenThing',
  '',
  'enum class Mode { A, B }',
  '',
  'interface Contract { fun run() }',
  '',
  'fun interface Sam { fun call() }',
  '',
  'typealias Alias = Alpha',
  '',
  '// F32: 浮点标记一',
  'fun risky(value: Float): Float = value',
  '',
  'class Holder {',
  '    fun memberVisible2(): Int = 2',
  '    // F32: 成员里的浮点标记',
  '    val ratio: Float = 0.5f',
  '}',
  '',
].join('\n');

const BETA_KT = [
  'package demo.beta',
  '',
  'class Beta(val value: Int)',
  '',
].join('\n');

const GAMMA_JAVA = [
  'package demo.gamma;',
  '',
  'public class Gamma {',
  '    private final int value;',
  '',
  '    public Gamma(int value) {',
  '        this.value = value;',
  '    }',
  '',
  '    public int value() {',
  '        return value;',
  '    }',
  '}',
  '',
].join('\n');

const SKIP_KT = [
  'package demo.skip',
  '',
  'class Skip',
  '',
].join('\n');

const EMPTY_KT = [
  'package demo.empty',
  '',
  '// 只有注释，没有声明',
  '',
].join('\n');

const FIXTURE_FILES: { path: string; content: string }[] = [
  { path: 'alpha/Alpha.kt', content: ALPHA_KT },
  { path: 'beta/Beta.kt', content: BETA_KT },
  { path: 'gamma/Gamma.java', content: GAMMA_JAVA },
  { path: 'empty/Empty.kt', content: EMPTY_KT },
  { path: 'skip/Skip.kt', content: SKIP_KT },
];

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface PackFileRow {
  path: string;
  loc: number;
  signatures: number;
  f32: number;
  shard: string | null;
}

interface PackReport {
  ok: boolean;
  lang: string;
  files: PackFileRow[];
  totals: {
    files: number;
    loc: number;
    bytes: number;
    estTokens: number;
    signatures: number;
    topLevelSignatures: number;
    memberSignatures: number;
    f32: number;
    sourceBytes: number;
  };
  shards: { file: string; bytes: number; files: number; oversize: boolean }[];
  excluded: { path: string; pattern: string }[];
  f32Markers: { file: string; line: number; text: string }[];
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function countLines(src: string): number {
  if (src.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  if (src.endsWith('\n')) n--;
  return n;
}

function formatNumber(value: number): string {
  const digits = String(Math.trunc(value));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

function withFixture(fn: (closureDir: string, workDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'arkts-pack-'));
  const closureDir = join(root, 'closure');
  const workDir = join(root, 'work');
  mkdirSync(closureDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  for (const file of FIXTURE_FILES) {
    const target = join(closureDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  try {
    fn(closureDir, workDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function reportOf(closureDir: string, extra: string[] = []): PackReport {
  const result = runCli(['--closure', closureDir, '--json', ...extra]);
  assert.equal(result.status, 0, 'CLI 退出码应为 0，stderr：' + result.stderr);
  return JSON.parse(result.stdout) as PackReport;
}

function readAllShards(outPath: string, report: PackReport): string[] {
  return report.shards.map((shard) => readFileSync(join(dirname(outPath), shard.file), 'utf8'));
}

test('--help：退出码 0，包含用法与退出码说明', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('用法'));
  assert.ok(result.stdout.includes('--max-bytes'));
  assert.ok(result.stdout.includes('--exclude'));
  assert.ok(result.stdout.includes('退出码'));
});

test('参数校验与退出码：用法错误 2，闭包目录不存在/不是目录 2，读取失败 1', () => {
  withFixture((closureDir) => {
    assert.equal(runCli([]).status, 2);
    assert.equal(runCli(['--json']).status, 2);
    assert.equal(runCli(['--closure', join(closureDir, 'nope')]).status, 2);
    const fileAsClosure = join(closureDir, 'alpha/Alpha.kt');
    assert.equal(runCli(['--closure', fileAsClosure]).status, 2);
    assert.equal(runCli(['--closure', closureDir, '--lang', 'dart']).status, 2);
    assert.equal(runCli(['--closure', closureDir, '--max-bytes', '0']).status, 2);
    assert.equal(runCli(['--closure', closureDir, '--max-bytes', 'abc']).status, 2);
    assert.equal(runCli(['--closure', closureDir, '--bogus']).status, 2);
    assert.equal(runCli(['--closure', closureDir, '--out', closureDir]).status, 2);
    // 需要分片但没给 --out → 2
    const shardedNoOut = runCli(['--closure', closureDir, '--max-bytes', '900', '--json']);
    assert.equal(shardedNoOut.status, 2);
    assert.ok(shardedNoOut.stderr.includes('--out'));
    // 读取失败 → 1（root 不受权限位限制，跳过）
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const unreadable = join(closureDir, 'beta/Beta.kt');
      chmodSync(unreadable, 0o000);
      const failed = runCli(['--closure', closureDir, '--json']);
      chmodSync(unreadable, 0o644);
      assert.equal(failed.status, 1, '不可读文件应退出码 1');
      assert.ok(failed.stderr.includes('读取闭包失败'));
    }
  });
});

test('文件清单与签名索引：顶层声明 + 一层成员，均不带函数体', () => {
  withFixture((closureDir, workDir) => {
    const outPath = join(workDir, 'context.md');
    const result = runCli(['--closure', closureDir, '--exclude', 'skip/Skip.kt', '--out', outPath, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as PackReport;
    const markdown = readFileSync(outPath, 'utf8');

    assert.equal(report.ok, true);
    assert.equal(report.lang, 'jvm');
    assert.deepEqual(report.files.map((file) => file.path), ['alpha/Alpha.kt', 'beta/Beta.kt', 'empty/Empty.kt', 'gamma/Gamma.java']);
    assert.deepEqual(report.excluded, [{ path: 'skip/Skip.kt', pattern: 'skip/Skip.kt' }]);
    assert.equal(report.totals.files, 4);
    assert.equal(report.totals.loc, report.files.reduce((sum, file) => sum + file.loc, 0));
    assert.equal(report.totals.loc, countLines(ALPHA_KT) + countLines(BETA_KT) + countLines(EMPTY_KT) + countLines(GAMMA_JAVA));
    // 顶层 11（Alpha）+ 1（Beta）+ 1（Gamma）= 13；成员 6（Alpha.kt）
    assert.equal(report.totals.topLevelSignatures, 13);
    assert.equal(report.totals.memberSignatures, 6);
    assert.equal(report.totals.signatures, 19);
    assert.equal(report.files.find((file) => file.path === 'alpha/Alpha.kt')!.signatures, 17);

    // 生成的 Markdown 结构
    assert.ok(markdown.startsWith('# 转写上下文包（jvm）'));
    assert.ok(markdown.includes('## 文件清单'));
    assert.ok(markdown.includes('| alpha/Alpha.kt |'));
    assert.ok(markdown.includes('## 顶层导出签名索引'));
    assert.ok(markdown.includes('data class Alpha('));
    // String 默认值不丢：渲染成 ""
    assert.ok(markdown.includes('val label: String = ""'));
    assert.ok(markdown.includes('fun interface Sam'));
    assert.ok(markdown.includes('typealias Alias = Alpha'));
    assert.ok(markdown.includes('public class Gamma'));
    assert.ok(markdown.includes('（无顶层导出签名）'));
    // 成员签名缩进 2 空格
    assert.ok(markdown.includes('\n  fun memberVisible(): Int'));
    assert.ok(markdown.includes('\n  val ratio: Float'));
    // 不带函数体：函数体标记、private 顶层声明、companion 内部成员都不出现
    assert.equal(markdown.includes('BODY_ONLY_MARKER'), false);
    assert.equal(markdown.includes('hiddenHelper'), false);
    assert.equal(markdown.includes('HiddenThing'), false);
    assert.equal(markdown.includes('fun from(id: Int)'), false);
    // 规则链接与 token 口径
    assert.ok(markdown.includes('rules/arkts-restrictions.md'));
    assert.ok(markdown.includes('adapters/jvm.md'));
    assert.ok(markdown.includes('bytes / 3.8'));
    // 自报字节数 == 实际字节数，estTokens == round(bytes / 3.8)
    const bytes = Buffer.byteLength(markdown, 'utf8');
    assert.equal(report.totals.bytes, bytes);
    assert.equal(report.totals.estTokens, Math.round(bytes / 3.8));
    assert.ok(markdown.includes('- 上下文包: ' + formatNumber(bytes) + ' 字节 ≈ ' + formatNumber(report.totals.estTokens) + ' tokens'));
    assert.ok(markdown.includes('- 源码: ' + formatNumber(report.totals.sourceBytes) + ' 字节'));
  });
});

test('F32 标记：文件:行 + 行内容，Markdown 与 JSON 一致', () => {
  withFixture((closureDir, workDir) => {
    const outPath = join(workDir, 'context.md');
    const result = runCli(['--closure', closureDir, '--out', outPath, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as PackReport;
    const markdown = readFileSync(outPath, 'utf8');

    const lines = ALPHA_KT.split('\n');
    const expected = lines
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter((entry) => /\/\/\s*F32\s*:/.test(entry.text));
    assert.equal(expected.length, 2);
    assert.deepEqual(report.f32Markers.map((marker) => ({ file: marker.file, line: marker.line, text: marker.text })), expected.map((entry) => ({ file: 'alpha/Alpha.kt', line: entry.line, text: entry.text })));
    assert.equal(report.totals.f32, 2);
    assert.ok(markdown.includes('## F32 标记（2 处）'));
    for (const entry of expected) assert.ok(markdown.includes('- alpha/Alpha.kt:' + entry.line + ': ' + entry.text));

    // 没有标记的闭包也要保留清单小节
    const cleanRoot = join(dirname(closureDir), 'clean');
    mkdirSync(cleanRoot, { recursive: true });
    writeFileSync(join(cleanRoot, 'Plain.kt'), 'package demo.plain\n\nclass Plain\n', 'utf8');
    const cleanReport = reportOf(cleanRoot);
    assert.equal(cleanReport.totals.f32, 0);
    const cleanText = runCli(['--closure', cleanRoot]).stdout;
    assert.ok(cleanText.includes('## F32 标记（0 处）'));
    assert.ok(cleanText.includes('无（闭包内没有 // F32: 标记）'));
  });
});

test('--exclude：basename / glob / 可重复，excluded 记录命中模式，分片也不含被排除文件', () => {
  withFixture((closureDir) => {
    const byGlob = reportOf(closureDir, ['--exclude', '**/skip/*.kt']);
    assert.deepEqual(byGlob.excluded, [{ path: 'skip/Skip.kt', pattern: '**/skip/*.kt' }]);
    assert.equal(byGlob.files.some((file) => file.path === 'skip/Skip.kt'), false);

    const repeated = reportOf(closureDir, ['--exclude', 'Skip.kt', '--exclude', 'Beta.kt']);
    assert.deepEqual(repeated.excluded.map((item) => item.path), ['beta/Beta.kt', 'skip/Skip.kt']);
    assert.deepEqual(repeated.files.map((file) => file.path), ['alpha/Alpha.kt', 'empty/Empty.kt', 'gamma/Gamma.java']);
  });
});

test('确定性：同输入两次逐字节相同，--out 路径不影响内容', () => {
  withFixture((closureDir, workDir) => {
    const first = join(workDir, 'a/context.md');
    const second = join(workDir, 'b/renamed-pack.md');
    const run1 = runCli(['--closure', closureDir, '--exclude', 'skip/Skip.kt', '--out', first]);
    const run2 = runCli(['--closure', closureDir, '--exclude', 'skip/Skip.kt', '--out', second]);
    assert.equal(run1.status, 0);
    assert.equal(run2.status, 0);
    const textA = readFileSync(first, 'utf8');
    const textB = readFileSync(second, 'utf8');
    assert.equal(textA, textB);

    // 同参数再跑一次，主文件逐字节相同
    const run3 = runCli(['--closure', closureDir, '--exclude', 'skip/Skip.kt', '--out', first]);
    assert.equal(run3.status, 0);
    assert.equal(readFileSync(first, 'utf8'), textA);

    // 内容里不出现绝对路径（闭包目录、输出目录）
    assert.equal(textA.includes(closureDir), false);
    assert.equal(textA.includes(workDir), false);
    assert.equal(/\/tmp\/arkts-pack-/.test(textA), false);
  });
});

test('分片：主文件索引完整，分片逐字节可拼接覆盖全部文件，总和等于 totals.bytes', () => {
  withFixture((closureDir, workDir) => {
    const outPath = join(workDir, 'context.md');
    const result = runCli(['--closure', closureDir, '--exclude', 'skip/Skip.kt', '--out', outPath, '--max-bytes', '250', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as PackReport;
    const main = readFileSync(outPath, 'utf8');

    assert.ok(report.shards.length >= 2, '小阈值应产生多个分片，实际 ' + report.shards.length);
    assert.ok(main.includes('- 打包模式: 分片'));
    assert.equal(main.includes(FENCE), false, '分片模式下主文件只给索引，不应有签名代码块');
    // 主文件索引完整：每个文件都出现在文件清单里
    for (const file of report.files) assert.ok(main.includes('| ' + file.path + ' |'), '主文件缺少 ' + file.path);
    // 每个文件都指向某个分片
    for (const file of report.files) assert.ok(file.shard !== null, '文件没有分片归属：' + file.path);
    // 分片文件命名固定、存在、大小受控
    const shardTexts: string[] = [];
    for (const shard of report.shards) {
      assert.match(shard.file, /^context-\d{3}\.md$/);
      const shardPath = join(dirname(outPath), shard.file);
      assert.ok(existsSync(shardPath), '缺少分片文件 ' + shard.file);
      const text = readFileSync(shardPath, 'utf8');
      shardTexts.push(text);
      assert.equal(Buffer.byteLength(text, 'utf8'), shard.bytes);
      assert.equal(shard.oversize, shard.files === 1 && shard.bytes > 250);
      if (!shard.oversize) assert.ok(shard.bytes <= 250, shard.file + ' 超过 --max-bytes');
    }
    // 分片拼接覆盖全部文件
    const joined = shardTexts.join('\n');
    for (const file of report.files) assert.ok(joined.includes('### ' + file.path), '分片未覆盖 ' + file.path);
    // 被排除的文件不在分片里
    assert.equal(joined.includes('skip/Skip.kt'), false);
    // 总字节数 = 主文件 + 全部分片
    const total = Buffer.byteLength(main, 'utf8') + report.shards.reduce((sum, shard) => sum + shard.bytes, 0);
    assert.equal(report.totals.bytes, total);
    assert.equal(report.totals.estTokens, Math.round(total / 3.8));
    assert.ok(main.includes('- 上下文包: ' + formatNumber(total) + ' 字节'));

    // 分片模式也确定性：换 --out 文件名/目录后，主文件与每个分片逐字节相同
    const otherDir = join(workDir, 'other');
    const otherOut = join(otherDir, 'renamed.md');
    const second = runCli(['--closure', closureDir, '--exclude', 'skip/Skip.kt', '--out', otherOut, '--max-bytes', '250', '--json']);
    assert.equal(second.status, 0, second.stderr);
    const secondReport = JSON.parse(second.stdout) as PackReport;
    assert.deepEqual(secondReport.shards, report.shards);
    assert.equal(readFileSync(otherOut, 'utf8'), main);
    for (const shard of report.shards) {
      assert.equal(readFileSync(join(otherDir, shard.file), 'utf8'), readFileSync(join(dirname(outPath), shard.file), 'utf8'));
    }
  });
});

test('--no-members：只出顶层签名', () => {
  withFixture((closureDir, workDir) => {
    const outPath = join(workDir, 'context.md');
    const result = runCli(['--closure', closureDir, '--exclude', 'skip/Skip.kt', '--out', outPath, '--no-members', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as PackReport;
    const markdown = readFileSync(outPath, 'utf8');
    assert.equal(report.totals.topLevelSignatures, 13);
    assert.equal(report.totals.memberSignatures, 0);
    assert.equal(report.totals.signatures, 13);
    assert.equal(markdown.includes('fun memberVisible'), false);
    assert.equal(markdown.includes('val ratio'), false);
    assert.ok(markdown.includes('data class Alpha('));
  });
});

test('输出模式：--json 只打 JSON；--report 与 --json 一致；人类摘要 ≤ 8 行；无 --out 时 Markdown 到 stdout', () => {
  withFixture((closureDir, workDir) => {
    const jsonOnly = runCli(['--closure', closureDir, '--json']);
    assert.equal(jsonOnly.status, 0);
    assert.equal(jsonOnly.stdout.trimStart().startsWith('{'), true);
    const parsed = JSON.parse(jsonOnly.stdout) as PackReport;
    assert.equal(parsed.ok, true);

    const reportPath = join(workDir, 'nested/report.json');
    const withReport = runCli(['--closure', closureDir, '--json', '--report', reportPath]);
    assert.equal(withReport.status, 0);
    assert.equal(readFileSync(reportPath, 'utf8'), withReport.stdout);

    const outPath = join(workDir, 'context.md');
    const human = runCli(['--closure', closureDir, '--out', outPath]);
    assert.equal(human.status, 0);
    const humanLines = human.stdout.trimEnd().split('\n');
    assert.ok(humanLines.length <= 8, '人类摘要应 ≤ 8 行，实际 ' + humanLines.length);
    assert.ok(human.stdout.includes('pack-context:'));
    assert.ok(human.stdout.includes('上下文包:'));

    const stdoutMode = runCli(['--closure', closureDir]);
    assert.equal(stdoutMode.status, 0);
    assert.ok(stdoutMode.stdout.startsWith('# 转写上下文包'));
  });
});

// ---------------------------------------------------------------- js-ts

const WEB_SRC = '/mnt/d/Project/legado-with-MD3/modules/web/src';

const JS_PACK_FILES: { path: string; content: string }[] = [
  {
    path: 'src/lib/a.ts',
    content: [
      '// F32: 浮点保真标记',
      'export const ratio = 0.5',
      '',
      'export function add(a: number, b: number): number { return a + b }',
      '',
      'export interface Shape {',
      '  area(): number',
      '}',
      '',
      "export type Mode = 'a' | 'b'",
      '',
      'export class Widget {',
      '  constructor(public size: number) {}',
      '}',
      '',
      'export default class Panel {}',
      '',
      'const internalNotExported = 1',
      '',
      'export async function load(',
      '  id: string,',
      '  options: { deep: boolean } = { deep: false },',
      '): Promise<number> {',
      '  return internalNotExported + id.length + (options.deep ? 1 : 0)',
      '}',
      '',
    ].join('\n'),
  },
  {
    path: 'src/plain.js',
    content: [
      'export const plain = 1',
      '',
      'export default function boot() {',
      '  return plain',
      '}',
      '',
    ].join('\n'),
  },
  { path: 'src/node_modules/dep/index.ts', content: 'export const vendored = 1\n' },
  { path: 'src/deep/node_modules/dep.ts', content: 'export const vendored = 2\n' },
];

function withJsPackFixture(fn: (closureDir: string, workDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'arkts-jspack-'));
  const closureDir = join(root, 'closure');
  const workDir = mkdtempSync(join(tmpdir(), 'arkts-jspack-work-'));
  mkdirSync(closureDir, { recursive: true });
  for (const file of JS_PACK_FILES) {
    const target = join(closureDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  try {
    fn(closureDir, workDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function jsPackReport(closureDir: string, extra: string[] = []): PackReport {
  const result = runCli(['--closure', closureDir, '--lang', 'js-ts', '--json', ...extra]);
  assert.equal(result.status, 0, 'js-ts pack 退出码应为 0，stderr：' + result.stderr);
  return JSON.parse(result.stdout) as PackReport;
}

test('js-ts 上下文包：export function/class/interface/type/const、默认导出、多行参数、F32、排除 node_modules', () => {
  withJsPackFixture((closureDir, workDir) => {
    const outPath = join(workDir, 'context.md');
    const result = runCli(['--closure', closureDir, '--lang', 'js-ts', '--out', outPath, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as PackReport;
    const markdown = readFileSync(outPath, 'utf8');

    assert.deepEqual(report.files.map((file) => file.path), ['src/lib/a.ts', 'src/plain.js']);
    assert.equal(report.files.some((file) => file.path.includes('node_modules')), false, 'node_modules 不应被扫描');
    assert.equal(markdown.includes('node_modules'), false);
    // a.ts：7 条顶层 + 2 条成员（Shape.area / Widget.constructor）；plain.js：2 条；非导出声明不计
    assert.equal(report.totals.signatures, 11);
    assert.equal(report.totals.topLevelSignatures, 9);
    assert.equal(report.totals.memberSignatures, 2);
    assert.equal(report.files[0].signatures, 9);
    assert.equal(report.files[1].signatures, 2);
    // 成员签名缩进 2 空格出现在 context.md
    assert.ok(markdown.includes('\n  area(): number'), 'interface 成员应出现在 context.md');
    assert.ok(markdown.includes('\n  constructor(public size: number)'), 'constructor 成员应出现在 context.md');

    // 各类导出形态
    assert.ok(markdown.includes('export const ratio'));
    assert.ok(markdown.includes('export function add(a: number, b: number): number'));
    assert.ok(markdown.includes('export interface Shape'));
    assert.ok(markdown.includes('export type Mode'));
    assert.ok(markdown.includes('export class Widget'));
    assert.ok(markdown.includes('export default class Panel'));
    // 多行参数折叠成一行、保留返回类型
    assert.ok(markdown.includes('export async function load(id: string, options: { deep: boolean } = { deep: false }): Promise<number>'));
    assert.ok(markdown.includes('export const plain'));
    assert.ok(markdown.includes('export default function boot()'));
    // 非导出声明不出现；函数体不出现
    assert.equal(markdown.includes('internalNotExported'), false);
    // fence 语言标记
    assert.ok(markdown.includes(FENCE + 'ts'));
    assert.ok(markdown.includes(FENCE + 'js'));

    // F32：文件:行 + 行内容
    assert.equal(report.totals.f32, 1);
    assert.deepEqual(report.f32Markers, [{ file: 'src/lib/a.ts', line: 1, text: '// F32: 浮点保真标记' }]);
    assert.ok(markdown.includes('## F32 标记（1 处）'));
    assert.ok(markdown.includes('- src/lib/a.ts:1: // F32: 浮点保真标记'));
    // 规则链接与 token 口径不变
    assert.ok(markdown.includes('rules/arkts-restrictions.md'));
    assert.ok(markdown.includes('adapters/jvm.md'));
    assert.ok(markdown.includes('bytes / 3.8'));
  });
});

const JS_MEMBERS_FILE = 'src/lib/members.ts';

const JS_MEMBERS_SRC = [
  'export interface Service {',
  '  name: string',
  '  retries?: number',
  '  run(input: string, options?: { deep: boolean }): Promise<string>',
  '  get status(): string',
  '}',
  '',
  'export type ServiceOptions = {',
  '  host: string',
  '  port?: number',
  '  retries: number',
  '}',
  '',
  'export class HttpService implements Service {',
  '  static readonly version = 2',
  '  private token: string',
  '  #secret = 1',
  '  readonly name: string',
  '  retries = 3',
  '  constructor(name: string, token: string, public timeout = 1000) {',
  '    this.name = name',
  '    this.token = token',
  '  }',
  '  async run(',
  '    input: string,',
  '    options?: { deep: boolean },',
  '  ): Promise<string> {',
  '    const value = this.token',
  '    return value + input',
  '  }',
  '  private reset(): void {}',
  '  protected helper(): number { return 1 }',
  '}',
  '',
  'export default class Panel {',
  '  render(): void {}',
  '}',
  '',
].join('\n');

function withJsMembersFixture(fn: (closureDir: string, workDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'arkts-jspack-members-'));
  const closureDir = join(root, 'closure');
  const workDir = mkdtempSync(join(tmpdir(), 'arkts-jspack-members-work-'));
  mkdirSync(join(closureDir, 'src/lib'), { recursive: true });
  writeFileSync(join(closureDir, JS_MEMBERS_FILE), JS_MEMBERS_SRC, 'utf8');
  try {
    fn(closureDir, workDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

test('js-ts 成员签名：class/interface/type 别名的方法、属性、constructor（不带函数体，private 排除）', () => {
  withJsMembersFixture((closureDir, workDir) => {
    const outPath = join(workDir, 'context.md');
    const result = runCli(['--closure', closureDir, '--lang', 'js-ts', '--out', outPath, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as PackReport;
    const markdown = readFileSync(outPath, 'utf8');

    // 顶层 4 条（interface / type / class / default class），成员 14 条
    assert.equal(report.totals.topLevelSignatures, 4);
    assert.equal(report.totals.memberSignatures, 14);
    assert.equal(report.totals.signatures, 18);
    assert.equal(report.files[0].signatures, 18, '--json files[].signatures 必须包含成员');

    // 方法签名（参数/返回）与多行折叠
    assert.ok(markdown.includes('export interface Service'));
    assert.ok(markdown.includes('\n  name: string'));
    assert.ok(markdown.includes('\n  retries?: number'));
    assert.ok(markdown.includes('\n  run(input: string, options?: { deep: boolean }): Promise<string>'));
    assert.ok(markdown.includes('\n  get status(): string'));
    // 对象类型别名的一层成员
    assert.ok(markdown.includes('export type ServiceOptions ='));
    assert.ok(markdown.includes('\n  host: string'));
    assert.ok(markdown.includes('\n  port?: number'));
    // class：属性 / 可选 / constructor 参数 / 多行方法折叠
    assert.ok(markdown.includes('\n  static readonly version'));
    assert.ok(markdown.includes('\n  readonly name: string'));
    assert.ok(markdown.includes('\n  retries'));
    assert.ok(markdown.includes('\n  constructor(name: string, token: string, public timeout = 1000)'));
    assert.ok(markdown.includes('\n  async run(input: string, options?: { deep: boolean }): Promise<string>'));
    assert.ok(markdown.includes('\n  protected helper(): number'));
    assert.ok(markdown.includes('\n  render(): void'));

    // 不带函数体 / 不索引初始化表达式
    assert.equal(markdown.includes('this.token'), false, '实现体不能出现在上下文包');
    assert.equal(markdown.includes('return value + input'), false, '实现体不能出现在上下文包');
    assert.equal(markdown.includes('return 1'), false, '成员函数体不能出现在上下文包');
    // private / # 成员排除
    assert.equal(markdown.includes('private token'), false);
    assert.equal(markdown.includes('#secret'), false);
    assert.equal(markdown.includes('private reset'), false);
    // 初始化表达式不漏成成员
    assert.equal(/\n  2\n/.test(markdown), false);
    assert.equal(/\n  3\n/.test(markdown), false);

    // --no-members：只出顶层
    const noMembers = runCli(['--closure', closureDir, '--lang', 'js-ts', '--no-members', '--json']);
    assert.equal(noMembers.status, 0, noMembers.stderr);
    const noMembersReport = JSON.parse(noMembers.stdout) as PackReport;
    assert.equal(noMembersReport.totals.signatures, 4);
    assert.equal(noMembersReport.totals.memberSignatures, 0);
    assert.equal(noMembersReport.files[0].signatures, 4);
  });
});

test('js-ts 上下文包：确定性 + 分片仍工作', () => {
  withJsPackFixture((closureDir, workDir) => {
    const first = runCli(['--closure', closureDir, '--lang', 'js-ts', '--json']);
    const second = runCli(['--closure', closureDir, '--lang', 'js-ts', '--json']);
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(first.stdout, second.stdout);

    const outPath = join(workDir, 'sharded.md');
    const shardRun = runCli(['--closure', closureDir, '--lang', 'js-ts', '--out', outPath, '--max-bytes', '250', '--json']);
    assert.equal(shardRun.status, 0, shardRun.stderr);
    const report = JSON.parse(shardRun.stdout) as PackReport;
    assert.ok(report.shards.length >= 2, '小阈值应产生多个分片，实际 ' + report.shards.length);
    const main = readFileSync(outPath, 'utf8');
    for (const file of report.files) assert.ok(main.includes('| ' + file.path + ' |'));
    const joined = report.shards.map((shard) => readFileSync(join(dirname(outPath), shard.file), 'utf8')).join('\n');
    for (const file of report.files) assert.ok(joined.includes('### ' + file.path), '分片未覆盖 ' + file.path);
    const total = Buffer.byteLength(main, 'utf8') + report.shards.reduce((sum, shard) => sum + shard.bytes, 0);
    assert.equal(report.totals.bytes, total);
  });
});

test('js-ts smoke：modules/web/src 真实上下文包（缺目录时跳过）', { skip: !existsSync(WEB_SRC) }, () => {
  const result = runCli(['--closure', WEB_SRC, '--lang', 'js-ts', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as PackReport;
  assert.equal(report.lang, 'js-ts');
  assert.ok(report.totals.files >= 20, '实测应扫到 20+ 文件，实际 ' + report.totals.files);
  assert.ok(report.files.some((file) => file.path === 'utils/chapterProgress.ts'));
  const chapter = report.files.find((file) => file.path === 'utils/chapterProgress.ts');
  assert.ok((chapter?.signatures ?? 0) >= 1);
  // utils.ts 里是 export const 箭头函数（多行参数）——签名必须抽到参数
  const utils = report.files.find((file) => file.path === 'utils/utils.ts');
  assert.ok((utils?.signatures ?? 0) >= 4);
  // 成员签名：真实模块里的对象类型别名（book.d.ts）与 interface（xboxGamepad.ts）
  assert.ok(report.totals.memberSignatures >= 20, '真实模块应索引出成员签名，实际 ' + report.totals.memberSignatures);
  assert.ok(report.totals.topLevelSignatures < report.totals.signatures);
  const book = report.files.find((file) => file.path === 'book.d.ts');
  assert.ok((book?.signatures ?? 0) >= 30, 'book.d.ts 的对象类型别名应带一层成员');
  const markdown = runCli(['--closure', WEB_SRC, '--lang', 'js-ts']).stdout;
  assert.ok(markdown.includes('export const paragraphAtPosition = (paragraphs: ReadonlyArray<'));
  assert.ok(markdown.includes('export const isNullOrBlank = (string: string | null | undefined | number)'));
  assert.ok(markdown.includes('\n  customCoverUrl?: string'), 'book.d.ts 的属性成员应缩进出现在 context.md');
  assert.ok(markdown.includes('\n  onToggleCatalog?: () => void'), 'xboxGamepad.ts interface 的成员应出现在 context.md');
  assert.equal(markdown.includes('node_modules'), false);
});
