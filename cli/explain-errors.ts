#!/usr/bin/env node
/**
 * ArkTS 错误解释器：把 lint / reachability-probe 的产物变成确定性可读清单。
 *
 * 用法：
 *   node cli/explain-errors.ts --log <hvigor.log|errors.json> --root <ets-root>
 *        [--max 20] [--rule arkts-*] [--json] [--report <path>]
 *
 * 两种输入（自动识别）：ArkTS 错误 JSON（[{code,file,line,col}]）或 hvigor 日志
 * （复用 lint/probe 的 Error Message / At File / (arkts-*) 解析，WARN 级 arkts 违规也收）。
 * 每条错误输出：规则 / file:line:col / 源码行 + 前后 2 行 / 修法锚点
 * （rules/arkts-restrictions.md 的规则名与修法）。file="?" 的无位置错误单列。
 *
 * 源码解析：--root 下依次尝试「原路径 → 逐个去掉前导目录 → .ets/.ts 扩展名互换」，
 * 因此 parity/model/X.ets 能命中 <root>/model/X.ts，探针临时副本的绝对路径也能收敛。
 *
 * 输出：默认只打印前 --max 条 + 按规则计数；--report / --json 给全量。
 * 退出码：0 = 读取成功（有错也 0）；2 = 用法/文件缺失/输入不可解析。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(fileURLToPath(import.meta.url));
const RULES_REF = 'rules/arkts-restrictions.md';
const RULES_PATH = join(cliDir, '..', RULES_REF);
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const WARN_FILE = /ArkTS:WARN File:\s+(.+?):(\d+):(\d+)\s*$/;

const USAGE = [
  '用法：',
  '  node cli/explain-errors.ts --log <hvigor.log|errors.json> [--root <ets-root>]',
  '       [--max 20] [--rule arkts-*] [--json] [--report <path>]',
  '',
  '把 ArkTS 错误变成「规则 / file:line:col / 源码片段 / 修法锚点」清单。',
  '',
  '参数：',
  '  --log <path>     输入文件（必填）：lint/probe 的 hvigor 日志，或 [{code,file,line,col}] JSON',
  '  --root <dir>     源码根（默认 cwd）：用于打印源码行与前后 2 行；不在 root 下也能按后缀匹配',
  '  --max <n>        默认文本模式最多打印 n 条（默认 20；0 = 只打印计数）',
  '  --rule <glob>    按规则过滤，支持一个 * 通配，可逗号分隔（如 arkts-*、arkts-no-as-const）',
  '  --json           stdout 只输出结构化 JSON（errors 全量，不受 --max 截断）',
  '  --report <path>  把同一份 JSON 写到文件（目录自动创建）',
  '  --help, -h       显示本帮助',
  '',
  '输出（默认）：',
  '  总数 / 文件数 / 无位置条数 / 按规则计数',
  '  前 --max 条：规则、file:line:col、修法、源码片段（目标行以 > 标记）',
  '  无位置错误（file="?"）单列，并说明无法给源码片段',
  '',
  '退出码：0 = 读取成功（有错也 0）；2 = 用法/文件缺失/输入不可解析',
].join('\n');

const VALUE_OPTS = new Set(['log', 'root', 'max', 'rule', 'report']);
const BOOL_OPTS = new Set(['json', 'help']);

interface ErrorEntry {
  level: string | null;
  rule: string;
  message: string | null;
  file: string;
  line: number;
  col: number;
}

interface SnippetLine {
  line: number;
  text: string;
  target: boolean;
}

interface Snippet {
  path: string;
  startLine: number;
  lines: SnippetLine[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failUsage(message: string): never {
  console.error('explain-errors: ' + message);
  console.error('用法见：node cli/explain-errors.ts --help');
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

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** 解析 rules/arkts-restrictions.md 的规则表：规则名 -> 含义 / 修法 */
function loadRuleAnchors(): Map<string, { meaning: string; fix: string }> {
  const anchors = new Map<string, { meaning: string; fix: string }>();
  let text = '';
  try {
    text = readFileSync(RULES_PATH, 'utf8');
  } catch {
    return anchors;
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const rule = /^`(arkts-[a-z-]+)`$/.exec(cells[1] ?? '');
    if (!rule) continue;
    anchors.set(rule[1], {
      meaning: cells[3] ?? '',
      fix: cells[4] ?? '',
    });
  }
  return anchors;
}

