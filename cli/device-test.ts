#!/usr/bin/env node
/**
 * 真机操作链工具：device check → install（可选）→ launch → hilog → screenshot → JSON 报告。
 *
 * 用法：
 *   node cli/device-test.ts --target <ip:port> [--check]
 *        [--hap <path> --install] [--bundle <name>] [--ability EntryAbility]
 *        [--screenshot <path>] [--hilog-filter <regex>]
 *        [--json] [--report <path>] [--log <path>] [--timeout <ms>] [--hdc <path>]
 *
 * hdc 定位顺序：--hdc > $HDC > $OHOS_BASE_SDK_HOME/<version>/toolchains/hdc > PATH。
 * --check 只验证连接与系统信息（不安装、不启动）；exit 0/1/2。
 *
 * 签名说明：本工具只如实报告 hdc 的安装错误码并给官方修法提示，不尝试绕过签名。
 *   9568320 = HAP 未签名/签名缺失
 *   9568257 = profile/签名链不被真机信任（HarmonyOS 真机只认 Huawei AGC 调试 profile）
 *   9568258 = profile 的 deviceTypes 与真机不匹配
 *
 * 退出码：0 = 所有请求的步骤成功；1 = 设备/安装/启动/截图等任一失败或超时；2 = 用法/前置缺失。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const SDK_VERSION = '26.0.0';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_LAUNCH_WAIT_MS = 1500;
const HILOG_MAX_LINES = 100;
const REMOTE_SCREENSHOT_DIR = '/data/local/tmp';

const USAGE = [
  '用法：',
  '  node cli/device-test.ts --target <ip:port> [--check]',
  '       [--hap <path> --install] [--bundle <name>] [--ability EntryAbility]',
  '       [--screenshot <path>] [--hilog-filter <regex>]',
  '       [--json] [--report <path>] [--log <path>] [--timeout <ms>] [--hdc <path>]',
  '',
  '一条命令完成：device check → install（可选）→ launch → hilog → screenshot → JSON 报告。',
  '',
  '参数：',
  '  --target <ip:port>   真机地址（hdc tconn 用；必填）',
  '  --check              只检查连接与系统信息（不安装、不启动），exit 0/1',
  '  --hap <path>         要安装的 .hap（必须与 --install 一起用）',
  '  --install            执行 hdc install -r <hap>；失败解析错误码并给官方修法，不绕过签名',
  '  --bundle <name>      启动的 bundleName（给了才 launch）',
  '  --ability <name>     启动的 abilityName（默认 EntryAbility）',
  '  --screenshot <path>  截图保存到本地路径（snapshot_display + file recv）',
  '  --hilog-filter <re>  在内置过滤（bundle/ability/error/exception）之外追加正则',
  '  --json               stdout 只输出结构化 JSON',
  '  --report <path>      把同一份 JSON 写到文件',
  '  --log <path>         命令日志路径（默认 <cwd>/out/logs/device-test.log）',
  '  --timeout <ms>       单条 hdc 命令超时（默认 60000；0 = 不超时）',
  '  --hdc <path>         hdc 可执行文件（默认 $HDC > SDK toolchains > PATH）',
  '  --help, -h           显示本帮助',
  '',
  '退出码：0 = 所有请求步骤成功；1 = 任一失败/超时；2 = 用法/前置缺失（含找不到 hdc）',
].join('\n');

const VALUE_OPTS = new Set([
  'target', 'hap', 'bundle', 'ability', 'screenshot', 'hilog-filter',
  'report', 'log', 'timeout', 'hdc',
]);
const BOOL_OPTS = new Set(['install', 'check', 'json', 'help']);

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

interface RawCli {
  [key: string]: string | boolean;
}

interface CommandResult {
  argv: string[];
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  spawnError: string | null;
}

interface Ctx {
  cwd: string;
  target: string;
  hdc: string;
  timeoutMs: number;
  commands: CommandResult[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failUsage(message: string): never {
  console.error('device-test: ' + message);
  console.error('用法见：node cli/device-test.ts --help');
  process.exit(EXIT_USAGE);
}

function parseCliArgs(argv: string[]): RawCli {
  const raw: RawCli = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') { raw.help = true; continue; }
    if (!token.startsWith('--')) failUsage('无法识别的参数：' + token);
    const eq = token.indexOf('=');
    if (eq > 2) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
      if (value === '') failUsage('参数 --' + key + ' 不能为空');
      raw[key] = value;
      continue;
    }
    const key = token.slice(2);
    if (BOOL_OPTS.has(key)) { raw[key] = true; continue; }
    if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) failUsage('参数 --' + key + ' 缺少取值');
    raw[key] = next;
    i++;
  }
  return raw;
}

function optional(raw: RawCli, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' ? value : null;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function oneLine(text: string, max = 240): string {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function relPath(cwd: string, path: string): string {
  const rel = path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path;
  return rel;
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  const flag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(flag, 0, 0, ms);
}

// ---------------------------------------------------------------------------
// hdc 定位与执行
// ---------------------------------------------------------------------------

function resolveHdcPath(raw: RawCli, cwd: string): string {
  const explicit = optional(raw, 'hdc') ?? process.env.HDC ?? '';
  if (explicit !== '') {
    const absolute = resolve(cwd, explicit);
    if (!isFile(absolute)) failUsage('--hdc / $HDC 指向的文件不存在：' + explicit);
    return absolute;
  }
  const sdkHome = process.env.OHOS_BASE_SDK_HOME ?? '';
  if (sdkHome !== '') {
    const sdkRoot = resolve(cwd, sdkHome);
    const fixed = join(sdkRoot, SDK_VERSION, 'toolchains', 'hdc');
    if (isFile(fixed)) return fixed;
    const candidates: string[] = [];
    try {
      for (const entry of readdirSync(sdkRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(sdkRoot, entry.name, 'toolchains', 'hdc'));
      }
    } catch {
      // SDK 目录不可读时退回 PATH
    }
    candidates.sort().reverse();
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
  }
  return 'hdc';
}

function runCommand(ctx: Ctx, argv: string[], timeoutOverride?: number): CommandResult {
  const startedAt = Date.now();
  const timeoutMs = timeoutOverride === undefined ? ctx.timeoutMs : timeoutOverride;
  const res = spawnSync(ctx.hdc, argv, {
    cwd: ctx.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - startedAt;
  let spawnError: string | null = null;
  let timedOut = false;
  if (res.error) {
    const error = res.error as { code?: string; message?: string };
    timedOut = error.code === 'ETIMEDOUT';
    spawnError = timedOut
      ? '超时（--timeout ' + timeoutMs + 'ms）'
      : (error.code === 'ENOENT' ? '找不到 hdc 可执行文件：' + ctx.hdc : (error.message ?? String(res.error)));
  }
  const command = 'hdc ' + argv.map(quoteArg).join(' ');
  const result: CommandResult = {
    argv,
    command,
    exitCode: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    durationMs,
    timedOut,
    spawnError,
  };
  ctx.commands.push(result);
  return result;
}

/** 带 -t <target> 的 hdc 命令 */
function runTargeted(ctx: Ctx, argv: string[], timeoutOverride?: number): CommandResult {
  return runCommand(ctx, ['-t', ctx.target, ...argv], timeoutOverride);
}

