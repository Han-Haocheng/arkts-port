#!/usr/bin/env node
/**
 * 保真度门禁：比对「原实现产出的 golden」与「转写实现重放的结果」。
 *
 * 用法：
 *   node cli/verify-fidelity.ts --golden golden.json --actual actual.json [--json]
 *   node cli/verify-fidelity.ts ... --key scenario --items pages --field text
 *   node cli/verify-fidelity.ts --help
 *
 * 默认形状（cases/legado 使用）：[{ scenario, pageCount, pages: [{ text, ... }] }]
 * 门禁口径：100% 逐项一致 **且** golden 里的场景在 actual 中全部存在。
 * 缺失场景（golden 有、actual 无）算 FAIL —— 不能因为「没得比」就判通过。
 * totalItems=0（没有任何可比较 item）单独记为 NO_ITEMS：场景全等时 exit 0（输出 N/A，不打印误导的
 * 0%），有缺失场景/结构差异仍 FAIL；JSON 增 noItems/verdict（fidelityPct 在 NO_ITEMS 时为 null）。
 *
 * 退出码：0 = 100% 一致且无缺失场景；1 = 有差异或缺失场景；2 = 用法/文件缺失。
 */
import { readFileSync } from 'node:fs';

const USAGE = [
  '用法：',
  '  node cli/verify-fidelity.ts --golden <a.json> --actual <b.json> [--json]',
  '  node cli/verify-fidelity.ts --golden <a.json> --actual <b.json>',
  '       [--key scenario] [--items pages] [--field text]',
  '',
  '比对原实现 golden 与转写实现 actual。默认结构：',
  '  [{ "scenario": "s1", "pages": [{ "text": "..." }] }]',
  '',
  '参数：',
  '  --golden <a.json>   golden 数据（顶层数组）',
  '  --actual <b.json>   重放结果（顶层数组）',
  '  --key <name>        场景键字段（默认 scenario）',
  '  --items <name>      逐项比对数组字段（默认 pages）',
  '  --field <name>      逐项比对字段（默认 text）',
  '  --json              stdout 只输出结构化 JSON',
  '  --help, -h          显示本帮助',
  '',
  '输出（默认，供 cli/port.ts 解析）：',
  '  保真度: <pct>%  (<same>/<total>)              items 比对正常时',
  '  保真度: N/A（0 items 可比较）                 totalItems=0 时（NO_ITEMS），不再打印误导的 0%',
  '  场景全等: <same>/<total>',
  '  DIFF <scenario> ... / MISSING <scenario>',
  '  门禁: PASS|FAIL（必须 100%）；NO_ITEMS 且场景全等 → PASS（exit 0），有缺失场景/结构差异仍 FAIL',
  '',
  'JSON 字段：totalItems / sameItems / fidelityPct（NO_ITEMS 时为 null）/ sameScenarios / totalScenarios /',
  '  missingScenarios / noItems / verdict(PASS|FAIL|NO_ITEMS) / pass / details',
  '',
  '退出码：0 = 100% 一致且无缺失场景；1 = 有差异或缺失场景；2 = 用法/文件缺失',
].join('\n');

const VALUE_OPTS = new Set(['golden', 'actual', 'key', 'items', 'field']);
const BOOL_OPTS = new Set(['json', 'help']);

