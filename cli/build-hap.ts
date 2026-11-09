#!/usr/bin/env node
/**
 * 构建 HAP（Linux 无 DevEco）。
 *
 * 用法：
 *   node cli/build-hap.ts --project <harmony-project> [--mode debug|release]
 *        [--sdk <OHOS_BASE_SDK_HOME>] [--hvigor <node_modules 目录>] [--log <path>]
 *
 * 与原版差异（P0 复跑性修补）：
 * - 不再 stdio: inherit 直出 236 行原始日志；默认只打印摘要（构建模式 / 任务数 / 关键阶段 /
 *   日志路径），完整输出落 --log（默认 out/logs/build-hap.log）。cli/port.ts 仍能匹配
 *   stdout 里的 BUILD SUCCESSFUL 或失败摘要。
 * - 先校验 --project 目录（P2：原来不校验，cwd 不存在时只得到 spawn 错误）。
 * - 未知参数 exit 2；--help 打印用法 exit 0。
 *
 * 环境变量：OHOS_BASE_SDK_HOME / HVIGOR_HOME / NODE_HOME
 * 退出码：0 = BUILD SUCCESSFUL；1 = 构建失败；2 = 用法/前置缺失。
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const USAGE = [
  '用法：',
  '  node cli/build-hap.ts --project <harmony-project> [--mode debug|release]',
  '       [--sdk <path>] [--hvigor <path>] [--log <path>]',
  '',
  '构建 HAP（Linux 无 DevEco；hvigor 直出日志落盘，stdout 只留摘要）。',
  '',
  '参数：',
  '  --project <dir>   鸿蒙工程目录（必填，必须存在）',
  '  --mode <mode>     debug | release（默认 debug）',
  '  --sdk <path>      OpenHarmony SDK（默认 OHOS_BASE_SDK_HOME；必须有 <sdk>/26.0.0/ets）',
  '  --hvigor <path>   hvigor node_modules 目录（默认 HVIGOR_HOME；必须有 @ohos/hvigor/bin/hvigor.js）',
  '  --log <path>      完整构建日志路径（默认 out/logs/build-hap.log，相对 cwd）',
  '  --help, -h        显示本帮助',
  '',
  '输出（摘要，供 cli/port.ts 解析）：',
  '  构建模式 / 任务 / 阶段 / 日志',
  '  成功时包含 BUILD SUCCESSFUL；失败时给「错误摘要」并以非 0 退出',
  '',
  '退出码：0 = BUILD SUCCESSFUL；1 = 构建失败；2 = 用法/前置缺失',
].join('\n');

const VALUE_OPTS = new Set(['project', 'mode', 'sdk', 'hvigor', 'log']);
const BOOL_OPTS = new Set(['help']);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STEP_TASKS = ['PreBuild', 'CompileArkTS', 'PackageHap', 'SignHap', 'assembleHap'];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failUsage(message: string): never {
  console.error('build-hap: ' + message);
  console.error('用法见：node cli/build-hap.ts --help');
  process.exit(2);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') { args.help = true; continue; }
    if (!token.startsWith('--')) failUsage('无法识别的参数：' + token);
    const eq = token.indexOf('=');
    if (eq > 2) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
      if (value === '') failUsage('参数 --' + key + ' 不能为空');
      args[key] = value;
      continue;
    }
    const key = token.slice(2);
    if (BOOL_OPTS.has(key)) { args[key] = true; continue; }
    if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) failUsage('参数 --' + key + ' 缺少取值');
    args[key] = next;
    i++;
  }
  return args;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** hvigor 的 "> hvigor <STATUS> :entry:default@Task..." 行 */
function parseStepStatuses(clean: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of clean.split('\n')) {
    const match = /(Finished|UP-TO-DATE|Failed|FAILED|Skipped|SKIPPED)\s+:(\S+?)(?:\.\.\.|\s|$)/.exec(line);
    if (!match) continue;
    const task = match[2].split('@').pop() ?? match[2];
    if (!found.has(task)) found.set(task, match[1]);
  }
  return found;
}

function oneLine(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…';
}

