#!/usr/bin/env node
/**
 * 四类转换占比自动评估（只评估，不转换）。
 *
 * 用法：
 *   node cli/assess-conversion.ts --root <repo> --lang jvm [--profile broad|conservative] [--production-only] [--json] [--md] [--out <dir>]
 *
 * 默认 conservative（独立子智能体严格口径，对齐 A/S/M/N 目标）；--profile broad 保留 v1.0 宽口径作对照。
 * 一条命令输出 automated / semi-automated / manual / non-convertible 四类的
 * 文件数 / 行数 / 百分比 + 定义 / 置信度 / 样本 + funnel + 与 analyze-coupling auto 的一致性检查；
 * conservative 额外输出与 out/conversion-share/REPORT.md + numbers.json 的逐类 diff。
 * 规则全部来自 rules/conversion-share.json（工具读取并输出 ruleVersion + ruleSha256）。
 *
 * 原则：
 * - 只读 --root，不转换、不跑 port、不改上游；--out 不允许位于 --root 内。
 * - 确定性：目录/样本/模块全部稳定排序；同输入两次输出逐字节一致（无时间戳）。
 * - 严格非可转：只认平台/JVM 胶水（JNI/反射/JVM-only 库/平台服务/框架内部），不把「难」算「不可能」。
 * - automated 是能力上限（静态规则），不代表已实证移植；报告中显式 disclaimer。
 *
 * 退出码：0 = 评估完成（含空目录）；1 = 不变量被破坏（unclassified>0 / 百分比合计!=100 / automated 超出 analyze auto）；
 *         2 = 用法错误（含 --out 越界）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(cliDir, '..', 'rules', 'conversion-share.json');
const TOOL_VERSION = '1.1.0';
const DEFAULT_OUT = join('out', 'conversion-share');
/**
 * semiAutomated 的免责声明（B-10 P2）：
 * 与 automated 的「能力上限」口径对齐——semi 只是边界拆分候选，不代表已经半自动实现。
 * 数字来源：out/boundary-pilot/REPORT.md（2 文件 / +1,670 行试点）与
 * out/conversion-share/triage-legado.json（35 候选 / 6,436 行，top 8 仍待人工转写）。
 * 注意：规则文件不在本任务写 scope，故常量内置；若 rules 里给了 disclaimer 则优先用规则。
 */
const SEMI_AUTOMATED_DISCLAIMER =
  '候选上限：这是「非 UI + 平台耦合」的边界拆分候选，不代表已实现半自动；' +
  '实测仅 2 文件 / +1,670 行完成边界试点，triage 35 候选 / 6,436 行，top 8 仍待人工转写。';
const CATEGORY_ORDER = ['automated', 'semiAutomated', 'manual', 'nonConvertible'] as const;
const CATEGORY_LABELS: Record<string, string> = {
  automated: 'automated（自动）',
  semiAutomated: 'semi-automated（半自动）',
  manual: 'manual（人工）',
  nonConvertible: 'non-convertible（不可转）',
};

const USAGE = [
  '用法：',
  '  node cli/assess-conversion.ts --root <repo> --lang jvm [--profile broad|conservative] [--production-only] [--json] [--md] [--out <dir>]',
  '',
  '四类转换占比自动评估（只评估，不转换）：automated / semi-automated / manual / non-convertible。',
  '默认 conservative；--profile broad 保留 v1.0 宽口径（B-10 旧表）作对照。',
  '',
  '参数：',
  '  --root <dir>       要评估的源码仓库根（只读；分母 = .kt/.java，排除 build/generated/test/依赖/隐藏目录）',
  '  --lang <id>        语言（当前支持 jvm；规则见 rules/conversion-share.json）',
  '  --profile <id>     broad | conservative（默认 conservative）',
  '  --production-only  conservative 下再排除 test/macrobenchmark（baselineProfile），分母 2,093/402,755',
  '  --json             stdout 输出结构化 JSON',
  '  --md               stdout 输出 Markdown 报告',
  '  --out <dir>        报告目录（默认 <cwd>/out/conversion-share；不得位于 --root 内）',
  '  --help, -h         显示本帮助',
  '',
  '规则与口径：rules/conversion-share.json v1.1（工具输出 ruleVersion/ruleSha256）。',
  '  conservative（默认）：A 纯逻辑/S 有界边界/M 人工移植/N 严格 N0；对齐独立子智能体严格口径（±0.5pt）。',
  '  broad：v1.0 宽口径（A 无平台耦合、S 非 UI 平台耦合、M UI、N 严格 JNI/反射/Rhino；仅对照，不回归）。',
  '  N0（conservative）：Rhino/JS 引擎、JNI/Cronet/libarchive、JVM test/macrobenchmark。',
  '',
  '分母：conservative 默认 2,108/404,343（含 testComic/androidTestComic）；--production-only 2,093/402,755；',
  '  broad 2,095/402,965；XML 单独列、不进分母。四类合计 100%，unclassified 必须为 0。',
  '',
  '输出：broad → tool-report.json/.md；conservative → conservative-report.json/.md；--json/--md 控制 stdout。',
  '  conservative 对比：优先读取 <out>/numbers.json；否则用 rules.conservative.reference（REPORT.md 转录数字），逐类 diff + 差异文件 top N。',
  '',
  '退出码：0 = 评估完成；1 = 不变量被破坏（unclassified>0 / 合计!=100 / conservative 对齐失败 / broad automated 超出 analyze auto）；2 = 用法错误',
].join('\n');

interface RawCli {
  [key: string]: string | boolean;
}

interface PatternRule {
  id: string;
  regex: string;
}

interface CategoryRules {
  definition: string;
  confidence: number;
  narrowConfidence?: number;
  broadConfidence?: number;
  pathRules?: PatternRule[];
  contentRules?: PatternRule[];
  importRules?: PatternRule[];
  jvmOnlyImportRules?: PatternRule[];
  narrow?: { maxAndroidImports: number; maxInternalImports: number; coroutinesOnly: boolean };
  disclaimer?: string;
  samples?: string[];
}

interface ReferenceCategory {
  files: number;
  lines: number;
  percent: number;
}

interface ConservativeRules {
  definition: string;
  denominator: {
    includeTestVariants: boolean;
    productionOnlyPathRules: Array<PatternRule & { reason: string }>;
    note: string;
  };
  reference: {
    source: string;
    capturedAt: string;
    denominator: { files: number; lines: number };
    productionOnly: { files: number; lines: number };
    categories: Record<string, ReferenceCategory>;
    tolerancePt: number;
    note: string;
  };
  categories: {
    nonConvertible: CategoryRules;
    manual: CategoryRules;
    semiAutomated: CategoryRules;
    automated: CategoryRules;
  };
  rules: {
    nonConvertible: {
      pathRules: PatternRule[];
      importRules: PatternRule[];
      contentRules: PatternRule[];
      rhinoImportRule: PatternRule;
      rhinoExceptionPathRules: PatternRule[];
    };
    automated: {
      pathExcludeRules: PatternRule[];
      blockedImportRules: PatternRule[];
      platformImportRules: PatternRule[];
      annotationImportRule: PatternRule;
      thirdPartyAnnotationRegex: string;
      allowedImportPrefixes: string[];
      excludedPathRules: PatternRule[];
      note: string;
    };
    semiAutomated: {
      pathIncludeRules: PatternRule[];
      maxLines: number;
      capExemptPathRules: PatternRule[];
      excludedPathRules: PatternRule[];
      note: string;
    };
    manual: { note: string };
  };
}

interface JvmRules {
  extensions: string[];
  denominator: {
    excludeDirNames: string[];
    excludeDirReasons: Record<string, string>;
    excludePathRules: Array<PatternRule & { reason: string }>;
    note: string;
  };
  categories: {
    nonConvertible: CategoryRules;
    manual: CategoryRules;
    semiAutomated: CategoryRules;
    automated: CategoryRules;
  };
  conservative: ConservativeRules;
}

type Profile = 'broad' | 'conservative';

interface ScanOptions {
  includeTestVariants: boolean;
  productionOnly: boolean;
}

