#!/usr/bin/env node
/**
 * 分诊：扫描源码树，统计「未耦合原平台」的代码占比 —— 决定值不值得走自动转写流水线。
 * 语言通过 adapters/languages.json 配置，工具本身与语言无关。
 *
 * 「可自动转写」只统计真能建立 golden 的代码：以下三类不算（但单列，避免口径误导）：
 *   - 耦合原平台（platformPatterns 命中：原生/DOM/框架/资源 import 等）
 *   - 类型声明 .d.ts（无运行时代码，js-ts 单列 dts）
 *   - 纯数据配置（js-ts：无 import/函数/控制流，只有导出字面量 → dataOnly）
 * 分母仍是全部行数，所以「可自动转写 %」与旧口径可直接对比。
 *
 * 用法：
 *   node cli/analyze-coupling.ts --root <dir> [--lang jvm|js-ts|dart|c-cpp|swift] [--json] [--top 15]
 *   node cli/analyze-coupling.ts --list-langs
 *
 * 不给 --lang 时按扩展名自动识别（混合工程会按文件各自归属统计）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface LangConfig {
  name: string;
  extensions: string[];
  platformPatterns: string[];
  goldenRunner: string;
  harnessTemplate: string;
  semanticStage: string;
  status: string;
  note?: string;
}

const configPath = fileURLToPath(new URL('../adapters/languages.json', import.meta.url));
const LANGS = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, LangConfig>;

const USAGE = [
  '用法：',
  '  node cli/analyze-coupling.ts --root <dir> [--lang <id>] [--json] [--top 15]',
  '  node cli/analyze-coupling.ts --list-langs',
  '',
  '分诊：统计源码中「未耦合原平台」的代码占比，决定值不值得走自动转写流水线。',
  '不给 --lang 时按扩展名自动识别（混合工程按文件各自归属统计）。',
  '',
  '.d.ts 类型声明与「纯数据配置」（js-ts：无 import/函数/控制流，只有导出字面量）',
  '不计入可自动转写，分别单列为 dts / dataOnly（两者合计 unaudited）。',
  '',
  '参数：',
  '  --root <dir>   源码根目录（默认当前目录；必须存在）',
  '  --lang <id>    只统计一种语言（见 --list-langs；未知语言 exit 2）',
  '  --top <n>      模块排序取前 n 个（默认 15，正整数）',
  '  --json         输出机器可读 JSON（不打印人类摘要）',
  '  --list-langs   列出 adapters/languages.json 支持的语言与状态',
  '  --help, -h     显示本帮助',
  '',
  '退出码：0 = 统计完成；2 = 用法错误（含 --root 不存在 / 没有匹配文件）',
].join('\n');

const VALUE_OPTS = new Set(['root', 'lang', 'top']);
const BOOL_OPTS = new Set(['json', 'list-langs', 'help']);

function failUsage(message: string): never {
  console.error('analyze-coupling: ' + message);
  console.error('用法见：node cli/analyze-coupling.ts --help');
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

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

if (args['list-langs']) {
  for (const [id, cfg] of Object.entries(LANGS)) {
    console.log(id.padEnd(8) + cfg.status.padEnd(11) + cfg.name);
    console.log('         转写: ' + cfg.semanticStage + '  |  golden: ' + cfg.goldenRunner);
  }
  process.exit(0);
}

const rootDir = String(args.root ?? process.cwd());
try {
  if (!statSync(rootDir).isDirectory()) failUsage('--root 不是目录：' + rootDir);
} catch {
  failUsage('--root 不存在：' + rootDir);
}
const onlyLang = args.lang === undefined ? null : String(args.lang);
if (onlyLang !== null && !LANGS[onlyLang]) {
  failUsage('未知语言：' + onlyLang + '（可用：' + Object.keys(LANGS).join(', ') + '）');
}
let topCount = 15;
if (args.top !== undefined) {
  const parsed = Number(args.top);
  if (!Number.isInteger(parsed) || parsed < 1) failUsage('--top 必须是正整数：' + String(args.top));
  topCount = parsed;
}

// 扩展名 → 语言 id
const extToLang = new Map<string, string>();
for (const [id, cfg] of Object.entries(LANGS)) {
  if (onlyLang !== null && id !== onlyLang) continue;
  for (const ext of cfg.extensions) extToLang.set(ext, id);
}

const SKIP_DIRS = new Set(['build', 'node_modules', 'gradle', '.git', '.gradle', '.idea', 'oh_modules', '.hvigor', 'test', 'androidTest', 'ohosTest', '__tests__', 'dist', 'out']);
const patternCache = new Map<string, RegExp[]>();
function patternsOf(lang: string): RegExp[] {
  let p = patternCache.get(lang);
  if (!p) {
    p = LANGS[lang].platformPatterns.map((s) => new RegExp(s, 'm'));
    patternCache.set(lang, p);
  }
  return p;
}

interface Row { rel: string; lang: string; loc: number; coupled: boolean; dts: boolean; dataOnly: boolean }
const rows: Row[] = [];

const DTS_FILE = /\.d\.(?:ts|mts|cts)$/i;

/** 去掉注释与字符串字面量，避免把注释/文案里的单词当成代码（只用于 dataOnly 判定）。 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const BACKTICK = String.fromCharCode(96);
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === BACKTICK) {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (quote !== BACKTICK && src[i] === '\n') break;
        i++;
      }
      out += ' STR ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 纯数据配置：没有 import / 函数 / 类 / 箭头函数 / 控制流，只有导出的字面量（对象、数组）。
 * 这类文件没有逻辑可写 golden，不能算「可自动转写」；只对 js-ts 生效，避免影响其它语言口径。
 */
