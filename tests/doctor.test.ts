import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测仓库里的 cli/doctor.ts；所有用例都在临时目录里造假工程/假 SDK，不依赖真实环境。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const doctorPath = join(repoRoot, 'cli', 'doctor.ts');

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CheckRecord {
  id: string;
  title: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  fix: string | null;
  anchor: string;
}

interface ReportRecord {
  ok: boolean;
  counts: { pass: number; warn: number; fail: number };
  checks: CheckRecord[];
  inputs: Record<string, unknown>;
  env: Record<string, unknown>;
}

const SDK_SUBDIRS = ['ets', 'js', 'native', 'toolchains', 'previewer'];

/** 故意用 JSON5 语法（注释、无引号 key、单引号、尾逗号），顺带测解析器。 */
const PROFILE_JSON5 = [
  '// 假工程的 build-profile（JSON5 fixture）',
  '{',
  '  app: {',
  '    products: [',
  '      {',
  "        name: 'default',",
  "        compileSdkVersion: '26.0.0',",
  "        compatibleSdkVersion: '26.0.0',",
  "        targetSdkVersion: '26.0.0',",
  "        runtimeOS: 'OpenHarmony',",
  '      },',
  '    ],',
  "    buildModeSet: [{ name: 'debug' }, { name: 'release' },],",
  '  },',
  '  modules: [',
  "    { name: 'entry', srcPath: './entry', targets: [{ name: 'default', applyToProducts: ['default'] }] },",
  '  ],',
  '}',
  '',
].join('\n');

const MODULE_JSON5 = [
  '{',
  '  module: {',
  "    name: 'entry',",
  "    type: 'entry',",
  "    deviceTypes: ['default'],",
  '  },',
  '}',
  '',
].join('\n');

function makeTmp(t: TestHooks): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-port-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEnv(t: TestHooks) {
  const root = makeTmp(t);
  const sdk = join(root, 'sdk');
  for (const sub of SDK_SUBDIRS) mkdirSync(join(sdk, '26.0.0', sub), { recursive: true });

  const hvigor = join(root, 'hvigor');
  mkdirSync(join(hvigor, '@ohos', 'hvigor', 'bin'), { recursive: true });
  writeFileSync(join(hvigor, '@ohos', 'hvigor', 'bin', 'hvigor.js'), '\n', 'utf8');

  const project = join(root, 'project');
  mkdirSync(join(project, 'entry', 'src', 'main', 'ets', 'pages'), { recursive: true });
  mkdirSync(join(project, 'AppScope'), { recursive: true });
  writeFileSync(join(project, 'build-profile.json5'), PROFILE_JSON5, 'utf8');
  writeFileSync(join(project, 'entry', 'src', 'main', 'module.json5'), MODULE_JSON5, 'utf8');
  writeFileSync(join(project, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), '\n', 'utf8');
  writeFileSync(join(project, 'AppScope', 'app.json5'), JSON.stringify({ app: { bundleName: 'x' } }), 'utf8');

  const caseDir = join(root, 'case');
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'golden.json'), '[]', 'utf8');
  writeFileSync(join(caseDir, 'actual.json'), '[]', 'utf8');

  // 假 NODE_HOME：让 node-home 检查不依赖宿主机 /usr/bin/node
  const nodeHome = join(root, 'nodebin');
  mkdirSync(nodeHome, { recursive: true });
  writeFileSync(join(nodeHome, 'node'), '\n', 'utf8');

  return { root, sdk, hvigor, project, caseDir, nodeHome };
}

function runDoctor(
  args: string[],
  cwd: string,
  envOverride: Record<string, string> = {},
): RunResult {
  const res = spawnSync(process.execPath, [doctorPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      OHOS_BASE_SDK_HOME: '',
      HVIGOR_HOME: '',
      NODE_HOME: '',
      ...envOverride,
    },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function fullArgs(env: { sdk: string; hvigor: string; project: string; caseDir: string }): string[] {
  return ['--project', env.project, '--sdk', env.sdk, '--hvigor', env.hvigor, '--case', env.caseDir];
}

function readJson(path: string): ReportRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as ReportRecord;
}

function checkOf(report: ReportRecord, id: string): CheckRecord {
  const found = report.checks.find((check) => check.id === id);
  assert.ok(found, '报告里应有检查项：' + id);
  return found;
}

function humanLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.trim() !== '');
}

// ---------------------------------------------------------------------------
// 全 PASS / JSON / 报告字段
// ---------------------------------------------------------------------------