interface CompiledConservative {
  n0Path: Array<{ id: string; regex: RegExp }>;
  n0Import: Array<{ id: string; regex: RegExp }>;
  n0Content: Array<{ id: string; regex: RegExp }>;
  rhinoImport: RegExp;
  rhinoExceptionPath: Array<{ id: string; regex: RegExp }>;
  aPathExclude: Array<{ id: string; regex: RegExp }>;
  aBlockedImport: Array<{ id: string; regex: RegExp }>;
  aPlatformImport: Array<{ id: string; regex: RegExp }>;
  aAnnotationImport: RegExp;
  aThirdPartyAnnotation: RegExp;
  aAllowedPrefixes: RegExp[];
  aExcludedPath: Array<{ id: string; regex: RegExp }>;
  sPathInclude: Array<{ id: string; regex: RegExp }>;
  sCapExemptPath: Array<{ id: string; regex: RegExp }>;
  sExcludedPath: Array<{ id: string; regex: RegExp }>;
  sMaxLines: number;
  uiImport: Array<{ id: string; regex: RegExp }>;
  uiContent: Array<{ id: string; regex: RegExp }>;
  analyzePlatform: RegExp[];
}

interface RulesFile {
  version: string;
  description: string;
  languages: { jvm: JvmRules; [key: string]: JvmRules };
  shared: {
    analyzePlatformImportRegexes: string[];
    analyzeNote: string;
    additionalPlatformImportRegexes: string[];
    coroutineImportRegexes: string[];
    androidImportRegexes: string[];
    internalPackageRegexes: string[];
    output: { sampleLimit: number; moduleLimit: number; topDirDepth: number };
  };
}

const VALUE_OPTS = new Set(['root', 'lang', 'out', 'profile']);
const BOOL_OPTS = new Set(['json', 'md', 'help', 'production-only']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failUsage(message: string): never {
  console.error('assess-conversion: ' + message);
  console.error('用法见：node cli/assess-conversion.ts --help');
  process.exit(2);
}

function parseCliArgs(argv: string[]): RawCli {
  const raw: RawCli = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') { raw.help = true; continue; }
    if (!token.startsWith('--')) failUsage('无法识别的参数：' + token);
    const eq = token.indexOf('=');
    if (eq > 2) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      if (key === 'production-only') {
        if (value === 'true') raw[key] = true;
        else if (value === 'false') raw[key] = false;
        else failUsage('参数 --production-only 只接受 true/false');
        continue;
      }
      if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
      if (value === '') failUsage('参数 --' + key + ' 不能为空');
      raw[key] = value;
      continue;
    }
    const key = token.slice(2);
    if (BOOL_OPTS.has(key)) { raw[key] = true; continue; }
    if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) failUsage('参数 --' + key + ' 缺少取值');
    raw[key] = next;
    i++;
  }
  return raw;
}

function optional(raw: RawCli, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' ? value : null;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function relPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return path;
  return rel;
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

function loadRules(): { rules: RulesFile; rawText: string; sha: string } {
  let rawText = '';
  try {
    rawText = readFileSync(RULES_PATH, 'utf8');
  } catch (error) {
    failUsage('无法读取规则文件 ' + RULES_PATH + '：' + errorMessage(error));
  }
  let rules: RulesFile;
  try {
    rules = JSON.parse(rawText) as RulesFile;
  } catch (error) {
    failUsage('规则文件不是合法 JSON：' + RULES_PATH + '（' + errorMessage(error) + '）');
  }
  if (typeof rules.version !== 'string' || rules.version === '') failUsage('规则文件缺少 version');
  return { rules, rawText, sha: sha256(rawText) };
}

function compilePatterns(rules: PatternRule[], multiline: boolean): Array<{ id: string; regex: RegExp }> {
  const compiled: Array<{ id: string; regex: RegExp }> = [];
  for (const rule of rules) {
    try {
      compiled.push({ id: rule.id, regex: new RegExp(rule.regex, multiline ? 'm' : '') });
    } catch (error) {
      failUsage('规则正则非法（' + rule.id + '）：' + rule.regex + '（' + errorMessage(error) + '）');
    }
  }
  return compiled;
}

function matchIds(patterns: Array<{ id: string; regex: RegExp }>, target: string): string[] {
  const ids: string[] = [];
  for (const pattern of patterns) {
    if (pattern.regex.test(target)) ids.push(pattern.id);
  }
  return ids;
}

function matchImportIds(patterns: Array<{ id: string; regex: RegExp }>, imports: string[]): string[] {
  const ids: string[] = [];
  for (const pattern of patterns) {
    if (imports.some((name) => pattern.regex.test(name))) ids.push(pattern.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 扫描（分母 + 排除桶 + XML 单列）
// ---------------------------------------------------------------------------

interface SourceFile {
  rel: string;
  abs: string;
  lines: number;
  text: string;
  imports: string[];
}

interface ExcludedBucket {
  reason: string;
  files: number;
  lines: number;
  samples: string[];
}

interface XmlEntry {
  rel: string;
  lines: number;
}

interface ScanResult {
  sources: SourceFile[];
  excluded: ExcludedBucket[];
  xml: XmlEntry[];
  skippedDirs: string[];
}

function importsOf(text: string): string[] {
  const names: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('import ')) continue;
    let rest = line.slice('import '.length).trim();
    if (rest.startsWith('static ')) rest = rest.slice('static '.length).trim();
    const token = rest.split(/\s+/)[0];
    const name = token.replace(/;$/, '').replace(/\.\*$/, '');
    if (name !== '') names.push(name);
  }
  return names;
}

function scanRepo(rootAbs: string, jvm: JvmRules, profile: Profile, options: ScanOptions): ScanResult {
  const extensions = new Set(jvm.extensions);
  const excludeDirNames = new Set(jvm.denominator.excludeDirNames);
  const basePathRules = profile === 'broad'
    ? jvm.denominator.excludePathRules
    : jvm.denominator.excludePathRules.filter((rule) => rule.id !== 'testflavor-srcset');
  const rawPathRules = options.productionOnly
    ? [...basePathRules, ...jvm.conservative.denominator.productionOnlyPathRules]
    : basePathRules;
  const pathRules = rawPathRules.map((rule) => ({
    id: rule.id, reason: rule.reason, regex: new RegExp(rule.regex),
  }));
  const sources: SourceFile[] = [];
  const excludedMap = new Map<string, ExcludedBucket>();
  const xml: XmlEntry[] = [];
  const skippedDirs: string[] = [];

  const addExcluded = (reason: string, rel: string, lines: number): void => {
    let bucket = excludedMap.get(reason);
    if (bucket === undefined) {
      bucket = { reason, files: 0, lines: 0, samples: [] };
      excludedMap.set(reason, bucket);
    }
    bucket.files++;
    bucket.lines += lines;
    if (bucket.samples.length < 5) bucket.samples.push(rel);
  };

  const walk = (dirAbs: string, relParts: string[]): void => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch (error) {
      failUsage('无法读取目录 ' + dirAbs + '：' + errorMessage(error));
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relParts.length === 0 ? entry.name : [...relParts, entry.name].join('/');
      const abs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) {
          skippedDirs.push(rel + '/（hidden）');
          continue;
        }
        if (excludeDirNames.has(entry.name)) {
          const reason = jvm.denominator.excludeDirReasons[entry.name] ?? 'excluded-dir';
          skippedDirs.push(rel + '/（' + reason + '，整目录未计入）');
          continue;
        }
        walk(abs, [...relParts, entry.name]);
        continue;
      }
      const ext = extname(entry.name);
      const isSource = extensions.has(ext);
      const isXml = ext === '.xml';
      if (!isSource && !isXml) continue;
      const matchedPath = pathRules.find((rule) => rule.regex.test(rel));
      if (matchedPath !== undefined) {
        if (isSource) {
          let lines = 0;
          try { lines = readFileSync(abs, 'utf8').split('\n').length; } catch { lines = 0; }
          addExcluded(matchedPath.reason, rel, lines);
        }
        continue;
      }
      if (isXml) {
        let lines = 0;
        try { lines = readFileSync(abs, 'utf8').split('\n').length; } catch { lines = 0; }
        xml.push({ rel, lines });
        continue;
      }
      let text = '';
      try {
        text = readFileSync(abs, 'utf8');
      } catch (error) {
        failUsage('无法读取源码 ' + abs + '：' + errorMessage(error));
      }
      sources.push({
        rel,
        abs,
        lines: text.split('\n').length,
        text,
        imports: importsOf(text),
      });
    }
  };

  walk(rootAbs, []);
  const excluded = [...excludedMap.values()].sort((a, b) => b.files - a.files || (a.reason < b.reason ? -1 : 1));
  xml.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { sources, excluded, xml, skippedDirs };
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

