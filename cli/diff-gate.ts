#!/usr/bin/env node
/**
 * diff-gate —— 适配「只动类型层」的告警门禁。
 *
 * 背景：adapt-arkts 的合法性建立在「只改类型层、不动运行时语句」上（docs/tooling-backlog.md A4）。
 * 这个工具把「reviewer 人工读 diff」变成确定性检查：按相对路径配对 before/after 的 .ts/.ets，
 * 做行级 diff（自实现 Myers，零依赖），把每个变更区域分类成
 *
 *   - type-only   ：interface 声明/字段、constructor(options: <Class>Options)、copy(patch: <Class>Patch)、
 *                   type XValue / interface XMap、显式类型标注、as const 删除后的 XMap 标注等
 *   - import-path ：仅相对 import 说明符的 .ts 扩展名增删（--ets 产物）
 *   - needs-review：函数体/语句/表达式/控制流/字符串字面量等任何可能改运行时的行；
 *                   只在一边存在的文件（新增/删除）也算 needs-review。
 *
 * 用法：
 *   node cli/diff-gate.ts --before <dir> --after <dir> [--json] [--report <path>] [--max 20] [--strict]
 *
 *   --before <dir>   适配前目录（例如 .refs/arkts-adapt-baseline）
 *   --after <dir>    适配后目录（例如 out/adapt 或 .refs/pag-exp/ts）
 *   --json           把报告打到 stdout（只有 JSON）
 *   --report <path>  把报告写成 JSON 文件（父目录会自动创建）
 *   --max <n>        人类摘要里最多列出的 needs-review 条数（默认 20；摘要整体 ≤15 行，故最多打印 10 条）
 *   --strict         有 needs-review 时退出码 1（默认 3，不阻止构建）
 *   --help, -h       打印本帮助
 *
 * 退出码：0 = 无 needs-review；
 *         3 = 有 needs-review（告警，不阻止构建；--strict 时是 1）；
 *         1 = 读取/参数错误（目录不存在、文件读不了、--report 写不了）；--strict 且有 needs-review 也是 1；
 *         2 = 用法错误（缺参数、未知参数、--max 不是正整数）。
 *
 * 报告 JSON：
 *   {
 *     "ok": true,
 *     "before": "<--before 原样>",
 *     "after": "<--after 原样>",
 *     "files": [ { "path": "layout/ReaderPaginator.ts", "status": "modified",
 *                  "hunks": [ { "line": 12, "kind": "type-only", "before": null, "after": "export interface ..." } ] } ],
 *     "counts": { "typeOnly": 0, "importPath": 0, "needsReview": 0, "cannotPair": 0 }
 *   }
 *
 * 约定 / 口径：
 *   - 配对：把 relative path 的 .ts/.ets 扩展名去掉后配对（--ets 后扩展名会变）；
 *     只在一边存在的文件 status=added/removed，每个文件一条 kind=needs-review 的 hunk。
 *   - hunk = 一段连续变更区域（中间没有相同行的其它改动）；line 取 after 文件里的起始行，
 *     纯删除区域取 before 文件里的起始行；before/after 是该区域被删/增的行文本（用换行连接，缺省 null）。
 *   - counts：typeOnly/importPath/needsReview 是 hunk 计数；cannotPair 是只在一边存在的文件数
 *     （它们的 hunk 已计入 needsReview，不重复计入其它类别）。
 *   - ok = 没有任何 needs-review hunk。
 *   - 内容完全相同、只是扩展名不同的文件不算变更（不产生 hunk）。
 *   - 确定性：同一输入逐字节相同输出；人类摘要不打印绝对路径，报告里的 before/after 是命令行原样。
 *   - 只比较 .ts/.ets；不读其它文件、不写 --before/--after 目录。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_NEEDS_REVIEW = 3;

const KIND_TYPE_ONLY = 'type-only';
const KIND_IMPORT_PATH = 'import-path';
const KIND_NEEDS_REVIEW = 'needs-review';

const HUMAN_MAX_ENTRIES = 10;

class UsageError extends Error {}
class InputError extends Error {}

const USAGE = [
  'diff-gate —— 适配「只动类型层」的告警门禁（自实现行级 diff，零依赖）',
  '',
  '用法：',
  '  node cli/diff-gate.ts --before <dir> --after <dir> [--json] [--report <path>]',
  '                       [--max 20] [--strict]',
  '',
  '参数：',
  '  --before <dir>   适配前目录（如 .refs/arkts-adapt-baseline）',
  '  --after <dir>    适配后目录（如 out/adapt 或 .refs/pag-exp/ts）',
  '  --json           把报告打到 stdout',
  '  --report <path>  把报告写成 JSON 文件',
  '  --max <n>        人类摘要里最多列出的 needs-review 条数（默认 20，摘要最多打印 10 条）',
  '  --strict         有 needs-review 时退出码 1（默认 3，不阻止构建）',
  '  --help, -h       打印本帮助',
  '',
  '分类：type-only（interface/构造器 Options/copy Patch/类型改名/XMap/as const 等）｜',
  '      import-path（仅相对 import 的 .ts 后缀变化）｜needs-review（可能改运行时；新增/删除文件）',
  '退出码：0 无 needs-review；3 有 needs-review（--strict 时 1）；1 读取/参数错误；2 用法错误。',
].join('\n');

/* ------------------------------------------------------------------ 参数 */

