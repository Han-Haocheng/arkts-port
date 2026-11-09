#!/usr/bin/env node
/**
 * adapt-arkts —— ArkTS 机械适配 codemod（确定性、幂等）。
 *
 * 把 ArkTS 严格模式的机械适配固化成确定性变换（依据 rules/arkts-restrictions.md）：
 *
 *   1. constructor(options: { ... })                 -> <Class>Options interface
 *      支持单行 / 多行 / "} = {}) {" 默认值；interface 插在类 JSDoc 之前。
 *   2. copy(patch: Partial<Self>)                    -> <Class>Patch interface
 *      字段优先取构造参数，无构造参数的类取 readonly 实例字段；全部可选。
 *   3. 同名 export type X + export const X = {...} as const
 *                                                    -> 类型改名 XValue（+ XMap interface + const 标注 + 删 as const）。
 *      **只改类型位置**：类型标注/联合/交叉/as/extends/implements/类型实参/type·interface 声明/import type。
 *      值位置一律不动（= Tone、{ Tone }、{ Tone: ... }、Tone.A、函数实参、数组元素、return Tone、位运算…）。
 *      跨文件只在 import type { X } 且该文件里全部用法都是类型位置时才改名（同时改 import 说明符）；
 *      值 import / 别名 import / 拿不准 → 不改，报 crossfile-type-ref（residual 必须诚实）。
 *   4. 未配对的 as const                             -> 只报告，不猜类型。
 *
 * 用法：
 *   node cli/adapt-arkts.ts --src <dir> --out <dir> [--ets] [--report <path.json>]
 *                           [--json] [--fail-on-residual]
 *
 *   --src <dir>            输入目录：递归扫描 .ts/.ets（跳过 node_modules 与 .git）
 *   --out <dir>            输出目录：保留相对路径，在副本上变换；src 永不被修改，
 *                          --out 不能等于 --src 也不能位于 --src 内
 *   --ets                  输出扩展名 .ets，并把相对 import 说明符的 ".ts" 后缀去掉
 *                          （ArkTS 工程用）；不加时保持 .ts 与后缀（供 Node 重放）
 *   --report <path.json>   报告写成 JSON 文件
 *   --json                 报告打到 stdout（只有 JSON，便于下游解析）
 *   --fail-on-residual     存在 residual 时退出码 3
 *   --help, -h             打印本帮助
 *
 * 退出码：0 = 成功（有 residual 也是 0）
 *         1 = 变换异常（例如同名的 <Class>Options 已存在：报错而不是覆盖）
 *         2 = 用法错误
 *         3 = --fail-on-residual 且存在 residual
 *
 * 幂等：对 --out 的结果再跑一次不会有任何改动（filesChanged=0、changes=[]）。
 * 确定性：文件按路径排序处理，报告里只有相对路径，不含时间戳；同一输入两次运行逐字节相同。
 * 报告行号：指向 --out 产物里的行（changes 指生成/改动的那一行；residuals 指残留的那一行）。
 *
 * 报告 JSON 形状：
 *   {
 *     "summary": { "filesScanned": n, "filesChanged": n, "options": n, "patches": n,
 *                  "renames": n, "asConst": n, "residuals": n },
 *     "changes":   [ { "file": "a/b.ts", "line": 12, "rule": "constructor-options" } ],
 *     "residuals": [ { "file": "a/b.ts", "line": 8, "code": "inline-object-type",
 *                      "hint": "...", "snippet": "static key(element: { ... })" } ]
 *   }
 *
 * changes.rule:      constructor-options | copy-patch | type-rename | type-ref | map-interface | ets-import
 * residuals.code:    globalThis | as-unknown | any-unknown | indexed-type-access | inline-object-type |
 *                    unsupported-constructor | partial-remaining | as-const-unpaired |
 *                    name-conflict | crossfile-type-ref | map-keys-unsupported | rename-uncertain
 *
 * 不做的事（必须人工 / 后续工具）：改语义、猜类型、改 src、把 UI 层 ArkUI 化。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ 退出码与规则名 */

const EXIT_OK = 0;
const EXIT_TRANSFORM = 1;
const EXIT_USAGE = 2;
const EXIT_RESIDUAL = 3;

const RULE_OPTIONS = 'constructor-options';
const RULE_PATCH = 'copy-patch';
const RULE_TYPE_RENAME = 'type-rename';
const RULE_TYPE_REF = 'type-ref';
const RULE_MAP = 'map-interface';
const RULE_ETS_IMPORT = 'ets-import';

const RESIDUAL_HINTS: Record<string, string> = {
  globalThis: 'ArkTS 禁 globalThis；改成模块级变量 + 宿主注入（参见 cases/legado 的 ReaderPerformanceTimer 修法）',
  'as-unknown': 'ArkTS 禁 unknown（含 as unknown）；换具体类型或具名 interface',
  'any-unknown': 'ArkTS 禁 any/unknown；换具体类型',
  'indexed-type-access': 'ArkTS 禁按索引取类型 X["k"]；显式声明联合类型或 interface',
  'inline-object-type': 'ArkTS 要求对象字面量对应显式声明的 class/interface；把内联对象类型抽成具名 interface',
  'unsupported-constructor': '构造器内联对象类型形状不支持自动抽取（嵌套对象/注释/非常规成员）；人工抽成 interface',
  'partial-remaining': '剩余 Partial<T>：类内 copy(patch: Partial<Self>) 已自动改成 <Class>Patch；类外/非 Self 的 Partial 需人工换成显式 interface',
  'as-const-unpaired': 'ArkTS 禁 as const；没有同名 type 的对象常量需人工决定字面量类型',
  'name-conflict': '生成的 XValue/XMap 与既有声明重名；这一对没有改，人工改名后再跑',
  'crossfile-type-ref': '跨文件引用不是 import type 或含值位置用法；这一对没有改（避免改坏），人工处理',
  'rename-uncertain': '文件内有无法判定是类型还是值的用法；这一对没有改（避免把值位置改坏），人工处理',
  'map-keys-unsupported': '对象常量的键不是简单标识符/字符串（或含展开）；无法生成 XMap，人工处理',
};

const USAGE = [
  'adapt-arkts —— ArkTS 机械适配 codemod（确定性、幂等）',
  '',
  '用法：',
  '  node cli/adapt-arkts.ts --src <dir> --out <dir> [--ets] [--report <path.json>]',
  '                          [--json] [--fail-on-residual]',
  '',
  '参数：',
  '  --src <dir>            输入目录（递归扫描 .ts/.ets；跳过 node_modules 与 .git）',
  '  --out <dir>            输出目录（保留相对路径；src 永不被修改；不能等于或在 src 内）',
  '  --ets                  输出 .ets，且相对 import 说明符去掉 .ts 后缀',
  '  --report <path.json>   把报告写成 JSON 文件',
  '  --json                 把报告打到 stdout（只有 JSON）',
  '  --fail-on-residual     存在 residual 时退出码 3',
  '  --help, -h             打印本帮助',
  '',
  '变换（4 类，见 rules/arkts-restrictions.md）：',
  '  1) constructor(options: { ... })  -> <Class>Options interface（单行/多行/默认值）',
  '  2) copy(patch: Partial<Self>)     -> <Class>Patch interface（全部字段可选）',
  '  3) export type X + export const X = {...} as const -> 类型改名 XValue + XMap + 删 as const',
  '     （只改类型位置；值位置不动。跨文件只认 import type 且全部用法都是类型位置）',
  '  4) 未配对的 as const -> 只报告',
  '',
  '退出码：0 成功（有 residual 也是 0）；1 变换异常；2 用法错误；3 --fail-on-residual 且有 residual。',
  '',
  '示例：',
  '  node cli/adapt-arkts.ts --src .refs/arkts-adapt-baseline --out out/ts --report out/report.json --json',
  '  node cli/adapt-arkts.ts --src out/ts --out out/ets --ets',
].join('\n');

/* ------------------------------------------------------------------ 错误类型 */

class UsageError extends Error {}
class TransformError extends Error {}

/* ------------------------------------------------------------------ 基础文本工具 */

interface Edit {
  start: number;
  end: number;
  text: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function lineStartAt(text: string, index: number): number {
  let i = index;
  while (i > 0 && text[i - 1] !== '\n') i--;
  return i;
}

function lineEndAt(text: string, index: number): number {
  let i = index;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  const limit = Math.min(index, text.length);
  for (let i = 0; i < limit; i++) if (text[i] === '\n') line++;
  return line;
}

function lineTextAt(text: string, index: number): string {
  return text.slice(lineStartAt(text, index), lineEndAt(text, index));
}

function nextLineStart(text: string, lineStart: number): number {
  const end = lineEndAt(text, lineStart);
  return end >= text.length ? text.length : end + 1;
}

function prevLineStart(text: string, lineStart: number): number | null {
  if (lineStart <= 0) return null;
  let i = lineStart - 1;
  if (text[i] !== '\n') return null;
  let j = i - 1;
  while (j >= 0 && text[j] !== '\n') j--;
  return j + 1;
}

function prevNonSpaceIndex(text: string, index: number): number {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i--;
  return i;
}

function nextNonSpaceIndex(text: string, index: number): number {
  let i = index;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  return i;
}

function previousWord(text: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  let end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(text[i])) i--;
  return text.slice(i + 1, end);
}

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = edits.slice().sort((a, b) => (b.start - a.start) || (b.end - a.end));
  let out = text;
  let boundary = text.length + 1;
  for (const edit of sorted) {
    if (edit.end > boundary) {
      throw new TransformError('内部错误：编辑区间重叠 [' + edit.start + ',' + edit.end + ')');
    }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    boundary = edit.start;
  }
  return out;
}

