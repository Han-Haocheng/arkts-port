#!/usr/bin/env node
/**
 * cases/js-ts-yoga/arkts-fix.mjs —— yoga 案例的确定性 ArkTS 修复层（只改 adapt-arkts 产物，不碰上游/staged 源）。
 *
 * 背景：adapt-arkts --ets 之后的两个 .ets 在 ArkTS 全量可达 probe 下有 136 条约定错误
 * （README §5.2 基线）：enums 的 const-object + type query/as const/同名 type + aliased index（112 条），
 * index 的对象字面量类型/未具名对象字面量/unknown（24 条）。本脚本按固定规则机械修复：
 *
 *   enums.ets：16 个 export const X = {...} as const + export type X = (typeof X)[keyof typeof X]
 *              → export enum X { A = 0, ... }（数值不变；调用方 Align.Center 语义不变）
 *   index.ets：对象字面量类型声明 → interface（Value/Layout/Style/Config/Size/Yoga）；
 *              内联对象类型（MeasureFunction 返回、getComputedLayout、getYogaCounters）→ 具名 interface；
 *              setDirtiedFunc 的 unknown → 具体函数类型；Yoga 的嵌套对象类型 → 具名 interface。
 *
 * 用法（仓库根目录）：
 *   node cases/js-ts-yoga/arkts-fix.mjs [--in <adapt dir>] [--out <fixed dir>] [--json]
 *   --in  默认 out/js-ts-yoga/adapt；--out 默认 out/js-ts-yoga/adapt-fixed（每次从 --in 重新复制）
 *
 * 每条规则都断言「命中次数恰好等于期望值」，命中数不符即 exit 1（不静默改坏）；输出确定性、可重复。
 * 退出码：0 成功；1 锚点/规则不符；2 用法错误；3 输入缺失（SKIP）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_IN = join(repoRoot, 'out', 'js-ts-yoga', 'adapt');
const DEFAULT_OUT = join(repoRoot, 'out', 'js-ts-yoga', 'adapt-fixed');

const USAGE = [
  '用法：',
  '  node cases/js-ts-yoga/arkts-fix.mjs [--in <adapt dir>] [--out <fixed dir>] [--json]',
  '',
  '对 adapt-arkts --ets 的产物做确定性 ArkTS 修复（不改上游源/staged 源）：',
  '  enums.ets：const-object + typeof/索引类型/as const → export enum（数值不变）',
  '  index.ets：对象字面量类型 → interface；内联对象类型 → 具名 interface；unknown → 具体类型',
  '  每条规则的命中次数必须正好等于期望值，否则 exit 1',
  '',
  '退出码：0 成功；1 规则不符；2 用法错误；3 输入缺失（SKIP）',
].join('\n');

const argv = process.argv.slice(2);
const args = { inDir: DEFAULT_IN, outDir: DEFAULT_OUT, json: false, help: false };
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (token === '--json') args.json = true;
  else if (token === '-h' || token === '--help') args.help = true;
  else if (token === '--in' || token === '--out') {
    const value = argv[i + 1];
    if (value === undefined || value === '') {
      process.stderr.write('arkts-fix.mjs: ' + token + ' 缺少取值\n');
      process.exit(2);
    }
    args[token === '--in' ? 'inDir' : 'outDir'] = resolve(value);
    i++;
  } else {
    process.stderr.write('arkts-fix.mjs: 未知参数 ' + token + '\n');
    process.stderr.write(USAGE + '\n');
    process.exit(2);
  }
}
if (args.help) {
  process.stdout.write(USAGE + '\n');
  process.exit(0);
}
if (!existsSync(join(args.inDir, 'yoga', 'index.ets')) || !existsSync(join(args.inDir, 'yoga', 'enums.ets'))) {
  process.stderr.write('SKIP: 找不到 adapt 产物（期望 ' + join(args.inDir, 'yoga', 'index.ets') + '）\n');
  process.exit(3);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 断言并替换：anchor 出现次数必须等于 expected（字符串精确匹配）。 */
