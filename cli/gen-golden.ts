#!/usr/bin/env node
/**
 * Golden 生成 + 稳定性门禁：把「编译/环境检查 → 跑 harness 两次 → 逐字节比对」
 * 机械化成一条命令；场景设计仍归 agent（本工具不设计、不补场景）。
 *
 * 支持两种语言：
 *   --lang jvm    kotlinc 编译闭包 → kotlin 跑两次 → 逐字节比较 → 写 golden.json
 *   --lang js-ts  node --version 环境检查 → node 跑 harness 两次 → 逐字节比较 → 写 golden.json
 *
 * 用法：
 *   node cli/gen-golden.ts --lang jvm --src <dir> --main <Main.kt> [--package <pkg>]
 *        [--out <dir>] [--json] [--report <path.json>]
 *   node cli/gen-golden.ts --lang js-ts --main <harness.mjs|.js>
 *        [--out <dir>] [--json] [--report <path.json>] [--logs <dir>]
 *
 * 退出码：0 = 成功且两次一致；1 = 编译/运行失败；2 = 用法错误；
 *         3 = 输出不稳定（两次 stdout 不等）；4 = 缺 harness（已复制骨架，未生成 golden）。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Stage = 'validate' | 'harness' | 'compile' | 'run' | 'stability';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_UNSTABLE = 3;
const EXIT_HARNESS = 4;

const SUPPORTED_LANGS = ['jvm', 'js-ts'];
const DEFAULT_OUT = join('out', 'gen-golden');
/** node-harness 模板缺失时的内嵌骨架（写 scope 不含 templates/，因此内置兜底） */
const NODE_HARNESS_SKELETON = [
  '// arkts-port node golden harness 骨架（cli/gen-golden.ts --lang js-ts 复制）',
  '// 补场景：固定输入 → console.log 稳定 JSON（禁止时间戳/随机数/绝对路径）；stdout 即 golden.json。',
  '// import { target } from "../path/to/module.ts";',
  '',
  'const scenarios = [',
  "  { name: 's1', input: {} },",
  '];',
  '',
  'const out = scenarios.map((scenario) => ({',
  '  scenario: scenario.name,',
  '  // result: target(scenario.input),',
  '  result: null,',
  '}));',
  '',
  'console.log(JSON.stringify(out));',
  '',
].join('\n');

const USAGE = [
  '用法：',
  '  JVM：   node cli/gen-golden.ts --lang jvm --src <dir> --main <Main.kt> [--package <pkg>]',
  '          [--out <dir>] [--json] [--report <path.json>]',
  '  JS/TS： node cli/gen-golden.ts --lang js-ts --main <harness.mjs|.js>',
  '          [--out <dir>] [--json] [--report <path.json>] [--logs <dir>]',
  '          （.mjs 是 ESM；.js 按最近 package.json 的 type 判定，CommonJS/ESM 均可）',
  '',
  '两种语言做同样的四件事：',
  '  jvm   ：校验参数/从 Main.kt 读 package（主类名按 object/class/top-level fun 推断）',
  '          → kotlinc 编译 → kotlin 跑两次逐字节比较 → 一致才写 golden.json',
  '  js-ts ：校验参数 → node --version 环境检查 → node 跑 harness 两次逐字节比较',
  '          → 一致才写 golden.json（js-ts 不需要 --src；harness 自包含）',
  '',
  '缺 harness（没传 --main 或文件不存在）：',
  '  jvm   ：从 templates/kotlin-harness/Main.example.kt 复制骨架到 <out>/Main.kt',
  '  js-ts ：从 templates/node-harness 复制骨架（缺失时写入内嵌骨架）到 <out>/harness.mjs',
  '  两者都提示 TODO 并 exit 4（不生成 golden；场景设计仍归 agent）',
  '',
  '输出：人类摘要 ≤10 行；--json 输出结构化报告；--report 把同一份 JSON 写到文件。',
  '     WARN（时间戳/随机数/绝对路径特征）只提示，不影响退出码。',
  '边界：--out / --logs 必须位于源根之外；越界（含 --out == 源根）→ 用法错误 exit 2，不写任何文件。',
  '      jvm 的源根是 --src；js-ts 的源根是 --main 所在目录。',
  '',
  '退出码：0 = 成功且两次一致；1 = 编译/运行失败；2 = 用法错误；3 = 输出不稳定；4 = 缺 harness',
  '',
  '可选扩展：',
  '  --logs <dir>      日志目录（默认 <cwd>/out/logs）',
  '  --timeout <ms>    单次子进程超时，0 = 不超时（默认 0）',
  '  --help, -h        显示本帮助',
  '',
  '示例：',
  '  node cli/gen-golden.ts --lang jvm --src /path/to/closure/src --main /path/to/closure/src/Main.kt \\',
  '       --out out/gen-golden --json --report out/gen-golden/report.json',
  '  node cli/gen-golden.ts --lang js-ts --main out/harness/web.mjs --out out/gen-golden/web --json',
].join('\n');