/* ------------------------------------------------------------------ 代码遮罩（字符串/注释/正则/模板字面量都不参与变换） */

const REGEX_PREV_CHARS = '=(,[:!&|?{;+-*%<>~^';

function isRegexLiteralStart(text: string, index: number): boolean {
  let j = index - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j--;
  if (j < 0) return true;
  const prev = text[j];
  if (REGEX_PREV_CHARS.indexOf(prev) >= 0) return true;
  if (/[A-Za-z_$]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--;
    const word = text.slice(k + 1, j + 1);
    return ['return', 'case', 'typeof', 'delete', 'void', 'new', 'in', 'of', 'throw'].indexOf(word) >= 0;
  }
  return false;
}

function buildCodeMask(text: string): Uint8Array {
  const size = text.length;
  const mask = new Uint8Array(size);
  const BACKTICK = String.fromCharCode(96);
  let i = 0;
  while (i < size) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < size && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < size && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < size) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        if (text[i] === '\n') break;
        i++;
      }
      continue;
    }
    if (c === BACKTICK) {
      i++;
      while (i < size) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === BACKTICK) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && isRegexLiteralStart(text, i)) {
      i++;
      let inClass = false;
      while (i < size) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) { i++; break; }
        else if (text[i] === '\n') break;
        i++;
      }
      while (i < size && /[A-Za-z]/.test(text[i])) i++;
      continue;
    }
    mask[i] = 1;
    i++;
  }
  return mask;
}

function forEachCodeMatch(text: string, mask: Uint8Array, pattern: RegExp, visit: (match: RegExpExecArray) => void): void {
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (mask[match.index] === 1) visit(match);
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
    match = pattern.exec(text);
  }
}

function findMatch(text: string, mask: Uint8Array, openIndex: number): number {
  const open = text[openIndex];
  const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : '';
  if (close === '') throw new TransformError('内部错误：不支持的括号 ' + open);
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (mask[i] !== 1) continue;
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new TransformError('括号不配对 ["' + open + '" @' + openIndex + ']');
}

/* ------------------------------------------------------------------ 结构与语法扫描 */

interface ClassInfo {
  name: string;
  exported: boolean;
  declLineStart: number;
  openBrace: number;
  closeBrace: number;
}

function findClasses(text: string, mask: Uint8Array): ClassInfo[] {
  const list: ClassInfo[] = [];
  const pattern = /\bclass[ \t]+([A-Za-z_$][\w$]*)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const keywordIndex = match.index;
    if (mask[keywordIndex] === 1) {
      const declLineStart = lineStartAt(text, keywordIndex);
      const prefix = text.slice(declLineStart, keywordIndex);
      if (/^[ \t]*(?:export[ \t]+)?(?:abstract[ \t]+)?$/.test(prefix)) {
        let cursor = keywordIndex + match[0].length;
        const stop = Math.min(text.length, cursor + 400);
        let openBrace = -1;
        while (cursor < stop) {
          if (mask[cursor] === 1 && text[cursor] === '{') { openBrace = cursor; break; }
          if (mask[cursor] === 1 && text[cursor] === ';') break;
          cursor++;
        }
        if (openBrace >= 0) {
          list.push({
            name: match[1],
            exported: /^[ \t]*export[ \t]+/.test(prefix),
            declLineStart,
            openBrace,
            closeBrace: findMatch(text, mask, openBrace),
          });
        }
      }
    }
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
    match = pattern.exec(text);
  }
  return list;
}

function classAnchorIndex(text: string, declLineStart: number): number {
  // 向上跳过空行：命中的第一行如果是块注释（JSDoc），插到注释之前；
  // 否则插在类声明行之前（保留类上方的空行在插入块之前）。
  let line = prevLineStart(text, declLineStart);
  while (line !== null) {
    const raw = text.slice(line, lineEndAt(text, line)).trim();
    if (raw === '') {
      line = prevLineStart(text, line);
      continue;
    }
    if (!raw.endsWith('*/')) return declLineStart;
    let blockStart = line;
    let probe = line;
    for (;;) {
      if (text.slice(probe, lineEndAt(text, probe)).indexOf('/*') >= 0) { blockStart = probe; break; }
      const previous = prevLineStart(text, probe);
      if (previous === null) break;
      probe = previous;
    }
    return blockStart;
  }
  return declLineStart;
}

interface TypeAliasInfo {
  name: string;
  exported: boolean;
  nameIndex: number;
  stmtStart: number;
  stmtEnd: number;
  bodyStart: number;
  bodyEnd: number;
  isObjectLiteral: boolean;
  objectOpen: number;
  objectClose: number;
}

function findTypeAliases(text: string, mask: Uint8Array): TypeAliasInfo[] {
  const list: TypeAliasInfo[] = [];
  const pattern = /\btype[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (mask[match.index] === 1) {
      const stmtStart = lineStartAt(text, match.index);
      const prefix = text.slice(stmtStart, match.index);
      if (/^[ \t]*(?:export[ \t]+)?$/.test(prefix)) {
        const eqIndex = match.index + match[0].length - 1;
        const stmtEnd = findStatementEnd(text, mask, eqIndex + 1);
        if (stmtEnd > 0) {
          const bodyStart = nextNonSpaceIndex(text, eqIndex + 1);
          const bodyEnd = stmtEnd;
          const isObjectLiteral = text[bodyStart] === '{';
          let objectClose = -1;
          if (isObjectLiteral) {
            objectClose = findMatch(text, mask, bodyStart);
            if (text.slice(objectClose + 1, bodyEnd).trim() !== '') objectClose = -1;
          }
          list.push({
            name: match[1],
            exported: /^[ \t]*export[ \t]+/.test(prefix),
            nameIndex: match.index + match[0].indexOf(match[1]),
            stmtStart,
            stmtEnd,
            bodyStart,
            bodyEnd,
            isObjectLiteral: isObjectLiteral && objectClose >= 0,
            objectOpen: isObjectLiteral && objectClose >= 0 ? bodyStart : -1,
            objectClose,
          });
        }
      }
    }
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
    match = pattern.exec(text);
  }
  return list;
}

function findStatementEnd(text: string, mask: Uint8Array, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (mask[i] !== 1) continue;
    const ch = text[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === ';' && depth === 0) {
      return i;
    }
  }
  return -1;
}

interface ConstDeclInfo {
  name: string;
  exported: boolean;
  constIndex: number;
  nameIndex: number;
  eqIndex: number;
  stmtEnd: number;
}

function findConstDecls(text: string, mask: Uint8Array): ConstDeclInfo[] {
  const list: ConstDeclInfo[] = [];
  const pattern = /\bconst[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (mask[match.index] === 1) {
      const prefix = text.slice(lineStartAt(text, match.index), match.index);
      const prefixMatch = /^[ \t]*(?:(export)[ \t]+)?$/.exec(prefix);
      if (prefixMatch !== null) {
        const eqIndex = match.index + match[0].length - 1;
        const stmtEnd = findStatementEnd(text, mask, eqIndex + 1);
        if (stmtEnd > 0) {
          list.push({
            name: match[1],
            exported: prefixMatch[1] !== undefined,
            constIndex: match.index,
            nameIndex: match.index + match[0].indexOf(match[1]),
            eqIndex,
            stmtEnd,
          });
        }
      }
    }
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
    match = pattern.exec(text);
  }
  return list;
}

interface Span {
  start: number;
  end: number;
}

function findAsConstSpans(text: string, mask: Uint8Array): Span[] {
  const spans: Span[] = [];
  forEachCodeMatch(text, mask, /\bas[ \t]+const\b/g, (match) => {
    spans.push({ start: match.index, end: match.index + match[0].length });
  });
  return spans;
}

function findObjectLiteral(text: string, mask: Uint8Array, from: number, to: number): Span | null {
  const open = nextNonSpaceIndex(text, from);
  if (open >= to || text[open] !== '{') return null;
  const close = findMatch(text, mask, open);
  if (text.slice(close + 1, to).trim() !== '') return null;
  return { start: open, end: close };
}

/* ------------------------------------------------------------------ 对象字面量的顶层键 */

