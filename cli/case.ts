#!/usr/bin/env node
/**
 * cli/case.ts —— 通用 case runner（契约见 docs/case-runner.md）。
 *
 * 只做编排/聚合，不复制断言：
 *   - stages 模式：按清单 argv 顺序 spawn 现有 CLI；PASS/FAIL 以退出码 + 清单 expect.exit 为准；
 *   - runner 模式：整案委托 case 自带 run.mjs；整体 PASS/FAIL 信 runner 的 evidence.pass 与 gates[].status。
 * 报告 schema 对齐 port：{stages, pass, counts, requested, stoppedEarly, remaining}。
 *
 * 退出码（三态）：
 *   0 = 请求的 stage 全 PASS/WARN（SKIP 只允许出现在 optional:true 的 stage）
 *   1 = 任一 stage FAIL（含超时/spawn 失败）
 *   2 = 用法错误 / 清单非法 / 未知 case 或 stage / --update 不被支持
 *   3 = 无 FAIL，但至少一个非 optional stage 因外部前置缺失（refs/SDK/hvigor/device/upstream）SKIP
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = join(repoRoot, 'cases');
const DEFAULT_REFS = '/mnt/d/Project/legado-with-MD3/.refs';
const DEFAULT_SDK = '/mnt/d/Project/legado-with-MD3/.ohos-sdk/linux';
const DEFAULT_HVIGOR = '/mnt/d/Project/legado-with-MD3/.ohos-tools/node_modules';
const DEFAULT_REPORT = join('out', 'case-report.json');
const LOGS_DIR = join('out', 'logs');
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_READY = 3;
const HUMAN_MAX_LINES = 15;
const PLACEHOLDER = /\$\{([a-z]+)\}/g;

const USAGE = [
  '用法：',
  '  node cli/case.ts --case <id|dir> [--stage all|<name>[,<name>...]]',
  '                   [--list] [--json] [--report <path.json>] [--update]',
  '                   [--refs <dir>] [--sdk <p>] [--hvigor <p>] [--device <ip:port>]',
  '                   [--continue] [--timeout <ms>] [--case-arg <arg>]... [--help]',
  '',
  '  --case <id|dir>   案例 id（如 js-ts）或目录（如 cases/legado）',
  '  --stage <list>    默认 all；按清单顺序执行子集；未知 stage → exit 2',
  '  --list            列出发现到的 case（id/mode/stages/是否就绪），不执行',
  '  --json            stdout 只输出统一报告 JSON（与 --report 一致）',
  '  --report <path>   报告路径（默认 ' + DEFAULT_REPORT + '）',
  '  --update          仅 runner 模式支持时透传（更新 golden/actual）；stages 模式 → exit 2',
  '  --refs <dir>      外部证据根（优先于 $ARKTS_PORT_CASE_REFS 与清单默认值）',
  '  --sdk/--hvigor    透传；缺省读 $OHOS_BASE_SDK_HOME / $HVIGOR_HOME',
  '  --device <ip:port> 仅当清单 argv 使用占位符 device 时生效（当前三 case 不消费）',
  '  --continue        FAIL 后继续跑剩余 stage（默认 FAIL 即停）',
  '  --timeout <ms>    单 stage 超时（默认 0 = 不超时），超时记 FAIL',
  '  --case-arg <arg>  透传给 runner 的额外参数（可重复；仅 runner 模式）',
  '',
  '退出码：0 = 全 PASS/WARN（仅 optional SKIP）；1 = FAIL；2 = 用法错误；',
  '        3 = 无 FAIL 但非 optional stage 因外部前置缺失 SKIP',
].join('\n');

interface StageDef {
  name: string;
  title?: string;
  argv: string[];
  optional?: boolean;
  stdoutFile?: string;
  report?: string;
  reportPath?: string;
  expect?: { exit?: number; report?: Record<string, unknown> };
}

interface RunnerDef {
  cmd: string[];
  jsonFlag?: string;
  stageFlag?: string;
  updateFlag?: string;
  stages: string[];
  passthrough?: string[];
  evidence?: string;
}

interface Manifest {
  schemaVersion: number;
  id: string;
  title: string;
  lang: string;
  mode: 'stages' | 'runner';
  upstream?: { paths?: string[]; license?: string; inRepo?: boolean; note?: string };
  external?: { refsEnv?: string; refsDefault?: string };
  defaults?: { sdkEnv?: string; hvigorEnv?: string; deviceEnv?: string };
  runner?: RunnerDef;
  stages?: StageDef[];
  expected?: Record<string, unknown>;
}

interface Args {
  caseArg: string;
  stages: string;
  json: boolean;
  report: string;
  update: boolean;
  refs: string | null;
  sdk: string;
  hvigor: string;
  device: string;
  doContinue: boolean;
  timeoutMs: number;
  caseArgs: string[];
  list: boolean;
}

interface StageResult {
  name: string;
  title: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
  exitCode: number | null;
  durationMs: number;
  summary: string;
  metrics?: Record<string, unknown>;
  logPath: string;
  reportPath?: string;
  optional: boolean;
}

interface Report {
  schemaVersion: 1;
  case: string;
  title: string;
  lang: string;
  mode: 'stages' | 'runner';
  requested: string[];
  stages: StageResult[];
  pass: boolean;
  counts: { pass: number; warn: number; fail: number; skip: number };
  stoppedEarly: boolean;
  remaining: string[];
  refs: string | null;
  sdk: string;
  hvigor: string;
  skippedNonOptional: number;
  skipReason: string | null;
  warnings: string[];
  reportPath: string;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const VALUE_OPTS = new Set(['case', 'stage', 'report', 'refs', 'sdk', 'hvigor', 'device', 'timeout', 'case-arg']);
const BOOL_OPTS = new Set(['list', 'json', 'update', 'continue', 'help']);

function failUsage(message: string): never {
  console.error('case: ' + message);
  console.error('用法见：node cli/case.ts --help');
  process.exit(EXIT_USAGE);
}

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string | boolean> = {};
  const caseArgs: string[] = [];
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
      if (key === 'case-arg') {
        caseArgs.push(value);
        continue;
      }
      if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
      if (value === '') failUsage('--' + key + ' 不能为空');
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
    if (next === undefined || next === '') failUsage('--' + key + ' 缺少取值');
    // --case-arg 的值本身可能就是 --no-fix/--restage 这类 flag
    if (key !== 'case-arg' && next.startsWith('--')) failUsage('--' + key + ' 缺少取值');
    if (key === 'case-arg') caseArgs.push(next);
    else raw[key] = next;
    i++;
  }
  return {
    caseArg: typeof raw.case === 'string' ? raw.case : '',
    stages: typeof raw.stage === 'string' ? raw.stage : 'all',
    json: raw.json === true,
    report: typeof raw.report === 'string' ? raw.report : DEFAULT_REPORT,
    update: raw.update === true,
    refs: typeof raw.refs === 'string' ? raw.refs : null,
    sdk: typeof raw.sdk === 'string' ? raw.sdk : '',
    hvigor: typeof raw.hvigor === 'string' ? raw.hvigor : '',
    device: typeof raw.device === 'string' ? raw.device : '',
    doContinue: raw.continue === true,
    timeoutMs: 0,
    caseArgs,
    list: raw.list === true,
  };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function oneLine(text: string, max = 160): string {
  const clean = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function firstMeaningfulLine(text: string): string {
  const clean = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return oneLine(trimmed, 160);
  }
  return '(无输出)';
}

function relPath(path: string): string {
  const rel = relative(process.cwd(), path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------------------
// case 发现 / 清单校验
// ---------------------------------------------------------------------------

function candidateDirs(value: string): string[] {
  const direct = resolve(process.cwd(), value);
  const named = join(CASES_DIR, value.replace(/^cases[\/]/, ''));
  return [direct, named];
}

function discoverCase(value: string): string {
  for (const candidate of candidateDirs(value)) {
    if (isFile(join(candidate, 'case.json'))) return candidate;
  }
  failUsage('未知 case：' + value + '（找不到 case.json；可用 --list 查看）');
}

function discoverAll(): Array<{ dir: string; manifest: Manifest | null; path: string }> {
  if (!isDirectory(CASES_DIR)) failUsage('cases/ 目录不存在');
  const found: Array<{ dir: string; manifest: Manifest | null; path: string }> = [];
  for (const dirName of readdirSync(CASES_DIR).sort()) {
    const dir = join(CASES_DIR, dirName);
    const manifestPath = join(dir, 'case.json');
    if (!isFile(manifestPath)) continue;
    found.push({ dir, manifest: validateManifest(manifestPath, true), path: manifestPath });
  }
  return found;
}

function validateManifest(manifestPath: string, tolerant: boolean): Manifest | null {
  const raw = readJsonFile(manifestPath);
  const record = asObject(raw);
  if (record === null) return tolerant ? null : failUsage('case.json 不是合法 JSON 对象：' + manifestPath);
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== 1) {
    if (tolerant) return null;
    failUsage('case.json schemaVersion 必须是 1：' + manifestPath);
  }
  const id = typeof record.id === 'string' ? record.id : '';
  const lang = typeof record.lang === 'string' ? record.lang : '';
  const mode = record.mode === 'stages' || record.mode === 'runner' ? record.mode : '';
  if (id === '' || lang === '' || mode === '') {
    if (tolerant) return null;
    failUsage('case.json 缺少 id/lang/mode：' + manifestPath);
  }
  const manifest = record as unknown as Manifest;
  manifest.id = id;
  manifest.lang = lang;
  manifest.mode = mode;
  manifest.title = typeof record.title === 'string' ? record.title : id;
  if (mode === 'runner') {
    const runner = asObject(record.runner);
    if (runner === null || !Array.isArray(runner.cmd) || runner.cmd.length === 0 || !Array.isArray(runner.stages)) {
      if (tolerant) return null;
      failUsage('case.json runner 模式必须有 runner.cmd 与 runner.stages：' + manifestPath);
    }
    manifest.runner = runner as unknown as RunnerDef;
  } else {
    if (!Array.isArray(record.stages) || record.stages.length === 0) {
      if (tolerant) return null;
      failUsage('case.json stages 模式必须有 stages 数组：' + manifestPath);
    }
    for (const stage of record.stages as unknown[]) {
      const item = asObject(stage);
      if (item === null || typeof item.name !== 'string' || !Array.isArray(item.argv)) {
        if (tolerant) return null;
        failUsage('case.json stages[] 每项必须有 name 与 argv 数组：' + manifestPath);
      }
    }
    manifest.stages = record.stages as unknown as StageDef[];
  }
  return manifest;
}

function runnerStages(manifest: Manifest): string[] {
  return manifest.mode === 'runner' && manifest.runner !== undefined ? [...manifest.runner.stages] : [];
}

function stageNames(manifest: Manifest): string[] {
  return manifest.mode === 'runner' ? runnerStages(manifest) : (manifest.stages ?? []).map((stage) => stage.name);
}

function requestedStages(manifest: Manifest, requested: string): string[] {
  const all = stageNames(manifest);
  const lower = all.map((stage) => stage.toLowerCase());
  const pieces = requested.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (pieces.length === 0) failUsage('--stage 不能为空');
  if (pieces.length === 1 && pieces[0].toLowerCase() === 'all') return all;
  const picked = new Set<string>();
  for (const piece of pieces) {
    const index = lower.indexOf(piece.toLowerCase());
    if (index < 0) failUsage('未知 stage：' + piece + '（可用：all 或 ' + all.join(',') + '）');
    picked.add(all[index]);
  }
  return all.filter((stage) => picked.has(stage));
}

// ---------------------------------------------------------------------------
// 外部前置与占位符
// ---------------------------------------------------------------------------

function resolveRefs(manifest: Manifest, args: Args): string | null {
  const external = manifest.external;
  const envName = external?.refsEnv ?? 'ARKTS_PORT_CASE_REFS';
  const envValue = process.env[envName];
  const candidate = args.refs ?? (envValue !== undefined && envValue !== '' ? envValue : null) ?? external?.refsDefault ?? null;
  if (candidate === null) return null;
  const resolved = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  return isDirectory(resolved) ? resolved : null;
}

function resolveSdk(manifest: Manifest, args: Args): string {
  const envName = manifest.defaults?.sdkEnv ?? 'OHOS_BASE_SDK_HOME';
  const fromEnv = process.env[envName];
  if (args.sdk !== '') {
    const resolved = isAbsolute(args.sdk) ? args.sdk : resolve(process.cwd(), args.sdk);
    return isDirectory(resolved) ? resolved : '';
  }
  if (fromEnv !== undefined && fromEnv !== '') {
    const resolved = isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
    return isDirectory(resolved) ? resolved : '';
  }
  return isDirectory(DEFAULT_SDK) ? DEFAULT_SDK : '';
}

function resolveHvigor(manifest: Manifest, args: Args): string {
  const envName = manifest.defaults?.hvigorEnv ?? 'HVIGOR_HOME';
  const fromEnv = process.env[envName];
  if (args.hvigor !== '') {
    const resolved = isAbsolute(args.hvigor) ? args.hvigor : resolve(process.cwd(), args.hvigor);
    return isDirectory(resolved) ? resolved : '';
  }
  if (fromEnv !== undefined && fromEnv !== '') {
    const resolved = isAbsolute(fromEnv) ? fromEnv : resolve(process.cwd(), fromEnv);
    return isDirectory(resolved) ? resolved : '';
  }
  return isDirectory(DEFAULT_HVIGOR) ? DEFAULT_HVIGOR : '';
}

function upstreamReady(manifest: Manifest): { ready: boolean; reason: string | null } {
  const paths = manifest.upstream?.paths;
  if (paths === undefined || paths.length === 0) return { ready: true, reason: null };
  for (const path of paths) {
    const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
    if (existsSync(resolved)) return { ready: true, reason: null };
  }
  return { ready: false, reason: '上游源码缺失：' + paths.join(' 或 ') };
}

function placeholderSkipReason(argv: string[], manifest: Manifest, args: Args, refs: string | null, sdk: string, hvigor: string): string | null {
  const source = argv.join(' ');
  if (source.includes('$' + '{refs}') && refs === null) return '外部证据缺失：--refs / $' + (manifest.external?.refsEnv ?? 'ARKTS_PORT_CASE_REFS');
  if (source.includes('$' + '{sdk}') && sdk === '') return '缺少 SDK：--sdk / $' + (manifest.defaults?.sdkEnv ?? 'OHOS_BASE_SDK_HOME');
  if (source.includes('$' + '{hvigor}') && hvigor === '') return '缺少 hvigor：--hvigor / $' + (manifest.defaults?.hvigorEnv ?? 'HVIGOR_HOME');
  if (source.includes('$' + '{device}') && args.device === '') return '缺少 --device <ip:port>';
  return null;
}

function substitute(value: string, vars: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (match, key: string) => {
    const replacement = vars[key];
    return replacement === undefined ? match : replacement;
  });
}

function looksBinary(command: string): string {
  return /^node(\.exe)?$/.test(command) ? process.execPath : command;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

interface ChildRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  spawnError: string | null;
  command: string;
}

function runProcess(command: string, argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>): ChildRun {
  const startedAt = Date.now();
  const res = spawnSync(looksBinary(command), argv, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    env: Object.assign({}, process.env, env),
  });
  const durationMs = Date.now() - startedAt;
  const error = res.error as { code?: string; message?: string } | null | undefined;
  return {
    exitCode: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    durationMs,
    timedOut: error !== null && error !== undefined && error.code === 'ETIMEDOUT',
    spawnError: error !== null && error !== undefined && error.code !== 'ETIMEDOUT' ? String(error.message ?? error) : null,
    command: [command, ...argv].join(' '),
  };
}

function evaluateExpectReport(expected: Record<string, unknown>, metrics: Record<string, unknown> | null): string[] {
  const mismatches: string[] = [];
  if (metrics === null) return ['报告不可解析'];
  for (const [key, value] of Object.entries(expected)) {
    const actual = metrics[key];
    if (typeof value === 'number' && typeof actual === 'number') {
      if (Math.abs(value - actual) > 1e-9) mismatches.push(key + '=' + String(actual) + '（期望 ' + String(value) + '）');
      continue;
    }
    if (JSON.stringify(actual) !== JSON.stringify(value)) mismatches.push(key + '=' + JSON.stringify(actual) + '（期望 ' + JSON.stringify(value) + '）');
  }
  return mismatches;
}

function runStages(manifest: Manifest, args: Args, refs: string | null, sdk: string, hvigor: string): StageResult[] {
  const requested = requestedStages(manifest, args.stages);
  const stages = (manifest.stages ?? []).filter((stage) => requested.includes(stage.name));
  const vars = { refs: refs ?? '', sdk, hvigor, device: args.device };
  const upstream = upstreamReady(manifest);
  const results: StageResult[] = [];
  const logsDir = join(repoRoot, LOGS_DIR);
  mkdirSync(logsDir, { recursive: true });
  const stoppedAt = (name: string) => results.some((stage) => stage.status === 'FAIL') && !args.doContinue && name !== results[results.length - 1].name;
  for (const stage of stages) {
    const logPath = join(logsDir, 'case-' + manifest.id + '-' + stage.name + '.log');
    const argv = stage.argv.map((item) => substitute(item, vars));
    const optional = stage.optional === true;
    PLACEHOLDER.lastIndex = 0;
    const unresolvedArgv = argv.filter((item) => item.includes('$' + '{'));
    const skip = !upstream.ready ? upstream.reason : placeholderSkipReason(stage.argv, manifest, args, refs, sdk, hvigor);
    if (skip !== null || unresolvedArgv.length > 0) {
      const reason = unresolvedArgv.length > 0 ? '占位符未解析：' + unresolvedArgv[0] : (skip ?? '外部前置缺失');
      writeFileSync(logPath, '# 状态: SKIP\n# 原因: ' + reason + '\n', 'utf8');
      results.push({ name: stage.name, title: stage.title ?? stage.name, status: 'SKIP', exitCode: null, durationMs: 0, summary: 'SKIP：' + reason, logPath: relPath(logPath), optional });
      if (!optional && !args.doContinue) {
        // SKIP 不阻断后续（port 语义相反），继续跑，最终按非 optional SKIP 判 exit 3
      }
      continue;
    }
    const command = argv[0];
    const childArgs = argv.slice(1);
    const run = runProcess(command, childArgs, repoRoot, args.timeoutMs, { ARKTS_PORT_CASE_REFS: refs ?? '' });
    const logLines = ['# 命令: ' + run.command, '# 退出码: ' + String(run.exitCode), '# 耗时: ' + run.durationMs + 'ms', '---', run.stdout, run.stderr];
    writeFileSync(logPath, logLines.join('\n') + '\n', 'utf8');
    if (stage.stdoutFile !== undefined) {
      const target = resolve(repoRoot, stage.stdoutFile);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, run.stdout, 'utf8');
    }
    const expectedExit = stage.expect !== undefined && typeof stage.expect.exit === 'number' ? stage.expect.exit : 0;
    const metricsRaw = parseJsonText(run.stdout);
    const metrics = asObject(metricsRaw);
    let status: StageResult['status'] = 'PASS';
    let summary = []
      .concat(run.stdout.trim() !== '' ? [] : [])
      .join('');
    if (run.timedOut) {
      status = 'FAIL';
      summary = '超时（--timeout ' + args.timeoutMs + 'ms）';
    } else if (run.spawnError !== null) {
      status = 'FAIL';
      summary = '无法启动：' + run.spawnError;
    } else if (run.exitCode !== expectedExit) {
      status = 'FAIL';
      summary = 'exit ' + String(run.exitCode) + '：' + firstMeaningfulLine(run.stderr || run.stdout);
    } else {
      summary = 'exit ' + String(run.exitCode);
    }
    if (status === 'PASS' && stage.expect !== undefined && isObject(stage.expect.report)) {
      const mismatches = evaluateExpectReport(stage.expect.report, metrics);
      if (mismatches.length > 0) {
        status = 'WARN';
        summary += '；期望展示不一致：' + mismatches.join('，') + '（以工具结果为准）';
      } else if (metrics !== null) {
        const parts = Object.keys(stage.expect.report).map((key) => key + '=' + String(metrics[key]));
        summary += '；' + parts.join('，');
      }
    }
    const result: StageResult = {
      name: stage.name,
      title: stage.title ?? stage.name,
      status,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      summary: oneLine(summary, 200),
      metrics: metrics ?? undefined,
      logPath: relPath(logPath),
      optional,
    };
    if (stage.reportPath !== undefined) result.reportPath = relPath(resolve(repoRoot, stage.reportPath));
    results.push(result);
    if (status === 'FAIL' && !args.doContinue) break;
  }
  return results;
}

function readRunnerEvidence(manifest: Manifest): Record<string, unknown> | null {
  const evidence = manifest.runner?.evidence;
  if (evidence === undefined) return null;
  return asObject(readJsonFile(resolve(repoRoot, evidence)));
}

function normalizeGates(evidence: Record<string, unknown>, logPath: string, reportPath: string | null): StageResult[] {
  const gates = Array.isArray(evidence.gates) ? evidence.gates : [];
  const results: StageResult[] = [];
  for (const item of gates) {
    const gate = asObject(item);
    if (gate === null) continue;
    const rawStatus = typeof gate.status === 'string' ? gate.status : '';
    const status: StageResult['status'] = rawStatus === 'FAIL' ? 'FAIL' : rawStatus === 'INFO' ? 'WARN' : rawStatus === 'SKIP' ? 'SKIP' : 'PASS';
    const result: StageResult = {
      name: typeof gate.gate === 'string' ? gate.gate : 'gate',
      title: typeof gate.title === 'string' ? gate.title : (typeof gate.gate === 'string' ? gate.gate : 'gate'),
      status,
      exitCode: null,
      durationMs: 0,
      summary: oneLine(typeof gate.detail === 'string' ? gate.detail : '', 240),
      metrics: asObject(gate.metrics) ?? undefined,
      logPath,
      optional: false,
    };
    if (reportPath !== null) result.reportPath = reportPath;
    results.push(result);
  }
  return results;
}

function runRunner(manifest: Manifest, args: Args, refs: string | null, sdk: string, hvigor: string): StageResult[] {
  const runner = manifest.runner as RunnerDef;
  const requested = requestedStages(manifest, args.stages);
  const singleInvocation = args.stages === 'all';
  const invocations = singleInvocation ? ['all'] : requested;
  const results: StageResult[] = [];
  const logsDir = join(repoRoot, LOGS_DIR);
  mkdirSync(logsDir, { recursive: true });
  const evidencePath = runner.evidence === undefined ? null : resolve(repoRoot, runner.evidence);
  for (const invocation of invocations) {
    const command = runner.cmd[0];
    const argv = [...runner.cmd.slice(1)];
    argv.push(runner.jsonFlag ?? '--json');
    argv.push(runner.stageFlag ?? '--stage', invocation);
    if (args.update) {
      if (runner.updateFlag === undefined) failUsage('case ' + manifest.id + ' 的 runner 不支持 --update');
      argv.push(runner.updateFlag);
    }
    if (sdk !== '') argv.push('--sdk', sdk);
    if (hvigor !== '') argv.push('--hvigor', hvigor);
    for (const extra of args.caseArgs) argv.push(extra);
    const logPath = join(logsDir, 'case-' + manifest.id + '-' + invocation.replace(/[^a-zA-Z0-9_-]/g, '_') + '.log');
    // 防止读到上一次运行的 stale evidence
    if (evidencePath !== null) rmSync(evidencePath, { force: true });
    const run = runProcess(command, argv, repoRoot, args.timeoutMs, { ARKTS_PORT_CASE_REFS: refs ?? '' });
    writeFileSync(logPath, ['# 命令: ' + run.command, '# 退出码: ' + String(run.exitCode), '# 耗时: ' + run.durationMs + 'ms', '---', run.stdout, run.stderr].join('\n') + '\n', 'utf8');
    const evidence = evidencePath !== null && isFile(evidencePath) ? asObject(readJsonFile(evidencePath)) : asObject(parseJsonText(run.stdout));
    let stageResults: StageResult[] = [];
    if (evidence !== null) {
      stageResults = normalizeGates(evidence, relPath(logPath), evidencePath === null ? null : relPath(evidencePath));
      // 逐 stage 委托时 runner 的 evidence 可能仍含全部 gates：按 evidence.selected / 本次 stage 过滤
      const selected = Array.isArray(evidence.selected) ? evidence.selected.filter((item) => typeof item === 'string') : [];
      const keep = invocation === 'all' ? selected : selected.includes(invocation) ? [invocation] : selected;
      if (keep.length > 0) {
        const filtered = stageResults.filter((stage) => keep.includes(stage.name));
        if (filtered.length > 0) stageResults = filtered;
      }
      const pass = evidence.pass === true;
      if (!pass && !stageResults.some((stage) => stage.status === 'FAIL')) {
        stageResults.push({
          name: invocation === 'all' ? 'runner' : invocation,
          title: 'runner',
          status: 'FAIL',
          exitCode: run.exitCode,
          durationMs: 0,
          summary: 'runner report pass=false（exit ' + String(run.exitCode) + '）：' + firstMeaningfulLine(run.stderr || run.stdout),
          logPath: relPath(logPath),
          optional: false,
        });
      }
      if (run.exitCode !== 0 && !stageResults.some((stage) => stage.status === 'FAIL')) {
        stageResults.push({
          name: invocation === 'all' ? 'runner' : invocation,
          title: 'runner',
          status: 'FAIL',
          exitCode: run.exitCode,
          durationMs: 0,
          summary: 'runner exit ' + String(run.exitCode) + '：' + firstMeaningfulLine(run.stderr || run.stdout),
          logPath: relPath(logPath),
          optional: false,
        });
      }
    } else {
      stageResults = [{
        name: invocation === 'all' ? 'runner' : invocation,
        title: 'runner',
        status: run.exitCode === 0 ? 'PASS' : 'FAIL',
        exitCode: run.exitCode,
        durationMs: 0,
        summary: run.exitCode === 0 ? 'runner exit 0（无 evidence JSON）' : 'runner exit ' + String(run.exitCode) + '：' + firstMeaningfulLine(run.stderr || run.stdout),
        logPath: relPath(logPath),
        optional: false,
      }];
    }
    for (const item of stageResults) {
      item.durationMs = item.durationMs === 0 ? run.durationMs : item.durationMs;
      results.push(item);
    }
    const failed = run.exitCode !== 0 || stageResults.some((stage) => stage.status === 'FAIL') || (evidence !== null && evidence.pass !== true);
    if (failed && !args.doContinue) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function countsOf(stages: StageResult[]): Report['counts'] {
  return {
    pass: stages.filter((stage) => stage.status === 'PASS').length,
    warn: stages.filter((stage) => stage.status === 'WARN').length,
    fail: stages.filter((stage) => stage.status === 'FAIL').length,
    skip: stages.filter((stage) => stage.status === 'SKIP').length,
  };
}

function stageLine(stage: StageResult): string {
  const numbers = stage.metrics === undefined ? '' : '';
  return [stage.status.padEnd(4), stage.name.padEnd(12), oneLine(stage.summary, 110) + numbers, stage.logPath].join('  ');
}

function writeReport(reportPath: string, report: Report): void {
  const absolute = resolve(process.cwd(), reportPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// --list
// ---------------------------------------------------------------------------

function listCases(json: boolean): void {
  const entries = discoverAll();
  const rows = entries.map((entry) => {
    if (entry.manifest === null) {
      return { id: relative(CASES_DIR, entry.dir), mode: 'invalid', stages: [], ready: false, reason: 'case.json 非法', title: '' };
    }
    const manifest = entry.manifest;
    const refs = resolveRefs(manifest, parseArgs([]));
    const sdk = resolveSdk(manifest, parseArgs([]));
    const hvigor = resolveHvigor(manifest, parseArgs([]));
    const upstream = upstreamReady(manifest);
    const argv = manifest.mode === 'stages' ? (manifest.stages ?? []).flatMap((stage) => stage.argv) : [];
    const placeholderMissing = placeholderSkipReason(argv, manifest, parseArgs([]), refs, sdk, hvigor);
    const ready = upstream.ready && placeholderMissing === null;
    return {
      id: manifest.id,
      title: manifest.title,
      lang: manifest.lang,
      mode: manifest.mode,
      stages: stageNames(manifest),
      ready,
      reason: ready ? null : (upstream.ready ? placeholderMissing : upstream.reason),
    };
  });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, cases: rows }, null, 2));
    return;
  }
  for (const row of rows) {
    console.log(String(row.id).padEnd(12) + '  ' + String(row.mode).padEnd(7) + '  ' +
      (row.ready ? 'ready ' : 'SKIP  ') + String(row.stages.join(',')).padEnd(16) + '  ' +
      (row.reason === null ? '' : row.reason));
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main(): void {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }
  if (process.argv.includes('--list')) {
    listCases(process.argv.includes('--json'));
    process.exit(EXIT_OK);
  }
  const args = parseArgs(process.argv.slice(2));
  const timeoutRaw = process.argv.indexOf('--timeout');
  if (timeoutRaw >= 0) {
    const parsed = Number(process.argv[timeoutRaw + 1]);
    if (!Number.isInteger(parsed) || parsed < 0) failUsage('--timeout 必须是非负整数（毫秒）：' + process.argv[timeoutRaw + 1]);
    args.timeoutMs = parsed;
  }
  if (args.caseArg === '') failUsage('缺少 --case <id|dir>');
  if (args.update && !args.caseArg) failUsage('--update 需要 --case');

  const caseDir = discoverCase(args.caseArg);
  const manifest = validateManifest(join(caseDir, 'case.json'), false) as Manifest;
  const requested = requestedStages(manifest, args.stages);
  if (args.update && manifest.mode !== 'runner') failUsage('case ' + manifest.id + ' 不支持 --update（stages 模式无更新语义）');

  const refs = resolveRefs(manifest, args);
  const sdk = resolveSdk(manifest, args);
  const hvigor = resolveHvigor(manifest, args);
  const warnings: string[] = [];
  const upstream = upstreamReady(manifest);
  if (!upstream.ready) warnings.push(upstream.reason ?? '上游缺失');
  if (args.device !== '') {
    const consumed = manifest.mode === 'stages' && (manifest.stages ?? []).some((stage) => stage.argv.some((item) => item.includes('$' + '{device}')));
    if (!consumed) warnings.push('--device 已提供，但当前清单没有消费 device 的 stage（WARN）');
  }

  let stages: StageResult[] = [];
  if (manifest.mode === 'runner') {
    stages = runRunner(manifest, args, refs, sdk, hvigor);
  } else {
    stages = runStages(manifest, args, refs, sdk, hvigor);
  }

  const requestedSet = new Set(requested);
  const executedNames = new Set(stages.map((stage) => stage.name));
  const remaining = requested.filter((name) => !executedNames.has(name));
  const stoppedEarly = remaining.length > 0;
  const counts = countsOf(stages);
  const skippedNonOptional = stages.filter((stage) => stage.status === 'SKIP' && stage.optional !== true).length;
  const nonOptionalSkipReason = stages.find((stage) => stage.status === 'SKIP' && stage.optional !== true)?.summary ?? null;
  const ok = counts.fail === 0 && skippedNonOptional === 0;

  const report: Report = {
    schemaVersion: 1,
    case: manifest.id,
    title: manifest.title,
    lang: manifest.lang,
    mode: manifest.mode,
    requested,
    stages,
    pass: ok,
    counts,
    stoppedEarly,
    remaining,
    refs,
    sdk,
    hvigor,
    skippedNonOptional,
    skipReason: nonOptionalSkipReason,
    warnings,
    reportPath: relPath(resolve(process.cwd(), args.report)),
  };
  writeReport(args.report, report);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const lines: string[] = [];
    lines.push('case ' + manifest.id + '  mode=' + manifest.mode + '  lang=' + manifest.lang +
      '  stage=' + (args.stages === 'all' ? 'all' : requested.join(',')));
    for (const stage of stages) lines.push(stageLine(stage));
    if (warnings.length > 0) lines.push('WARN  ' + warnings.join('；'));
    const verdict = counts.fail > 0 ? 'FAIL' : skippedNonOptional > 0 ? 'SKIPPED（外部前置缺失）' : 'PASS';
    lines.push('结果: ' + verdict + '（PASS ' + counts.pass + ' / WARN ' + counts.warn + ' / FAIL ' + counts.fail +
      ' / SKIP ' + counts.skip + '）  报告: ' + report.reportPath);
    console.log(lines.slice(0, HUMAN_MAX_LINES).join('\n'));
  }
  process.exit(counts.fail > 0 ? EXIT_FAIL : skippedNonOptional > 0 ? EXIT_NOT_READY : EXIT_OK);
}

main();