function failUsage(message: string): never {
  console.error('verify-fidelity: ' + message);
  console.error('用法见：node cli/verify-fidelity.ts --help');
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

function readJsonArray(path: string, label: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    failUsage('无法读取 ' + label + '：' + path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failUsage(label + ' 不是合法 JSON：' + path);
  }
  if (!Array.isArray(parsed)) failUsage(label + ' 顶层必须是数组：' + path);
  return parsed as Record<string, unknown>[];
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.golden === undefined || args.actual === undefined) {
  failUsage('缺少 --golden 或 --actual');
}

const keyField = String(args.key ?? 'scenario');
const itemsField = String(args.items ?? 'pages');
const compareField = String(args.field ?? 'text');

const golden = readJsonArray(String(args.golden), '--golden');
const actual = readJsonArray(String(args.actual), '--actual');
const actualByKey = new Map(actual.map((s) => [String(s[keyField]), s]));

let totalItems = 0;
let sameItems = 0;
let sameScenarios = 0;
let missingScenarios = 0;
const details: Record<string, unknown>[] = [];

for (const g of golden) {
  const key = String(g[keyField]);
  const a = actualByKey.get(key);
  if (!a) {
    // 缺失场景不能算通过：统计上不贡献 sameItems，同时单独计数并打印 MISSING
    missingScenarios++;
    details.push({
      scenario: key,
      status: 'missing',
      expectedItems: ((g[itemsField] as unknown[]) ?? []).length,
      actualItems: 0,
      sameItems: 0,
      countMatch: false,
      firstDiffs: [],
    });
    continue;
  }
  const gItems = (g[itemsField] as Record<string, unknown>[]) ?? [];
  const aItems = (a[itemsField] as Record<string, unknown>[]) ?? [];
  const n = Math.max(gItems.length, aItems.length);
  let same = 0;
  const diffs: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    totalItems++;
    const gv = gItems[i]?.[compareField];
    const av = aItems[i]?.[compareField];
    if (gv !== undefined && av !== undefined && gv === av) { same++; sameItems++; }
    else diffs.push({ index: i, expected: gv ?? '<none>', actual: av ?? '<none>' });
  }
  if (gItems.length === aItems.length && diffs.length === 0) sameScenarios++;
  details.push({
    scenario: key,
    expectedItems: gItems.length,
    actualItems: aItems.length,
    sameItems: same,
    countMatch: gItems.length === aItems.length,
    firstDiffs: diffs.slice(0, 3),
  });
}

// totalItems=0 是「没有可比对的 item」，不是「0% 保真」：
// - 场景齐全且结构一致 → NO_ITEMS（PASS，exit 0）
// - 有缺失场景/结构差异 → FAIL（exit 1）
const noItems = totalItems === 0;
const allScenariosEqual = missingScenarios === 0 && sameScenarios === golden.length;
const pct = noItems ? 0 : sameItems * 100 / totalItems;
const pass = noItems ? allScenariosEqual : sameItems === totalItems && missingScenarios === 0;
const verdict = pass ? (noItems ? 'NO_ITEMS' : 'PASS') : 'FAIL';
const result = {
  totalItems,
  sameItems,
  fidelityPct: noItems ? null : Math.round(pct * 100) / 100,
  sameScenarios,
  totalScenarios: golden.length,
  missingScenarios,
  noItems,
  verdict,
  pass,
  details,
};

if (args.json) {
  console.log(JSON.stringify(result, null, 1));
} else {
  if (noItems) {
    console.log('保真度: N/A（0 items 可比较）');
    console.log('场景全等: ' + result.sameScenarios + '/' + result.totalScenarios);
    console.log('警告: NO_ITEMS —— golden/actual 里没有任何可比较的 item；场景全等时按 NO_ITEMS 判定（exit 0），有缺失场景/结构差异仍 FAIL');
  } else {
    console.log('保真度: ' + result.fidelityPct + '%  (' + result.sameItems + '/' + result.totalItems + ')');
    console.log('场景全等: ' + result.sameScenarios + '/' + result.totalScenarios);
  }
  for (const d of details) {
    if (d.status === 'missing') {
      console.log('  MISSING ' + String(d.scenario));
      continue;
    }
    const ok = d.countMatch === true && ((d.firstDiffs as unknown[]) ?? []).length === 0;
    if (!ok) {
      console.log('  DIFF ' + String(d.scenario) + '  ' + d.actualItems + '/' + d.expectedItems + ' 一致 ' + d.sameItems);
      for (const dd of ((d.firstDiffs as Record<string, unknown>[]) ?? [])) {
        console.log('      #' + dd.index + ' expected=' + JSON.stringify(dd.expected).slice(0, 60) +
          ' actual=' + JSON.stringify(dd.actual).slice(0, 60));
      }
    }
  }
  if (missingScenarios > 0) {
    console.log('缺失场景: ' + missingScenarios + ' 个（golden 有、actual 无）算 FAIL');
  }
  console.log(pass
    ? (noItems ? '门禁: PASS（NO_ITEMS：无可比较 items，未做逐项比对）' : '门禁: PASS')
    : '门禁: FAIL（必须 100%）');
}

process.exitCode = pass ? 0 : 1;