function isDataOnlySource(src: string): boolean {
  const code = stripCommentsAndStrings(src);
  if (/(?:^|\n)\s*import\b/.test(code)) return false;
  if (/\bimport\s*\(/.test(code)) return false;
  if (/\b(?:function|class)\b/.test(code)) return false;
  if (/=>/.test(code)) return false;
  if (/\b(?:if|for|while|switch|case|return|try|catch|throw|await|async|new|delete)\b/.test(code)) return false;
  if (!/\bexport\s+(?:default|const|let|var)\b/.test(code)) return false;
  if (!/[{[][\s\S]*[}\]]/.test(code)) return false;
  return true;
}

function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(p);
      continue;
    }
    const lang = extToLang.get(extname(entry.name));
    if (!lang) continue;
    const src = readFileSync(p, 'utf8');
    const dts = DTS_FILE.test(entry.name);
    const coupled = !dts && patternsOf(lang).some((re) => re.test(src));
    const dataOnly = !dts && !coupled && lang === 'js-ts' && isDataOnlySource(src);
    rows.push({ rel: relative(rootDir, p), lang, loc: src.split('\n').length, coupled, dts, dataOnly });
  }
}

walk(rootDir);
// 确定性顺序：不依赖 readdir 顺序，保证同输入同输出（报告可 diff）
rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
if (rows.length === 0) {
  console.error('没有匹配到任何源文件：' + rootDir + '（检查 --lang 或 adapters/languages.json）');
  process.exit(2);
}

function summarize(filter: (r: Row) => boolean) {
  const list = rows.filter(filter);
  const totalLoc = list.reduce((s, r) => s + r.loc, 0);
  const coupledLoc = list.filter((r) => r.coupled).reduce((s, r) => s + r.loc, 0);
  const dtsList = list.filter((r) => r.dts);
  const dataList = list.filter((r) => r.dataOnly);
  const dtsLoc = dtsList.reduce((s, r) => s + r.loc, 0);
  const dataOnlyLoc = dataList.reduce((s, r) => s + r.loc, 0);
  // 分母保持「全部行数」，与旧口径可直接对比；.d.ts 与纯数据配置不算可自动转写
  const autoConvertibleLoc = totalLoc - coupledLoc - dtsLoc - dataOnlyLoc;
  const pct = totalLoc === 0 ? 0 : Math.round(autoConvertibleLoc * 1000 / totalLoc) / 10;
  return {
    files: list.length,
    totalLoc,
    coupledFiles: list.filter((r) => r.coupled).length,
    coupledLoc,
    dts: { files: dtsList.length, loc: dtsLoc },
    dataOnly: { files: dataList.length, loc: dataOnlyLoc },
    unaudited: { files: dtsList.length + dataList.length, loc: dtsLoc + dataOnlyLoc },
    autoConvertibleLoc,
    autoConvertiblePct: pct,
    verdict: pct >= 30 ? 'high' : pct >= 15 ? 'medium' : 'low',
  };
}