interface RawCli {
  [key: string]: string | boolean;
}

interface ChildResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  command: string;
  spawnError: string | null;
}

interface WarningRecord {
  code: string;
  message: string;
  count: number;
}

const VALUE_OPTS = new Set(['lang', 'src', 'main', 'package', 'out', 'report', 'logs', 'timeout']);
const BOOL_OPTS = new Set(['json', 'help']);

// ---------------------------------------------------------------------------
// 参数解析：任何用法错误 → exit 2
// ---------------------------------------------------------------------------

function failUsage(message: string): never {
  console.error('gen-golden: ' + message);
  console.error('用法见：node cli/gen-golden.ts --help');
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

function optional(raw: RawCli, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' ? value : null;
}

function parseTimeout(raw: RawCli): number {
  let timeoutMs = 0;
  const timeoutRaw = optional(raw, 'timeout');
  if (timeoutRaw !== null) {
    const parsed = Number(timeoutRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      failUsage('--timeout 必须是非负整数（毫秒）：' + timeoutRaw);
    }
    timeoutMs = parsed;
  }
  return timeoutMs;
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function oneLine(text: string, max = 200): string {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function relPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return path;
  return rel;
}

function formatSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(2) + 's';
}

/** child 是否等于 parent 或位于 parent 之内（两边都应是 resolve 后的绝对路径） */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 字符类里不要出现「$ 紧跟 {」的写法，避免被模板字符串当插值 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?()[\]{}|^$-]/g, '\\$&');
}

function countKtFiles(dir: string): number {
  let count = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.kt')) count++;
    }
  };
  try {
    walk(dir);
  } catch {
    // 计数只用于摘要，失败不致命
  }
  return count;
}

// ---------------------------------------------------------------------------
// 源码解析：package 与主类名
// ---------------------------------------------------------------------------

function readPackageFromSource(source: string): string {
  const match = /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/m.exec(source);
  return match ? match[1] : '';
}

function isValidPackage(pkg: string): boolean {
  if (pkg === '') return true; // Kotlin 默认包
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(pkg);
}

/**
 * 主类名：Kotlin 入口类名由源码结构决定
 * - 顶层 fun main() → <File>Kt（JVM 约定）
 * - object <File> / class <File>（@JvmStatic fun main）→ <File>
 * 编译后用 classes 目录里的 .class 复核；源码启发式只作兜底（便于无真实编译器的测试）。
 */
function detectMainClass(mainFileBase: string, source: string, classesDir: string, pkg: string): string {
  const packageDir = pkg === '' ? classesDir : join(classesDir, ...pkg.split('.'));
  if (isFile(join(packageDir, mainFileBase + '.class'))) return mainFileBase;
  if (isFile(join(packageDir, mainFileBase + 'Kt.class'))) return mainFileBase + 'Kt';
  const objectOrClass = new RegExp('^\\s*(?:object|class)\\s+' + escapeRegExp(mainFileBase) + '\\b', 'm');
  if (objectOrClass.test(source)) return mainFileBase;
  return mainFileBase + 'Kt';
}

// ---------------------------------------------------------------------------
// 子进程与日志
// ---------------------------------------------------------------------------

interface LogWriter {
  path: string;
  append(text: string): void;
}

function createLog(path: string): LogWriter {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '# arkts-port gen-golden 日志\n', 'utf8');
  return {
    path,
    append(text: string): void {
      try {
        writeFileSync(path, readFileSync(path, 'utf8') + text, 'utf8');
      } catch {
        // 日志失败不影响门禁结论
      }
    },
  };
}

function runChild(command: string, args: string[], cwd: string, timeoutMs: number): ChildResult {
  const startedAt = Date.now();
  const res = spawnSync(command, args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - startedAt;
  let spawnError: string | null = null;
  if (res.error) {
    const error = res.error as { code?: string; message?: string };
    spawnError = error.code === 'ENOENT'
      ? '找不到命令：' + command + '（PATH 里没有？）'
      : (error.message ?? String(res.error));
  }
  return {
    exitCode: res.status,
    stdout: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(''),
    stderr: Buffer.isBuffer(res.stderr) ? res.stderr : Buffer.from(''),
    durationMs,
    command: [command, ...args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))].join(' '),
    spawnError,
  };
}

