#!/usr/bin/env node
/**
 * canonical metrics + 文档数字一致性检查。
 *
 * 背景：项目已有 10 处文档数字漂移（docs/tooling-backlog.md §9）。本工具从真值文件
 * 重算 canonical 数字，并用 --check 扫描文档里的数字声明，把漂移变成可检测的 file:line。
 *
 * 用法：
 *   node cli/docs-metrics.ts --case cases/legado [--refs <dir>] [--coverage <json>]
 *        [--check README.md,HANDOFF.md] [--json] [--report <path.json>]
 *
 * 退出码：0 = 计算成功（无 --check 或有 --check 且无 mismatch）；1 = --check 有 mismatch；
 *         2 = 用法/读取失败。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_USAGE = 2;

const ERRORS_JSON_PREFERRED = 'arkts-adapt-errors-with-full-reachability.json';

const USAGE = [
  '用法：',
  '  node cli/docs-metrics.ts --case cases/legado [--refs <dir>] [--coverage <json>]',
  '       [--check README.md,HANDOFF.md] [--json] [--report <path.json>]',
  '',
  '从真值文件重算 canonical 数字（无时间戳，同输入同输出）：',
  '  case（必算）       golden/actual 的场景数、页数、逐项保真度、actual md5',
  '  --refs             baseline（arkts-adapt-baseline）文件数/物理行数、',
  '                     adapted（pag-exp/ts）文件数/物理行数、',
  '                     pag-exp/src 的 .kt 文件数/行数（含 Main.kt 与模块数）、',
  '                     错误 JSON 总数（硬错误/WARN 拆分 + code 直方图）、',
  '                     codemod 计数（Options/Patch/as const/改名组；计数跳过注释行）',
  '  --coverage         读取 analyze-coupling --json 的输出（files/totalLoc/autoConvertiblePct/verdict）',
  '',
  '--check 扫描文档里的 canonical 数字声明，不一致时输出 file:line + 原文片段 + expected/actual。',
  '覆盖 8 组已知漂移：覆盖率、ArkTS 错误口径（178=硬177+WARN1 同行可解析）、闭包文件/行数、',
  'TS 产物（转写→baseline / 适配→adapted 按关键词分流）、保真 62/62、',
  'codemod 计数（Options/Patch/改名/as const）、构建+签名、改名组数。',
  '',
  '输出：--json 把 canonical JSON 打 stdout；--report 写同一份 JSON；否则人类摘要 ≤15 行。',
  '',
  '退出码：0 = 计算成功（无 --check 或有 --check 且无 mismatch）；1 = --check 有 mismatch；',
  '        2 = 用法/读取失败',
  '',
  '示例：',
  '  node cli/docs-metrics.ts --case cases/legado --refs /path/.refs \\',
  '       --coverage out/coverage.json --check README.md,HANDOFF.md --json',
].join('\n');

interface RawCli {
  [key: string]: string | boolean;
}

interface CaseMetrics {
  dir: string;
  golden: { scenarios: number; pages: number };
  actual: { scenarios: number; pages: number };
  fidelityPct: number;
  fidelityEqual: boolean;
  actualMd5: string;
}

interface CountMetrics {
  files: number;
  lines: number;
}

interface ClosureMetrics extends CountMetrics {
  moduleFiles: number;
  moduleLines: number;
}

interface ErrorsMetrics {
  file: string;
  total: number;
  hard: number;
  warn: number;
  byCode: { code: string; count: number }[];
}

interface CodemodMetrics {
  options: number;
  patches: number;
  asConst: number;
  renamePairs: number;
  renamedTypeAliases: number;
  renamedValueDeclarations: number;
}

interface RefsMetrics {
  dir: string;
  baseline: CountMetrics | null;
  adapted: CountMetrics | null;
  src: ClosureMetrics | null;
  errors: ErrorsMetrics | null;
  codemod: CodemodMetrics | null;
}

interface CoverageMetrics {
  files: number;
  totalLoc: number;
  autoConvertiblePct: number;
  verdict: string;
}

interface Claim {
  label: string;
  expected: number | string;
  actual: number | string;
  kind: 'int' | 'percent' | 'text';
  approx: boolean;
}

interface Mismatch {
  file: string;
  line: number;
  group: string;
  label: string;
  expected: number | string;
  actual: number | string;
  snippet: string;
}

interface CheckReport {
  files: string[];
  linesScanned: number;
  claims: number;
  mismatches: Mismatch[];
  /** 至少产出一条声明（被检查到）的组 */
  groupsHit: string[];
  /** 至少有一处不一致的组 */
  groupsMismatched: string[];
  skipped: string[];
}