function skipStringLike(text: string, index: number): number {
  const quote = text[index];
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

function skipCommentsAndSpace(text: string, index: number): number {
  let i = index;
  while (i < text.length) {
    if (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r') { i++; continue; }
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    return i;
  }
  return i;
}

function skipValueExpression(text: string, index: number): number {
  let i = index;
  let depth = 0;
  const BACKTICK = String.fromCharCode(96);
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") { i = skipStringLike(text, i); continue; }
    if (c === BACKTICK) {
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === BACKTICK) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ')' || c === ']') {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (c === ',' && depth === 0) return i;
    i++;
  }
  return i;
}

function extractTopLevelKeys(body: string): string[] | null {
  const keys: string[] = [];
  let i = 0;
  while (i < body.length) {
    i = skipCommentsAndSpace(body, i);
    if (i >= body.length) break;
    if (body[i] === ',') { i++; continue; }
    if (body.slice(i, i + 3) === '...') return null;
    if (body[i] === '[') return null;
    let key = '';
    const identifier = /^[A-Za-z_$][\w$]*/.exec(body.slice(i));
    if (identifier !== null) {
      key = identifier[0];
      i += identifier[0].length;
    } else if (body[i] === '"' || body[i] === "'") {
      const end = skipStringLike(body, i);
      key = body.slice(i + 1, end - 1);
      i = end;
    } else {
      return null;
    }
    const colon = skipCommentsAndSpace(body, i);
    if (body[colon] !== ':') return null;
    keys.push(key);
    i = skipValueExpression(body, colon + 1);
  }
  return keys.length > 0 ? keys : null;
}

/* ------------------------------------------------------------------ 成员解析 */

function parseConstructorOptionsBody(body: string): string[] | null {
  if (body.indexOf('{') >= 0 || body.indexOf('}') >= 0) return null;
  if (body.indexOf('//') >= 0 || body.indexOf('/*') >= 0) return null;
  const members: string[] = [];
  for (const raw of body.split(';')) {
    const member = raw.trim();
    if (member === '') continue;
    if (member.indexOf('=') >= 0) return null;
    if (!/^(?:readonly[ \t]+)?[A-Za-z_$][\w$]*[ \t]*\??[ \t]*:[ \t]*\S[\s\S]*$/.test(member)) return null;
    members.push(member);
  }
  return members.length > 0 ? members : null;
}

function makeOptionalMember(member: string): string {
  const match = /^(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\??[ \t]*:[ \t]*([\s\S]+)$/.exec(member);
  if (match === null) throw new TransformError('成员形状不支持：' + member);
  return match[1] + '?: ' + match[2].trim();
}

function readonlyFieldMembers(text: string, cls: ClassInfo): string[] | null {
  const members: string[] = [];
  let cursor = nextLineStart(text, cls.declLineStart);
  while (cursor < cls.closeBrace) {
    const end = lineEndAt(text, cursor);
    const raw = text.slice(cursor, end);
    const trimmed = raw.trim();
    cursor = end >= text.length ? text.length : end + 1;
    if (trimmed === '') continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (/^static[ \t]/.test(trimmed) || /^@/.test(trimmed)) continue;
    const field = /^(?:private[ \t]+)?readonly[ \t]+([A-Za-z_$][\w$]*)[ \t]*:[ \t]*([\s\S]+);$/.exec(trimmed);
    if (field !== null) {
      if (field[2].indexOf('=') >= 0) return null;
      members.push(field[1] + ': ' + field[2].trim());
      continue;
    }
    // readonly 开头但形状不认识（带初始化器等）：保守放弃
    if (/^(?:private[ \t]+)?readonly[ \t]+/.test(trimmed)) return null;
    break;
  }
  return members.length > 0 ? members : null;
}

function looksLikeTypeBody(body: string): boolean {
  if (body.trim() === '') return false;
  const members: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ';' && depth === 0) {
      members.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (depth !== 0) return false;
  members.push(current);
  let count = 0;
  for (const member of members) {
    const trimmed = member.trim();
    if (trimmed === '') continue;
    if (!/^(?:readonly[ \t]+)?[A-Za-z_$][\w$]*[ \t]*\??[ \t]*:[ \t]*[\s\S]+$/.test(trimmed)) return false;
    count++;
  }
  return count > 0;
}

/* ------------------------------------------------------------------ import 解析 */

interface ImportBinding {
  localName: string;
  importedName: string;
  typeOnly: boolean;
}

interface ImportInfo {
  spec: string;
  specIndex: number;
  kind: string;
  typeOnly: boolean;
  bindings: ImportBinding[];
  listOpen: number;
  listClose: number;
  stmtStart: number;
  stmtEnd: number;
}

function findImports(text: string, mask: Uint8Array): ImportInfo[] {
  const list: ImportInfo[] = [];
  const pattern = /\bimport([ \t\n]+)(type)?([ \t\n]*)([\s\S]{0,400}?)[ \t\n]+from[ \t\n]*(["'])([^"']+)\5/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (mask[match.index] === 1) {
      const clauseOffset = match.index + 6 + match[1].length + (match[2] !== undefined ? match[2].length : 0) + match[3].length;
      const clause = match[4];
      const specIndex = match.index + match[0].lastIndexOf(match[5]);
      const info: ImportInfo = {
        spec: match[6],
        specIndex,
        kind: 'named',
        typeOnly: match[2] !== undefined,
        bindings: [],
        listOpen: -1,
        listClose: -1,
        stmtStart: match.index,
        stmtEnd: match.index + match[0].length,
      };
      if (/^\*[ \t]*as[ \t]+/.test(clause)) {
        info.kind = 'namespace';
      } else {
        const braceOffset = clause.indexOf('{');
        if (braceOffset >= 0) {
          const listOpen = clauseOffset + braceOffset;
          const listClose = findMatch(text, mask, listOpen);
          info.listOpen = listOpen;
          info.listClose = listClose;
          for (const part of text.slice(listOpen + 1, listClose).split(',')) {
            const item = part.trim();
            if (item === '') continue;
            const asMatch = /^(type[ \t]+)?([A-Za-z_$][\w$]*)[ \t]+as[ \t]+([A-Za-z_$][\w$]*)$/.exec(item);
            if (asMatch !== null) {
              info.bindings.push({ importedName: asMatch[2], localName: asMatch[3], typeOnly: asMatch[1] !== undefined });
              continue;
            }
            const plainMatch = /^(type[ \t]+)?([A-Za-z_$][\w$]*)$/.exec(item);
            if (plainMatch !== null) {
              info.bindings.push({ importedName: plainMatch[2], localName: plainMatch[2], typeOnly: plainMatch[1] !== undefined });
            }
          }
        } else {
          info.kind = 'default';
          const defaultMatch = /^([A-Za-z_$][\w$]*)/.exec(clause.trim());
          if (defaultMatch !== null) info.bindings.push({ importedName: 'default', localName: defaultMatch[1], typeOnly: false });
        }
      }
      list.push(info);
    } else {
      // 匹配起点在注释/字符串里：从下一个字符重试，别把后面真正的 import 一起跳过
      pattern.lastIndex = match.index + 1;
    }
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
    match = pattern.exec(text);
  }
  return list;
}

function normalizePosixPath(path: string): string {
  const parts = path.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function posixDirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '.' : path.slice(0, index);
}

function resolveSpecifier(fromRel: string, spec: string, known: Map<string, FileState>): string | null {
  if (spec.charAt(0) !== '.') return null;
  const base = normalizePosixPath(posixDirname(fromRel) + '/' + spec);
  const candidates = [base];
  if (!/\.(ts|ets)$/.test(base)) candidates.push(base + '.ts', base + '.ets');
  for (const candidate of candidates) if (known.has(candidate)) return candidate;
  return null;
}

/* ------------------------------------------------------------------ 标识符角色 */

const CTX_TOP = 0;
const CTX_PAREN = 1;
const CTX_BRACKET = 2;
const CTX_BLOCK = 3;
const CTX_VALUE_OBJECT = 4;
const CTX_TYPE_OBJECT = 5;

const VALUE_PREV_CHARS = '=([,?<>!+-*%&|^~/';
const VALUE_PREV_WORDS = ['return', 'case', 'default', 'in', 'of', 'new', 'await', 'yield', 'throw'];

interface CodeAnalysis {
  mask: Uint8Array;
  contexts: Uint8Array;
  typeRanges: Uint8Array;
  imports: ImportInfo[];
}

/** 每个字符所处的括号上下文：值对象字面量 / 类型对象 / 代码块 / 圆括号 / 方括号。 */
function analyzeCodeContexts(text: string, mask: Uint8Array): Uint8Array {
  const contexts = new Uint8Array(text.length);
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (mask[i] !== 1) continue;
    const c = text[i];
    contexts[i] = stack.length > 0 ? stack[stack.length - 1] : CTX_TOP;
    if (c === '(') { stack.push(CTX_PAREN); continue; }
    if (c === '[') { stack.push(CTX_BRACKET); continue; }
    if (c === ')') { if (stack.length > 0 && stack[stack.length - 1] === CTX_PAREN) stack.pop(); continue; }
    if (c === ']') { if (stack.length > 0 && stack[stack.length - 1] === CTX_BRACKET) stack.pop(); continue; }
    if (c === '}') {
      const top = stack.length > 0 ? stack[stack.length - 1] : -1;
      if (top === CTX_VALUE_OBJECT || top === CTX_BLOCK || top === CTX_TYPE_OBJECT) stack.pop();
      continue;
    }
    if (c !== '{') continue;
    const prev = prevNonSpaceIndex(text, i);
    const prevChar = prev >= 0 ? text[prev] : '';
    const prevWord = previousWord(text, i);
    const top = stack.length > 0 ? stack[stack.length - 1] : CTX_TOP;
    let kind = CTX_BLOCK;
    if (prevWord === 'as') kind = CTX_TYPE_OBJECT;
    else if (prevChar === ':') kind = (top === CTX_VALUE_OBJECT || top === CTX_BRACKET) ? CTX_VALUE_OBJECT : CTX_TYPE_OBJECT;
    else if (prev >= 0 && '=([,?'.indexOf(prevChar) >= 0) kind = CTX_VALUE_OBJECT;
    else if (VALUE_PREV_WORDS.indexOf(prevWord) >= 0) kind = CTX_VALUE_OBJECT;
    stack.push(kind);
  }
  return contexts;
}

/** 标记 interface 声明与 type 别名语句覆盖的字符区间（这些区间里都是类型位置）。 */
function analyzeTypeRanges(text: string, mask: Uint8Array): Uint8Array {
  const ranges = new Uint8Array(text.length);
  const mark = (from: number, to: number): void => {
    const start = Math.max(0, from);
    const end = Math.min(text.length, to);
    for (let i = start; i < end; i++) ranges[i] = 1;
  };
  for (const alias of findTypeAliases(text, mask)) mark(alias.stmtStart, alias.stmtEnd + 1);
  const pattern = /\binterface[ \t]+[A-Za-z_$][\w$]*/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (mask[match.index] === 1) {
      const prefix = text.slice(lineStartAt(text, match.index), match.index);
      if (/^[ \t]*(?:export[ \t]+)?$/.test(prefix)) {
        let open = -1;
        for (let i = match.index + match[0].length; i < text.length; i++) {
          if (mask[i] !== 1) continue;
          if (text[i] === '{') { open = i; break; }
          if (text[i] === ';') break;
        }
        if (open >= 0) {
          const close = findMatch(text, mask, open);
          mark(match.index, close + 1);
          pattern.lastIndex = close + 1;
          match = pattern.exec(text);
          continue;
        }
      }
    }
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
    match = pattern.exec(text);
  }
  return ranges;
}