function outputOf(result: CommandResult): string {
  return (result.stdout ?? '') + (result.stderr ?? '');
}

// ---------------------------------------------------------------------------
// device check
// ---------------------------------------------------------------------------

interface CheckResult {
  ok: boolean;
  connected: boolean;
  targets: string[];
  hdcVersion: string | null;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  apiVersion: string | null;
  message: string;
  hint: string | null;
}

function readParam(ctx: Ctx, key: string): string | null {
  const result = runTargeted(ctx, ['shell', 'param', 'get', key]);
  const text = outputOf(result).trim();
  if (text === '' || /^Get parameter .* fail/i.test(text) || /errNum is:/i.test(text)) return null;
  return text.split('\n')[0].trim() || null;
}

interface DeviceParams {
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  apiVersion: string | null;
}

const PARAM_KEYS: Array<[string, string]> = [
  ['model', 'const.product.model'],
  ['manufacturer', 'const.product.manufacturer'],
  ['osVersion', 'const.product.os.dist.version'],
  ['osVersionAlt', 'const.product.software.version'],
  ['apiVersion', 'const.ohos.apiversion'],
];

/** 一次 hdc shell 批量取 5 个参数（单次 hdc 的 TCP 固定开销约 1.4s，5 次调用会很慢） */
function readDeviceParams(ctx: Ctx): DeviceParams {
  const script = ['echo __arkts_params__']
    .concat(PARAM_KEYS.flatMap(([tag, key]) => ['echo __' + tag + '__', 'param get ' + key]))
    .join('; ');
  const result = runTargeted(ctx, ['shell', script]);
  const values: Record<string, string | null> = {};
  for (const [tag] of PARAM_KEYS) values[tag] = null;
  let current: string | null = null;
  for (const rawLine of outputOf(result).split('\n')) {
    const line = rawLine.trim();
    const marker = /^__([A-Za-z]+)__$/.exec(line);
    if (marker !== null) { current = marker[1]; continue; }
    if (current === null || line === '' || values[current] !== null) continue;
    if (/^Get parameter .* fail/i.test(line) || /errNum is:/i.test(line)) { current = null; continue; }
    values[current] = line;
    current = null;
  }
  const batchFailed = result.timedOut || result.spawnError !== null ||
    !outputOf(result).includes('__arkts_params__');
  if (batchFailed) {
    // 批量 shell 不可用时退回逐条读取（更慢但兼容旧设备）
    return {
      model: readParam(ctx, 'const.product.model'),
      manufacturer: readParam(ctx, 'const.product.manufacturer'),
      osVersion: readParam(ctx, 'const.product.os.dist.version') ??
        readParam(ctx, 'const.product.software.version'),
      apiVersion: readParam(ctx, 'const.ohos.apiversion'),
    };
  }
  return {
    model: values.model,
    manufacturer: values.manufacturer,
    osVersion: values.osVersion ?? values.osVersionAlt,
    apiVersion: values.apiVersion,
  };
}

