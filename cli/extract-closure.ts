#!/usr/bin/env node
/**
 * 抽取依赖闭包（jvm：Kotlin/Java；js-ts：JS/TS）：从 entry 出发做传递闭包，把「能编译的纯逻辑」和
 * 「必须人工处理的平台耦合」分开，输出机器可读报告。对应流水线第 ② 步。
 *
 * js-ts 解析规则：ESM import / export-from / 动态 import() / CJS require()；相对路径按
 * 「精确文件 → 补扩展名（.ts/.tsx/.d.ts/.js/.jsx/.mjs/.cjs）→ .js 与 .ts 互换 → index.*」解析；
 * 非相对 import（npm 包、vite 别名如 @/）按契约归 external；命中 adapters/languages.json 的
 * js-ts platformPatterns（react-native / @tarojs / document.* / window.* / navigator.*）→ coupled boundary。
 *
 * 用法：
 *   node cli/extract-closure.ts --root <project> --entry <file.kt|.java> [--lang jvm]
 *        [--out <dir>] [--report <path.json>] [--json] [--no-package-complete]
 *   node cli/extract-closure.ts --help
 *
 * 退出码：0 成功（unresolved 非空仍为 0，但一定会报告）；1 entry 不存在/无法解析；2 参数错误。
 *
 * 分类：
 *   include  闭包内的纯逻辑文件（--out 时按原相对路径复制）
 *   coupled  命中 adapters/languages.json 的 platformPatterns，记为 boundary，不再深入
 *   test     测试源集（src/test、src/androidTest、src/ohosTest、test/、androidTest/），不进闭包
 *   平台 import 只被注解使用（如 @Stable）或完全未使用 → 记入 removableImports，不算耦合
 *   （对应 adapters/jvm.md「只用到注解的 → 去掉注解」）
 *
 * 同包引用：Kotlin/Java 同 package 的符号可以不带 import 直接用，正则穷举不可靠，
 * 所以默认做 package 补全 —— 闭包只要碰到某个 package 的纯逻辑文件，就把该 package 其余的
 * 纯逻辑文件一并纳入，保证抽出的闭包可编译。--no-package-complete 退回严格引用闭包（更小，可能缺同包符号）。
 *
 * 限制（诚实边界）：不做类型推断；不解析字符串字面量内的符号；Kotlin 只展开带花括号的模板表达式；
 * 不展开 "$name" 简单模板；对完全限定名（inline FQN，如 io.x.Y.z()）不做引用解析。
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, relative, resolve, extname, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- 类型

export interface LangConfig {
  name: string;
  extensions: string[];
  platformPatterns: string[];
  goldenRunner: string;
  harnessTemplate: string;
  semanticStage: string;
  status: string;
  note?: string;
}

export interface ImportRef {
  /** jvm：完整限定名；js-ts：模块说明符（相对路径或包名） */
  fqn: string;
  star: boolean;
  alias: string | null;
  line: number;
  /** js-ts：具名导入/再导出的绑定名（用于 boundary 的 neededBy 展示） */
  names?: string[];
  /** js-ts：是否有默认导入 */
  defaultImport?: boolean;
}

export interface Decl {
  name: string;
  kind: 'class' | 'interface' | 'object' | 'enum' | 'typealias' | 'fun' | 'val' | 'var' | 'annotation';
  line: number;
  visibility: 'public' | 'private';
}

export interface PlatformHit {
  line: number;
  text: string;
  patternIndex: number;
  fqn: string | null;
}

export interface RemovableImport {
  symbol: string;
  usage: 'annotation-only' | 'unused';
}

export interface FileInfo {
  rel: string;
  pkg: string;
  imports: ImportRef[];
  decls: Decl[];
  loc: number;
  isTest: boolean;
  coupled: boolean;
  platformHits: PlatformHit[];
  removable: RemovableImport[];
}

export type Via = 'entry' | 'import' | 'star-import' | 'same-package' | 'package-peer';

export interface Dep {
  rel: string;
  via: Via;
  symbol: string | null;
}

export interface ProjectIndex {
  root: string;
  lang: string;
  cfg: LangConfig;
  files: Map<string, FileInfo>;
  byPkg: Map<string, Map<string, string[]>>;
  byQualified: Map<string, string[]>;
  byFileKey: Map<string, string[]>;
  packages: Set<string>;
  scanned: number;
  /** 本工程独占的标识符缓存（按 index 作用域化，避免连续跑两个 root 时串味）。 */
  identCache: Map<string, Set<string>>;
}

export interface FileRow {
  path: string;
  loc: number;
  role: 'include' | 'coupled' | 'test';
  coupled: boolean;
  pkg: string;
  vias: Via[];
}

export interface BoundaryDeclaration {
  name: string;
  kind: Decl['kind'];
  line: number;
  /** 闭包是否真的需要它（false = 与需要的声明同处耦合文件、抽模块时可一并评估） */
  needed: boolean;
}

export interface BoundaryRow {
  file: string;
  reason: string;
  evidence: string[];
  patterns: number[];
  /** 闭包需要的声明（= 手工抽模块必须带出的最小集合） */
  symbols: Decl[];
  /** 该耦合文件的全部 public 顶层声明，needed 标记是否被闭包需要 */
  declarations: BoundaryDeclaration[];
  neededBy: { file: string; symbols: string[] }[];
}

export interface UnresolvedRow {
  symbol: string;
  fromFile: string;
  reason: string;
  kind: 'external' | 'internal';
  /** 命中但断链的 alias 模式（js-ts） */
  alias?: string;
  /** alias 展开出的 root 相对目标（js-ts） */
  target?: string;
}

export interface ManualExtractionRow {
  symbol: string;
  kind: Decl['kind'];
  declaredIn: string;
  neededBy: string[];
  reason: string;
}

export interface ClosureReport {
  entry: string;
  entryPackage: string;
  root: string;
  lang: string;
  packageComplete: boolean;
  files: FileRow[];
  totals: {
    files: number;
    loc: number;
    include: number;
    coupled: number;
    test: number;
    includeLoc: number;
    coupledLoc: number;
  };
  boundaries: BoundaryRow[];
  unresolved: UnresolvedRow[];
  removableImports: { symbol: string; fromFile: string; usage: 'annotation-only' | 'unused' }[];
  manualExtractions: ManualExtractionRow[];
  /** js-ts：是否启用 alias 解析（jvm 恒 false） */
  aliasesEnabled: boolean;
  /** js-ts：命中的 alias 与展开目标（按 fromFile + specifier 排序） */
  aliases: AliasHit[];
  /** js-ts：实际读过的 alias 配置文件（root 相对） */
  aliasConfigs: string[];
  scannedFiles: number;
}

export interface ExtractOptions {
  root: string;
  entry: string;
  lang?: string;
  packageComplete?: boolean;
  /** js-ts：是否解析 tsconfig paths / vite alias（默认开；--no-alias 关闭）。 */
  aliases?: boolean;
}

// ---------------------------------------------------------------- 常量

const LANG_CONFIG_PATH = fileURLToPath(new URL('../adapters/languages.json', import.meta.url));

/** 已实现解析器的语言。契约要求 jvm；其它语言等适配器实现后再接。 */
const SUPPORTED_LANGS = ['jvm', 'js-ts'];

const SKIP_DIR_NAMES = new Set([
  'build', 'out', 'dist', 'target', 'node_modules', '.git', '.gradle', '.idea', '.hvigor',
  'oh_modules', '.cxx', 'coverage', '.direnv', '.kotlin', 'generated',
]);

/** 测试源集目录名。生产闭包永不进入；entry 落在测试源集时仍可解析，但角色记 test。 */
const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'androidTest', 'ohosTest', 'testFixtures']);

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

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

const BACKTICK = String.fromCharCode(96);

// ---------------------------------------------------------------- 源码预处理

/**
 * 把注释与字符串字面量的内容替换成空格（长度、换行不变），保留 Kotlin/Java 的
 * 带花括号模板表达式（里面是代码）。注释嵌套按 Kotlin 规则处理（Java 不嵌套，嵌套化处理无害）。
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
        if (src[i + 1] === '"' && src[i + 2] === '"') {
          frames.push({ kind: 'raw', braces: 0 }); blank(i); blank(i + 1); blank(i + 2); i += 3; continue;
        }
        frames.push({ kind: 'str', braces: 0 }); blank(i); i++; continue;
      }
      if (ch === "'") { frames.push({ kind: 'char', braces: 0 }); blank(i); i++; continue; }
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
      if (top.kind === 'str' && ch === '"') { frames.pop(); blank(i); i++; continue; }
      if (top.kind === 'char' && ch === "'") { frames.pop(); blank(i); i++; continue; }
      if (top.kind === 'str' && ch === '$' && next === '{') {
        blank(i); blank(i + 1); i += 2; frames.push({ kind: 'code', braces: 0 }); continue;
      }
      blank(i); i++; continue;
    }
    // raw string（三引号）
    if (ch === '$' && next === '{') {
      blank(i); blank(i + 1); i += 2; frames.push({ kind: 'code', braces: 0 }); continue;
    }
    if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      frames.pop(); blank(i); blank(i + 1); blank(i + 2); i += 3; continue;
    }
    blank(i); i++; continue;
  }
  return out.join('');
}

/** 行首下标表，用于把字符下标换成行号。 */
function lineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** 物理行数（与 wc -l 对齐：末尾换行不多算一行）。 */
export function countLines(src: string): number {
  if (src.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  if (src.endsWith('\n')) n--;
  return n;
}

function stripLeadingGenerics(text: string): string {
  if (text[0] !== '<') return text;
  let depth = 0;
  let i = 0;
  for (; i < text.length; i++) {
    if (text[i] === '<') depth++;
    else if (text[i] === '>') { depth--; if (depth === 0) { i++; break; } }
  }
  return text.slice(i).trimStart();
}

function identifierOf(text: string): string | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(BACKTICK)) {
    const end = trimmed.indexOf(BACKTICK, 1);
    if (end > 1) return trimmed.slice(1, end);
    return null;
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(trimmed);
  return m ? m[0] : null;
}

