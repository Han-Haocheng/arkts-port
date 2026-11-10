#!/usr/bin/env node
/**
 * arkts-fix —— 对 adapt-arkts 产物（.ets）做「高置信、可断言」的 ArkTS 机械修复（原型，未接 port/adapt-arkts）。
 *
 * 只做两类规则（其余一律不动，宁可漏修也不猜）：
 *  1) as-const-object-to-enum（默认开启）：
 *       export const X = { A: 0, B: 1 } as const;
 *       export type X = (typeof X)[keyof typeof X];
 *     → export enum X { A = 0, B = 1 }
 *     成员只接受数字/字符串字面量；必须紧跟着配对的 typeof/keyof 类型别名；否则整块跳过并记入 skips。
 *     这条规则消除的是它自己引入的 arkts-no-as-const / arkts-no-type-query / arkts-no-aliases-by-index（以及同名重声明）。
 *  2) object-type-alias-to-interface（默认开启，可用 --no-obj-type-alias 关闭）：
 *       export type X = { ... }  (整个别名就是一个对象类型字面量)
 *     → export interface X { ... }
 *     只在安全时转换：别名体必须是单个对象字面量类型（顶层无 | / &），且文件里没有同名值声明（const/let/var/function/class）。
 *     inline 对象类型 / 字面量推断 / 带方法的对象字面量不在这里做（见 cases/js-ts-yoga/arkts-fix.mjs 的案例专用做法）。
 *
 * 用法：
 *   node cli/arkts-fix.ts --src <adapt 产物目录> --out <修复后目录> [--json] [--report <path>]
 *        [--dry-run] [--no-obj-type-alias] [--help]
 *
 * 参数：
 *   --src <dir>        必填，adapt-arkts --ets 的产物目录（递归扫描 .ets）
 *   --out <dir>        输出目录（与 src 同构；不能等于/位于 src 内）；--dry-run 时可不给
 *   --dry-run          只分析、不落盘（报告照常输出）
 *   --no-obj-type-alias 关闭规则 2（只做 as const 对象→enum）
 *   --json             stdout 只输出结构化 JSON
 *   --report <path>    把同一份 JSON 写到文件（目录自动创建）
 *   --help, -h         显示本帮助
 *
 * 报告 JSON：
 *   { ok, src, out, dryRun, rules:{<rule>: count}, files:[{path, bytesIn, bytesOut, changed,
 *     sha256In, sha256Out, rules:[{rule, count, members?}], skips:[{rule, line, reason}] }],
 *     totals:{files, changed, transforms, skips} }
 *
 * 退出码：0 = 成功（0 命中也是 0）；1 = 规则内部不一致/读写失败；2 = 用法错误。
 * 确定性：文件按相对路径排序；内容不含时间戳/绝对路径以外的易变信息；同输入两次运行逐字节相同。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const VALUE_OPTS = new Set(['src', 'out', 'report']);
const BOOL_OPTS = new Set(['json', 'dry-run', 'no-obj-type-alias', 'help']);

const USAGE = [
  '用法：',
  '  node cli/arkts-fix.ts --src <adapt 产物目录> --out <修复后目录> [--json] [--report <path>]',
  '       [--dry-run] [--no-obj-type-alias] [--help]',
  '',
  '对 adapt-arkts --ets 的产物做高置信机械修复（不接 port/adapt-arkts；只改输出副本）：',
  '  1) export const X = {...} as const + export type X = (typeof X)[keyof typeof X] → export enum X {...}',
  '  2) export type X = { ... }（单个对象类型字面量）→ export interface X { ... }（--no-obj-type-alias 关闭）',
  '非目标代码一律不动；每条规则的命中数写进报告，命中为 0 也成功。',
  '',
  '退出码：0 = 成功；1 = 规则内部不一致/读写失败；2 = 用法错误',
].join('\n');

interface RawCli {
  [key: string]: string | boolean;
}

function failUsage(message: string): never {
  console.error('arkts-fix: ' + message);
  console.error('用法见：node cli/arkts-fix.ts --help');
  process.exit(2);
}

function parseArgs(argv: string[]): RawCli {
  const raw: RawCli = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') { raw.help = true; continue; }
    if (!token.startsWith('--')) failUsage('无法识别的参数：' + token);
    const eq = token.indexOf('=');
    if (eq > 2) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
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

interface RuleHit {
  rule: string;
  count: number;
  members?: number;
}

interface RuleSkip {
  rule: string;
  line: number;
  reason: string;
}

interface FileFix {
  text: string;
  rules: RuleHit[];
  skips: RuleSkip[];
}

const RULE_ENUM = 'as-const-object-to-enum';
const RULE_INTERFACE = 'object-type-alias-to-interface';

function isCodeFile(name: string): boolean {
  return name.endsWith('.ets');
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, root, out);
      continue;
    }
    if (!isCodeFile(entry.name)) continue;
    out.push(relative(root, path).split(sep).join('/'));
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const MEMBER_RE = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:(-?\d+(?:\.\d+)?)|(['"])([^'"\\]*)\3)\s*,?\s*$/;
const START_RE = /^export const ([A-Za-z_$][\w$]*) = \{$/;
const END_RE = /^\} as const;?\s*$/;

function literalText(match: RegExpExecArray): string {
  if (match[2] !== undefined) return match[2];
  return match[3] + (match[4] === undefined ? '' : match[4]) + match[3];
}

/**
 * 规则 1：export const X = {...} as const + export type X = (typeof X)[keyof typeof X] → export enum X {...}。
 * 只接受「数字/字符串字面量成员 + 紧邻的配对 typeof/keyof 类型别名」；否则整块跳过（不改）。
 */
