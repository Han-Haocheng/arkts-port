#!/usr/bin/env node
/**
 * pack-context —— 给「语义转写」阶段生成确定性上下文包：agent 只读这个包，不整棵读闭包源码。
 * 对应流水线 ② 之后的转写准备步骤（读数从「闭包源码」降到「索引 + 标记 + 规则」）。
 *
 * 用法：
 *   node cli/pack-context.ts --closure <dir> [--lang jvm] [--out out/context.md]
 *        [--max-bytes 200000] [--exclude <glob>]... [--json] [--report <path>]
 *   node cli/pack-context.ts --help
 *
 * 生成内容（Markdown）：
 *   文件清单 + 行数 / 顶层导出签名索引（class/interface/object/enum/data class/typealias/顶层 fun/val，不带函数体；
 *   js-ts 额外给顶层 class/interface/对象类型别名索引一层成员签名：方法/属性/constructor 参数，同样不带函数体，
 *   --no-members 关闭）
 *   / F32 标记位置（文件:行 + 行内容）/ 规则链接（rules/arkts-restrictions.md、adapters/jvm.md）
 *   / 总字节数与 token 估算（bytes / 3.8）
 *
 * 输出：
 *   --out <file>   写 Markdown 上下文包；超过 --max-bytes 时主文件给完整索引，正文按文件分片到
 *                  同目录的 context-001.md、context-002.md …（固定命名，内容与 --out 路径无关）
 *   --json         报告 JSON 打到 stdout
 *   --report <f>   报告 JSON 写到文件
 *   都不给          Markdown 打到 stdout（人类摘要打到 stderr）
 *
 * 退出码：0 成功；1 读取失败；2 用法错误。
 *
 * 确定性：同参数两次运行输出逐字节相同；内容里不出现时间戳、绝对路径、--out 路径。
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// 与 extract-closure 共用 js-ts 的掩码/签名实现，避免两套解析器漂移（jvm 仍走本文件的 Kotlin/Java 解析）
import { extractJsTsSignatures, loadLangConfig, maskJsSource } from './extract-closure.ts';

// ---------------------------------------------------------------- 常量

const SUPPORTED_LANGS = ['jvm', 'js-ts'];
/** js-ts 的体积目录一律不扫（node_modules 是硬要求）。 */
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'oh_modules', '.git', '.hvigor', '.next', '.nuxt', 'vendor']);
const DEFAULT_MAX_BYTES = 200000;
const TOKEN_DIVISOR = 3.8;
/** 分片固定前缀：内容不随 --out 文件名变化（契约要求）。 */
const SHARD_BASENAME = 'context';
const SHARD_DIGITS = 3;
const FENCE = String.fromCharCode(96, 96, 96);
const SIGNATURE_MAX_CHARS = 2000;
const HEADER_SCAN_LIMIT = 8000;

const RULES_LINKS = [
  'rules/arkts-restrictions.md —— ArkTS 限制清单与修法（转写后必须过 lint）',
  'adapters/jvm.md —— Kotlin/Java 语义映射与坑',
];

const DECL_MODIFIERS = [
  'public', 'private', 'protected', 'internal', 'open', 'abstract', 'sealed', 'data', 'enum',
  'annotation', 'value', 'inline', 'expect', 'actual', 'final', 'const', 'lateinit', 'override',
  'suspend', 'operator', 'infix', 'tailrec', 'external', 'vararg', 'static', 'transient',
  'volatile', 'native', 'synchronized', 'default', 'strictfp', 'noinline', 'crossinline', 'reified',
];

const MODIFIER_PREFIX = '(?:(?:' + DECL_MODIFIERS.join('|') + ')\\s+)*';

const DECL_RE = new RegExp(
  '^(' + MODIFIER_PREFIX + ')' +
  '((?:@[A-Za-z_][A-Za-z0-9_]*(?:\\s*\\([^)]*\\))?\\s+)*)' +
  '(class|interface|object|typealias|fun|val|var|record)\\s+([\\s\\S]+)$',
);

const BACKTICK = String.fromCharCode(96);

// ---------------------------------------------------------------- 类型

export interface Signature {
  text: string;
  line: number;
  kind: string;
  /** true = 类型成员签名（缩进渲染）；false = 顶层声明 */
  member: boolean;
}

export interface F32Marker {
  line: number;
  text: string;
}

export interface SourceFile {
  path: string;
  loc: number;
  sourceBytes: number;
  lang: 'kotlin' | 'java' | 'ts' | 'js';
  signatures: Signature[];
  f32: F32Marker[];
}

export interface ExcludedFile {
  path: string;
  pattern: string;
}

export interface ShardInfo {
  file: string;
  bytes: number;
  files: number;
  oversize: boolean;
}

export interface PackReport {
  ok: boolean;
  lang: string;
  files: { path: string; loc: number; signatures: number; f32: number; shard: string | null }[];
  totals: {
    files: number;
    loc: number;
    bytes: number;
    estTokens: number;
    signatures: number;
    topLevelSignatures: number;
    memberSignatures: number;
    f32: number;
    sourceBytes: number;
  };
  shards: ShardInfo[];
  excluded: ExcludedFile[];
  f32Markers: { file: string; line: number; text: string }[];
}

export interface PackBuild {
  main: string;
  shards: { file: string; content: string; files: number; oversize: boolean }[];
  sharded: boolean;
  report: PackReport;
  totalsBytes: number;
}

// ---------------------------------------------------------------- 源码预处理