interface Metrics {
  case: CaseMetrics;
  refs: RefsMetrics | null;
  coverage: CoverageMetrics | null;
}

interface Rule {
  group: string;
  pattern: RegExp;
  evaluate: (line: string, match: RegExpExecArray, metrics: Metrics) => Claim[] | null;
}

// ---------------------------------------------------------------------------
// 参数解析：任何用法错误 → exit 2
// ---------------------------------------------------------------------------

function failUsage(message: string): never {
  console.error('docs-metrics: ' + message);
  console.error('用法见：node cli/docs-metrics.ts --help');
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
      if (!isValueOpt(key)) failUsage('未知参数：--' + key);
      if (value === '') failUsage('参数 --' + key + ' 不能为空');
      raw[key] = value;
      continue;
    }
    const key = token.slice(2);
    if (key === 'json' || key === 'help') {
      raw[key] = true;
      continue;
    }
    if (!isValueOpt(key)) failUsage('未知参数：--' + key);
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) {
      failUsage('参数 --' + key + ' 缺少取值');
    }
    raw[key] = next;
    i++;
  }
  return raw;
}

function isValueOpt(key: string): boolean {
  return ['case', 'refs', 'coverage', 'check', 'report', 'logs'].indexOf(key) >= 0;
}

function optional(raw: RawCli, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' ? value : null;
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

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    failUsage('读取失败：' + path + '（' + errorMessage(error) + '）');
  }
}

/** wc -l 口径：数换行符个数 */
function countLines(buffer: Buffer): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) count++;
  }
  return count;
}

function listFiles(dir: string, recursive: boolean, extFilter: string[] | null, out: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) listFiles(full, recursive, extFilter, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extFilter !== null && !extFilter.some((ext) => entry.name.endsWith(ext))) continue;
    out.push(full);
  }
  out.sort();
  return out;
}