const langsPresent = [...new Set(rows.map((r) => r.lang))].sort();
const overall = summarize(() => true);
const perLang = langsPresent.map((lang) => ({ lang, name: LANGS[lang].name, ...summarize((r) => r.lang === lang) }));

const buckets = new Map<string, { loc: number; coupledLoc: number; files: number }>();
for (const r of rows) {
  const parts = r.rel.split(/[\\/]/);
  const cut = parts.findIndex((s) => ['java', 'src', 'lib', 'app'].includes(s));
  const pkg = (cut >= 0 ? parts.slice(cut + 1, cut + 5) : parts.slice(0, 4)).join('/');
  const b = buckets.get(pkg) ?? { loc: 0, coupledLoc: 0, files: 0 };
  b.loc += r.loc; b.files += 1;
  if (r.coupled) b.coupledLoc += r.loc;
  buckets.set(pkg, b);
}

const result = {
  root: rootDir,
  languages: langsPresent,
  ...overall,
  perLanguage: perLang,
  topModules: [...buckets.entries()]
    .sort((a, b) => b[1].loc - a[1].loc || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, topCount)
    .map(([pkg, v]) => ({ pkg, loc: v.loc, files: v.files, couplingPct: Math.round(v.coupledLoc * 100 / Math.max(v.loc, 1)) })),
  largestPureFiles: rows.filter((r) => !r.coupled && !r.dts && !r.dataOnly).sort((a, b) => b.loc - a.loc || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)).slice(0, 20).map((r) => ({ loc: r.loc, path: r.rel, lang: r.lang })),
};

if (args.json) {
  console.log(JSON.stringify(result, null, 1));
  // 用 exitCode 而非 process.exit：大 JSON 走管道时避免截断
  process.exitCode = 0;
} else {
  printHumanReport();
}

function printHumanReport(): void {
  console.log('根目录: ' + result.root);
  console.log('语言: ' + result.languages.map((l) => l + '(' + LANGS[l].status + ')').join(', '));
  console.log('文件 ' + result.files + '，总行数 ' + result.totalLoc);
  console.log('耦合原平台 ' + result.coupledFiles + ' 个文件 / ' + result.coupledLoc + ' 行');
  if (result.dts.files > 0) {
    console.log('类型声明 .d.ts ' + result.dts.files + ' 个文件 / ' + result.dts.loc + ' 行（无运行时代码，不计入可自动转写）');
  }
  if (result.dataOnly.files > 0) {
    console.log('纯数据配置 ' + result.dataOnly.files + ' 个文件 / ' + result.dataOnly.loc +
      ' 行（无 import/函数/控制流，不计入可自动转写）');
  }
  console.log('可自动转写 ' + result.autoConvertibleLoc + ' 行 = ' + result.autoConvertiblePct + '%  [' + result.verdict +
    ']（分母 = 全部 ' + result.totalLoc + ' 行；已扣除耦合' +
    (result.unaudited.loc > 0 ? '/' + (result.dts.loc > 0 ? '.d.ts' : '') +
      (result.dts.loc > 0 && result.dataOnly.loc > 0 ? '/' : '') +
      (result.dataOnly.loc > 0 ? '纯数据' : '') : '') + '）');
  if (perLang.length > 1) {
    console.log('');
    console.log('按语言：');
    for (const p of perLang) console.log('  ' + p.lang.padEnd(7) + p.autoConvertiblePct + '%   ' + p.files + ' 文件 / ' + p.totalLoc + ' 行');
  }
  console.log('');
  console.log('模块级耦合率（前 ' + result.topModules.length + '）：');
  for (const m of result.topModules) {
    console.log('  ' + String(m.loc).padStart(7) + ' 行  耦合 ' + String(m.couplingPct).padStart(3) + '%  ' + m.pkg);
  }
  console.log('');
  console.log('最大的纯逻辑文件（转写候选）：');
  for (const f of result.largestPureFiles.slice(0, 10)) {
    console.log('  ' + String(f.loc).padStart(6) + '  [' + f.lang + '] ' + f.path);
  }
}
