#!/usr/bin/env node
/**
 * arkts-port 门禁编排器：一条命令跑完整流水线门禁。
 *
 * 设计原则（改之前先想清楚）：
 * - 只编排，不复制逻辑：每个阶段都 spawn 现有 cli/*.ts，子工具的退出码就是门禁结论。
 * - 少 token：子工具输出全部落盘到 out/logs/<stage>.log，人只看「每阶段一行」摘要；
 *   agent 读 --report 的 JSON 即可，不需要回读长日志。
 * - 可复跑：同样的参数得到同样的阶段顺序 / 状态 / 摘要；日志与报告路径稳定。
 *
 * 退出码：0 = 没有 FAIL 且没有 SKIP（PASS / WARN 都算通过；WARN 只告警）；
 *         1 = 任一 FAIL 或 SKIP（SKIP 不算通过）；2 = 用法错误。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type StageName = 'analyze' | 'adapt' | 'diff' | 'fidelity' | 'lint' | 'reach' | 'build' | 'device';
type StageStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

const STAGE_ORDER: StageName[] = ['analyze', 'adapt', 'diff', 'fidelity', 'lint', 'reach', 'build', 'device'];

const STAGE_TITLE: Record<StageName, string> = {
  analyze: '耦合分诊',
  adapt: 'ArkTS 机械适配',
  diff: '适配只动类型层告警',
  fidelity: '保真度门禁',
  lint: 'ArkTS 编译门禁',
  reach: '全量可达门禁',
  build: 'HAP 构建',
  device: '真机 device-test',
};

const STAGE_TOOL: Record<StageName, string> = {
  analyze: 'analyze-coupling',
  adapt: 'adapt-arkts',
  diff: 'diff-gate',
  fidelity: 'verify-fidelity',
  lint: 'lint-arkts',
  reach: 'reachability-probe',
  build: 'build-hap',
  device: 'device-test',
};

/** 与 cli/build-hap.ts 保持一致：SDK 必须在 <home>/<version>/ets 下 */
const SDK_VERSION = '26.0.0';
/** 与 cli/build-hap.ts / lint-arkts.ts / reachability-probe.ts 保持一致 */
const HVIGOR_BIN = '@ohos/hvigor/bin/hvigor.js';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE = [
  '用法：',
  '  node cli/port.ts [--project <harmony>] [--case <dir>] [--src <dir>] [--adapted <dir>]',
  '       [--actual <a.json>] [--sdk <p>] [--hvigor <p>]',
  '       [--stages analyze,adapt,diff,fidelity,lint,reach,build,device|all] [--report <path.json>]',
  '       [--device <ip:port>] [--signed-hap <hap>] [--bundle <id>] [--ability <EntryAbility>]',
  '       [--hdc <p>] [--device-timeout <ms>]',
  '       [--json] [--continue] [--strict-diff]',
  '',
  '阶段（固定按此顺序执行；--stages 只选子集，执行顺序不变；默认 all）：',
  '  analyze   对 --src 跑 analyze-coupling（无 --src → SKIP）',
  '  adapt     adapt-arkts：--src → --adapted（默认输出 .ets；工具未就绪 → SKIP；扫描 0 文件/残留视为失败）',
  '  diff      diff-gate：--before（默认 --adapt-src/--src）→ --after（默认 --adapted）；',
  '            exit 0 → PASS；exit 3 → WARN（只告警、不阻断后续）；其它 → FAIL；输入缺失 → SKIP',
  '  fidelity  verify-fidelity：--case/golden.json 对比 actual',
  '            actual 选择顺序：--actual > replay.ts 重放 > <case>/actual.json',
  '  lint      lint-arkts --project（需要 SDK + hvigor）',
  '  reach     reachability-probe --project（需要 SDK + hvigor）',
  '  build     build-hap --project（需要 SDK + hvigor）',
  '  device    真机 device-test（仅 --device <ip:port> 时启用）：无 --signed-hap → check-only；',
  '            有 --signed-hap → install+launch+screenshot（install 需要 --bundle）',
  '',
  '输出：',
  '  每个阶段一行：PASS/WARN/FAIL/SKIP + 关键数字 + 日志路径；日志默认写 out/logs/<stage>.log',
  '  报告 JSON 默认写 out/port-report.json；加 --json 时把同一份 JSON 打到 stdout',
  '  状态口径：PASS/WARN 都算通过（WARN 只告警）；SKIP 不算通过；WARN 不会阻断后续阶段',
  '  默认遇到 FAIL 立即停止；--continue 继续跑后续阶段',
  '',
  '退出码：0 = 没有 FAIL 且没有 SKIP（PASS/WARN 通过）；1 = 任一 FAIL 或 SKIP；2 = 用法错误',
  '',
  '可选扩展（原契约之外，均为可选）：',
  '  --logs <dir>          日志目录（默认 out/logs）',
  '  --mode debug|release  build 阶段模式（默认 debug）',
  '  --ets-src <rel>       reach 阶段工程内 .ets 根（默认 entry/src/main/ets）',
  '  --entry <rel>         reach 阶段入口页（默认 pages/Index.ets）',
  '  --lang <id>           analyze 阶段的 --lang（按 adapters/languages.json 校验）',
  '  --timeout <ms>        单阶段超时，0 = 不超时（默认 0）',
  '  --adapt-src <dir>     adapt 阶段的输入目录（默认同 --src；上游源码目录 != TS 转写产物目录时用）',
  '  --allow-residuals     adapt 允许 residual>0 仍 PASS（默认传 --fail-on-residual：残留即 FAIL）',
  '  --no-ets              adapt 输出保持 .ts（默认给 adapt-arkts 传 --ets）',
  '  --strict-diff         diff 阶段把 WARN（needs-review>0）视为 FAIL',
  '  --no-replay           fidelity 不尝试 replay.ts 重放',
  '  --no-explain          lint/reach FAIL 时不自动跑 explain-errors（默认自动；不改变门禁结论）',
  '  --explain-max <n>     自动 explain 取前 n 条（默认 5；人类摘要每阶段最多 3 行）',
  '  --device <ip:port>    启用可选 device 阶段（不提供则阶段序列保持 7 阶段）',
  '  --signed-hap <hap>    AGC 签名 HAP：提供则 install+launch+screenshot（需要 --bundle）；不提供则 check-only',
  '  --bundle <id>         install 的 bundleName（提供 --signed-hap 时必填）',
  '  --ability <name>      launch 的 abilityName（默认 EntryAbility）',
  '  --hdc <path>          device 阶段的 hdc 可执行文件（默认 $HDC > SDK toolchains > PATH）',
  '  --device-timeout <ms> device-test 单条 hdc 命令超时（0=不超时；不传用 CLI 默认 60000）',
  '  --help, -h            显示本帮助',
  '',
  '示例：',
  '  node cli/port.ts --case cases/legado --stages fidelity',
  '  node cli/port.ts --project out/harmony --src out/src --adapted out/adapted \\',
  '       --case cases/legado --sdk $OHOS_BASE_SDK_HOME --hvigor $HVIGOR_HOME \\',
  '       --report out/report.json',
].join('\n');