function md5(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function oneLine(text: string, max = 200): string {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

function parseNumber(text: string): number {
  return Number(text.replace(/[,，\s]/g, ''));
}

function formatNumber(value: number): string {
  if (!Number.isInteger(value)) return String(value);
  return value.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// canonical metrics：case
// ---------------------------------------------------------------------------

function countPages(records: unknown[]): number {
  let pages = 0;
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const items = (record as Record<string, unknown>).pages;
    if (Array.isArray(items)) pages += items.length;
  }
  return pages;
}

function loadCase(caseDir: string, displayDir: string): CaseMetrics {
  const goldenPath = join(caseDir, 'golden.json');
  const actualPath = join(caseDir, 'actual.json');
  if (!isFile(goldenPath) || !isFile(actualPath)) {
    failUsage('案例缺少 golden.json 或 actual.json：' + caseDir);
  }
  const goldenBuffer = readFileSync(goldenPath);
  const actualBuffer = readFileSync(actualPath);
  let golden: unknown;
  let actual: unknown;
  try {
    golden = JSON.parse(goldenBuffer.toString('utf8'));
    actual = JSON.parse(actualBuffer.toString('utf8'));
  } catch (error) {
    failUsage('案例 JSON 解析失败：' + errorMessage(error));
  }
  if (!Array.isArray(golden) || !Array.isArray(actual)) {
    failUsage('golden.json / actual.json 顶层必须是数组');
  }
  const goldenRecords = golden as Record<string, unknown>[];
  const actualRecords = actual as Record<string, unknown>[];

  const actualByKey = new Map<string, Record<string, unknown>>();
  for (const record of actualRecords) {
    if (record === null || typeof record !== 'object') continue;
    actualByKey.set(String(record.scenario), record);
  }
  let totalItems = 0;
  let sameItems = 0;
  for (const expected of goldenRecords) {
    const found = actualByKey.get(String(expected.scenario));
    if (found === undefined) continue;
    const goldenPages = Array.isArray(expected.pages) ? (expected.pages as Record<string, unknown>[]) : [];
    const actualPages = Array.isArray(found.pages) ? (found.pages as Record<string, unknown>[]) : [];
    const length = Math.max(goldenPages.length, actualPages.length);
    for (let index = 0; index < length; index++) {
      totalItems++;
      const goldenText = goldenPages[index]?.text;
      const actualText = actualPages[index]?.text;
      if (goldenText !== undefined && actualText !== undefined && goldenText === actualText) sameItems++;
    }
  }
  const fidelityPct = totalItems === 0 ? 0 : round2((sameItems * 100) / totalItems);

  return {
    dir: displayDir,
    golden: { scenarios: goldenRecords.length, pages: countPages(goldenRecords) },
    actual: { scenarios: actualRecords.length, pages: countPages(actualRecords) },
    fidelityPct,
    fidelityEqual: fidelityPct === 100 && sameItems === totalItems && totalItems > 0,
    actualMd5: md5(actualBuffer),
  };
}

// ---------------------------------------------------------------------------
// canonical metrics：refs
// ---------------------------------------------------------------------------

function loadCountMetrics(dir: string, extFilter: string[] | null): CountMetrics | null {
  if (!isDirectory(dir)) return null;
  const files = listFiles(dir, true, extFilter);
  let lines = 0;
  for (const file of files) {
    try {
      lines += countLines(readFileSync(file));
    } catch {
      // 单文件读失败不致命
    }
  }
  return { files: files.length, lines };
}

function loadClosureMetrics(dir: string): ClosureMetrics | null {
  if (!isDirectory(dir)) return null;
  const files = listFiles(dir, true, ['.kt']);
  let lines = 0;
  let moduleFiles = 0;
  let moduleLines = 0;
  for (const file of files) {
    let fileLines = 0;
    try {
      fileLines = countLines(readFileSync(file));
    } catch {
      // 忽略
    }
    lines += fileLines;
    if (basename(file) !== 'Main.kt') {
      moduleFiles++;
      moduleLines += fileLines;
    }
  }
  return { files: files.length, lines, moduleFiles, moduleLines };
}

function loadErrorsMetrics(refsDir: string): ErrorsMetrics | null {
  let errorsPath = join(refsDir, ERRORS_JSON_PREFERRED);
  if (!isFile(errorsPath)) {
    const candidates = listFiles(refsDir, false, ['.json']).filter((file) => /error/i.test(basename(file)));
    if (candidates.length === 0) return null;
    errorsPath = candidates[0];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(errorsPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = parsed as Record<string, unknown>[];
  const histogram = new Map<string, number>();
  let warn = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const code = String(row.code ?? 'unknown');
    histogram.set(code, (histogram.get(code) ?? 0) + 1);
    if (row.file === '?' && code === 'arkts-no-globalthis') warn++;
  }
  const byCode = [...histogram.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => (b.count - a.count) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { file: errorsPath, total: rows.length, hard: rows.length - warn, warn, byCode };
}

/** 注释行不参与代码计数：去掉行首空白后以 // 、* 、/* 开头的行都跳过 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function codeLines(file: string): string[] | null {
  let source = '';
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return source.split('\n').filter((line) => !isCommentLine(line));
}

function loadCodemodMetrics(baselineDir: string, adaptedDir: string): CodemodMetrics | null {
  if (!isDirectory(baselineDir)) return null;
  let options = 0;
  let patches = 0;
  let asConst = 0;
  const typeNames = new Set<string>();
  const constNames = new Set<string>();
  for (const file of listFiles(baselineDir, true, ['.ts'])) {
    const lines = codeLines(file);
    if (lines === null) continue;
    for (const line of lines) {
      options += (line.match(/constructor\s*\(\s*options\s*:/g) ?? []).length;
      patches += (line.match(/copy\s*\(\s*patch\s*:\s*Partial\s*</g) ?? []).length;
      asConst += (line.match(/\bas\s+const\b/g) ?? []).length;
      for (const match of line.matchAll(/export\s+type\s+([A-Za-z0-9_]+)/g)) typeNames.add(match[1]);
      for (const match of line.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*\{/g)) constNames.add(match[1]);
    }
  }
  let renamePairs = 0;
  for (const name of typeNames) {
    if (constNames.has(name)) renamePairs++;
  }
  // 适配产物里的 XxxValue 声明：export type 是 type alias，export interface 是类型声明，两者都算
  const aliases = new Set<string>();
  const declarations = new Set<string>();
  if (isDirectory(adaptedDir)) {
    for (const file of listFiles(adaptedDir, true, ['.ts'])) {
      const lines = codeLines(file);
      if (lines === null) continue;
      for (const line of lines) {
        for (const match of line.matchAll(/export\s+type\s+([A-Za-z0-9_]+Value)\b/g)) aliases.add(match[1]);
        for (const match of line.matchAll(/export\s+(?:type|interface)\s+([A-Za-z0-9_]+Value)\b/g)) declarations.add(match[1]);
      }
    }
  }
  return {
    options,
    patches,
    asConst,
    renamePairs,
    renamedTypeAliases: aliases.size,
    renamedValueDeclarations: declarations.size,
  };
}

function loadRefs(refsDir: string, displayDir: string): RefsMetrics {
  if (!isDirectory(refsDir)) failUsage('--refs 目录不存在：' + displayDir);
  const baselineDir = join(refsDir, 'arkts-adapt-baseline');
  const adaptedDir = join(refsDir, 'pag-exp', 'ts');
  const srcDir = join(refsDir, 'pag-exp', 'src');
  return {
    dir: displayDir,
    baseline: loadCountMetrics(baselineDir, null),
    adapted: loadCountMetrics(adaptedDir, null),
    src: loadClosureMetrics(srcDir),
    errors: loadErrorsMetrics(refsDir),
    codemod: loadCodemodMetrics(baselineDir, adaptedDir),
  };
}

function loadCoverage(coveragePath: string): CoverageMetrics {
  if (!isFile(coveragePath)) failUsage('--coverage 文件不存在：' + coveragePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(coveragePath, 'utf8'));
  } catch (error) {
    failUsage('--coverage JSON 解析失败：' + errorMessage(error));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failUsage('--coverage 顶层必须是对象（analyze-coupling --json 输出）');
  }
  const record = parsed as Record<string, unknown>;
  const files = Number(record.files);
  const totalLoc = Number(record.totalLoc);
  const autoConvertiblePct = Number(record.autoConvertiblePct);
  if (!Number.isFinite(files) || !Number.isFinite(totalLoc) || !Number.isFinite(autoConvertiblePct)) {
    failUsage('--coverage 缺少 files/totalLoc/autoConvertiblePct 字段');
  }
  return {
    files,
    totalLoc,
    autoConvertiblePct,
    verdict: typeof record.verdict === 'string' ? record.verdict : '',
  };
}

// ---------------------------------------------------------------------------
// --check：8 组已知漂移的声明规则
// ---------------------------------------------------------------------------

const FILES_LINES = /([\d,，]+)\s*(?:个)?\s*文件\s*[\/／]\s*(?:约\s*)?([\d,，]+)\s*行/;
const PERCENT = /([\d.]+)\s*%/;
/** 策略/阈值行（覆盖率 <15% 不做自动转换、verdict=low 等）不是数字声明，不能当漂移 */
const COVERAGE_POLICY = /阈值|门槛|低于|不足|不做|放弃|不要投入|策略|verdict/i;

/** 从一行里取「真正的覆盖率数字」：覆盖率 13.1% / 13%（2,108 文件…）；阈值行返回 null */
function coveragePercentOf(line: string): number | null {
  if (COVERAGE_POLICY.test(line)) return null;
  const declaration = /(?:可自动)?覆盖率[^\d%<>≤≥]{0,8}?([\d.]+)\s*%/.exec(line) ??
    /([\d.]+)\s*%\s*（\s*[\d,，]+\s*文件/.exec(line);
  if (!declaration) return null;
  return Number(declaration[1]);
}

function ensureRefs(metrics: Metrics): RefsMetrics | null {
  return metrics.refs;
}

/** 每个检查组依赖哪些 canonical 数据；缺了就跳过（而不是把「该行不适用」误报成缺数据） */
const GROUP_REQUIRES: Record<string, string | null> = {
  coverage: 'coverage',
  errors: 'refs.errors',
  closure: 'refs.src',
  ts: 'refs',
  fidelity: 'case',
  codemod: 'refs.codemod',
  rename: 'refs.codemod',
  sign: null,
};

function hasMetric(metrics: Metrics, requires: string | null): boolean {
  if (requires === null) return true;
  if (requires === 'case') return true;
  if (requires === 'coverage') return metrics.coverage !== null;
  const refs = metrics.refs;
  if (refs === null) return false;
  if (requires === 'refs') return true;
  if (requires === 'refs.errors') return refs.errors !== null;
  if (requires === 'refs.src') return refs.src !== null;
  if (requires === 'refs.ts') return refs.ts !== null;
  if (requires === 'refs.codemod') return refs.codemod !== null;
  return true;
}

const RULES: Rule[] = [
  // 1) 覆盖率：文件数/行数（同一行还要有覆盖率/耦合语境）
  {
    group: 'coverage',
    pattern: FILES_LINES,
    evaluate: (line, match, metrics) => {
      if (metrics.coverage === null) return null;
      if (COVERAGE_POLICY.test(line)) return [];
      if (!/覆盖率|可自动|耦合/.test(line)) return null;
      return [
        { label: '覆盖率文件数', expected: metrics.coverage.files, actual: parseNumber(match[1]), kind: 'int', approx: false },
        { label: '覆盖率行数', expected: metrics.coverage.totalLoc, actual: parseNumber(match[2]), kind: 'int', approx: /约/.test(line) },
      ];
    },
  },
  // 1b) 覆盖率百分比：只认真正的覆盖率声明（覆盖率 13.1% / **13%（2,108 文件…））；
  //     阈值/策略行（覆盖率 <15% 不做自动转换、verdict=low（<15%））直接跳过
  {
    group: 'coverage',
    pattern: PERCENT,
    evaluate: (line, _match, metrics) => {
      if (metrics.coverage === null) return null;
      const actual = coveragePercentOf(line);
      if (actual === null) return [];
      return [
        {
          label: '自动覆盖率',
          expected: metrics.coverage.autoConvertiblePct,
          actual,
          kind: 'percent',
          approx: false,
        },
      ];
    },
  },
  // 2) ArkTS 错误口径：明确写「全量」的表格行 / 叙述
  {
    group: 'errors',
    pattern: /全量[^|\n]*\|\s*\*{0,2}([\d,，]+)/,
    evaluate: (_line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.errors === null) return null;
      return [
        { label: '全量 ArkTS 错误数', expected: refs.errors.total, actual: parseNumber(match[1]), kind: 'int', approx: false },
      ];
    },
  },
  {
    group: 'errors',
    pattern: /([\d,，]+)\s*处错误[^\n]*机械/,
    evaluate: (_line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.errors === null) return null;
      return [
        { label: '全量 ArkTS 错误数', expected: refs.errors.total, actual: parseNumber(match[1]), kind: 'int', approx: false },
      ];
    },
  },
  // 2b) 「178 条原始（硬 177 + 1 WARN）」这类同行多口径：分别解析 total/hard/warn
  {
    group: 'errors',
    pattern: /([\d,，]+)\s*(?:条|处)\s*(?:原始)?[^\n]*?硬\s*(\d[\d,]*)/,
    evaluate: (line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.errors === null) return null;
      if (!/错误|WARN|原始/.test(line)) return null;
      return [
        { label: '全量 ArkTS 错误数', expected: refs.errors.total, actual: parseNumber(match[1]), kind: 'int', approx: false },
        { label: '硬错误数', expected: refs.errors.hard, actual: parseNumber(match[2]), kind: 'int', approx: false },
      ];
    },
  },
  {
    group: 'errors',
    pattern: /(\d[\d,，]*)\s*(?:条\s*)?(?:无位置\s*)?WARN/i,
    evaluate: (line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.errors === null) return null;
      if (!/原始|硬|全量/.test(line)) return null;
      return [
        { label: 'WARN 数', expected: refs.errors.warn, actual: parseNumber(match[1]), kind: 'int', approx: false },
      ];
    },
  },
  // 3) 闭包：模块文件数/行数（不含 Main.kt）
  {
    group: 'closure',
    pattern: FILES_LINES,
    evaluate: (line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.src === null) return null;
      if (!/闭包/.test(line)) return null;
      return [
        { label: '闭包文件数', expected: refs.src.moduleFiles, actual: parseNumber(match[1]), kind: 'int', approx: false },
        { label: '闭包行数', expected: refs.src.moduleLines, actual: parseNumber(match[2]), kind: 'int', approx: /约/.test(line) },
      ];
    },
  },
  // 4) TS 产物：按行内关键词分流到 baseline（转写）或 adapted（适配产物）
  {
    group: 'ts',
    pattern: FILES_LINES,
    evaluate: (line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null) return null;
      const files = parseNumber(match[1]);
      const lines = parseNumber(match[2]);
      const approx = /约/.test(line);
      if (/适配产物|ArkTS\s*产物|(?:^|[^A-Za-z0-9_])ets(?:[^A-Za-z0-9_]|$)/i.test(line)) {
        if (refs.adapted === null) return [];
        return [
          { label: '适配产物文件数', expected: refs.adapted.files, actual: files, kind: 'int', approx: false },
          { label: '适配产物行数', expected: refs.adapted.lines, actual: lines, kind: 'int', approx },
        ];
      }
      if (/转写产物|语义转写|Node\s*重放/i.test(line)) {
        if (refs.baseline === null) return [];
        return [
          { label: '转写产物文件数', expected: refs.baseline.files, actual: files, kind: 'int', approx: false },
          { label: '转写产物行数', expected: refs.baseline.lines, actual: lines, kind: 'int', approx },
        ];
      }
      return [];
    },
  },
  // 5) 保真度：页数比 + 场景数
  {
    group: 'fidelity',
    pattern: /([\d,，]+)\s*[\/／]\s*([\d,，]+)/,
    evaluate: (line, match, metrics) => {
      if (!/保真|逐字全等/.test(line)) return null;
      const expected = metrics.case.golden.pages;
      return [
        {
          label: '保真页数',
          expected: expected + '/' + expected,
          actual: parseNumber(match[1]) + '/' + parseNumber(match[2]),
          kind: 'text',
          approx: false,
        },
      ];
    },
  },
  {
    group: 'fidelity',
    pattern: /([\d,，]+)\s*(?:个)?\s*场景/,
    evaluate: (line, match, metrics) => {
      if (!/保真|逐字全等/.test(line)) return null;
      return [
        {
          label: '场景数',
          expected: metrics.case.golden.scenarios,
          actual: parseNumber(match[1]),
          kind: 'int',
          approx: false,
        },
      ];
    },
  },
  // 6) codemod：Options / Patch / as const（文档里带反引号，\x60 兼容）
  {
    group: 'codemod',
    pattern: /([\d,，]+)\s*个\s*\x60?XxxOptions\x60?/,
    evaluate: (_line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.codemod === null) return null;
      return [{ label: 'XxxOptions 数', expected: refs.codemod.options, actual: parseNumber(match[1]), kind: 'int', approx: false }];
    },
  },
  {
    group: 'codemod',
    pattern: /([\d,，]+)\s*个\s*\x60?XxxPatch\x60?/,
    evaluate: (_line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.codemod === null) return null;
      return [{ label: 'XxxPatch 数', expected: refs.codemod.patches, actual: parseNumber(match[1]), kind: 'int', approx: false }];
    },
  },
  {
    group: 'codemod',
    pattern: /([\d,，]+)\s*处\s*\x60?as\s+const\x60?/i,
    evaluate: (_line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.codemod === null) return null;
      return [{ label: 'as const 数', expected: refs.codemod.asConst, actual: parseNumber(match[1]), kind: 'int', approx: false }];
    },
  },
  // 8) 类型改名组数：canonical = adapted 里实际产出的 XxxValue 声明数（type + interface）
  {
    group: 'rename',
    pattern: /([\d,，]+)\s*(?:组|对)(?:类型)?改名/,
    evaluate: (_line, match, metrics) => {
      const refs = ensureRefs(metrics);
      if (refs === null || refs.codemod === null) return null;
      return [
        {
          label: '类型改名组数',
          expected: refs.codemod.renamedValueDeclarations,
          actual: parseNumber(match[1]),
          kind: 'int',
          approx: false,
        },
      ];
    },
  },
  // 7) 「构建 + 签名」：build-hap 产出的是 unsigned HAP
  {
    group: 'sign',
    pattern: /构建\s*[+＋]\s*签名/,
    evaluate: () => [
      {
        label: '构建产物是否签名',
        expected: '仅构建（unsigned HAP，不签名）',
        actual: '构建 + 签名',
        kind: 'text',
        approx: false,
      },
    ],
  },
];