function replaceOnce(text, anchor, replacement, label, expected) {
  const want = expected === undefined ? 1 : expected;
  const count = text.split(anchor).length - 1;
  if (count !== want) {
    throw new Error(label + '：锚点出现 ' + count + ' 次（期望 ' + want + ' 次）：' + JSON.stringify(anchor.slice(0, 120)));
  }
  return text.split(anchor).join(replacement);
}

/** enums：export const X = {...} as const + export type X = ... → export enum X {...}。 */
function fixEnums(text) {
  const lines = text.split('\n');
  const output = [];
  const converted = [];
  let i = 0;
  while (i < lines.length) {
    const start = /^export const ([A-Za-z_$][\w$]*) = \{$/.exec(lines[i]);
    if (start === null) {
      output.push(lines[i]);
      i++;
      continue;
    }
    const name = start[1];
    const members = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '} as const') break;
      const member = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(-?\d+),?\s*$/.exec(line);
      if (member === null) throw new Error('enums：' + name + ' 成员行不符合预期：' + JSON.stringify(line));
      members.push({ name: member[1], value: member[2] });
    }
    if (j >= lines.length) throw new Error('enums：' + name + ' 缺少 } as const');
    j++;
    let k = j;
    while (k < lines.length) {
      const trimmed = lines[k].trim();
      if (trimmed === '' || trimmed.startsWith('/**') || trimmed.startsWith('*') || trimmed === '*/') {
        k++;
        continue;
      }
      break;
    }
    const typeStart = /^export type ([A-Za-z_$][\w$]*) =/.exec(lines[k] === undefined ? '' : lines[k]);
    if (typeStart === null || typeStart[1] !== name) {
      throw new Error('enums：' + name + ' 之后找不到 export type ' + name + '（实际行：' + JSON.stringify(lines[k]) + '）');
    }
    let depth = 0;
    let end = k;
    for (; end < lines.length; end++) {
      const line = lines[end];
      for (const ch of line) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
      }
      const trimmed = line.trim();
      const continues = trimmed.endsWith('=') || trimmed.endsWith('[') || trimmed.endsWith('(') ||
        (lines[end + 1] !== undefined && /^\s*[(\[]/.test(lines[end + 1]));
      if (depth === 0 && !continues) break;
    }
    if (end >= lines.length) throw new Error('enums：' + name + ' 的 type 定义没有结束');
    output.push('export enum ' + name + ' {');
    for (const member of members) output.push('  ' + member.name + ' = ' + member.value + ',');
    output.push('}');
    converted.push({ name, members: members.length });
    i = end + 1;
  }
  return { text: output.join('\n'), converted };
}

const COMPUTED_LAYOUT_INTERFACE = [
  '/**',
  ' * ArkTS 修复层（cases/js-ts-yoga/arkts-fix.mjs）：对象字面量类型必须具名。',
  ' * getComputedLayout 的返回形状。',
  ' */',
  'export interface ComputedLayout {',
  '  left: number',
  '  top: number',
  '  right: number',
  '  bottom: number',
  '  width: number',
  '  height: number',
  '}',
  '',
  '/** getYogaCounters 的返回形状。 */',
  'export interface YogaCounters {',
  '  visited: number',
  '  measured: number',
  '  cacheHits: number',
  '  live: number',
  '}',
  '',
].join('\n');

