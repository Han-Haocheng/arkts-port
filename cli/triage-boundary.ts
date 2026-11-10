#!/usr/bin/env node
/**
 * triage-boundary —— 低 API 文件边界拆分分诊器（JVM/Kotlin）。
 *
 * 背景（task-52 实测）：低 API ≠ 可拆。真正值得做“纯逻辑 + platform adapter”拆分的文件，
 * 平台耦合必须只有协程（kotlinx.coroutines），且内部依赖面窄、不是 UI、行数够大。
 * 本工具把当时的一次性脚本沉淀成确定性 CLI：扫 .kt → 分类 → 漏斗计数 → 候选 top N。
 *
 * 用法：
 *   node cli/triage-boundary.ts --root <dir> [--json | --md] [--out <path>]
 *                               [--min-lines 100] [--top 8]
 *   node cli/triage-boundary.ts --help
 *
 * 参数：
 *   --root <dir>     源码根目录（必填；路径都相对它；只读，不改仓库）
 *   --json           输出机器 JSON
 *   --md             输出 Markdown 报告（与 --json 二选一）
 *   --out <path>     把输出写文件（父目录不存在会创建）；stdout 不再打印
 *   --min-lines <n>  计入漏斗的最小物理行数（默认 100，正整数）
 *   --top <n>        候选表输出前 n 个（默认 8，正整数）
 *   --help, -h       打印帮助
 *
 * 指标（每个文件）：
 *   - loc：物理行数（末尾换行不算一行）
 *   - imports：android / androidx / compose（androidx.compose.*，属于 androidx 的子集，单列）
 *     / google（com.google.android.*，只算平台库，不含 gson 之类普通三方库）/ dagger
 *     / coroutines（kotlinx.coroutines）/ internal（项目内包）/ otherExternal（其余三方 + JDK）
 *   - ui：import 级或声明级 UI 标记（ViewModel/Activity/Fragment/Composable/RecyclerView…）；
 *     uiPath 单列但不参与分类（避免把 ui/ 目录下的纯逻辑文件误杀）
 *   - async：suspend 函数数、Flow 用法数、每百行异步密度
 *
 * 分类（只对命中 jvm platformPatterns 的 coupled 文件）：
 *   splittable-candidate：platform=0 && coroutines>0 && internal<=8 && !ui && loc>=minLines
 *   ui：命中 UI 标记（优先于 boundary-only）
 *   boundary-only：android/androidx/google/dagger import > 0
 *   not-worth：短于 minLines / 无协程耦合 / internal>8
 *
 * 排序：loc 降序（价值优先）→ internal 升序（越少越好拆）→ suspend+Flow 升序 → 路径升序。
 *
 * 退出码：0 成功；1 运行时（读/写失败）；2 用法或参数错误。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;

const TOOL = 'triage-boundary';
const VERSION = 1;
const MAX_INTERNAL_IMPORTS = 8;

const USAGE = [
  '用法：',
  '  node cli/triage-boundary.ts --root <dir> [--json | --md] [--out <path>]',
  '                              [--min-lines 100] [--top 8]',
  '  node cli/triage-boundary.ts --help',
  '',
  '低 API 文件边界拆分分诊：扫 .kt，按平台耦合/依赖面/UI/行数分类，输出漏斗计数与候选 top N。',
  '',
  '参数：',
  '  --root <dir>     源码根目录（必填；只读；报告里的路径都相对它）',
  '  --json           输出机器 JSON（与 --md 二选一）',
  '  --md             输出 Markdown 报告（与 --json 二选一）',
  '  --out <path>     写文件而不是打 stdout（父目录会创建）',
  '  --min-lines <n>  计入漏斗的最小物理行数（默认 100）',
  '  --top <n>        候选表输出前 n 个（默认 8）',
  '  --help, -h       打印本帮助',
  '',
  '分类：splittable-candidate / boundary-only / ui / not-worth（详见文件头注释）。',
  '退出码：0 = 成功；1 = 读写失败；2 = 用法错误。',
];

interface Args {
  root: string;
  json: boolean;
  md: boolean;
  out: string | null;
  minLines: number;
  top: number;
  help: boolean;
}

// ---------------------------------------------------------------- 平台配置

const configPath = fileURLToPath(new URL('../adapters/languages.json', import.meta.url));
const JVM_FALLBACK_PATTERN = '^\\s*import\\s+(android\\.|androidx\\.|com\\.google\\.android\\.|dagger\\.|kotlinx\\.coroutines)';

function loadJvmPattern(): string {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { jvm?: { platformPatterns?: unknown } };
    const pattern = parsed.jvm?.platformPatterns;
    if (Array.isArray(pattern) && typeof pattern[0] === 'string') return pattern[0];
  } catch {
    // 配置缺失/损坏时用内置兜底（与 adapters/languages.json#jvm 同义）
  }
  return JVM_FALLBACK_PATTERN;
}

// ---------------------------------------------------------------- 参数

function parsePositiveInt(name: string, raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function parseArgs(argv: string[]): { args?: Args; error?: string } {
  const args: Args = { root: '', json: false, md: false, out: null, minLines: 100, top: 8, help: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--') && token !== '-h') return { error: '未知参数：' + token };
    const name = token === '-h' ? 'help' : token.slice(2);
    if (seen.has(name)) return { error: '参数重复：--' + name };
    seen.add(name);
    switch (name) {
      case 'help':
        args.help = true;
        continue;
      case 'json':
        args.json = true;
        continue;
      case 'md':
        args.md = true;
        continue;
      case 'root': {
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) return { error: '--root 缺少目录' };
        args.root = value;
        continue;
      }
      case 'out': {
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) return { error: '--out 缺少路径' };
        args.out = value;
        continue;
      }
      case 'min-lines': {
        const value = argv[++index];
        const parsed = value === undefined ? null : parsePositiveInt('min-lines', value);
        if (parsed === null) return { error: '--min-lines 需要正整数，实际：' + String(value) };
        args.minLines = parsed;
        continue;
      }
      case 'top': {
        const value = argv[++index];
        const parsed = value === undefined ? null : parsePositiveInt('top', value);
        if (parsed === null) return { error: '--top 需要正整数，实际：' + String(value) };
        args.top = parsed;
        continue;
      }
      default:
        return { error: '未知参数：--' + name };
    }
  }
  if (args.help) return { args };
  if (args.root === '') return { error: '缺少 --root（源码根目录）' };
  if (args.json && args.md) return { error: '--json 与 --md 只能二选一' };
  return { args };
}

function failUsage(message: string): never {
  process.stderr.write('错误：' + message + '\n\n' + USAGE.join('\n') + '\n');
  process.exit(EXIT_USAGE);
}

// ---------------------------------------------------------------- 扫描

const SKIP_DIR_NAMES = new Set([
  '.git', '.gradle', '.idea', '.vscode', 'build', 'out', 'target', 'obj', 'bin',
  'node_modules', 'vendor', 'dist', 'coverage', '.next', '.nuxt', '.refs',
  '.hvigor', '.ohos-tools', '.cxx',
]);
const TEST_SOURCE_PATH = /(^|\/)src\/(test|androidTest)\//;

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function listKotlinFiles(root: string): { files: string[]; skippedTestSources: number } {
  const files: string[] = [];
  let skippedTestSources = 0;
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .slice()
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.kt')) continue;
      const rel = toPosix(relative(root, abs));
      if (TEST_SOURCE_PATH.test(rel)) {
        skippedTestSources++;
        continue;
      }
      files.push(rel);
    }
  };
  walk(root);
  files.sort();
  return { files, skippedTestSources };
}

// ---------------------------------------------------------------- 单文件指标

function countLines(source: string): number {
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

function packageNameOf(source: string): string | null {
  const match = /^\s*package\s+([\w.]+)/m.exec(source);
  return match === null ? null : match[1];
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?/gm)].map((match) => match[1]);
}

function projectPackageRoot(packages: string[]): string | null {
  if (packages.length === 0) return null;
  const counts = new Map<string, number>();
  for (const name of packages) {
    const segments = name.split('.').filter((segment) => segment.length > 0);
    const root = segments.slice(0, Math.min(3, segments.length)).join('.');
    if (root === '') continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  });
  return ranked.length === 0 ? null : ranked[0][0];
}

const UI_IMPORT_PREFIXES = [
  'androidx.lifecycle.ViewModel',
  'androidx.activity.',
  'androidx.fragment.',
  'androidx.compose.',
  'androidx.recyclerview.',
  'androidx.viewpager',
  'androidx.navigation.',
  'com.google.android.material.',
];

const UI_DECLARATIONS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /@Composable\b/, reason: 'Composable 注解' },
  { pattern: /:\s*ViewModel\s*[({]/, reason: '继承 ViewModel' },
  { pattern: /:\s*(?:Component)?Activity\s*[({]/, reason: '继承 Activity' },
  { pattern: /:\s*Fragment\s*[({]/, reason: '继承 Fragment' },
];

interface ImportCounts {
  android: number;
  androidx: number;
  compose: number;
  google: number;
  dagger: number;
  coroutines: number;
  internal: number;
  otherExternal: number;
}

interface FileMetrics {
  file: string;
  loc: number;
  coupled: boolean;
  imports: ImportCounts;
  platformImports: number;
  ui: { value: boolean; reasons: string[]; uiPath: boolean };
  async: { suspendCount: number; flowCount: number; per100Loc: number };
  classification: Classification;
  reason: string;
  /** 旧 scan-candidates.mjs 的子串 UI 标记命中（仅用于解释 67 vs 71，不参与分类）。 */
  legacyScanUiMention: boolean;
}

