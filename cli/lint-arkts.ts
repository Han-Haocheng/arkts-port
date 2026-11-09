#!/usr/bin/env node
/**
 * ArkTS 合规门禁：在项目里跑一次构建，把 ArkTS 错误按规则分类。
 *
 * 用法：
 *   node cli/lint-arkts.ts --project <harmony-project> [--sdk <path>] [--hvigor <path>]
 *        [--json] [--report <path>] [--log <path> | --log-in-project]
 *
 * 前置校验（对齐 build-hap）：--project 目录、SDK <sdk>/26.0.0/ets、hvigor bin。
 * 缺前置 exit 2，绝不把「根本没法跑」输出成「ArkTS 错误数: 0」。
 * 日志默认写 out/logs/lint-arkts.log（cwd 下，自动建目录）；--log-in-project 才写工程内
 * <project>/.arkts-lint.log，避免污染用户工程。
 *
 * 门禁可靠性：hvigor 是增量构建，第二次跑会是 UP-TO-DATE、不再输出 ArkTS 诊断，
 * 导致「第一次 FAIL、第二次 PASS」的 fail-open。因此每次构建前默认清理
 * <project>/.hvigor/cache 与各模块 build 目录（只删构建产物，不碰源码）；
 * --no-clean 可显式跳过，但门禁将依赖上一次缓存。
 *
 * 退出码：0 = 0 个 ArkTS 错误；1 = 有错误或构建失败；2 = 用法/前置缺失。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const USAGE = [
  '用法：',
  '  node cli/lint-arkts.ts --project <harmony-project> [--sdk <path>] [--hvigor <path>]',
  '       [--json] [--report <path>] [--log <path> | --log-in-project]',
  '',
  '在项目里跑一次 hvigor 构建，统计 ArkTS 错误数并按规则分类。',
  '门禁可靠性：每次构建前默认清理 .hvigor/cache 与各模块 build（只删构建产物），',
  '避免 hvigor UP-TO-DATE 导致的「第一次 FAIL、第二次 PASS」fail-open。',
  '',
  '参数：',
  '  --project <dir>     鸿蒙工程目录（必填，必须存在）',
  '  --sdk <path>        OpenHarmony SDK（默认 OHOS_BASE_SDK_HOME；必须有 <sdk>/26.0.0/ets）',
  '  --hvigor <path>     hvigor node_modules 目录（默认 HVIGOR_HOME；必须有 @ohos/hvigor/bin/hvigor.js）',
  '  --json              stdout 只输出结构化 JSON（RULES 分类 + errors 全量）',
  '  --report <path>     把同一份 JSON 写到文件（目录自动创建）',
  '  --log <path>        构建日志路径（默认 out/logs/lint-arkts.log，相对 cwd）',
  '  --log-in-project    日志写到 <project>/.arkts-lint.log（默认不写工程内）',
  '  --no-clean          跳过构建缓存清理（默认每次门禁都清，防 UP-TO-DATE fail-open）',
  '  --help, -h          显示本帮助',
  '',
  '输出（默认，供 cli/port.ts 解析；n 含 ERROR 与 WARN 级 arkts-* 违规）：',
  '  ArkTS 错误数: <n>',
  '  其中 WARN 级: <m>   （仅当有 WARN 级 arkts 违规时打印）',
  '  按规则分类: ...',
  '  前 5 条错误： ...',
  '  门禁: PASS|FAIL',
  '',
  '退出码：0 = 0 个 ArkTS 错误；1 = 有错误或构建失败；2 = 用法/前置缺失',
].join('\n');

const VALUE_OPTS = new Set(['project', 'sdk', 'hvigor', 'report', 'log']);
const BOOL_OPTS = new Set(['json', 'log-in-project', 'no-clean', 'help']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failUsage(message: string): never {
  console.error('lint-arkts: ' + message);
  console.error('用法见：node cli/lint-arkts.ts --help');
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

const CLEAN_SKIP_DIRS = new Set(['node_modules', 'oh_modules', '.git', '.hvigor', 'build']);

/**
 * 收集需要删除的构建产物目录（不碰源码）：
 * - <project>/.hvigor/cache：hvigor 的 task cache（决定任务是否 UP-TO-DATE，是关键）
 * - <project>/build 与各模块 build：编译产物；模块路径优先读 build-profile.json5 的 srcPath
 * 只 remove 构建产物，任何异常都 fail-closed（exit 2），避免悄悄退化成依赖缓存。
 */