/** hvigor 日志：ERROR 是单行 Error Message，WARN 是两行 ArkTS:WARN File + 消息行 */
function parseHvigorLog(text: string): ErrorEntry[] {
  const clean = text.replace(ANSI, '');
  const lines = clean.split('\n');
  const errors: ErrorEntry[] = [];
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

function normalizeJsonEntry(raw: unknown): ErrorEntry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rule = asText(record.code ?? record.rule ?? '?') || '?';
  const file = asText(record.file ?? record.filePath ?? '?') || '?';
  const levelRaw = record.level ?? record.severity;
  return {
    level: levelRaw === undefined ? null : asText(levelRaw),
    rule,
    message: record.message === undefined ? null : asText(record.message),
    file,
    line: asNumber(record.line ?? record.lineno ?? 0),
    col: asNumber(record.col ?? record.column ?? 0),
  };
}

function loadInput(inputPath: string): { type: 'json' | 'log'; errors: ErrorEntry[] } {
  let text = '';
  try {
    text = readFileSync(inputPath, 'utf8');
  } catch {
    failUsage('无法读取 --log 文件：' + inputPath);
  }
  const trimmed = text.trim();
  // JSON 判定要避开 hvigor 日志行首的时间戳 "[2026-...]"
  const looksJson = trimmed.startsWith('{') || /^\[\s*[{\]]/.test(trimmed);
  if (looksJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      failUsage('输入像 JSON 但解析失败：' + inputPath + '（' + errorMessage(error) + '）');
    }
    let list: unknown[] | null = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed !== null && typeof parsed === 'object' &&
      Array.isArray((parsed as Record<string, unknown>).errors)) {
      list = (parsed as Record<string, unknown>).errors as unknown[];
    }
    if (list === null) {
      failUsage('JSON 结构不认识（期望 [{code,file,line,col}] 或 {errors:[...]}）：' + inputPath);
    }
    const errors: ErrorEntry[] = [];
    for (const item of list) {
      const normalized = normalizeJsonEntry(item);
      if (normalized !== null) errors.push(normalized);
    }
    return { type: 'json', errors };
  }
  return { type: 'log', errors: parseHvigorLog(text) };
}

function ruleMatches(rule: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (!pattern.includes('*')) {
      if (rule === pattern) return true;
      continue;
    }
    const star = pattern.indexOf('*');
    if (star !== pattern.lastIndexOf('*')) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (rule.startsWith(prefix) && rule.endsWith(suffix)) return true;
  }
  return false;
}

function extVariants(rel: string): string[] {
  if (/\.ets$/i.test(rel)) return [rel, rel.replace(/\.ets$/i, '.ts')];
  if (/\.ts$/i.test(rel)) return [rel, rel.replace(/\.ts$/i, '.ets')];
  return [rel, rel + '.ets', rel + '.ts'];
}