/**
 * 把注释与字符串字面量内容替换成空格（长度/换行不变），保留带花括号的模板表达式。
 * 与 cli/extract-closure.ts 同口径（本仓库工具都是零依赖自包含的，这里刻意重复而不跨工具 import）。
 */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = new Array(src.length);
  for (let k = 0; k < src.length; k++) out[k] = src[k];
  const n = src.length;
  const blank = (k: number): void => {
    if (k < n && src[k] !== '\n' && src[k] !== '\r') out[k] = ' ';
  };
  type Frame = { kind: 'code' | 'str' | 'raw' | 'char'; braces: number };
  const frames: Frame[] = [{ kind: 'code', braces: 0 }];
  let i = 0;
  while (i < n) {
    const top = frames[frames.length - 1];
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (top.kind === 'code') {
      if (ch === '/' && next === '/') {
        while (i < n && src[i] !== '\n') { blank(i); i++; }
        continue;
      }
      if (ch === '/' && next === '*') {
        let depth = 0;
        while (i < n) {
          if (src[i] === '/' && src[i + 1] === '*') { depth++; blank(i); blank(i + 1); i += 2; continue; }
          if (src[i] === '*' && src[i + 1] === '/') {
            depth--; blank(i); blank(i + 1); i += 2;
            if (depth === 0) break;
            continue;
          }
          blank(i); i++;
        }
        continue;
      }
      if (ch === '"') {
        // 保留字符串定界符（签名里 String 默认值渲染成 ""，不丢信息），只清空内容
        if (src[i + 1] === '"' && src[i + 2] === '"') {
          frames.push({ kind: 'raw', braces: 0 }); i += 3; continue;
        }
        frames.push({ kind: 'str', braces: 0 }); i++; continue;
      }
      if (ch === "'") { frames.push({ kind: 'char', braces: 0 }); i++; continue; }
      if (ch === '{') { top.braces++; i++; continue; }
      if (ch === '}') {
        if (top.braces > 0) { top.braces--; i++; continue; }
        if (frames.length > 1) { frames.pop(); blank(i); i++; continue; }
        i++; continue;
      }
      i++; continue;
    }
    if (top.kind === 'str' || top.kind === 'char') {
      if (ch === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (top.kind === 'str' && ch === '"') { frames.pop(); i++; continue; }
      if (top.kind === 'char' && ch === "'") { frames.pop(); i++; continue; }
      if (top.kind === 'str' && ch === '$' && next === '{') {
        blank(i); blank(i + 1); i += 2; frames.push({ kind: 'code', braces: 0 }); continue;
      }
      blank(i); i++; continue;
    }
    if (ch === '$' && next === '{') {
      blank(i); blank(i + 1); i += 2; frames.push({ kind: 'code', braces: 0 }); continue;
    }
    if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      frames.pop(); i += 3; continue;
    }
    blank(i); i++; continue;
  }
  return out.join('');
}

/** 物理行数（与 wc -l 对齐：末尾换行不多算一行）。 */
export function countLines(src: string): number {
  if (src.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  if (src.endsWith('\n')) n--;
  return n;
}

function kindFromKeyword(keyword: string, modifiers: string): string {
  if (keyword === 'class') {
    if (/\benum\b/.test(modifiers)) return 'enum';
    if (/\bannotation\b/.test(modifiers)) return 'annotation';
    return 'class';
  }
  if (keyword === 'record') return 'class';
  return keyword;
}

interface DeclStart {
  kind: string;
  visibility: 'public' | 'private';
}

/** 判断一行是否某个顶层声明的起点（行首、花括号/圆括号深度都为 0）。 */
function parseDeclStart(line: string): DeclStart | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const modifierMatch = new RegExp('^' + MODIFIER_PREFIX).exec(trimmed);
  const modifiers = modifierMatch ? modifierMatch[0] : '';
  const afterModifiers = trimmed.slice(modifiers.length);
  const visibility: 'public' | 'private' = /\bprivate\b/.test(modifiers) ? 'private' : 'public';
  if (afterModifiers.startsWith('@interface')) return { kind: 'annotation', visibility };
  if (trimmed.startsWith('@')) return null;
  if (/^(package|import)\s/.test(trimmed)) return null;
  const m = DECL_RE.exec(trimmed);
  if (!m) return null;
  const keyword = m[3];
  let kind = kindFromKeyword(keyword, modifiers);
  const rest = m[4];
  if (keyword === 'fun' && /^interface\s+/.test(rest)) kind = 'interface';
  return { kind, visibility };
}

/**
 * 从声明起点抽出「头部」文本：到函数/属性体（= 或 {）为止，保留构造参数列表；
 * 圆括号里的默认值（含 lambda 花括号）不算体。Java 用 ; 作为头部结束。
 */
function readHeader(code: string, start: number, kind: string): string {
  let paren = 0;
  let brace = 0;
  const limit = Math.min(code.length, start + HEADER_SCAN_LIMIT);
  let i = start;
  for (; i < limit; i++) {
    const ch = code[i];
    if (ch === '(') { paren++; continue; }
    if (ch === ')') { paren = paren > 0 ? paren - 1 : 0; continue; }
    if (ch === '{') {
      if (paren === 0 && brace === 0) break;
      brace++;
      continue;
    }
    if (ch === '}') { if (brace > 0) brace--; continue; }
    // typealias 的 = 右侧是签名的一部分（别名目标），其余声明的 = 是体
    if (ch === '=' && paren === 0 && brace === 0 && kind !== 'typealias') break;
    if (ch === ';' && paren === 0 && brace === 0) break;
    if (ch === '\n' && paren === 0 && brace === 0) {
      let j = i + 1;
      while (j < limit && (code[j] === ' ' || code[j] === '\t' || code[j] === '\r' || code[j] === '\n')) j++;
      const next = j < limit ? code[j] : '';
      if (next === ':' || next === '{' || next === ',') continue;
      let p = i - 1;
      while (p >= start && (code[p] === ' ' || code[p] === '\t' || code[p] === '\r')) p--;
      if (code[p] === ':' || code[p] === ',') continue;
      break;
    }
  }
  return code.slice(start, i);
}