/** index：对象字面量类型 → interface；内联对象类型 → 具名 interface；unknown → 具体类型。 */
function fixIndex(text) {
  const transforms = [];
  const apply = (label, anchor, replacement, expected) => {
    const before = text.split(anchor).length - 1;
    text = replaceOnce(text, anchor, replacement, label, expected);
    transforms.push({ label, count: before });
  };

  // 1) 对象字面量类型声明 → interface（ArkTS: arkts-no-obj-literals-as-types）
  apply('Value type→interface', 'export type Value = {', 'export interface Value {');
  apply('Layout type→interface', 'type Layout = {', 'interface Layout {');
  apply('Style type→interface', 'type Style = {', 'interface Style {');
  apply('Config type→interface', 'export type Config = {', 'export interface Config {');
  apply('Size type→interface',
    'export type Size = { width: number; height: number }',
    ['export interface Size {', '  width: number', '  height: number', '}'].join('\n'));
  // 2) MeasureFunction 的返回内联对象类型 → Size
  apply('MeasureFunction return→Size',
    ') => { width: number; height: number }',
    ') => Size');
  // 3) getComputedLayout 内联返回类型 → ComputedLayout
  apply('getComputedLayout return→ComputedLayout', [
    'getComputedLayout(): {',
    '    left: number',
    '    top: number',
    '    right: number',
    '    bottom: number',
    '    width: number',
    '    height: number',
    '  } {',
  ].join('\n'), 'getComputedLayout(): ComputedLayout {');
  // 4) getYogaCounters 内联返回类型 → YogaCounters
  apply('getYogaCounters return→YogaCounters', [
    'export function getYogaCounters(): {',
    '  visited: number',
    '  measured: number',
    '  cacheHits: number',
    '  live: number',
    '} {',
  ].join('\n'), 'export function getYogaCounters(): YogaCounters {');
  // 5) Yoga 的嵌套对象类型 → 具名 interface
  apply('Yoga nested→named interfaces', [
    'export type Yoga = {',
    '  Config: {',
    '    create(): Config',
    '    destroy(config: Config): void',
    '  }',
    '  Node: {',
    '    create(config?: Config): Node',
    '    createDefault(): Node',
    '    createWithConfig(config: Config): Node',
    '    destroy(node: Node): void',
    '  }',
    '}',
  ].join('\n'), [
    'export interface YogaConfigFactory {',
    '  create(): Config',
    '  destroy(config: Config): void',
    '}',
    '',
    'export interface YogaNodeFactory {',
    '  create(config?: Config): Node',
    '  createDefault(): Node',
    '  createWithConfig(config: Config): Node',
    '  destroy(node: Node): void',
    '}',
    '',
    'export interface Yoga {',
    '  Config: YogaConfigFactory',
    '  Node: YogaNodeFactory',
    '}',
  ].join('\n'));
  // 6) createConfig 的「带方法对象字面量」→ 类实现（ArkTS 不接受带方法的对象字面量）
  const createConfigAnchor = [
    'function createConfig(): Config {',
    '  const config: Config = {',
    '    pointScaleFactor: 1,',
    '    errata: Errata.None,',
    '    useWebDefaults: false,',
    '    free() {},',
    '    isExperimentalFeatureEnabled() {',
    '      return false',
    '    },',
    '    setExperimentalFeatureEnabled() {},',
    '    setPointScaleFactor(f) {',
    '      config.pointScaleFactor = f',
    '    },',
    '    getErrata() {',
    '      return config.errata',
    '    },',
    '    setErrata(e) {',
    '      config.errata = e',
    '    },',
    '    setUseWebDefaults(v) {',
    '      config.useWebDefaults = v',
    '    },',
    '  }',
    '  return config',
    '}',
  ].join('\n');
  apply('createConfig → class ConfigImpl', createConfigAnchor, [
    'class ConfigImpl implements Config {',
    '  pointScaleFactor: number = 1',
    '  errata: Errata = Errata.None',
    '  useWebDefaults: boolean = false',
    '  free(): void {}',
    '  isExperimentalFeatureEnabled(_: ExperimentalFeature): boolean {',
    '    return false',
    '  }',
    '  setExperimentalFeatureEnabled(_: ExperimentalFeature, __: boolean): void {}',
    '  setPointScaleFactor(f: number): void {',
    '    this.pointScaleFactor = f',
    '  }',
    '  getErrata(): Errata {',
    '    return this.errata',
    '  }',
    '  setErrata(errata: Errata): void {',
    '    this.errata = errata',
    '  }',
    '  setUseWebDefaults(v: boolean): void {',
    '    this.useWebDefaults = v',
    '  }',
    '}',
    '',
    'function createConfig(): Config {',
    '  return new ConfigImpl()',
    '}',
  ].join('\n'));

  // 7) YOGA_INSTANCE 的嵌套对象字面量（带方法）→ 类实现
  const yogaInstanceAnchor = [
    'const YOGA_INSTANCE: Yoga = {',
    '  Config: {',
    '    create: createConfig,',
    '    destroy() {},',
    '  },',
    '  Node: {',
    '    create: (config?: Config) => new Node(config),',
    '    createDefault: () => new Node(),',
    '    createWithConfig: (config: Config) => new Node(config),',
    '    destroy() {},',
    '  },',
    '}',
  ].join('\n');
  apply('YOGA_INSTANCE → class YogaImpl', yogaInstanceAnchor, [
    'class YogaConfigFactoryImpl implements YogaConfigFactory {',
    '  create(): Config {',
    '    return createConfig()',
    '  }',
    '  destroy(_config: Config): void {}',
    '}',
    '',
    'class YogaNodeFactoryImpl implements YogaNodeFactory {',
    '  create(config?: Config): Node {',
    '    return new Node(config)',
    '  }',
    '  createDefault(): Node {',
    '    return new Node()',
    '  }',
    '  createWithConfig(config: Config): Node {',
    '    return new Node(config)',
    '  }',
    '  destroy(_node: Node): void {}',
    '}',
    '',
    'class YogaImpl implements Yoga {',
    '  Config: YogaConfigFactory = new YogaConfigFactoryImpl()',
    '  Node: YogaNodeFactory = new YogaNodeFactoryImpl()',
    '}',
    '',
    'const YOGA_INSTANCE: Yoga = new YogaImpl()',
  ].join('\n'));

  // 8) unknown → 具体类型（arkts-no-any-unknown）
  apply('setDirtiedFunc unknown→concrete',
    'setDirtiedFunc(_: unknown): void {}',
    'setDirtiedFunc(_fn: (() => void) | null): void {}');
  // 7) 在 import 块之后插入具名 interface（ComputedLayout / YogaCounters）
  apply('insert fix interfaces',
    "} from './enums'\n",
    "} from './enums'\n\n" + COMPUTED_LAYOUT_INTERFACE);

  return { text, transforms };
}