function claimMatches(claim: Claim): boolean {
  if (claim.kind === 'text') return String(claim.expected) === String(claim.actual);
  const expected = Number(claim.expected);
  const actual = Number(claim.actual);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return String(claim.expected) === String(claim.actual);
  if (claim.kind === 'percent') return Math.abs(expected - actual) <= 0.05;
  const tolerance = claim.approx ? Math.max(5, Math.round(expected * 0.02)) : 0;
  return Math.abs(expected - actual) <= tolerance;
}

function scanDocs(files: string[], cwd: string, metrics: Metrics): CheckReport {
  const mismatches: Mismatch[] = [];
  const groupsHit = new Set<string>();
  const groupsMismatched = new Set<string>();
  const skipped: string[] = [];
  let linesScanned = 0;
  let claims = 0;

  for (const rawFile of files) {
    const path = resolve(cwd, rawFile);
    if (!isFile(path)) failUsage('--check 文件不存在：' + rawFile);
    const text = readText(path);
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].replace(/\r$/, '');
      if (line.trim() === '') continue;
      linesScanned++;
      for (const rule of RULES) {
        const requires = GROUP_REQUIRES[rule.group] ?? null;
        if (!hasMetric(metrics, requires)) {
          const reason = rule.group + '（缺 canonical 数据）';
          if (!skipped.includes(reason)) skipped.push(reason);
          continue;
        }
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(line);
        if (!match) continue;
        const produced = rule.evaluate(line, match, metrics);
        if (produced === null) continue;
        for (const claim of produced) {
          claims++;
          groupsHit.add(rule.group);
          if (claimMatches(claim)) continue;
          groupsMismatched.add(rule.group);
          mismatches.push({
            file: rawFile,
            line: index + 1,
            group: rule.group,
            label: claim.label,
            expected: claim.expected,
            actual: claim.actual,
            snippet: oneLine(line, 120),
          });
        }
      }
    }
  }
  mismatches.sort((a, b) =>
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    (a.line - b.line) ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return {
    files,
    linesScanned,
    claims,
    mismatches,
    groupsHit: [...groupsHit].sort(),
    groupsMismatched: [...groupsMismatched].sort(),
    skipped,
  };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

interface ReportPayload {
  ok: boolean;
  case: CaseMetrics;
  refs: RefsMetrics | null;
  coverage: CoverageMetrics | null;
  check: CheckReport | null;
}

function emit(payload: ReportPayload, raw: RawCli, cwd: string, human: string[]): never {
  const reportArg = optional(raw, 'report');
  if (reportArg !== null) {
    const reportPath = resolve(cwd, reportArg);
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    } catch (error) {
      console.error('docs-metrics: 无法写入报告 ' + reportPath + '：' + errorMessage(error));
      process.exit(EXIT_USAGE);
    }
  }
  if (raw.json === true) console.log(JSON.stringify(payload, null, 2));
  else console.log(human.join('\n'));
  const mismatches = payload.check === null ? 0 : payload.check.mismatches.length;
  process.exit(mismatches > 0 ? EXIT_MISMATCH : EXIT_OK);
}