interface CompiledJvm {
  nonConvPath: Array<{ id: string; regex: RegExp }>;
  nonConvContent: Array<{ id: string; regex: RegExp }>;
  nonConvImport: Array<{ id: string; regex: RegExp }>;
  uiImport: Array<{ id: string; regex: RegExp }>;
  uiContent: Array<{ id: string; regex: RegExp }>;
  analyzePlatform: RegExp[];
  additionalPlatformImport: Array<{ id: string; regex: RegExp }>;
  coroutineImport: RegExp[];
  androidImport: RegExp[];
  internalPackage: RegExp[];
  narrow: { maxAndroidImports: number; maxInternalImports: number; coroutinesOnly: boolean };
}

function compileJvm(jvm: JvmRules, shared: RulesFile['shared']): CompiledJvm {
  const semi = jvm.categories.semiAutomated.narrow;
  if (semi === undefined) failUsage('规则文件缺少 languages.jvm.categories.semiAutomated.narrow');
  const toGlobals = (rules: string[]): RegExp[] => rules.map((pattern) => {
    try { return new RegExp(pattern); } catch (error) { return failUsage('规则正则非法：' + pattern + '（' + errorMessage(error) + '）'); }
  });
  return {
    nonConvPath: compilePatterns(jvm.categories.nonConvertible.pathRules ?? [], true),
    nonConvContent: compilePatterns(jvm.categories.nonConvertible.contentRules ?? [], true),
    nonConvImport: compilePatterns(jvm.categories.nonConvertible.jvmOnlyImportRules ?? [], false),
    uiImport: compilePatterns(jvm.categories.manual.importRules ?? [], false),
    uiContent: compilePatterns(jvm.categories.manual.contentRules ?? [], true),
    analyzePlatform: shared.analyzePlatformImportRegexes.map((pattern) => {
      try { return new RegExp(pattern, 'm'); } catch (error) { return failUsage('规则正则非法：' + pattern + '（' + errorMessage(error) + '）'); }
    }),
    additionalPlatformImport: compilePatterns(shared.additionalPlatformImportRegexes.map((regex, index) => ({ id: 'additional-' + index, regex })), false),
    coroutineImport: toGlobals(shared.coroutineImportRegexes),
    androidImport: toGlobals(shared.androidImportRegexes),
    internalPackage: toGlobals(shared.internalPackageRegexes),
    narrow: semi,
  };
}

type CategoryKey = (typeof CATEGORY_ORDER)[number];

interface ClassifiedFile extends SourceFile {
  category: CategoryKey;
  ruleIds: string[];
  narrow: boolean;
  couplingImports: number;
  internalImports: number;
  androidImports: number;
  coroutineOnly: boolean;
  analyzeCoupled: boolean;
}

function classify(file: SourceFile, compiled: CompiledJvm): ClassifiedFile {
  const nonConvPath = matchIds(compiled.nonConvPath, file.rel);
  const nonConvContent = matchIds(compiled.nonConvContent, file.text);
  const nonConvImport = matchImportIds(compiled.nonConvImport, file.imports);
  const uiImport = matchImportIds(compiled.uiImport, file.imports);
  const uiContent = matchIds(compiled.uiContent, file.text);

  const couplingIds: string[] = [];
  let couplingImports = 0;
  let androidImports = 0;
  let coroutineOnly = file.imports.length > 0;
  let coroutineImports = 0;
  for (const name of file.imports) {
    const isCoupling = compiled.additionalPlatformImport.some((pattern) => pattern.regex.test(name));
    if (isCoupling) {
      couplingImports++;
      couplingIds.push(name);
    }
    if (compiled.androidImport.some((pattern) => pattern.test(name))) androidImports++;
    if (compiled.coroutineImport.some((pattern) => pattern.test(name))) coroutineImports++;
    else if (isCoupling) coroutineOnly = false;
  }
  if (couplingImports === 0 || coroutineImports === 0) coroutineOnly = false;
  const internalImports = file.imports.filter((name) => compiled.internalPackage.some((pattern) => pattern.test(name))).length;
  const analyzeCoupled = compiled.analyzePlatform.some((pattern) => pattern.test(file.text));
  const hasCoupling = analyzeCoupled || couplingImports > 0;

  const narrow = hasCoupling &&
    (coroutineOnly || androidImports <= compiled.narrow.maxAndroidImports) &&
    internalImports <= compiled.narrow.maxInternalImports;

  let category: CategoryKey;
  let ruleIds: string[];
  if (nonConvPath.length + nonConvContent.length + nonConvImport.length > 0) {
    category = 'nonConvertible';
    ruleIds = [...nonConvPath, ...nonConvContent, ...nonConvImport];
  } else if (uiImport.length + uiContent.length > 0) {
    category = 'manual';
    ruleIds = [...uiImport, ...uiContent];
  } else if (hasCoupling) {
    category = 'semiAutomated';
    ruleIds = [...couplingIds.slice(0, 3), ...(analyzeCoupled && couplingIds.length === 0 ? ['analyze-platform-import'] : [])];
  } else {
    category = 'automated';
    ruleIds = [];
  }

  return {
    ...file,
    category,
    ruleIds: [...new Set(ruleIds)],
    narrow,
    couplingImports,
    internalImports,
    androidImports,
    coroutineOnly,
    analyzeCoupled,
  };
}



function compileConservative(jvm: JvmRules, shared: RulesFile['shared']): CompiledConservative {
  const cons = jvm.conservative;
  if (cons === undefined) failUsage('规则文件缺少 languages.jvm.conservative');
  const compileSection = (rules: PatternRule[], multiline: boolean): Array<{ id: string; regex: RegExp }> =>
    compilePatterns(rules, multiline);
  const toGlobals = (patterns: string[], flags = ''): RegExp[] => patterns.map((pattern) => {
    try { return new RegExp(pattern, flags); } catch (error) {
      return failUsage('规则正则非法：' + pattern + '（' + errorMessage(error) + '）');
    }
  });
  const single = (rule: PatternRule): RegExp => {
    try { return new RegExp(rule.regex, 'm'); } catch (error) {
      return failUsage('规则正则非法（' + rule.id + '）：' + rule.regex + '（' + errorMessage(error) + '）');
    }
  };
  return {
    n0Path: compileSection(cons.rules.nonConvertible.pathRules, true),
    n0Import: compileSection(cons.rules.nonConvertible.importRules, false),
    n0Content: compileSection(cons.rules.nonConvertible.contentRules, true),
    rhinoImport: single(cons.rules.nonConvertible.rhinoImportRule),
    rhinoExceptionPath: compileSection(cons.rules.nonConvertible.rhinoExceptionPathRules, true),
    aPathExclude: compileSection(cons.rules.automated.pathExcludeRules, true),
    aBlockedImport: compileSection(cons.rules.automated.blockedImportRules, false),
    aPlatformImport: compileSection(cons.rules.automated.platformImportRules, false),
    aAnnotationImport: single(cons.rules.automated.annotationImportRule),
    aThirdPartyAnnotation: (() => {
      try { return new RegExp(cons.rules.automated.thirdPartyAnnotationRegex); } catch (error) {
        return failUsage('规则正则非法（thirdPartyAnnotation）：' + cons.rules.automated.thirdPartyAnnotationRegex + '（' + errorMessage(error) + '）');
      }
    })(),
    aAllowedPrefixes: toGlobals(cons.rules.automated.allowedImportPrefixes),
    aExcludedPath: compileSection(cons.rules.automated.excludedPathRules, true),
    sPathInclude: compileSection(cons.rules.semiAutomated.pathIncludeRules, true),
    sCapExemptPath: compileSection(cons.rules.semiAutomated.capExemptPathRules, true),
    sExcludedPath: compileSection(cons.rules.semiAutomated.excludedPathRules, true),
    sMaxLines: cons.rules.semiAutomated.maxLines,
    uiImport: compileSection(jvm.categories.manual.importRules ?? [], false),
    uiContent: compileSection(jvm.categories.manual.contentRules ?? [], true),
    analyzePlatform: toGlobals(shared.analyzePlatformImportRegexes, 'm'),
  };
}