type Classification = 'splittable-candidate' | 'boundary-only' | 'ui' | 'not-worth';

function classify(row: { loc: number; platformImports: number; imports: ImportCounts; ui: { value: boolean } }, minLines: number): { classification: Classification; reason: string } {
  if (row.loc < minLines) return { classification: 'not-worth', reason: '短于 --min-lines（' + row.loc + ' < ' + minLines + '）' };
  if (row.ui.value) return { classification: 'ui', reason: 'UI 标记命中（见 ui.reasons）' };
  if (row.platformImports > 0) return { classification: 'boundary-only', reason: '平台 import ' + row.platformImports + ' 条（android/androidx/google/dagger）' };
  if (row.imports.coroutines === 0) return { classification: 'not-worth', reason: '无协程耦合，拆分无增益' };
  if (row.imports.internal > MAX_INTERNAL_IMPORTS) {
    return { classification: 'not-worth', reason: '内部依赖 ' + row.imports.internal + ' > ' + MAX_INTERNAL_IMPORTS };
  }
  return { classification: 'splittable-candidate', reason: '仅协程耦合 + 依赖面窄 + 非 UI' };
}

function analyzeSource(rel: string, source: string, pattern: RegExp, projectRoot: string | null, minLines: number): FileMetrics {
  const loc = countLines(source);
  const importList = importsOf(source);
  const imports: ImportCounts = {
    android: 0, androidx: 0, compose: 0, google: 0, dagger: 0,
    coroutines: 0, internal: 0, otherExternal: 0,
  };
  for (const name of importList) {
    if (name.startsWith('android.')) imports.android++;
    if (name.startsWith('androidx.')) imports.androidx++;
    if (name.startsWith('androidx.compose.')) imports.compose++;
    if (name.startsWith('com.google.android.')) imports.google++;
    if (name.startsWith('dagger.')) imports.dagger++;
    if (name.startsWith('kotlinx.coroutines')) imports.coroutines++;
    if (projectRoot !== null && (name === projectRoot || name.startsWith(projectRoot + '.'))) imports.internal++;
    if (!name.startsWith('android.') && !name.startsWith('androidx.') &&
      !name.startsWith('com.google.android.') && !name.startsWith('dagger.') &&
      !name.startsWith('kotlinx.coroutines') && !name.startsWith('kotlin.') &&
      !(projectRoot !== null && (name === projectRoot || name.startsWith(projectRoot + '.')))) {
      imports.otherExternal++;
    }
  }
  const platformImports = imports.android + imports.androidx + imports.google + imports.dagger;
  const uiReasons: string[] = [];
  for (const prefix of UI_IMPORT_PREFIXES) {
    if (importList.some((name) => name === prefix || name.startsWith(prefix))) {
      uiReasons.push('import ' + prefix);
      break;
    }
  }
  for (const declaration of UI_DECLARATIONS) {
    if (declaration.pattern.test(source)) uiReasons.push(declaration.reason);
  }
  const uiPath = /(^|\/)(ui|compose)\//.test(rel);
  const legacyScanUiMention = /@Composable|:\s*ViewModel\s*\(|ViewModel |:\s*Activity|Activity\(|:\s*Fragment|Fragment\(|ComponentActivity|NavHostController|MutableState<|remember \{/.test(source);
  const suspendCount = (source.match(/\bsuspend\s+fun\b/g) ?? []).length;
  const flowCount = (source.match(/\b(?:Mutable)?(?:State|Shared)?Flow\s*<|\bflowOf\s*\(|\.collect\b/g) ?? []).length;
  const base = {
    loc,
    platformImports,
    imports,
    ui: { value: uiReasons.length > 0, reasons: uiReasons, uiPath },
  };
  const verdict = classify(base, minLines);
  return {
    file: rel,
    loc,
    coupled: pattern.test(source),
    imports,
    platformImports,
    ui: base.ui,
    async: {
      suspendCount,
      flowCount,
      per100Loc: loc === 0 ? 0 : Math.round(((suspendCount + flowCount) * 1000) / loc) / 10,
    },
    classification: verdict.classification,
    reason: verdict.reason,
    legacyScanUiMention,
  };
}

// ---------------------------------------------------------------- 漏斗

interface Funnel {
  scannedKotlinFiles: number;
  skippedTestSources: number;
  coupledFiles: number;
  coupledAtLeastMinLines: number;
  zeroPlatformImports: number;
  narrowDepsNonUi: number;
  zeroInternalImports: number;
  legacyPathUi: { narrowDepsNonUi: number; excludedOnlyByPath: number };
  legacyScanUi: { zeroPlatformImports: number; falsePositiveFiles: number };
}

function computeFunnel(files: FileMetrics[], scanned: number, skippedTestSources: number, minLines: number): Funnel {
  const coupled = files.filter((row) => row.coupled);
  const coupledBig = coupled.filter((row) => row.loc >= minLines);
  const zeroPlatform = coupledBig.filter((row) => row.platformImports === 0);
  const narrow = zeroPlatform.filter((row) => row.imports.internal <= MAX_INTERNAL_IMPORTS && !row.ui.value);
  const narrowLegacyPath = narrow.filter((row) => !row.ui.uiPath);
  const legacyFalsePositives = zeroPlatform.filter((row) => !row.ui.value && row.legacyScanUiMention).length;
  return {
    scannedKotlinFiles: scanned,
    skippedTestSources,
    coupledFiles: coupled.length,
    coupledAtLeastMinLines: coupledBig.length,
    zeroPlatformImports: zeroPlatform.length,
    narrowDepsNonUi: narrow.length,
    zeroInternalImports: zeroPlatform.filter((row) => row.imports.internal === 0).length,
    legacyPathUi: {
      narrowDepsNonUi: narrowLegacyPath.length,
      excludedOnlyByPath: narrow.length - narrowLegacyPath.length,
    },
    legacyScanUi: {
      zeroPlatformImports: zeroPlatform.length - legacyFalsePositives,
      falsePositiveFiles: legacyFalsePositives,
    },
  };
}

// ---------------------------------------------------------------- 报告

function compareCandidates(left: FileMetrics, right: FileMetrics): number {
  if (left.loc !== right.loc) return right.loc - left.loc;
  if (left.imports.internal !== right.imports.internal) return left.imports.internal - right.imports.internal;
  const leftAsync = left.async.suspendCount + left.async.flowCount;
  const rightAsync = right.async.suspendCount + right.async.flowCount;
  if (leftAsync !== rightAsync) return leftAsync - rightAsync;
  return left.file < right.file ? -1 : left.file > right.file ? 1 : 0;
}

function buildPayload(files: FileMetrics[], funnel: Funnel, minLines: number, top: number): Record<string, unknown> {
  const coupledBig = files.filter((row) => row.coupled && row.loc >= minLines);
  const candidates = coupledBig
    .filter((row) => row.classification === 'splittable-candidate')
    .sort(compareCandidates);
  const byClass: Record<Classification, number> = {
    'splittable-candidate': 0,
    'boundary-only': 0,
    ui: 0,
    'not-worth': 0,
  };
  for (const row of coupledBig) byClass[row.classification]++;
  const excludedShort = files
    .filter((row) => row.coupled && row.loc < minLines)
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    .map((row) => ({ file: row.file, loc: row.loc, reason: row.reason }));
  return {
    tool: TOOL,
    version: VERSION,
    root: '.',
    minLines,
    top,
    sort: ['loc:desc', 'internal-imports:asc', 'suspend+flow:asc', 'path:asc'],
    funnel,
    counts: {
      coupledAtLeastMinLines: coupledBig.length,
      splittableCandidates: candidates.length,
      byClass,
    },
    top: candidates.slice(0, top).map(publicRow),
    candidates: candidates.map(publicRow),
    excludedShort,
    notes: [
      '路径都相对 --root；无时间戳/绝对路径，同输入两次输出逐字节相同。',
      'LOC 用物理行数（split 换行后去掉末尾空行），coupled = 命中 adapters/languages.json#jvm.platformPatterns。',
      'compose import 计入 androidx，也单列 compose（platformImports 只算 android/androidx/google/dagger，不重复加 compose）。',
      'internal import = 以项目主包前缀（多数文件的 package 前三段）开头的 import；kotlin.* 不算 otherExternal。',
      'UI 判定看 import 与声明（ViewModel/Activity/Fragment/Composable/RecyclerView…）；uiPath（/ui/、/compose/ 目录）单列但不参与分类，防止误杀 ui/ 下的纯逻辑文件。',
      '旧口径对照：out/boundary-pilot 的 67 = 本工具 zeroPlatformImports 71 减去 4 个把注释里出现 “ViewModel ” 误判为 UI 的文件（scan-candidates.mjs 的字符串启发式）；32 = 本工具 narrowDepsNonUi 35 减去 3 个仅因位于 ui/ 目录被排除的纯逻辑文件（aggregate.mjs 的路径启发式，其中包含已拆成功的 WholeBookPageCoordinator）。',
      'legacyPathUi 给出旧路径启发式下的窄依赖计数（narrowDepsNonUiPath）与被路径单独排除的文件数。',
      'legacyScanUi 给出旧 scan-candidates.mjs 子串 UI 启发式下的 zero-platform 计数（71 - 4 = 67）与误判文件数。',
      '--root 建议指向被移植模块的生产源集（如 legado 的 app/src/main/java）；扫整个仓库会把其他模块（modules/rhino、baselineProfile）和测试源集算进漏斗，数字会变大。',
    ],
  };
}

function publicRow(row: FileMetrics): Record<string, unknown> {
  return {
    file: row.file,
    loc: row.loc,
    imports: row.imports,
    platformImports: row.platformImports,
    ui: { value: row.ui.value, reasons: row.ui.reasons, uiPath: row.ui.uiPath },
    async: row.async,
    classification: row.classification,
    reason: row.reason,
  };
}

function renderMarkdown(files: FileMetrics[], funnel: Funnel, minLines: number, top: number): string {
  const coupledBig = files.filter((row) => row.coupled && row.loc >= minLines);
  const candidates = coupledBig
    .filter((row) => row.classification === 'splittable-candidate')
    .sort(compareCandidates);
  const byClass: Record<Classification, number> = {
    'splittable-candidate': 0,
    'boundary-only': 0,
    ui: 0,
    'not-worth': 0,
  };
  for (const row of coupledBig) byClass[row.classification]++;
  const lines: string[] = [];
  lines.push('# 低 API 文件边界拆分分诊');
  lines.push('');
  lines.push('工具：' + TOOL + ' v' + VERSION + '。root：.；最小行数：' + minLines + '；候选 top ' + top + '。');
  lines.push('');
  lines.push('## 漏斗');
  lines.push('');
  lines.push('| 阶段 | 文件数 |');
  lines.push('| --- | ---: |');
  lines.push('| 扫描 .kt（跳过 test/androidTest） | ' + funnel.scannedKotlinFiles + ' |');
  lines.push('| coupled（命中 jvm platformPatterns） | ' + funnel.coupledFiles + ' |');
  lines.push('| coupled 且 ≥ ' + minLines + ' 行 | ' + funnel.coupledAtLeastMinLines + ' |');
  lines.push('| 0 平台 import | ' + funnel.zeroPlatformImports + ' |');
  lines.push('| 窄依赖（internal ≤ ' + MAX_INTERNAL_IMPORTS + '）且非 UI | ' + funnel.narrowDepsNonUi + ' |');
  lines.push('| 其中 0 internal import | ' + funnel.zeroInternalImports + ' |');
  lines.push('');
  const shortCoupled = files.filter((row) => row.coupled && row.loc < minLines);
  if (shortCoupled.length > 0) {
    lines.push('coupled 但短于 ' + minLines + ' 行（不参与分类与候选）：' + shortCoupled.length + ' 个。');
    lines.push('');
  }
  lines.push('旧口径对照：路径 UI 启发式下“窄依赖且非 UI”为 ' + funnel.legacyPathUi.narrowDepsNonUi +
    '（' + funnel.legacyPathUi.excludedOnlyByPath + ' 个纯逻辑文件仅因位于 ui/ 目录被排除）。');
  lines.push('task-52 的 67 = 71 - ' + funnel.legacyScanUi.falsePositiveFiles +
    ' 个被字符串启发式误判的“注释里出现 ViewModel ”文件；本工具用 import/声明判定，对应 ' + funnel.zeroPlatformImports + '。');
  lines.push('');
  lines.push('## 分类计数（coupled 且 ≥ ' + minLines + ' 行）');
  lines.push('');
  lines.push('| 分类 | 文件数 |');
  lines.push('| --- | ---: |');
  lines.push('| splittable-candidate | ' + byClass['splittable-candidate'] + ' |');
  lines.push('| boundary-only | ' + byClass['boundary-only'] + ' |');
  lines.push('| ui | ' + byClass.ui + ' |');
  lines.push('| not-worth | ' + byClass['not-worth'] + ' |');
  lines.push('');
  lines.push('## 候选 top ' + top + '（排序：LOC 降序 → 内部依赖升序 → suspend+Flow 升序 → 路径）');
  lines.push('');
  lines.push('| # | 文件 | LOC | 协程 import | 内部依赖 | suspend | Flow |');
  lines.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: |');
  candidates.slice(0, top).forEach((row, index) => {
    lines.push('| ' + (index + 1) + ' | ' + row.file + ' | ' + row.loc + ' | ' + row.imports.coroutines +
      ' | ' + row.imports.internal + ' | ' + row.async.suspendCount + ' | ' + row.async.flowCount + ' |');
  });
  lines.push('');
  lines.push('## 复跑');
  lines.push('');
  lines.push('    node cli/triage-boundary.ts --root <源码根目录> --md');
  lines.push('    node cli/triage-boundary.ts --root <源码根目录> --json --out triage.json');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- main

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) failUsage(parsed.error);
  const args = parsed.args as Args;
  if (args.help) {
    process.stdout.write(USAGE.join('\n') + '\n');
    return EXIT_OK;
  }
  const root = resolve(args.root);
  let files: string[];
  let skippedTestSources: number;
  try {
    const listed = listKotlinFiles(root);
    files = listed.files;
    skippedTestSources = listed.skippedTestSources;
  } catch (error) {
    process.stderr.write('错误：无法读取 --root：' + args.root + '（' + (error as Error).message + '）\n');
    return EXIT_USAGE;
  }
  const pattern = new RegExp(loadJvmPattern(), 'm');
  const sources = files.map((rel) => ({ rel, text: readFileSync(join(root, rel), 'utf8') }));
  const projectRoot = projectPackageRoot(
    sources.map((entry) => packageNameOf(entry.text)).filter((name): name is string => name !== null),
  );
  const metrics = sources.map((entry) => analyzeSource(entry.rel, entry.text, pattern, projectRoot, args.minLines));
  const funnel = computeFunnel(metrics, files.length, skippedTestSources, args.minLines);
  const content = args.json
    ? JSON.stringify(buildPayload(metrics, funnel, args.minLines, args.top), null, 2) + '\n'
    : args.md
      ? renderMarkdown(metrics, funnel, args.minLines, args.top)
      : renderSummary(funnel, metrics, args.minLines, args.top);
  if (args.out !== null) {
    const outPath = resolve(args.out);
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, content, 'utf8');
    } catch (error) {
      process.stderr.write('错误：无法写入 --out：' + args.out + '（' + (error as Error).message + '）\n');
      return EXIT_RUNTIME;
    }
    return EXIT_OK;
  }
  process.stdout.write(content);
  return EXIT_OK;
}

function renderSummary(funnel: Funnel, files: FileMetrics[], minLines: number, top: number): string {
  const coupledBig = files.filter((row) => row.coupled && row.loc >= minLines);
  const candidates = coupledBig
    .filter((row) => row.classification === 'splittable-candidate')
    .sort(compareCandidates);
  const lines: string[] = [];
  lines.push('扫描 ' + funnel.scannedKotlinFiles + ' 个 .kt（跳过测试源集 ' + funnel.skippedTestSources + ' 个）');
  lines.push('漏斗：coupled ' + funnel.coupledFiles + ' → coupled≥' + minLines + ' ' + funnel.coupledAtLeastMinLines +
    ' → 0 平台 import ' + funnel.zeroPlatformImports + ' → 窄依赖非 UI ' + funnel.narrowDepsNonUi +
    ' → 0 internal ' + funnel.zeroInternalImports);
  lines.push('候选（top ' + top + '，共 ' + candidates.length + '）：');
  candidates.slice(0, top).forEach((row, index) => {
    lines.push('  ' + String(index + 1).padStart(2, ' ') + '. ' + row.file +
      '  loc=' + row.loc + ' coroutines=' + row.imports.coroutines + ' internal=' + row.imports.internal +
      ' suspend=' + row.async.suspendCount + ' flow=' + row.async.flowCount);
  });
  lines.push('用 --json 或 --md 拿完整结果。');
  return lines.join('\n') + '\n';
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}

export { parseArgs, listKotlinFiles, analyzeSource, computeFunnel, buildPayload, renderMarkdown, compareCandidates, classify, projectPackageRoot };