function normalizeHeader(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  // 字符串字面量在 strip 阶段只留定界符 + 空格，这里收成空字面量，别让 String 默认值看起来像丢了
  text = text.replace(/"[ \t]*"/g, '""').replace(/'[ \t]*'/g, "''");
  text = text.replace(/\s+get\(\)$/, '').replace(/\s+set\([^)]*\)$/, '');
  if (text.length > SIGNATURE_MAX_CHARS) text = text.slice(0, SIGNATURE_MAX_CHARS).trimEnd() + ' …';
  return text;
}

const CLASS_LIKE_KINDS = new Set(['class', 'interface', 'object', 'enum', 'annotation']);

/**
 * 导出签名（不带函数体）：顶层声明 + 顶层类型的一层成员（默认；--no-members 只出顶层）。
 * private 声明不导出，跳过；函数/属性体、局部变量、companion object 内部、嵌套类型内部不索引。
 */
export function extractSignatures(src: string, options?: { members?: boolean }): Signature[] {
  const includeMembers = options?.members !== false;
  const code = stripCommentsAndStrings(src);
  const lines = code.split('\n');
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) { offsets.push(acc); acc += line.length + 1; }
  const signatures: Signature[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let lastTopKind: string | null = null;
  let inClassBody = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (braceDepth === 0 && parenDepth === 0) {
      const decl = parseDeclStart(line);
      if (decl !== null && decl.visibility === 'public') {
        const text = normalizeHeader(readHeader(code, offsets[li], decl.kind));
        if (text.length > 0) {
          signatures.push({ text, line: li + 1, kind: decl.kind, member: false });
          lastTopKind = decl.kind;
        }
      }
    } else if (includeMembers && inClassBody && braceDepth === 1 && parenDepth === 0) {
      const member = parseDeclStart(line);
      if (member !== null && member.visibility === 'public') {
        const text = normalizeHeader(readHeader(code, offsets[li], member.kind));
        if (text.length > 0) signatures.push({ text, line: li + 1, kind: member.kind, member: true });
      }
    }
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = braceDepth > 0 ? braceDepth - 1 : 0;
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = parenDepth > 0 ? parenDepth - 1 : 0;
    }
    if (braceDepth === 0) {
      inClassBody = false;
    } else if (!inClassBody && braceDepth === 1 && lastTopKind !== null && CLASS_LIKE_KINDS.has(lastTopKind)) {
      inClassBody = true;
    }
  }
  return signatures;
}

// ---------------------------------------------------------------- js-ts 成员签名

interface JsTypeBody {
  name: string;
  kind: 'class' | 'interface' | 'typealias';
  /** 体起点（'{' 之后）与终点（'}' 之前）。 */
  start: number;
  end: number;
}

const JS_MEMBER_MODIFIER = '(?:(?:static|public|private|protected|readonly|abstract|override|declare|async)\\s+)*';
const JS_MEMBER_METHOD_RE = new RegExp('^' + JS_MEMBER_MODIFIER + '[A-Za-z_$#][\\w$]*\\s*\\??\\s*(?:<[^>]*>)?\\s*\\(');

function offsetLine(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function findBraceClose(code: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 顶层 export class/interface 的体范围（只找顶层：brace/paren 深度为 0 时匹配）。 */
function findJsTypeBodies(code: string): JsTypeBody[] {
  const bodies: JsTypeBody[] = [];
  const lines = code.split('\n');
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1;
  }
  let braceDepth = 0;
  let parenDepth = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (braceDepth === 0 && parenDepth === 0) {
      const m = /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(line.trim());
      if (m !== null) {
        const keyword = m[1] === 'class' ? 'class' : m[1] === 'interface' ? 'interface' : 'typealias';
        let open = -1;
        if (keyword === 'typealias') {
          // 只索引 export type X = ... { ... } 这种带对象体的类型别名；纯联合/Pick 没有体
          let eq = -1;
          for (let p = offsets[li]; p < code.length; p++) {
            if (code[p] === '=') {
              eq = p;
              break;
            }
            if (code[p] === ';') break;
          }
          if (eq >= 0) {
            let p = eq + 1;
            while (p < code.length) {
              const ch = code[p];
              if (ch === '{') {
                open = p;
                break;
              }
              if (ch === ';') break;
              if (ch === '\n') {
                const prev = prevNonSpace(code, p - 1);
                const prevCh = prev >= 0 ? code[prev] : '';
                if (prevCh === '&' || prevCh === '|' || prevCh === '=' || prevCh === ',' || prevCh === '(' || prevCh === '<' || prevCh === ':') {
                  p++;
                  continue;
                }
                let j = p + 1;
                while (j < code.length && (code[j] === ' ' || code[j] === '\t' || code[j] === '\r' || code[j] === '\n')) j++;
                const nextCh = j < code.length ? code[j] : '';
                if (nextCh === '|' || nextCh === '&' || nextCh === '{') {
                  p = j;
                  continue;
                }
                break;
              }
              p++;
            }
          }
        } else {
          for (let p = offsets[li]; p < code.length; p++) {
            if (code[p] === '{') {
              open = p;
              break;
            }
            if (code[p] === ';') break;
          }
        }
        if (open >= 0) {
          const close = findBraceClose(code, open, code.length);
          if (close > open) bodies.push({ name: m[2], kind: keyword, start: open + 1, end: close });
        }
      }
    }
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = braceDepth > 0 ? braceDepth - 1 : 0;
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = parenDepth > 0 ? parenDepth - 1 : 0;
    }
  }
  return bodies;
}

function prevNonSpace(code: string, from: number): number {
  let i = from;
  while (i >= 0 && (code[i] === ' ' || code[i] === '\t' || code[i] === '\r' || code[i] === '\n')) i--;
  return i;
}