function logChild(log: LogWriter, title: string, child: ChildResult): void {
  const lines: string[] = [
    '',
    '# ' + title,
    '# 命令: ' + child.command,
    '# 退出码: ' + (child.exitCode === null ? '-' : String(child.exitCode)),
    '# 耗时: ' + child.durationMs + 'ms',
  ];
  if (child.spawnError !== null) lines.push('# 启动错误: ' + child.spawnError);
  lines.push('---');
  log.append(lines.join('\n') + '\n');
  log.append(child.stdout.toString('utf8'));
  if (child.stderr.length > 0) log.append('\n[stderr]\n' + child.stderr.toString('utf8'));
  log.append('\n');
}

// ---------------------------------------------------------------------------
// WARN：输出里出现时间戳/随机数/绝对路径特征（只提示，不失败）
// ---------------------------------------------------------------------------

function detectWarnings(text: string): WarningRecord[] {
  const warnings: WarningRecord[] = [];
  const add = (code: string, label: string, regex: RegExp): void => {
    const matches = text.match(regex);
    if (matches && matches.length > 0) {
      warnings.push({ code, message: label + '出现 ' + matches.length + ' 处', count: matches.length });
    }
  };
  add('timestamp-iso', '时间戳（ISO 格式）', /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?/g);
  add('timestamp-epoch-ms', '时间戳（毫秒级 epoch）', /\b1\d{12}\b/g);
  add('uuid', 'UUID/随机标识', /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
  add('absolute-path', '绝对路径',
    /(?:^|[\s"':=])\/(?:home|mnt|tmp|usr|opt|Users|private|var)\/|[A-Za-z]:\\\\/g);
  add('default-tostring', '对象默认 toString（可能不稳定）', /@[0-9a-f]{6,8}\b/g);
  return warnings;
}

// ---------------------------------------------------------------------------
// 报告与输出
// ---------------------------------------------------------------------------

interface RunPayload {
  ok: boolean;
  stage: Stage;
  message: string;
  lang: string;
  /** jvm = --src 目录；js-ts 无 --src，固定为 null */
  src: string | null;
  main: string | null;
  package: string | null;
  mainClass: string | null;
  classesDir: string | null;
  goldenPath: string | null;
  runs: number;
  stable: boolean;
  compile: { exitCode: number | null; durationMs: number };
  run: { exitCode: number | null; durationMs: number };
  warnings: string[];
  warningDetails?: WarningRecord[];
  logPath: string | null;
  goldenSha256?: string | null;
  goldenBytes?: number | null;
  skeletonPath?: string;
  skeletonSource?: string;
  runDurations?: number[];
  nodeVersion?: string | null;
}

function emit(payload: RunPayload, raw: RawCli, cwd: string, humanLines: string[]): never {
  const reportArg = optional(raw, 'report');
  if (reportArg !== null) {
    const reportPath = resolve(cwd, reportArg);
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    } catch (error) {
      console.error('gen-golden: 无法写入报告 ' + reportPath + '：' + errorMessage(error));
      process.exit(EXIT_USAGE);
    }
  }
  if (raw.json === true) console.log(JSON.stringify(payload, null, 2));
  else console.log(humanLines.join('\n'));
  const code = payload.stage === 'harness'
    ? EXIT_HARNESS
    : payload.ok
      ? EXIT_OK
      : payload.stage === 'stability'
        ? EXIT_UNSTABLE
        : EXIT_FAIL;
  process.exit(code);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main(): void {
  const raw = parseCliArgs(process.argv.slice(2));
  if (raw.help === true) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }

  const cwd = process.cwd();
  const langRaw = optional(raw, 'lang');
  if (langRaw === null) failUsage('缺少 --lang（支持 --lang ' + SUPPORTED_LANGS.join(' / ') + '）');
  if (!SUPPORTED_LANGS.includes(langRaw)) {
    failUsage('目前支持 --lang ' + SUPPORTED_LANGS.join(',') + '（收到 "' + langRaw + '"）');
  }
  const timeoutMs = parseTimeout(raw);
  if (langRaw === 'jvm') runJvm(raw, cwd, timeoutMs);
  else runJsTs(raw, cwd, timeoutMs);
}

function runJvm(raw: RawCli, cwd: string, timeoutMs: number): void {
  const lang = 'jvm';

  const srcArg = optional(raw, 'src');
  if (srcArg === null) failUsage('缺少 --src（Kotlin 闭包目录）');
  const srcAbs = resolve(cwd, srcArg);
  if (!isDirectory(srcAbs)) failUsage('--src 目录不存在：' + srcArg);

  const mainArg = optional(raw, 'main');
  const outArg = optional(raw, 'out') ?? DEFAULT_OUT;
  const outAbs = resolve(cwd, outArg);
  const classesAbs = join(outAbs, 'classes');
  const goldenAbs = join(outAbs, 'golden.json');
  const logsArg = optional(raw, 'logs');
  const logsAbs = logsArg === null ? resolve(cwd, join('out', 'logs')) : resolve(cwd, logsArg);
  const logAbs = join(logsAbs, 'gen-golden.log');
  const logRef = relPath(cwd, logAbs);

  // fail-closed：绝不把 classes/golden/日志写进 --src（含 --out 等于 --src）
  if (isWithin(outAbs, srcAbs)) {
    failUsage('--out 不能等于或位于 --src 内（gen-golden 只写 <out>，绝不污染 --src）：--out=' + outArg +
      '，--src=' + srcArg + '；请把 --out 指到源码目录之外（如 --out out/gen-golden）');
  }
  if (isWithin(logsAbs, srcAbs)) {
    failUsage('--logs 不能位于 --src 内（日志不得写进源码目录）：--logs=' +
      (logsArg === null ? join('out', 'logs') : logsArg) + '，--src=' + srcArg +
      '；请把 --logs 指到源码目录之外（如 --logs out/logs）');
  }

  mkdirSync(outAbs, { recursive: true });

  // ---- 缺 harness：复制骨架，exit 4（不设计场景） ----
  const mainAbs = mainArg === null ? null : resolve(cwd, mainArg);
  if (mainAbs === null || !isFile(mainAbs)) {
    const skeletonAbs = join(outAbs, 'Main.kt');
    const templateAbs = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'kotlin-harness', 'Main.example.kt');
    const reason = mainArg === null ? '未提供 --main' : '找不到 ' + mainArg;
    if (!isFile(templateAbs)) {
      emit({
        ok: false, stage: 'harness', message: reason + '；模板缺失：' + templateAbs,
        lang, src: relPath(cwd, srcAbs), main: mainArg, package: null, mainClass: null,
        classesDir: null, goldenPath: null, runs: 0, stable: false,
        compile: { exitCode: null, durationMs: 0 }, run: { exitCode: null, durationMs: 0 },
        warnings: [], logPath: null, skeletonPath: relPath(cwd, skeletonAbs),
      }, raw, cwd, [
        'gen-golden  lang=' + lang,
        'harness    ' + reason + '，且模板缺失：' + templateAbs,
        '结果: FAIL（仓库模板缺失，检查仓库完整性）',
      ]);
    }
    copyFileSync(templateAbs, skeletonAbs);
    emit({
      ok: false, stage: 'harness',
      message: reason + '，已复制骨架到 ' + relPath(cwd, skeletonAbs) + '，补完场景后重跑',
      lang, src: relPath(cwd, srcAbs), main: mainArg, package: null, mainClass: null,
      classesDir: null, goldenPath: null, runs: 0, stable: false,
      compile: { exitCode: null, durationMs: 0 }, run: { exitCode: null, durationMs: 0 },
      warnings: [], logPath: null, skeletonPath: relPath(cwd, skeletonAbs),
    }, raw, cwd, [
      'gen-golden  lang=' + lang,
      'src        ' + relPath(cwd, srcAbs),
      'harness    ' + reason + ' → 已复制骨架：' + relPath(cwd, skeletonAbs),
      'TODO       按目标模块补场景（构造固定输入 → main 里 println JSON），然后重跑本命令',
      '结果: HARNESS（未生成 golden；场景设计归 agent）',
    ]);
  }

  // ---- package 与主类名 ----
  const mainSource = readFileSync(mainAbs, 'utf8');
  const mainFileBase = basename(mainAbs, extname(mainAbs));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(mainFileBase)) {
    failUsage('--main 文件名必须是合法 Kotlin 标识符（决定主类名）：' + basename(mainAbs));
  }
  const packageArg = optional(raw, 'package');
  const pkg = packageArg ?? readPackageFromSource(mainSource);
  if (!isValidPackage(pkg)) failUsage('无法解析 package：' + pkg);
  let mainClass = detectMainClass(mainFileBase, mainSource, classesAbs, pkg);

  const log = createLog(logAbs);

  // ---- 清理上次产物，避免旧 golden 冒充新结果 ----
  rmSync(classesAbs, { recursive: true, force: true });
  rmSync(goldenAbs, { force: true });
  mkdirSync(classesAbs, { recursive: true });

  // ---- 编译 ----
  const compile = runChild('kotlinc', [srcAbs, '-d', classesAbs], cwd, timeoutMs);
  log.append('# 源码: ' + srcAbs + '\n');
  logChild(log, '编译（kotlinc）', compile);

  // 编译后用 .class 复核主类名（源码启发式只作兜底）
  mainClass = detectMainClass(mainFileBase, mainSource, classesAbs, pkg);
  const runTarget = pkg === '' ? mainClass : pkg + '.' + mainClass;

  if (compile.spawnError !== null || compile.exitCode !== 0) {
    emit({
      ok: false, stage: 'compile',
      message: compile.spawnError ?? ('kotlinc 退出码 ' + String(compile.exitCode)),
      lang, src: relPath(cwd, srcAbs), main: relPath(cwd, mainAbs), package: pkg, mainClass,
      classesDir: relPath(cwd, classesAbs), goldenPath: relPath(cwd, goldenAbs),
      runs: 0, stable: false,
      compile: { exitCode: compile.exitCode, durationMs: compile.durationMs },
      run: { exitCode: null, durationMs: 0 }, warnings: [], logPath: logRef,
    }, raw, cwd, [
      'gen-golden  lang=' + lang + '  ' + runTarget,
      'src        ' + relPath(cwd, srcAbs),
      '编译失败   ' + (compile.spawnError ?? ('kotlinc 退出码 ' + String(compile.exitCode))) +
        '（' + formatSeconds(compile.durationMs) + '）',
      '日志       ' + logRef,
      '结果: FAIL（编译失败，看日志尾部定位）',
    ]);
  }

  // ---- 跑两次，逐字节比较 stdout ----
  const runDurations: number[] = [];
  const outputs: Buffer[] = [];
  let runExitCode: number | null = 0;
  let runs = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const run = runChild('kotlin', ['-cp', classesAbs, runTarget], cwd, timeoutMs);
    runs = attempt;
    runDurations.push(run.durationMs);
    logChild(log, '运行 #' + attempt + '（kotlin）', run);
    outputs.push(run.stdout);
    if (run.spawnError !== null || run.exitCode !== 0) {
      runExitCode = run.exitCode;
      emit({
        ok: false, stage: 'run',
        message: run.spawnError ?? ('kotlin 退出码 ' + String(run.exitCode)),
        lang, src: relPath(cwd, srcAbs), main: relPath(cwd, mainAbs), package: pkg, mainClass,
        classesDir: relPath(cwd, classesAbs), goldenPath: relPath(cwd, goldenAbs),
        runs, stable: false,
        compile: { exitCode: compile.exitCode, durationMs: compile.durationMs },
        run: { exitCode: runExitCode, durationMs: runDurations.reduce((sum, value) => sum + value, 0) },
        warnings: [], logPath: logRef, runDurations,
      }, raw, cwd, [
        'gen-golden  lang=' + lang + '  ' + runTarget,
        '编译       kotlinc ' + formatSeconds(compile.durationMs) + '（exit 0）',
        '运行失败   #' + attempt + '：' + (run.spawnError ?? ('kotlin 退出码 ' + String(run.exitCode))) +
          '（' + formatSeconds(run.durationMs) + '）',
        '日志       ' + logRef,
        '结果: FAIL（运行失败，看日志里的 stderr）',
      ]);
    }
  }

  const firstOutput = outputs[0];
  const secondOutput = outputs[1];
  const stable = firstOutput.equals(secondOutput);
  const runDurationMs = runDurations.reduce((sum, value) => sum + value, 0);
  const warnings = detectWarnings(firstOutput.toString('utf8'));
  const warningMessages = warnings.map((warning) => warning.message);

  if (!stable) {
    emit({
      ok: false, stage: 'stability',
      message: '两次 stdout 不一致：' + firstOutput.length + ' vs ' + secondOutput.length + ' 字节',
      lang, src: relPath(cwd, srcAbs), main: relPath(cwd, mainAbs), package: pkg, mainClass,
      classesDir: relPath(cwd, classesAbs), goldenPath: relPath(cwd, goldenAbs),
      runs: 2, stable: false,
      compile: { exitCode: compile.exitCode, durationMs: compile.durationMs },
      run: { exitCode: runExitCode, durationMs: runDurationMs },
      warnings: warningMessages, warningDetails: warnings, logPath: logRef, runDurations,
    }, raw, cwd, [
      'gen-golden  lang=' + lang + '  ' + runTarget,
      '编译       kotlinc ' + formatSeconds(compile.durationMs) + '（exit 0）',
      '运行       kotlin 两次 ' + runDurations.map(formatSeconds).join(' + ') + '（exit 0/0）',
      '稳定性     两次 stdout 不一致（' + firstOutput.length + ' vs ' + secondOutput.length +
        ' 字节），本次不写 golden',
      '日志       ' + logRef,
      '结果: UNSTABLE（先去掉时间戳/随机数/绝对路径再重跑）',
    ]);
  }

  // ---- 写 golden（原始字节，不做任何加工） ----
  writeFileSync(goldenAbs, firstOutput);
  const goldenHash = sha256(firstOutput);

  emit({
    ok: true,
    stage: 'stability',
    message: '两次 stdout 逐字节一致',
    lang,
    src: relPath(cwd, srcAbs),
    main: relPath(cwd, mainAbs),
    package: pkg,
    mainClass,
    classesDir: relPath(cwd, classesAbs),
    goldenPath: relPath(cwd, goldenAbs),
    runs: 2,
    stable: true,
    compile: { exitCode: compile.exitCode, durationMs: compile.durationMs },
    run: { exitCode: runExitCode, durationMs: runDurationMs },
    warnings: warningMessages,
    warningDetails: warnings,
    logPath: logRef,
    goldenSha256: goldenHash,
    goldenBytes: firstOutput.length,
    runDurations,
  }, raw, cwd, [
    'gen-golden  lang=' + lang + '  ' + runTarget,
    'src        ' + srcArg + '（' + countKtFiles(srcAbs) + ' 个 .kt）',
    '编译       kotlinc ' + formatSeconds(compile.durationMs) + '（exit 0）',
    '运行       kotlin 两次 ' + runDurations.map(formatSeconds).join(' + ') + '（exit 0/0）',
    '稳定性     两次 stdout 逐字节一致  sha256 ' + goldenHash.slice(0, 12) + '…  ' + firstOutput.length + ' 字节',
    'golden     ' + relPath(cwd, goldenAbs),
    '日志       ' + logRef,
    '结果: OK' + (warningMessages.length > 0
      ? '（WARN ' + warningMessages.length + ' 条，不阻塞：' + oneLine(warningMessages.join('；'), 80) + '）'
      : ''),
  ]);
}