function fixEnums(text: string): FileFix {
  const lines = text.split('\n');
  const output: string[] = [];
  const skips: RuleSkip[] = [];
  let converted = 0;
  let membersTotal = 0;
  let i = 0;
  while (i < lines.length) {
    const start = START_RE.exec(lines[i]);
    if (start === null) {
      output.push(lines[i]);
      i++;
      continue;
    }
    const name = start[1];
    const members: Array<{ key: string; value: string }> = [];
    let j = i + 1;
    let bad = false;
    let badReason = '';
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (END_RE.test(line)) break;
      const member = MEMBER_RE.exec(line);
      if (member === null) {
        bad = true;
        badReason = '成员不是字面量（' + JSON.stringify(line.trim()) + '）';
        break;
      }
      members.push({ key: member[1], value: literalText(member) });
    }
    if (bad || j >= lines.length) {
      skips.push({ rule: RULE_ENUM, line: i + 1, reason: bad ? badReason : '缺少 } as const 结束行' });
      output.push(lines[i]);
      i++;
      continue;
    }
    const end = j;
    let k = end + 1;
    while (k < lines.length) {
      const trimmed = lines[k].trim();
      if (trimmed === '' || trimmed.startsWith('/**') || trimmed.startsWith('*') || trimmed === '*/') {
        k++;
        continue;
      }
      break;
    }
    const typeLine = k < lines.length ? lines[k].trim() : '';
    const expectedType = 'export type ' + name + ' = (typeof ' + name + ')[keyof typeof ' + name + ']';
    let typeText = typeLine;
    let typeEnd = k;
    if (typeLine.startsWith('export type ' + name + ' =') === false) {
      skips.push({ rule: RULE_ENUM, line: i + 1, reason: '没有紧跟配对的 export type ' + name });
      output.push(lines[i]);
      i++;
      continue;
    }
    // 类型别名允许折成两行（如 export type X =\n  (typeof X)[keyof typeof X]）
    if (typeLine.endsWith('=') && k + 1 < lines.length) {
      typeEnd = k + 1;
      typeText = typeLine + ' ' + lines[k + 1].trim();
    }
    const normalized = typeText.replace(/\s+/g, ' ').trim();
    if (normalized !== expectedType) {
      skips.push({ rule: RULE_ENUM, line: i + 1, reason: '配对的类型别名不是 (typeof ' + name + ')[keyof typeof ' + name + ']' });
      output.push(lines[i]);
      i++;
      continue;
    }
    output.push('export enum ' + name + ' {');
    for (const member of members) output.push('  ' + member.key + ' = ' + member.value + ',');
    output.push('}');
    converted++;
    membersTotal += members.length;
    i = typeEnd + 1;
  }
  const rules: RuleHit[] = converted > 0 ? [{ rule: RULE_ENUM, count: converted, members: membersTotal }] : [];
  return { text: output.join('\n'), rules, skips };
}

function lineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function offsetLine(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function escapeRegExp(value: string): string {
  let out = '';
  for (const ch of value) {
    if ('\\^$.*+?()[]{}|'.indexOf(ch) >= 0) out += '\\';
    out += ch;
  }
  return out;
}

/**
 * 规则 2：export type X = { ... }（单个对象类型字面量、顶层无 |/&）→ export interface X { ... }。
 * 文件里存在同名值声明（const/let/var/function/class）时跳过（会引入 arkts-unique-names）。
 */
function fixObjectTypeAliases(text: string): FileFix {
  const starts = lineStarts(text);
  const skips: RuleSkip[] = [];
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  // 单行对象类型别名：export type Size = { width: number; height: number }
  const singleLine = /^(export )?type ([A-Za-z_$][\w$]*) = \{([^{}\n]*)\}[ \t]*;?[ \t]*$/gm;
  // 单行但不是「纯对象别名」（后面接 | / &）：记录跳过，保持原样
  const singleImpure = /^(export )?type ([A-Za-z_$][\w$]*) = \{[^{}\n]*\}[ \t]*[|&]/gm;
  let impure = singleImpure.exec(text);
  while (impure !== null) {
    skips.push({ rule: RULE_INTERFACE, line: offsetLine(starts, impure.index), reason: '不是单个对象字面量（顶层 | / &）' });
    impure = singleImpure.exec(text);
  }
  let single = singleLine.exec(text);
  while (single !== null) {
    const name = single[2];
    const script = escapeRegExp(name);
    const valueDecl = new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|function|class)\\s+' + script + '\\b', 'm');
    const before = text.slice(0, single.index);
    const members = single[3].split(';').map((part) => part.trim()).filter((part) => part !== '');
    if (valueDecl.test(text) || members.length === 0) {
      if (valueDecl.test(text)) {
        skips.push({ rule: RULE_INTERFACE, line: offsetLine(starts, single.index), reason: '存在同名值声明 ' + name + '（会触发 arkts-unique-names）' });
      }
      single = singleLine.exec(text);
      continue;
    }
    const lines = [((single[1] === undefined ? '' : 'export ') + 'interface ' + name + ' {')];
    for (const member of members) lines.push('  ' + member);
    lines.push('}');
    edits.push({ start: single.index, end: single.index + single[0].length, replacement: lines.join('\n') });
    single = singleLine.exec(text);
  }
  const pattern = /^(export )?type ([A-Za-z_$][\w$]*) = \{$/gm;
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[2];
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) {
      skips.push({ rule: RULE_INTERFACE, line: offsetLine(starts, match.index), reason: '花括号不平衡' });
      match = pattern.exec(text);
      continue;
    }
    let after = close + 1;
    while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after++;
    if (after < text.length && text[after] === ';') after++;
    while (after < text.length && (text[after] === '\n' || text[after] === '\r' || text[after] === ' ' || text[after] === '\t')) after++;
    const next = after < text.length ? text[after] : '';
    if (next === '&' || next === '|') {
      skips.push({ rule: RULE_INTERFACE, line: offsetLine(starts, match.index), reason: '别名不是单个对象字面量（顶层 & / |）' });
      match = pattern.exec(text);
      continue;
    }
    const script = escapeRegExp(name);
    const valueDecl = new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|function|class)\\s+' + script + '\\b', 'm');
    if (valueDecl.test(text)) {
      skips.push({ rule: RULE_INTERFACE, line: offsetLine(starts, match.index), reason: '存在同名值声明 ' + name + '（会触发 arkts-unique-names）' });
      match = pattern.exec(text);
      continue;
    }
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: (match[1] === undefined ? '' : 'export ') + 'interface ' + name + ' {',
    });
    void open;
    void close;
    match = pattern.exec(text);
  }
  if (edits.length === 0) return { text, rules: [], skips };
  edits.sort((a, b) => a.start - b.start);
  let out = text;
  let previousEnd = -1;
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].start < previousEnd) throw new Error('规则 2 的内部错误：匹配区间重叠');
    previousEnd = edits[i].end;
  }
  for (let i = edits.length - 1; i >= 0; i--) {
    out = out.slice(0, edits[i].start) + edits[i].replacement + out.slice(edits[i].end);
  }
  return { text: out, rules: [{ rule: RULE_INTERFACE, count: edits.length }], skips };
}

function applyRules(text: string, allowObjTypeAlias: boolean): FileFix {
  const first = fixEnums(text);
  const second = allowObjTypeAlias ? fixObjectTypeAliases(first.text) : { text: first.text, rules: [], skips: [] };
  return {
    text: second.text,
    rules: first.rules.concat(second.rules),
    skips: first.skips.concat(second.skips),
  };
}