/**
 * 读一个成员头部：到方法体 / 属性初始化 / ';' 为止。
 * 内联对象类型的花括号（属性类型、泛型约束）整块跳过；多行签名靠换行续行规则折叠。
 */
function readJsMemberHeader(code: string, start: number, bodyEnd: number): number {
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let i = start;
  for (; i < bodyEnd; i++) {
    const ch = code[i];
    if (ch === '(') {
      paren++;
      continue;
    }
    if (ch === ')') {
      paren = paren > 0 ? paren - 1 : 0;
      continue;
    }
    if (ch === '[') {
      bracket++;
      continue;
    }
    if (ch === ']') {
      bracket = bracket > 0 ? bracket - 1 : 0;
      continue;
    }
    if (paren !== 0 || bracket !== 0) continue;
    if (ch === '<') {
      angle++;
      continue;
    }
    if (ch === '>' && angle > 0) {
      angle--;
      continue;
    }
    if (ch === ';' || ch === '}') return i;
    if (ch === '{') {
      const p = prevNonSpace(code, i - 1);
      const prevCh = p >= start ? code[p] : '';
      if (prevCh === ':' || prevCh === '|' || prevCh === '&' || prevCh === '=' || prevCh === ',' || prevCh === '<') {
        i = findBraceClose(code, i, bodyEnd);
        if (i < 0) return bodyEnd;
        continue;
      }
      return i;
    }
    if (ch === '=' && code[i + 1] !== '>') return i;
    if (ch === '\n') {
      const p = prevNonSpace(code, i - 1);
      const prevCh = p >= start ? code[p] : '';
      if (prevCh === ',' || prevCh === '(' || prevCh === ':' || prevCh === '|' || prevCh === '&' || prevCh === '<' || prevCh === '=') continue;
      let j = i + 1;
      while (j < bodyEnd && (code[j] === ' ' || code[j] === '\t' || code[j] === '\r' || code[j] === '\n')) j++;
      const nextCh = j < bodyEnd ? code[j] : '';
      if (nextCh === '|' || nextCh === '&' || nextCh === ':' || nextCh === ',' || nextCh === ')' || nextCh === '?' || nextCh === '>' || nextCh === '<') continue;
      return i;
    }
  }
  return i;
}

function normalizeJsMember(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/"[ \t]*"/g, '""').replace(/'[ \t]*'/g, "''");
  text = text.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/,\s*\)/g, ')');
  if (text.length > SIGNATURE_MAX_CHARS) text = text.slice(0, SIGNATURE_MAX_CHARS).trimEnd() + ' …';
  return text;
}

function classifyJsMember(text: string): string {
  if (/^constructor\b/.test(text)) return 'constructor';
  if (/^(?:get|set)\s+[A-Za-z_$#]/.test(text)) return 'accessor';
  if (JS_MEMBER_METHOD_RE.test(text)) return 'method';
  return 'property';
}

/** 属性初始化表达式：跳到 ';' 或行尾（函数体/对象字面量整块跳过），别把初始值当成新成员。 */
function skipJsInitializer(code: string, from: number, bodyEnd: number): number {
  let paren = 0;
  let bracket = 0;
  let i = from + 1;
  for (; i < bodyEnd; i++) {
    const ch = code[i];
    if (ch === '(') {
      paren++;
      continue;
    }
    if (ch === ')') {
      if (paren > 0) paren--;
      continue;
    }
    if (ch === '[') {
      bracket++;
      continue;
    }
    if (ch === ']') {
      bracket = bracket > 0 ? bracket - 1 : 0;
      continue;
    }
    if (ch === '{') {
      const close = findBraceClose(code, i, bodyEnd);
      if (close < 0) return bodyEnd;
      i = close;
      continue;
    }
    if (ch === ';' && paren === 0 && bracket === 0) return i + 1;
    if (ch === '\n' && paren === 0 && bracket === 0) {
      const p = prevNonSpace(code, i - 1);
      const prevCh = p >= from ? code[p] : '';
      if (prevCh === '+' || prevCh === '-' || prevCh === '*' || prevCh === '/' || prevCh === '&' || prevCh === '|' || prevCh === '=' || prevCh === '?' || prevCh === ':' || prevCh === ',' || prevCh === '(' || prevCh === '.') continue;
      let j = i + 1;
      while (j < bodyEnd && (code[j] === ' ' || code[j] === '\t' || code[j] === '\r' || code[j] === '\n')) j++;
      const nextCh = j < bodyEnd ? code[j] : '';
      if (nextCh === '.' || nextCh === '?' || nextCh === ':' || nextCh === '&' || nextCh === '|' || nextCh === '+' || nextCh === '-' || nextCh === '*') continue;
      return i;
    }
  }
  return i;
}

/** 顶层类型的一层成员（不含函数体；private/# 成员、纯修饰词、孤立大括号都跳过）。 */
function extractJsTsMemberSignatures(code: string, body: JsTypeBody, offsets: number[]): Signature[] {
  const members: Signature[] = [];
  const SKIP_TEXT = /^(?:static|public|private|protected|readonly|abstract|override|declare)$/;
  let i = body.start;
  while (i < body.end) {
    while (i < body.end && (code[i] === ' ' || code[i] === '\t' || code[i] === '\r' || code[i] === '\n' || code[i] === ';')) i++;
    if (i >= body.end) break;
    const start = i;
    const headerEnd = readJsMemberHeader(code, start, body.end);
    const text = normalizeJsMember(code.slice(start, headerEnd));
    const trimmed = text.trim();
    if (trimmed.length > 0 && trimmed !== '{' && trimmed !== '}' && !SKIP_TEXT.test(trimmed)) {
      if (!/^private\b/.test(trimmed) && trimmed.charAt(0) !== '#') {
        members.push({ text: text, line: offsetLine(offsets, start), kind: classifyJsMember(trimmed), member: true });
      }
    }
    let cursor = headerEnd;
    if (cursor < body.end && code[cursor] === '{') cursor = findBraceClose(code, cursor, body.end);
    else if (cursor < body.end && code[cursor] === '=') cursor = skipJsInitializer(code, cursor, body.end);
    if (cursor < 0) cursor = body.end;
    i = cursor <= start ? start + 1 : cursor;
  }
  return members;
}

/** js-ts 顶层签名 + 顶层 class/interface 的一层成员（默认；members:false 只出顶层）。 */
export function extractJsTsSignaturesWithMembers(src: string, options?: { members?: boolean }): Signature[] {
  const top = extractJsTsSignatures(src);
  if (options?.members === false) return top;
  const code = maskJsSource(src, 'signatures');
  const lines = code.split('\n');
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1;
  }
  const members: Signature[] = [];
  for (const body of findJsTypeBodies(code)) {
    for (const member of extractJsTsMemberSignatures(code, body, offsets)) members.push(member);
  }
  if (members.length === 0) return top;
  return top.concat(members).sort((a, b) => a.line - b.line || (a.member === b.member ? 0 : a.member ? 1 : -1));
}

/** F32 标记：原文件里匹配 // F32: 的行（文件:行 + 行内容）。 */
export function findF32Markers(src: string): F32Marker[] {
  const markers: F32Marker[] = [];
  const re = /\/\/\s*F32\s*:/;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) markers.push({ line: i + 1, text: lines[i].trim() });
  }
  return markers;
}