interface CliOptions {
  before: string;
  after: string;
  json: boolean;
  report: string | null;
  max: number;
  strict: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { before: '', after: '', json: false, report: null, max: 20, strict: false, help: false };
  const valueFlags = new Set(['before', 'after', 'report', 'max']);
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    if (!argument.startsWith('--')) throw new UsageError('不认识的参数：' + argument);
    let key = argument.slice(2);
    let value: string | null = null;
    const eq = key.indexOf('=');
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    if (valueFlags.has(key)) {
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw new UsageError('--' + key + ' 缺少取值');
        value = next;
        i++;
      }
      if (value === '') throw new UsageError('--' + key + ' 缺少取值');
      if (key === 'before') options.before = value;
      else if (key === 'after') options.after = value;
      else if (key === 'report') options.report = value;
      else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError('--max 必须是正整数：' + value);
        options.max = parsed;
      }
      continue;
    }
    if (value !== null) throw new UsageError('--' + key + ' 不接受取值');
    if (key === 'json') options.json = true;
    else if (key === 'strict') options.strict = true;
    else throw new UsageError('不认识的参数：--' + key);
  }
  return options;
}

/* ------------------------------------------------------------------ 文件读取 */

interface SourceFile {
  rel: string;
  lines: string[];
}

function walkSource(root: string, prefix = ''): string[] {
  const found: string[] = [];
  const entries = readdirSync(prefix === '' ? root : join(root, prefix), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) {
      for (const nested of walkSource(root, rel)) found.push(nested);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.ets'))) {
      found.push(rel);
    }
  }
  return found;
}

function readSource(root: string, rel: string): SourceFile {
  let text: string;
  try {
    text = readFileSync(join(root, rel.split('/').join(sep)), 'utf8');
  } catch (error) {
    throw new InputError('读取失败：' + rel + '（' + (error instanceof Error ? error.message : String(error)) + '）');
  }
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { rel, lines };
}

function collectDir(rootArg: string, label: string): { root: string; files: SourceFile[] } {
  const root = resolve(rootArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new InputError(label + ' 不是目录：' + rootArg);
  }
  let rels: string[];
  try {
    rels = walkSource(root);
  } catch (error) {
    throw new InputError('扫描失败：' + rootArg + '（' + (error instanceof Error ? error.message : String(error)) + '）');
  }
  const files = rels.map((rel) => readSource(root, rel));
  return { root, files };
}

/* ------------------------------------------------------------------ Myers 行级 diff */

interface DiffOp {
  type: string;
  ai: number;
  bi: number;
}

const TRACE_BYTE_LIMIT = 256 * 1024 * 1024;

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, bi) => ({ type: 'insert', ai: -1, bi }));
  if (m === 0) return a.map((_, ai) => ({ type: 'delete', ai, bi: -1 }));
  const max = n + m;
  const offset = max + 1;
  const size = 2 * max + 3;
  const v = new Int32Array(size);
  const trace: Int32Array[] = [];
  let foundD = -1;
  for (let d = 0; d <= max; d++) {
    if ((trace.length + 1) * size * 4 > TRACE_BYTE_LIMIT) {
      // 超大 diff 的兜底：前缀相同 + 中间整块视为一次替换（宁可多报 needs-review，不 OOM）
      return diffFallback(a, b);
    }
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { foundD = d; break; }
    }
    if (foundD >= 0) break;
  }
  if (foundD < 0) return diffFallback(a, b);

  const script: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      script.push({ type: 'equal', ai: x - 1, bi: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) {
      script.push({ type: 'insert', ai: -1, bi: y - 1 });
      y--;
    } else {
      script.push({ type: 'delete', ai: x - 1, bi: -1 });
      x--;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    script.push({ type: 'equal', ai: x - 1, bi: y - 1 });
    x--;
    y--;
  }
  script.reverse();
  return script;
}