function analyzeFileText(text: string, mask: Uint8Array): CodeAnalysis {
  return {
    mask,
    contexts: analyzeCodeContexts(text, mask),
    typeRanges: analyzeTypeRanges(text, mask),
    imports: findImports(text, mask),
  };
}

function findEnclosingImport(analysis: CodeAnalysis, index: number): ImportInfo | null {
  for (const info of analysis.imports) {
    if (index >= info.stmtStart && index < info.stmtEnd) return info;
  }
  return null;
}

/** 同一行内、在 index 之前是否有顶层的赋值 '='（用来区分赋值表达式与类型联合）。 */
function hasAssignmentBefore(text: string, index: number): boolean {
  const lineStart = lineStartAt(text, index);
  let depth = 0;
  for (let i = index - 1; i >= lineStart; i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { if (depth > 0) depth--; else break; }
    else if (c === ';' && depth === 0) break;
    else if (c === '=' && depth === 0 && text[i + 1] !== '>' && text[i + 1] !== '=' && text[i - 1] !== '=') return true;
  }
  return false;
}

/** 同一行内、在 index 之前是否有类型标注 ':'（排除 ?: 与三元）。 */
function hasTypeAnnotationColonBefore(text: string, index: number): boolean {
  const lineStart = lineStartAt(text, index);
  let depth = 0;
  for (let i = index - 1; i >= lineStart; i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { if (depth > 0) depth--; else break; }
    else if (c === ':' && depth === 0) {
      if (text[i - 1] === '?') return false;
      return !isTernaryColon(text, i);
    } else if (c === ';' && depth === 0) break;
  }
  return false;
}

function isTernaryColon(text: string, colonIndex: number): boolean {
  if (text[colonIndex - 1] === '?') return false;
  const lineStart = lineStartAt(text, colonIndex);
  let depth = 0;
  let question = -1;
  for (let i = colonIndex - 1; i >= lineStart; i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { if (depth > 0) depth--; else break; }
    else if (c === ';' && depth === 0) break;
    else if (c === '?' && depth === 0) { question = i; break; }
  }
  if (question < 0) return false;
  for (let i = question - 1; i >= lineStart; i--) {
    const c = text[i];
    if (c === '=' && text[i + 1] !== '>' && text[i + 1] !== '=' && text[i - 1] !== '=') return true;
  }
  return false;
}

/** 标识符是否在类型实参列表里（Array<Tone> / Map<string, Tone>），要求配对的 '>' 后面是类型上下文。 */
function isInsideTypeArguments(text: string, mask: Uint8Array, index: number): boolean {
  let depth = 0;
  let open = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (mask[i] !== 1) continue;
    const c = text[i];
    if (c === '>') depth++;
    else if (c === '<') { if (depth === 0) { open = i; break; } depth--; }
    else if (c === ';' || c === '{' || c === '}' || c === '=') return false;
  }
  if (open < 0) return false;
  let before = open - 1;
  while (before >= 0 && (text[before] === ' ' || text[before] === '\t' || text[before] === '\n')) before--;
  if (before < 0 || !/[A-Za-z0-9_$)\]]/.test(text[before])) return false;
  depth = 0;
  let close = -1;
  for (let i = index; i < text.length; i++) {
    if (mask[i] !== 1) continue;
    const c = text[i];
    if (c === '<') depth++;
    else if (c === '>') { if (depth === 0) { close = i; break; } depth--; }
    else if (c === ';' || c === '{' || c === '}') return false;
  }
  if (close < 0) return false;
  const after = nextNonSpaceIndex(text, close + 1);
  if (after >= text.length) return true;
  return '(.;,)]}>='.indexOf(text[after]) >= 0;
}

function inHeritageClause(text: string, index: number): boolean {
  const lineStart = lineStartAt(text, index);
  const head = text.slice(lineStart, index);
  return /\b(?:implements|extends)\b[^;{}]*$/.test(head);
}

/**
 * 只认「类型位置」：类型标注/联合/交叉/as/extends/implements/keyof/类型实参/interface 与 type 声明/import type。
 * 值位置（= Tone、{ Tone }、{ Tone: ... }、Tone.A、函数实参、数组元素、return Tone、位运算等）一律不动。
 * 拿不准 → 'uncertain'（调用方据此跳过该对并报告，而不是猜）。
 */
function classifyOccurrenceRole(text: string, analysis: CodeAnalysis, index: number, name: string): string {
  const mask = analysis.mask;
  const next = nextNonSpaceIndex(text, index + name.length);
  const nextChar = next < text.length ? text[next] : '';
  if (nextChar === '.') return 'value';
  const prevWord = previousWord(text, index);
  if (prevWord === 'typeof') return 'value';
  const prev = prevNonSpaceIndex(text, index);
  const prevChar = prev >= 0 ? text[prev] : '';
  if (prevChar === '.') return 'member';

  const importInfo = findEnclosingImport(analysis, index);
  if (importInfo !== null) {
    for (const binding of importInfo.bindings) {
      if (binding.localName !== name) continue;
      if (importInfo.typeOnly || binding.typeOnly) return 'import-type';
      return 'import-value';
    }
    return 'value';
  }

  // 对象字面量里的裸标识符是值；后跟 ':' 的是属性键（不是类型引用）
  if (analysis.contexts[index] === CTX_VALUE_OBJECT) return 'value';
  if (nextChar === ':') return 'value';

  if (['const', 'let', 'var', 'function', 'class', 'type', 'interface', 'enum'].indexOf(prevWord) >= 0) return 'declaration';

  if (analysis.typeRanges[index] === 1) return 'type';
  if (prevChar === ':') return isTernaryColon(text, prev) ? 'value' : 'type';
  if (prevChar === '|' || prevChar === '&') return hasTypeAnnotationColonBefore(text, index) ? 'type' : 'value';
  if (['as', 'extends', 'implements', 'keyof', 'satisfies'].indexOf(prevWord) >= 0) return 'type';
  if (inHeritageClause(text, index)) return 'type';
  if (isInsideTypeArguments(text, mask, index)) return 'type';
  if (prevChar === '>' && prev >= 1 && text[prev - 1] === '=' && hasTypeAnnotationColonBefore(text, index)) return 'type';

  if (prev >= 0 && VALUE_PREV_CHARS.indexOf(prevChar) >= 0) return 'value';
  if (VALUE_PREV_WORDS.indexOf(prevWord) >= 0) return 'value';
  if (prevChar === ';' || prevChar === '{' || prevChar === '}' || prev < 0) return 'value';
  return 'uncertain';
}

function collectIdentifierOccurrences(text: string, mask: Uint8Array, name: string): number[] {
  const found: number[] = [];
  const pattern = new RegExp('\\b' + escapeRegExp(name) + '\\b', 'g');
  let match = pattern.exec(text);
  while (match !== null) {
    if (mask[match.index] === 1) found.push(match.index);
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
    match = pattern.exec(text);
  }
  return found;
}

interface RoleScan {
  renames: Edit[];
  uncertain: Array<{ index: number; role: string }>;
}

function scanIdentifierRoles(
  text: string,
  mask: Uint8Array,
  name: string,
  newName: string,
  exclusions: Array<[number, number]>,
  analysis: CodeAnalysis,
): RoleScan {
  const scan: RoleScan = { renames: [], uncertain: [] };
  for (const index of collectIdentifierOccurrences(text, mask, name)) {
    let excluded = false;
    for (const range of exclusions) {
      if (index >= range[0] && index < range[1]) { excluded = true; break; }
    }
    if (excluded) continue;
    const role = classifyOccurrenceRole(text, analysis, index, name);
    if (role === 'type') scan.renames.push({ start: index, end: index + name.length, text: newName });
    else if (role === 'uncertain' || role === 'declaration') scan.uncertain.push({ index, role });
  }
  return scan;
}