// ---------------------------------------------------------------------------
// js-ts：node harness（无需编译；--main 所在目录作为源根做越界守卫）
// ---------------------------------------------------------------------------

function copyNodeHarnessSkeleton(outAbs: string): { skeletonAbs: string; source: string } {
  const skeletonAbs = join(outAbs, 'harness.mjs');
  const templateAbs = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'node-harness', 'harness.example.mjs');
  if (isFile(templateAbs)) {
    copyFileSync(templateAbs, skeletonAbs);
    return { skeletonAbs, source: relPath(process.cwd(), templateAbs) };
  }
  writeFileSync(skeletonAbs, NODE_HARNESS_SKELETON, 'utf8');
  return { skeletonAbs, source: '内嵌骨架（templates/node-harness/harness.example.mjs 缺失）' };
}

function runJsTs(raw: RawCli, cwd: string, timeoutMs: number): void {
  const lang = 'js-ts';
  if (optional(raw, 'src') !== null) {
    failUsage('--lang js-ts 不需要 --src（harness 自包含；越界守卫按 --main 所在目录推断）');
  }
  if (optional(raw, 'package') !== null) {
    failUsage('--package 仅 --lang jvm 支持（js-ts 没有 Kotlin 包名）');
  }

  const mainArg = optional(raw, 'main');
  const outArg = optional(raw, 'out') ?? DEFAULT_OUT;
  const outAbs = resolve(cwd, outArg);
  const goldenAbs = join(outAbs, 'golden.json');
  const logsArg = optional(raw, 'logs');
  const logsAbs = logsArg === null ? resolve(cwd, join('out', 'logs')) : resolve(cwd, logsArg);
  const logAbs = join(logsAbs, 'gen-golden.log');
  const logRef = relPath(cwd, logAbs);

  // js-ts 的源根：--main 所在目录（与 jvm 的 --src 守卫语义一致，绝不把产物写进源码/ harness 目录）
  const mainAbs = mainArg === null ? null : resolve(cwd, mainArg);
  const guardRoot = mainAbs === null ? null : dirname(mainAbs);
  if (guardRoot !== null) {
    if (isWithin(outAbs, guardRoot)) {
      failUsage('--out 不能等于或位于 --main 所在目录内（gen-golden 只写 <out>，绝不污染 harness/源码）：--out=' +
        outArg + '，--main=' + mainArg + '；请把 --out 指到该目录之外（如 --out out/gen-golden）');
    }
    if (isWithin(logsAbs, guardRoot)) {
      failUsage('--logs 不能位于 --main 所在目录内（日志不得写进 harness/源码目录）：--logs=' +
        (logsArg === null ? join('out', 'logs') : logsArg) + '，--main=' + mainArg +
        '；请把 --logs 指到该目录之外（如 --logs out/logs）');
    }
  }

  mkdirSync(outAbs, { recursive: true });

  // ---- 缺 harness：复制骨架，exit 4（不设计场景） ----
  if (mainAbs === null || !isFile(mainAbs)) {
    const reason = mainArg === null ? '未提供 --main' : '找不到 ' + mainArg;
    const skeleton = copyNodeHarnessSkeleton(outAbs);
    emit({
      ok: false, stage: 'harness',
      message: reason + '，已复制骨架到 ' + relPath(cwd, skeleton.skeletonAbs) + '，补完场景后重跑',
      lang, src: null, main: mainArg, package: null, mainClass: null,
      classesDir: null, goldenPath: null, runs: 0, stable: false,
      compile: { exitCode: null, durationMs: 0 }, run: { exitCode: null, durationMs: 0 },
      warnings: [], logPath: null,
      skeletonPath: relPath(cwd, skeleton.skeletonAbs),
      skeletonSource: skeleton.source,
    }, raw, cwd, [
      'gen-golden  lang=' + lang,
      'harness    ' + reason + ' → 已复制骨架：' + relPath(cwd, skeleton.skeletonAbs),
      'TODO       按目标模块补场景（固定输入 → console.log 稳定 JSON），然后重跑本命令',
      '结果: HARNESS（未生成 golden；场景设计归 agent）',
    ]);
  }

  const mainRel = relPath(cwd, mainAbs);
  const log = createLog(logAbs);
  log.append('# harness: ' + mainAbs + '\n');
  rmSync(goldenAbs, { force: true });

  // ---- 环境检查（node --version 代替 compile 阶段） ----
  const compile = runChild(process.execPath, ['--version'], cwd, timeoutMs);
  const nodeVersion = compile.stdout.toString('utf8').trim().split('\n')[0] ?? '';
  const nodeVersionField = nodeVersion === '' ? null : nodeVersion;
  logChild(log, '运行环境（node --version）', compile);
  if (compile.spawnError !== null || compile.exitCode !== 0) {
    emit({
      ok: false, stage: 'compile',
      message: compile.spawnError ?? ('node --version 退出码 ' + String(compile.exitCode)),
      lang, src: null, main: mainRel, package: null, mainClass: null,
      classesDir: null, goldenPath: relPath(cwd, goldenAbs),
      runs: 0, stable: false,
      compile: { exitCode: compile.exitCode, durationMs: compile.durationMs },
      run: { exitCode: null, durationMs: 0 }, warnings: [], logPath: logRef,
      nodeVersion: nodeVersionField,
    }, raw, cwd, [
      'gen-golden  lang=' + lang + '  ' + mainRel,
      '环境检查失败  ' + (compile.spawnError ?? ('node --version 退出码 ' + String(compile.exitCode))) +
        '（' + formatSeconds(compile.durationMs) + '）',
      '日志       ' + logRef,
      '结果: FAIL（环境检查失败，看日志）',
    ]);
  }

  // ---- 跑两次，逐字节比较 stdout ----
  const runDurations: number[] = [];
  const outputs: Buffer[] = [];
  let runExitCode: number | null = 0;
  let runs = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const run = runChild(process.execPath, [mainAbs], cwd, timeoutMs);
    runs = attempt;
    runDurations.push(run.durationMs);
    logChild(log, '运行 #' + attempt + '（node）', run);
    outputs.push(run.stdout);
    if (run.spawnError !== null || run.exitCode !== 0) {
      runExitCode = run.exitCode;
      emit({
        ok: false, stage: 'run',
        message: run.spawnError ?? ('node 退出码 ' + String(run.exitCode)),
        lang, src: null, main: mainRel, package: null, mainClass: null,
        classesDir: null, goldenPath: relPath(cwd, goldenAbs),
        runs, stable: false,
        compile: { exitCode: compile.exitCode, durationMs: compile.durationMs },
        run: { exitCode: runExitCode, durationMs: runDurations.reduce((sum, value) => sum + value, 0) },
        warnings: [], logPath: logRef, runDurations,
        nodeVersion: nodeVersionField,
      }, raw, cwd, [
        'gen-golden  lang=' + lang + '  ' + mainRel,
        '环境       node ' + nodeVersion + '（' + formatSeconds(compile.durationMs) + '）',
        '运行失败   #' + attempt + '：' + (run.spawnError ?? ('node 退出码 ' + String(run.exitCode))) +
          '（' + formatSeconds(run.durationMs) + '）',
        '日志       ' + logRef,
        '结果: FAIL（运行失败，看日志里的 stderr）',
      ]);
    }
  }

  const firstOutput = outputs[0];
  const secondOutput = outputs[1];
  const stable = firstOutput.equals(secondOutput);
  const runDurationMs = runDurations.reduce((sum, value) => sum + value, 0);
  const warnings = detectWarnings(firstOutput.toString('utf8'));
  const warningMessages = warnings.map((warning) => warning.message);

  if (!stable) {
    emit({
      ok: false, stage: 'stability',
      message: '两次 stdout 不一致：' + firstOutput.length + ' vs ' + secondOutput.length + ' 字节',
      lang, src: null, main: mainRel, package: null, mainClass: null,
      classesDir: null, goldenPath: relPath(cwd, goldenAbs),
      runs: 2, stable: false,
      compile: { exitCode: compile.exitCode, durationMs: compile.durationMs },
      run: { exitCode: runExitCode, durationMs: runDurationMs },
      warnings: warningMessages, warningDetails: warnings, logPath: logRef, runDurations,
      nodeVersion: nodeVersionField,
    }, raw, cwd, [
      'gen-golden  lang=' + lang + '  ' + mainRel,
      '环境       node ' + nodeVersion + '（' + formatSeconds(compile.durationMs) + '）',
      '运行       node 两次 ' + runDurations.map(formatSeconds).join(' + ') + '（exit 0/0）',
      '稳定性     两次 stdout 不一致（' + firstOutput.length + ' vs ' + secondOutput.length +
        ' 字节），本次不写 golden',
      '日志       ' + logRef,
      '结果: UNSTABLE（先去掉时间戳/随机数/绝对路径再重跑）',
    ]);
  }

  // ---- 写 golden（harness stdout 原始字节） ----
  writeFileSync(goldenAbs, firstOutput);
  const goldenHash = sha256(firstOutput);

  emit({
    ok: true,
    stage: 'stability',
    message: '两次 stdout 逐字节一致',
    lang,
    src: null,
    main: mainRel,
    package: null,
    mainClass: null,
    classesDir: null,
    goldenPath: relPath(cwd, goldenAbs),
    runs: 2,
    stable: true,
    compile: { exitCode: compile.exitCode, durationMs: compile.durationMs },
    run: { exitCode: runExitCode, durationMs: runDurationMs },
    warnings: warningMessages,
    warningDetails: warnings,
    logPath: logRef,
    goldenSha256: goldenHash,
    goldenBytes: firstOutput.length,
    runDurations,
    nodeVersion: nodeVersionField,
  }, raw, cwd, [
    'gen-golden  lang=' + lang + '  ' + mainRel,
    '环境       node ' + nodeVersion + '（' + formatSeconds(compile.durationMs) + '）',
    '运行       node 两次 ' + runDurations.map(formatSeconds).join(' + ') + '（exit 0/0）',
    '稳定性     两次 stdout 逐字节一致  sha256 ' + goldenHash.slice(0, 12) + '…  ' + firstOutput.length + ' 字节',
    'golden     ' + relPath(cwd, goldenAbs),
    '日志       ' + logRef,
    '结果: OK' + (warningMessages.length > 0
      ? '（WARN ' + warningMessages.length + ' 条，不阻塞：' + oneLine(warningMessages.join('；'), 80) + '）'
      : ''),
  ]);
}

main();