// ---------------------------------------------------------------- 扫描

function extsForLang(lang: string): Set<string> {
  // 语言扩展名统一由 adapters/languages.json 提供（jvm 仍是 .kt/.java）
  return new Set(loadLangConfig(lang).extensions.map((item) => item.toLowerCase()));
}

/** 极简 glob：* / ? / **，按相对路径匹配；没有 / 的模式同时匹配 basename。 */
export function globMatches(pattern: string, relPath: string): boolean {
  const regex = globToRegExp(pattern);
  if (regex.test(relPath)) return true;
  if (!pattern.includes('/')) return regex.test(basename(relPath));
  return false;
}

const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '(', ')', '[', ']', '|', '\\']);

function globToRegExp(pattern: string): RegExp {
  const glob = pattern.replace(/\\/g, '/');
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; }
        else source += '.*';
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { source += '[^/]'; continue; }
    source += REGEX_SPECIALS.has(ch) ? '\\' + ch : ch;
  }
  source += '$';
  return new RegExp(source);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const absDir = relDir === '' ? root : join(root, relDir);
    const entries = readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : relDir + '/' + entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
        stack.push(relPath);
        continue;
      }
      if (entry.isFile()) out.push(relPath);
    }
  }
  out.sort();
  return out;
}

export interface ScanResult {
  files: SourceFile[];
  excluded: ExcludedFile[];
}

export function scanClosure(root: string, lang: string, excludes: string[], options?: { members?: boolean }): ScanResult {
  const exts = extsForLang(lang);
  const all = walkFiles(root);
  const files: SourceFile[] = [];
  const excluded: ExcludedFile[] = [];
  for (const relPath of all) {
    const matched = excludes.find((pattern) => globMatches(pattern, relPath));
    if (matched !== undefined) {
      excluded.push({ path: relPath, pattern: matched });
      continue;
    }
    const ext = extname(relPath).toLowerCase();
    if (!exts.has(ext)) continue;
    const src = readFileSync(join(root, relPath), 'utf8');
    files.push({
      path: relPath,
      loc: countLines(src),
      sourceBytes: Buffer.byteLength(src, 'utf8'),
      lang: lang === 'js-ts'
        ? (ext === '.ts' || ext === '.tsx' ? 'ts' : 'js')
        : (ext === '.java' ? 'java' : 'kotlin'),
      signatures: lang === 'js-ts' ? extractJsTsSignaturesWithMembers(src, options) : extractSignatures(src, options),
      f32: findF32Markers(src),
    });
  }
  return { files, excluded };
}

// ---------------------------------------------------------------- 渲染