test('假环境下全 PASS：exit 0，人类输出 ≤15 行，最终行说明环境 OK', (t) => {
  const env = makeEnv(t);
  const res = runDoctor(fullArgs(env), env.root, { NODE_HOME: env.nodeHome });
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const lines = humanLines(res.stdout);
  assert.ok(lines.length <= 15, '人类输出应 ≤15 行，实际 ' + lines.length + ' 行');
  assert.match(lines[lines.length - 1], /^环境: OK（PASS 13 \/ WARN 0）/);
  for (const line of lines.slice(0, -1)) {
    assert.match(line, /^(PASS|WARN|FAIL)\s{2}/, '每项一行且以状态开头：' + line);
  }
  assert.doesNotMatch(res.stdout, /^FAIL/m);
});

test('--json 与 --report 输出同一份结构化报告，字段稳定', (t) => {
  const env = makeEnv(t);
  const reportPath = join(env.root, 'report.json');
  const res = runDoctor([...fullArgs(env), '--json', '--report', reportPath], env.root, {
    NODE_HOME: env.nodeHome,
  });
  assert.equal(res.code, 0, res.stdout + res.stderr);

  const fromStdout = JSON.parse(res.stdout) as ReportRecord;
  const fromFile = readJson(reportPath);
  assert.deepEqual(fromStdout, fromFile);
  assert.equal(fromFile.ok, true);
  assert.deepEqual(fromFile.counts, { pass: 13, warn: 0, fail: 0 });
  assert.deepEqual(
    fromFile.checks.map((check) => check.id),
    ['sdk', 'hvigor', 'build-profile', 'sdk-version', 'runtime-os', 'device-types',
      'ets-dir', 'entry-page', 'app-scope', 'node-home', 'env-align', 'case-golden', 'case-actual'],
  );
  for (const check of fromFile.checks) {
    assert.equal(check.status, 'PASS');
    assert.equal(typeof check.message, 'string');
    assert.equal(typeof check.anchor, 'string');
    assert.match(check.anchor, /rules\/pitfalls\.md|cases\/legado\/README\.md/);
  }
  assert.equal(fromFile.inputs.sdk, env.sdk);
});

// ---------------------------------------------------------------------------
// 人造错误：SDK / 版本号 / deviceTypes / runtimeOS / 语法
// ---------------------------------------------------------------------------

test('SDK 缺子目录：FAIL 并列出缺哪一个', (t) => {
  const env = makeEnv(t);
  rmSync(join(env.sdk, '26.0.0', 'native'), { recursive: true, force: true });
  const res = runDoctor(fullArgs(env), env.root);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /FAIL\s+sdk\s+.*缺子目录：native/);
  assert.match(res.stdout, /修法：.*26\.0\.0\/\{ets,js,native,toolchains,previewer\}/);
  assert.match(res.stdout, /rules\/pitfalls\.md#构建工具链linux-无-deveco/);
});

test('compileSdkVersion 写成数字：FAIL 且给出字符串修法', (t) => {
  const env = makeEnv(t);
  writeFileSync(
    join(env.project, 'build-profile.json5'),
    JSON.stringify({
      app: {
        products: [{
          name: 'default',
          compileSdkVersion: 26,
          compatibleSdkVersion: '26.0.0',
          targetSdkVersion: '26.0.0',
          runtimeOS: 'OpenHarmony',
        }],
      },
    }),
    'utf8',
  );
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as ReportRecord;
  const check = checkOf(report, 'sdk-version');
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /compileSdkVersion=26/);
  assert.match(String(check.fix), /"26\.0\.0"/);
  assert.match(String(check.fix), /00306042|字符串/);
});

test('deviceTypes 含 phone：FAIL 提示改成 default', (t) => {
  const env = makeEnv(t);
  writeFileSync(
    join(env.project, 'entry', 'src', 'main', 'module.json5'),
    "{ module: { name: 'entry', deviceTypes: ['phone'], }, }\n",
    'utf8',
  );
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as ReportRecord;
  const check = checkOf(report, 'device-types');
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /phone/);
  assert.match(String(check.fix), /default\/tablet\/2in1\/tv\/wearable\/liteWearable/);
});

test('deviceTypes 非法值：FAIL 列出来源模块', (t) => {
  const env = makeEnv(t);
  writeFileSync(
    join(env.project, 'entry', 'src', 'main', 'module.json5'),
    "{ module: { name: 'entry', deviceTypes: ['tablet', 'desktop'], }, }\n",
    'utf8',
  );
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const check = checkOf(JSON.parse(res.stdout) as ReportRecord, 'device-types');
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /entry=desktop/);
});