function main(): void {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.help === true) {
    console.log(USAGE);
    process.exit(0);
  }
  const srcArg = typeof raw.src === 'string' ? raw.src : null;
  const outArg = typeof raw.out === 'string' ? raw.out : null;
  const dryRun = raw['dry-run'] === true;
  const allowObjTypeAlias = raw['no-obj-type-alias'] !== true;
  const json = raw.json === true;
  const reportArg = typeof raw.report === 'string' ? raw.report : null;
  if (srcArg === null) failUsage('缺少 --src（adapt-arkts 产物目录）');
  if (outArg === null && !dryRun) failUsage('缺少 --out（修复后目录；--dry-run 时可不给）');
  const cwd = process.cwd();
  const srcAbs = resolve(cwd, srcArg);
  if (!existsSync(srcAbs) || !statSync(srcAbs).isDirectory()) failUsage('--src 不是目录：' + srcArg);
  let outAbs: string | null = null;
  if (outArg !== null) {
    outAbs = resolve(cwd, outArg);
    if (outAbs === srcAbs) failUsage('--out 不能等于 --src');
    if (outAbs.startsWith(srcAbs + sep)) failUsage('--out 不能位于 --src 内：' + outArg);
    if (!dryRun && !existsSync(outAbs)) mkdirSync(outAbs, { recursive: true });
  }
  const rels: string[] = [];
  walk(srcAbs, srcAbs, rels);
  rels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files: Array<Record<string, unknown>> = [];
  const ruleTotals: Record<string, number> = {};
  let changed = 0;
  let transforms = 0;
  let skipTotal = 0;
  for (const rel of rels) {
    const inAbs = join(srcAbs, rel.split('/').join(sep));
    const textIn = readFileSync(inAbs, 'utf8');
    const fixed = applyRules(textIn, allowObjTypeAlias);
    const textOut = fixed.text;
    const isChanged = textOut !== textIn;
    if (isChanged) changed++;
    for (const hit of fixed.rules) {
      ruleTotals[hit.rule] = (ruleTotals[hit.rule] === undefined ? 0 : ruleTotals[hit.rule]) + hit.count;
      transforms += hit.count;
    }
    skipTotal += fixed.skips.length;
    if (outAbs !== null && !dryRun) {
      const outFile = join(outAbs, rel.split('/').join(sep));
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, textOut, 'utf8');
    }
    files.push({
      path: rel,
      bytesIn: Buffer.byteLength(textIn, 'utf8'),
      bytesOut: Buffer.byteLength(textOut, 'utf8'),
      changed: isChanged,
      sha256In: sha256(textIn),
      sha256Out: sha256(textOut),
      rules: fixed.rules,
      skips: fixed.skips,
    });
  }
  const report = {
    ok: true,
    src: srcArg,
    out: outArg,
    dryRun,
    rules: ruleTotals,
    files,
    totals: { files: rels.length, changed, transforms, skips: skipTotal },
  };
  const reportText = JSON.stringify(report, null, 2) + '\n';
  if (reportArg !== null) {
    const reportAbs = resolve(cwd, reportArg);
    mkdirSync(dirname(reportAbs), { recursive: true });
    writeFileSync(reportAbs, reportText, 'utf8');
  }
  if (json) {
    process.stdout.write(reportText);
    return;
  }
  const ruleLines = Object.keys(ruleTotals).sort().map((rule) => '  ' + rule + ' ×' + ruleTotals[rule]);
  console.log('arkts-fix（' + (dryRun ? 'dry-run' : '写入 ' + String(outArg)) + '）');
  console.log('  文件 ' + rels.length + '，改动 ' + changed + '，规则命中 ' + transforms + '，跳过 ' + skipTotal);
  for (const line of ruleLines) console.log(line);
  for (const file of files) {
    const hits = (file.rules as RuleHit[]).map((hit) => hit.rule + '×' + hit.count).join('，');
    const skips = file.skips as RuleSkip[];
    if (hits === '' && skips.length === 0) continue;
    console.log('  ' + String(file.path) + (hits === '' ? '' : '：' + hits) + (skips.length === 0 ? '' : '（跳过 ' + skips.length + '）'));
    for (const skip of skips) console.log('    - 跳过 ' + skip.rule + ' @' + skip.line + '：' + skip.reason);
  }
}

main();