import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * cli/device-test.ts 契约测试：全部用 fake hdc（Node 脚本 + JSON 行为配置），
 * 覆盖 --check / 无签名错误码 / 安装成功 / 启动失败 / 截图 / 超时 / 缺 hdc / 参数错误。
 * 真实 --check smoke 需 ARKTS_DEVICE_TEST_HDC（或 OHOS_BASE_SDK_HOME）且真机在线，否则 skip。
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const deviceTestPath = join(repoRoot, 'cli', 'device-test.ts');
const NL = String.fromCharCode(10);

interface TestHooks {
  after(fn: () => void): void;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface FakeAction {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  sleepMs?: number;
  writeLastArg?: string;
}

interface FakeHdc {
  dir: string;
  path: string;
  config: string;
  log: string;
}

const FAKE_HDC_SCRIPT = [
  '#!/usr/bin/env node',
  'const fs = require("node:fs");',
  'const argv = process.argv.slice(2);',
  'const joined = argv.join(" ");',
  'if (process.env.FAKE_HDC_LOG) {',
  '  fs.appendFileSync(process.env.FAKE_HDC_LOG, JSON.stringify({ argv, joined }) + String.fromCharCode(10));',
  '}',
  'const config = JSON.parse(fs.readFileSync(process.env.FAKE_HDC_CONFIG, "utf8"));',
  'const entries = Object.entries(config.commands || {}).sort((a, b) => b[0].length - a[0].length);',
  'for (const [key, action] of entries) {',
  '  if (!joined.includes(key)) continue;',
  '  if (action.writeLastArg !== undefined) fs.writeFileSync(argv[argv.length - 1], action.writeLastArg);',
  '  if (action.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, action.sleepMs);',
  '  if (action.stdout) process.stdout.write(action.stdout);',
  '  if (action.stderr) process.stderr.write(action.stderr);',
  '  process.exit(action.exitCode === undefined ? 0 : action.exitCode);',
  '}',
  'process.exit(0);',
  '',
].join(NL);

function makeTmp(t: TestHooks, prefix = 'arkts-device-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakeHdc(t: TestHooks): FakeHdc {
  const dir = makeTmp(t);
  const path = join(dir, 'hdc');
  writeFileSync(path, FAKE_HDC_SCRIPT, 'utf8');
  chmodSync(path, 0o755);
  const config = join(dir, 'config.json');
  const log = join(dir, 'calls.ndjson');
  writeFileSync(config, JSON.stringify({ commands: {} }), 'utf8');
  writeFileSync(log, '', 'utf8');
  // 子进程通过 env 找到行为配置与调用记录（测试按文件顺序串行执行，fake 用完即弃）
  process.env.FAKE_HDC_CONFIG = config;
  process.env.FAKE_HDC_LOG = log;
  return { dir, path, config, log };
}

function setFakeCommands(fake: FakeHdc, commands: Record<string, FakeAction>): void {
  writeFileSync(fake.config, JSON.stringify({ commands }), 'utf8');
}

function fakeCalls(fake: FakeHdc): Array<{ argv: string[]; joined: string }> {
  return readFileSync(fake.log, 'utf8').split(NL).filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { argv: string[]; joined: string });
}

function wasCalled(fake: FakeHdc, text: string): boolean {
  return fakeCalls(fake).some((call) => call.joined.includes(text));
}