function diffFallback(a: string[], b: string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const script: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) script.push({ type: 'equal', ai: i, bi: i });
  for (let i = prefix; i < a.length - suffix; i++) script.push({ type: 'delete', ai: i, bi: -1 });
  for (let i = prefix; i < b.length - suffix; i++) script.push({ type: 'insert', ai: -1, bi: i });
  for (let i = a.length - suffix; i < a.length; i++) {
    script.push({ type: 'equal', ai: i, bi: i - a.length + b.length });
  }
  return script;
}

/* ------------------------------------------------------------------ 变更区域 */

interface Region {
  removed: Array<{ index: number; text: string }>;
  added: Array<{ index: number; text: string }>;
}

function buildRegions(ops: DiffOp[], beforeLines: string[], afterLines: string[]): Region[] {
  const regions: Region[] = [];
  let current: Region | null = null;
  for (const op of ops) {
    if (op.type === 'equal') {
      if (current !== null) { regions.push(current); current = null; }
      continue;
    }
    if (current === null) current = { removed: [], added: [] };
    if (op.type === 'delete') current.removed.push({ index: op.ai, text: beforeLines[op.ai] });
    else current.added.push({ index: op.bi, text: afterLines[op.bi] });
  }
  if (current !== null) regions.push(current);
  return regions;
}

/* ------------------------------------------------------------------ 类型结构分析 */