/** 在 root 下找源码：原路径 -> 去前导目录 -> 扩展名互换；探针临时副本的绝对路径也能收敛 */
function resolveSource(root: string, file: string): string | null {
  if (file === '?' || file === '') return null;
  const candidates: string[] = [];
  const push = (candidate: string): void => {
    if (candidate !== '' && !candidates.includes(candidate)) candidates.push(candidate);
  };
  if (isAbsolute(file)) {
    for (const variant of extVariants(file)) push(variant);
  }
  const segments = file.replace(/\\/g, '/').split('/').filter((part) => part !== '');
  for (let i = 0; i < segments.length; i++) {
    const rel = segments.slice(i).join('/');
    for (const variant of extVariants(rel)) push(join(root, variant));
  }
  if (!isAbsolute(file)) {
    for (const variant of extVariants(file)) push(resolve(file));
  }
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function readSnippet(sourcePath: string, line: number, context = 2): Snippet | null {
  if (line <= 0) return null;
  let text = '';
  try {
    text = readFileSync(sourcePath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + context);
  const out: SnippetLine[] = [];
  for (let n = from; n <= to; n++) {
    out.push({ line: n, text: lines[n - 1] ?? '', target: n === line });
  }
  return { path: sourcePath, startLine: from, lines: out };
}

function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  return path;
}

function sortedRules(errors: ErrorEntry[]): Array<{ rule: string; count: number }> {
  const counts = new Map<string, number>();
  for (const error of errors) counts.set(error.rule, (counts.get(error.rule) ?? 0) + 1);
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

function writeReport(reportPath: string, text: string): void {
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, text, 'utf8');
  } catch (error) {
    failUsage('无法写入 --report ' + reportPath + '：' + errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

if (args.log === undefined) failUsage('缺少 --log（hvigor 日志或错误 JSON）');
const cwd = process.cwd();
const inputPath = resolve(cwd, String(args.log));
if (!isFile(inputPath)) failUsage('--log 文件不存在：' + String(args.log));

const root = resolve(cwd, args.root === undefined ? '.' : String(args.root));
if (!isDirectory(root)) failUsage('--root 目录不存在：' + String(args.root ?? '.'));

let maxCount = 20;
if (args.max !== undefined) {
  const parsed = Number(args.max);
  if (!Number.isInteger(parsed) || parsed < 0) failUsage('--max 必须是非负整数：' + String(args.max));
  maxCount = parsed;
}

let ruleFilterRaw: string | null = null;
let rulePatterns: string[] = [];
if (args.rule !== undefined) {
  ruleFilterRaw = String(args.rule);
  rulePatterns = ruleFilterRaw.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (rulePatterns.length === 0) failUsage('--rule 不能为空');
}

const jsonOut = args.json === true;
const reportPath = args.report === undefined ? null : resolve(cwd, String(args.report));

const input = loadInput(inputPath);
const anchors = loadRuleAnchors();
const allErrors = input.errors;
const errors = rulePatterns.length === 0
  ? allErrors
  : allErrors.filter((error) => ruleMatches(error.rule, rulePatterns));

const byRule = sortedRules(errors);
const noLocation = errors.filter((error) => error.file === '?');
const located = errors.filter((error) => error.file !== '?');
const files = new Set(located.map((error) => error.file));

const inputDisplay = displayPath(cwd, inputPath);
const entryCache = new Map<string, string | null>();
const resolvedOf = (file: string): string | null => {
  if (!entryCache.has(file)) entryCache.set(file, resolveSource(root, file));
  return entryCache.get(file) ?? null;
};

const entries = errors.map((error, index) => {
  const sourcePath = error.file === '?' ? null : resolvedOf(error.file);
  const snippet = sourcePath === null ? null : readSnippet(sourcePath, error.line);
  const anchor = anchors.get(error.rule);
  return {
    index: index + 1,
    level: error.level,
    rule: error.rule,
    message: error.message,
    file: error.file,
    line: error.line,
    col: error.col,
    sourcePath: sourcePath === null ? null : displayPath(root, sourcePath),
    sourceMissing: error.file !== '?' && sourcePath === null,
    anchor: anchor === undefined ? null : RULES_REF,
    meaning: anchor === undefined ? null : anchor.meaning,
    fix: anchor === undefined ? null : anchor.fix,
    snippet: snippet === null
      ? null
      : { startLine: snippet.startLine, lines: snippet.lines },
  };
});

/** located/errors 里的对象引用 → entries 里对应的结构化条目 */
const entryOf = new Map<ErrorEntry, (typeof entries)[number]>();
errors.forEach((error, index) => entryOf.set(error, entries[index]));

const payload = {
  input: inputDisplay,
  inputType: input.type,
  root,
  filters: { rule: ruleFilterRaw, max: maxCount },
  total: errors.length,
  fileCount: files.size + (noLocation.length > 0 ? 1 : 0), // 与原始 JSON 的 distinct file 口径一致（含 "?"）
  locatedFileCount: files.size,
  noLocationCount: noLocation.length,
  byRule: byRule.map((item) => {
    const anchor = anchors.get(item.rule);
    return {
      rule: item.rule,
      count: item.count,
      anchor: anchor === undefined ? null : RULES_REF,
      meaning: anchor === undefined ? null : anchor.meaning,
      fix: anchor === undefined ? null : anchor.fix,
    };
  }),
  errors: entries,
};
const payloadText = JSON.stringify(payload, null, 2) + '\n';

if (jsonOut) {
  process.stdout.write(payloadText);
} else {
  const out: string[] = [];
  out.push('explain-errors: 输入 ' + inputDisplay + '（' +
    (input.type === 'json' ? 'ArkTS 错误 JSON' : 'hvigor 日志') + '）');
  out.push('源码根: ' + root);
  const fileNote = files.size + ' 个文件' +
    (noLocation.length > 0 ? ' + ' + noLocation.length + ' 条无位置（file="?"）' : '');
  out.push('共 ' + errors.length + ' 条，' + fileNote +
    (ruleFilterRaw === null ? '' : '  [--rule ' + ruleFilterRaw + ']'));
  if (byRule.length > 0) {
    out.push('按规则:');
    for (const item of byRule) {
      const anchor = anchors.get(item.rule);
      out.push('  ' + String(item.count).padStart(4) + '  ' + item.rule +
        (anchor === undefined ? '' : '  → ' + RULES_REF + '：' + anchor.meaning));
    }
  } else {
    out.push('按规则:（没有符合条件的错误）');
  }

  if (maxCount > 0 && located.length > 0) {
    const shown = located.slice(0, maxCount);
    out.push('');
    for (let i = 0; i < shown.length; i++) {
      const error = shown[i];
      const entry = entryOf.get(error);
      const anchor = anchors.get(error.rule);
      out.push('── ' + (i + 1) + '/' + located.length + '  ' + error.rule + '  ' +
        error.file + ':' + error.line + ':' + error.col +
        (error.level === null ? '' : '  [' + error.level + ']'));
      out.push('   修法: ' + (anchor === undefined
        ? RULES_REF + '（按规则名 ' + error.rule + ' 查规则表）'
        : RULES_REF + '（' + error.rule + '）：' + anchor.fix));
      if (error.message !== null) out.push('   消息: ' + error.message);
      if (entry !== null && entry.snippet !== null) {
        out.push('   源码: ' + String(entry.sourcePath));
        for (const line of entry.snippet.lines) {
          out.push('     ' + (line.target ? '>' : ' ') + String(line.line).padStart(4) +
            ' | ' + line.text);
        }
      } else {
        out.push('   源码: 未在 --root 下找到（已试过去前缀 + .ets/.ts 互换）');
      }
      if (i < shown.length - 1) out.push('');
    }
    if (located.length > shown.length) {
      out.push('');
      out.push('... 还有 ' + (located.length - shown.length) +
        ' 条未打印（--max 或 --report/--json 看全量）');
    }
  } else if (maxCount === 0) {
    out.push('');
    out.push('（--max 0：不打印条目；完整清单见 --report/--json）');
  }

  if (noLocation.length > 0) {
    out.push('');
    out.push('无位置错误（file="?"，共 ' + noLocation.length + ' 条，无法给源码片段）:');
    out.push('  说明：globalThis 这类全局规则编译器不提供 File 位置（line/col 记为 0:0），只能按规则名修');
    for (const error of noLocation.slice(0, Math.max(maxCount, 1))) {
      const anchor = anchors.get(error.rule);
      out.push('  - ' + error.rule +
        (error.message === null ? '' : '：' + error.message) +
        (anchor === undefined ? '' : '  → ' + RULES_REF + '（' + error.rule + '）'));
    }
    if (noLocation.length > Math.max(maxCount, 1)) {
      out.push('  ... 省略 ' + (noLocation.length - Math.max(maxCount, 1)) + ' 条');
    }
  }
  console.log(out.join('\n'));
}

if (reportPath !== null) writeReport(reportPath, payloadText);
// 不调用 process.exit：stdout 是管道时大 JSON 会被截断；用 exitCode 让 Node 正常 flush
process.exitCode = 0;