function formatNumber(value: number): string {
  const digits = String(Math.trunc(value));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

function shardFileName(index: number): string {
  return SHARD_BASENAME + '-' + String(index).padStart(SHARD_DIGITS, '0') + '.md';
}

function shardHeader(index: number): string {
  return '# 转写上下文包 · 分片 ' + String(index).padStart(SHARD_DIGITS, '0') + '\n\n';
}

function renderHeader(options: {
  lang: string;
  files: number;
  loc: number;
  sourceBytes: number;
  bytesText: string;
  tokensText: string;
  sharded: boolean;
  shardCount: number;
  excluded: ExcludedFile[];
}): string {
  const lines: string[] = [];
  lines.push('# 转写上下文包（' + options.lang + '）');
  lines.push('');
  lines.push('- 文件: ' + formatNumber(options.files) + ' / 行数: ' + formatNumber(options.loc));
  lines.push('- 源码: ' + formatNumber(options.sourceBytes) + ' 字节');
  lines.push('- 上下文包: ' + options.bytesText + ' 字节 ≈ ' + options.tokensText + ' tokens（bytes / ' + TOKEN_DIVISOR + '）');
  lines.push('- 打包模式: ' + (options.sharded ? '分片（' + formatNumber(options.shardCount) + ' 个）' : '单文件'));
  lines.push('- 规则: ' + RULES_LINKS.map((item) => item.split(' —— ')[0]).join(' · '));
  if (options.excluded.length > 0) {
    const names = options.excluded.slice(0, 8).map((item) => item.path);
    const suffix = options.excluded.length > names.length ? ' 等 ' + formatNumber(options.excluded.length) + ' 个' : '';
    lines.push('- 排除: ' + names.join(' · ') + suffix);
  }
  lines.push('');
  return lines.join('\n');
}

function renderFileList(files: SourceFile[], shardOf: (path: string) => string | null): string {
  const lines: string[] = [];
  lines.push('## 文件清单');
  lines.push('');
  if (files.every((file) => shardOf(file.path) === null)) {
    lines.push('| 文件 | 行数 | 签名 | F32 |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const file of files) {
      lines.push('| ' + file.path + ' | ' + formatNumber(file.loc) + ' | ' + formatNumber(file.signatures.length) + ' | ' + formatNumber(file.f32.length) + ' |');
    }
  } else {
    lines.push('| 文件 | 行数 | 签名 | F32 | 分片 |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const file of files) {
      const shard = shardOf(file.path);
      lines.push('| ' + file.path + ' | ' + formatNumber(file.loc) + ' | ' + formatNumber(file.signatures.length) + ' | ' + formatNumber(file.f32.length) + ' | ' + (shard === null ? '-' : shard) + ' |');
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderSections(sections: { file: SourceFile; text: string }[]): string {
  return sections.map((item) => item.text).join('\n');
}

function renderSection(file: SourceFile): string {
  const lines: string[] = [];
  lines.push('### ' + file.path);
  lines.push('');
  if (file.signatures.length === 0) {
    lines.push('（无顶层导出签名）');
    lines.push('');
    return lines.join('\n');
  }
  lines.push(FENCE + file.lang);
  for (const signature of file.signatures) lines.push((signature.member ? '  ' : '') + signature.text);
  lines.push(FENCE);
  lines.push('');
  return lines.join('\n');
}

function renderF32(files: SourceFile[]): string {
  const entries: { path: string; line: number; text: string }[] = [];
  for (const file of files) for (const marker of file.f32) entries.push({ path: file.path, line: marker.line, text: marker.text });
  const lines: string[] = [];
  lines.push('## F32 标记（' + formatNumber(entries.length) + ' 处）');
  lines.push('');
  if (entries.length === 0) {
    lines.push('无（闭包内没有 // F32: 标记）');
  } else {
    for (const entry of entries) lines.push('- ' + entry.path + ':' + entry.line + ': ' + entry.text);
  }
  lines.push('');
  return lines.join('\n');
}

function renderRules(): string {
  const lines: string[] = [];
  lines.push('## 规则');
  lines.push('');
  for (const link of RULES_LINKS) lines.push('- ' + link);
  lines.push('');
  return lines.join('\n');
}

function renderShardIndex(shards: { file: string; content: string; files: number }[]): string {
  const lines: string[] = [];
  lines.push('## 分片');
  lines.push('');
  for (const shard of shards) {
    lines.push('- ' + shard.file + '（' + formatNumber(shard.files) + ' 文件 / ' + formatNumber(Buffer.byteLength(shard.content, 'utf8')) + ' 字节）');
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 打包

function groupByMaxBytes(sections: { file: SourceFile; text: string }[], maxBytes: number): { file: SourceFile; text: string }[][] {
  const reserve = Buffer.byteLength(shardHeader(1), 'utf8');
  const groups: { file: SourceFile; text: string }[][] = [];
  let current: { file: SourceFile; text: string }[] = [];
  let currentBytes = 0;
  for (const section of sections) {
    const size = Buffer.byteLength(section.text, 'utf8');
    if (current.length > 0 && reserve + currentBytes + size > maxBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(section);
    currentBytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function buildPack(
  files: SourceFile[],
  excluded: ExcludedFile[],
  options: { lang: string; maxBytes: number },
): PackBuild {
  const sorted = files.slice().sort((a, b) => a.path.localeCompare(b.path));
  const sections = sorted.map((file) => ({ file, text: renderSection(file) }));
  const loc = sorted.reduce((sum, file) => sum + file.loc, 0);
  const sourceBytes = sorted.reduce((sum, file) => sum + file.sourceBytes, 0);
  const signatureCount = sorted.reduce((sum, file) => sum + file.signatures.length, 0);
  const memberSignatureCount = sorted.reduce((sum, file) => sum + file.signatures.filter((signature) => signature.member).length, 0);
  const topLevelSignatureCount = signatureCount - memberSignatureCount;
  const f32Count = sorted.reduce((sum, file) => sum + file.f32.length, 0);

  const headerFor = (bytesText: string, tokensText: string, sharded: boolean, shardCount: number): string =>
    renderHeader({ lang: options.lang, files: sorted.length, loc, sourceBytes, bytesText, tokensText, sharded, shardCount, excluded });

  // 1) 先按单文件渲染，迭代到自引用字节数稳定
  const renderSingle = (bytesText: string, tokensText: string): string =>
    [
      headerFor(bytesText, tokensText, false, 0),
      renderFileList(sorted, () => null),
      '## 顶层导出签名索引\n\n约定：不缩进 = 顶层声明；缩进 2 空格 = 类型成员签名（都不带函数体）。',
      renderSections(sections),
      renderF32(sorted),
      renderRules(),
    ].join('\n');
  let singleText = '';
  let singleBytes = 0;
  for (let i = 0; i < 10; i++) {
    singleText = renderSingle(formatNumber(singleBytes), formatNumber(Math.round(singleBytes / TOKEN_DIVISOR)));
    const actual = Buffer.byteLength(singleText, 'utf8');
    if (actual === singleBytes) break;
    singleBytes = actual;
  }

  // 2) 没超限：单文件模式
  if (singleBytes <= options.maxBytes) {
    const report: PackReport = {
      ok: true,
      lang: options.lang,
      files: sorted.map((file) => ({ path: file.path, loc: file.loc, signatures: file.signatures.length, f32: file.f32.length, shard: null })),
      totals: {
        files: sorted.length, loc, bytes: singleBytes, estTokens: Math.round(singleBytes / TOKEN_DIVISOR),
        signatures: signatureCount, topLevelSignatures: topLevelSignatureCount, memberSignatures: memberSignatureCount,
        f32: f32Count, sourceBytes,
      },
      shards: [],
      excluded,
      f32Markers: sorted.flatMap((file) => file.f32.map((marker) => ({ file: file.path, line: marker.line, text: marker.text }))),
    };
    return { main: singleText, shards: [], sharded: false, report, totalsBytes: singleBytes };
  }

  // 3) 分片模式：正文按文件分片，主文件给完整索引
  const groups = groupByMaxBytes(sections, options.maxBytes);
  const shards = groups.map((group, index) => {
    const content = shardHeader(index + 1) + group.map((item) => item.text).join('\n');
    const bytes = Buffer.byteLength(content, 'utf8');
    const oversize = group.length === 1 && bytes > options.maxBytes;
    return { file: shardFileName(index + 1), content, files: group.length, oversize, entries: group };
  });
  const shardOf = new Map<string, string>();
  for (const shard of shards) for (const entry of shard.entries) shardOf.set(entry.file.path, shard.file);
  const shardBytes = shards.reduce((sum, shard) => sum + Buffer.byteLength(shard.content, 'utf8'), 0);

  const renderMain = (bytesText: string, tokensText: string): string =>
    [
      headerFor(bytesText, tokensText, true, shards.length),
      renderFileList(sorted, (path) => shardOf.get(path) ?? null),
      renderF32(sorted),
      renderShardIndex(shards.map((shard) => ({ file: shard.file, content: shard.content, files: shard.files }))),
      renderRules(),
    ].join('\n');
  let mainText = '';
  let totalBytes = 0;
  for (let i = 0; i < 10; i++) {
    mainText = renderMain(formatNumber(totalBytes), formatNumber(Math.round(totalBytes / TOKEN_DIVISOR)));
    const actual = Buffer.byteLength(mainText, 'utf8') + shardBytes;
    if (actual === totalBytes) break;
    totalBytes = actual;
  }

  const report: PackReport = {
    ok: true,
    lang: options.lang,
    files: sorted.map((file) => ({ path: file.path, loc: file.loc, signatures: file.signatures.length, f32: file.f32.length, shard: shardOf.get(file.path) ?? null })),
    totals: {
      files: sorted.length, loc, bytes: totalBytes, estTokens: Math.round(totalBytes / TOKEN_DIVISOR),
      signatures: signatureCount, topLevelSignatures: topLevelSignatureCount, memberSignatures: memberSignatureCount,
      f32: f32Count, sourceBytes,
    },
    shards: shards.map((shard) => ({ file: shard.file, bytes: Buffer.byteLength(shard.content, 'utf8'), files: shard.files, oversize: shard.oversize })),
    excluded,
    f32Markers: sorted.flatMap((file) => file.f32.map((marker) => ({ file: file.path, line: marker.line, text: marker.text }))),
  };
  return { main: mainText, shards: shards.map((shard) => ({ file: shard.file, content: shard.content, files: shard.files, oversize: shard.oversize })), sharded: true, report, totalsBytes: totalBytes };
}

// ---------------------------------------------------------------- CLI

const USAGE = [
  'pack-context —— 生成「语义转写」阶段的确定性上下文包（流水线 ② 之后）',
  '',
  '用法：',
  '  node cli/pack-context.ts --closure <dir> [--lang jvm] [--out out/context.md]',
  '       [--max-bytes 200000] [--exclude <glob>]... [--json] [--report <path>]',
  '',
  '参数：',
  '  --closure <dir>    必填，闭包目录（通常是 extract-closure --out 的产物）',
  '  --lang <id>        语言适配器：jvm（.kt/.java，默认）/ js-ts（.js/.jsx/.ts/.tsx/.mjs/.cjs）',
  '  --out <file>       写 Markdown 上下文包；父目录会自动创建',
  '  --max-bytes <n>    单个 Markdown 文件上限，默认 200000；超限时主文件给完整索引、',
  '                     正文按文件分片到同目录 context-001.md、context-002.md …（固定命名）',
  '  --exclude <glob>   排除文件，可重复；支持 * ? **，如 Main.kt、**/skip/*.kt',
  '  --no-members       签名索引只出顶层声明（默认含顶层类型的一层成员，仍不带函数体）',
  '  --json             报告 JSON 打到 stdout',
  '  --report <file>    报告 JSON 写到文件（与 --json 内容一致）',
  '  --help             显示本帮助（退出码 0）',
  '',
  'js-ts：签名索引覆盖 export function/class/interface/type/const/let/var/enum 与默认导出，',
  '  多行参数折叠成单行；顶层 export class/interface/对象类型别名（export type X = {...}）再索引一层成员签名',
  '  （方法/属性/constructor 参数，同样不带函数体；private/# 成员跳过，--no-members 关闭）；',
  '  自动跳过 node_modules/dist/build/out 等目录。',
  '  Markdown 内容：文件清单 + 行数 / 顶层导出签名索引（不带函数体，含顶层类型的一层成员签名，',
  '同样不带函数体、缩进渲染，--no-members 可关）/ F32 标记位置（文件:行 + 行内容）',
  '',
  '报告 JSON：',
  '  {ok, lang, files:[{path,loc,signatures,f32,shard}],',
  '   totals{files,loc,bytes,estTokens,signatures,topLevelSignatures,memberSignatures,f32,sourceBytes},',
  '   shards:[{file,bytes,files,oversize}], excluded:[{path,pattern}],',
  '   f32Markers:[{file,line,text}]}',
  '  totals.bytes = 上下文包字节数（主文件 + 分片）；totals.sourceBytes = 闭包源码字节数。',
  '',
  '退出码：0 成功；1 读取失败；2 用法错误',
  '',
  '确定性：同参数两次运行逐字节相同；内容不含时间戳、绝对路径、--out 路径。',
  '',
  '示例：',
  '  node cli/pack-context.ts --closure out/closure/src --exclude Main.kt \\',
  '       --out out/context.md --report out/context.json',
].join('\n');

interface CliArgs {
  closure?: string;
  lang: string;
  out?: string;
  maxBytes: number;
  exclude: string[];
  noMembers: boolean;
  json: boolean;
  report?: string;
  help: boolean;
}

const BOOL_FLAGS = new Set(['json', 'help', 'h', 'no-members']);
const VALUE_FLAGS = new Set(['closure', 'lang', 'out', 'max-bytes', 'exclude', 'report']);

class UsageError extends Error {}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { lang: 'jvm', maxBytes: DEFAULT_MAX_BYTES, exclude: [], noMembers: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) throw new UsageError('多余的参数：' + token);
    const name = token === '-h' ? 'h' : token.replace(/^--?/, '');
    if (BOOL_FLAGS.has(name)) {
      if (name === 'json') args.json = true;
      else if (name === 'no-members') args.noMembers = true;
      else args.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError('未知参数：' + token);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError('参数缺值：' + token);
    i++;
    if (name === 'closure') args.closure = value;
    else if (name === 'lang') args.lang = value;
    else if (name === 'out') args.out = value;
    else if (name === 'report') args.report = value;
    else if (name === 'exclude') args.exclude.push(value);
    else {
      if (!/^\d+$/.test(value) || Number(value) <= 0) throw new UsageError('--max-bytes 必须是正整数：' + value);
      args.maxBytes = Number(value);
    }
  }
  return args;
}

function fail(message: string, code: number): never {
  console.error('pack-context: ' + message);
  process.exit(code);
}

function humanSummary(report: PackReport, outPath: string | null, shardNames: string[]): string {
  const lines: string[] = [];
  lines.push('pack-context: ' + formatNumber(report.totals.files) + ' 文件 / ' + formatNumber(report.totals.loc) + ' 行'
    + ' / 签名 ' + formatNumber(report.totals.signatures) + ' 条（顶层 ' + formatNumber(report.totals.topLevelSignatures)
    + ' + 成员 ' + formatNumber(report.totals.memberSignatures) + '）'
    + ' / F32 ' + formatNumber(report.totals.f32) + ' 处');
  lines.push('上下文包: ' + formatNumber(report.totals.bytes) + ' 字节 ≈ ' + formatNumber(report.totals.estTokens) + ' tokens（bytes / ' + TOKEN_DIVISOR + '）');
  if (outPath !== null) lines.push('输出: ' + outPath);
  if (shardNames.length > 0) {
    const shown = shardNames.slice(0, 3).join('、');
    const suffix = shardNames.length > 3 ? ' 等 ' + formatNumber(shardNames.length) + ' 个' : '';
    lines.push('分片: ' + shown + suffix);
  }
  if (report.excluded.length > 0) {
    const names = report.excluded.slice(0, 5).map((item) => item.path);
    const suffix = report.excluded.length > names.length ? ' 等 ' + formatNumber(report.excluded.length) + ' 个' : '';
    lines.push('排除: ' + names.join('、') + suffix);
  }
  return lines.join('\n');
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error('pack-context: ' + error.message);
      console.error('用 --help 看用法');
      process.exit(2);
    }
    throw error;
  }
  if (args.help) { console.log(USAGE); return; }
  if (!args.closure) {
    console.error('pack-context: 缺少 --closure');
    console.error('用 --help 看用法');
    process.exit(2);
  }
  if (!SUPPORTED_LANGS.includes(args.lang)) {
    fail('支持的语言：' + SUPPORTED_LANGS.join(' / ') + '，不支持 --lang ' + args.lang, 2);
  }
  const closureDir = resolve(args.closure as string);
  if (!existsSync(closureDir) || !statSync(closureDir).isDirectory()) {
    fail('--closure 不是目录：' + closureDir, 2);
  }
  let outPath: string | null = null;
  if (args.out !== undefined) {
    outPath = resolve(args.out);
    if (existsSync(outPath) && statSync(outPath).isDirectory()) fail('--out 是目录而不是文件：' + outPath, 2);
  }

  let scan: ScanResult;
  try {
    scan = scanClosure(closureDir, args.lang, args.exclude, { members: !args.noMembers });
  } catch (error) {
    fail('读取闭包失败：' + (error as Error).message, 1);
  }

  const built = buildPack(scan.files, scan.excluded, { lang: args.lang, maxBytes: args.maxBytes });
  if (built.sharded && outPath === null) {
    fail('上下文包超过 --max-bytes 需要分片，但没给 --out（分片无处写）；给 --out 或调大 --max-bytes', 2);
  }

  const json = JSON.stringify(built.report, null, 2) + '\n';
  if (args.report !== undefined) {
    const reportPath = resolve(args.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, json, 'utf8');
  }
  if (outPath !== null) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, built.main, 'utf8');
    for (const shard of built.shards) {
      writeFileSync(join(dirname(outPath), shard.file), shard.content, 'utf8');
    }
  }

  if (args.json) {
    process.stdout.write(json);
    return;
  }
  if (outPath !== null) {
    // 人类摘要里回显用户给的路径写法（不强制展开成绝对路径）
    console.log(humanSummary(built.report, args.out as string, built.shards.map((shard) => shard.file)));
    return;
  }
  process.stdout.write(built.main);
  console.error(humanSummary(built.report, null, []));
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return pathToFileURL(resolve(argv1)).href === import.meta.url; } catch { return false; }
})();

if (invokedDirectly) main();