function runDevice(args: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ARKTS_DEVICE_TEST_WAIT_MS: '0',
    ...env,
  };
  // 子进程不是测试文件，去掉测试上下文，避免 CLI 的测试发现守卫误判
  delete childEnv.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [deviceTestPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: childEnv,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const TARGET = '1.2.3.4:5555';

function connectedCommands(extra: Record<string, FakeAction> = {}): Record<string, FakeAction> {
  return {
    '__arkts_params__': {
      stdout: '__arkts_params__' + NL + '__model__' + NL + 'CMM-AL10 ' + NL +
        '__manufacturer__' + NL + 'HUAWEI ' + NL +
        '__osVersion__' + NL + '7.0.0 ' + NL +
        '__osVersionAlt__' + NL + 'CMM-AL10P 7.0.0.111' + NL +
        '__apiVersion__' + NL + '26 ' + NL,
    },
    'install -r': { stdout: 'install bundle successfully.' + NL },
    'aa start': { stdout: 'start ability successfully.' + NL },
    'aa dump -a': { stdout: 'bundle name [com.demo.app]' + NL },
    'bm dump -n': { stdout: 'com.demo.app:' + NL + '{}' + NL },
    'hilog -x': { stdout: HILOG_SAMPLE },
    'snapshot_display': { stdout: 'fileType: jpeg' + NL + 'snapshot: success' + NL },
    'file recv': { writeLastArg: 'FAKE_JPEG_BYTES' },
    'shell rm -f': { stdout: '' },
    'list targets': { stdout: TARGET + NL },
    'tconn': { stdout: '[Info]Target is connected, repeat operation' + NL },
    '-v': { stdout: 'Ver: 3.2.0f' + NL },
    ...extra,
  };
}

const HILOG_SAMPLE = [
  '11-10 00:00:01.000 100 100 E A0/App: boom error happened',
  '11-10 00:00:02.000 100 100 I A0/App: normal noise',
  '11-10 00:00:03.000 100 100 I A0/App: bundle com.demo.app started',
  '11-10 00:00:04.000 100 100 W A0/App: warning only',
  '',
].join(NL);

function defaultArgs(fake: FakeHdc, extra: string[] = []): string[] {
  return ['--target', TARGET, '--hdc', fake.path, '--log', join(fake.dir, 'device-test.log'), ...extra];
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

test('--check 成功：连接 + 设备信息，其余步骤 skipped，JSON 与报告一致', (t) => {
  const fake = makeFakeHdc(t);
  setFakeCommands(fake, connectedCommands());
  const reportPath = join(fake.dir, 'report.json');
  const res = runDevice(defaultArgs(fake, ['--check', '--json', '--report', reportPath]), fake.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.hdcVersion, '3.2.0f');
  assert.equal(report.check.ok, true);
  assert.equal(report.check.connected, true);
  assert.equal(report.check.model, 'CMM-AL10');
  assert.equal(report.check.apiVersion, '26');
  assert.equal(report.check.osVersion, '7.0.0');
  assert.deepEqual(report.check.targets, [TARGET]);
  for (const step of ['install', 'launch', 'hilog', 'screenshot']) {
    assert.equal(report[step].status, 'skipped', step + ' 在 --check 下应 skipped');
  }
  assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), report, '--report 与 --json 应一致');
  assert.ok(wasCalled(fake, 'tconn ' + TARGET));
  assert.ok(wasCalled(fake, 'list targets'));
  assert.equal(wasCalled(fake, 'install -r'), false, '--check 不得安装');
  assert.equal(wasCalled(fake, 'aa start'), false, '--check 不得启动');

  const human = runDevice(defaultArgs(fake, ['--check']), fake.dir);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /check\s+connected/);
  assert.match(human.stdout, /CMM-AL10/);
  assert.match(human.stdout, /结果: PASS/);
  assert.ok(human.stdout.split('\n').filter((line) => line.trim() !== '').length <= 10);
});

test('--check 设备不在线：exit 1，check.connected=false，human 给 hdc tconn 修法', (t) => {
  const fake = makeFakeHdc(t);
  setFakeCommands(fake, connectedCommands({
    'list targets': { stdout: '[Empty]' + NL },
    'tconn': { stderr: 'Connect server failed' + NL, exitCode: 1 },
  }));
  const res = runDevice(defaultArgs(fake, ['--check', '--json']), fake.dir);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.ok, false);
  assert.equal(report.check.connected, false);
  assert.match(String(report.check.hint), /hdc tconn/);
  const human = runDevice(defaultArgs(fake, ['--check']), fake.dir);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /check\s+FAILED/);
  assert.match(human.stdout, /修法: .*hdc tconn/);
});

