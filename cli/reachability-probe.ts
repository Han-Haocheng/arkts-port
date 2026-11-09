#!/usr/bin/env node
/**
 * 全量可达性检查：ArkTS 只对「从 entry 可达」的模块做类型检查，
 * 直接构建会漏掉没人 import 的文件。本工具在**临时副本**上注入探针，
 * 把 src 下所有 .ets 拉进可达图再编译，因此不会污染原工程。
 *
 * 用法：
 *   node cli/reachability-probe.ts --project <harmony-project> [--src entry/src/main/ets]
 *        [--entry pages/Index.ets] [--sdk <path>] [--hvigor <path>]
 *        [--json] [--report <path>] [--keep]
 *
 * 前置校验（对齐 build-hap）：--project 目录、SDK <sdk>/26.0.0/ets、hvigor bin、
 * <project>/<src> 与入口页存在。缺前置 exit 2。
 * 错误计数包含 ERROR 与 WARN 级的 arkts-* 规则违规（实测 globalThis 是 WARN，
 * 但同样必须卡门禁）；默认输出保留「探针模块数 / ArkTS 错误数 / 门禁」三行。
 *
 * 退出码：0 = 0 个 ArkTS 错误；1 = 有错误或构建失败；2 = 用法/前置缺失。
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const USAGE = [
  '用法：',
  '  node cli/reachability-probe.ts --project <harmony-project> [--src entry/src/main/ets]',
  '       [--entry pages/Index.ets] [--sdk <path>] [--hvigor <path>]',
  '       [--json] [--report <path>] [--keep]',
  '',
  '在工程临时副本里注入探针，把 src 下全部 .ets 拉进可达图后编译（不污染原工程）。',
  '',
  '参数：',
  '  --project <dir>   鸿蒙工程目录（必填，必须存在）',
  '  --src <rel>       工程内 .ets 根（默认 entry/src/main/ets）',
  '  --entry <rel>     入口页（相对 --src，默认 pages/Index.ets）',
  '  --sdk <path>      OpenHarmony SDK（默认 OHOS_BASE_SDK_HOME；必须有 <sdk>/26.0.0/ets）',
  '  --hvigor <path>   hvigor node_modules 目录（默认 HVIGOR_HOME；必须有 @ohos/hvigor/bin/hvigor.js）',
  '  --json            stdout 只输出结构化 JSON',
  '  --report <path>   把同一份 JSON 写到文件（目录自动创建）',
  '  --keep            保留临时副本（默认清理）',
  '  --help, -h        显示本帮助',
  '',
  '输出（默认，供 cli/port.ts 解析）：',
  '  探针模块数: <n>',
  '  ArkTS 错误数: <n>（全量可达）',
  '  其中 WARN 级: <n>   （仅当有 WARN 级 arkts 违规时打印）',
  '  前 10 条： ...',
  '  门禁: PASS|FAIL',
  '',
  '退出码：0 = 0 个 ArkTS 错误；1 = 有错误或构建失败；2 = 用法/前置缺失',
].join('\n');

const VALUE_OPTS = new Set(['project', 'src', 'entry', 'sdk', 'hvigor', 'report']);
const BOOL_OPTS = new Set(['json', 'keep', 'help']);

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const WARN_FILE = /ArkTS:WARN File:\s+(.+?):(\d+):(\d+)\s*$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failUsage(message: string): never {
  console.error('reachability-probe: ' + message);
  console.error('用法见：node cli/reachability-probe.ts --help');
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

function walkEts(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkEts(p, out);
    else if (e.name.endsWith('.ets')) out.push(p);
  }
  return out;
}

interface ArkTsError {
  level: 'ERROR' | 'WARN';
  rule: string;
  message: string;
  file: string;
  line: number;
  col: number;
}

/**
 * 解析 hvigor 日志，同时收 ERROR 与 WARN 级的 arkts-* 违规：
 *  - ERROR：单行 "Error Message: <msg> At File: <path>:<line>:<col>"
 *  - WARN ：两行结构 "ArkTS:WARN File: <path>:<line>:<col>" + 下一行 "<msg> (arkts-*)"
 * 与 cli/lint-arkts.ts、cli/explain-errors.ts 口径一致。
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
          file: warn[1].trim().replace(work, '<project>'),
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

function countRules(log: string): Map<string, number> {
  const rules = new Map<string, number>();
  for (const match of log.replace(ANSI, '').matchAll(/\((arkts-[a-z-]+)\)/g)) {
    rules.set(match[1], (rules.get(match[1]) ?? 0) + 1);
  }
  return rules;
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
if (!isDirectory(project)) failUsage('--project 目录不存在：' + projectArg);

const srcRel = String(args.src ?? 'entry/src/main/ets');
const entryRel = String(args.entry ?? 'pages/Index.ets');
const srcDir = join(project, srcRel);
const entryPage = join(srcDir, entryRel);

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

if (!isDirectory(srcDir) || !isFile(entryPage)) {
  failUsage('找不到源目录或入口页：' + join(srcRel, entryRel) + '（可用 --src/--entry 覆盖）');
}

const jsonOut = args.json === true;
const keep = args.keep === true;
const reportPath = args.report === undefined ? null : resolve(cwd, String(args.report));

let work = '';
let exitCode = 1;
try {
  // 1) 复制到临时目录（排除构建产物与依赖）
  work = join(tmpdir(), 'arkts-probe-' + process.pid);
  rmSync(work, { recursive: true, force: true });
  cpSync(project, work, {
    recursive: true,
    filter: (src) => {
      const name = src.split(sep).pop() ?? '';
      return !['build', '.hvigor', 'node_modules', 'oh_modules', '.git', '.idea'].includes(name);
    },
  });

  // 2) 生成探针：侧效应 import 全部 .ets
  const probeDir = join(work, srcRel, '__reachability__');
  mkdirSync(probeDir, { recursive: true });
  const modules = walkEts(join(work, srcRel))
    .filter((f) => !f.includes('__reachability__') && f !== join(work, srcRel, entryRel));
  const imports = modules.map((f) => {
    const rel = relative(probeDir, f).split(sep).join('/').replace(/\.ets$/, '');
    return "import '" + (rel.startsWith('.') ? rel : './' + rel) + "';";
  });
  writeFileSync(join(probeDir, 'Probe.ets'), [
    '// 由 arkts-port/cli/reachability-probe.ts 自动生成，仅用于把全部模块拉进可达图',
    ...imports,
    'export const REACHABILITY_PROBE = true;',
    '',
  ].join('\n'), 'utf8');

  // 3) 让探针本身可达（ArkTS 要求 import 在所有语句之前）
  const entryWork = join(work, srcRel, entryRel);
  writeFileSync(entryWork, "import '../__reachability__/Probe';\n" + readFileSync(entryWork, 'utf8'), 'utf8');

  // 4) 在副本里构建
  const res = spawnSync(
    process.execPath,
    [hvigorJs, '--mode', 'module', '-p', 'product=default', '-p', 'buildMode=debug', 'assembleHap', '--no-daemon'],
    {
      cwd: work,
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
    (spawnError === null ? '' : '\n[reachability-probe] 无法启动 hvigor：' + spawnError + '\n');

  // 5) 报告（ERROR + WARN 级 arkts 违规都算）
  const rules = countRules(log);
  const errors = parseErrors(log);
  const total = errors.length;
  const warnCount = errors.filter((error) => error.level === 'WARN').length;
  const ok = res.status === 0 && spawnError === null && total === 0;

  const payload = {
    project,
    src: srcRel,
    entry: entryRel,
    sdk,
    hvigor: hvigorHome,
    probeModules: modules.length,
    arktsErrors: total,
    warnArktsErrors: warnCount,
    pass: ok,
    rules: Object.fromEntries(sortedRules(rules)),
    errors,
    hvigorExitCode: res.status ?? null,
    spawnError,
    workDir: keep ? work : null,
  };
  const payloadText = JSON.stringify(payload, null, 1) + '\n';

  if (jsonOut) {
    process.stdout.write(payloadText);
  } else {
    console.log('探针模块数: ' + modules.length);
    console.log('ArkTS 错误数: ' + total + (total === 0 ? '（全量可达）' : ''));
    if (warnCount > 0) console.log('其中 WARN 级: ' + warnCount);
    if (rules.size > 0) {
      for (const [rule, count] of sortedRules(rules)) {
        console.log('  ' + String(count).padStart(4) + '  ' + rule);
      }
    }
    if (!ok) {
      console.log('');
      console.log('前 10 条：');
      for (const error of errors.slice(0, 10)) {
        console.log('  ' + error.message +
          (error.file === '?' ? '' : '  @ ' + error.file + ':' + error.line + ':' + error.col));
      }
    }
    console.log(ok ? '门禁: PASS' : '门禁: FAIL');
    if (keep) console.log('副本保留在: ' + work);
  }

  if (reportPath !== null) writeReport(reportPath, payloadText);
  exitCode = ok ? 0 : 1;
} catch (error) {
  console.error('reachability-probe: ' + errorMessage(error));
  exitCode = 1;
} finally {
  if (work !== '' && !keep) rmSync(work, { recursive: true, force: true });
}
// 用 exitCode 而非 process.exit：--json 大输出走管道时避免截断
process.exitCode = exitCode;