function stripStringsAndLineComment(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '"' || c === "'" || c === String.fromCharCode(96)) {
      const quote = c;
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function braceDelta(line: string): number {
  const code = stripStringsAndLineComment(line);
  let delta = 0;
  for (const c of code) {
    if (c === '{') delta++;
    else if (c === '}') delta--;
  }
  return delta;
}

function countParens(line: string): number {
  const code = stripStringsAndLineComment(line);
  let delta = 0;
  for (const c of code) {
    if (c === '(') delta++;
    else if (c === ')') delta--;
  }
  return delta;
}

/** 标记每行是否属于「声明的参数列表」（多行签名里 ')' 后面是类型+'{' 的那种）。 */
function analyzeParamContext(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const code = stripStringsAndLineComment(lines[i]);
    const trimmed = code.trim();
    if (!/^(?:export\s+)?(?:(?:static|private|public|protected|async|readonly)\s+)*(?:function\s+)?[A-Za-z_$][\w$]*\s*\(/.test(trimmed)) continue;
    if (/^(?:if|while|for|switch|catch|return|typeof|new|await|yield|do)\b/.test(trimmed)) continue;
    if (code.indexOf('=') >= 0) continue; // 带默认值的签名：不把里面的对象字面量当参数注解
    const delta = countParens(code);
    if (delta <= 0) continue;
    let depth = delta;
    let closeLine = -1;
    for (let j = i + 1; j < lines.length; j++) {
      depth += countParens(stripStringsAndLineComment(lines[j]));
      if (depth <= 0) { closeLine = j; break; }
    }
    if (closeLine < 0) continue;
    const closeCode = stripStringsAndLineComment(lines[closeLine]);
    const closePos = closeCode.lastIndexOf(')');
    const after = closePos >= 0 ? closeCode.slice(closePos + 1) : '';
    if (!/^\s*(?::[^;{]*)?\{/.test(after)) continue; // 只认「声明/方法实现」的括号组，调用参数组不算
    for (let j = i + 1; j <= closeLine; j++) flags[j] = true;
  }
  return flags;
}

/** 参数注解行（"name: Type,"）的比较形状：只取参数名；带默认值的一律不算类型层。 */
function paramAnnotationName(line: string): string | null {
  const match = /^\s*([A-Za-z_$][\w$]*)\?*\s*:\s*([\s\S]*?),\s*$/.exec(line);
  if (match === null) return null;
  if (topLevelEqualsIndex(match[2]) >= 0) return null;
  return match[1];
}

/** 标记每行是否属于「纯类型构造」：interface 块 / type 别名语句。 */
function analyzeTypeContext(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  let mode = '';
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = stripStringsAndLineComment(lines[i]).trim();
    if (mode === 'interface' || mode === 'typeObject') {
      flags[i] = true;
      depth += braceDelta(lines[i]);
      if (depth <= 0) mode = '';
      continue;
    }
    if (mode === 'typeStatement') {
      flags[i] = true;
      if (/;\s*$/.test(code)) mode = '';
      continue;
    }
    if (/^(export\s+)?interface\s+[A-Za-z_$][\w$]*/.test(code)) {
      flags[i] = true;
      const delta = braceDelta(lines[i]);
      if (delta > 0) { mode = 'interface'; depth = delta; }
      continue;
    }
    if (/^(export\s+)?type\s+[A-Za-z_$][\w$]*\s*=/.test(code)) {
      flags[i] = true;
      const delta = braceDelta(lines[i]);
      if (delta > 0) { mode = 'typeObject'; depth = delta; }
      else if (!/;\s*$/.test(code)) mode = 'typeStatement';
      continue;
    }
  }
  return flags;
}

/* ------------------------------------------------------------------ 行分类辅助 */

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/')) return true;
  return false;
}

function isTypeOnlyLine(line: string, inTypeContext: boolean): boolean {
  if (isBlankOrComment(line)) return true;
  if (inTypeContext) return true;
  const code = stripStringsAndLineComment(line).trim();
  if (/^(export\s+)?interface\s+[A-Za-z_$][\w$]*/.test(code)) return true;
  if (/^(export\s+)?type\s+[A-Za-z_$][\w$]*\s*=/.test(code)) return true;
  return false;
}

function isImportLine(line: string): boolean {
  const code = stripStringsAndLineComment(line).trim();
  if (/^import\b/.test(code)) return true;
  if (/\bfrom\s*["'][^"']*["']/.test(line)) return true;
  return false;
}

function isTypeOnlyImportLine(line: string): boolean {
  const code = stripStringsAndLineComment(line).trim();
  return /^import\s+type\b/.test(code);
}

function normalizeImportSuffixes(line: string): string {
  return line.replace(/(["'])(\.\.?\/[^"']*?)\.ts(["'])/g, '$1$2$3');
}

function stripGeneratedTypeSuffixes(line: string): string {
  return line.replace(/\b([A-Za-z_$][\w$]*?)(?:Options|Patch|Map|Value)\b/g, '$1');
}

function isDeclarationTypeLine(line: string): boolean {
  return (
    /^\s*(?:export\s+)?(?:readonly\s+|static\s+|private\s+|public\s+|protected\s+)*[A-Za-z_$][\w$]*\??\s*:\s*\S/.test(line) ||
    /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*\S/.test(line) ||
    /^\s*[A-Za-z_$][\w$]*\??\s*:\s*\S[^;]*,\s*$/.test(line)
  );
}

function isTypePositionOnlyChange(beforeLine: string, afterLine: string): boolean {
  if (!isDeclarationTypeLine(beforeLine) || !isDeclarationTypeLine(afterLine)) return false;
  return stripGeneratedTypeSuffixes(beforeLine) === stripGeneratedTypeSuffixes(afterLine);
}

function splitTopLevel(text: string, separator: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === String.fromCharCode(96)) {
      const quote = c;
      current += c;
      i++;
      while (i < text.length) {
        current += text[i];
        if (text[i] === '\\') { i++; if (i < text.length) current += text[i]; i++; continue; }
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '(' || c === '{' || c === '[' || c === '<') { depth++; current += c; i++; continue; }
    if (c === ')' || c === '}' || c === ']' || c === '>') { if (depth > 0) depth--; current += c; i++; continue; }
    if (c === separator && depth === 0) { parts.push(current); current = ''; i++; continue; }
    current += c;
    i++;
  }
  if (depth !== 0) return null;
  parts.push(current);
  return parts;
}

function topLevelEqualsIndex(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '=' && depth === 0 && text[i + 1] !== '>') return i;
  }
  return -1;
}

function stripReturnType(rest: string): string {
  const trimmed = rest.trim();
  if (!trimmed.startsWith(':')) return trimmed.replace(/\s+/g, ' ');
  const end = Math.max(trimmed.lastIndexOf('{'), trimmed.lastIndexOf(';'), trimmed.lastIndexOf('=>'));
  if (end < 0) return 'T';
  return trimmed.slice(end).replace(/\s+/g, ' ');
}

function signatureShape(line: string): string | null {
  const open = line.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return null;
  const prefix = line.slice(0, open).trim().replace(/\s+/g, ' ');
  const paramsText = line.slice(open + 1, close);
  const rawParams = splitTopLevel(paramsText, ',');
  if (rawParams === null) return null;
  const params: string[] = [];
  for (const raw of rawParams) {
    const text = raw.trim();
    if (text === '') continue;
    const nameMatch = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(text);
    if (nameMatch === null) return null;
    const afterName = text.slice(nameMatch[0].length);
    const eq = topLevelEqualsIndex(afterName);
    params.push(nameMatch[1] + (eq < 0 ? '' : ' ' + afterName.slice(eq).trim().replace(/\s+/g, ' ')));
  }
  return prefix + '(' + params.join(',') + ')' + stripReturnType(line.slice(close + 1));
}

