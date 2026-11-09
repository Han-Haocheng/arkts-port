import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * cli/explain-errors.ts 契约（backlog §5.1）：
 * - 两种输入：ArkTS 错误 JSON / hvigor 日志（ERROR 单行 + WARN 两行结构）
 * - 每条给规则 / file:line:col / 源码行 + 前后 2 行 / 修法锚点；file="?" 单列
 * - 默认只打印前 --max 条 + 按规则计数；--json/--report 全量
 * - exit 0 = 读取成功（有错也 0）；2 = 用法/文件缺失/输入不可解析
 * fixtures 全部自造，不依赖仓库外路径。
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const explainPath = join(repoRoot, 'cli', 'explain-errors.ts');

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function makeTmp(t: TestHooks, prefix = 'arkts-explain-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runExplain(args: string[], cwd: string): RunResult {
  const res = spawnSync(process.execPath, [explainPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function parseJson(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function makeJsonFixture(t: TestHooks): { dir: string; root: string; log: string } {
  const dir = makeTmp(t);
  const root = join(dir, 'root');
  writeFile(join(root, 'model', 'Alpha.ts'), [
    '// Alpha',
    '',
    'export const alpha = 1;',
    '// tail',
    '// tail2',
  ].join('\n') + '\n');
  const errors = [
    { code: 'arkts-no-as-const', file: 'parity/model/Alpha.ets', line: 3, col: 7 },
    { code: 'arkts-no-globalthis', file: '?', line: 0, col: 0 },
    { code: 'arkts-no-as-const', file: 'model/Beta.ets', line: 99, col: 1 },
  ];
  const log = join(dir, 'errors.json');
  writeFile(log, JSON.stringify(errors, null, 1));
  return { dir, root, log };
}

test('explain-errors: --help exit 0；缺 --log / 未知参数 / 文件缺失 / 坏输入 exit 2', (t) => {
  const dir = makeTmp(t);
  const help = runExplain(['--help'], dir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /explain-errors/);
  assert.match(help.stdout, /--rule/);

  for (const args of [[], ['--bogus'], ['--log'], ['--log', 'nope.json']]) {
    const res = runExplain(args, dir);
    assert.equal(res.code, 2, '应 exit 2：' + args.join(' '));
    assert.match(res.stderr, /explain-errors: /);
  }

  writeFile(join(dir, 'bad.json'), '[{"code":');
  assert.equal(runExplain(['--log', 'bad.json'], dir).code, 2, '坏 JSON 应 exit 2');

  const { log } = makeJsonFixture(t);
  assert.equal(runExplain(['--log', log, '--max', '-1'], dir).code, 2);
  assert.equal(runExplain(['--log', log, '--max', 'abc'], dir).code, 2);
  assert.equal(runExplain(['--log', log, '--root', join(dir, 'missing-root')], dir).code, 2);
});

test('explain-errors: JSON 输入 → 规则计数 / 源码片段 / file="?" 单列', (t) => {
  const { dir, root, log } = makeJsonFixture(t);
  const res = runExplain(['--log', log, '--root', root], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /ArkTS 错误 JSON/);
  assert.match(res.stdout, /共 3 条，2 个文件 \+ 1 条无位置/);
  assert.match(res.stdout, /2  arkts-no-as-const/);
  assert.match(res.stdout, /1  arkts-no-globalthis/);
  assert.match(res.stdout, /parity\/model\/Alpha\.ets:3:7/);
  assert.match(res.stdout, /源码: model\/Alpha\.ts/);
  assert.match(res.stdout, />\s+3 [|] export const alpha = 1;/);
  assert.match(res.stdout, /源码: 未在 --root 下找到/);
  assert.match(res.stdout, /无位置错误（file="\?"，共 1 条/);
  assert.match(res.stdout, /- arkts-no-globalthis/);
  assert.match(res.stdout, /── 2\/2/);
});

test('explain-errors: --max 只截断默认打印，计数保留；--rule 过滤', (t) => {
  const { dir, root, log } = makeJsonFixture(t);
  const limited = runExplain(['--log', log, '--root', root, '--max', '1'], dir);
  assert.equal(limited.code, 0);
  assert.match(limited.stdout, /共 3 条/);
  assert.match(limited.stdout, /── 1\/2/);
  assert.doesNotMatch(limited.stdout, /── 2\/2/);
  assert.match(limited.stdout, /还有 1 条未打印/);
  assert.match(limited.stdout, /无位置错误/);

  const filtered = runExplain(['--log', log, '--root', root, '--rule', 'arkts-no-as-const'], dir);
  assert.equal(filtered.code, 0);
  assert.match(filtered.stdout, /共 2 条，2 个文件/);
  assert.doesNotMatch(filtered.stdout, /无位置错误/);
  assert.match(filtered.stdout, /--rule arkts-no-as-const/);

  const none = runExplain(['--log', log, '--root', root, '--rule', 'arkts-no-nope'], dir);
  assert.equal(none.code, 0, '过滤后 0 条也是读取成功');
  assert.match(none.stdout, /共 0 条/);
  assert.match(none.stdout, /没有符合条件的错误/);
});

test('explain-errors: --json 全量结构化，--report 落盘全量', (t) => {
  const { dir, root, log } = makeJsonFixture(t);
  const jsonRun = runExplain(['--log', log, '--root', root, '--json'], dir);
  assert.equal(jsonRun.code, 0, jsonRun.stderr);
  const json = parseJson(jsonRun.stdout);
  assert.equal(json.inputType, 'json');
  assert.equal(json.total, 3);
  assert.equal(json.fileCount, 3);
  assert.equal(json.locatedFileCount, 2);
  assert.equal(json.noLocationCount, 1);
  assert.deepEqual(
    json.byRule.map((item: any) => item.rule + ':' + item.count),
    ['arkts-no-as-const:2', 'arkts-no-globalthis:1'],
  );
  assert.equal(json.errors.length, 3, '--json 不受 --max 截断');

  const first = json.errors[0];
  assert.equal(first.rule, 'arkts-no-as-const');
  assert.equal(first.file, 'parity/model/Alpha.ets');
  assert.equal(first.line, 3);
  assert.equal(first.col, 7);
  assert.equal(first.sourcePath, 'model/Alpha.ts');
  assert.equal(first.snippet.startLine, 1);
  assert.ok(first.snippet.lines.some((line: any) => line.target === true && line.line === 3));
  assert.equal(json.errors[1].file, '?');
  assert.equal(json.errors[1].snippet, null);
  assert.equal(json.errors[2].sourceMissing, true);

  const reportPath = join(dir, 'reports', 'errors.json');
  const rep = runExplain(['--log', log, '--root', root, '--max', '1', '--report', reportPath], dir);
  assert.equal(rep.code, 0);
  assert.match(rep.stdout, /还有 1 条未打印/);
  assert.ok(existsSync(reportPath));
  const report = parseJson(readFileSync(reportPath, 'utf8'));
  assert.equal(report.total, 3);
  assert.equal(report.errors.length, 3, '--report 必须写全量');
});

test('explain-errors: hvigor 日志输入（ERROR + WARN 两行结构，行首时间戳不误判 JSON）', (t) => {
  const dir = makeTmp(t);
  const root = join(dir, 'root');
  writeFile(join(root, 'entry', 'src', 'main', 'ets', 'model', 'Alpha.ts'), [
    '// one',
    '// two',
    'export const alpha = 1;',
  ].join('\n') + '\n');
  const logText = [
    '[2026-01-01T00:00:00.000] [INFO] debug-file - start',
    '\u001b[31mError Message: Object literal must correspond to some explicitly declared class or interface (arkts-no-untyped-obj-literals) At File: /tmp/arkts-probe-123/entry/src/main/ets/model/Alpha.ets:3:5\u001b[39m',
    '\u001b[33m1 WARN: \u001b[33m\u001b[33mArkTS:WARN File: /tmp/arkts-probe-123/entry/src/main/ets/model/Alpha.ets:1:2\u001b[39m\u001b[39m',
    ' "globalThis" is not supported (arkts-no-globalthis)',
  ].join('\n') + '\n';
  writeFile(join(dir, 'hvigor.log'), logText);

  const res = runExplain(['--log', 'hvigor.log', '--root', root, '--max', '5'], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /hvigor 日志/);
  assert.match(res.stdout, /共 2 条，1 个文件/);
  assert.match(res.stdout, /\[ERROR\]/);
  assert.match(res.stdout, /\[WARN\]/);
  assert.match(res.stdout, /源码: entry\/src\/main\/ets\/model\/Alpha\.ts/);
  assert.match(res.stdout, />\s+3 [|] export const alpha = 1;/);

  const jsonRun = runExplain(['--log', 'hvigor.log', '--root', root, '--json'], dir);
  assert.equal(jsonRun.code, 0);
  const json = parseJson(jsonRun.stdout);
  assert.equal(json.inputType, 'log');
  assert.equal(json.total, 2);
  assert.deepEqual(json.errors.map((error: any) => error.level), ['ERROR', 'WARN']);
  assert.equal(json.errors[0].rule, 'arkts-no-untyped-obj-literals');
  assert.equal(json.errors[0].line, 3);
  assert.equal(json.errors[1].rule, 'arkts-no-globalthis');
  assert.equal(json.errors[1].line, 1);
});