function classifyConservative(file: SourceFile, compiled: CompiledConservative): ClassifiedFile {
  const n0Path = matchIds(compiled.n0Path, file.rel);
  const n0Import = matchImportIds(compiled.n0Import, file.imports);
  const n0Content = matchIds(compiled.n0Content, file.text);
  const rhinoImport = file.imports.some((name) => compiled.rhinoImport.test(name));
  const rhinoException = matchIds(compiled.rhinoExceptionPath, file.rel);
  const uiImport = matchImportIds(compiled.uiImport, file.imports);
  const uiContent = matchIds(compiled.uiContent, file.text);
  const analyzeCoupled = compiled.analyzePlatform.some((pattern) => pattern.test(file.text));

  const base = {
    ...file,
    narrow: false,
    couplingImports: 0,
    internalImports: 0,
    androidImports: 0,
    coroutineOnly: false,
    analyzeCoupled,
  };

  const n0Ids = [
    ...n0Path, ...n0Import, ...n0Content,
    ...(rhinoImport && rhinoException.length === 0 ? ['rhino-import'] : []),
  ];
  if (n0Ids.length > 0) {
    return { ...base, category: 'nonConvertible', ruleIds: [...new Set(n0Ids)] };
  }
  if (uiImport.length + uiContent.length > 0) {
    return { ...base, category: 'manual', ruleIds: [...new Set([...uiImport, ...uiContent])] };
  }
  const excludedPath = matchIds(compiled.sExcludedPath, file.rel);
  if (excludedPath.length > 0) {
    return { ...base, category: 'manual', ruleIds: excludedPath };
  }
  const blockedImport = matchImportIds(compiled.aBlockedImport, file.imports);
  const pathExclude = matchIds(compiled.aPathExclude, file.rel);
  const platformImports = file.imports.filter((name) => compiled.aPlatformImport.some((pattern) => pattern.regex.test(name)));
  const platformOk = platformImports.every((name) => compiled.aAnnotationImport.test(name));
  const thirdParty = file.imports.filter((name) =>
    !compiled.aAllowedPrefixes.some((pattern) => pattern.test(name)) &&
    !compiled.aPlatformImport.some((pattern) => pattern.regex.test(name)));
  const thirdPartyOk = thirdParty.every((name) => compiled.aThirdPartyAnnotation.test(name));
  const isAutomated = blockedImport.length === 0 && pathExclude.length === 0 &&
    excludedPath.length === 0 && platformOk && thirdPartyOk;
  if (isAutomated) {
    return {
      ...base,
      category: 'automated',
      ruleIds: [...new Set([...(platformImports.length > 0 ? ['annotation-only-platform'] : []), ...(thirdParty.length > 0 ? ['annotation-only-third-party'] : [])])],
    };
  }
  const semiPath = matchIds(compiled.sPathInclude, file.rel);
  if (semiPath.length > 0) {
    const capExempt = matchIds(compiled.sCapExemptPath, file.rel).length > 0;
    if (capExempt || file.lines <= compiled.sMaxLines) {
      return { ...base, category: 'semiAutomated', ruleIds: [...new Set(semiPath)] };
    }
  }
  return { ...base, category: 'manual', ruleIds: [] };
}


interface ConservativeReference {
  source: string;
  categories: Record<string, ReferenceCategory>;
  denominator: { files: number; lines: number };
  productionOnly?: { files: number; lines: number };
  tolerancePt: number;
  note: string;
  available: boolean;
  path: string | null;
}

function isAnnotationOnlyPlatformFile(file: SourceFile, compiled: CompiledConservative): boolean {
  const platformImports = file.imports.filter((name) => compiled.aPlatformImport.some((pattern) => pattern.regex.test(name)));
  return platformImports.length > 0 && platformImports.every((name) => compiled.aAnnotationImport.test(name));
}

function readReferenceCategories(source: Record<string, any>): Record<string, ReferenceCategory> | null {
  const categories: Record<string, ReferenceCategory> = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = normalizeCategoryKey(rawKey);
    if (key === null || value === null || typeof value !== 'object') continue;
    const entry = value as Record<string, any>;
    const files = typeof entry.files === 'number' ? entry.files : null;
    const lines = typeof entry.lines === 'number' ? entry.lines : null;
    if (files === null || lines === null) continue;
    const percent = typeof entry.percent === 'number' ? entry.percent
      : typeof entry.pct === 'number' ? entry.pct
      : null;
    categories[key] = { files, lines, percent: percent === null ? 0 : percent };
  }
  return Object.keys(categories).length === 4 ? categories : null;
}

function resolveConservativeReference(outDir: string, jvm: JvmRules, productionOnly: boolean): ConservativeReference {
  const fallback = (jvm as any).conservative?.reference as ConservativeRules['reference'] | undefined;
  if (fallback === undefined) {
    failUsage('规则文件缺少 languages.jvm.conservative.reference（需要 rules v1.1；请勿混用 v1.0 rules 与新 CLI）');
  }
  const numbersPath = join(outDir, 'numbers.json');
  let text = '';
  try {
    text = readFileSync(numbersPath, 'utf8');
  } catch {
    text = '';
  }
  let parsed: Record<string, any> | null = null;
  if (text !== '') {
    try { parsed = JSON.parse(text) as Record<string, any>; } catch { parsed = null; }
  }
  let categories: Record<string, ReferenceCategory> | null = null;
  let denominator: { files: number; lines: number } | null = null;
  let production: { files: number; lines: number } | undefined;
  let referencePath = numbersPath;
  if (parsed !== null) {
    const source = (parsed.categories ?? parsed.classification ?? parsed) as Record<string, any>;
    categories = readReferenceCategories(source);
    const denom = parsed.denominator ?? parsed.total ?? parsed.counts;
    if (denom !== null && typeof denom === 'object' && typeof denom.files === 'number' && typeof denom.lines === 'number') {
      denominator = { files: denom.files, lines: denom.lines };
    }
    const prod = parsed.productionOnly ?? parsed.production;
    if (prod !== null && typeof prod === 'object' && typeof prod.files === 'number' && typeof prod.lines === 'number') {
      production = { files: prod.files, lines: prod.lines };
    }
  }
  if (categories === null) {
    // numbers.json 不存在/不可解析时，回退解析 <out>/REPORT.md 内的 JSON 代码块（四类数值）
    try {
      const reportText = readFileSync(join(outDir, 'REPORT.md'), 'utf8');
      for (const block of extractJsonBlocks(reportText)) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
        const record = block as Record<string, any>;
        const source = (record.categories ?? record) as Record<string, any>;
        const parsedCategories = readReferenceCategories(source);
        if (parsedCategories !== null) {
          referencePath = join(outDir, 'REPORT.md');
          categories = parsedCategories;
          const denom = record.denominator ?? record.total;
          if (denom !== null && typeof denom === 'object' && typeof denom.files === 'number' && typeof denom.lines === 'number') {
            denominator = { files: denom.files, lines: denom.lines };
          }
          break;
        }
      }
    } catch {
      // 无 REPORT.md，保持 fallback
    }
  }
  const useNumbers = categories !== null && denominator !== null;
  const resolvedCategories = useNumbers ? categories as Record<string, ReferenceCategory> : fallback.categories;
  const resolvedDenominator = useNumbers ? denominator as { files: number; lines: number } : fallback.denominator;
  const resolvedProduction = useNumbers ? production : fallback.productionOnly;
  return {
    source: useNumbers ? (relPath(process.cwd(), referencePath) || referencePath) : fallback.source,
    categories: resolvedCategories,
    denominator: productionOnly && resolvedProduction !== undefined ? resolvedProduction : resolvedDenominator,
    productionOnly: resolvedProduction,
    tolerancePt: fallback.tolerancePt,
    note: fallback.note + (useNumbers ? '（本次优先读取 numbers.json）' : '（numbers.json 不存在，使用规则转录 reference）'),
    available: useNumbers,
    path: useNumbers ? relPath(process.cwd(), referencePath) : null,
  };
}