test('runtimeOS 不是 OpenHarmony：FAIL', (t) => {
  const env = makeEnv(t);
  writeFileSync(
    join(env.project, 'build-profile.json5'),
    JSON.stringify({
      app: {
        products: [{
          name: 'default',
          compileSdkVersion: '26.0.0',
          runtimeOS: 'HarmonyOS',
        }],
      },
    }),
    'utf8',
  );
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const check = checkOf(JSON.parse(res.stdout) as ReportRecord, 'runtime-os');
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /HarmonyOS/);
  assert.match(String(check.fix), /OpenHarmony/);
});

test('build-profile 语法坏掉：build-profile FAIL，依赖项降为 WARN（不重复报 FAIL）', (t) => {
  const env = makeEnv(t);
  writeFileSync(join(env.project, 'build-profile.json5'), '{ app: { products: [ }\n', 'utf8');
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as ReportRecord;
  assert.equal(checkOf(report, 'build-profile').status, 'FAIL');
  assert.equal(checkOf(report, 'sdk-version').status, 'WARN');
  assert.equal(checkOf(report, 'runtime-os').status, 'WARN');
  assert.equal(checkOf(report, 'device-types').status, 'PASS');
  assert.equal(report.counts.fail, 1);
});

// ---------------------------------------------------------------------------
// 环境变量 / case / 缺参 / 用法
// ---------------------------------------------------------------------------

test('NODE_HOME 指向不存在目录：FAIL 且修法可操作', (t) => {
  const env = makeEnv(t);
  const res = runDoctor(fullArgs(env), env.root, { NODE_HOME: '/nonexistent-node-home' });
  assert.equal(res.code, 1);
  const reportLines = res.stdout;
  assert.match(reportLines, /FAIL\s+node-home\s+.*NODE_HOME=\/nonexistent-node-home/);
  assert.match(reportLines, /修法：NODE_HOME 指向含 node 可执行文件的目录/);
});

test('--sdk 与 OHOS_BASE_SDK_HOME 不一致：WARN 且不阻塞（exit 0）', (t) => {
  const env = makeEnv(t);
  const secondSdk = join(env.root, 'sdk2');
  for (const sub of SDK_SUBDIRS) mkdirSync(join(secondSdk, '26.0.0', sub), { recursive: true });
  const res = runDoctor(
    ['--project', env.project, '--sdk', secondSdk, '--hvigor', env.hvigor, '--case', env.caseDir],
    env.root,
    { OHOS_BASE_SDK_HOME: env.sdk },
  );
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(String(runDoctor(
    ['--project', env.project, '--sdk', secondSdk, '--hvigor', env.hvigor, '--json'],
    env.root,
    { OHOS_BASE_SDK_HOME: env.sdk },
  ).stdout)) as ReportRecord;
  const check = checkOf(report, 'env-align');
  assert.equal(check.status, 'WARN');
  assert.match(check.message, /≠ OHOS_BASE_SDK_HOME=/);
  assert.equal(report.ok, true);
});

test('case 缺 golden/actual：只 WARN，不 FAIL（exit 0）', (t) => {
  const env = makeEnv(t);
  rmSync(join(env.caseDir, 'golden.json'), { force: true });
  rmSync(join(env.caseDir, 'actual.json'), { force: true });
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as ReportRecord;
  assert.equal(checkOf(report, 'case-golden').status, 'WARN');
  assert.equal(checkOf(report, 'case-actual').status, 'WARN');
  assert.equal(checkOf(report, 'case-golden').status === 'FAIL', false);
  assert.equal(report.ok, true);
  assert.equal(report.counts.fail, 0);
});

test('无参数：SDK/hvigor 记 FAIL，exit 1', (t) => {
  const env = makeEnv(t);
  const res = runDoctor([], env.root);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /FAIL\s+sdk\s+.*未提供 --sdk/);
  assert.match(res.stdout, /FAIL\s+hvigor\s+.*未提供 --hvigor/);
  assert.match(res.stdout, /环境: 有 2 项 FAIL/);
});

test('--project 指向不存在目录：工程项 FAIL/WARN，不崩', (t) => {
  const env = makeEnv(t);
  const res = runDoctor(
    ['--project', join(env.root, 'nope'), '--sdk', env.sdk, '--hvigor', env.hvigor, '--json'],
    env.root,
  );
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as ReportRecord;
  assert.equal(checkOf(report, 'build-profile').status, 'FAIL');
  assert.match(checkOf(report, 'build-profile').message, /目录不存在/);
  assert.equal(checkOf(report, 'ets-dir').status, 'WARN');
  assert.equal(checkOf(report, 'entry-page').status, 'WARN');
  assert.equal(checkOf(report, 'app-scope').status, 'WARN');
});

