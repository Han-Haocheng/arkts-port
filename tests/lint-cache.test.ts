import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * task-17：lint-arkts 缓存 fail-open 回归。
 * hvigor 增量构建第二次会 UP-TO-DATE、不再输出 ArkTS 诊断，造成「第一次 FAIL、第二次 PASS」。
 * 默认行为必须是构建前清理 .hvigor/cache 与各模块 build；--no-clean 才允许依赖缓存。
 * 用假 hvigor 精确控制「缓存标记」，真实 SDK 用例需 ARKTS_LINT_REAL_* 环境变量，否则 skip。
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lintPath = join(repoRoot, 'cli', 'lint-arkts.ts');

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Env {
  dir: string;
  project: string;
  sdk: string;
  hvigor: string;
}

function makeTmp(t: TestHooks, prefix = 'arkts-lint-cache-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEnv(t: TestHooks): Env {
  const dir = makeTmp(t);
  const project = join(dir, 'project');
  mkdirSync(join(project, 'entry', 'src', 'main', 'ets', 'pages'), { recursive: true });
  writeFileSync(
    join(project, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'),
    'export const index = 1;\n',
    'utf8',
  );
  const sdk = join(dir, 'sdk');
  mkdirSync(join(sdk, '26.0.0', 'ets'), { recursive: true });
  const hvigor = join(dir, 'hvigor');
  mkdirSync(join(hvigor, '@ohos', 'hvigor', 'bin'), { recursive: true });
  return { dir, project, sdk, hvigor };
}

function hvigorJs(env: Env): string {
  return join(env.hvigor, '@ohos', 'hvigor', 'bin', 'hvigor.js');
}

function writeHvigor(env: Env, lines: string[]): void {
  writeFileSync(hvigorJs(env), lines.join('\n') + '\n', 'utf8');
}

function runLint(env: Env, extra: string[] = []): RunResult {
  const res = spawnSync(
    process.execPath,
    [lintPath, '--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor, ...extra],
    { cwd: env.dir, encoding: 'utf8', timeout: 120000 },
  );
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** 假 hvigor 只做两件事：记录构建前 sentinel 是否还在；输出 BUILD SUCCESSFUL。 */
function writeSentinelHvigor(env: Env): void {
  const probePath = join(env.dir, 'probe.json');
  writeHvigor(env, [
    "const { existsSync, writeFileSync } = require('node:fs');",
    "const path = require('node:path');",
    'const project = ' + JSON.stringify(env.project) + ';',
    'writeFileSync(' + JSON.stringify(probePath) + ', JSON.stringify({',
    "  entryBuild: existsSync(path.join(project, 'entry', 'build', 'sentinel.txt')),",
    "  hvigorCache: existsSync(path.join(project, '.hvigor', 'cache', 'sentinel.txt')),",
    '}));',
    "process.stdout.write('BUILD SUCCESSFUL in 1 ms\\n');",
    'process.exit(0);',
  ]);
}

/**
 * 假 hvigor 模拟 hvigor 增量：
 * - 有 entry/build/compiled.marker → 只输出 UP-TO-DATE（无 ArkTS 诊断）；
 * - 没有 marker → 输出 WARN 级 globalThis 并创建 marker。
 * 默认 clean 会删掉 marker，所以连续两次都会走「首次编译」→ 都 FAIL。
 */
function writeIncrementalHvigor(env: Env): void {
  writeHvigor(env, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const project = ' + JSON.stringify(env.project) + ';',
    "const marker = path.join(project, 'entry', 'build', 'compiled.marker');",
    'if (fs.existsSync(marker)) {',
    "  process.stdout.write('> hvigor UP-TO-DATE :entry:default@CompileArkTS...\\nBUILD SUCCESSFUL in 1 ms\\n');",
    '  process.exit(0);',
    '}',
    'fs.mkdirSync(path.dirname(marker), { recursive: true });',
    "fs.writeFileSync(marker, '1');",
    "process.stdout.write('\\u001b[33m1 WARN: \\u001b[33m\\u001b[33mArkTS:WARN File: ' + project + '/entry/src/main/ets/pages/Index.ets:1:1\\n \"globalThis\" is not supported (arkts-no-globalthis)\\n\\u001b[39m\\u001b[39m\\nBUILD SUCCESSFUL in 1 ms\\n');",
    'process.exit(0);',
  ]);
}

test('lint-arkts: 默认构建前清理 .hvigor/cache 与模块 build；--no-clean 才保留', (t) => {
  const env = makeEnv(t);
  writeSentinelHvigor(env);
  const entrySentinel = join(env.project, 'entry', 'build', 'sentinel.txt');
  const cacheSentinel = join(env.project, '.hvigor', 'cache', 'sentinel.txt');
  const plant = (): void => {
    mkdirSync(join(env.project, 'entry', 'build'), { recursive: true });
    mkdirSync(join(env.project, '.hvigor', 'cache'), { recursive: true });
    writeFileSync(entrySentinel, '1', 'utf8');
    writeFileSync(cacheSentinel, '1', 'utf8');
  };
  const probe = (): Record<string, boolean> =>
    JSON.parse(readFileSync(join(env.dir, 'probe.json'), 'utf8')) as Record<string, boolean>;

  plant();
  const first = runLint(env, ['--json']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const json = JSON.parse(first.stdout) as Record<string, any>;
  assert.equal(json.clean, true);
  assert.equal(json.arktsErrors, 0);
  assert.ok(Array.isArray(json.cleanPaths), 'JSON 必须暴露 cleanPaths');
  assert.ok(
    json.cleanPaths.some((cleanPath: string) => basename(cleanPath) === 'build'),
    'cleanPaths 应包含模块 build 目录',
  );
  assert.ok(
    json.cleanPaths.some((cleanPath: string) => basename(cleanPath) === 'cache'),
    'cleanPaths 应包含 .hvigor/cache',
  );
  assert.equal(probe().entryBuild, false, '构建前 entry/build 必须已清');
  assert.equal(probe().hvigorCache, false, '构建前 .hvigor/cache 必须已清');

  plant();
  const second = runLint(env, ['--no-clean']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stderr, /--no-clean/);
  const json2 = JSON.parse(runLint(env, ['--json', '--no-clean']).stdout) as Record<string, any>;
  assert.equal(json2.clean, false);
  assert.equal(probe().entryBuild, true, '--no-clean 时 sentinel 必须保留');
  assert.equal(probe().hvigorCache, true, '--no-clean 时 sentinel 必须保留');
});

test('lint-arkts: 缓存型工程连续两次默认都 FAIL；--no-clean 复现第二次假 PASS（对照）', (t) => {
  const env = makeEnv(t);
  writeIncrementalHvigor(env);
  const first = runLint(env);
  const second = runLint(env);
  const results: Array<[string, RunResult]> = [['1st', first], ['2nd', second]];
  for (const [label, res] of results) {
    assert.equal(res.code, 1, label + ' 必须 FAIL（不能 UP-TO-DATE 假 PASS）：' + res.stdout);
    assert.match(res.stdout, /ArkTS 错误数: 1/);
    assert.match(res.stdout, /其中 WARN 级: 1/);
    assert.match(res.stdout, /门禁: FAIL/);
  }

  // 对照组：显式 --no-clean 时第二次仍会走 UP-TO-DATE → 假 PASS；证明默认 clean 是必要的
  const noCleanEnv = makeEnv(t);
  writeIncrementalHvigor(noCleanEnv);
  const a = runLint(noCleanEnv, ['--no-clean']);
  const b = runLint(noCleanEnv, ['--no-clean']);
  assert.equal(a.code, 1, '--no-clean 第一次仍应 FAIL');
  assert.match(a.stdout, /ArkTS 错误数: 1/);
  assert.equal(b.code, 0, '--no-clean 第二次应复现假 PASS（对照组）');
  assert.match(b.stdout, /ArkTS 错误数: 0/);
});

test('lint-arkts: 真实 hvigor 连续两次都 FAIL（缺 ARKTS_LINT_REAL_* 时 skip）', (t) => {
  const projectRaw = process.env.ARKTS_LINT_REAL_PROJECT ?? '';
  const sdkRaw = process.env.ARKTS_LINT_REAL_SDK ?? '';
  const hvigorRaw = process.env.ARKTS_LINT_REAL_HVIGOR ?? '';
  if (projectRaw === '' || sdkRaw === '' || hvigorRaw === '') {
    t.skip('缺 ARKTS_LINT_REAL_PROJECT / ARKTS_LINT_REAL_SDK / ARKTS_LINT_REAL_HVIGOR');
    return;
  }
  const project = resolve(projectRaw);
  const sdk = resolve(sdkRaw);
  const hvigor = resolve(hvigorRaw);
  if (
    !existsSync(project) ||
    !existsSync(join(sdk, '26.0.0', 'ets')) ||
    !existsSync(join(hvigor, '@ohos', 'hvigor', 'bin', 'hvigor.js'))
  ) {
    t.skip('真实工程/SDK/hvigor 路径不存在');
    return;
  }
  const dir = makeTmp(t, 'arkts-lint-real-');
  const copy = join(dir, 'project');
  cpSync(project, copy, {
    recursive: true,
    filter: (src) => !['build', '.hvigor', 'node_modules', 'oh_modules', '.git'].includes(basename(src)),
  });
  const indexPath = join(copy, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');
  if (!existsSync(indexPath)) {
    t.skip('参考工程没有 entry/src/main/ets/pages/Index.ets');
    return;
  }
  writeFileSync(
    indexPath,
    readFileSync(indexPath, 'utf8') + '\nexport const LINT_CACHE_TEST_PROBE = globalThis;\n',
    'utf8',
  );
  const env: Env = { dir, project: copy, sdk, hvigor };
  const first = runLint(env);
  const second = runLint(env);
  assert.equal(first.code, 1, '真实 hvigor 第一次应 FAIL：' + first.stdout);
  assert.equal(second.code, 1, '真实 hvigor 第二次也必须 FAIL：' + second.stdout);
  assert.match(first.stdout, /arkts-no-globalthis/);
  assert.match(second.stdout, /arkts-no-globalthis/);
});