test('--check 与其他步骤参数同用：仍只检查，不安装/不启动', (t) => {
  const fake = makeFakeHdc(t);
  setFakeCommands(fake, connectedCommands());
  const hap = join(fake.dir, 'app.hap');
  writeFileSync(hap, 'fake-hap', 'utf8');
  const res = runDevice(defaultArgs(fake, ['--check', '--install', '--hap', hap, '--bundle', 'com.demo.app', '--json']), fake.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.install.status, 'skipped');
  assert.equal(report.launch.status, 'skipped');
  assert.equal(wasCalled(fake, 'install -r'), false);
  assert.equal(wasCalled(fake, 'aa start'), false);
});

// ---------------------------------------------------------------------------
// install（错误码解析，不绕过签名）
// ---------------------------------------------------------------------------

test('安装失败：解析 9568320/9568257/9568258 并给官方修法提示，exit 1', (t) => {
  const fake = makeFakeHdc(t);
  const hap = join(fake.dir, 'app.hap');
  writeFileSync(hap, 'fake-hap', 'utf8');
  const cases: Array<[string, RegExp]> = [
    ['9568320', /未签名|签名缺失/],
    ['9568257', /AGC|profile/],
    ['9568258', /deviceTypes/],
  ];
  for (const [code, hintPattern] of cases) {
    setFakeCommands(fake, connectedCommands({
      'install -r': {
        stdout: '[Fail]Failed to install the HAP' + NL + 'Error Code: ' + code + NL,
        exitCode: 0,
      },
    }));
    const res = runDevice(defaultArgs(fake, ['--install', '--hap', hap, '--json']), fake.dir);
    assert.equal(res.code, 1, '错误码 ' + code + ' 应 exit 1：' + res.stdout + res.stderr);
    const report = JSON.parse(res.stdout) as Record<string, any>;
    assert.equal(report.install.status, 'failed');
    assert.equal(report.install.errorCode, code);
    assert.match(String(report.install.hint), hintPattern);
    assert.ok(report.install.message.includes(code));
    assert.equal(existsSync(join(fake.dir, 'device-test.log')), true);
  }

  // 无签名错误的人类输出：必须给出可操作修法，且明确不绕过签名
  setFakeCommands(fake, connectedCommands({
    'install -r': { stdout: '[Fail]no signature' + NL + 'Error Code: 9568320' + NL, exitCode: 0 },
  }));
  const human = runDevice(defaultArgs(fake, ['--install', '--hap', hap]), fake.dir);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /install\s+FAILED/);
  assert.match(human.stdout, /9568320/);
  assert.match(human.stdout, /修法: .*AGC|不尝试绕过签名/);
});

test('安装成功（install bundle successfully）+ hilog 默认只留 E/F 级，exit 0', (t) => {
  const fake = makeFakeHdc(t);
  const hap = join(fake.dir, 'app.hap');
  writeFileSync(hap, 'fake-hap', 'utf8');
  setFakeCommands(fake, connectedCommands());
  const res = runDevice(defaultArgs(fake, ['--install', '--hap', hap, '--json']), fake.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.install.status, 'installed');
  assert.equal(report.install.errorCode, null);
  assert.equal(report.hilog.status, 'collected');
  assert.equal(report.hilog.count, 1, '无 bundle 时只保留 E/F 级：' + JSON.stringify(report.hilog.lines));
  assert.match(report.hilog.lines[0], /boom error happened/);
  assert.ok(wasCalled(fake, 'install -r ' + hap));
});

test('--hilog-filter 追加匹配；有 --bundle 时同时保留 bundle 相关行', (t) => {
  const fake = makeFakeHdc(t);
  setFakeCommands(fake, connectedCommands());
  const res = runDevice(defaultArgs(fake, ['--bundle', 'com.demo.app', '--hilog-filter', 'noise', '--json']), fake.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.launch.status, 'started');
  assert.equal(report.launch.verify.running, true);
  assert.equal(report.launch.verify.installed, true);
  assert.deepEqual(report.hilog.lines.map((line: string) => line.split(': ').pop()), [
    'boom error happened',
    'normal noise',
    'bundle com.demo.app started',
  ]);
});

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