function nameOfCallable(rest: string): string | null {
  const text = stripLeadingGenerics(rest.trim());
  const cut = text.search(/[(=:{ \t]/);
  const signature = cut === -1 ? text : text.slice(0, cut);
  const parts = signature.split('.');
  return identifierOf(parts[parts.length - 1].trim());
}

function nameOfProperty(rest: string): string | null {
  const text = rest.trim();
  if (text.startsWith('(')) return null; // 解构声明
  const cut = text.search(/[=:( \t]/);
  const spec = cut === -1 ? text : text.slice(0, cut);
  const parts = spec.split('.');
  return identifierOf(parts[parts.length - 1].trim());
}

function kindFromKeyword(keyword: string, modifiers: string): Decl['kind'] {
  if (keyword === 'class') {
    if (/\benum\b/.test(modifiers)) return 'enum';
    if (/\bannotation\b/.test(modifiers)) return 'annotation';
    return 'class';
  }
  if (keyword === 'record') return 'class';
  if (keyword === 'interface') return 'interface';
  if (keyword === 'object') return 'object';
  if (keyword === 'typealias') return 'typealias';
  if (keyword === 'fun') return 'fun';
  if (keyword === 'val') return 'val';
  return 'var';
}

/** 解析一行顶层声明；不是声明返回 null。 */
function parseDeclLine(line: string): Decl | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const modifierMatch = new RegExp('^' + MODIFIER_PREFIX).exec(trimmed);
  const modifiers = modifierMatch ? modifierMatch[0] : '';
  const afterModifiers = trimmed.slice(modifiers.length);
  if (afterModifiers.startsWith('@interface')) {
    const name = identifierOf(afterModifiers.slice('@interface'.length));
    if (!name) return null;
    return { name, kind: 'annotation', line: 0, visibility: /\bprivate\b/.test(modifiers) ? 'private' : 'public' };
  }
  if (trimmed.startsWith('@')) return null; // 注解行（声明在别的行）
  if (/^(package|import)\s/.test(trimmed)) return null;
  const m = DECL_RE.exec(trimmed);
  if (!m) return null;
  const keyword = m[3];
  let rest = m[4];
  let kind = kindFromKeyword(keyword, modifiers);
  if (keyword === 'fun' && /^interface\s+/.test(rest)) {
    kind = 'interface';
    rest = rest.replace(/^interface\s+/, '');
  }
  const name = kind === 'fun' ? nameOfCallable(rest)
    : (kind === 'val' || kind === 'var') ? nameOfProperty(rest)
      : identifierOf(rest);
  if (!name) return null;
  const visibility = /\bprivate\b/.test(modifiers) ? 'private' : 'public';
  return { name, kind, line: 0, visibility };
}

export function isTestPath(rel: string): boolean {
  for (const part of rel.split('/')) if (TEST_DIR_NAMES.has(part)) return true;
  return false;
}

function isImportLine(line: string): boolean {
  return /^[ \t]*import\s+/.test(line);
}

/** import 路径：a.b.C 或 a.b.*（每段都要以字母/下划线开头，末段允许 *）。 */
const IMPORT_PATH = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_*][A-Za-z0-9_]*)*';

function importFqn(line: string): string | null {
  const m = new RegExp('^[ \\t]*import\\s+(?:static\\s+)?(' + IMPORT_PATH + ')').exec(line);
  return m ? m[1] : null;
}

/** 符号名是 ASCII 标识符，只需转义正则元字符（不含大括号，避免模板字面量歧义）。 */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

/** 只在注解位置（或完全未使用）出现的符号 → 去掉注解/删 import 即可，不算平台耦合。 */
function removableUsage(codeWithoutImports: string, simpleName: string): RemovableImport | null {
  const name = escapeRe(simpleName);
  const usage = new RegExp('\\b' + name + '\\b', 'g');
  const total = (codeWithoutImports.match(usage) ?? []).length;
  if (total === 0) return { symbol: simpleName, usage: 'unused' };
  const annotated = new RegExp('@(?:[A-Za-z_][A-Za-z0-9_]*:)?\\s*' + name + '\\b', 'g');
  const annotations = (codeWithoutImports.match(annotated) ?? []).length;
  if (annotations === total) return { symbol: simpleName, usage: 'annotation-only' };
  return null;
}

export interface CouplingResult {
  coupled: boolean;
  hits: PlatformHit[];
  removable: RemovableImport[];
}

export function evaluateCoupling(code: string, cfg: LangConfig): CouplingResult {
  const lines = code.split('\n');
  const codeWithoutImports = lines.filter((line) => !isImportLine(line)).join('\n');
  const patterns = cfg.platformPatterns.map((pattern) => new RegExp(pattern));
  const hits: PlatformHit[] = [];
  const removable = new Map<string, RemovableImport>();
  for (let pi = 0; pi < patterns.length; pi++) {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.trim().length === 0) continue;
      if (!patterns[pi].test(line)) continue;
      const text = line.trim();
      const fqn = isImportLine(line) ? importFqn(line) : null;
      hits.push({ line: li + 1, text, patternIndex: pi, fqn });
      if (fqn) {
        const simple = fqn.split('.').pop() ?? '';
        if (simple && simple !== '*' && !removable.has(fqn)) {
          const usage = removableUsage(codeWithoutImports, simple);
          if (usage) removable.set(fqn, { symbol: fqn, usage: usage.usage });
        }
      }
    }
  }
  let nonImportHit = false;
  const hardImports = new Set<string>();
  for (const hit of hits) {
    if (hit.fqn === null) { nonImportHit = true; continue; }
    if (!removable.has(hit.fqn)) hardImports.add(hit.fqn);
  }
  const removableOut = [...removable.values()].filter((item) => !hardImports.has(item.symbol));
  return { coupled: nonImportHit || hardImports.size > 0, hits, removable: removableOut };
}

/** 解析单个文件：package / imports / 顶层声明（带行号与可见性）/ 耦合判定。 */
export function parseSource(rel: string, src: string, cfg: LangConfig, lang = 'jvm'): FileInfo {
  if (lang === 'js-ts') return parseJsTsSource(rel, src, cfg);
  const code = stripCommentsAndStrings(src);
  const starts = lineStarts(code);
  const pkgMatch = /^[ \t]*package\s+([A-Za-z_][A-Za-z0-9_.]*)/m.exec(code);
  const pkg = pkgMatch ? pkgMatch[1] : '';

  const imports: ImportRef[] = [];
  const importRe = new RegExp('^[ \\t]*import\\s+(?:static\\s+)?(' + IMPORT_PATH + ')(?:\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*))?', 'gm');
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    const fqn = m[1];
    imports.push({ fqn, star: fqn.endsWith('.*'), alias: m[2] ?? null, line: lineAt(starts, m.index) });
  }

  const lines = code.split('\n');
  const decls: Decl[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (braceDepth === 0 && parenDepth === 0) {
      const decl = parseDeclLine(line);
      if (decl) { decl.line = li + 1; decls.push(decl); }
    }
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth = braceDepth > 0 ? braceDepth - 1 : 0;
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = parenDepth > 0 ? parenDepth - 1 : 0;
    }
  }

  const coupling = evaluateCoupling(code, cfg);
  return {
    rel, pkg, imports, decls, loc: countLines(src), isTest: isTestPath(rel),
    coupled: coupling.coupled, platformHits: coupling.hits, removable: coupling.removable,
  };
}

// ---------------------------------------------------------------- 工程扫描与索引

function walkSourceFiles(root: string, exts: Set<string>): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const absDir = relDir === '' ? root : join(root, relDir);
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = relDir === '' ? entry.name : relDir + '/' + entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!exts.has(extname(entry.name).toLowerCase())) continue;
      out.push(relPath);
    }
  }
  out.sort();
  return out;
}

export function loadLangConfig(lang: string): LangConfig {
  if (!existsSync(LANG_CONFIG_PATH)) throw new Error('找不到 adapters/languages.json：' + LANG_CONFIG_PATH);
  const all = JSON.parse(readFileSync(LANG_CONFIG_PATH, 'utf8')) as Record<string, LangConfig>;
  const cfg = all[lang];
  if (!cfg) throw new Error('未知语言：' + lang + '（可用：' + Object.keys(all).join(', ') + '）');
  return cfg;
}

export function scanProject(root: string, lang: string): ProjectIndex {
  const cfg = loadLangConfig(lang);
  const exts = new Set(cfg.extensions.map((item) => item.toLowerCase()));
  const rels = walkSourceFiles(root, exts);
  const files = new Map<string, FileInfo>();
  const byPkg = new Map<string, Map<string, string[]>>();
  const byQualified = new Map<string, string[]>();
  const byFileKey = new Map<string, string[]>();
  const packages = new Set<string>();
  const push = (map: Map<string, string[]>, key: string, rel: string): void => {
    const list = map.get(key);
    if (list) { if (!list.includes(rel)) list.push(rel); } else map.set(key, [rel]);
  };
  const isJvm = lang === 'jvm';
  for (const rel of rels) {
    let src: string;
    try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    const info = parseSource(rel, src, cfg, lang);
    files.set(rel, info);
    // js-ts 是路径导入，不需要 package/符号索引（也不该让同名导出互相干扰）
    if (!isJvm) continue;
    if (info.pkg) packages.add(info.pkg);
    let pkgMap = byPkg.get(info.pkg);
    if (!pkgMap) { pkgMap = new Map<string, string[]>(); byPkg.set(info.pkg, pkgMap); }
    const base = rel.split('/').pop() as string;
    const fileBase = base.slice(0, base.length - extname(base).length);
    if (info.pkg) push(byFileKey, info.pkg.replace(/\./g, '/') + '/' + fileBase, rel);
    for (const decl of info.decls) {
      if (decl.visibility === 'private') continue;
      push(pkgMap, decl.name, rel);
      if (info.pkg) push(byQualified, info.pkg + '.' + decl.name, rel);
    }
  }
  for (const nameMap of byPkg.values()) for (const list of nameMap.values()) list.sort();
  return { root, lang, cfg, files, byPkg, byQualified, byFileKey, packages, scanned: files.size, identCache: new Map() };
}

function chooseFile(rels: string[] | undefined, index: ProjectIndex, fromRel: string): string | null {
  if (!rels || rels.length === 0) return null;
  const prod = rels.filter((rel) => {
    const info = index.files.get(rel);
    return info !== undefined && !info.isTest;
  });
  if (prod.length === 0) return null;
  if (prod.length === 1) return prod[0];
  const fromPkg = index.files.get(fromRel)?.pkg;
  const samePkg = prod.filter((rel) => index.files.get(rel)?.pkg === fromPkg).sort();
  if (samePkg.length > 0) return samePkg[0];
  return prod.slice().sort()[0];
}