function buildConservativeComparison(
  totals: { files: number; lines: number },
  categories: Record<string, CategorySummary>,
  reference: ConservativeReference,
  limit: number,
  productionOnly: boolean,
): Record<string, any> {
  const denominator = { ...totals, refFiles: reference.denominator.files, refLines: reference.denominator.lines };
  const diffs = CATEGORY_ORDER.map((key) => {
    const ours = categories[key];
    const ref = reference.categories[key];
    const refPercent = ref === undefined ? null : (ref.percent > 0 ? ref.percent : round2(ref.lines * 100 / Math.max(reference.denominator.lines, 1)));
    const deltaPt = refPercent === null ? null : round2(ours.percentLines - refPercent);
    return {
      category: key,
      oursFiles: ours.files,
      refFiles: ref === undefined ? null : ref.files,
      deltaFiles: ref === undefined ? null : ours.files - ref.files,
      oursLines: ours.lines,
      refLines: ref === undefined ? null : ref.lines,
      deltaLines: ref === undefined ? null : ours.lines - ref.lines,
      oursPercent: ours.percentLines,
      refPercent,
      deltaPt,
      pass: deltaPt === null ? false : Math.abs(deltaPt) <= reference.tolerancePt,
    };
  });
  const referenceApplicable = !productionOnly;
  const allPass = diffs.every((diff) => diff.pass);
  const deltaFiles = denominator.refFiles === undefined ? null : denominator.files - denominator.refFiles;
  const deltaLines = denominator.refLines === undefined ? null : denominator.lines - denominator.refLines;
  return {
    source: reference.source,
    referencePath: reference.path,
    referenceAvailable: reference.available,
    productionOnly,
    tolerancePt: reference.tolerancePt,
    denominator: {
      oursFiles: denominator.files,
      oursLines: denominator.lines,
      refFiles: denominator.refFiles,
      refLines: denominator.refLines,
      deltaFiles,
      deltaLines,
    },
    categories: diffs,
    withinTolerance: referenceApplicable ? allPass : true,
    classReferenceApplicable: referenceApplicable,
    perFileReferenceAvailable: false,
    fileDiffTop: Object.fromEntries(CATEGORY_ORDER.map((key) => [key, categories[key].samples.slice(0, Math.min(limit, 5))])),
    note: reference.note + (referenceApplicable
      ? '；逐类行占比允许 ≤' + reference.tolerancePt + 'pt（files 边界差异以行占比验收为准）；逐文件标签不可得，fileDiffTop 为本工具侧样本（差异候选，不是与子智能体的逐文件 diff）。'
      : '；--production-only 仅校对分母，四类参照仍为默认（含 test-variant）口径，故不判定逐类通过。'),
  };
}

// ---------------------------------------------------------------------------
// 汇总与不变量
// ---------------------------------------------------------------------------

interface CategorySummary {
  files: number;
  lines: number;
  percentFiles: number;
  percentLines: number;
  definition: string;
  confidence: number;
  disclaimer: string | null;
  narrowFiles?: number;
  broadFiles?: number;
  samples: Array<{ path: string; lines: number; rules: string[]; narrow?: boolean }>;
}