/** 只改签名里的参数类型/返回类型（参数名、顺序、默认值不变）也属于类型层改动。 */
function isSignatureOnlyChange(beforeLine: string, afterLine: string): boolean {
  const before = signatureShape(beforeLine);
  if (before === null) return false;
  const after = signatureShape(afterLine);
  if (after === null) return false;
  return before === after;
}

function pairIsTypeLevel(beforeLine: string, afterLine: string, beforeIsParam: boolean, afterIsParam: boolean): boolean {
  if (isTypePositionOnlyChange(beforeLine, afterLine)) return true;
  if (isSignatureOnlyChange(beforeLine, afterLine)) return true;
  if (beforeIsParam && afterIsParam) {
    const beforeName = paramAnnotationName(beforeLine);
    const afterName = paramAnnotationName(afterLine);
    if (beforeName !== null && beforeName === afterName) return true;
  }
  return false;
}

/** 整个变更区域都只是「类型标注/类型名」层面的改动（可能有多行，如相邻字段一起改名）。 */
function isTypePositionOnlyRegion(
  region: Region,
  beforeCtx: boolean[],
  afterCtx: boolean[],
  beforeParams: boolean[],
  afterParams: boolean[],
): boolean {
  if (region.removed.length === 0 || region.added.length === 0) return false;
  // 逐行配对比较：每对都必须是「只改类型标注 / 只改签名类型（参数名、顺序、默认值不变）」
  if (region.removed.length !== region.added.length) return false;
  for (let i = 0; i < region.removed.length; i++) {
    const beforeItem = region.removed[i];
    const afterItem = region.added[i];
    if (!pairIsTypeLevel(beforeItem.text, afterItem.text, beforeParams[beforeItem.index], afterParams[afterItem.index])) {
      return false;
    }
  }
  return true;
}