function checkDevice(ctx: Ctx): CheckResult {
  const version = runCommand(ctx, ['-v']);
  if (version.spawnError !== null && /找不到 hdc/.test(version.spawnError)) {
    failUsage(version.spawnError);
  }
  if (version.timedOut || version.spawnError !== null) {
    return {
      ok: false, connected: false, targets: [], hdcVersion: null,
      model: null, manufacturer: null, osVersion: null, apiVersion: null,
      message: 'hdc 不可用：' + (version.spawnError ?? 'hdc -v 超时'),
      hint: '检查 --hdc/$HDC/SDK toolchains/hdc 是否可执行，或 hdc 服务是否被占用',
    };
  }
  const versionMatch = /Ver:\s*(\S+)/.exec(version.stdout + version.stderr);
  const hdcVersion = versionMatch ? versionMatch[1] : null;

  runCommand(ctx, ['tconn', ctx.target]);
  const list = runCommand(ctx, ['list', 'targets']);
  const targets = list.stdout.split('\n').map((line) => line.trim())
    .filter((line) => line !== '' && !/^\[Empty\]$/.test(line));
  const connected = targets.includes(ctx.target);
  if (!connected) {
    const hint = /\bempty\b|\[Empty\]/i.test(outputOf(list))
      ? '设备没有出现在 hdc list targets：检查数据线/网络、开启「USB 调试/无线调试」，再手动 hdc tconn ' + ctx.target
      : 'hdc list targets 里没有目标设备：先 hdc tconn ' + ctx.target + '，或确认 hdc 与设备版本匹配';
    return {
      ok: false, connected: false, targets, hdcVersion,
      model: null, manufacturer: null, osVersion: null, apiVersion: null,
      message: '设备未连接：' + ctx.target, hint,
    };
  }

  const params = readDeviceParams(ctx);
  return {
    ok: true, connected: true, targets, hdcVersion,
    model: params.model, manufacturer: params.manufacturer,
    osVersion: params.osVersion, apiVersion: params.apiVersion,
    message: '已连接 ' + ctx.target, hint: null,
  };
}

// ---------------------------------------------------------------------------
// install（只解析错误码并给官方修法，不绕过签名）
// ---------------------------------------------------------------------------

interface InstallHint {
  title: string;
  hint: string;
}

const INSTALL_CODE_HINTS: Record<string, InstallHint> = {
  '9568320': {
    title: 'HAP 未签名或签名缺失',
    hint: 'HAP 未签名/签名缺失：用 Huawei AGC 调试证书 + provisioning profile 签名后再装；本工具不尝试绕过签名。见 rules/pitfalls.md',
  },
  '9568257': {
    title: 'profile/签名链不被真机信任',
    hint: 'HarmonyOS 真机只接受 Huawei AGC 签发的调试 profile（OpenHarmony 自签通常会报 9568257）；在 AGC 创建/下载 profile 并绑定设备 UDID 后重签',
  },
  '9568258': {
    title: 'profile 的 deviceTypes 与真机不匹配',
    hint: '检查 AGC profile 与 build-profile.json5 的 deviceTypes（合法值如 phone/tablet；不能用已废弃的 phone 写法），见 rules/pitfalls.md',
  },
};