function collectCleanTargets(project: string): string[] {
  const targets = new Set<string>();
  const add = (dir: string): void => {
    if (isDirectory(dir)) targets.add(dir);
  };
  add(join(project, '.hvigor', 'cache'));
  add(join(project, 'build'));
  try {
    const profile = readFileSync(join(project, 'build-profile.json5'), 'utf8');
    for (const match of profile.matchAll(/srcPath\s*:\s*['"]([^'"]+)['"]/g)) {
      add(join(resolve(project, match[1]), 'build'));
    }
  } catch {
    // 没有 build-profile.json5 / 解析失败：退回一层目录扫描
  }
  try {
    for (const entry of readdirSync(project, { withFileTypes: true })) {
      if (!entry.isDirectory() || CLEAN_SKIP_DIRS.has(entry.name)) continue;
      add(join(project, entry.name, 'build'));
    }
  } catch {
    // 扫描失败也不影响：.hvigor/cache 已足以让 hvigor 重新执行任务
  }
  return [...targets].sort();
}

function cleanBuildArtifacts(project: string): string[] {
  const targets = collectCleanTargets(project);
  for (const target of targets) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      failUsage('无法清理构建缓存 ' + target + '：' + errorMessage(error) +
        '（可加 --no-clean 跳过，但门禁会依赖上一次缓存）');
    }
  }
  return targets.filter((target) => !isDirectory(target));
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const WARN_FILE = /ArkTS:WARN File:\s+(.+?):(\d+):(\d+)\s*$/;

interface ArkTsError {
  level: 'ERROR' | 'WARN';
  rule: string;
  message: string;
  file: string;
  line: number;
  col: number;
}

function countRules(log: string): Map<string, number> {
  const rules = new Map<string, number>();
  for (const match of log.matchAll(/\((arkts-[a-z-]+)\)/g)) {
    rules.set(match[1], (rules.get(match[1]) ?? 0) + 1);
  }
  return rules;
}

/**
 * 与 cli/reachability-probe.ts、cli/explain-errors.ts 共用同一套 hvigor 解析口径：
 * - ERROR：单行 "Error Message: <msg> At File: <path>:<line>:<col>"
 * - WARN ：两行 "ArkTS:WARN File: <path>:<line>:<col>" + 下一行 "<msg> (arkts-*)"
 * 实测 globalThis 只报 WARN；WARN 级 arkts 规则同样必须卡门禁，否则是假 PASS。
 */
function parseErrors(log: string): ArkTsError[] {
  const clean = log.replace(ANSI, '');
  const lines = clean.split('\n');
  const errors: ArkTsError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = line.indexOf('Error Message:');
    if (at >= 0) {
      let body = line.slice(at + 'Error Message:'.length).trim();
      let file = '?';
      let lineNo = 0;
      let col = 0;
      const pos = /\s+At File:\s+(.+?):(\d+):(\d+)\s*$/.exec(body);
      if (pos) {
        file = pos[1].trim();
        lineNo = Number(pos[2]);
        col = Number(pos[3]);
        body = body.slice(0, pos.index).trim();
      }
      const rule = /\((arkts-[a-z-]+)\)/.exec(body);
      errors.push({ level: 'ERROR', rule: rule ? rule[1] : '?', message: body, file, line: lineNo, col });
      continue;
    }
    const warn = WARN_FILE.exec(line);
    if (!warn) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const body = lines[j].trim();
      if (body === '') break;
      const rule = /\((arkts-[a-z-]+)\)/.exec(body);
      if (rule) {
        errors.push({
          level: 'WARN',
          rule: rule[1],
          message: body,
          file: warn[1].trim(),
          line: Number(warn[2]),
          col: Number(warn[3]),
        });
        i = j;
      }
      break;
    }
  }
  return errors;
}