test('启动失败：aa start Error Code 10104001，exit 1，提示先安装/核对名称', (t) => {
  const fake = makeFakeHdc(t);
  setFakeCommands(fake, connectedCommands({
    'aa start': {
      stdout: 'error: failed to start ability.' + NL + 'Error Code:10104001  Error Message:The specified ability does not exist' + NL,
      exitCode: 0,
    },
    'aa dump -a': { stdout: 'no running abilities' + NL },
    'bm dump -n': { stdout: 'error: failed to get information and the parameters may be wrong.' + NL },
  }));
  const reportPath = join(fake.dir, 'report.json');
  const res = runDevice(defaultArgs(fake, ['--bundle', 'com.demo.app', '--json', '--report', reportPath]), fake.dir);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.launch.status, 'failed');
  assert.equal(report.launch.errorCode, '10104001');
  assert.match(String(report.launch.hint), /bundle\/ability|安装/);
  assert.equal(report.launch.verify.running, false);
  assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), report);

  const human = runDevice(defaultArgs(fake, ['--bundle', 'com.demo.app']), fake.dir);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /launch\s+FAILED/);
  assert.match(human.stdout, /10104001/);
});

test('启动成功：aa start 成功 + aa dump/bm dump 确认，exit 0', (t) => {
  const fake = makeFakeHdc(t);
  setFakeCommands(fake, connectedCommands());
  const res = runDevice(defaultArgs(fake, ['--bundle', 'com.demo.app', '--json']), fake.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.launch.status, 'started');
  assert.equal(report.launch.bundle, 'com.demo.app');
  assert.equal(report.launch.ability, 'EntryAbility');
  assert.deepEqual(report.launch.verify.methods, ['aa dump -a', 'bm dump -n']);
  assert.ok(wasCalled(fake, 'aa start -a EntryAbility -b com.demo.app'));
});

test('安装失败时不再尝试启动，但继续抓 hilog，exit 1', (t) => {
  const fake = makeFakeHdc(t);
  const hap = join(fake.dir, 'app.hap');
  writeFileSync(hap, 'fake-hap', 'utf8');
  setFakeCommands(fake, connectedCommands({
    'install -r': { stdout: '[Fail]no signature' + NL + 'Error Code: 9568320' + NL, exitCode: 1 },
  }));
  const res = runDevice(defaultArgs(fake, ['--install', '--hap', hap, '--bundle', 'com.demo.app', '--json']), fake.dir);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.install.status, 'failed');
  assert.equal(report.launch.status, 'skipped');
  assert.equal(report.hilog.status, 'collected');
  assert.equal(wasCalled(fake, 'aa start'), false);
});

// ---------------------------------------------------------------------------
// screenshot / 超时 / 缺 hdc / 参数
// ---------------------------------------------------------------------------

test('截图：snapshot_display + file recv 落盘，报告 bytes/remote，exit 0', (t) => {
  const fake = makeFakeHdc(t);
  setFakeCommands(fake, connectedCommands());
  const shot = join(fake.dir, 'nested', 'shot.jpeg');
  const res = runDevice(defaultArgs(fake, ['--screenshot', shot, '--json']), fake.dir);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.screenshot.status, 'captured');
  assert.equal(report.screenshot.path, shot);
  assert.match(String(report.screenshot.remote), /^\/data\/local\/tmp\/arkts-port-device-test-\d+\.jpeg$/);
  assert.equal(report.screenshot.bytes, Buffer.byteLength('FAKE_JPEG_BYTES'));
  assert.equal(statSync(shot).size, Buffer.byteLength('FAKE_JPEG_BYTES'));
  assert.ok(wasCalled(fake, 'snapshot_display -f'));
  assert.ok(wasCalled(fake, 'file recv'));
  assert.ok(wasCalled(fake, 'shell rm -f'));
});