interface RawCli {
  [key: string]: string | boolean;
}

interface Ctx {
  cliDir: string;
  cwd: string;
  raw: RawCli;
  stages: StageName[];
  doContinue: boolean;
  logsDir: string;
  reportPath: string;
  sdk: string;
  sdkAbs: string;
  hvigor: string;
  hvigorJs: string;
  mode: string;
  timeoutMs: number;
  ets: boolean;
  replay: boolean;
  etsSrc: string;
  entry: string;
  lang: string;
  adaptSrc: string | null;
  allowResiduals: boolean;
  strictDiff: boolean;
  replayOut: string;
  adaptReport: string;
  /** lint/reach FAIL 时自动跑 explain-errors（默认 true；--no-explain 关闭） */
  explain: boolean;
  /** 自动 explain 取前 N 条（默认 5） */
  explainMax: number;
  /** 可选 device 阶段：--device <ip:port> 才启用 */
  device: string;
  /** AGC 签名 HAP；提供则 install+launch，不提供则 check-only */
  signedHap: string;
  bundle: string;
  ability: string;
  hdc: string;
  deviceTimeoutMs: number | null;
}

interface StageOutcome {
  status: StageStatus;
  exitCode: number | null;
  summary: string;
  metrics?: Record<string, unknown>;
  commands: string[];
  notes: string[];
  output: string;
  /** 人类摘要附加行（如 lint/reach FAIL 时的 explain 摘要；每阶段最多 3 行） */
  extraLines?: string[];
}

interface StageResult {
  name: StageName;
  status: StageStatus;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  logPath: string;
  metrics?: Record<string, unknown>;
  extraLines?: string[];
}

interface ChildRun {
  exitCode: number | null;
  signal: string | null;
  /** 仅 stdout：JSON 解析、重放产物写入都必须用它，避免把 stderr 警告混进数据 */
  stdout: string;
  /** 仅 stderr：只进日志/错误摘要，不参与解析 */
  stderr: string;
  /** stdout + stderr：给日志和失败摘要看 */
  output: string;
  timedOut: boolean;
  spawnError: string | null;
  durationMs: number;
  command: string;
}

const VALUE_OPTS = new Set([
  'project', 'case', 'src', 'adapted', 'actual', 'sdk', 'hvigor',
  'stages', 'report', 'logs', 'mode', 'timeout', 'ets-src', 'entry', 'lang', 'adapt-src',
  'explain-max', 'device', 'signed-hap', 'bundle', 'ability', 'hdc', 'device-timeout',
]);
const BOOL_OPTS = new Set([
  'json', 'continue', 'ets', 'no-ets', 'no-replay', 'allow-residuals', 'strict-diff', 'no-explain', 'help',
]);

// ---------------------------------------------------------------------------
// 参数解析与校验：任何用法错误都必须 exit 2，且给出可操作的提示
// ---------------------------------------------------------------------------

function failUsage(message: string): never {
  console.error('port: ' + message);
  console.error('用法见：node cli/port.ts --help');
  process.exit(EXIT_USAGE);
}

function parseCliArgs(argv: string[]): RawCli {
  const raw: RawCli = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      raw.help = true;
      continue;
    }
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
    if (BOOL_OPTS.has(key)) {
      raw[key] = true;
      continue;
    }
    if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) {
      failUsage('参数 --' + key + ' 缺少取值');
    }
    raw[key] = next;
    i++;
  }
  return raw;
}

function resolveStages(raw: RawCli, deviceEnabled: boolean): StageName[] {
  // device 默认不启用：只有提供 --device <ip:port> 才进入阶段序列（默认 all 也保持 7 阶段语义）
  const available = deviceEnabled ? [...STAGE_ORDER] : STAGE_ORDER.filter((stage) => stage !== 'device');
  const text = optional(raw, 'stages');
  if (text === null) return available;
  const pieces = text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (pieces.length === 0) failUsage('--stages 不能为空');
  const picked = new Set<StageName>();
  for (const piece of pieces) {
    if (piece === 'all') {
      for (const stage of available) picked.add(stage);
      continue;
    }
    if (piece === 'device' && !deviceEnabled) {
      failUsage('--stages 包含 device，但缺少 --device <ip:port>（device 阶段默认不启用）');
    }
    if (!available.includes(piece as StageName)) {
      failUsage('未知阶段："' + piece + '"（可用：all 或 ' + available.join(',') + '；device 需 --device）');
    }
    picked.add(piece as StageName);
  }
  // 固定顺序执行，保证同样的参数得到同样的阶段序列
  return available.filter((stage) => picked.has(stage));
}

function optional(raw: RawCli, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' ? value : null;
}

function opt(ctx: Ctx, key: string): string | null {
  return optional(ctx.raw, key);
}

// ---------------------------------------------------------------------------
// 小工具（解析子工具输出；不复制子工具的门禁逻辑，只提取关键数字）
// ---------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function oneLine(text: string, max = 160): string {
  const clean = text.replace(ANSI, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function firstMeaningfulLine(text: string): string {
  const clean = text.replace(ANSI, '');
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-=#*_]{3,}$/.test(trimmed)) continue;
    return oneLine(trimmed, 160);
  }
  return '(无输出)';
}