function parseInstallErrorCode(text: string): string | null {
  const known = /\b(9568\d{3})\b/.exec(text);
  if (known) return known[1];
  const labeled = /(?:error code|Error Code|errorCode|code)\s*[:：=]?\s*(\d{5,})/i.exec(text);
  return labeled ? labeled[1] : null;
}

interface InstallResult {
  status: 'installed' | 'failed' | 'skipped';
  hap: string | null;
  exitCode: number | null;
  errorCode: string | null;
  message: string;
  hint: string | null;
  outputTail: string;
}

function installHap(ctx: Ctx, hapAbs: string): InstallResult {
  const result = runTargeted(ctx, ['install', '-r', hapAbs]);
  const text = outputOf(result);
  const success = /install bundle successfully|successfully installed|install success/i.test(text);
  const errorCode = parseInstallErrorCode(text);
  const failedText = /\[Fail\]|\bfail(ed)?\b|\berror\b/i.test(text);
  const outputTail = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    .slice(-5).join('\n');

  if (result.timedOut || result.spawnError !== null) {
    return {
      status: 'failed', hap: hapAbs, exitCode: result.exitCode, errorCode,
      message: result.spawnError ?? '安装超时', hint: null, outputTail,
    };
  }
  if (success && errorCode === null) {
    return {
      status: 'installed', hap: hapAbs, exitCode: result.exitCode, errorCode: null,
      message: 'install bundle successfully', hint: null, outputTail,
    };
  }
  const hintInfo = errorCode === null ? null : INSTALL_CODE_HINTS[errorCode] ?? null;
  const hint = hintInfo !== null
    ? hintInfo.hint
    : '安装失败：看日志里的 hdc 输出；签名/权限类错误需走官方签名与设备授权流程（不尝试绕过）';
  const message = errorCode !== null
    ? 'hdc install 失败（code ' + errorCode + (hintInfo ? '：' + hintInfo.title : '') + '）'
    : (failedText ? 'hdc install 输出含失败信息' : '无法确认安装结果（无成功/失败标记）');
  return {
    status: 'failed', hap: hapAbs, exitCode: result.exitCode, errorCode,
    message, hint, outputTail,
  };
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

interface LaunchResult {
  status: 'started' | 'failed' | 'skipped';
  bundle: string | null;
  ability: string | null;
  exitCode: number | null;
  errorCode: string | null;
  message: string;
  hint: string | null;
  verify: {
    aaStartOk: boolean;
    running: boolean;
    installed: boolean;
    methods: string[];
  };
  outputTail: string;
}

function launchAbility(ctx: Ctx, bundle: string, ability: string): LaunchResult {
  const start = runTargeted(ctx, ['shell', 'aa', 'start', '-a', ability, '-b', bundle]);
  const startText = outputOf(start);
  const startErrorCode = /Error Code:\s*(\d+)/i.exec(startText);
  const aaStartOk = startErrorCode === null && /start ability successfully|successfully/i.test(startText) &&
    !/\berror\b/i.test(startText);

  const waitMsRaw = Number(process.env.ARKTS_DEVICE_TEST_WAIT_MS ?? DEFAULT_LAUNCH_WAIT_MS);
  const waitMs = Number.isInteger(waitMsRaw) && waitMsRaw >= 0 ? waitMsRaw : DEFAULT_LAUNCH_WAIT_MS;
  sleepMs(waitMs);

  const aaDump = runTargeted(ctx, ['shell', 'aa', 'dump', '-a']);
  const running = outputOf(aaDump).includes('bundle name [' + bundle + ']') ||
    outputOf(aaDump).includes('bundle name <' + bundle + '>');
  const bmDump = runTargeted(ctx, ['shell', 'bm', 'dump', '-n', bundle]);
  const bmText = outputOf(bmDump);
  const installed = !/^\s*error:/im.test(bmText) && bmText.includes(bundle);

  const methods: string[] = [];
  if (running) methods.push('aa dump -a');
  if (installed) methods.push('bm dump -n');
  const ok = startErrorCode === null && (aaStartOk || running);
  const outputTail = startText.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    .slice(-5).join('\n');
  if (ok && (running || installed)) {
    return {
      status: 'started', bundle, ability, exitCode: start.exitCode, errorCode: null,
      message: 'aa start 成功' + (methods.length > 0 ? '（' + methods.join(' + ') + ' 已确认）' : ''),
      hint: null, verify: { aaStartOk, running, installed, methods }, outputTail,
    };
  }
  if (ok) {
    return {
      status: 'failed', bundle, ability, exitCode: start.exitCode, errorCode: null,
      message: 'aa start 返回成功，但 aa dump/bm dump 未确认到该 bundle（可能启动即崩溃）',
      hint: '用 --screenshot 与 hilog 看现场；确认 bundleName/abilityName 与已安装 HAP 一致',
      verify: { aaStartOk, running, installed, methods }, outputTail,
    };
  }
  const hint = startErrorCode !== null && startErrorCode[1] === '10104001'
    ? 'bundle/ability 不存在或未安装：确认名称，并先 device-test --install 装 HAP。'
    : '启动失败：检查 HAP 是否已安装、bundle/ability 名称与 module.json5 一致；必要时看 hilog。';
  return {
    status: 'failed', bundle, ability, exitCode: start.exitCode,
    errorCode: startErrorCode ? startErrorCode[1] : null,
    message: startErrorCode !== null
      ? 'aa start 失败（Error Code ' + startErrorCode[1] + '）'
      : 'aa start 未返回成功标记',
    hint, verify: { aaStartOk, running, installed, methods }, outputTail,
  };
}

// ---------------------------------------------------------------------------
// hilog
// ---------------------------------------------------------------------------

interface HilogResult {
  status: 'collected' | 'failed' | 'skipped';
  filter: string | null;
  count: number;
  lines: string[];
  truncated: boolean;
  message: string;
}

function collectHilog(
  ctx: Ctx,
  bundle: string | null,
  ability: string | null,
  customFilter: RegExp | null,
  customText: string | null,
): HilogResult {
  const result = runTargeted(ctx, ['shell', 'hilog', '-x'], Math.max(ctx.timeoutMs, 30000));
  if (result.timedOut || result.spawnError !== null) {
    return {
      status: 'failed', filter: customText, count: 0, lines: [], truncated: false,
      message: result.spawnError ?? 'hilog 超时',
    };
  }
  // hilog 行格式：11-10 00:00:12.506  3679  4266 E A01B04/domain/Tag: message
  const levelOf = (line: string): string | null => {
    const match = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+([EWF])\s/.exec(line);
    return match ? match[1] : null;
  };
  const keyword = /\b(error|exception|fatal)\b/i;
  const filterText = (bundle !== null ? bundle + '/' : '') +
    (ability !== null ? ability + '/' : '') + 'E/F 级 + error/exception' +
    (customText !== null ? ' + ' + customText : '');
  const matched: string[] = [];
  for (const line of outputOf(result).split('\n')) {
    if (line.trim() === '') continue;
    const level = levelOf(line);
    let keep = level === 'E' || level === 'F' || (level === null && keyword.test(line));
    if (!keep && bundle !== null && line.includes(bundle)) keep = true;
    if (!keep && ability !== null && ability !== '' && line.includes(ability)) keep = true;
    if (!keep && customFilter !== null) keep = customFilter.test(line);
    if (keep) matched.push(line.replace(/\s+$/, ''));
  }
  const truncated = matched.length > HILOG_MAX_LINES;
  return {
    status: 'collected', filter: filterText, count: matched.length,
    lines: truncated ? matched.slice(-HILOG_MAX_LINES) : matched,
    truncated, message: 'hilog 命中 ' + matched.length + ' 行',
  };
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

interface ScreenshotResult {
  status: 'captured' | 'failed' | 'skipped';
  path: string | null;
  remote: string | null;
  bytes: number | null;
  message: string;
}

function takeScreenshot(ctx: Ctx, localAbs: string): ScreenshotResult {
  const remote = REMOTE_SCREENSHOT_DIR + '/arkts-port-device-test-' + process.pid + '.jpeg';
  try {
    mkdirSync(dirname(localAbs), { recursive: true });
  } catch (error) {
    return { status: 'failed', path: localAbs, remote, bytes: null, message: '无法创建本地目录：' + errorMessage(error) };
  }
  const shot = runTargeted(ctx, ['shell', 'snapshot_display', '-f', remote]);
  const shotText = outputOf(shot);
  if (shot.timedOut || shot.spawnError !== null || /^\s*error:/im.test(shotText)) {
    return {
      status: 'failed', path: localAbs, remote, bytes: null,
      message: shot.spawnError ?? ('snapshot_display 失败：' + oneLine(shotText, 120)),
    };
  }
  const recv = runTargeted(ctx, ['file', 'recv', remote, localAbs]);
  const bytes = isFile(localAbs) ? statSync(localAbs).size : null;
  // 尽力清理设备临时文件（失败不影响结论）
  runTargeted(ctx, ['shell', 'rm', '-f', remote], 5000);
  if (recv.timedOut || recv.spawnError !== null || bytes === null || bytes === 0) {
    return {
      status: 'failed', path: localAbs, remote, bytes,
      message: recv.spawnError ?? ('file recv 失败（本地文件缺失或为空）：' + oneLine(outputOf(recv), 120)),
    };
  }
  return {
    status: 'captured', path: localAbs, remote, bytes,
    message: '截图 ' + bytes + ' 字节',
  };
}

// ---------------------------------------------------------------------------
// 报告与输出
// ---------------------------------------------------------------------------

interface DeviceTestReport {
  ok: boolean;
  exitCode: number;
  target: string;
  hdc: string;
  hdcVersion: string | null;
  check: {
    ok: boolean;
    connected: boolean;
    targets: string[];
    model: string | null;
    manufacturer: string | null;
    osVersion: string | null;
    apiVersion: string | null;
    message: string;
    hint: string | null;
  };
  install: InstallResult;
  launch: LaunchResult;
  hilog: HilogResult;
  screenshot: ScreenshotResult;
  logPath: string | null;
  commands: Array<{ command: string; exitCode: number | null; durationMs: number; timedOut: boolean }>;
}

function skippedInstall(): InstallResult {
  return {
    status: 'skipped', hap: null, exitCode: null, errorCode: null,
    message: '未请求安装（--install）', hint: null, outputTail: '',
  };
}

function skippedLaunch(): LaunchResult {
  return {
    status: 'skipped', bundle: null, ability: null, exitCode: null, errorCode: null,
    message: '未请求启动（--bundle）', hint: null,
    verify: { aaStartOk: false, running: false, installed: false, methods: [] }, outputTail: '',
  };
}

function skippedHilog(): HilogResult {
  return { status: 'skipped', filter: null, count: 0, lines: [], truncated: false, message: '--check 不抓 hilog' };
}

function skippedScreenshot(): ScreenshotResult {
  return { status: 'skipped', path: null, remote: null, bytes: null, message: '未请求截图（--screenshot）' };
}

/** 命令输出写日志时截断（hilog -x 一次可 1MB+；报告里只保留过滤后的 100 行） */
function truncateForLog(text: string, maxLines = 300): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.replace(/\s+$/, '').split('\n');
  if (lines.length <= maxLines) return { text: lines.join('\n'), truncated: false, totalLines: lines.length };
  return {
    text: lines.slice(-maxLines).join('\n'),
    truncated: true,
    totalLines: lines.length,
  };
}

function writeCommandLog(ctx: Ctx, logAbs: string): string | null {
  const lines: string[] = [
    '# arkts-port device-test 日志',
    '# target: ' + ctx.target,
    '# hdc: ' + ctx.hdc,
    '# 命令数: ' + ctx.commands.length,
    '',
  ];
  for (const command of ctx.commands) {
    lines.push('## ' + command.command);
    lines.push('# 退出码: ' + (command.exitCode === null ? '-' : String(command.exitCode)) +
      '  耗时: ' + command.durationMs + 'ms  超时: ' + (command.timedOut ? 'yes' : 'no'));
    if (command.spawnError !== null) lines.push('# 启动错误: ' + command.spawnError);
    const stdout = truncateForLog(command.stdout);
    if (stdout.truncated) lines.push('# stdout 截断：共 ' + stdout.totalLines + ' 行，保留最后 300 行');
    lines.push('--- stdout');
    lines.push(stdout.text);
    if (command.stderr !== '') {
      const stderr = truncateForLog(command.stderr);
      if (stderr.truncated) lines.push('# stderr 截断：共 ' + stderr.totalLines + ' 行，保留最后 300 行');
      lines.push('--- stderr');
      lines.push(stderr.text);
    }
    lines.push('');
  }
  try {
    mkdirSync(dirname(logAbs), { recursive: true });
    writeFileSync(logAbs, lines.join('\n') + '\n', 'utf8');
    return relPath(ctx.cwd, logAbs);
  } catch (error) {
    console.error('device-test: 无法写日志 ' + logAbs + '：' + errorMessage(error));
    return null;
  }
}

function emitReport(
  ctx: Ctx,
  raw: RawCli,
  report: DeviceTestReport,
  humanLines: string[],
): void {
  const reportArg = optional(raw, 'report');
  if (reportArg !== null) {
    const reportAbs = resolve(ctx.cwd, reportArg);
    try {
      mkdirSync(dirname(reportAbs), { recursive: true });
      writeFileSync(reportAbs, JSON.stringify(report, null, 2) + '\n', 'utf8');
    } catch (error) {
      failUsage('无法写入 --report ' + reportArg + '：' + errorMessage(error));
    }
  }
  if (raw.json === true) console.log(JSON.stringify(report, null, 2));
  else console.log(humanLines.join('\n'));
  // 用 exitCode 而非 process.exit：大 JSON 走管道时避免截断
  process.exitCode = report.exitCode;
}

function humanLines(ctx: Ctx, report: DeviceTestReport): string[] {
  const lines: string[] = [];
  lines.push('device-test  target=' + report.target + '  hdc=' + report.hdc +
    (report.hdcVersion !== null ? ' (' + report.hdcVersion + ')' : ''));
  const check = report.check;
  lines.push('check        ' + (check.ok ? 'connected  ' : 'FAILED  ') +
    [check.model, check.manufacturer, check.osVersion !== null ? 'OS ' + check.osVersion : null,
      check.apiVersion !== null ? 'API ' + check.apiVersion : null]
      .filter((part) => part !== null && part !== '').join(' / '));
  if (!check.ok) {
    if (check.hint !== null) lines.push('             修法: ' + check.hint);
  }
  const install = report.install;
  lines.push('install      ' + (install.status === 'installed' ? 'installed  ' + oneLine(String(install.hap), 90)
    : install.status === 'failed'
      ? 'FAILED  ' + (install.errorCode !== null ? 'code ' + install.errorCode : oneLine(install.message, 90))
      : 'skipped'));
  if (install.status === 'failed' && install.hint !== null) lines.push('             修法: ' + oneLine(install.hint, 140));
  const launch = report.launch;
  lines.push('launch       ' + (launch.status === 'started'
    ? 'started  ' + String(launch.ability) + ' / ' + String(launch.bundle)
    : launch.status === 'failed'
      ? 'FAILED  ' + (launch.errorCode !== null ? 'Error Code ' + launch.errorCode : oneLine(launch.message, 90))
      : 'skipped'));
  if (launch.status === 'failed' && launch.hint !== null) lines.push('             修法: ' + oneLine(launch.hint, 140));
  const hilog = report.hilog;
  lines.push('hilog        ' + (hilog.status === 'collected'
    ? hilog.count + ' 行（filter: ' + oneLine(String(hilog.filter), 90) + '）'
    : hilog.status === 'failed' ? 'FAILED  ' + oneLine(hilog.message, 90) : 'skipped'));
  const screenshot = report.screenshot;
  lines.push('screenshot   ' + (screenshot.status === 'captured'
    ? String(screenshot.path) + '  ' + screenshot.bytes + ' 字节'
    : screenshot.status === 'failed' ? 'FAILED  ' + oneLine(screenshot.message, 90) : 'skipped'));
  lines.push('日志         ' + (report.logPath === null ? '(未写)' : report.logPath));
  lines.push('结果: ' + (report.ok ? 'PASS' : 'FAIL') + '（exit ' + report.exitCode + '）');
  return lines;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function parseTimeout(raw: RawCli): number {
  const text = optional(raw, 'timeout');
  if (text === null) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 0) failUsage('--timeout 必须是非负整数（毫秒）：' + text);
  return parsed;
}

function parseHilogFilter(raw: RawCli): { regex: RegExp | null; text: string | null } {
  const text = optional(raw, 'hilog-filter');
  if (text === null) return { regex: null, text: null };
  try {
    return { regex: new RegExp(text), text };
  } catch (error) {
    failUsage('--hilog-filter 不是合法正则：' + text + '（' + errorMessage(error) + '）');
  }
}

function main(): void {
  const raw = parseCliArgs(process.argv.slice(2));
  if (raw.help === true) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }
  const cwd = process.cwd();
  const checkOnly = raw.check === true;

  const target = optional(raw, 'target');
  if (target === null) failUsage('缺少 --target（真机地址，如 192.0.2.10:40135）');
  const installRequested = raw.install === true;
  const hapArg = optional(raw, 'hap');
  if (installRequested && hapArg === null) failUsage('--install 需要 --hap <path>');
  if (hapArg !== null && !installRequested) failUsage('--hap 需要同时给 --install（避免误以为已安装）');
  const hapAbs = hapArg === null ? null : resolve(cwd, hapArg);
  if (hapAbs !== null && !isFile(hapAbs)) failUsage('--hap 文件不存在：' + hapArg);

  const bundle = optional(raw, 'bundle');
  const ability = optional(raw, 'ability') ?? 'EntryAbility';
  if (optional(raw, 'ability') !== null && bundle === null) {
    failUsage('--ability 需要同时给 --bundle');
  }
  const screenshotArg = optional(raw, 'screenshot');
  const screenshotAbs = screenshotArg === null ? null : resolve(cwd, screenshotArg);
  if (screenshotAbs !== null && isDirectory(screenshotAbs)) {
    failUsage('--screenshot 不能是目录：' + screenshotArg);
  }
  const timeoutMs = parseTimeout(raw);
  const hilogFilter = parseHilogFilter(raw);
  const hdc = resolveHdcPath(raw, cwd);

  const ctx: Ctx = { cwd, target, hdc, timeoutMs, commands: [] };
  const check = checkDevice(ctx);
  const install = skippedInstall();
  const launch = skippedLaunch();
  const hilog = skippedHilog();
  const screenshot = skippedScreenshot();

  if (checkOnly) {
    install.message = '--check 模式不安装';
    launch.message = '--check 模式不启动';
    screenshot.message = '--check 模式不截图';
  }

  if (!check.ok) {
    install.message = '设备未连接，跳过安装';
    launch.message = '设备未连接，跳过启动';
    hilog.message = '设备未连接，跳过 hilog';
    screenshot.message = '设备未连接，跳过截图';
  }

  let exitCode = check.ok ? EXIT_OK : EXIT_FAIL;
  if (check.ok && !checkOnly) {
    if (installRequested && hapAbs !== null) {
      Object.assign(install, installHap(ctx, hapAbs));
      if (install.status !== 'installed') exitCode = EXIT_FAIL;
    }
    if (bundle !== null && (install.status === 'installed' || !installRequested)) {
      Object.assign(launch, launchAbility(ctx, bundle, ability));
      if (launch.status !== 'started') exitCode = EXIT_FAIL;
    } else if (bundle !== null) {
      Object.assign(launch, {
        status: 'skipped', bundle, ability, exitCode: null, errorCode: null,
        message: '安装失败，跳过启动', hint: null,
        verify: { aaStartOk: false, running: false, installed: false, methods: [] }, outputTail: '',
      });
    }
    Object.assign(hilog, collectHilog(ctx, bundle, bundle === null ? null : ability, hilogFilter.regex, hilogFilter.text));
    if (hilog.status === 'failed') exitCode = EXIT_FAIL;
    if (screenshotAbs !== null) {
      Object.assign(screenshot, takeScreenshot(ctx, screenshotAbs));
      if (screenshot.status !== 'captured') exitCode = EXIT_FAIL;
    }
  }

  const logArg = optional(raw, 'log');
  const logAbs = resolve(cwd, logArg ?? join('out', 'logs', 'device-test.log'));
  const logPath = writeCommandLog(ctx, logAbs);
  const report: DeviceTestReport = {
    ok: exitCode === EXIT_OK,
    exitCode,
    target,
    hdc,
    hdcVersion: check.hdcVersion,
    check,
    install,
    launch,
    hilog,
    screenshot,
    logPath,
    commands: ctx.commands.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      timedOut: command.timedOut,
    })),
  };
  emitReport(ctx, raw, report, humanLines(ctx, report));
}

// Node 的测试发现规则会把 *-test.ts 当测试文件：node --test 在仓库根会误执行本 CLI
// （无参数 → exit 2，导致全仓测试失败）。测试上下文 + 无参数时静默 exit 0；
// 正常命令行（带参数）不受影响。
if (process.env.NODE_TEST_CONTEXT !== undefined && process.argv.length <= 2) {
  process.exit(0);
}

main();