test('超时：list targets 超时 → exit 1，commands 记录 timedOut', (t) => {
  const fake = makeFakeHdc(t);
  setFakeCommands(fake, connectedCommands({
    'list targets': { sleepMs: 5000, stdout: TARGET + NL },
  }));
  const res = runDevice(defaultArgs(fake, ['--check', '--json', '--timeout', '100']), fake.dir);
  assert.equal(res.code, 1, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.check.ok, false);
  assert.ok(report.commands.some((command: any) => command.timedOut === true));
});

test('缺 hdc：--hdc / $HDC / PATH 都找不到 → exit 2', (t) => {
  const dir = makeTmp(t);
  const explicit = runDevice(['--target', TARGET, '--check', '--hdc', join(dir, 'nope-hdc')], dir);
  assert.equal(explicit.code, 2, explicit.stdout + explicit.stderr);
  assert.match(explicit.stderr, /device-test: --hdc/);

  const envHdc = runDevice(['--target', TARGET, '--check'], dir, { HDC: join(dir, 'nope-hdc') });
  assert.equal(envHdc.code, 2, envHdc.stdout + envHdc.stderr);

  const noPath = runDevice(['--target', TARGET, '--check'], dir, {
    PATH: join(dir, 'empty-bin'),
    HDC: '',
    OHOS_BASE_SDK_HOME: '',
  });
  assert.equal(noPath.code, 2, noPath.stdout + noPath.stderr);
  assert.match(noPath.stderr, /找不到 hdc/);
});

test('参数错误：缺 target / 未知参数 / --install 无 --hap / --hap 无 --install / 坏 timeout / 坏 regex → exit 2', (t) => {
  const fake = makeFakeHdc(t);
  const dir = fake.dir;
  const hap = join(dir, 'app.hap');
  writeFileSync(hap, 'fake-hap', 'utf8');
  const cases: string[][] = [
    [],
    ['--bogus'],
    ['--target', TARGET, '--install'],
    ['--target', TARGET, '--hap', hap],
    ['--target', TARGET, '--ability', 'EntryAbility'],
    ['--target', TARGET, '--timeout', 'abc'],
    ['--target', TARGET, '--hilog-filter', '('],
    ['--target', TARGET, '--screenshot', dir],
    ['--target', TARGET, '--hdc'],
  ];
  for (const args of cases) {
    const res = runDevice(args, dir);
    assert.equal(res.code, 2, '应 exit 2：' + JSON.stringify(args) + '\n' + res.stdout + res.stderr);
    assert.match(res.stderr, /device-test: /);
  }
});

// ---------------------------------------------------------------------------
// 真实 --check smoke（无真机/无 hdc 时 skip）
// ---------------------------------------------------------------------------

test('真实 --check：192.0.2.10:40135 在线则 PASS，否则 skip', (t) => {
  const hdcEnv = process.env.ARKTS_DEVICE_TEST_HDC ?? '';
  const sdk = process.env.OHOS_BASE_SDK_HOME ?? '';
  const candidates = [hdcEnv, sdk === '' ? '' : join(sdk, '26.0.0', 'toolchains', 'hdc')].filter((path) => path !== '');
  const hdc = candidates.find((path) => existsSync(path));
  if (hdc === undefined) {
    t.skip('缺 ARKTS_DEVICE_TEST_HDC / OHOS_BASE_SDK_HOME，跳过真实设备 smoke');
    return;
  }
  const target = '192.0.2.10:40135';
  const probe = spawnSync(hdc, ['list', 'targets'], { encoding: 'utf8', timeout: 30000 });
  if (probe.status !== 0 || !(probe.stdout ?? '').includes(target)) {
    t.skip('真机 ' + target + ' 未连接，跳过真实设备 smoke');
    return;
  }
  const res = runDevice([
    '--target', target, '--check', '--hdc', hdc, '--json', '--log', join(makeTmp(t), 'check.log'),
  ], repoRoot);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const report = JSON.parse(res.stdout) as Record<string, any>;
  assert.equal(report.check.connected, true);
  assert.ok(String(report.check.model ?? '').length > 0);
  assert.ok(String(report.check.apiVersion ?? '').length > 0);
});