function errorSummary(clean: string): { first: string | null; more: number } {
  const lines = clean.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  // 优先 ArkTS 的 Error Message（最可操作），其次 hvigor 的 ERROR/Failed 行
  const messages = lines.filter((line) => /Error Message:/.test(line));
  const hits = messages.length > 0
    ? messages
    : lines.filter((line) => /\bERROR:/.test(line) || /Failed :/.test(line));
  if (hits.length === 0) {
    const fallback = lines.find((line) => /\bERROR\b/.test(line) || /错误/.test(line));
    if (fallback !== undefined) hits.push(fallback);
  }
  return { first: hits.length > 0 ? oneLine(hits[0]) : null, more: Math.max(0, hits.length - 1) };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

if (args.project === undefined) failUsage('缺少 --project（鸿蒙工程目录）');
const projectArg = String(args.project);
const cwd = process.cwd();
const project = resolve(cwd, projectArg);
if (!isDirectory(project)) failUsage('--project 目录不存在：' + projectArg);

const mode = String(args.mode ?? 'debug');
if (mode !== 'debug' && mode !== 'release') failUsage('--mode 只能是 debug 或 release：' + mode);

const sdkArg = args.sdk === undefined ? (process.env.OHOS_BASE_SDK_HOME ?? '') : String(args.sdk);
if (sdkArg === '') failUsage('缺少 OpenHarmony SDK（--sdk 或 OHOS_BASE_SDK_HOME）');
const sdk = resolve(cwd, sdkArg);
if (!isDirectory(join(sdk, '26.0.0', 'ets'))) {
  failUsage('缺少 OpenHarmony SDK（期望 <sdk>/26.0.0/ets）：' + sdkArg +
    '；见 rules/pitfalls.md 的「构建工具链」一节');
}

const hvigorArg = args.hvigor === undefined ? (process.env.HVIGOR_HOME ?? '') : String(args.hvigor);
if (hvigorArg === '') failUsage('缺少 hvigor（--hvigor 或 HVIGOR_HOME）');
const hvigorHome = resolve(cwd, hvigorArg);
const hvigorJs = join(hvigorHome, '@ohos/hvigor/bin/hvigor.js');
if (!isFile(hvigorJs)) failUsage('缺少 hvigor 入口：' + hvigorJs);

const logPath = args.log === undefined
  ? resolve(cwd, 'out', 'logs', 'build-hap.log')
  : resolve(cwd, String(args.log));

const res = spawnSync(
  process.execPath,
  [hvigorJs, '--mode', 'module', '-p', 'product=default', '-p', 'buildMode=' + mode, 'assembleHap', '--no-daemon'],
  {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      OHOS_BASE_SDK_HOME: sdk,
      NODE_PATH: hvigorHome,
      NODE_HOME: process.env.NODE_HOME ?? '/usr/bin',
    },
  },
);

const spawnError = res.error ? errorMessage(res.error) : null;
const raw = (res.stdout ?? '') + (res.stderr ?? '') +
  (spawnError === null ? '' : '\n[build-hap] 无法启动 hvigor：' + spawnError + '\n');
let logNote = '';
try {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, raw, 'utf8');
  logNote = '（' + Buffer.byteLength(raw, 'utf8') + ' 字节）';
} catch (error) {
  console.error('build-hap: 无法写日志 ' + logPath + '：' + errorMessage(error));
}

const clean = raw.replace(ANSI, '');
const ok = res.status === 0 && spawnError === null;
const summary: string[] = ['构建模式: ' + mode];
const totals = /(\d+) tasks in total: (\d+) executed, (\d+) up-to-date/.exec(clean);
if (totals) {
  summary.push('任务: ' + totals[1] + ' total（执行 ' + totals[2] + ' / 最新 ' + totals[3] + '）');
}
const steps = parseStepStatuses(clean);
const stepParts = STEP_TASKS.filter((task) => steps.has(task)).map((task) => task + '=' + steps.get(task));
if (stepParts.length > 0) summary.push('阶段: ' + stepParts.join('  '));
summary.push('日志: ' + logPath + logNote);

if (ok) {
  if (/BUILD SUCCESSFUL/.test(clean)) summary.push('BUILD SUCCESSFUL');
  else summary.push('构建完成（hvigor exit 0，但日志里没匹配到 BUILD SUCCESSFUL）');
} else if (spawnError !== null) {
  summary.push('hvigor 启动失败：' + oneLine(spawnError));
  summary.push('构建失败（无法启动 hvigor）');
} else {
  const detail = errorSummary(clean);
  summary.push('错误摘要: ' + (detail.first ?? '（日志里没有识别到错误行，见日志）'));
  if (detail.more > 0) summary.push('更多错误: ' + detail.more + ' 条（见日志）');
  // 不放裸 "BUILD FAILED" 行：cli/port.ts 的失败摘要优先匹配 FAILED，会盖掉更可操作的「错误摘要」
  summary.push('构建失败（exit ' + (res.status ?? 'null') + '）');
}
console.log(summary.join('\n'));

process.exitCode = spawnError !== null ? 2 : (ok ? 0 : 1);