test('--report 单独使用也会写文件，人类输出仍只到 stdout', (t) => {
  const env = makeEnv(t);
  const reportPath = join(env.root, 'sub', 'doctor.json');
  const res = runDoctor([...fullArgs(env), '--report', reportPath], env.root);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = readJson(reportPath);
  assert.equal(report.ok, true);
  assert.equal(report.counts.pass, 13);
  assert.match(res.stdout, /^PASS/m);
});

// ---------------------------------------------------------------------------
// fail-closed：空/类型错/缺文件都必须 FAIL
// ---------------------------------------------------------------------------

test('deviceTypes 空数组 → FAIL（device type empty）', (t) => {
  const env = makeEnv(t);
  writeFileSync(
    join(env.project, 'entry', 'src', 'main', 'module.json5'),
    "{ module: { name: 'entry', deviceTypes: [], }, }\n",
    'utf8',
  );
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as ReportRecord;
  const check = checkOf(report, 'device-types');
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /为空/);
  assert.match(check.message, /device type empty/);
});

test('deviceTypes 是字符串 → FAIL 且不能说「未设置」', (t) => {
  const env = makeEnv(t);
  writeFileSync(
    join(env.project, 'entry', 'src', 'main', 'module.json5'),
    "{ module: { name: 'entry', deviceTypes: 'default', }, }\n",
    'utf8',
  );
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const check = checkOf(JSON.parse(res.stdout) as ReportRecord, 'device-types');
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /必须是数组/);
  assert.match(check.message, /string/);
  assert.doesNotMatch(check.message, /未设置/);
});

test('compileSdkVersion / compatibleSdkVersion / targetSdkVersion 空串 → FAIL', (t) => {
  const env = makeEnv(t);
  const fields = ['compileSdkVersion', 'compatibleSdkVersion', 'targetSdkVersion'];
  for (const field of fields) {
    const products = [{
      name: 'default',
      compileSdkVersion: '26.0.0',
      compatibleSdkVersion: '26.0.0',
      targetSdkVersion: '26.0.0',
      runtimeOS: 'OpenHarmony',
    }];
    (products[0] as Record<string, unknown>)[field] = '';
    writeFileSync(
      join(env.project, 'build-profile.json5'),
      JSON.stringify({ app: { products } }),
      'utf8',
    );
    const res = runDoctor([...fullArgs(env), '--json'], env.root);
    assert.equal(res.code, 1, field + ' 空串应 FAIL');
    const check = checkOf(JSON.parse(res.stdout) as ReportRecord, 'sdk-version');
    assert.equal(check.status, 'FAIL');
    assert.match(check.message, new RegExp(field + '=\\"\\"（不能为空）'));
  }
});

test('缺 entry/src/main/module.json5 → FAIL（module.json5 file not found）', (t) => {
  const env = makeEnv(t);
  rmSync(join(env.project, 'entry', 'src', 'main', 'module.json5'), { force: true });
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const check = checkOf(JSON.parse(res.stdout) as ReportRecord, 'device-types');
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /module\.json5 file not found/);
});

test('多 module：逐个检查扫描到的 module.json5，非 entry 模块违规也要 FAIL', (t) => {
  const env = makeEnv(t);
  mkdirSync(join(env.project, 'feature', 'src', 'main'), { recursive: true });
  writeFileSync(
    join(env.project, 'feature', 'src', 'main', 'module.json5'),
    "{ module: { name: 'feature', deviceTypes: ['phone'], }, }\n",
    'utf8',
  );
  const res = runDoctor([...fullArgs(env), '--json'], env.root);
  assert.equal(res.code, 1);
  const check = checkOf(JSON.parse(res.stdout) as ReportRecord, 'device-types');
  assert.equal(check.status, 'FAIL');
  assert.match(check.message, /feature=phone/);
});

// ---------------------------------------------------------------------------
// 用法错误
// ---------------------------------------------------------------------------

test('用法错误 exit 2，--help exit 0', () => {
  for (const args of [['--bogus'], ['--project'], ['--sdk'], ['--case'], ['plain-arg']]) {
    const res = runDoctor(args, repoRoot);
    assert.equal(res.code, 2, '参数应报用法错误：' + args.join(' '));
    assert.match(res.stderr, /doctor: /);
  }
  const help = runDoctor(['--help'], repoRoot);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /node cli\/doctor\.ts/);
  assert.match(help.stdout, /退出码：0 = 无 FAIL/);
});