function emptySummary(): CategorySummary {
  return { files: 0, lines: 0, percentFiles: 0, percentLines: 0, definition: '', confidence: 0, disclaimer: null, samples: [] };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentages(values: Record<string, number>, total: number): Record<string, number> {
  const result: Record<string, number> = {};
  if (total === 0) {
    for (const key of Object.keys(values)) result[key] = 0;
    return result;
  }
  let sum = 0;
  for (const [key, value] of Object.entries(values)) {
    result[key] = round2(value * 100 / total);
    sum += result[key];
  }
  const diff = round2(100 - sum);
  if (diff !== 0) {
    const largest = Object.entries(values).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    result[largest] = round2(result[largest] + diff);
  }
  return result;
}

function sampleOf(file: ClassifiedFile): { path: string; lines: number; rules: string[]; narrow?: boolean } {
  const sample: { path: string; lines: number; rules: string[]; narrow?: boolean } = {
    path: file.rel,
    lines: file.lines,
    rules: file.ruleIds,
  };
  if (file.category === 'semiAutomated') sample.narrow = file.narrow;
  return sample;
}

function pickSamples(files: ClassifiedFile[], limit: number): Array<{ path: string; lines: number; rules: string[]; narrow?: boolean }> {
  return [...files]
    .sort((a, b) => b.lines - a.lines || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .slice(0, limit)
    .map(sampleOf);
}

function buildReport(
  rootArg: string,
  rootAbs: string,
  rules: RulesFile,
  ruleSha: string,
  scan: ScanResult,
  profile: Profile,
  options: ScanOptions,
  reference: ConservativeReference | null,
): Record<string, any> {
  const jvm = rules.languages.jvm;
  const compiled = profile === 'broad' ? compileJvm(jvm, rules.shared) : null;
  const conservativeCompiled = profile === 'conservative' ? compileConservative(jvm, rules.shared) : null;
  const files = scan.sources.map((file) => profile === 'broad'
    ? classify(file, compiled as CompiledJvm)
    : classifyConservative(file, conservativeCompiled as CompiledConservative));
  const categoryRules = profile === 'broad' ? jvm.categories : jvm.conservative.categories;
  const totalFiles = files.length;
  const totalLines = files.reduce((sum, file) => sum + file.lines, 0);
  const limit = rules.shared.output.sampleLimit;

  const byCategory = new Map<CategoryKey, ClassifiedFile[]>();
  for (const key of CATEGORY_ORDER) byCategory.set(key, []);
  for (const file of files) byCategory.get(file.category)?.push(file);

  const filesPercent = percentages(Object.fromEntries(CATEGORY_ORDER.map((key) => [key, byCategory.get(key)?.length ?? 0])), totalFiles);
  const linesPercent = percentages(Object.fromEntries(CATEGORY_ORDER.map((key) => [key, (byCategory.get(key) ?? []).reduce((sum, file) => sum + file.lines, 0)])), totalLines);

  const categories: Record<string, CategorySummary> = {};
  for (const key of CATEGORY_ORDER) {
    const list = byCategory.get(key) ?? [];
    const rulesForCategory = categoryRules[key];
    const disclaimer = rulesForCategory.disclaimer ??
      (key === 'semiAutomated' ? SEMI_AUTOMATED_DISCLAIMER : null);
    const summary: CategorySummary = {
      files: list.length,
      lines: list.reduce((sum, file) => sum + file.lines, 0),
      percentFiles: filesPercent[key],
      percentLines: linesPercent[key],
      definition: rulesForCategory.definition,
      confidence: rulesForCategory.confidence,
      disclaimer,
      samples: pickSamples(list, limit),
    };
    if (key === 'semiAutomated' && profile === 'broad') {
      summary.narrowFiles = list.filter((file) => file.narrow).length;
      summary.broadFiles = list.length - summary.narrowFiles;
    }
    if (profile === 'conservative') {
      summary.samples = summary.samples.map((sample) => {
        const { narrow: _narrow, ...rest } = sample;
        return rest;
      });
    }
    categories[key] = summary;
  }

  const excluded = [...scan.excluded];
  const unclassified = files.filter((file) => !CATEGORY_ORDER.includes(file.category)).length;
  const automatedFiles = byCategory.get('automated') ?? [];
  const analyzeAuto = files.filter((file) => !file.analyzeCoupled);
  const automatedInAnalyzeAuto = automatedFiles.filter((file) => !file.analyzeCoupled);
  const automatedCoupled = automatedFiles.filter((file) => file.analyzeCoupled);
  const automatedAnnotationOnly = profile === 'conservative' && conservativeCompiled !== null
    ? automatedCoupled.filter((file) => isAnnotationOnlyPlatformFile(file, conservativeCompiled))
    : [];
  const automatedNotInAnalyzeAuto = automatedCoupled.filter((file) => !automatedAnnotationOnly.includes(file));
  const analyzeAutoNotAutomated = analyzeAuto.filter((file) => file.category !== 'automated');
  const analyzeAutoNotAutomatedByCategory: Record<string, number> = {};
  for (const file of analyzeAutoNotAutomated) {
    analyzeAutoNotAutomatedByCategory[file.category] = (analyzeAutoNotAutomatedByCategory[file.category] ?? 0) + 1;
  }

  const funnel = [
    { stage: 'denominator', files: totalFiles, lines: totalLines },
    { stage: 'after non-convertible', files: files.filter((file) => file.category !== 'nonConvertible').length, lines: files.filter((file) => file.category !== 'nonConvertible').reduce((sum, file) => sum + file.lines, 0) },
    { stage: 'after manual', files: files.filter((file) => file.category === 'semiAutomated' || file.category === 'automated').length, lines: files.filter((file) => file.category === 'semiAutomated' || file.category === 'automated').reduce((sum, file) => sum + file.lines, 0) },
    { stage: 'after semi-automated', files: files.filter((file) => file.category === 'automated').length, lines: files.filter((file) => file.category === 'automated').reduce((sum, file) => sum + file.lines, 0) },
  ];

  const moduleMap = new Map<string, { files: number; lines: number; automated: number; semiAutomated: number; manual: number; nonConvertible: number }>();
  for (const file of files) {
    const parts = file.rel.split('/');
    const module = parts.slice(0, Math.min(rules.shared.output.topDirDepth, Math.max(parts.length - 1, 1))).join('/');
    let bucket = moduleMap.get(module);
    if (bucket === undefined) {
      bucket = { files: 0, lines: 0, automated: 0, semiAutomated: 0, manual: 0, nonConvertible: 0 };
      moduleMap.set(module, bucket);
    }
    bucket.files++;
    bucket.lines += file.lines;
    bucket[file.category]++;
  }
  const modules = [...moduleMap.entries()]
    .sort((a, b) => b[1].lines - a[1].lines || (a[0] < b[0] ? -1 : 1))
    .slice(0, rules.shared.output.moduleLimit)
    .map(([path, bucket]) => ({ path, ...bucket }));

  const fingerprint = sha256(
    [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
      .map((file) => file.rel + ':' + file.lines).join('\n'),
  );

  const xmlLines = scan.xml.reduce((sum, entry) => sum + entry.lines, 0);
  const excludedFiles = excluded.reduce((sum, bucket) => sum + bucket.files, 0);
  const excludedLines = excluded.reduce((sum, bucket) => sum + bucket.lines, 0);

  const checks = {
    unclassified,
    totalFilesMatch: CATEGORY_ORDER.reduce((sum, key) => sum + (byCategory.get(key)?.length ?? 0), 0) === totalFiles,
    totalLinesMatch: CATEGORY_ORDER.reduce((sum, key) => sum + ((byCategory.get(key) ?? []).reduce((inner, file) => inner + file.lines, 0)), 0) === totalLines,
    percentFilesTotal: round2(CATEGORY_ORDER.reduce((sum, key) => sum + categories[key].percentFiles, 0)),
    percentLinesTotal: round2(CATEGORY_ORDER.reduce((sum, key) => sum + categories[key].percentLines, 0)),
    automatedNotInAnalyzeAuto: automatedNotInAnalyzeAuto.length,
    automatedAnnotationOnlyPlatform: automatedAnnotationOnly.length,
  };
  const comparison = profile === 'conservative' && reference !== null
    ? buildConservativeComparison({ files: totalFiles, lines: totalLines }, categories, reference, limit, options.productionOnly)
    : null;
  const ok = unclassified === 0 && checks.totalFilesMatch && checks.totalLinesMatch &&
    (totalFiles === 0 || (checks.percentFilesTotal === 100 && checks.percentLinesTotal === 100)) &&
    automatedNotInAnalyzeAuto.length === 0;

  const report: Record<string, any> = {
    tool: 'assess-conversion',
    toolVersion: TOOL_VERSION,
    ruleVersion: rules.version,
    ruleSha256: ruleSha,
    root: rootArg,
    lang: 'jvm',
    profile,
    productionOnly: options.productionOnly,
    denominator: {
      files: totalFiles,
      lines: totalLines,
      extensions: jvm.extensions,
      excluded: {
        files: excludedFiles,
        lines: excludedLines,
        byReason: excluded,
        skippedDirs: [...scan.skippedDirs].sort(),
      },
      note: profile === 'broad'
        ? jvm.denominator.note
        : jvm.conservative.denominator.note + (options.productionOnly ? '（--production-only 已生效）' : ''),
    },
    categories,
    percentTotal: {
      files: checks.percentFilesTotal,
      lines: checks.percentLinesTotal,
    },
    unclassified,
    checks,
    ok,
    funnel,
    modules,
    xml: {
      files: scan.xml.length,
      lines: xmlLines,
      samples: scan.xml.slice(0, limit).map((entry) => entry.rel),
    },
    consistency: {
      analyzeCoupling: {
        note: rules.shared.analyzeNote,
        analyzeAutoFiles: analyzeAuto.length,
        analyzeAutoLines: analyzeAuto.reduce((sum, file) => sum + file.lines, 0),
        automatedFiles: automatedFiles.length,
        automatedInAnalyzeAuto: automatedInAnalyzeAuto.length,
        automatedNotInAnalyzeAuto: automatedNotInAnalyzeAuto.map(sampleOf),
        analyzeAutoNotAutomatedFiles: analyzeAutoNotAutomated.length,
        analyzeAutoNotAutomatedLines: analyzeAutoNotAutomated.reduce((sum, file) => sum + file.lines, 0),
        analyzeAutoNotAutomatedByCategory,
        analyzeAutoNotAutomatedSamples: pickSamples(analyzeAutoNotAutomated, limit),
        consistent: automatedNotInAnalyzeAuto.length === 0,
      },
    },
    comparison,
    inputFingerprint: fingerprint,
    empty: totalFiles === 0,
    rootResolved: rootAbs,
  };
  return report;
}

// ---------------------------------------------------------------------------
// 与子智能体报告对比（可选，尽力解析）
// ---------------------------------------------------------------------------

function extractJsonBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  const marker = String.fromCharCode(96, 96, 96) + 'json';
  let index = text.indexOf(marker);
  while (index >= 0) {
    const start = index + marker.length;
    const end = text.indexOf(String.fromCharCode(96, 96, 96), start);
    if (end < 0) break;
    try {
      blocks.push(JSON.parse(text.slice(start, end)));
    } catch {
      // 非 JSON 块忽略
    }
    index = text.indexOf(marker, end + 3);
  }
  return blocks;
}

function normalizeCategoryKey(key: string): string | null {
  const lower = key.toLowerCase().replace(/[^a-z]/g, '');
  if (lower === 'automated') return 'automated';
  if (lower === 'semiautomated' || lower === 'semi') return 'semiAutomated';
  if (lower === 'manual') return 'manual';
  if (lower === 'nonconvertible' || lower === 'nonconvert' || lower === 'impossible') return 'nonConvertible';
  return null;
}

function compareSubagent(report: Record<string, any>, outDir: string): Record<string, any> {
  const reportPath = join(outDir, 'REPORT.md');
  let text = '';
  try {
    text = readFileSync(reportPath, 'utf8');
  } catch {
    return {
      subagentReport: relPath(process.cwd(), reportPath),
      present: false,
      parsed: false,
      note: '未找到子智能体报告（<out>/REPORT.md），跳过对比；工具报告仍可比对同一分母的 tool-report.json。',
      diffs: [],
    };
  }
  const blocks = extractJsonBlocks(text);
  let machine: Record<string, any> | null = null;
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, any>;
    const source = (record.categories ?? record) as Record<string, any>;
    const keys = Object.keys(source).map(normalizeCategoryKey).filter((key) => key !== null);
    if (keys.length >= 2) {
      machine = source;
      break;
    }
  }
  if (machine === null) {
    return {
      subagentReport: relPath(process.cwd(), reportPath),
      present: true,
      parsed: false,
      note: 'REPORT.md 存在，但未找到含四类数值的 JSON 代码块；无法机器化对比（差异需人工核对）。',
      diffs: [],
    };
  }
  const diffs: Array<Record<string, any>> = [];
  for (const key of CATEGORY_ORDER) {
    let entry: Record<string, any> | null = null;
    for (const [rawKey, value] of Object.entries(machine)) {
      if (normalizeCategoryKey(rawKey) === key && value !== null && typeof value === 'object') {
        entry = value as Record<string, any>;
        break;
      }
    }
    const ours = report.categories[key];
    const subFiles = entry !== null && typeof entry.files === 'number' ? entry.files : null;
    const subPercent = entry !== null && typeof entry.percent === 'number'
      ? entry.percent
      : entry !== null && typeof entry.percentFiles === 'number' ? entry.percentFiles : null;
    diffs.push({
      category: key,
      oursFiles: ours.files,
      subagentFiles: subFiles,
      filesDelta: subFiles === null ? null : ours.files - subFiles,
      oursPercentFiles: ours.percentFiles,
      subagentPercent: subPercent,
      percentDelta: subPercent === null ? null : round2(ours.percentFiles - subPercent),
    });
  }
  const reasons: string[] = [];
  if (diffs.some((diff) => diff.filesDelta !== null && diff.filesDelta !== 0)) {
    reasons.push('分母/规则版本可能不同：本工具分母为 .kt/.java 且排除 test 变体/生成代码（报告 denominator 字段为准）');
    reasons.push('子智能体报告为一次性评估，规则与置信度未版本化；以本工具 ruleVersion=' + report.ruleVersion + ' 的规则为准');
  }
  return {
    subagentReport: relPath(process.cwd(), reportPath),
    present: true,
    parsed: true,
    note: '对比基于 REPORT.md 中的 JSON 代码块（四类 files/percent）；差异原因见 reasons。',
    diffs,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function buildMarkdown(report: Record<string, any>): string {
  const lines: string[] = [];
  lines.push('# 四类转换占比评估（assess-conversion）');
  lines.push('');
  lines.push('- profile: **' + report.profile + '**' + (report.productionOnly ? '（--production-only）' : ''));
  lines.push('- root: ' + report.root);
  lines.push('- lang: ' + report.lang + '  |  rules: ' + report.ruleVersion + '（sha256 ' + report.ruleSha256.slice(0, 12) + '…）');
  lines.push('- 分母: ' + report.denominator.files + ' 文件 / ' + report.denominator.lines + ' 行（仅 .kt/.java；XML 单列）');
  lines.push('- 输入指纹: sha256 ' + report.inputFingerprint.slice(0, 16) + '…  |  empty: ' + report.empty);
  lines.push('');
  lines.push('## 四类占比');
  lines.push('');
  lines.push('| 类别 | 文件 | 文件占比 | 行 | 行占比 | 置信度 |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const key of CATEGORY_ORDER) {
    const summary = report.categories[key];
    const label = key === 'semiAutomated'
      ? 'semi-automated（半自动；candidate，不代表已实现）'
      : CATEGORY_LABELS[key];
    lines.push('| ' + label + ' | ' + summary.files + ' | ' + summary.percentFiles.toFixed(2) + '% | ' +
      summary.lines + ' | ' + summary.percentLines.toFixed(2) + '% | ' + summary.confidence.toFixed(2) + ' |');
  }
  lines.push('| **合计** | **' + report.denominator.files + '** | **' + report.percentTotal.files.toFixed(2) + '%** | **' +
    report.denominator.lines + '** | **' + report.percentTotal.lines.toFixed(2) + '%** | — |');
  lines.push('');
  lines.push('unclassified=' + report.unclassified + '；不变量: ' + JSON.stringify(report.checks));
  lines.push('');
  lines.push('> **semi-automated 口径**：' + report.categories.semiAutomated.disclaimer);
  lines.push('>');
  lines.push('> automated 口径：' + report.categories.automated.disclaimer);
  lines.push('');
  lines.push('## 定义与样本');
  for (const key of CATEGORY_ORDER) {
    const summary = report.categories[key];
    lines.push('');
    lines.push('### ' + CATEGORY_LABELS[key]);
    lines.push('');
    lines.push('- 定义: ' + summary.definition);
    lines.push('- 置信度: ' + summary.confidence);
    if (summary.disclaimer !== null) {
      lines.push('- 免责声明: ' + summary.disclaimer + '（不代表已实证/已实现）');
    }
    if (key === 'semiAutomated' && report.profile === 'broad') {
      lines.push('- 窄耦合: ' + summary.narrowFiles + ' 文件；宽耦合: ' + summary.broadFiles + ' 文件');
    }
    if (summary.samples.length === 0) {
      lines.push('- 样本: （无）');
    } else {
      lines.push('- 样本:');
      for (const sample of summary.samples) {
        lines.push('  - ' + sample.path + '（' + sample.lines + ' 行' +
          (sample.rules.length > 0 ? '；规则: ' + sample.rules.join(', ') : '') +
          (sample.narrow === undefined ? '' : '；narrow=' + sample.narrow) + '）');
      }
    }
  }
  lines.push('');
  lines.push('## Funnel（优先级剥离）');
  lines.push('');
  lines.push('| 阶段 | 剩余文件 | 剩余行 |');
  lines.push('|---|---:|---:|');
  for (const stage of report.funnel) lines.push('| ' + stage.stage + ' | ' + stage.files + ' | ' + stage.lines + ' |');
  lines.push('');
  lines.push('## 排除与 XML（不进分母）');
  lines.push('');
  lines.push('- 排除文件: ' + report.denominator.excluded.files + ' 文件 / ' + report.denominator.excluded.lines + ' 行');
  for (const bucket of report.denominator.excluded.byReason) {
    lines.push('  - ' + bucket.reason + ': ' + bucket.files + ' 文件 / ' + bucket.lines + ' 行' +
      (bucket.samples.length > 0 ? '（例: ' + bucket.samples.slice(0, 3).join(', ') + '）' : ''));
  }
  if (report.denominator.excluded.skippedDirs.length > 0) {
    lines.push('  - 整目录未计入: ' + report.denominator.excluded.skippedDirs.slice(0, 10).join('；') +
      (report.denominator.excluded.skippedDirs.length > 10 ? ' … 共 ' + report.denominator.excluded.skippedDirs.length + ' 项' : ''));
  }
  lines.push('- XML 单列: ' + report.xml.files + ' 文件 / ' + report.xml.lines + ' 行（不进分母）');
  lines.push('');
  lines.push('## 与 analyze-coupling auto 的一致性');
  lines.push('');
  const consistency = report.consistency.analyzeCoupling;
  lines.push('- analyze-coupling 口径 auto（本分母内）: ' + consistency.analyzeAutoFiles + ' 文件 / ' + consistency.analyzeAutoLines + ' 行');
  lines.push('- 本工具 automated: ' + consistency.automatedFiles + ' 文件（其中 ' + consistency.automatedInAnalyzeAuto + ' 文件在 analyze auto 内）');
  lines.push('- automated 超出 analyze auto: ' + consistency.automatedNotInAnalyzeAuto.length + '（必须为 0）');
  lines.push('- 其中 annotation-only 平台 import（conservative 允许）: ' + (report.checks.automatedAnnotationOnlyPlatform ?? 0) + ' 文件');
  lines.push('- analyze auto 但被判 non-automated: ' + consistency.analyzeAutoNotAutomatedFiles + ' 文件 / ' + consistency.analyzeAutoNotAutomatedLines + ' 行；分类分布: ' + JSON.stringify(consistency.analyzeAutoNotAutomatedByCategory));
  lines.push('- 说明: ' + consistency.note);
  lines.push('');
  const comparison = report.comparison;
  if (report.profile === 'conservative' && comparison !== null && comparison.categories !== undefined) {
    lines.push('## 与独立子智能体严格口径对比（conservative）');
    lines.push('');
    lines.push('- reference: ' + comparison.source + '；允许逐类行占比误差 ≤ ' + comparison.tolerancePt + 'pt');
    lines.push('- 分母: 本工具 ' + comparison.denominator.oursFiles + ' 文件 / ' + comparison.denominator.oursLines +
      ' 行；ref ' + comparison.denominator.refFiles + ' 文件 / ' + comparison.denominator.refLines +
      ' 行；Δ文件 ' + (comparison.denominator.deltaFiles ?? '—') + '，Δ行 ' + (comparison.denominator.deltaLines ?? '—'));
    lines.push('');
    lines.push('| 类别 | 本工具文件 | ref 文件 | Δ文件 | 本工具行 | ref 行 | Δ行 | 本工具% | ref% | Δpt | 判定 |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const diff of comparison.categories) {
      lines.push('| ' + diff.category + ' | ' + diff.oursFiles + ' | ' + (diff.refFiles ?? '—') + ' | ' +
        (diff.deltaFiles ?? '—') + ' | ' + diff.oursLines + ' | ' + (diff.refLines ?? '—') + ' | ' +
        (diff.deltaLines ?? '—') + ' | ' + diff.oursPercent.toFixed(2) + '% | ' +
        (diff.refPercent === null ? '—' : diff.refPercent.toFixed(2) + '%') + ' | ' +
        (diff.deltaPt === null ? '—' : diff.deltaPt.toFixed(2)) + ' | ' + (diff.pass ? 'PASS' : 'FAIL') + ' |');
    }
    lines.push('');
    lines.push('- withinTolerance: **' + comparison.withinTolerance + '**' +
      (comparison.classReferenceApplicable ? '' : '（--production-only：仅校对分母，不判逐类）'));
    lines.push('- 差异文件 top N（本工具侧样本；子智能体逐文件标签不可得）:');
    for (const key of CATEGORY_ORDER) {
      const samples = comparison.fileDiffTop[key] ?? [];
      lines.push('  - ' + key + ': ' + (samples.length === 0 ? '（无）'
        : samples.map((sample: any) => sample.path + '(' + sample.lines + ')').join(', ')));
    }
    lines.push('- 说明: ' + comparison.note);
    lines.push('');
  } else {
  lines.push('## 与子智能体报告对比');
  lines.push('');
  if (comparison === null || comparison.present === false) {
    lines.push('- ' + (comparison === null ? '未执行对比。' : comparison.note));
  } else if (comparison.parsed === true) {
    lines.push('- 报告: ' + comparison.subagentReport);
    lines.push('| 类别 | 本工具文件 | 子智能体文件 | Δ文件 | 本工具% | 子智能体% | Δ% |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const diff of comparison.diffs) {
      lines.push('| ' + diff.category + ' | ' + diff.oursFiles + ' | ' + (diff.subagentFiles ?? '—') + ' | ' +
        (diff.filesDelta ?? '—') + ' | ' + diff.oursPercentFiles.toFixed(2) + '% | ' +
        (diff.subagentPercent === null ? '—' : diff.subagentPercent.toFixed(2) + '%') + ' | ' +
        (diff.percentDelta === null ? '—' : diff.percentDelta.toFixed(2)) + ' |');
    }
    for (const reason of comparison.reasons) lines.push('- 原因: ' + reason);
  } else {
    lines.push('- 报告: ' + comparison.subagentReport + '（存在，' + comparison.note + '）');
  }
  }
  lines.push('');
  lines.push('## 复跑');
  lines.push('');
  lines.push('    node cli/assess-conversion.ts --root ' + report.root + ' --lang ' + report.lang +
    ' --profile ' + report.profile + (report.productionOnly ? ' --production-only' : '') + ' --out <dir>');
  lines.push('');
  lines.push('规则版本 ' + report.ruleVersion + '；同输入两次输出逐字节一致（无时间戳；输入指纹 ' + report.inputFingerprint + '）。');
  lines.push('');
  return lines.join('\n');
}

function humanLines(report: Record<string, any>, jsonPath: string, mdPath: string): string[] {
  const lines: string[] = [];
  lines.push('assess-conversion  root=' + report.root + '  lang=' + report.lang + '  profile=' + report.profile +
    (report.productionOnly ? '(production-only)' : '') + '  rules=' + report.ruleVersion + '  empty=' + report.empty);
  lines.push('分母 ' + report.denominator.files + ' 文件 / ' + report.denominator.lines + ' 行' +
    '（排除 ' + report.denominator.excluded.files + ' 文件 / ' + report.denominator.excluded.lines + ' 行；XML 单列 ' +
    report.xml.files + ' 文件）');
  for (const key of CATEGORY_ORDER) {
    const summary = report.categories[key];
    lines.push(CATEGORY_LABELS[key].replace('（自动）', '').padEnd(26) + ' ' +
      String(summary.files).padStart(5) + ' 文件 (' + summary.percentFiles.toFixed(2) + '%)  ' +
      String(summary.lines).padStart(7) + ' 行 (' + summary.percentLines.toFixed(2) + '%)  置信度 ' + summary.confidence.toFixed(2) +
      (key === 'semiAutomated' && report.profile === 'broad' ? '  窄/宽 ' + summary.narrowFiles + '/' + summary.broadFiles : ''));
  }
  const consistency = report.consistency.analyzeCoupling;
  lines.push('合计 ' + report.percentTotal.files.toFixed(2) + '% / ' + report.percentTotal.lines.toFixed(2) +
    '%；unclassified=' + report.unclassified + '；analyze auto 超集检查: automated 超出 ' + consistency.automatedNotInAnalyzeAuto.length +
    '，analyze auto 被判非 auto ' + consistency.analyzeAutoNotAutomatedFiles + ' 文件');
  if (report.profile === 'conservative' && report.comparison !== null && report.comparison.categories !== undefined) {
    const diffs = report.comparison.categories.map((diff: any) => diff.category + ' Δ' +
      (diff.deltaPt === null ? '—' : diff.deltaPt.toFixed(2) + 'pt')).join(' / ');
    lines.push('与严格口径对比: ' + diffs + '；' + (report.comparison.withinTolerance ? 'PASS' : 'FAIL') +
      '（≤' + report.comparison.tolerancePt + 'pt）');
  }
  lines.push('结果: ' + (report.ok ? 'OK' : 'INVARIANT-VIOLATION') + '（exit ' + (report.ok ? 0 : 1) + '）');
  lines.push('报告: ' + jsonPath + ' / ' + mdPath);
  return lines;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main(): void {
  const raw = parseCliArgs(process.argv.slice(2));
  if (raw.help === true) {
    console.log(USAGE);
    process.exit(0);
  }
  const { rules, sha } = loadRules();
  const cwd = process.cwd();

  const rootArg = optional(raw, 'root');
  if (rootArg === null) failUsage('缺少 --root（要评估的源码仓库根）');
  const rootAbs = resolve(cwd, rootArg);
  if (!isDirectory(rootAbs)) failUsage('--root 目录不存在：' + rootArg);

  const lang = optional(raw, 'lang');
  if (lang === null) failUsage('缺少 --lang（当前支持 jvm）');
  const jvm = rules.languages[lang];
  if (jvm === undefined) failUsage('暂不支持 --lang ' + lang + '（可用：' + Object.keys(rules.languages).join(', ') + '）');

  const profileArg = optional(raw, 'profile') ?? 'conservative';
  if (profileArg !== 'broad' && profileArg !== 'conservative') {
    failUsage('--profile 只支持 broad | conservative（收到 ' + profileArg + '）');
  }
  const profile: Profile = profileArg;
  const productionOnly = raw['production-only'] === true;

  const outArg = optional(raw, 'out') ?? DEFAULT_OUT;
  const outAbs = resolve(cwd, outArg);
  if (isWithin(outAbs, rootAbs)) {
    failUsage('--out 不能等于或位于 --root 内（评估只读上游，不改仓库）：--out=' + outArg + '，--root=' + rootArg);
  }
  const outDir = outAbs;
  if (profile === 'conservative' && (jvm as any).conservative?.reference === undefined) {
    failUsage('规则文件缺少 conservative profile/reference（需要 rules v1.1；请勿混用 v1.0 rules 与新 CLI）');
  }
  const scanOptions: ScanOptions = { includeTestVariants: profile === 'conservative', productionOnly };
  const scan = scanRepo(rootAbs, jvm, profile, scanOptions);
  const reference = profile === 'conservative' ? resolveConservativeReference(outDir, jvm, productionOnly) : null;
  const report = buildReport(rootArg, rootAbs, rules, sha, scan, profile, scanOptions, reference);
  if (profile === 'broad') report.comparison = compareSubagent(report, outDir);

  const jsonText = JSON.stringify(report, null, 2) + '\n';
  const mdText = buildMarkdown(report);
  const reportBase = profile === 'conservative' ? 'conservative-report' : 'tool-report';
  const jsonPath = join(outDir, reportBase + '.json');
  const mdPath = join(outDir, reportBase + '.md');
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(jsonPath, jsonText, 'utf8');
    writeFileSync(mdPath, mdText, 'utf8');
  } catch (error) {
    failUsage('无法写报告到 ' + outArg + '：' + errorMessage(error));
  }

  const jsonOut = raw.json === true;
  const mdOut = raw.md === true;
  if (jsonOut) process.stdout.write(jsonText);
  if (jsonOut && mdOut) console.log('');
  if (mdOut) process.stdout.write(mdText);
  if (!jsonOut && !mdOut) console.log(humanLines(report, relPath(cwd, jsonPath), relPath(cwd, mdPath)).join('\n'));

  process.exitCode = report.ok ? 0 : 1;
}

try {
  main();
} catch (error) {
  console.error('assess-conversion: 内部错误：' + errorMessage(error));
  process.exitCode = 1;
}