function hasDeclarationNamed(text: string, mask: Uint8Array, name: string): boolean {
  const pattern = new RegExp('\\b(?:const|let|var|function|class|type|interface|enum)[ \\t]+' + escapeRegExp(name) + '\\b', 'g');
  let found = false;
  forEachCodeMatch(text, mask, pattern, () => { found = true; });
  return found;
}

function hasReExportNamed(text: string, mask: Uint8Array, name: string): boolean {
  let found = false;
  const pattern = new RegExp('\\bexport[ \\t]*\\{[^}]*\\b' + escapeRegExp(name) + '\\b', 'g');
  forEachCodeMatch(text, mask, pattern, () => { found = true; });
  return found;
}

/* ------------------------------------------------------------------ 文件状态 */

interface ChangeRecord {
  rule: string;
  marker?: string;
  markerAlt?: string;
  line?: number;
}

interface PendingResidual {
  code: string;
  marker: string;
  occurrence: number;
  detail?: string;
}

interface FileState {
  rel: string;
  text: string;
  originalText: string;
  mask: Uint8Array;
  changes: ChangeRecord[];
  residuals: Array<{ line: number; code: string; snippet: string }>;
  pendingResiduals: PendingResidual[];
  claimedAsConst: Set<string>;
  stats: { options: number; patches: number; renames: number; asConst: number };
}

function makeFileState(rel: string, text: string): FileState {
  return {
    rel,
    text,
    originalText: text,
    mask: buildCodeMask(text),
    changes: [],
    residuals: [],
    pendingResiduals: [],
    claimedAsConst: new Set<string>(),
    stats: { options: 0, patches: 0, renames: 0, asConst: 0 },
  };
}

function refreshMask(file: FileState): void {
  file.mask = buildCodeMask(file.text);
}

/* ------------------------------------------------------------------ 规则 1/2：类内 Options / Patch */

interface ClassEditPlan {
  optionsFields: string[] | null;
  patchFields: string[] | null;
  constructorEdit: Edit | null;
  copyEdit: Edit | null;
}

function buildInterfaceBlock(name: string, comment: string, members: string[], optional: boolean): string[] {
  const lines: string[] = [];
  lines.push('/** ' + comment + ' */');
  lines.push('export interface ' + name + ' {');
  for (const member of members) {
    lines.push('  ' + (optional ? makeOptionalMember(member) : member) + ';');
  }
  lines.push('}');
  return lines;
}

function transformClassRules(file: FileState): void {
  refreshMask(file);
  const text = file.text;
  const mask = file.mask;
  const classes = findClasses(text, mask);
  if (classes.length === 0) return;
  const edits: Edit[] = [];
  const insertions = new Map<number, string[]>();

  for (const cls of classes) {
    const plan = planClass(cls, text, mask);
    if (plan === null) continue;

    const blocks: string[] = [];
    if (plan.optionsFields !== null) {
      blocks.push(...buildInterfaceBlock(cls.name + 'Options', cls.name + ' 的构造参数。', plan.optionsFields, false));
      blocks.push('');
      file.stats.options++;
      file.changes.push({ rule: RULE_OPTIONS, marker: 'export interface ' + cls.name + 'Options' });
    }
    if (plan.patchFields !== null) {
      blocks.push(...buildInterfaceBlock(
        cls.name + 'Patch',
        cls.name + ' 的 copy 补丁（语义等同 Partial<' + cls.name + '>，全部字段可选）。',
        plan.patchFields,
        true,
      ));
      blocks.push('');
      file.stats.patches++;
      file.changes.push({ rule: RULE_PATCH, marker: 'export interface ' + cls.name + 'Patch' });
    }
    if (plan.constructorEdit !== null) edits.push(plan.constructorEdit);
    if (plan.copyEdit !== null) edits.push(plan.copyEdit);
    if (blocks.length > 0) {
      const anchor = classAnchorIndex(text, cls.declLineStart);
      const before = prevLineStart(text, anchor);
      const previousIsBlank = before === null || text.slice(before, lineEndAt(text, before)).trim() === '';
      const prefix = previousIsBlank ? '' : '\n';
      const existing = insertions.get(anchor);
      const blockText = prefix + blocks.join('\n') + '\n';
      if (existing === undefined) insertions.set(anchor, [blockText]);
      else existing.push(blockText);
    }
  }

  for (const [anchor, texts] of insertions) {
    edits.push({ start: anchor, end: anchor, text: texts.join('') });
  }
  if (edits.length === 0) return;
  file.text = applyEdits(file.text, edits);
  refreshMask(file);
}