function escapeRegExpText(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

/* ------------------------------------------------------------------ 区域分类 */

interface RegionVerdict {
  kind: string;
  reason: string;
}

function matchTypePattern(removed: string[], added: string[]): string | null {
  const isCtorNamed = (line: string): boolean =>
    /^\s*constructor\(options:\s*[A-Za-z_$][\w$]*Options(\s*=\s*\{\})?\)\s*\{\s*$/.test(line);
  // 构造器内联对象类型（多行）
  if (
    removed.length >= 2 &&
    /^\s*constructor\(options:\s*\{\s*$/.test(removed[0]) &&
    /^\s*\}\)\s*\{\s*$/.test(removed[removed.length - 1]) &&
    added.length === 1 && isCtorNamed(added[0])
  ) return '构造器内联对象类型 → <Class>Options';
  if (
    removed.length >= 2 &&
    /^\s*constructor\(options:\s*\{\s*$/.test(removed[0]) &&
    /^\s*\}\s*=\s*\{\}\)\s*\{\s*$/.test(removed[removed.length - 1]) &&
    added.length === 1 && isCtorNamed(added[0])
  ) return '构造器内联对象类型 → <Class>Options（带默认值）';
  // 构造器内联对象类型（单行）
  if (
    removed.length === 1 &&
    /^\s*constructor\(options:\s*\{[\s\S]*\}\)\s*\{\s*$/.test(removed[0]) &&
    added.length === 1 && isCtorNamed(added[0])
  ) return '构造器内联对象类型 → <Class>Options（单行）';
  // copy(patch: Partial<Self>)
  if (
    removed.length === 1 && added.length === 1 &&
    /^\s*copy\(patch:\s*Partial<[A-Za-z_$][\w$]*>\):\s*[A-Za-z_$][\w$]*\s*\{\s*$/.test(removed[0]) &&
    /^\s*copy\(patch:\s*[A-Za-z_$][\w$]*Patch\):\s*[A-Za-z_$][\w$]*\s*\{\s*$/.test(added[0])
  ) return 'copy(patch: Partial<Self>) → <Class>Patch';
  // export const X = {  ->  export const X: XMap = {
  if (removed.length === 1) {
    const constMatch = /^\s*export const ([A-Za-z_$][\w$]*)\s*=\s*\{\s*$/.exec(removed[0]);
    if (constMatch !== null) {
      const pattern = new RegExp('^\\s*export const ' + escapeRegExpText(constMatch[1]) + ':\\s*[A-Za-z_$][\\w$]*\\s*=\\s*\\{\\s*$');
      for (const line of added) if (pattern.test(line)) return 'const 补显式 XMap 标注';
    }
  }
  // } as const;  ->  };
  if (
    removed.length === 1 && added.length === 1 &&
    /^\s*\}\s+as\s+const;\s*$/.test(removed[0]) &&
    /^\s*\};\s*$/.test(added[0])
  ) return '删除 as const';
  // type X = ...  ->  type XValue = ...
  if (removed.length === 1 && added.length === 1) {
    const single = /^(\s*)(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);\s*$/.exec(removed[0]);
    if (single !== null) {
      const after = new RegExp('^' + escapeRegExpText(single[1]) + '(export\\s+)?type\\s+' + escapeRegExpText(single[3]) + 'Value\\s*=\\s*([\\s\\S]*?);\\s*$').exec(added[0]);
      if (after !== null && after[2].trim() === single[4].trim()) return 'type X → XValue';
    }
    const multi = /^(\s*)(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(removed[0]);
    if (multi !== null) {
      const after = new RegExp('^' + escapeRegExpText(multi[1]) + '(export\\s+)?type\\s+' + escapeRegExpText(multi[3]) + 'Value\\s*=\\s*$').exec(added[0]);
      if (after !== null) return 'type X → XValue（多行联合）';
    }
    const objectAlias = /^(\s*)(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*$/.exec(removed[0]);
    if (objectAlias !== null) {
      const after = new RegExp('^\\s*(export\\s+)?interface\\s+' + escapeRegExpText(objectAlias[3]) + 'Value\\s*\\{\\s*$').exec(added[0]);
      if (after !== null) return '对象类型别名 → interface XValue';
    }
  }
  return null;
}

function regionReason(removed: string[], added: string[]): string {
  const changed = [...removed, ...added].filter((line) => line.trim() !== '');
  if (changed.some((line) => /\breturn\b|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bswitch\b|\bthrow\b/.test(line))) {
    return '控制流/语句改动';
  }
  if (changed.some((line) => /^\s*(?:const|let|var)\b/.test(line))) return '变量/初始化改动';
  if (changed.some((line) => /^\s*(?:this\.|[A-Za-z_$][\w$]*\s*\()/.test(line))) return '表达式/调用改动';
  if (changed.some((line) => /^import\b/.test(line.trim()))) return 'import 变更（可能影响运行时依赖）';
  return '运行时相关改动';
}

function classifyRegion(
  region: Region,
  beforeCtx: boolean[],
  afterCtx: boolean[],
  beforeParams: boolean[],
  afterParams: boolean[],
): RegionVerdict {
  const removed = region.removed.map((item) => item.text);
  const added = region.added.map((item) => item.text);
  const all = [...removed, ...added];

  // 1) import：只有相对说明符 .ts 后缀变化 -> import-path；import type 变更 -> type-only
  if (all.length > 0 && all.every(isImportLine)) {
    const removedNormalized = removed.map(normalizeImportSuffixes).join('\n');
    const addedNormalized = added.map(normalizeImportSuffixes).join('\n');
    if (removedNormalized === addedNormalized) {
      return { kind: KIND_IMPORT_PATH, reason: '仅相对 import 的 .ts 后缀变化' };
    }
    if (removed.every(isTypeOnlyImportLine) && added.every(isTypeOnlyImportLine)) {
      return { kind: KIND_TYPE_ONLY, reason: 'import type 变更（运行时擦除）' };
    }
    return { kind: KIND_NEEDS_REVIEW, reason: 'import 变更（可能影响运行时依赖）' };
  }

  // 2) 已知的类型层变换
  const pattern = matchTypePattern(removed, added);
  if (pattern !== null) return { kind: KIND_TYPE_ONLY, reason: pattern };

  // 3) 全部变更行都是类型层（interface 块内 / type 别名内 / 类型声明 / 注释空行）
  let allTypeOnly = true;
  for (const item of region.removed) {
    if (!isTypeOnlyLine(item.text, beforeCtx[item.index])) { allTypeOnly = false; break; }
  }
  if (allTypeOnly) {
    for (const item of region.added) {
      if (!isTypeOnlyLine(item.text, afterCtx[item.index])) { allTypeOnly = false; break; }
    }
  }
  if (allTypeOnly && all.length > 0) return { kind: KIND_TYPE_ONLY, reason: '类型声明/类型层改动' };

  // 4) 只改类型标注/类型名（可能多行，如相邻字段一起改名）
  if (isTypePositionOnlyRegion(region, beforeCtx, afterCtx, beforeParams, afterParams)) {
    return { kind: KIND_TYPE_ONLY, reason: '显式类型标注/类型名改名' };
  }

  return { kind: KIND_NEEDS_REVIEW, reason: regionReason(removed, added) };
}

/* ------------------------------------------------------------------ 主流程 */

interface Hunk {
  line: number;
  kind: string;
  before: string | null;
  after: string | null;
  reason: string;
}

interface FileEntry {
  path: string;
  status: string;
  hunks: Hunk[];
}

interface Counts {
  typeOnly: number;
  importPath: number;
  needsReview: number;
  cannotPair: number;
}

interface GateResult {
  ok: boolean;
  before: string;
  after: string;
  files: FileEntry[];
  counts: Counts;
  stats: { beforeFiles: number; afterFiles: number; paired: number; changedFiles: number; changedLines: number };
}

function pairKey(rel: string): string {
  return rel.replace(/\.(ts|ets)$/, '');
}

function runGate(options: CliOptions): GateResult {
  const beforeDir = collectDir(options.before, '--before');
  const afterDir = collectDir(options.after, '--after');
  const beforeByKey = new Map<string, SourceFile>();
  const afterByKey = new Map<string, SourceFile>();
  for (const file of beforeDir.files) beforeByKey.set(pairKey(file.rel), file);
  for (const file of afterDir.files) afterByKey.set(pairKey(file.rel), file);

  const ctxCache = new Map<string, boolean[]>();
  const cachedFlags = (cacheKey: string, compute: () => boolean[]): boolean[] => {
    let cached = ctxCache.get(cacheKey);
    if (cached === undefined) {
      cached = compute();
      ctxCache.set(cacheKey, cached);
    }
    return cached;
  };
  const typeContext = (side: string, file: SourceFile): boolean[] =>
    cachedFlags(side + '#type#' + file.rel, () => analyzeTypeContext(file.lines));
  const paramContext = (side: string, file: SourceFile): boolean[] =>
    cachedFlags(side + '#param#' + file.rel, () => analyzeParamContext(file.lines));

  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const files: FileEntry[] = [];
  const counts: Counts = { typeOnly: 0, importPath: 0, needsReview: 0, cannotPair: 0 };
  let paired = 0;
  let changedLines = 0;

  for (const key of keys) {
    const beforeFile = beforeByKey.get(key);
    const afterFile = afterByKey.get(key);
    if (beforeFile === undefined || afterFile === undefined) {
      // 无法配对：新增/删除文件必须人看
      const file = (afterFile === undefined ? beforeFile : afterFile) as SourceFile;
      const status = afterFile === undefined ? 'removed' : 'added';
      files.push({
        path: file.rel,
        status,
        hunks: [{
          line: 1,
          kind: KIND_NEEDS_REVIEW,
          before: status === 'removed' ? file.lines.join('\n') : null,
          after: status === 'added' ? file.lines.join('\n') : null,
          reason: status === 'added' ? '新增文件（无法配对，必须人看）' : '删除文件（无法配对，必须人看）',
        }],
      });
      counts.needsReview++;
      counts.cannotPair++;
      changedLines += Math.max(file.lines.length, 1);
      continue;
    }
    paired++;
    if (beforeFile.lines.join('\n') === afterFile.lines.join('\n')) continue;
    const ops = diffLines(beforeFile.lines, afterFile.lines);
    const regions = buildRegions(ops, beforeFile.lines, afterFile.lines);
    const beforeCtx = typeContext('before', beforeFile);
    const afterCtx = typeContext('after', afterFile);
    const beforeParams = paramContext('before', beforeFile);
    const afterParams = paramContext('after', afterFile);
    const hunks: Hunk[] = [];
    for (const region of regions) {
      if (region.removed.length === 0 && region.added.length === 0) continue;
      const verdict = classifyRegion(region, beforeCtx, afterCtx, beforeParams, afterParams);
      const line = region.added.length > 0 ? region.added[0].index + 1 : region.removed[0].index + 1;
      hunks.push({
        line,
        kind: verdict.kind,
        before: region.removed.length === 0 ? null : region.removed.map((item) => item.text).join('\n'),
        after: region.added.length === 0 ? null : region.added.map((item) => item.text).join('\n'),
        reason: verdict.reason,
      });
      changedLines += region.removed.length + region.added.length;
      if (verdict.kind === KIND_TYPE_ONLY) counts.typeOnly++;
      else if (verdict.kind === KIND_IMPORT_PATH) counts.importPath++;
      else counts.needsReview++;
    }
    if (hunks.length > 0) files.push({ path: afterFile.rel, status: 'modified', hunks });
  }

  return {
    ok: counts.needsReview === 0,
    before: options.before,
    after: options.after,
    files,
    counts,
    stats: {
      beforeFiles: beforeDir.files.length,
      afterFiles: afterDir.files.length,
      paired,
      changedFiles: files.length,
      changedLines,
    },
  };
}

/* ------------------------------------------------------------------ 输出 */

function serializeReport(result: GateResult): Record<string, unknown> {
  return {
    ok: result.ok,
    before: result.before,
    after: result.after,
    files: result.files.map((file) => ({
      path: file.path,
      status: file.status,
      hunks: file.hunks.map((hunk) => ({
        line: hunk.line,
        kind: hunk.kind,
        before: hunk.before,
        after: hunk.after,
      })),
    })),
    counts: {
      typeOnly: result.counts.typeOnly,
      importPath: result.counts.importPath,
      needsReview: result.counts.needsReview,
      cannotPair: result.counts.cannotPair,
    },
  };
}

function truncate(value: string, limit: number): string {
  const oneLine = value.split('\n').join(' / ');
  return oneLine.length <= limit ? oneLine : oneLine.slice(0, limit - 1) + '…';
}

function printHuman(result: GateResult, options: CliOptions): void {
  const lines: string[] = [];
  const s = result.stats;
  const c = result.counts;
  lines.push(
    'diff-gate：before ' + s.beforeFiles + ' 文件 / after ' + s.afterFiles + ' 文件，配对 ' + s.paired +
      ' 对，无法配对 ' + c.cannotPair,
  );
  lines.push(
    '变更：' + s.changedFiles + ' 文件 / ' + s.changedLines + ' 行；分类 hunk：type-only ' + c.typeOnly +
      ' / import-path ' + c.importPath + ' / needs-review ' + c.needsReview,
  );
  if (c.needsReview === 0) {
    lines.push('门禁：PASS（没有 needs-review，适配只动类型层）');
  } else {
    lines.push('needs-review ' + c.needsReview + ' 处（file:line｜原因｜前 → 后）：');
    const entries: Array<{ file: string; hunk: Hunk }> = [];
    for (const file of result.files) {
      for (const hunk of file.hunks) if (hunk.kind === KIND_NEEDS_REVIEW) entries.push({ file: file.path, hunk });
    }
    const limit = Math.min(options.max, HUMAN_MAX_ENTRIES);
    for (const entry of entries.slice(0, limit)) {
      const beforeSnippet = entry.hunk.before === null ? '(空)' : truncate(entry.hunk.before, 44);
      const afterSnippet = entry.hunk.after === null ? '(空)' : truncate(entry.hunk.after, 44);
      lines.push('  ' + entry.file + ':' + entry.hunk.line + '  [' + entry.hunk.reason + ']  - ' + beforeSnippet + '  → + ' + afterSnippet);
    }
    if (entries.length > limit) lines.push('  …（其余 ' + (entries.length - limit) + ' 处见 --json/--report）');
    lines.push('门禁：FAIL（有 needs-review；' + (options.strict ? '--strict 退出码 1' : '退出码 3，告警不阻止构建') + '）');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/* ------------------------------------------------------------------ main */

function main(argv: string[]): number {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(USAGE + '\n');
      return EXIT_OK;
    }
    if (options.before === '') throw new UsageError('缺少 --before');
    if (options.after === '') throw new UsageError('缺少 --after');

    const result = runGate(options);
    if (options.report !== null) {
      const reportPath = resolve(options.report);
      try {
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, JSON.stringify(serializeReport(result), null, 2) + '\n', 'utf8');
      } catch (error) {
        throw new InputError('写 --report 失败：' + options.report + '（' + (error instanceof Error ? error.message : String(error)) + '）');
      }
    }
    if (options.json) process.stdout.write(JSON.stringify(serializeReport(result), null, 2) + '\n');
    else printHuman(result, options);

    if (result.ok) return EXIT_OK;
    return options.strict ? EXIT_ERROR : EXIT_NEEDS_REVIEW;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write('错误：' + error.message + '\n\n' + USAGE + '\n');
      return EXIT_USAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write('diff-gate 失败：' + message + '\n');
    return EXIT_ERROR;
  }
}

process.exitCode = main(process.argv.slice(2));