mkdirSync(args.outDir, { recursive: true });
rmSync(args.outDir, { recursive: true, force: true });
cpSync(args.inDir, args.outDir, { recursive: true });

const files = [];
const target = join(args.outDir, 'yoga');
for (const name of ['enums.ets', 'index.ets']) {
  const path = join(target, name);
  const original = readFileSync(path, 'utf8');
  const fixed = name === 'enums.ets' ? fixEnums(original) : fixIndex(original);
  const text = fixed.text;
  if (text.includes('as const')) throw new Error(name + '：修复后仍有 as const');
  if (/\(typeof [A-Za-z_$][\w$]*\)\[keyof/.test(text)) throw new Error(name + '：修复后仍有 typeof 类型查询');
  if (/\bunknown\b/.test(text)) throw new Error(name + '：修复后仍有 unknown');
  writeFileSync(path, text, 'utf8');
  files.push({
    path: relative(args.outDir, path).split('\\').join('/'),
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256(text),
    transforms: fixed.converted === undefined
      ? fixed.transforms
      : [{ label: 'enums→enum', count: fixed.converted.length }],
  });
}

const payload = { ok: true, inDir: relative(repoRoot, args.inDir).split('\\').join('/'), outDir: relative(repoRoot, args.outDir).split('\\').join('/'), files };
if (args.json) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  process.stdout.write('arkts-fix: ' + payload.outDir + '（来自 ' + payload.inDir + '）\n');
  for (const file of files) {
    process.stdout.write('  ' + file.path + '  ' + file.bytes + ' B  sha256 ' + file.sha256.slice(0, 12) + '…\n');
    for (const item of file.transforms) process.stdout.write('    - ' + item.label + ' ×' + item.count + '\n');
  }
}