export interface Resolution {
  rel: string;
  how: 'symbol' | 'member' | 'file';
}

export function resolveImport(index: ProjectIndex, fqn: string, fromRel: string): Resolution | null {
  const direct = chooseFile(index.byQualified.get(fqn), index, fromRel);
  if (direct) return { rel: direct, how: 'symbol' };
  const parts = fqn.split('.');
  for (let k = parts.length - 1; k >= 1; k--) {
    const qual = parts.slice(0, k).join('.');
    const hit = chooseFile(index.byQualified.get(qual), index, fromRel);
    if (hit) return { rel: hit, how: 'member' };
  }
  const fileKey = parts.slice(0, -1).join('/') + '/' + parts[parts.length - 1];
  const byFile = chooseFile(index.byFileKey.get(fileKey), index, fromRel);
  if (byFile) return { rel: byFile, how: 'file' };
  return null;
}

function identifiersOf(index: ProjectIndex, rel: string): Set<string> {
  // 缓存挂在 index 上：同一个 root 重复抽取可以命中，换 root 不会读到别的工程的文件内容
  const cached = index.identCache.get(rel);
  if (cached) return cached;
  let src = '';
  try { src = readFileSync(join(index.root, rel), 'utf8'); } catch { /* 读不到按空处理 */ }
  const idents = new Set<string>();
  const code = stripCommentsAndStrings(src);
  let m: RegExpExecArray | null;
  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(code)) !== null) idents.add(m[0]);
  index.identCache.set(rel, idents);
  return idents;
}


// ---------------------------------------------------------------- js-ts（ESM / CJS）

const JS_RESOLVE_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