function sortedRules(rules: Map<string, number>): Array<[string, number]> {
  return [...rules.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function writeReport(reportPath: string, text: string): void {
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, text, 'utf8');
  } catch (error) {
    failUsage('无法写入 --report ' + reportPath + '：' + errorMessage(error));
  }
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
if (!isDirectory(project)) {
  failUsage('--project 目录不存在：' + projectArg);
}

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

const jsonOut = args.json === true;
let logPath: string;
if (args.log !== undefined) logPath = resolve(cwd, String(args.log));
else if (args['log-in-project'] === true) logPath = join(project, '.arkts-lint.log');
else logPath = resolve(cwd, 'out', 'logs', 'lint-arkts.log');
const reportPath = args.report === undefined ? null : resolve(cwd, String(args.report));

// 每次门禁默认干净构建：不清理的话，第二次 hvigor 会 UP-TO-DATE 且不输出诊断，
// 造成「第一次 FAIL、第二次 PASS」的 fail-open（reviewer P1，task-17）。
const doClean = args['no-clean'] !== true;
const cleanPaths = doClean ? cleanBuildArtifacts(project) : [];
if (!doClean) {
  console.error('lint-arkts: 警告：--no-clean 跳过构建缓存清理；hvigor 可能 UP-TO-DATE 而漏报（fail-open）');
}

const res = spawnSync(
  process.execPath,
  [hvigorJs, '--mode', 'module', '-p', 'product=default', '-p', 'buildMode=debug', 'assembleHap', '--no-daemon'],
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
const log = (res.stdout ?? '') + (res.stderr ?? '') +
  (spawnError === null ? '' : '\n[lint-arkts] 无法启动 hvigor：' + spawnError + '\n');
try {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, log, 'utf8');
} catch (error) {
  console.error('lint-arkts: 无法写日志 ' + logPath + '：' + errorMessage(error));
}

const rules = countRules(log);
const errors = parseErrors(log);
const total = errors.length;
const warnCount = errors.filter((error) => error.level === 'WARN').length;
// WARN 级 arkts 规则（如 globalThis）也算违规：否则会「构建绿了但规则违规」假 PASS
const ok = res.status === 0 && spawnError === null && total === 0;

const payload = {
  project,
  sdk,
  hvigor: hvigorHome,
  logPath,
  arktsErrors: total,
  warnArktsErrors: warnCount,
  pass: ok,
  clean: doClean,
  cleanPaths,
  rules: Object.fromEntries(sortedRules(rules)),
  errors,
  hvigorExitCode: res.status ?? null,
  spawnError,
};
const payloadText = JSON.stringify(payload, null, 1) + '\n';

if (jsonOut) {
  process.stdout.write(payloadText);
} else {
  console.log('ArkTS 错误数: ' + total);
  if (warnCount > 0) console.log('其中 WARN 级: ' + warnCount);
  if (rules.size > 0) {
    console.log('按规则分类:');
    for (const [rule, count] of sortedRules(rules)) {
      console.log('  ' + String(count).padStart(4) + '  ' + rule);
    }
    console.log('');
    console.log('修法见 rules/arkts-restrictions.md');
  }
  if (!ok) {
    console.log('');
    console.log('前 5 条错误：');
    for (const error of errors.slice(0, 5)) {
      console.log('  ' + error.message +
        (error.file === '?' ? '' : '  @ ' + error.file + ':' + error.line + ':' + error.col));
    }
  }
  console.log(ok ? '门禁: PASS' : '门禁: FAIL');
}

if (reportPath !== null) writeReport(reportPath, payloadText);
// 用 exitCode 而非 process.exit：--json 大输出走管道时避免截断
process.exitCode = ok ? 0 : 1;