function planClass(cls: ClassInfo, text: string, mask: Uint8Array): ClassEditPlan | null {
  const body = text.slice(cls.openBrace, cls.closeBrace + 1);
  let constructorEdit: Edit | null = null;
  let optionsFields: string[] | null = null;

  const constructorPattern = /\bconstructor[ \t]*\([ \t]*options[ \t]*:[ \t]*/g;
  constructorPattern.lastIndex = 0;
  let constructorMatch = constructorPattern.exec(body);
  while (constructorMatch !== null) {
    const absolute = cls.openBrace + constructorMatch.index;
    if (mask[absolute] === 1) break;
    constructorMatch = constructorPattern.exec(body);
  }
  if (constructorMatch !== null) {
    const typeOpen = cls.openBrace + constructorMatch.index + constructorMatch[0].length;
    if (text[typeOpen] === '{') {
      const typeClose = findMatch(text, mask, typeOpen);
      // 支持 "}) {" 与 "} = {}) {"（默认值留在原处，只替换花括号里的内联对象类型）
      const after = nextNonSpaceIndex(text, typeClose + 1);
      let supported = false;
      if (text[after] === ')') {
        supported = true;
      } else if (text[after] === '=') {
        const valueStart = nextNonSpaceIndex(text, after + 1);
        if (text[valueStart] === '{') {
          const valueClose = findMatch(text, mask, valueStart);
          const parenIndex = nextNonSpaceIndex(text, valueClose + 1);
          if (text[parenIndex] === ')' && text.slice(valueStart, valueClose + 1).trim() === '{}') {
            supported = true;
          }
        }
      }
      if (supported) {
        const members = parseConstructorOptionsBody(text.slice(typeOpen + 1, typeClose));
        if (members !== null) {
          if (hasDeclarationNamed(text, mask, cls.name + 'Options')) {
            throw new TransformError(
              fileLabel(text, cls.declLineStart) + '已经存在同名声明 ' + cls.name + 'Options，拒绝覆盖（规则 1）',
            );
          }
          optionsFields = members;
          constructorEdit = { start: typeOpen, end: typeClose + 1, text: cls.name + 'Options' };
        }
      }
    }
  }

  let copyEdit: Edit | null = null;
  let patchFields: string[] | null = null;
  const copyPattern = /\bcopy[ \t]*\([ \t]*patch[ \t]*:[ \t]*Partial[ \t]*<[ \t]*([A-Za-z_$][\w$]*)[ \t]*>/g;
  copyPattern.lastIndex = 0;
  let copyMatch = copyPattern.exec(body);
  while (copyMatch !== null) {
    const absolute = cls.openBrace + copyMatch.index;
    if (mask[absolute] === 1) break;
    copyMatch = copyPattern.exec(body);
  }
  if (copyMatch !== null && copyMatch[1] === cls.name) {
    const fields = optionsFields !== null ? optionsFields : readonlyFieldMembers(text, cls);
    if (fields !== null) {
      patchFields = fields;
      if (hasDeclarationNamed(text, mask, cls.name + 'Patch')) {
        throw new TransformError(
          fileLabel(text, cls.declLineStart) + '已经存在同名声明 ' + cls.name + 'Patch，拒绝覆盖（规则 2）',
        );
      }
      const partialStart = cls.openBrace + copyMatch.index + copyMatch[0].indexOf('Partial');
      const partialEnd = cls.openBrace + copyMatch.index + copyMatch[0].length;
      copyEdit = { start: partialStart, end: partialEnd, text: cls.name + 'Patch' };
    }
  }

  if (optionsFields === null && patchFields === null && constructorEdit === null && copyEdit === null) return null;
  return { optionsFields, patchFields, constructorEdit, copyEdit };
}

function fileLabel(text: string, index: number): string {
  return '第 ' + lineOf(text, index) + ' 行：';
}

/* ------------------------------------------------------------------ 规则 3/4：同名 type + as const 常量 */

interface PairCandidate {
  file: FileState;
  name: string;
  keys: string[];
}

function collectPairCandidates(files: FileState[]): PairCandidate[] {
  const candidates: PairCandidate[] = [];
  for (const file of files) {
    refreshMask(file);
    const text = file.text;
    const mask = file.mask;
    const aliases = findTypeAliases(text, mask);
    const consts = findConstDecls(text, mask);
    const spans = findAsConstSpans(text, mask);
    for (const owner of consts) {
      let span: Span | null = null;
      for (const candidate of spans) {
        if (candidate.start >= owner.constIndex && candidate.end <= owner.stmtEnd) { span = candidate; break; }
      }
      if (span === null) continue;
      const alias = aliases.filter((item) => item.name === owner.name && item.exported)[0];
      if (alias === undefined || !owner.exported) {
        file.claimedAsConst.add(owner.name);
        file.pendingResiduals.push({ code: 'as-const-unpaired', marker: 'const ' + owner.name + ' =', occurrence: 0 });
        continue;
      }
      if (text.slice(span.end, owner.stmtEnd).trim() !== '') {
        file.claimedAsConst.add(owner.name);
        file.pendingResiduals.push({ code: 'as-const-unpaired', marker: 'const ' + owner.name + ' =', occurrence: 0 });
        continue;
      }
      const literal = findObjectLiteral(text, mask, owner.eqIndex + 1, span.start);
      if (literal === null) {
        file.claimedAsConst.add(owner.name);
        file.pendingResiduals.push({ code: 'as-const-unpaired', marker: 'const ' + owner.name + ' =', occurrence: 0 });
        continue;
      }
      const keys = extractTopLevelKeys(text.slice(literal.start + 1, literal.end));
      if (keys === null) {
        file.claimedAsConst.add(owner.name);
        file.pendingResiduals.push({ code: 'map-keys-unsupported', marker: 'const ' + owner.name + ' =', occurrence: 0 });
        continue;
      }
      candidates.push({ file, name: owner.name, keys });
    }
  }
  return candidates;
}

interface CrossFilePlan {
  ok: boolean;
  reason: string;
  planFile: string;
  planLine: number;
  editsByFile: Array<{ file: FileState; edits: Edit[]; lines: number[] }>;
}

function unsafeCrossFile(result: CrossFilePlan, other: FileState, index: number, reason: string): CrossFilePlan {
  result.ok = false;
  result.reason = reason;
  result.planFile = other.rel;
  result.planLine = lineOf(other.text, index);
  return result;
}

/** 找 import 列表里某个 binding 说明符的位置（用于把 Tone 换成 ToneValue）。 */
function findImportSpecifierIndex(text: string, info: ImportInfo, binding: ImportBinding): number {
  const pattern = new RegExp('\\b' + escapeRegExp(binding.localName) + '\\b', 'g');
  pattern.lastIndex = info.listOpen + 1;
  const match = pattern.exec(text);
  if (match === null || match.index >= info.listClose) return -1;
  return match.index;
}

function planCrossFileRename(candidate: PairCandidate, files: FileState[], known: Map<string, FileState>): CrossFilePlan {
  const result: CrossFilePlan = { ok: true, reason: '', planFile: '', planLine: 0, editsByFile: [] };
  const newName = candidate.name + 'Value';
  for (const other of files) {
    if (other === candidate.file) continue;
    refreshMask(other);
    const occurrences = collectIdentifierOccurrences(other.text, other.mask, candidate.name);
    if (occurrences.length === 0) continue;
    if (hasDeclarationNamed(other.text, other.mask, candidate.name)) {
      return unsafeCrossFile(result, other, occurrences[0], other.rel + ' 里有同名声明 ' + candidate.name);
    }
    if (hasReExportNamed(other.text, other.mask, candidate.name)) {
      return unsafeCrossFile(result, other, occurrences[0], other.rel + ' 里 re-export 了 ' + candidate.name);
    }
    const analysis = analyzeFileText(other.text, other.mask);
    const imports = analysis.imports;
    let bindingInfo: ImportInfo | null = null;
    let binding: ImportBinding | null = null;
    for (const info of imports) {
      for (const item of info.bindings) {
        if (item.localName === candidate.name) { bindingInfo = info; binding = item; break; }
      }
      if (bindingInfo !== null) break;
    }
    const importRanges: Array<[number, number]> = [];
    for (const info of imports) importRanges.push([info.stmtStart, info.stmtEnd]);
    const outside: number[] = [];
    for (const index of occurrences) {
      let insideImport = false;
      for (const range of importRanges) {
        if (index >= range[0] && index < range[1]) { insideImport = true; break; }
      }
      if (!insideImport) outside.push(index);
    }
    // 只出现在 import 里：无需处理
    if (outside.length === 0) continue;
    // 要求：import type { Tone }（且非别名），否则不改，诚实地上报
    if (bindingInfo === null || binding === null) {
      return unsafeCrossFile(result, other, outside[0], other.rel + ' 里用到了 ' + candidate.name + ' 但没有从定义文件 import');
    }
    if (binding.importedName !== binding.localName) {
      return unsafeCrossFile(result, other, outside[0], other.rel + ' 的 import 用了别名（' + binding.importedName + ' as ' + binding.localName + '），无法安全改名');
    }
    if (!bindingInfo.typeOnly && !binding.typeOnly) {
      return unsafeCrossFile(result, other, outside[0], other.rel + ' 用的是值 import（不是 import type），无法安全改名；跨文件改名要求 import type { ' + candidate.name + ' }');
    }
    if (bindingInfo.kind !== 'named') {
      return unsafeCrossFile(result, other, outside[0], other.rel + ' 用的是非具名 import（' + bindingInfo.kind + '），无法安全改名');
    }
    const resolved = resolveSpecifier(other.rel, bindingInfo.spec, known);
    if (resolved === null || resolved !== candidate.file.rel) {
      return unsafeCrossFile(result, other, outside[0], other.rel + ' 里 ' + candidate.name + ' 的 import（' + bindingInfo.spec + '）无法解析到定义文件');
    }
    // 所有使用都必须是类型位置，否则不改（值位置不能动）
    const typeOccurrences: number[] = [];
    for (const index of outside) {
      const role = classifyOccurrenceRole(other.text, analysis, index, candidate.name);
      if (role === 'type') { typeOccurrences.push(index); continue; }
      return unsafeCrossFile(
        result,
        other,
        index,
        other.rel + ' 里 ' + candidate.name + ' 还有值位置/无法判定的用法（' + role + '），不能只改类型引用',
      );
    }
    if (typeOccurrences.length === 0) continue;
    const specifierIndex = findImportSpecifierIndex(other.text, bindingInfo, binding);
    if (specifierIndex < 0) {
      return unsafeCrossFile(result, other, outside[0], other.rel + ' 里找不到 import 说明符 ' + candidate.name);
    }
    const edits: Edit[] = [];
    const lines: number[] = [];
    for (const index of typeOccurrences) {
      edits.push({ start: index, end: index + candidate.name.length, text: newName });
      lines.push(lineOf(other.text, index));
    }
    edits.push({ start: specifierIndex, end: specifierIndex + candidate.name.length, text: newName });
    lines.push(lineOf(other.text, specifierIndex));
    result.editsByFile.push({ file: other, edits, lines });
  }
  return result;
}

/** 遇到无法判定类型的用法：不改这一对，诚实上报（不能猜、更不能把值位置改坏）。 */
function refuseUncertainRename(file: FileState, name: string, scan: RoleScan): boolean {
  file.claimedAsConst.add(name);
  const first = scan.uncertain[0];
  file.pendingResiduals.push({
    code: 'rename-uncertain',
    marker: 'type ' + name + ' =',
    occurrence: 0,
    detail: file.rel + ':' + lineOf(file.text, first.index) + ' 的用法无法判定是否类型位置（' + first.role + '）',
  });
  return false;
}

function transformPair(candidate: PairCandidate): boolean {
  const file = candidate.file;
  const name = candidate.name;
  const newName = name + 'Value';
  refreshMask(file);
  let aliases = findTypeAliases(file.text, file.mask);
  let alias = aliases.filter((item) => item.name === name && item.exported)[0];
  if (alias === undefined) return false;
  let consts = findConstDecls(file.text, file.mask);
  let owner = consts.filter((item) => item.name === name && item.exported)[0];
  if (owner === undefined) return false;

  if (hasDeclarationNamed(file.text, file.mask, newName) || hasDeclarationNamed(file.text, file.mask, name + 'Map')) {
    file.claimedAsConst.add(name);
    file.pendingResiduals.push({ code: 'name-conflict', marker: 'type ' + name + ' =', occurrence: 0 });
    return false;
  }
  if (hasReExportNamed(file.text, file.mask, name)) {
    file.claimedAsConst.add(name);
    file.pendingResiduals.push({ code: 'crossfile-type-ref', marker: 'type ' + name + ' =', occurrence: 0 });
    return false;
  }

  // Pass A：只改类型位置；值位置（= Tone、{ Tone }、{ Tone: 1 }、Tone.A、函数实参、数组元素等）一律不动
  const exclusions: Array<[number, number]> = [
    [alias.stmtStart, alias.stmtEnd],
    [owner.constIndex, owner.stmtEnd],
  ];
  // import 说明符不参与就地改名（跨文件时由 planCrossFileRename 显式处理）
  for (const info of findImports(file.text, file.mask)) exclusions.push([info.stmtStart, info.stmtEnd]);
  const analysis = analyzeFileText(file.text, file.mask);
  const scan = scanIdentifierRoles(file.text, file.mask, name, newName, exclusions, analysis);
  if (scan.uncertain.length > 0) return refuseUncertainRename(file, name, scan);
  if (scan.renames.length > 0) {
    file.text = applyEdits(file.text, scan.renames);
    refreshMask(file);
  }

  // Pass B：alias 语句本身
  aliases = findTypeAliases(file.text, file.mask);
  alias = aliases.filter((item) => item.name === name && item.exported)[0];
  if (alias === undefined) return false;
  if (alias.isObjectLiteral) {
    const bodyStart = alias.objectOpen + 1;
    const bodyText = file.text.slice(bodyStart, alias.objectClose);
    const bodyScan = scanIdentifierRoles(
      file.text,
      file.mask,
      name,
      newName,
      [[0, bodyStart], [alias.objectClose, file.text.length]],
      analyzeFileText(file.text, file.mask),
    );
    if (bodyScan.uncertain.length > 0) return refuseUncertainRename(file, name, bodyScan);
    const adjusted = bodyScan.renames.map((edit) => ({ start: edit.start - bodyStart, end: edit.end - bodyStart, text: edit.text }));
    const newBody = applyEdits(bodyText, adjusted);
    const statement = (alias.exported ? 'export ' : '') + 'interface ' + newName + ' {' + newBody + '}';
    file.text = applyEdits(file.text, [{ start: alias.stmtStart, end: alias.stmtEnd + 1, text: statement }]);
    refreshMask(file);
  } else {
    const bodyScan = scanIdentifierRoles(
      file.text,
      file.mask,
      name,
      newName,
      [[0, alias.bodyStart], [alias.bodyEnd, file.text.length]],
      analyzeFileText(file.text, file.mask),
    );
    if (bodyScan.uncertain.length > 0) return refuseUncertainRename(file, name, bodyScan);
    const bodyEdits = bodyScan.renames;
    bodyEdits.push({ start: alias.nameIndex, end: alias.nameIndex + name.length, text: newName });
    file.text = applyEdits(file.text, bodyEdits);
    refreshMask(file);
  }

  // Pass C：XMap interface + const 标注 + 删 as const
  consts = findConstDecls(file.text, file.mask);
  owner = consts.filter((item) => item.name === name && item.exported)[0];
  if (owner === undefined) return false;
  const spans = findAsConstSpans(file.text, file.mask);
  let asConst: Span | null = null;
  for (const span of spans) {
    if (span.start >= owner.constIndex && span.end <= owner.stmtEnd) { asConst = span; break; }
  }
  if (asConst === null) return false;
  const mapLines: string[] = [];
  mapLines.push('/** ' + name + ' 常量的声明类型：ArkTS 不接受 as const，改为显式 interface。 */');
  mapLines.push('export interface ' + name + 'Map {');
  for (const key of candidate.keys) mapLines.push('  readonly ' + key + ': ' + newName + ';');
  mapLines.push('}');
  const mapBlock = mapLines.join('\n') + '\n\n';

  const edits: Edit[] = [];
  const constLineStart = lineStartAt(file.text, owner.constIndex);
  edits.push({ start: constLineStart, end: constLineStart, text: mapBlock });
  edits.push({ start: owner.nameIndex + name.length, end: owner.nameIndex + name.length, text: ': ' + name + 'Map' });
  let removalStart = asConst.start;
  while (removalStart > 0 && (file.text[removalStart - 1] === ' ' || file.text[removalStart - 1] === '\t')) removalStart--;
  edits.push({ start: removalStart, end: asConst.end, text: '' });
  file.text = applyEdits(file.text, edits);
  refreshMask(file);

  file.stats.renames++;
  file.stats.asConst++;
  file.claimedAsConst.add(name);
  file.changes.push({ rule: RULE_TYPE_RENAME, marker: 'type ' + newName, markerAlt: 'interface ' + newName });
  file.changes.push({ rule: RULE_MAP, marker: 'export interface ' + name + 'Map' });
  return true;
}

function transformAllPairs(files: FileState[], known: Map<string, FileState>): void {
  const candidates = collectPairCandidates(files);
  candidates.sort((a, b) => {
    if (a.file.rel !== b.file.rel) return a.file.rel < b.file.rel ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const candidate of candidates) {
    const crossFile = planCrossFileRename(candidate, files, known);
    if (!crossFile.ok) {
      candidate.file.claimedAsConst.add(candidate.name);
      candidate.file.pendingResiduals.push({
        code: 'crossfile-type-ref',
        marker: 'type ' + candidate.name + ' =',
        occurrence: 0,
        detail: crossFile.reason,
      });
      continue;
    }
    const applied = transformPair(candidate);
    if (!applied) continue;
    for (const target of crossFile.editsByFile) {
      target.file.text = applyEdits(target.file.text, target.edits);
      refreshMask(target.file);
      for (const line of target.lines) {
        target.file.changes.push({ rule: RULE_TYPE_REF, line });
      }
    }
  }
}

/* ------------------------------------------------------------------ --ets import 重写 */

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

function rewriteEtsImports(file: FileState): void {
  refreshMask(file);
  const text = file.text;
  const mask = file.mask;
  const edits: Edit[] = [];
  const lines: number[] = [];
  const record = (specIndex: number, spec: string, index: number): void => {
    if (!isRelativeSpecifier(spec)) return;
    if (!spec.endsWith('.ts')) return;
    if (spec.endsWith('.d.ts')) return;
    edits.push({ start: specIndex + 1, end: specIndex + 1 + spec.length, text: spec.slice(0, spec.length - 3) });
    lines.push(lineOf(text, index));
  };
  forEachCodeMatch(text, mask, /\bfrom[ \t]*(["'])([^"']+)\1/g, (match) => {
    record(match.index + match[0].indexOf(match[1]), match[2], match.index);
  });
  forEachCodeMatch(text, mask, /\bimport[ \t]*\(?[ \t]*(["'])([^"']+)\1/g, (match) => {
    record(match.index + match[0].indexOf(match[1]), match[2], match.index);
  });
  if (edits.length === 0) return;
  file.text = applyEdits(file.text, edits);
  refreshMask(file);
  for (const line of lines) file.changes.push({ rule: RULE_ETS_IMPORT, line });
}

/* ------------------------------------------------------------------ 残留扫描 */

function overlaps(spans: Span[], index: number): boolean {
  for (const span of spans) if (index >= span.start && index < span.end) return true;
  return false;
}

function scanResiduals(file: FileState): void {
  refreshMask(file);
  const text = file.text;
  const mask = file.mask;
  const lines: number[] = [];
  const add = (code: string, index: number): void => {
    file.residuals.push({ line: lineOf(text, index), code, snippet: lineTextAt(text, index).trim().slice(0, 160) });
    lines.push(lineOf(text, index));
  };

  forEachCodeMatch(text, mask, /\bglobalThis\b/g, (match) => add('globalThis', match.index));

  const asUnknownSpans: Span[] = [];
  forEachCodeMatch(text, mask, /\bas[ \t]+unknown\b/g, (match) => {
    asUnknownSpans.push({ start: match.index, end: match.index + match[0].length });
    add('as-unknown', match.index);
  });
  forEachCodeMatch(text, mask, /\b(?:any|unknown)\b/g, (match) => {
    if (overlaps(asUnknownSpans, match.index)) return;
    const prev = prevNonSpaceIndex(text, match.index);
    if (prev >= 0 && text[prev] === '.') return;
    add('any-unknown', match.index);
  });

  forEachCodeMatch(text, mask, /\bPartial[ \t]*</g, (match) => add('partial-remaining', match.index));

  const aliases = findTypeAliases(text, mask);
  forEachCodeMatch(text, mask, /([A-Za-z_$][\w$.]*)[ \t]*\[[ \t]*(?:"[^"]*"|'[^']*'|number)[ \t]*\]/g, (match) => {
    let insideAlias = false;
    for (const alias of aliases) {
      if (match.index >= alias.bodyStart && match.index < alias.bodyEnd) { insideAlias = true; break; }
    }
    if (insideAlias) {
      add('indexed-type-access', match.index);
      return;
    }
    const prev = prevNonSpaceIndex(text, match.index);
    if (prev >= 0 && ': |&<,'.indexOf(text[prev]) >= 0) add('indexed-type-access', match.index);
  });

  // 内联对象类型：只报告「类型位置」的 { ... }，跳过对象字面量的值位置。
  // 判定用一层括号上下文栈：{ 的类型由前一个字符/关键字决定，嵌套时继承 value-object。
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (mask[i] !== 1) continue;
    const ch = text[i];
    if (ch === '(') { stack.push('paren'); continue; }
    if (ch === '[') { stack.push('bracket'); continue; }
    if (ch === ')') { if (stack[stack.length - 1] === 'paren') stack.pop(); continue; }
    if (ch === ']') { if (stack[stack.length - 1] === 'bracket') stack.pop(); continue; }
    if (ch === '}') {
      const top = stack[stack.length - 1];
      if (top === 'value-object' || top === 'block' || top === 'type-object') stack.pop();
      continue;
    }
    if (ch !== '{') continue;
    const top = stack.length > 0 ? stack[stack.length - 1] : '';
    const prev = prevNonSpaceIndex(text, i);
    const prevChar = prev >= 0 ? text[prev] : '';
    const prevWord = previousWord(text, i);
    let kind = 'block';
    if (prevChar === ':') {
      kind = top === 'value-object' || top === 'bracket' ? 'value-object' : 'type-object';
    } else if (prevWord === 'as') {
      kind = 'type-object';
    } else if (prev >= 0 && '=([,?'.indexOf(prevChar) >= 0) {
      kind = 'value-object';
    } else if (['return', 'case', 'default', 'in', 'of', 'typeof'].indexOf(prevWord) >= 0) {
      kind = 'value-object';
    }
    if (kind === 'type-object') {
      const close = findMatch(text, mask, i);
      const body = text.slice(i + 1, close);
      if (looksLikeTypeBody(body)) {
        let isConstructor = false;
        if (prevChar === ':') {
          const head = text.slice(Math.max(0, prev - 48), prev);
          if (/constructor[ \t]*\([ \t]*options[ \t]*$/.test(head)) isConstructor = true;
        }
        add(isConstructor ? 'unsupported-constructor' : 'inline-object-type', i);
      }
    }
    stack.push(kind);
  }

  const consts = findConstDecls(text, mask);
  for (const span of findAsConstSpans(text, mask)) {
    let owner: ConstDeclInfo | null = null;
    for (const item of consts) {
      if (item.constIndex <= span.start && span.end <= item.stmtEnd) { owner = item; break; }
    }
    if (owner !== null && file.claimedAsConst.has(owner.name)) continue;
    add('as-const-unpaired', span.start);
  }
}

/* ------------------------------------------------------------------ 报告收尾 */

function resolveMarkerLine(text: string, marker: string, alternate: string | undefined, occurrence: number): number {
  let index = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(marker, from);
    if (index < 0) break;
    from = index + marker.length;
  }
  if (index < 0 && alternate !== undefined) index = text.indexOf(alternate);
  if (index < 0) return 1;
  return lineOf(text, index);
}

interface ChangeRow {
  file: string;
  line: number;
  rule: string;
}

interface ResidualRow {
  file: string;
  line: number;
  code: string;
  hint: string;
  snippet: string;
}

function finalizeReport(files: FileState[]): { changes: ChangeRow[]; residuals: ResidualRow[] } {
  const changes: ChangeRow[] = [];
  const residuals: ResidualRow[] = [];
  for (const file of files) {
    for (const change of file.changes) {
      const line = change.line !== undefined
        ? change.line
        : resolveMarkerLine(file.text, change.marker, change.markerAlt, 0);
      changes.push({ file: file.rel, line, rule: change.rule });
    }
    for (const pending of file.pendingResiduals) {
      const line = resolveMarkerLine(file.text, pending.marker, undefined, pending.occurrence);
      const baseHint = RESIDUAL_HINTS[pending.code] || '';
      residuals.push({
        file: file.rel,
        line,
        code: pending.code,
        hint: pending.detail !== undefined ? baseHint + '（' + pending.detail + '）' : baseHint,
        snippet: lineTextAt(file.text, lineStartAtByLine(file.text, line)).trim().slice(0, 160),
      });
    }
    for (const residual of file.residuals) {
      residuals.push({
        file: file.rel,
        line: residual.line,
        code: residual.code,
        hint: RESIDUAL_HINTS[residual.code] || '',
        snippet: residual.snippet,
      });
    }
  }
  changes.sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)));
  residuals.sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)));
  return { changes, residuals };
}