/** import 说明符去掉 ?query / #hash（Vite 风格），只用于文件解析。 */
function rawSpecifier(specifier: string): string {
  return specifier.replace(/[?#].*$/, '');
}

function posixDirname(rel: string): string {
  const parts = rel.split('/');
  parts.pop();
  return parts.join('/');
}

/** 归一化相对路径；越出工程根返回 null。 */
function normalizeRelPath(parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** 把一个「root 相对、无扩展名」的候选路径解析成工程内文件：精确 → 补扩展名 → .js/.ts 互换 → index.*。 */
function resolveCandidateFile(index: ProjectIndex, baseRel: string): string | null {
  if (baseRel.length === 0) return null;
  if (index.files.has(baseRel)) return baseRel;
  for (const ext of JS_RESOLVE_EXTS) if (index.files.has(baseRel + ext)) return baseRel + ext;
  if (/\.(js|jsx|mjs|cjs)$/.test(baseRel)) {
    const stem = baseRel.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const ext of JS_RESOLVE_EXTS) if (index.files.has(stem + ext)) return stem + ext;
  }
  for (const ext of JS_RESOLVE_EXTS) if (index.files.has(baseRel + '/index' + ext)) return baseRel + '/index' + ext;
  return null;
}

/** 相对路径解析：精确文件 → 补扩展名 → .js→.ts 互换 → index.*（按 TS/Node 习惯排序）。 */
export function resolveJsRelative(index: ProjectIndex, fromRel: string, specifier: string): string | null {
  const clean = rawSpecifier(specifier);
  if (!clean.startsWith('./') && !clean.startsWith('../')) return null;
  const base = normalizeRelPath([...posixDirname(fromRel).split('/'), ...clean.split('/')]);
  if (base === null) return null;
  return resolveCandidateFile(index, base);
}

// ---------------------------------------------------------------- js-ts 别名（tsconfig paths / vite resolve.alias）

export interface AliasMapping {
  /** 配置里的 alias 模式：'@'、'@/'、'@/*'、'@utils/*' 等 */
  alias: string;
  /** root 相对目标模板（可能含 '*'） */
  target: string;
  source: 'tsconfig' | 'vite';
  /** 配置文件名（root 相对） */
  config: string;
}

export interface AliasConfig {
  mappings: AliasMapping[];
  /** 实际读过的配置文件（root 相对，按读取顺序） */
  configs: string[];
}

export interface AliasHit {
  specifier: string;
  alias: string;
  /** alias 展开出的 root 相对候选路径 */
  target: string;
  fromFile: string;
  source: 'tsconfig' | 'vite';
}

const MAX_ALIAS_CONFIG_FILES = 16;

/** JSONC（tsconfig 常见注释 + 尾逗号）→ 可 JSON.parse 文本；字符串内容不动。 */
export function stripJsonc(text: string): string {
  const chars = [...text];
  let i = 0;
  const n = chars.length;
  while (i < n) {
    if (chars[i] === '"') {
      i++;
      while (i < n) {
        if (chars[i] === '\\') { i += 2; continue; }
        if (chars[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (chars[i] === '/' && chars[i + 1] === '/') {
      while (i < n && chars[i] !== '\n') { chars[i] = ' '; i++; }
      continue;
    }
    if (chars[i] === '/' && chars[i + 1] === '*') {
      chars[i] = ' '; chars[i + 1] = ' ';
      i += 2;
      while (i < n) {
        if (chars[i] === '*' && chars[i + 1] === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 2; break; }
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  // 去尾逗号（字符串外）
  i = 0;
  while (i < n) {
    if (chars[i] === '"') {
      i++;
      while (i < n) {
        if (chars[i] === '\\') { i += 2; continue; }
        if (chars[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (chars[i] === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(chars[j])) j++;
      if (j < n && (chars[j] === '}' || chars[j] === ']')) chars[i] = ' ';
    }
    i++;
  }
  return chars.join('');
}

function readJsoncFile(absPath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(absPath, 'utf8'))) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/** 把配置里的相对/根相对目标归一到 root 相对路径；越界返回 null。 */
function toRootRel(baseDirRel: string, candidate: string): string | null {
  const cleaned = candidate.replace(/\\/g, '/');
  if (cleaned.startsWith('/')) return normalizeRelPath(cleaned.split('/').filter((part) => part.length > 0));
  return normalizeRelPath([...baseDirRel.split('/').filter((part) => part.length > 0), ...cleaned.split('/')]);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 从 vite 配置里静态解析 alias 值（不 eval）：字符串 / fileURLToPath(new URL(...)) / path.resolve(__dirname, ...)。 */
function parseAliasTarget(raw: string): string | null {
  const text = raw.trim();
  const quoted = /^(['"])([^'"]*)\1$/.exec(text);
  if (quoted) return quoted[2];
  const fileUrl = /fileURLToPath\(\s*new\s+URL\(\s*(['"])([^'"]+)\1/.exec(text);
  if (fileUrl) return fileUrl[2];
  const newUrl = /new\s+URL\(\s*(['"])([^'"]+)\1/.exec(text);
  if (newUrl) return newUrl[2];
  const resolveCall = /\b(?:path\.)?resolve\(\s*__dirname\s*,\s*(['"])([^'"]+)\1/.exec(text);
  if (resolveCall) return resolveCall[2];
  return null; // 不猜
}

/** 取 openIndex 处 { 或 [ 的配对内容（跳过字符串）。 */
function balancedBody(text: string, openIndex: number): string | null {
  const open = text[openIndex];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let quote = '';
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** 按顶层逗号切分（括号/引号里的逗号不算）。 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function splitEntry(entry: string): { key: string; value: string } | null {
  let quote = '';
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (quote !== '') {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) { quote = ch; continue; }
    if (ch === ':') {
      let key = entry.slice(0, i).trim();
      const keyQuote = /^(['"])([^'"]*)\1$/.exec(key);
      if (keyQuote) key = keyQuote[2];
      return { key, value: entry.slice(i + 1).trim() };
    }
  }
  return null;
}

function unquote(value: string): string {
  const text = value.trim();
  const quoted = /^(['"])([^'"]*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

/** 静态解析 vite.config 的 resolve.alias（对象或数组写法）；解析不了的条目跳过，不猜。 */
function loadViteAliases(root: string): { aliases: { alias: string; target: string }[]; config: string | null } {
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs']) {
    const abs = join(root, name);
    if (!existsSync(abs)) continue;
    let raw = '';
    try { raw = readFileSync(abs, 'utf8'); } catch { return { aliases: [], config: null }; }
    const code = maskJsSource(raw, 'statements');
    const objectMatch = /\balias\s*:\s*\{/.exec(code);
    const arrayMatch = /\balias\s*:\s*\[/.exec(code);
    const aliases: { alias: string; target: string }[] = [];
    const configDir = posixDirname(name);
    if (objectMatch) {
      const openIndex = code.indexOf('{', objectMatch.index);
      const body = balancedBody(code, openIndex);
      if (body !== null) {
        for (const entry of splitTopLevel(body)) {
          const pair = splitEntry(entry);
          if (pair === null) continue;
          const target = parseAliasTarget(pair.value);
          if (target === null) continue;
          const targetRel = toRootRel(configDir, target);
          if (targetRel === null) continue;
          aliases.push({ alias: pair.key, target: targetRel });
        }
      }
    } else if (arrayMatch) {
      const openIndex = code.indexOf('[', arrayMatch.index);
      const body = balancedBody(code, openIndex);
      if (body !== null) {
        for (const entry of splitTopLevel(body)) {
          const objectOpen = entry.indexOf('{');
          if (objectOpen === -1) continue;
          const objectBody = balancedBody(entry, objectOpen);
          if (objectBody === null) continue;
          const findMatch = /\bfind\s*:\s*(['"])([^'"]+)\1/.exec(objectBody);
          const replacementMatch = /\breplacement\s*:\s*([\s\S]+)$/.exec(objectBody);
          if (!findMatch || !replacementMatch) continue;
          const target = parseAliasTarget(replacementMatch[1]);
          if (target === null) continue;
          const targetRel = toRootRel(configDir, target);
          if (targetRel === null) continue;
          aliases.push({ alias: findMatch[2], target: targetRel });
        }
      }
    }
    return { aliases, config: name };
  }
  return { aliases: [], config: null };
}

/** 读 --root 下的 tsconfig/jsconfig（含 references 与相对 extends）与 vite 配置，得到 alias 映射。 */
export function loadAliasConfig(root: string): AliasConfig {
  const mappings: AliasMapping[] = [];
  const configs: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) if (existsSync(join(root, name))) queue.push(name);
  while (queue.length > 0 && configs.length < MAX_ALIAS_CONFIG_FILES) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const json = readJsoncFile(join(root, rel));
    if (json === null) continue;
    configs.push(rel);
    const dir = posixDirname(rel);
    // extends：只跟相对路径（包名在 node_modules 里，不猜）
    const extendsValue = json.extends;
    const extendsList = Array.isArray(extendsValue) ? extendsValue : [extendsValue];
    for (const item of extendsList) {
      if (typeof item !== 'string') continue;
      if (!item.startsWith('./') && !item.startsWith('../')) continue;
      const target = item.endsWith('.json') ? item : item + '.json';
      const norm = toRootRel(dir, target);
      if (norm !== null) queue.push(norm);
    }
    // references（solution 风格：实际 paths 在子 config 里）
    const references = json.references;
    if (Array.isArray(references)) {
      for (const ref of references) {
        if (ref === null || typeof ref !== 'object') continue;
        const pathValue = asString((ref as Record<string, unknown>).path);
        if (pathValue === null) continue;
        const target = pathValue.endsWith('.json') ? pathValue : pathValue + '/tsconfig.json';
        const norm = toRootRel(dir, target);
        if (norm !== null) queue.push(norm);
      }
    }
    const compilerOptions = json.compilerOptions;
    if (compilerOptions !== null && typeof compilerOptions === 'object' && !Array.isArray(compilerOptions)) {
      const options = compilerOptions as Record<string, unknown>;
      const paths = options.paths;
      if (paths !== null && typeof paths === 'object' && !Array.isArray(paths)) {
        const baseUrlRaw = asString(options.baseUrl);
        const baseDir = baseUrlRaw !== null ? toRootRel(dir, baseUrlRaw) : (dir.length > 0 ? dir : '');
        if (baseDir !== null) {
          for (const alias of Object.keys(paths as Record<string, unknown>)) {
            const targets = (paths as Record<string, unknown>)[alias];
            if (!Array.isArray(targets)) continue;
            for (const item of targets) {
              if (typeof item !== 'string') continue;
              const targetRel = toRootRel(baseDir, item);
              if (targetRel === null) continue;
              mappings.push({ alias, target: targetRel, source: 'tsconfig', config: rel });
            }
          }
        }
      }
    }
  }
  const vite = loadViteAliases(root);
  if (vite.config !== null) {
    configs.push(vite.config);
    for (const item of vite.aliases) mappings.push({ alias: item.alias, target: item.target, source: 'vite', config: vite.config });
  }
  return { mappings, configs };
}

export interface AliasResolution {
  rel: string;
  alias: string;
  target: string;
  source: 'tsconfig' | 'vite';
}

export interface AliasMiss {
  alias: string;
  target: string;
  source: 'tsconfig' | 'vite';
}

/** 把 alias 映射展开成 root 相对候选路径；不匹配返回 null。 */
function expandAlias(mapping: AliasMapping, specifier: string): string | null {
  const alias = mapping.alias;
  if (alias.length === 0) return null;
  if (alias.includes('*')) {
    const star = alias.indexOf('*');
    const prefix = alias.slice(0, star);
    const suffix = alias.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
    if (specifier.length < prefix.length + suffix.length) return null;
    const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
    const target = mapping.target.includes('*') ? mapping.target.replace('*', middle) : mapping.target + middle;
    return normalizeRelPath(target.split('/'));
  }
  const aliasBase = alias.endsWith('/') ? alias.slice(0, -1) : alias;
  if (aliasBase.length === 0) return null;
  if (specifier === aliasBase) return normalizeRelPath(mapping.target.split('/'));
  if (!specifier.startsWith(aliasBase + '/')) return null;
  const rest = specifier.slice(aliasBase.length);
  return normalizeRelPath([...mapping.target.split('/').filter((part) => part.length > 0), ...rest.split('/')]);
}

/** 解析非相对 import 的别名：命中并找到文件返回 hit；命中但断链返回 miss；不匹配返回 null。 */
export function resolveJsAlias(
  index: ProjectIndex,
  specifier: string,
  config: AliasConfig,
): { hit: AliasResolution } | { miss: AliasMiss } | null {
  const clean = rawSpecifier(specifier);
  if (clean.startsWith('./') || clean.startsWith('../')) return null;
  const candidates: { mapping: AliasMapping; expanded: string; specificity: number }[] = [];
  for (const mapping of config.mappings) {
    const expanded = expandAlias(mapping, clean);
    if (expanded === null) continue;
    // 精确 alias 优先于通配；通配里更长的前缀优先（数组顺序作为同分时的稳定次序）
    const specificity = mapping.alias.includes('*') ? mapping.alias.replace('*', '').length : 1000 + mapping.alias.length;
    candidates.push({ mapping, expanded, specificity });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.specificity - a.specificity);
  for (const candidate of candidates) {
    const rel = resolveCandidateFile(index, candidate.expanded);
    if (rel !== null) {
      return { hit: { rel, alias: candidate.mapping.alias, target: candidate.expanded, source: candidate.mapping.source } };
    }
  }
  // 命中了 alias 但工程内没这个文件：报断链（alias + 展开后的候选路径），不猜
  const first = candidates[0];
  return { miss: { alias: first.mapping.alias, target: first.expanded, source: first.mapping.source } };
}

/** js-ts 预处理：注释清空（保留换行）。
 *  mode 'statements'：字符串/模板原样保留 —— 用来抓 import 说明符与平台正则（from 'react-native'）。
 *  mode 'signatures'：字符串内容、模板内容、正则字面量清空 —— 用来数花括号、抽签名。
 */
export function maskJsSource(src: string, mode: 'statements' | 'signatures'): string {
  const out: string[] = new Array(src.length);
  for (let k = 0; k < src.length; k++) out[k] = src[k];
  const n = src.length;
  const blank = (k: number): void => {
    if (k < n && src[k] !== '\n' && src[k] !== '\r') out[k] = ' ';
  };
  const REGEX_PREV = '(,=:[!&|?{};+-*%^~<>';
  const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await', 'throw', 'new']);
  let prevSignificant = '';
  let lastWord = '';
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') { blank(i); blank(i + 1); i += 2; break; }
        blank(i); i++;
      }
      continue;
    }
    if (ch === '/' && (prevSignificant === '' || REGEX_PREV.includes(prevSignificant) || (lastWord !== '' && REGEX_WORDS.has(lastWord)))) {
      // 正则字面量：内容清空（两种模式都清，避免花括号/引号误判）
      blank(i); i++;
      let inClass = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { blank(i); i++; break; }
        blank(i); i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) { blank(i); i++; }
      prevSignificant = 'V';
      lastWord = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === String.fromCharCode(96)) {
      const quote = ch;
      // 定界符保留（签名里显示成成对引号，不丢「这里有个字符串」的信息），内容清空以保花括号平衡
      i++;
      while (i < n) {
        if (src[i] === '\\') { if (mode === 'signatures') { blank(i); blank(i + 1); } i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (mode === 'signatures') blank(i);
        i++;
      }
      prevSignificant = 'V';
      lastWord = '';
      continue;
    }
    if (!/\s/.test(ch)) {
      prevSignificant = ch;
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j > 0 && /[A-Za-z0-9_$]/.test(src[j - 1])) j--;
        let k = i + 1;
        while (k < n && /[A-Za-z0-9_$]/.test(src[k])) k++;
        lastWord = src.slice(j, k);
      }
    }
    i++;
  }
  return out.join('');
}

function namedSpecifiers(text: string): string[] {
  const names: string[] = [];
  for (const part of text.split(',')) {
    const spec = part.trim();
    if (spec.length === 0) continue;
    const left = spec.split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(left)) names.push(left);
  }
  return names;
}

function clauseMeta(clause: string): { names: string[]; defaultImport: boolean; star: boolean } {
  const text = clause.trim();
  const braceMatch = /\{([\s\S]*)\}/.exec(text);
  const outside = braceMatch ? text.replace(braceMatch[0], ' ') : text;
  const outsideTrimmed = outside.replace(/^type\s+/, '').trim();
  let star = false;
  let defaultImport = false;
  if (/^\*/.test(outsideTrimmed) || /\*\s*as\b/.test(outsideTrimmed)) star = true;
  else if (/^[A-Za-z_$][A-Za-z0-9_$]*/.test(outsideTrimmed)) defaultImport = true;
  return { names: braceMatch ? namedSpecifiers(braceMatch[1]) : [], defaultImport, star };
}

/** 抓 ESM import / export-from / 动态 import() / CJS require() 的模块说明符。 */
export function parseJsTsImports(src: string, maskedCode?: string): ImportRef[] {
  const code = maskedCode ?? maskJsSource(src, 'statements');
  const starts = lineStarts(code);
  const merged = new Map<string, ImportRef>();
  const record = (specifier: string, offset: number, meta: { names: string[]; defaultImport: boolean; star: boolean }): void => {
    const key = rawSpecifier(specifier);
    if (key.length === 0) return;
    const existing = merged.get(key);
    if (existing) {
      existing.names = [...new Set([...(existing.names ?? []), ...meta.names])].sort();
      existing.defaultImport = Boolean(existing.defaultImport || meta.defaultImport);
      existing.star = existing.star || meta.star;
      return;
    }
    merged.set(key, {
      fqn: specifier,
      star: meta.star,
      alias: null,
      line: lineAt(starts, offset),
      names: meta.names.slice().sort(),
      defaultImport: meta.defaultImport,
    });
  };
  let m: RegExpExecArray | null;
  const staticRe = /\bimport\s+(?:type\s+)?([^;'"\x60]{0,400}?)\bfrom\s*(['"])([^'"\r\n]+)\2/g;
  while ((m = staticRe.exec(code)) !== null) record(m[3], m.index, clauseMeta(m[1] ?? ''));
  const sideRe = /\bimport\s*(['"])([^'"\r\n]+)\1/g;
  while ((m = sideRe.exec(code)) !== null) record(m[2], m.index, { names: [], defaultImport: false, star: false });
  const dynamicRe = /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g;
  while ((m = dynamicRe.exec(code)) !== null) record(m[2], m.index, { names: [], defaultImport: false, star: true });
  const requireRe = /\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g;
  while ((m = requireRe.exec(code)) !== null) record(m[2], m.index, { names: [], defaultImport: false, star: false });
  const reExportRe = /\bexport\s+(?:type\s+)?(?:\*|\{([\s\S]{0,400}?)\})\s*(?:as\s+[A-Za-z_$][A-Za-z0-9_$]*\s*)?from\s*(['"])([^'"\r\n]+)\2/g;
  while ((m = reExportRe.exec(code)) !== null) {
    record(m[3], m.index, { names: m[1] ? namedSpecifiers(m[1]) : [], defaultImport: false, star: !m[1] });
  }
  return [...merged.values()].sort((a, b) => a.line - b.line || a.fqn.localeCompare(b.fqn));
}

const TS_EXPORT_RE = /^export\s+(default\s+)?(declare\s+)?(async\s+)?(abstract\s+)?(function\s*\*?|class|interface|type|const|let|var|enum)\b([\s\S]*)$/;

interface TsDeclStart { kind: string }

/** 判断一行是否某个导出声明的起点；export {…} / export * 这类再导出跳过。 */
function parseTsExportStart(line: string): TsDeclStart | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('export')) return null;
  const m = TS_EXPORT_RE.exec(trimmed);
  if (m) {
    const keyword = m[5];
    const rest = (m[6] ?? '').trimStart();
    if (keyword === 'type' && (rest.startsWith('{') || rest.startsWith('*'))) return null;
    const kind = keyword.startsWith('function') ? 'fun'
      : keyword === 'class' ? 'class'
        : keyword === 'interface' ? 'interface'
          : keyword === 'type' ? 'typealias'
            : keyword === 'enum' ? 'enum'
              : keyword === 'const' ? 'val'
                : 'var';
    return { kind };
  }
  // export default <表达式>（类/函数之外的默认导出）
  if (/^export\s+default\b/.test(trimmed)) return { kind: 'val' };
  return null;
}

function tsDeclName(line: string): string | null {
  const trimmed = line.trim();
  const keyworded = /(?:function\s*\*?|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
  if (keyworded) return keyworded[1];
  const defaulted = /^export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
  return defaulted ? defaulted[1] : null;
}

export function parseJsTsExports(src: string): Decl[] {
  const code = maskJsSource(src, 'signatures');
  const lines = code.split('\n');
  const decls: Decl[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (braceDepth === 0 && parenDepth === 0) {
      const start = parseTsExportStart(line);
      if (start !== null) {
        const name = tsDeclName(line);
        if (name !== null && name.length > 0) {
          decls.push({ name, kind: start.kind as Decl['kind'], line: li + 1, visibility: 'public' });
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
  return decls;
}

const TS_SIGNATURE_MAX_CHARS = 2000;
const TS_HEADER_SCAN_LIMIT = 8000;

/** 签名归一化：多行折叠成单行、空字符串字面量保留成 ''/"", 超长截断。 */
function normalizeHeader(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/"[ \t]*"/g, '""').replace(/'[ \t]*'/g, "''");
  // 注释/换行被清空后常见 "(" 后多空格、")" 前多空格、", )" 这类，收干净一点
  text = text.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/,\s*\)/g, ')');
  text = text.replace(/\s+get\(\)$/, '').replace(/\s+set\([^)]*\)$/, '');
  if (text.length > TS_SIGNATURE_MAX_CHARS) text = text.slice(0, TS_SIGNATURE_MAX_CHARS).trimEnd() + ' …';
  return text;
}

/** 读 TS 声明头部（不带函数体）：函数/类/接口/枚举到 { 为止；type 吃完整类型表达式；const 保留箭头参数。 */
function readTsHeader(code: string, start: number, kind: string): string {
  let paren = 0;
  let brace = 0;
  let angle = 0;
  let arrow = false;
  const limit = Math.min(code.length, start + TS_HEADER_SCAN_LIMIT);
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
    if (ch === '=' && paren === 0 && brace === 0) {
      if (arrow && code[i + 1] === '>') break;
      if (kind === 'typealias') { continue; }
      const rest = code.slice(i + 1, i + 200).trimStart();
      if ((kind === 'val' || kind === 'var') && (rest.startsWith('(') || rest.startsWith('<') || rest.startsWith('function') || rest.startsWith('async'))) {
        arrow = true;
        continue;
      }
      if (rest.startsWith('>')) { arrow = true; continue; }
      break;
    }
    if (ch === ';' && paren === 0 && brace === 0) break;
    if (ch === '<' && paren === 0 && brace === 0) { angle++; continue; }
    if (ch === '>' && paren === 0 && brace === 0 && angle > 0) { angle--; continue; }
    if (ch === '\n' && paren === 0 && brace === 0 && angle === 0) {
      let j = i + 1;
      while (j < limit && (code[j] === ' ' || code[j] === '\t' || code[j] === '\r' || code[j] === '\n')) j++;
      const next = j < limit ? code[j] : '';
      if (kind === 'typealias' && (next === '|' || next === '&' || next === '=' || next === '<' || next === '.' || next === '[' || next === '(')) continue;
      break;
    }
  }
  return code.slice(start, i);
}

/** 导出签名（不带函数体）：export function/class/interface/type/const/let/var/enum + 默认导出。 */
export function extractJsTsSignatures(src: string): Signature[] {
  const code = maskJsSource(src, 'signatures');
  const lines = code.split('\n');
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) { offsets.push(acc); acc += line.length + 1; }
  const signatures: Signature[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (braceDepth === 0 && parenDepth === 0) {
      const start = parseTsExportStart(line);
      if (start !== null) {
        const text = normalizeHeader(readTsHeader(code, offsets[li], start.kind));
        if (text.length > 0) signatures.push({ text, line: li + 1, kind: start.kind, member: false });
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
  return signatures;
}

/** 从命中的行里取模块说明符（import-from / side-effect import / require），用于 boundary 的证据。 */
function jsImportSpecifier(line: string): string | null {
  const from = /\bfrom\s*(['"])([^'"\r\n]+)\1/.exec(line);
  if (from) return from[2];
  const requireHit = /\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/.exec(line);
  if (requireHit) return requireHit[2];
  const bare = /^[ \t]*import\s*(['"])([^'"\r\n]+)\1/.exec(line);
  return bare ? bare[2] : null;
}

/** js-ts 耦合判定：注释已清空、字符串保留；命中 platformPatterns 即 boundary。 */
export function evaluateCouplingJs(code: string, cfg: LangConfig): { coupled: boolean; hits: PlatformHit[] } {
  const lines = code.split('\n');
  const patterns = cfg.platformPatterns.map((pattern) => new RegExp(pattern));
  const hits: PlatformHit[] = [];
  for (let pi = 0; pi < patterns.length; pi++) {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.trim().length === 0) continue;
      if (!patterns[pi].test(line)) continue;
      hits.push({ line: li + 1, text: line.trim(), patternIndex: pi, fqn: jsImportSpecifier(line) });
    }
  }
  return { coupled: hits.length > 0, hits };
}

function parseJsTsSource(rel: string, src: string, cfg: LangConfig): FileInfo {
  const statements = maskJsSource(src, 'statements');
  const coupling = evaluateCouplingJs(statements, cfg);
  return {
    rel,
    pkg: '',
    imports: parseJsTsImports(src, statements),
    decls: parseJsTsExports(src),
    loc: countLines(src),
    isTest: isTestPath(rel),
    coupled: coupling.coupled,
    platformHits: coupling.hits,
    removable: [],
  };
}

// ---------------------------------------------------------------- 闭包

function sortVias(set: Set<Via>): Via[] {
  const order: Via[] = ['entry', 'import', 'star-import', 'same-package', 'package-peer'];
  return order.filter((via) => set.has(via));
}

export function extractClosure(index: ProjectIndex, entryRel: string, options: ExtractOptions): ClosureReport {
  // package 补全只对 jvm 有意义（js-ts 是路径导入，没有同包隐式引用）
  const packageComplete = options.packageComplete !== false && index.lang === 'jvm';
  const entryInfo = index.files.get(entryRel);
  if (!entryInfo) throw new Error('entry 不在工程索引里：' + entryRel + '（检查 --root 与扩展名）');
  if (!entryInfo.pkg && index.lang === 'jvm') throw new Error('无法解析 entry：缺少 package 声明 —— ' + entryRel);

  const rows = new Map<string, FileRow>();
  const vias = new Map<string, Set<Via>>();
  const edges: { from: string; to: string; via: Via; symbol: string | null }[] = [];
  const unresolved: UnresolvedRow[] = [];
  const unresolvedSeen = new Set<string>();
  const removableImports: { symbol: string; fromFile: string; usage: 'annotation-only' | 'unused' }[] = [];
  const queue: string[] = [entryRel];
  const visited = new Set<string>();
  const completedPkgs = new Set<string>();
  const aliasesEnabled = index.lang === 'js-ts' && options.aliases !== false;
  const aliasConfig: AliasConfig = aliasesEnabled ? loadAliasConfig(index.root) : { mappings: [], configs: [] };
  const aliasHits: AliasHit[] = [];

  const addVia = (rel: string, via: Via): void => {
    const set = vias.get(rel) ?? new Set<Via>();
    set.add(via);
    vias.set(rel, set);
  };
  addVia(entryRel, 'entry');

  const addUnresolved = (row: UnresolvedRow): void => {
    const key = row.fromFile + '\u0000' + row.symbol;
    if (unresolvedSeen.has(key)) return;
    unresolvedSeen.add(key);
    unresolved.push(row);
  };

  const isInternalLike = (fqn: string, fromFile: string): boolean => {
    const parts = fqn.split('.');
    for (let k = parts.length - 1; k >= 2; k--) {
      if (index.packages.has(parts.slice(0, k).join('.'))) return true;
    }
    const fromPkg = index.files.get(fromFile)?.pkg ?? '';
    const fromParts = fromPkg.split('.');
    if (fromParts.length >= 3) {
      const head = fromParts.slice(0, 3).join('.');
      if (fqn === head || fqn.startsWith(head + '.')) return true;
    }
    return false;
  };

  const directDeps = (rel: string, info: FileInfo): Dep[] => {
    const deps: Dep[] = [];
    const seen = new Set<string>();
    const add = (target: string, via: Via, symbol: string | null): void => {
      if (target === rel) return;
      const key = target + '\u0000' + via + '\u0000' + (symbol ?? '');
      if (seen.has(key)) return;
      seen.add(key);
      deps.push({ rel: target, via, symbol });
    };
    if (index.lang === 'js-ts') {
      // js-ts：相对路径解析；非相对按契约归 external（含路径别名 / npm 包）
      for (const imp of info.imports) {
        const target = resolveJsRelative(index, rel, imp.fqn);
        if (target !== null) {
          const names = imp.names ?? [];
          if (names.length > 0) {
            for (const name of names) add(target, 'import', name);
          } else if (imp.star) {
            add(target, 'import', '*');
          } else if (imp.defaultImport) {
            add(target, 'import', 'default');
          } else {
            add(target, 'import', null);
          }
          continue;
        }
        if (imp.fqn.startsWith('./') || imp.fqn.startsWith('../')) {
          addUnresolved({
            symbol: imp.fqn, fromFile: rel, kind: 'internal',
            reason: '相对导入未解析到工程内文件（扩展名或 index.* 未命中）',
          });
          continue;
        }
        const aliasResult = aliasesEnabled ? resolveJsAlias(index, imp.fqn, aliasConfig) : null;
        if (aliasResult !== null && 'hit' in aliasResult) {
          const hit = aliasResult.hit;
          aliasHits.push({ specifier: imp.fqn, alias: hit.alias, target: hit.target, fromFile: rel, source: hit.source });
          const names = imp.names ?? [];
          if (names.length > 0) {
            for (const name of names) add(hit.rel, 'import', name);
          } else if (imp.star) {
            add(hit.rel, 'import', '*');
          } else if (imp.defaultImport) {
            add(hit.rel, 'import', 'default');
          } else {
            add(hit.rel, 'import', null);
          }
        } else if (aliasResult !== null && 'miss' in aliasResult) {
          const miss = aliasResult.miss;
          addUnresolved({
            symbol: imp.fqn, fromFile: rel, kind: 'external',
            reason: 'alias 断链：' + miss.alias + ' → ' + miss.target + '（' + miss.source + '）未找到工程内文件',
            alias: miss.alias, target: miss.target,
          });
        } else {
          addUnresolved({
            symbol: imp.fqn, fromFile: rel, kind: 'external',
            reason: aliasesEnabled ? '外部依赖（非相对 import，未命中任何 alias）' : '外部依赖（非相对 import；alias 解析已关闭）',
          });
        }
      }
      return deps;
    }
    const idents = identifiersOf(index, rel);
    for (const imp of info.imports) {
      if (imp.star) {
        const pkg = imp.fqn.slice(0, -2);
        const names = index.byPkg.get(pkg);
        if (names) {
          const used = [...names.keys()].filter((name) => idents.has(name)).sort();
          let expanded = 0;
          for (const name of used) {
            const target = chooseFile(names.get(name), index, rel);
            if (target && target !== rel) { add(target, 'star-import', name); expanded++; }
          }
          if (expanded === 0) {
            addUnresolved({
              symbol: imp.fqn, fromFile: rel, kind: 'internal',
              reason: 'star import 未展开出任何被使用的工程内符号（' + pkg + '）',
            });
          }
          continue;
        }
        const kind = isInternalLike(pkg + '.X', rel) ? 'internal' : 'external';
        addUnresolved({
          symbol: imp.fqn, fromFile: rel, kind,
          reason: kind === 'internal' ? '工程内包未收录（' + pkg + '）' : '外部依赖（' + pkg + '）',
        });
        continue;
      }
      const resolution = resolveImport(index, imp.fqn, rel);
      if (resolution) {
        add(resolution.rel, 'import', imp.fqn.split('.').pop() as string);
        continue;
      }
      if (info.removable.some((item) => item.symbol === imp.fqn)) continue;
      const kind = isInternalLike(imp.fqn, rel) ? 'internal' : 'external';
      addUnresolved({
        symbol: imp.fqn, fromFile: rel, kind,
        reason: kind === 'internal'
          ? '工程内包存在，但符号未在索引中找到（可解析的内部符号不应出现在这里）'
          : '外部依赖（' + imp.fqn.split('.').slice(0, 2).join('.') + '）',
      });
    }
    const ownNames = new Set(info.decls.map((decl) => decl.name));
    const samePkg = index.byPkg.get(info.pkg);
    if (samePkg) {
      for (const name of [...samePkg.keys()].sort()) {
        if (ownNames.has(name)) continue;
        if (!idents.has(name)) continue;
        const target = chooseFile(samePkg.get(name), index, rel);
        if (target) add(target, 'same-package', name);
      }
    }
    return deps;
  };

  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (visited.has(rel)) continue;
    visited.add(rel);
    const info = index.files.get(rel);
    if (!info) continue;
    const isEntry = rel === entryRel;
    // 测试源集文件角色记 test（即使它是 entry，也仍要展开依赖，便于看清测试入口的引用面）
    const role: FileRow['role'] = info.isTest
      ? 'test'
      : (info.coupled && !isEntry ? 'coupled' : 'include');
    rows.set(rel, { path: rel, loc: info.loc, role, coupled: info.coupled, pkg: info.pkg, vias: [] });
    const descend = role === 'include' || (role === 'test' && isEntry);
    if (!descend) continue;

    for (const item of info.removable) removableImports.push({ symbol: item.symbol, fromFile: rel, usage: item.usage });
    const deps = directDeps(rel, info);
    for (const dep of deps) {
      edges.push({ from: rel, to: dep.rel, via: dep.via, symbol: dep.symbol });
      addVia(dep.rel, dep.via);
      if (!visited.has(dep.rel)) queue.push(dep.rel);
    }
    if (packageComplete) {
      const pkgs = [info.pkg];
      for (const dep of deps) {
        const depInfo = index.files.get(dep.rel);
        if (depInfo && !depInfo.coupled && !depInfo.isTest) pkgs.push(depInfo.pkg);
      }
      for (const pkg of pkgs) {
        if (completedPkgs.has(pkg)) continue;
        completedPkgs.add(pkg);
        const names = index.byPkg.get(pkg);
        if (!names) continue;
        for (const name of [...names.keys()].sort()) {
          for (const peer of names.get(name) as string[]) {
            const peerInfo = index.files.get(peer);
            if (!peerInfo || peerInfo.coupled || peerInfo.isTest) continue;
            if (visited.has(peer)) continue;
            addVia(peer, 'package-peer');
            queue.push(peer);
          }
        }
      }
    }
  }

  const files = [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const row of files) row.vias = sortVias(vias.get(row.path) ?? new Set<Via>());

  const boundaries: BoundaryRow[] = [];
  for (const row of files) {
    if (row.role !== 'coupled') continue;
    const info = index.files.get(row.path) as FileInfo;
    const removableSet = new Set(info.removable.map((item) => item.symbol));
    const hardHits = info.platformHits.filter((hit) => hit.fqn === null || !removableSet.has(hit.fqn));
    const evidence = [...new Set(hardHits.map((hit) => hit.text))].sort();
    const patterns = [...new Set(hardHits.map((hit) => hit.patternIndex))].sort((a, b) => a - b);
    const fqns = [...new Set(hardHits.map((hit) => hit.fqn).filter((fqn): fqn is string => fqn !== null))].sort();
    const nonImport = hardHits.filter((hit) => hit.fqn === null);
    const symbolNames = new Set<string>();
    const byFile = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (edge.to !== row.path || edge.symbol === null) continue;
      symbolNames.add(edge.symbol);
      const set = byFile.get(edge.from) ?? new Set<string>();
      set.add(edge.symbol);
      byFile.set(edge.from, set);
    }
    const symbols = info.decls.filter((decl) => symbolNames.has(decl.name)).sort((a, b) => a.line - b.line);
    const declarations: BoundaryDeclaration[] = info.decls
      .filter((decl) => decl.visibility === 'public')
      .sort((a, b) => a.line - b.line)
      .map((decl) => ({ name: decl.name, kind: decl.kind, line: decl.line, needed: symbolNames.has(decl.name) }));
    const neededBy: { file: string; symbols: string[] }[] = [];
    for (const from of [...byFile.keys()].sort()) {
      neededBy.push({ file: from, symbols: [...(byFile.get(from) as Set<string>)].sort() });
    }
    const reasonParts: string[] = [];
    if (fqns.length > 0) reasonParts.push('平台 import：' + fqns.join(', '));
    if (nonImport.length > 0) reasonParts.push('平台 API 命中 ' + nonImport.length + ' 处');
    reasonParts.push('platformPatterns[' + patterns.join(',') + ']（adapters/languages.json#' + index.lang + '）');
    boundaries.push({ file: row.path, reason: reasonParts.join('；'), evidence, patterns, symbols, declarations, neededBy });
  }
  boundaries.sort((a, b) => a.file.localeCompare(b.file));

  const manualExtractions: ManualExtractionRow[] = [];
  for (const boundary of boundaries) {
    for (const decl of boundary.symbols) {
      const neededBy: string[] = [];
      for (const item of boundary.neededBy) if (item.symbols.includes(decl.name)) neededBy.push(item.file);
      manualExtractions.push({
        symbol: decl.name,
        kind: decl.kind,
        declaredIn: boundary.file,
        neededBy: neededBy.sort(),
        reason: '闭包需要该声明，但它声明在耦合文件（boundary）里。按 adapters/' + index.lang + '.md，把它抽成纯逻辑模块后即可 include。',
      });
    }
  }
  manualExtractions.sort((a, b) => (a.symbol + a.declaredIn).localeCompare(b.symbol + b.declaredIn));

  unresolved.sort((a, b) => (a.fromFile + '\u0000' + a.symbol).localeCompare(b.fromFile + '\u0000' + b.symbol));
  removableImports.sort((a, b) => (a.fromFile + '\u0000' + a.symbol).localeCompare(b.fromFile + '\u0000' + b.symbol));

  const include = files.filter((row) => row.role === 'include');
  const coupledRows = files.filter((row) => row.role === 'coupled');
  const testRows = files.filter((row) => row.role === 'test');
  const totals = {
    files: files.length,
    loc: files.reduce((sum, row) => sum + row.loc, 0),
    include: include.length,
    coupled: coupledRows.length,
    test: testRows.length,
    includeLoc: include.reduce((sum, row) => sum + row.loc, 0),
    coupledLoc: coupledRows.reduce((sum, row) => sum + row.loc, 0),
  };

  return {
    entry: entryRel,
    entryPackage: entryInfo.pkg,
    root: index.root,
    lang: index.lang,
    packageComplete,
    files,
    totals,
    boundaries,
    unresolved,
    removableImports,
    manualExtractions,
    aliasesEnabled,
    aliases: aliasHits.slice().sort((a, b) => (a.fromFile + '\u0000' + a.specifier).localeCompare(b.fromFile + '\u0000' + b.specifier)),
    aliasConfigs: aliasConfig.configs.slice(),
    scannedFiles: index.scanned,
  };
}

// ---------------------------------------------------------------- CLI

const USAGE = [
  'extract-closure —— 从 entry 抽 JVM（Kotlin/Java）最小可编译依赖闭包（流水线 ②）',
  '',
  '用法：',
  '  node cli/extract-closure.ts --root <project> --entry <file.kt|.java> [--lang jvm]',
  '       [--out <dir>] [--report <path.json>] [--json] [--no-package-complete]',
  '',
  '参数：',
  '  --root <dir>       必填，工程根目录（全工程扫描一次，用于建 package/import/声明索引）',
  '  --entry <file>     必填，闭包入口（相对 --root 或绝对路径），.kt/.java',
  '  --lang <id>        语言适配器：jvm（.kt/.java，默认）/ js-ts（.js/.jsx/.ts/.tsx/.mjs/.cjs）',
  '  --out <dir>        把 include 文件按原相对路径复制到该目录。默认允许落在 --root 内的',
  '                     安全子目录（.refs/、out/、dist/、build/）；其它子目录需 --allow-out-in-root；',
  '                     不能等于 --root 或作为 --root 的父目录。会按目录里的',
  '                     .extract-closure-manifest.json 清理上次写过、本次不再 include 的旧文件；',
  '                     没有清单时不动任何文件，也不删非本工具写的文件',
  '  --allow-out-in-root  允许 --out 落在 --root 内的任意非源码子目录（默认只允许 .refs/out/dist/build；',
  '                     已有源码文件（.kt/.java/.ts/...）的目录仍拒绝，fail-closed）',
  '  --force            兼容旧用法：等价于 --allow-out-in-root 并打警告（仅调试）',
  '  --report <file>    把 JSON 报告写到文件',
  '  --json             把 JSON 报告打到 stdout（同时给 --report 时两者一致）',
  '  --no-package-complete  关闭 package 补全，只保留严格引用闭包（更小，可能缺同包符号）',
  '  --no-alias         js-ts：关闭 tsconfig paths / vite resolve.alias 解析（@/ 等别名回到 external）',
  '  --help             显示本帮助（退出码 0）',
  '',
  'js-ts 规则：',
  '  ESM import / export ... from / 动态 import() / CJS require() 都会解析；相对路径按',
  '  「精确文件 → 补扩展名 → .js/.ts 互换 → index.*」找工程内文件；非相对 import（npm 包、',
  '  vite 别名 @/）先按 tsconfig.json/jsconfig.json 的 baseUrl+paths、再按 vite.config 的 resolve.alias',
  '  解析（静态读配置，不 eval）；仍解析不到才归 external，alias 断链会单独标注 alias/target。',
  '  命中 adapters/languages.json#js-ts.platformPatterns → coupled boundary。',
  '  js-ts 没有 package，报告中 entryPackage 为空，package 补全不生效。',
  '',
  '分类：',
  '  include   闭包内纯逻辑文件（--out 复制这些）',
  '  coupled   命中 adapters/languages.json#jvm.platformPatterns，记为 boundary，不再深入、不复制',
  '  test      测试源集，不进闭包',
  '  平台 import 只用于注解（如 @Stable）或完全未使用 → 记入 removableImports，按 adapters/jvm.md 去掉即可',
  '',
  '报告 JSON：',
  '  {entry, entryPackage, root, lang, packageComplete, scannedFiles,',
  '   files[{path,loc,role,coupled,pkg,vias}], totals{files,loc,include,coupled,test,includeLoc,coupledLoc},',
  '   boundaries[{file,reason,evidence,patterns,symbols,declarations,neededBy}],',
  '   unresolved[{symbol,fromFile,reason,kind}], removableImports[{symbol,fromFile,usage}],',
  '   manualExtractions[{symbol,kind,declaredIn,neededBy,reason}],',
  '   aliasesEnabled, aliases[{specifier,alias,target,fromFile,source}], aliasConfigs[]}',
  '  boundaries[].symbols + manualExtractions 就是「手工抽取模块」的来源映射：',
  '  耦合文件里被闭包需要的每个声明，都能定位到 声明名 + 来源文件 + 谁需要它。',
  '',
  '退出码：0 成功（unresolved 非空仍为 0，但会报告）；1 entry 不存在/无法解析；2 参数错误',
  '',
  '限制：不做类型推断；不解析字符串字面量内的符号；Kotlin 只展开带花括号的模板表达式；不解析 inline FQN。',
  '',
  '示例：',
  '  node cli/extract-closure.ts --root /path/to/android \\',
  '       --entry app/src/main/java/x/Reader.kt \\',
  '       --out out/closure/src --report out/closure/report.json',
].join('\n');

interface CliArgs {
  root?: string;
  entry?: string;
  lang: string;
  out?: string;
  report?: string;
  json: boolean;
  packageComplete: boolean;
  force: boolean;
  allowOutInRoot: boolean;
  noAlias: boolean;
  help: boolean;
}

const BOOL_FLAGS = new Set(['json', 'help', 'h', 'no-package-complete', 'no-alias', 'force', 'allow-out-in-root']);
const VALUE_FLAGS = new Set(['root', 'entry', 'lang', 'out', 'report']);

class UsageError extends Error {}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { lang: 'jvm', json: false, packageComplete: true, force: false, allowOutInRoot: false, noAlias: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) throw new UsageError('多余的参数：' + token);
    const name = token === '-h' ? 'h' : token.replace(/^--?/, '');
    if (BOOL_FLAGS.has(name)) {
      if (name === 'json') args.json = true;
      else if (name === 'help' || name === 'h') args.help = true;
      else if (name === 'force') args.force = true;
      else if (name === 'allow-out-in-root') args.allowOutInRoot = true;
      else if (name === 'no-alias') args.noAlias = true;
      else args.packageComplete = false;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError('未知参数：' + token);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError('参数缺值：' + token);
    i++;
    if (name === 'root') args.root = value;
    else if (name === 'entry') args.entry = value;
    else if (name === 'lang') args.lang = value;
    else if (name === 'out') args.out = value;
    else args.report = value;
  }
  return args;
}

function fail(message: string, code: number): never {
  console.error('extract-closure: ' + message);
  process.exit(code);
}

function comparePath(pathText: string): string {
  return process.platform === 'win32' ? pathText.toLowerCase() : pathText;
}

function samePath(a: string, b: string): boolean {
  return comparePath(a) === comparePath(b);
}

/** child 是否等于或位于 parent 之内（大小写按平台归一，避免 Windows 盘符/大小写绕过）。 */
function isInsideOrEqual(parent: string, child: string): boolean {
  const p = comparePath(parent);
  const c = comparePath(child);
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c === p || c.startsWith(prefix);
}

/** --out 目录里的受管清单：只清理「上次本工具写过」的文件，绝不碰任意用户文件。 */
const OUT_MANIFEST = '.extract-closure-manifest.json';

/** --out 默认允许落在 --root 内的安全子目录（构建/缓存/引用目录，不属于上游源码树）。 */
export const SAFE_OUT_SUBDIRS = new Set(['.refs', 'out', 'dist', 'build']);
const SOURCE_FILE_EXTS = new Set(['.kt', '.kts', '.java', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.ets']);

/** outDir 相对 root 的第一段（小写）；不在 root 内返回 ''。 */
function firstRelSegment(root: string, target: string): string {
  const rel = relative(root, target).split(sep).filter((part) => part !== '' && part !== '.');
  return rel.length === 0 ? '' : rel[0].toLowerCase();
}

/** fail-closed：目录里（递归）只要已有源码文件，就拒绝把它当 --out。 */
function directoryHasSourceFiles(dir: string): boolean {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SOURCE_FILE_EXTS.has(extname(entry.name).toLowerCase())) return true;
    }
  }
  return false;
}

function isSafeRelPath(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  return rel.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..');
}

function readOutManifest(outDir: string): string[] {
  const manifestPath = join(outDir, OUT_MANIFEST);
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { tool?: unknown; files?: unknown };
    if (parsed.tool !== 'extract-closure' || !Array.isArray(parsed.files)) return [];
    return parsed.files.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function writeOutManifest(outDir: string, planned: Set<string>): void {
  const payload = { tool: 'extract-closure', version: 1, files: [...planned].sort() };
  writeFileSync(join(outDir, OUT_MANIFEST), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function pruneEmptyParents(startDir: string, stopDir: string): void {
  let current = startDir;
  while (!samePath(current, stopDir) && isInsideOrEqual(stopDir, current)) {
    let entries: string[];
    try { entries = readdirSync(current); } catch { return; }
    if (entries.length > 0) return;
    try { rmdirSync(current); } catch { return; }
    current = dirname(current);
  }
}

/** 删除上次清单里、本次不再 include 的旧产物；返回被删的相对路径（排序）。 */
function cleanStaleOutputs(outDir: string, planned: Set<string>): string[] {
  const removed: string[] = [];
  for (const rel of readOutManifest(outDir)) {
    if (planned.has(rel)) continue;
    if (!isSafeRelPath(rel)) continue;
    const dest = resolve(outDir, rel);
    if (!isInsideOrEqual(outDir, dest) || samePath(dest, outDir)) continue;
    if (!existsSync(dest) || !statSync(dest).isFile()) continue;
    try { unlinkSync(dest); } catch { continue; }
    removed.push(rel);
    pruneEmptyParents(dirname(dest), outDir);
  }
  return removed.sort();
}

function humanSummary(report: ClosureReport, elapsedMs: number, outDir: string | null, copied: number, removed: number): string {
  const lines: string[] = [];
  lines.push('extract-closure: ' + report.entry);
  lines.push('package ' + report.entryPackage + '  |  lang ' + report.lang + '  |  package 补全 ' + (report.packageComplete ? 'on' : 'off'));
  lines.push('扫描 ' + report.scannedFiles + ' 个源文件 / ' + elapsedMs.toFixed(0) + ' ms');
  lines.push('');
  lines.push('闭包 ' + report.totals.files + ' 文件 / ' + report.totals.loc + ' 行：'
    + 'include ' + report.totals.include + '（' + report.totals.includeLoc + ' 行）'
    + ' / coupled ' + report.totals.coupled + '（' + report.totals.coupledLoc + ' 行）'
    + ' / test ' + report.totals.test);
  const include = report.files.filter((row) => row.role === 'include');
  lines.push('');
  lines.push('include（--out 会按这些相对路径复制）：');
  const shown = include.length > 60 ? include.slice(0, 60) : include;
  for (const row of shown) lines.push('  ' + String(row.loc).padStart(6) + '  ' + row.path + '  [' + row.vias.join(',') + ']');
  if (include.length > shown.length) lines.push('  ...（共 ' + include.length + ' 个，完整清单见 --json/--report）');
  const test = report.files.filter((row) => row.role === 'test');
  if (test.length > 0) {
    lines.push('');
    lines.push('test（仅入口在测试源集时出现，不进闭包）：');
    for (const row of test) lines.push('  ' + String(row.loc).padStart(6) + '  ' + row.path);
  }
  if (report.boundaries.length > 0) {
    lines.push('');
    lines.push('boundaries（平台耦合，不深入；需要人工处理的边界）：');
    for (const boundary of report.boundaries) {
      lines.push('  ' + boundary.file);
      lines.push('      reason: ' + boundary.reason);
      if (boundary.evidence.length > 0) {
        const evidence = boundary.evidence.length > 4 ? boundary.evidence.slice(0, 4) : boundary.evidence;
        lines.push('      证据: ' + evidence.join(' | '));
        if (boundary.evidence.length > evidence.length) lines.push('            ...（共 ' + boundary.evidence.length + ' 行）');
      }
      if (boundary.symbols.length > 0) {
        lines.push('      闭包需要的声明: ' + boundary.symbols.map((decl) => decl.name + '(' + decl.kind + '@L' + decl.line + ')').join(', '));
      }
      if (boundary.declarations.length > boundary.symbols.length) {
        const others = boundary.declarations.filter((decl) => !decl.needed).map((decl) => decl.name + '(L' + decl.line + ')');
        lines.push('      同文件其它声明（未被闭包需要，抽模块时可选）: ' + others.slice(0, 12).join(', '));
      }
      if (boundary.neededBy.length > 0) {
        lines.push('      被引用: ' + boundary.neededBy.map((item) => item.file + ' → ' + item.symbols.join('+')).join(' | '));
      }
    }
  }
  if (report.manualExtractions.length > 0) {
    lines.push('');
    lines.push('manualExtractions（耦合文件里被闭包需要的声明 → 手工抽成独立模块的来源映射）：');
    for (const item of report.manualExtractions) {
      lines.push('  ' + item.symbol + ' (' + item.kind + ')  ←  ' + item.declaredIn + '   需要方: ' + item.neededBy.join(', '));
    }
  }
  if (report.removableImports.length > 0) {
    lines.push('');
    lines.push('removableImports（只用于注解/未使用的平台 import，按 adapters/jvm.md 去掉即可）：');
    for (const item of report.removableImports) {
      lines.push('  ' + item.symbol + '  [' + item.usage + ']  ←  ' + item.fromFile);
    }
  }
  if (report.unresolved.length > 0) {
    const internal = report.unresolved.filter((row) => row.kind === 'internal');
    const external = report.unresolved.filter((row) => row.kind === 'external');
    lines.push('');
    lines.push('unresolved：' + report.unresolved.length + ' 条（internal ' + internal.length + ' / external ' + external.length + '）');
    const sample = report.unresolved.slice(0, 10);
    for (const row of sample) lines.push('  [' + row.kind + '] ' + row.symbol + '  ←  ' + row.fromFile);
    if (report.unresolved.length > sample.length) lines.push('  ...（完整清单见 --json/--report）');
    // jvm 的 internal 只应出现在「解析失败但工程内包存在」这种异常；js-ts 的相对导入断链是正常报告项
    if (internal.length > 0 && report.lang === 'jvm') {
      console.error('extract-closure: 警告：unresolved 里有 ' + internal.length + ' 条 internal 符号（可解析的内部符号不应出现在这里）');
    }
  }
  if (outDir !== null) {
    lines.push('');
    lines.push('--out 已复制 ' + copied + ' 个 include 文件到 ' + outDir
      + (removed > 0 ? '（清理旧产物 ' + removed + ' 个）' : ''));
  }
  return lines.join('\n');
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error('extract-closure: ' + error.message);
      console.error('用 --help 看用法');
      process.exit(2);
    }
    throw error;
  }
  if (args.help) { console.log(USAGE); return; }
  if (!args.root) { console.error('extract-closure: 缺少 --root'); console.error('用 --help 看用法'); process.exit(2); }
  if (!args.entry) { console.error('extract-closure: 缺少 --entry'); console.error('用 --help 看用法'); process.exit(2); }
  if (!SUPPORTED_LANGS.includes(args.lang)) {
    fail('支持的语言：' + SUPPORTED_LANGS.join(' / ') + '，不支持 --lang ' + args.lang, 2);
  }
  const root = resolve(args.root as string);
  if (!existsSync(root) || !statSync(root).isDirectory()) fail('--root 不是目录：' + root, 2);
  const lang = args.lang;
  const cfg = loadLangConfig(lang);
  const exts = new Set(cfg.extensions.map((item) => item.toLowerCase()));

  const entryArg = args.entry as string;
  let entryAbs = isAbsolute(entryArg) ? resolve(entryArg) : resolve(root, entryArg);
  if (!existsSync(entryAbs) && existsSync(resolve(entryArg))) entryAbs = resolve(entryArg);
  if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) fail('entry 不存在：' + entryAbs, 1);
  if (!exts.has(extname(entryAbs).toLowerCase())) fail('entry 扩展名不支持：' + entryAbs + '（支持 ' + [...exts].join(' ') + '）', 1);
  const entryRel = relative(root, entryAbs).split(sep).join('/');
  if (entryRel.startsWith('..') || isAbsolute(entryRel)) fail('entry 不在 --root 内：' + entryAbs, 1);

  let outDir: string | null = null;
  if (args.out) {
    outDir = resolve(args.out);
    if (existsSync(outDir) && !statSync(outDir).isDirectory()) fail('--out 是文件而不是目录：' + outDir, 2);
    if (samePath(outDir, root)) fail('--out 不能等于 --root（会覆盖上游源码）', 2);
    if (isInsideOrEqual(root, outDir)) {
      // 允许 .refs/out/dist/build 这类安全子目录（工作区内常见落盘位置），仍保护源码树
      const segment = firstRelSegment(root, outDir);
      const safeSubdir = SAFE_OUT_SUBDIRS.has(segment);
      const allowAnyInsideRoot = args.allowOutInRoot || args.force;
      if (!safeSubdir && !allowAnyInsideRoot) {
        fail('--out 位于 --root 内且不是安全子目录（' + [...SAFE_OUT_SUBDIRS].join('/') + '）：' + outDir +
          '；如确需写入其它子目录，用 --allow-out-in-root（已有源码文件的目录仍会拒绝）', 2);
      }
      if (!safeSubdir) {
        if (existsSync(outDir) && directoryHasSourceFiles(outDir)) {
          fail('拒绝写入源码目录：--out 内已有源码文件（.kt/.java/.ts/...）：' + outDir +
            '；请换一个空目录或 --root 之外的目录', 2);
        }
        console.error('extract-closure: 警告：--out 位于 --root 内（' +
          (args.force ? '--force' : '--allow-out-in-root') + '），会写进工程目录：' + outDir);
      } else if (args.force) {
        console.error('extract-closure: 警告：--force 已启用（--out 位于 --root 内的安全子目录 ' + segment + '/）');
      }
    } else if (isInsideOrEqual(outDir, root)) {
      fail('--out 不能是 --root 的父目录（会覆盖上游源码）', 2);
    }
  }
  const reportPath = args.report ? resolve(args.report) : null;

  const t0 = Date.now();
  let report: ClosureReport | null = null;
  try {
    const index = scanProject(root, lang);
    report = extractClosure(index, entryRel, {
      root, entry: entryRel, lang, packageComplete: args.packageComplete, aliases: !args.noAlias,
    });
  } catch (error) {
    fail((error as Error).message, 1);
  }
  if (report === null) fail('闭包提取失败', 1);
  const elapsedMs = Date.now() - t0;
  const finalReport = report;

  const entryRow = finalReport.files.find((row) => row.path === entryRel);
  if (entryRow && entryRow.role === 'test') console.error('extract-closure: 提示：entry 在测试源集里，闭包角色记为 test');
  if (entryRow && entryRow.coupled) console.error('extract-closure: 提示：entry 自身命中平台耦合正则，仍会解析，平台依赖需人工处理');

  const json = JSON.stringify(finalReport, null, 2) + '\n';
  if (reportPath !== null) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, json, 'utf8');
  }
  let copied = 0;
  let removed = 0;
  if (outDir !== null) {
    mkdirSync(outDir, { recursive: true });
    const planned = new Set<string>();
    for (const row of finalReport.files) if (row.role === 'include') planned.add(row.path);
    removed = cleanStaleOutputs(outDir, planned).length;
    for (const rel of [...planned].sort()) {
      const from = join(root, rel);
      const to = join(outDir, rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied++;
    }
    writeOutManifest(outDir, planned);
  }
  if (args.json) {
    process.stdout.write(json);
    return;
  }
  console.log(humanSummary(finalReport, elapsedMs, outDir, copied, removed));
  if (reportPath !== null) console.log('\n报告已写入 ' + reportPath);
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return pathToFileURL(resolve(argv1)).href === import.meta.url; } catch { return false; }
})();

if (invokedDirectly) main();