function parseJsonValue(text: string): unknown {
  if (!text) return null;
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed) candidates.push(trimmed);
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) start = Math.min(firstBrace, firstBracket);
  else start = Math.max(firstBrace, firstBracket);
  if (start >= 0) {
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function matchInt(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** 报告里的路径：cwd 内用相对路径（可复跑），cwd 外用绝对路径（受 --logs/--report 指向 /tmp 时避免 ../../..） */
function relPath(ctx: Ctx, path: string): string {
  const rel = relative(ctx.cwd, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// 子进程：环境变量映射与 cli/build-hap.ts 完全一致
// ---------------------------------------------------------------------------

function childEnv(ctx: Ctx): Record<string, string | undefined> {
  return {
    ...process.env,
    OHOS_BASE_SDK_HOME: ctx.sdk,
    NODE_PATH: ctx.hvigor,
    NODE_HOME: process.env.NODE_HOME ?? '/usr/bin',
  };
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

function runChild(ctx: Ctx, scriptPath: string, args: string[]): ChildRun {
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ctx.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: ctx.timeoutMs > 0 ? ctx.timeoutMs : undefined,
    env: childEnv(ctx),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - startedAt;
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  let spawnError: string | null = null;
  let timedOut = false;
  if (res.error) {
    const error = res.error as { code?: string; message?: string };
    spawnError = error.message ?? String(res.error);
    timedOut = error.code === 'ETIMEDOUT';
  }
  const command = ['node', quoteArg(scriptPath), ...args.map(quoteArg)].join(' ');
  return {
    exitCode: res.status,
    signal: res.signal ?? null,
    stdout,
    stderr,
    output: stdout + stderr,
    timedOut,
    spawnError,
    durationMs,
    command,
  };
}

function statusOf(run: ChildRun): StageStatus {
  if (run.timedOut) return 'FAIL';
  if (run.spawnError) return 'FAIL';
  if (run.signal) return 'FAIL';
  return run.exitCode === 0 ? 'PASS' : 'FAIL';
}

/** 子工具支持 --json 时以它的 pass 为准；两边不一致（pass=true 但 exit≠0）按 FAIL 兜底 */
function statusWithChildPass(run: ChildRun, childPass: boolean | null): StageStatus {
  const fromExit = statusOf(run);
  if (childPass === null) return fromExit;
  if (childPass === false) return 'FAIL';
  return fromExit === 'PASS' ? 'PASS' : 'FAIL';
}

/** 失败摘要优先取「像错误的那一行」，避免把进度条/栈顶当成结论 */
function errorLine(text: string): string {
  const lines = text.replace(ANSI, '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const patterns: RegExp[] = [
    /^(?:SyntaxError|TypeError|RangeError|ReferenceError|AssertionError|Error)\b/,
    /\bERROR\b/,
    /\bFAILED\b/,
    /错误/,
    /失败/,
  ];
  for (const pattern of patterns) {
    for (const line of lines) {
      if (pattern.test(line)) return oneLine(line, 160);
    }
  }
  return firstMeaningfulLine(text);
}

function failureDetail(run: ChildRun): string {
  if (run.timedOut) return '阶段超时（--timeout ' + run.durationMs + 'ms 级别）';
  if (run.spawnError) return '无法启动子进程：' + run.spawnError;
  if (run.signal) return '子进程被信号终止：' + run.signal;
  return errorLine(run.output);
}

function outcomeFromRun(run: ChildRun, summary: string, metrics?: Record<string, number | string>): StageOutcome {
  return {
    status: statusOf(run),
    exitCode: run.exitCode,
    summary,
    metrics,
    commands: [run.command],
    notes: [],
    output: run.output,
  };
}

// ---------------------------------------------------------------------------
// 前置检查：缺失前置 → SKIP（不算 PASS），并给出可操作的缺失原因
// ---------------------------------------------------------------------------

function prereqAnalyze(ctx: Ctx): string | null {
  const src = opt(ctx, 'src');
  if (src === null) return '缺少 --src（analyze 需要源码目录）';
  if (!isDirectory(resolve(ctx.cwd, src))) return '--src 目录不存在：' + src;
  return null;
}

function prereqAdapt(ctx: Ctx): string | null {
  const toolPath = join(ctx.cliDir, STAGE_TOOL.adapt + '.ts');
  if (!isFile(toolPath)) return 'cli/adapt-arkts.ts 未就绪（并行开发中），adapt 阶段跳过';
  const src = ctx.adaptSrc;
  if (src === null) return '缺少 --src（或 --adapt-src）：adapt 的输入目录';
  if (!isDirectory(resolve(ctx.cwd, src))) return '--adapt-src 目录不存在：' + src;
  const adapted = opt(ctx, 'adapted');
  if (adapted === null) return '缺少 --adapted（adapt-arkts 的 --out 目标目录）';
  return null;
}

function prereqDiff(ctx: Ctx): string | null {
  const toolPath = join(ctx.cliDir, STAGE_TOOL.diff + '.ts');
  if (!isFile(toolPath)) return 'cli/diff-gate.ts 未就绪（并行开发中），diff 阶段跳过';
  const before = ctx.adaptSrc;
  if (before === null) return '缺少 --src（或 --adapt-src）：diff 的 --before 输入目录';
  if (!isDirectory(resolve(ctx.cwd, before))) return '--before 目录不存在：' + before;
  const after = opt(ctx, 'adapted');
  if (after === null) return '缺少 --adapted：diff 的 --after 输入目录';
  if (!isDirectory(resolve(ctx.cwd, after))) return '--after 目录不存在：' + after;
  return null;
}

function prereqFidelity(ctx: Ctx): string | null {
  const caseArg = opt(ctx, 'case');
  if (caseArg === null) return '缺少 --case（fidelity 需要 <case>/golden.json）';
  const caseAbs = resolve(ctx.cwd, caseArg);
  if (!isDirectory(caseAbs)) return '--case 目录不存在：' + caseArg;
  if (!isFile(join(caseAbs, 'golden.json'))) {
    return '缺少 ' + join(caseArg, 'golden.json') + '（保真度门禁的前提是 golden）';
  }
  const actualArg = opt(ctx, 'actual');
  if (actualArg !== null) {
    if (!isFile(resolve(ctx.cwd, actualArg))) return '--actual 不存在：' + actualArg;
    return null;
  }
  if (isFile(join(caseAbs, 'actual.json'))) return null;
  if (ctx.replay && isFile(join(caseAbs, 'replay.ts'))) return null; // 运行期先重放
  return '缺少 actual：没有 ' + join(caseArg, 'actual.json') +
    '，也没有 replay.ts' + (ctx.replay ? '' : '（--no-replay 已关闭重放）');
}

function prereqProjectStage(ctx: Ctx, stageName: StageName): string | null {
  const project = opt(ctx, 'project');
  if (project === null) return '缺少 --project（' + stageName + ' 需要鸿蒙工程目录）';
  if (!isDirectory(resolve(ctx.cwd, project))) return '--project 目录不存在：' + project;
  if (ctx.sdk === '') return '缺少 SDK（--sdk 或 OHOS_BASE_SDK_HOME）';
  if (!isDirectory(join(ctx.sdkAbs, SDK_VERSION, 'ets'))) {
    return 'SDK 目录不完整（期望 <sdk>/' + SDK_VERSION + '/ets）：' + ctx.sdk;
  }
  if (ctx.hvigor === '') return '缺少 hvigor（--hvigor 或 HVIGOR_HOME）';
  if (!isFile(ctx.hvigorJs)) return '缺少 hvigor 入口：' + ctx.hvigorJs;
  return null;
}

function prereqLint(ctx: Ctx): string | null {
  return prereqProjectStage(ctx, 'lint');
}

function prereqReach(ctx: Ctx): string | null {
  const base = prereqProjectStage(ctx, 'reach');
  if (base !== null) return base;
  const projectAbs = resolve(ctx.cwd, opt(ctx, 'project') as string);
  const entryPath = join(projectAbs, ctx.etsSrc, ctx.entry);
  if (!isFile(entryPath)) {
    return '找不到入口页：' + join(ctx.etsSrc, ctx.entry) + '（可用 --ets-src/--entry 覆盖）';
  }
  return null;
}

function prereqBuild(ctx: Ctx): string | null {
  return prereqProjectStage(ctx, 'build');
}

function prereqDevice(ctx: Ctx): string | null {
  if (ctx.device === '') return '未提供 --device <ip:port>（device 阶段默认不启用）';
  return null;
}

const STAGE_PREREQ: Record<StageName, (ctx: Ctx) => string | null> = {
  analyze: prereqAnalyze,
  adapt: prereqAdapt,
  diff: prereqDiff,
  fidelity: prereqFidelity,
  lint: prereqLint,
  reach: prereqReach,
  build: prereqBuild,
  device: prereqDevice,
};

// ---------------------------------------------------------------------------
// 各阶段执行：全部通过 spawn 现有 cli/*.ts，不复制子工具逻辑
// ---------------------------------------------------------------------------

function toolPath(ctx: Ctx, stageName: StageName): string {
  return join(ctx.cliDir, STAGE_TOOL[stageName] + '.ts');
}

function runAnalyze(ctx: Ctx): StageOutcome {
  const args = ['--root', opt(ctx, 'src') as string, '--json'];
  if (ctx.lang !== '') args.push('--lang', ctx.lang);
  const run = runChild(ctx, toolPath(ctx, 'analyze'), args);
  const parsed = asObject(parseJsonValue(run.stdout));
  const pct = parsed ? num(parsed.autoConvertiblePct) : null;
  if (parsed && pct !== null) {
    const files = num(parsed.files);
    const totalLoc = num(parsed.totalLoc);
    const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : '?';
    const summary = '可自动转写 ' + pct + '%（' + (files ?? '?') + ' 文件 / ' + (totalLoc ?? '?') +
      ' 行）[' + verdict + ']';
    return outcomeFromRun(run, summary, {
      files: files ?? 0,
      totalLoc: totalLoc ?? 0,
      autoConvertiblePct: pct,
      verdict,
    });
  }
  const summary = statusOf(run) === 'PASS'
    ? '分诊完成（未解析到摘要，见日志）'
    : '分诊失败：' + failureDetail(run);
  return outcomeFromRun(run, summary);
}

function runAdapt(ctx: Ctx): StageOutcome {
  const args = [
    '--src', ctx.adaptSrc as string,
    '--out', opt(ctx, 'adapted') as string,
    '--report', ctx.adaptReport,
  ];
  if (ctx.ets) args.push('--ets');
  // fail-closed：默认让 adapt-arkts 在 residual>0 时以 exit 3 失败；--allow-residuals 显式放宽
  if (!ctx.allowResiduals) args.push('--fail-on-residual');
  const run = runChild(ctx, toolPath(ctx, 'adapt'), args);
  const report = asObject(readJsonFile(ctx.adaptReport));
  const summary = report ? asObject(report.summary) : null;
  const filesScanned = summary ? num(summary.filesScanned) : null;
  const filesChanged = summary ? num(summary.filesChanged) : null;
  const rawResiduals = summary ? summary.residuals : null;
  const residuals = Array.isArray(rawResiduals) ? rawResiduals.length : num(rawResiduals);
  const metrics: Record<string, number | string> = {};
  if (filesScanned !== null) metrics.filesScanned = filesScanned;
  if (filesChanged !== null) metrics.filesChanged = filesChanged;
  if (residuals !== null) metrics.residuals = residuals;
  let text: string;
  let status = statusOf(run);
  if (status === 'FAIL') {
    text = (residuals !== null && residuals > 0)
      ? '适配有残留 ' + residuals + ' 处（exit ' + run.exitCode + '，默认严格模式；修掉或加 --allow-residuals）'
      : '适配失败：' + failureDetail(run);
  } else if (filesScanned === 0) {
    // 扫描 0 个文件几乎一定是路径指错了（比如给了上游 Kotlin 目录），不能算 PASS
    status = 'FAIL';
    text = '扫描 0 个 .ts/.ets 文件（--src/--adapt-src 可能不是 TS 转写产物目录）';
  } else if (residuals !== null && residuals > 0 && ctx.allowResiduals) {
    // 显式放宽：PASS 时必须写「已放行」，不能出现「残留」与 PASS 自相矛盾
    text = '残留 ' + residuals + ' 处已放行（--allow-residuals）' +
      (filesScanned !== null ? '；扫描 ' + filesScanned + ' 文件' : '');
  } else if (residuals !== null && residuals > 0) {
    // 防御：child 没按 --fail-on-residual 返回 3 时也不能放行
    status = 'FAIL';
    text = '适配有残留 ' + residuals + ' 处（默认严格模式；修掉或加 --allow-residuals）';
  } else if (summary !== null && filesScanned !== null && filesChanged !== null) {
    text = '扫描 ' + filesScanned + ' 文件，改动 ' + filesChanged + ' 文件，残留 ' +
      (residuals ?? 0) + ' 处';
  } else {
    text = '适配完成（未读到 ' + relPath(ctx, ctx.adaptReport) + ' 摘要，见日志）';
  }
  return {
    status,
    exitCode: run.exitCode,
    summary: text,
    metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
    commands: [run.command],
    notes: [],
    output: run.output,
  };
}

function runDiff(ctx: Ctx): StageOutcome {
  const before = ctx.adaptSrc as string;
  const after = opt(ctx, 'adapted') as string;
  const run = runChild(ctx, toolPath(ctx, 'diff'), ['--before', before, '--after', after, '--json']);
  const parsed = asObject(parseJsonValue(run.stdout));
  const counts = parsed ? asObject(parsed.counts) : null;
  const typeOnly = counts ? num(counts.typeOnly) : null;
  const importPath = counts ? num(counts.importPath) : null;
  const needsReview = counts ? num(counts.needsReview) : null;
  const cannotPair = counts ? num(counts.cannotPair) : null;
  const detail = (typeOnly !== null ? 'type-only ' + typeOnly : 'type-only ?') +
    ' / import-path ' + (importPath ?? '?') +
    ' / needs-review ' + (needsReview ?? '?') +
    ' / 无法配对 ' + (cannotPair ?? '?');

  let status: StageStatus;
  if (run.timedOut || run.spawnError || run.signal) status = 'FAIL';
  else if (run.exitCode === 0) status = 'PASS';
  else if (run.exitCode === 3) status = ctx.strictDiff ? 'FAIL' : 'WARN';
  else status = 'FAIL';

  let text: string;
  if (status === 'PASS') {
    text = '0 needs-review（适配只动类型层）；' + detail;
  } else if (run.exitCode === 3 && ctx.strictDiff) {
    text = '有 ' + (needsReview ?? '?') + ' 处 needs-review（--strict-diff 视为失败）；' + detail;
  } else if (status === 'WARN') {
    text = (needsReview ?? '?') + ' 处 needs-review（只告警，不阻断后续阶段）；' + detail;
  } else {
    text = '告警门禁失败：' + failureDetail(run);
  }

  const metrics: Record<string, number | string> = {};
  if (typeOnly !== null) metrics.typeOnly = typeOnly;
  if (importPath !== null) metrics.importPath = importPath;
  if (needsReview !== null) metrics.needsReview = needsReview;
  if (cannotPair !== null) metrics.cannotPair = cannotPair;
  if (status === 'WARN') metrics.verdict = 'WARN';
  if (ctx.strictDiff) metrics.strictDiff = 'true';

  return {
    status,
    exitCode: run.exitCode,
    summary: text,
    metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
    commands: [run.command],
    notes: [],
    output: run.output,
  };
}

function runFidelity(ctx: Ctx): StageOutcome {
  const caseArg = opt(ctx, 'case') as string;
  const caseAbs = resolve(ctx.cwd, caseArg);
  const golden = join(caseArg, 'golden.json');
  const notes: string[] = [];
  const commands: string[] = [];
  let actual: string | null = opt(ctx, 'actual');
  let actualLabel = '--actual';
  let replayFallback = false;
  if (actual === null) {
    const caseActual = join(caseArg, 'actual.json');
    const hasCaseActual = isFile(join(caseAbs, 'actual.json'));
    const replayTs = join(caseAbs, 'replay.ts');
    if (ctx.replay && isFile(replayTs)) {
      const replayRun = runChild(ctx, replayTs, []);
      commands.push(replayRun.command);
      const stderrLines = replayRun.stderr.trim() === '' ? 0 : replayRun.stderr.trim().split('\n').length;
      if (stderrLines > 0) {
        notes.push('replay stderr ' + stderrLines + ' 行（只进日志，不参与解析）');
      }
      // 只解析/落盘 stdout：Node 的警告（stderr）不能让重放假 SKIP/假 FAIL
      const replayed = replayRun.exitCode === 0 ? parseJsonValue(replayRun.stdout) : null;
      if (replayRun.exitCode === 0 && replayed !== null) {
        writeFileSync(ctx.replayOut, replayRun.stdout, 'utf8');
        actual = ctx.replayOut;
        actualLabel = 'replay.ts';
        notes.push('先重放 replay.ts → ' + relPath(ctx, ctx.replayOut));
      } else {
        const detail = replayRun.exitCode === 0
          ? '输出不是合法 JSON'
          : failureDetail(replayRun);
        notes.push('重放 replay.ts 失败（' + oneLine(detail, 120) + '），回退 ' + join(caseArg, 'actual.json'));
        if (hasCaseActual) {
          actual = caseActual;
          actualLabel = 'case/actual.json';
          replayFallback = true;
        }
      }
    } else if (hasCaseActual) {
      actual = caseActual;
      actualLabel = 'case/actual.json';
    }
  }
  if (actual === null) {
    return {
      status: 'SKIP',
      exitCode: null,
      summary: '无可用 actual：replay.ts 重放失败，且缺少 ' + join(caseArg, 'actual.json'),
      commands,
      notes,
      output: notes.join('\n') + '\n',
    };
  }
  const run = runChild(ctx, toolPath(ctx, 'fidelity'), ['--golden', golden, '--actual', actual, '--json']);
  commands.push(run.command);
  const parsed = asObject(parseJsonValue(run.stdout));
  const pct = parsed ? num(parsed.fidelityPct) : null;
  const childPass = parsed !== null && typeof parsed.pass === 'boolean' ? parsed.pass : null;
  const status = statusWithChildPass(run, childPass);
  let text: string;
  let metrics: Record<string, number | string> | undefined;
  if (parsed && pct !== null) {
    const sameItems = num(parsed.sameItems);
    const totalItems = num(parsed.totalItems);
    const sameScenarios = num(parsed.sameScenarios);
    const totalScenarios = num(parsed.totalScenarios);
    const missing = num(parsed.missingScenarios) ??
      asArray(parsed.details).filter((item) => asObject(item)?.status === 'missing').length;
    if (status === 'PASS') {
      text = '保真度 ' + pct + '%（' + (sameItems ?? '?') + '/' + (totalItems ?? '?') + ' 页）' +
        '，场景全等 ' + (sameScenarios ?? '?') + '/' + (totalScenarios ?? '?') +
        '，actual=' + actualLabel + (replayFallback ? '（replay 失败已回退）' : '');
    } else if (missing > 0) {
      // FAIL 时不能显示「保真度 100%」：缺场景是独立失败原因
      text = 'FAIL：缺失 ' + missing + ' 场景（已匹配项逐项 ' + pct + '%）' +
        '，actual=' + actualLabel;
    } else {
      text = 'FAIL：保真度 ' + pct + '%（' + (sameItems ?? '?') + '/' + (totalItems ?? '?') + ' 页）' +
        '，场景全等 ' + (sameScenarios ?? '?') + '/' + (totalScenarios ?? '?') +
        '，actual=' + actualLabel + (replayFallback ? '（replay 失败已回退）' : '');
    }
    metrics = {
      fidelityPct: pct,
      sameItems: sameItems ?? 0,
      totalItems: totalItems ?? 0,
      actualSource: actualLabel,
    };
    if (missing > 0) metrics.missingScenarios = missing;
    if (replayFallback) metrics.replayFallback = 'true';
  } else {
    text = status === 'PASS'
      ? '保真度门禁通过（未解析到摘要，见日志）'
      : '保真度未达标：' + failureDetail(run);
  }
  return { status, exitCode: run.exitCode, summary: text, metrics, commands, notes, output: run.output };
}

// ---------------------------------------------------------------------------
// lint/reach FAIL 时自动 explain-errors：只补充定位信息，不改变门禁 PASS/FAIL
// ---------------------------------------------------------------------------

interface ExplainEntry {
  rule: string;
  file: string;
  line: number | null;
  message: string | null;
  level: string | null;
}

/** 挑 explain-errors 的输入：优先把子工具 JSON 里的 errors 落成 <logs>/<stage>-errors.json；否则用已有阶段日志 */
function explainLogFor(ctx: Ctx, stageName: StageName, parsed: Record<string, unknown> | null): string | null {
  if (parsed !== null && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const path = join(ctx.logsDir, stageName + '-errors.json');
    try {
      writeFileSync(path, JSON.stringify(parsed.errors, null, 2) + '\n', 'utf8');
      return path;
    } catch {
      // 写不进就退回阶段日志
    }
  }
  const stageLog = join(ctx.logsDir, stageName + '.log');
  if (isFile(stageLog)) return stageLog;
  return null;
}

function attachExplain(ctx: Ctx, stageName: StageName, outcome: StageOutcome, parsed: Record<string, unknown> | null): void {
  if (!ctx.explain || outcome.status !== 'FAIL') return;
  const logPath = explainLogFor(ctx, stageName, parsed);
  const metrics = outcome.metrics ?? {};
  if (logPath === null) {
    outcome.metrics = { ...metrics, explain: { ok: false, max: ctx.explainMax, reason: '未找到阶段日志/错误 JSON，跳过 explain' } };
    outcome.extraLines = [...(outcome.extraLines ?? []), '      ↳ explain 跳过：未找到可解析日志（不改变门禁结论）'];
    outcome.notes.push('explain 跳过：未找到可解析日志');
    return;
  }
  const project = opt(ctx, 'project') ?? '';
  const rootAbs = resolve(ctx.cwd, project, ctx.etsSrc);
  const run = runChild(ctx, join(ctx.cliDir, 'explain-errors.ts'), [
    '--log', logPath,
    '--root', rootAbs,
    '--max', String(ctx.explainMax),
    '--json',
  ]);
  outcome.commands.push(run.command);
  const explainLog = relPath(ctx, logPath);
  const report = asObject(parseJsonValue(run.stdout));
  if (run.exitCode !== 0 || report === null || !Array.isArray(report.errors)) {
    outcome.metrics = {
      ...metrics,
      explain: {
        ok: false,
        max: ctx.explainMax,
        log: explainLog,
        error: oneLine(run.stderr.trim() !== '' ? run.stderr : run.stdout, 160),
      },
    };
    outcome.extraLines = [...(outcome.extraLines ?? []), '      ↳ explain WARN：explain-errors 未成功（见 ' + explainLog + '）'];
    outcome.notes.push('explain 自身失败，只记 WARN，不改变门禁结论');
    return;
  }
  const all = report.errors as unknown[];
  const total = num(report.total) ?? all.length;
  const entries: ExplainEntry[] = [];
  for (const item of all.slice(0, ctx.explainMax)) {
    const record = asObject(item);
    if (record === null) continue;
    const rule = String(record.rule ?? record.code ?? '?');
    const file = String(record.sourcePath ?? record.file ?? '?');
    const line = num(record.line);
    const message = typeof record.message === 'string' ? record.message : null;
    const level = typeof record.level === 'string' ? record.level : null;
    entries.push({ rule, file, line, message, level });
  }
  outcome.metrics = {
    ...metrics,
    explain: {
      ok: true,
      total,
      max: ctx.explainMax,
      log: explainLog,
      rules: Array.isArray(report.rules) ? report.rules.slice(0, ctx.explainMax) : [],
      top: entries,
    },
  };
  const lines = entries.slice(0, 3).map((entry) => {
    const location = entry.line === null ? entry.file : entry.file + ':' + entry.line;
    return '      ↳ ' + entry.rule + '  ' + location + (entry.message !== null ? '  ' + oneLine(entry.message, 90) : '');
  });
  if (lines.length === 0) lines.push('      ↳ explain：0 条错误（见 ' + explainLog + '）');
  outcome.extraLines = lines;
  outcome.notes.push('explain：' + total + ' 条错误（top ' + entries.length + '，--explain-max ' + ctx.explainMax + '）');
}

function runLint(ctx: Ctx): StageOutcome {
  const project = opt(ctx, 'project') as string;
  const args = ['--project', project, '--sdk', ctx.sdk, '--hvigor', ctx.hvigor, '--json'];
  const run = runChild(ctx, toolPath(ctx, 'lint'), args);
  const parsed = asObject(parseJsonValue(run.stdout));
  const childPass = parsed !== null && typeof parsed.pass === 'boolean' ? parsed.pass : null;
  const jsonErrors = parsed ? num(parsed.arktsErrors) : null;
  const warnErrors = parsed ? num(parsed.warnArktsErrors) : null;
  // 中文标签解析保留作兜底（旧版子工具没有 --json 时）
  const errors = jsonErrors ?? matchInt(run.output, /ArkTS 错误数:\s*(\d+)/);
  const status = statusWithChildPass(run, childPass);
  let text: string;
  let metrics: Record<string, unknown> | undefined;
  if (errors !== null) {
    text = 'ArkTS 错误 ' + errors + (warnErrors !== null && warnErrors > 0 ? '（其中 WARN 级 ' + warnErrors + '）' : '');
    metrics = { arktsErrors: errors };
    if (warnErrors !== null && warnErrors > 0) metrics.warnArktsErrors = warnErrors;
  } else if (status === 'PASS') {
    text = '构建通过（未解析到错误数，见日志）';
  } else {
    text = '编译失败：' + failureDetail(run);
  }
  const outcome: StageOutcome = { status, exitCode: run.exitCode, summary: text, metrics, commands: [run.command], notes: [], output: run.output };
  attachExplain(ctx, 'lint', outcome, parsed);
  return outcome;
}

function runReach(ctx: Ctx): StageOutcome {
  const project = opt(ctx, 'project') as string;
  const args = [
    '--project', project,
    '--src', ctx.etsSrc,
    '--entry', ctx.entry,
    '--sdk', ctx.sdk,
    '--hvigor', ctx.hvigor,
  ];
  args.push('--json');
  const run = runChild(ctx, toolPath(ctx, 'reach'), args);
  const parsed = asObject(parseJsonValue(run.stdout));
  const childPass = parsed !== null && typeof parsed.pass === 'boolean' ? parsed.pass : null;
  const jsonModules = parsed ? num(parsed.probeModules) : null;
  const jsonErrors = parsed ? num(parsed.arktsErrors) : null;
  const warnErrors = parsed ? num(parsed.warnArktsErrors) : null;
  const modules = jsonModules ?? matchInt(run.output, /探针模块数:\s*(\d+)/);
  const errors = jsonErrors ?? matchInt(run.output, /ArkTS 错误数:\s*(\d+)/);
  const status = statusWithChildPass(run, childPass);
  let text: string;
  let metrics: Record<string, unknown> | undefined;
  if (modules !== null || errors !== null) {
    text = '探针模块 ' + (modules ?? '?') + '，ArkTS 错误 ' + (errors ?? '?') +
      (warnErrors !== null && warnErrors > 0 ? '（其中 WARN 级 ' + warnErrors + '）' : '');
    metrics = {};
    if (modules !== null) metrics.probeModules = modules;
    if (errors !== null) metrics.arktsErrors = errors;
    if (warnErrors !== null && warnErrors > 0) metrics.warnArktsErrors = warnErrors;
  } else if (status === 'PASS') {
    text = '全量可达检查通过（未解析到摘要，见日志）';
  } else {
    text = '全量可达检查失败：' + failureDetail(run);
  }
  const outcome: StageOutcome = { status, exitCode: run.exitCode, summary: text, metrics, commands: [run.command], notes: [], output: run.output };
  attachExplain(ctx, 'reach', outcome, parsed);
  return outcome;
}

function runBuild(ctx: Ctx): StageOutcome {
  const project = opt(ctx, 'project') as string;
  const args = [
    '--project', project,
    '--mode', ctx.mode,
    '--sdk', ctx.sdk,
    '--hvigor', ctx.hvigor,
  ];
  const run = runChild(ctx, toolPath(ctx, 'build'), args);
  const status = statusOf(run);
  const success = /BUILD SUCCESSFUL/.test(run.stdout);
  let text: string;
  if (status === 'PASS') {
    text = success ? 'BUILD SUCCESSFUL' : '构建完成（未匹配到 BUILD SUCCESSFUL，见日志）';
  } else {
    text = '构建失败：' + failureDetail(run);
  }
  return outcomeFromRun(run, text);
}

function runDevice(ctx: Ctx): StageOutcome {
  const logFile = join(ctx.logsDir, 'device-test.log');
  const args = ['--target', ctx.device, '--json', '--log', logFile];
  if (ctx.hdc !== '') args.push('--hdc', ctx.hdc);
  if (ctx.deviceTimeoutMs !== null) args.push('--timeout', String(ctx.deviceTimeoutMs));
  const installMode = ctx.signedHap !== '';
  if (!installMode) {
    args.push('--check');
  } else {
    args.push(
      '--hap', ctx.signedHap,
      '--install',
      '--bundle', ctx.bundle,
      '--ability', ctx.ability,
      '--screenshot', join(ctx.logsDir, 'device.jpeg'),
    );
  }
  const run = runChild(ctx, toolPath(ctx, 'device'), args);
  const status = statusOf(run);
  const parsed = asObject(parseJsonValue(run.stdout));
  const metrics: Record<string, unknown> = {
    target: ctx.device,
    mode: installMode ? 'install' : 'check-only',
  };
  let checkModel: string | null = null;
  if (parsed !== null) {
    const check = asObject(parsed.check);
    if (check !== null) {
      metrics.checkOk = check.ok === true;
      if (typeof check.message === 'string') metrics.checkMessage = oneLine(check.message, 120);
      if (typeof check.model === 'string') checkModel = check.model;
    }
    const install = asObject(parsed.install);
    if (install !== null && typeof install.status === 'string') metrics.installStatus = install.status;
    const launch = asObject(parsed.launch);
    if (launch !== null && typeof launch.status === 'string') metrics.launchStatus = launch.status;
    const screenshot = asObject(parsed.screenshot);
    if (screenshot !== null) {
      if (typeof screenshot.status === 'string') metrics.screenshotStatus = screenshot.status;
      if (typeof screenshot.path === 'string') metrics.screenshotPath = screenshot.path;
    }
    if (typeof parsed.logPath === 'string') metrics.deviceLog = parsed.logPath;
  }
  let text: string;
  if (status === 'PASS') {
    if (!installMode) {
      text = 'device check OK（' + ctx.device + (checkModel !== null ? '，' + checkModel : '') + '）';
    } else {
      const launchStatus = typeof metrics.launchStatus === 'string' ? metrics.launchStatus : '?';
      const shotStatus = typeof metrics.screenshotStatus === 'string' ? metrics.screenshotStatus : '?';
      text = 'install OK（' + ctx.bundle + '/' + ctx.ability + '）+ launch ' + launchStatus + ' + 截图 ' + shotStatus;
    }
  } else if (run.exitCode === EXIT_USAGE) {
    text = 'device-test 用法/前置错误：' + failureDetail(run) + '（检查 --hdc/$HDC/SDK toolchains/hdc 是否可用）';
  } else {
    text = 'device-test 失败：' + failureDetail(run);
  }
  return { status, exitCode: run.exitCode, summary: text, metrics, commands: [run.command], notes: [], output: run.output };
}

const STAGE_RUN: Record<StageName, (ctx: Ctx) => StageOutcome> = {
  analyze: runAnalyze,
  adapt: runAdapt,
  diff: runDiff,
  fidelity: runFidelity,
  lint: runLint,
  reach: runReach,
  build: runBuild,
  device: runDevice,
};

// ---------------------------------------------------------------------------
// 执行与报告
// ---------------------------------------------------------------------------

function composeLog(ctx: Ctx, stageName: StageName, outcome: StageOutcome, durationMs: number): string {
  const lines: string[] = [
    '# arkts-port 阶段: ' + stageName + '（' + STAGE_TITLE[stageName] + '）',
    '# 状态: ' + outcome.status,
  ];
  for (const command of outcome.commands) lines.push('# 命令: ' + command);
  lines.push('# cwd: ' + ctx.cwd);
  lines.push('# 退出码: ' + (outcome.exitCode === null ? '-' : String(outcome.exitCode)));
  lines.push('# 耗时: ' + durationMs + 'ms');
  for (const note of outcome.notes) lines.push('# ' + note);
  const body = outcome.output;
  const tail = body === '' || body.endsWith('\n') ? '' : '\n';
  return lines.join('\n') + '\n---\n' + body + tail;
}

function writeLog(logPath: string, content: string): void {
  try {
    writeFileSync(logPath, content, 'utf8');
  } catch (error) {
    console.error('port: 无法写入日志 ' + logPath + '：' + errorMessage(error));
    process.exit(EXIT_USAGE);
  }
}

function executeStage(ctx: Ctx, stageName: StageName): StageResult {
  const logPath = join(ctx.logsDir, stageName + '.log');
  const skipReason = STAGE_PREREQ[stageName](ctx);
  if (skipReason !== null) {
    writeLog(logPath, [
      '# arkts-port 阶段: ' + stageName + '（' + STAGE_TITLE[stageName] + '）',
      '# 状态: SKIP',
      '# 原因: ' + skipReason,
      '# 命令: 未执行',
      '',
    ].join('\n'));
    return {
      name: stageName,
      status: 'SKIP',
      exitCode: null,
      durationMs: 0,
      summary: skipReason,
      logPath: relPath(ctx, logPath),
    };
  }
  const startedAt = Date.now();
  let outcome: StageOutcome;
  try {
    outcome = STAGE_RUN[stageName](ctx);
  } catch (error) {
    outcome = {
      status: 'FAIL',
      exitCode: null,
      summary: '编排器异常：' + errorMessage(error),
      commands: [],
      notes: [],
      output: '# 编排器异常\n' + (error instanceof Error && error.stack ? error.stack : errorMessage(error)) + '\n',
    };
  }
  const durationMs = Date.now() - startedAt;
  writeLog(logPath, composeLog(ctx, stageName, outcome, durationMs));
  const result: StageResult = {
    name: stageName,
    status: outcome.status,
    exitCode: outcome.exitCode,
    durationMs,
    summary: oneLine(outcome.summary, 400),
    logPath: relPath(ctx, logPath),
  };
  if (outcome.metrics && Object.keys(outcome.metrics).length > 0) result.metrics = outcome.metrics;
  if (outcome.extraLines !== undefined && outcome.extraLines.length > 0) result.extraLines = outcome.extraLines;
  return result;
}

function formatDuration(durationMs: number): string {
  return (durationMs / 1000).toFixed(2) + 's';
}

function formatStageLine(result: StageResult): string {
  const parts: string[] = [result.status.padEnd(4), result.name.padEnd(8), oneLine(result.summary, 150)];
  if (result.exitCode !== null && result.exitCode !== 0) parts.push('[exit ' + result.exitCode + ']');
  if (result.status !== 'SKIP') parts.push(formatDuration(result.durationMs));
  parts.push(result.logPath);
  return parts.join('  ').replace(/\s+$/, '');
}

function countByStatus(results: StageResult[], status: StageStatus): number {
  return results.filter((result) => result.status === status).length;
}

function buildReport(ctx: Ctx, results: StageResult[], remaining: StageName[], stoppedEarly: boolean) {
  const counts = {
    pass: countByStatus(results, 'PASS'),
    warn: countByStatus(results, 'WARN'),
    fail: countByStatus(results, 'FAIL'),
    skip: countByStatus(results, 'SKIP'),
  };
  // WARN 只告警：不改变 pass 真值（PASS/WARN 都算通过；SKIP 不算通过）
  const pass = counts.fail === 0 && counts.skip === 0 && counts.pass + counts.warn > 0;
  return {
    stages: results,
    pass,
    counts,
    requested: ctx.stages,
    stoppedEarly,
    remaining,
  };
}

function writeReport(reportPath: string, report: unknown): void {
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error('port: 无法写入报告 ' + reportPath + '：' + errorMessage(error));
    process.exit(EXIT_USAGE);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main(): void {
  const raw = parseCliArgs(process.argv.slice(2));
  if (raw.help) {
    console.log(USAGE);
    process.exit(EXIT_PASS);
  }

  const selfPath = fileURLToPath(import.meta.url);
  const cliDir = dirname(selfPath);
  const cwd = process.cwd();
  const device = optional(raw, 'device') ?? '';
  const signedHap = optional(raw, 'signed-hap') ?? '';
  const bundle = optional(raw, 'bundle') ?? '';
  const ability = optional(raw, 'ability') ?? 'EntryAbility';
  const hdc = optional(raw, 'hdc') ?? '';

  // device 阶段默认不启用：相关参数离开 --device 就没有意义，直接 fail-closed
  if (device === '') {
    const orphan: string[] = [];
    if (raw['signed-hap'] !== undefined) orphan.push('--signed-hap');
    if (raw.bundle !== undefined) orphan.push('--bundle');
    if (raw.ability !== undefined) orphan.push('--ability');
    if (raw.hdc !== undefined) orphan.push('--hdc');
    if (raw['device-timeout'] !== undefined) orphan.push('--device-timeout');
    if (orphan.length > 0) {
      failUsage(orphan.join('/') + ' 需要 --device <ip:port>（device 阶段默认不启用）');
    }
  }
  if (signedHap !== '' && bundle === '') {
    failUsage('--signed-hap（install+launch）需要 --bundle <bundleName>；只做连接检查请去掉 --signed-hap');
  }
  let deviceTimeoutMs: number | null = null;
  const deviceTimeoutRaw = optional(raw, 'device-timeout');
  if (deviceTimeoutRaw !== null) {
    const parsedDeviceTimeout = Number(deviceTimeoutRaw);
    if (!Number.isInteger(parsedDeviceTimeout) || parsedDeviceTimeout < 0) {
      failUsage('--device-timeout 必须是非负整数（毫秒；0=不超时）：' + deviceTimeoutRaw);
    }
    deviceTimeoutMs = parsedDeviceTimeout;
  }

  const stages = resolveStages(raw, device !== '');

  const mode = optional(raw, 'mode') ?? 'debug';
  if (mode !== 'debug' && mode !== 'release') failUsage('--mode 只能是 debug 或 release：' + mode);

  let timeoutMs = 0;
  const timeoutRaw = optional(raw, 'timeout');
  if (timeoutRaw !== null) {
    const parsed = Number(timeoutRaw);
    if (!Number.isInteger(parsed) || parsed < 0) failUsage('--timeout 必须是非负整数（毫秒）：' + timeoutRaw);
    timeoutMs = parsed;
  }

  let explainMax = 5;
  const explainMaxRaw = optional(raw, 'explain-max');
  if (explainMaxRaw !== null) {
    const parsedExplainMax = Number(explainMaxRaw);
    if (!Number.isInteger(parsedExplainMax) || parsedExplainMax < 1) {
      failUsage('--explain-max 必须是正整数（默认 5）：' + explainMaxRaw);
    }
    explainMax = parsedExplainMax;
  }
  const explain = raw['no-explain'] !== true;

  const etsSrc = optional(raw, 'ets-src') ?? 'entry/src/main/ets';
  if (isAbsolute(etsSrc)) failUsage('--ets-src 必须是工程内相对路径：' + etsSrc);
  const entry = optional(raw, 'entry') ?? 'pages/Index.ets';
  if (isAbsolute(entry)) failUsage('--entry 必须是工程内相对路径：' + entry);

  const adaptSrc = optional(raw, 'adapt-src') ?? optional(raw, 'src');

  let lang = '';
  const langRaw = optional(raw, 'lang');
  if (langRaw !== null) {
    const langsPath = join(cliDir, '..', 'adapters', 'languages.json');
    const langs = asObject(readJsonFile(langsPath));
    if (langs !== null) {
      if (!(langRaw in langs)) {
        failUsage('未知语言：' + langRaw + '（可用：' + Object.keys(langs).join(', ') + '）');
      }
    }
    lang = langRaw;
  }

  const sdk = optional(raw, 'sdk') ?? process.env.OHOS_BASE_SDK_HOME ?? '';
  const hvigor = optional(raw, 'hvigor') ?? process.env.HVIGOR_HOME ?? '';
  const sdkAbs = sdk === '' ? '' : resolve(cwd, sdk);
  const hvigorJs = hvigor === '' ? '' : join(resolve(cwd, hvigor), HVIGOR_BIN);

  const logsDir = resolve(cwd, optional(raw, 'logs') ?? join('out', 'logs'));
  const reportPath = resolve(cwd, optional(raw, 'report') ?? join('out', 'port-report.json'));

  try {
    mkdirSync(logsDir, { recursive: true });
  } catch (error) {
    console.error('port: 无法创建日志目录 ' + logsDir + '：' + errorMessage(error));
    process.exit(EXIT_USAGE);
  }

  const ctx: Ctx = {
    cliDir,
    cwd,
    raw,
    stages,
    doContinue: raw['continue'] === true,
    logsDir,
    reportPath,
    sdk,
    sdkAbs,
    hvigor,
    hvigorJs,
    mode,
    timeoutMs,
    ets: raw['no-ets'] !== true,
    replay: raw['no-replay'] !== true,
    etsSrc,
    entry,
    lang,
    adaptSrc,
    allowResiduals: raw['allow-residuals'] === true,
    strictDiff: raw['strict-diff'] === true,
    replayOut: join(logsDir, 'fidelity-replay.json'),
    adaptReport: join(logsDir, 'adapt-report.json'),
    explain,
    explainMax,
    device,
    signedHap,
    bundle,
    ability,
    hdc,
    deviceTimeoutMs,
  };

  const results: StageResult[] = [];
  const remaining: StageName[] = [];
  let stoppedEarly = false;
  for (const stageName of stages) {
    if (stoppedEarly) {
      remaining.push(stageName);
      continue;
    }
    const result = executeStage(ctx, stageName);
    results.push(result);
    if (result.status === 'FAIL' && !ctx.doContinue) stoppedEarly = true;
  }

  const report = buildReport(ctx, results, remaining, stoppedEarly);
  writeReport(reportPath, report);

  if (raw.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const counts = report.counts;
    const summaryLines: string[] = [];
    summaryLines.push(
      'arkts-port 门禁  stages=' + stages.join(',') + '  cwd=' + cwd,
    );
    for (const result of results) {
      summaryLines.push(formatStageLine(result));
      if (result.extraLines !== undefined) {
        for (const line of result.extraLines.slice(0, 3)) summaryLines.push(line);
      }
    }
    if (stoppedEarly) {
      const tail = remaining.length > 0 ? '；未运行：' + remaining.join(',') : '';
      summaryLines.push('已停止：遇到 FAIL 未继续（--continue 可继续）' + tail);
    }
    const verdict = report.pass
      ? (counts.warn > 0 ? 'PASS（含 WARN）' : 'PASS')
      : (counts.fail > 0 ? 'FAIL' : 'INCOMPLETE');
    summaryLines.push(
      '结果：' + verdict + '（PASS ' + counts.pass + ' / WARN ' + counts.warn + ' / FAIL ' + counts.fail +
      ' / SKIP ' + counts.skip + '）  报告：' + relPath(ctx, reportPath),
    );
    console.log(summaryLines.join('\n'));
  }

  process.exit(report.pass ? EXIT_PASS : EXIT_FAIL);
}

main();