function lineStartAtByLine(text: string, line: number): number {
  let current = 1;
  let index = 0;
  while (current < line && index < text.length) {
    const next = text.indexOf('\n', index);
    if (next < 0) return text.length;
    index = next + 1;
    current++;
  }
  return index;
}

/* ------------------------------------------------------------------ 目录扫描 */

function walkSourceFiles(root: string): string[] {
  const list: string[] = [];
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        visit(absolute);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.ets'))) {
        list.push(absolute);
      }
    }
  };
  visit(root);
  list.sort();
  return list;
}

/* ------------------------------------------------------------------ CLI */

interface CliOptions {
  src: string;
  out: string;
  ets: boolean;
  report: string;
  json: boolean;
  failOnResidual: boolean;
}

interface ParsedArgs {
  kind: string;
  message: string;
  options: CliOptions;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const options: CliOptions = {
    src: '',
    out: '',
    ets: false,
    report: '',
    json: false,
    failOnResidual: false,
  };
  const wantValue = new Set<string>(['src', 'out', 'report']);
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--help' || argument === '-h') return { kind: 'help', message: '', options };
    if (!argument.startsWith('--')) {
      return { kind: 'usage', message: '不认识的参数：' + argument, options };
    }
    let key = argument.slice(2);
    let value: string | null = null;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (wantValue.has(key)) {
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          return { kind: 'usage', message: '--' + key + ' 缺少取值', options };
        }
        value = next;
        i++;
      }
      if (value === '') return { kind: 'usage', message: '--' + key + ' 缺少取值', options };
      if (key === 'src') options.src = value;
      else if (key === 'out') options.out = value;
      else options.report = value;
      continue;
    }
    if (value !== null) return { kind: 'usage', message: '--' + key + ' 不接受取值', options };
    if (key === 'ets') options.ets = true;
    else if (key === 'json') options.json = true;
    else if (key === 'fail-on-residual') options.failOnResidual = true;
    else return { kind: 'usage', message: '不认识的参数：--' + key, options };
  }
  if (options.src === '') return { kind: 'usage', message: '缺少 --src', options };
  if (options.out === '') return { kind: 'usage', message: '缺少 --out', options };
  return { kind: 'run', message: '', options };
}