function humanLines(payload: ReportPayload): string[] {
  const lines: string[] = [];
  const caseMetrics = payload.case;
  lines.push('docs-metrics  case=' + caseMetrics.dir);
  lines.push(
    '保真      ' + caseMetrics.golden.scenarios + ' 场景 / ' + caseMetrics.golden.pages + ' 页 → ' +
    caseMetrics.fidelityPct + '%' + (caseMetrics.fidelityEqual ? '（逐项全等）' : '（有差异）') +
    '  actual md5 ' + caseMetrics.actualMd5.slice(0, 12) + '…',
  );
  const refs = payload.refs;
  if (refs === null) {
    lines.push('refs      未提供 --refs（闭包/产物/错误/codemod 计数跳过）');
  } else {
    const parts: string[] = [];
    if (refs.baseline !== null) parts.push('baseline ' + refs.baseline.files + ' 文件 / ' + formatNumber(refs.baseline.lines) + ' 行');
    if (refs.adapted !== null) parts.push('adapted ' + refs.adapted.files + ' / ' + formatNumber(refs.adapted.lines) + ' 行');
    if (refs.src !== null) {
      parts.push('closure ' + refs.src.files + ' .kt / ' + formatNumber(refs.src.lines) + ' 行（模块 ' +
        refs.src.moduleFiles + ' / ' + formatNumber(refs.src.moduleLines) + '）');
    }
    lines.push('refs      ' + (parts.length > 0 ? parts.join('；') : '（refs 目录下没有可识别的子目录）'));
    if (refs.errors !== null) {
      const histogram = refs.errors.byCode.slice(0, 4).map((item) => item.code.replace(/^arkts-/, '') + ' ' + item.count);
      lines.push('errors    ' + refs.errors.total + ' 条（硬 ' + refs.errors.hard + ' + WARN ' + refs.errors.warn +
        '）；' + histogram.join(' / ') + (refs.errors.byCode.length > 4 ? ' / 其它 ' + (refs.errors.byCode.length - 4) + ' 类' : ''));
    }
    if (refs.codemod !== null) {
      lines.push('codemod   options ' + refs.codemod.options + ' / patches ' + refs.codemod.patches +
        ' / asConst ' + refs.codemod.asConst + ' / renamePairs ' + refs.codemod.renamePairs +
        ' / valueAliases ' + refs.codemod.renamedTypeAliases +
        ' / valueDecls ' + refs.codemod.renamedValueDeclarations);
    }
  }
  if (payload.coverage === null) {
    lines.push('coverage  未提供 --coverage（覆盖率检查跳过）');
  } else {
    lines.push('coverage  ' + formatNumber(payload.coverage.files) + ' 文件 / ' +
      formatNumber(payload.coverage.totalLoc) + ' 行 / ' + payload.coverage.autoConvertiblePct + '%' +
      (payload.coverage.verdict !== '' ? ' [' + payload.coverage.verdict + ']' : ''));
  }
  if (payload.check !== null) {
    const check = payload.check;
    lines.push('check     ' + check.files.join(', ') + '：' + check.claims + ' 处声明（' +
      check.groupsHit.length + ' 组命中），' + check.mismatches.length + ' 处不一致' +
      (check.skipped.length > 0 ? '；跳过 ' + check.skipped.join(',') : ''));
    const shown = check.mismatches.slice(0, 6);
    for (const mismatch of shown) {
      lines.push('  ' + mismatch.file + ':' + mismatch.line + '  ' + mismatch.label +
        '  expected ' + mismatch.expected + '  actual ' + mismatch.actual +
        '  「' + oneLine(mismatch.snippet, 70) + '」');
    }
    if (check.mismatches.length > shown.length) {
      lines.push('  …还有 ' + (check.mismatches.length - shown.length) + ' 处不一致（见 --report）');
    }
    lines.push('结果: ' + (check.mismatches.length > 0
      ? 'MISMATCH（' + check.mismatches.length + ' 处不一致 / ' + check.groupsMismatched.length + ' 组）'
      : 'OK（文档数字与 canonical 一致）'));
  } else {
    lines.push('结果: OK（仅计算 canonical metrics；加 --check 可校验文档）');
  }
  return lines;
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
  const caseArg = optional(raw, 'case');
  if (caseArg === null) failUsage('缺少 --case（如 --case cases/legado）');
  const caseAbs = resolve(cwd, caseArg);
  if (!isDirectory(caseAbs)) failUsage('--case 目录不存在：' + caseArg);

  const refsArg = optional(raw, 'refs');
  const coverageArg = optional(raw, 'coverage');
  const checkArg = optional(raw, 'check');

  const caseMetrics = loadCase(caseAbs, caseArg);
  const refs = refsArg === null ? null : loadRefs(resolve(cwd, refsArg), refsArg);
  const coverage = coverageArg === null ? null : loadCoverage(resolve(cwd, coverageArg));
  const metrics: Metrics = { case: caseMetrics, refs, coverage };

  let check: CheckReport | null = null;
  if (checkArg !== null) {
    const files = checkArg.split(',').map((file) => file.trim()).filter((file) => file !== '');
    if (files.length === 0) failUsage('--check 不能为空');
    check = scanDocs(files, cwd, metrics);
  }

  const payload: ReportPayload = {
    ok: check === null || check.mismatches.length === 0,
    case: caseMetrics,
    refs,
    coverage,
    check,
  };
  emit(payload, raw, cwd, humanLines(payload));
}

main();