interface Report {
  summary: {
    filesScanned: number;
    filesChanged: number;
    options: number;
    patches: number;
    renames: number;
    asConst: number;
    residuals: number;
  };
  changes: ChangeRow[];
  residuals: ResidualRow[];
}

interface RunResult {
  report: Report;
  outDir: string;
}

function runAdapt(options: CliOptions): RunResult {
  const srcDir = resolve(options.src);
  const outDir = resolve(options.out);
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new UsageError('--src 不是目录：' + options.src);
  }
  if (outDir === srcDir) throw new UsageError('--out 不能等于 --src（src 永不被修改）');
  if (outDir.startsWith(srcDir + sep)) throw new UsageError('--out 不能位于 --src 内（src 永不被修改）');
  if (existsSync(outDir) && !statSync(outDir).isDirectory()) throw new UsageError('--out 已存在但不是目录：' + options.out);

  const absoluteFiles = walkSourceFiles(srcDir);
  const files: FileState[] = [];
  const known = new Map<string, FileState>();
  for (const absolute of absoluteFiles) {
    const rel = relative(srcDir, absolute).split(sep).join('/');
    let text = readFileSync(absolute, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const state = makeFileState(rel, text);
    files.push(state);
    known.set(rel, state);
  }

  transformAllPairs(files, known);
  for (const file of files) transformClassRules(file);
  if (options.ets) {
    for (const file of files) rewriteEtsImports(file);
  }
  for (const file of files) scanResiduals(file);

  const { changes, residuals } = finalizeReport(files);

  // 先把全部产物算好再落盘：变换异常时不会写出半成品。
  const outputs: Array<{ rel: string; text: string; absolute: string }> = [];
  let filesChanged = 0;
  for (const file of files) {
    let outRel = file.rel;
    if (options.ets && file.rel.endsWith('.ts')) outRel = file.rel.slice(0, file.rel.length - 3) + '.ets';
    const changed = outRel !== file.rel || file.text !== file.originalText;
    if (changed) filesChanged++;
    outputs.push({ rel: outRel, text: file.text, absolute: join(outDir, outRel.split('/').join(sep)) });
  }

  for (const output of outputs) {
    mkdirSync(dirname(output.absolute), { recursive: true });
    writeFileSync(output.absolute, output.text, 'utf8');
  }

  const report: Report = {
    summary: {
      filesScanned: files.length,
      filesChanged,
      options: files.reduce((sum, file) => sum + file.stats.options, 0),
      patches: files.reduce((sum, file) => sum + file.stats.patches, 0),
      renames: files.reduce((sum, file) => sum + file.stats.renames, 0),
      asConst: files.reduce((sum, file) => sum + file.stats.asConst, 0),
      residuals: residuals.length,
    },
    changes,
    residuals,
  };

  if (options.report !== '') {
    const reportPath = resolve(options.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return { report, outDir };
}

function formatHuman(result: RunResult): string {
  const summary = result.report.summary;
  const lines: string[] = [];
  lines.push('adapt-arkts：扫描 ' + summary.filesScanned + ' 文件 → ' + result.outDir);
  lines.push(
    '变换：options=' + summary.options + ' patches=' + summary.patches +
      ' renames=' + summary.renames + ' asConst=' + summary.asConst,
  );
  lines.push('改动：' + summary.filesChanged + ' 文件');
  lines.push('残留：' + summary.residuals + ' 处（不会自动改；--fail-on-residual 时退出码 3）');
  for (const residual of result.report.residuals.slice(0, 20)) {
    lines.push('  ' + residual.file + ':' + residual.line + '  ' + residual.code + '  ' + residual.snippet);
  }
  if (summary.residuals > 20) lines.push('  ...（其余见 --report）');
  if (summary.residuals === 0) lines.push('门禁：无残留');
  lines.push('下一步：残留按 rules/arkts-restrictions.md 人工处理；src 未改动。');
  return lines.join('\n');
}

function main(): number {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE + '\n');
    return EXIT_OK;
  }
  if (parsed.kind === 'usage') {
    process.stderr.write('错误：' + parsed.message + '\n\n' + USAGE + '\n');
    return EXIT_USAGE;
  }
  try {
    const result = runAdapt(parsed.options);
    if (parsed.options.json) {
      process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
    } else {
      process.stdout.write(formatHuman(result) + '\n');
    }
    if (parsed.options.failOnResidual && result.report.summary.residuals > 0) return EXIT_RESIDUAL;
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write('错误：' + error.message + '\n\n' + USAGE + '\n');
      return EXIT_USAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write('adapt-arkts 变换失败：' + message + '\n');
    return EXIT_TRANSFORM;
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();

export { buildCodeMask, runAdapt, parseCliArgs, main };
