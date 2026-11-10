#!/usr/bin/env node
/**
 * 环境/工程预检（doctor）：在构建前一次性查清「环境为什么跑不起来」。
 *
 * 背景：环境错一次要烧 3-6 万 token 试错（docs/tooling-backlog.md §5.2）。
 * 本工具只做确定性检查：逐项 PASS/FAIL/WARN + 一句话修法 + rules/pitfalls.md 锚点。
 *
 * 用法：
 *   node cli/doctor.ts [--project <harmony>] [--sdk <p>] [--hvigor <p>] [--case <dir>]
 *        [--json] [--report <path.json>]
 *
 * 退出码：0 = 无 FAIL（WARN 允许）；1 = 有 FAIL；2 = 用法错误。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
  fix: string | null;
  anchor: string;
}

interface RawCli {
  [key: string]: string | boolean;
}

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** 与 cli/build-hap.ts 一致：SDK 组件必须解压在 <home>/<version>/ 下 */
const SDK_VERSION = '26.0.0';
const SDK_SUBDIRS = ['ets', 'js', 'native', 'toolchains', 'previewer'];
const HVIGOR_BIN = '@ohos/hvigor/bin/hvigor.js';
/** OpenHarmony SDK 只认这些 deviceTypes（含 phone 会 00303060 syscap 交集为空） */
const ALLOWED_DEVICE_TYPES = ['default', 'tablet', '2in1', 'tv', 'wearable', 'liteWearable'];

const ANCHOR_TOOLCHAIN = 'rules/pitfalls.md#构建工具链linux-无-deveco';
const ANCHOR_RULES = 'rules/pitfalls.md';
const ANCHOR_CASE = 'cases/legado/README.md#复现步骤';

const USAGE = [
  '用法：',
  '  node cli/doctor.ts [--project <harmony>] [--sdk <p>] [--hvigor <p>] [--case <dir>]',
  '       [--json] [--report <path.json>]',
  '',
  '检查项（逐项 PASS/FAIL/WARN + 修法 + rules/pitfalls.md 锚点）：',
  '  sdk           <sdk>/' + SDK_VERSION + '/{ets,js,native,toolchains,previewer} 是否齐全（缺哪个列哪个）',
  '  hvigor        <hvigor>/' + HVIGOR_BIN + ' 是否存在',
  '  build-profile build-profile.json5 是否可解析（JSON5）',
  '  sdk-version   compileSdkVersion/compatibleSdkVersion/targetSdkVersion 必须是字符串',
  '  runtime-os    runtimeOS 必须是 OpenHarmony',
  '  device-types  module.json5 的 deviceTypes 不含 phone，且属于 default/tablet/2in1/tv/wearable/liteWearable',
  '  ets-dir / entry-page / app-scope  标准工程目录与入口文件是否存在',
  '  node-home     NODE_HOME（默认 /usr/bin）下是否有 node',
  '  env-align     --sdk/--hvigor 与 OHOS_BASE_SDK_HOME/HVIGOR_HOME 是否一致',
  '  case-golden / case-actual   --case 下 golden.json / actual.json 是否存在（缺失只 WARN）',
  '',
  '输出：默认每项一行 + 最终「环境: OK / 有 N 项 FAIL」（≤15 行）；--json 输出结构化报告；',
  '      --report 把同一份 JSON 写到文件。',
  '',
  '退出码：0 = 无 FAIL（WARN 允许）；1 = 有 FAIL；2 = 用法错误',
  '',
  '示例：',
  '  node cli/doctor.ts --project out/harmony --sdk $OHOS_BASE_SDK_HOME --hvigor $HVIGOR_HOME',
  '  node cli/doctor.ts --project . --sdk $OHOS_BASE_SDK_HOME --hvigor $HVIGOR_HOME --case cases/legado --json',
].join('\n');

const VALUE_OPTS = new Set(['project', 'sdk', 'hvigor', 'case', 'report']);
const BOOL_OPTS = new Set(['json', 'help']);

// ---------------------------------------------------------------------------
// 参数解析：任何用法错误 → exit 2
// ---------------------------------------------------------------------------

function failUsage(message: string): never {
  console.error('doctor: ' + message);
  console.error('用法见：node cli/doctor.ts --help');
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
      if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
      if (value === '') failUsage('参数 --' + key + ' 不能为空');
      raw[key] = value;
      continue;
    }
    const key = token.slice(2);
    if (BOOL_OPTS.has(key)) {
      raw[key] = true;
      continue;
    }
    if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) {
      failUsage('参数 --' + key + ' 缺少取值');
    }
    raw[key] = next;
    i++;
  }
  return raw;
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

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function positionLabel(text: string, offset: number): string {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return '第 ' + line + ' 行第 ' + column + ' 列';
}

// ---------------------------------------------------------------------------
// 极简 JSON5 解析（零依赖）：支持 // 与 /* */ 注释、尾逗号、未加引号的 key、
// 单/双引号字符串、+ 号、十六进制、Infinity/NaN。hvigor 的 JSON5 配置常用这几样。
// ---------------------------------------------------------------------------

function parseJson5(input: string): unknown {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const len = text.length;
  let pos = 0;

  function fail(message: string): never {
    throw new SyntaxError(message + '（' + positionLabel(text, pos) + '）');
  }

  function skipSpace(): void {
    for (;;) {
      while (pos < len && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r' ||
        text[pos] === '\u00a0' || text[pos] === '\ufeff')) {
        pos++;
      }
      if (text[pos] === '/' && text[pos + 1] === '/') {
        while (pos < len && text[pos] !== '\n') pos++;
        continue;
      }
      if (text[pos] === '/' && text[pos + 1] === '*') {
        pos += 2;
        while (pos < len && !(text[pos] === '*' && text[pos + 1] === '/')) pos++;
        if (pos >= len) fail('块注释未闭合');
        pos += 2;
        continue;
      }
      return;
    }
  }

  function parseString(): string {
    const quote = text[pos];
    pos++;
    let out = '';
    while (pos < len) {
      const ch = text[pos];
      if (ch === quote) {
        pos++;
        return out;
      }
      if (ch === '\n' || ch === '\r') fail('字符串里不能有裸换行');
      if (ch !== '\\') {
        out += ch;
        pos++;
        continue;
      }
      pos++;
      const esc = text[pos];
      if (esc === undefined) fail('字符串转义未结束');
      const simple: Record<string, string> = {
        b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0',
        '\'': '\'', '"': '"', '\\': '\\', '/': '/',
      };
      if (esc in simple) {
        out += simple[esc];
        pos++;
        continue;
      }
      if (esc === '\n') {
        pos++;
        continue;
      }
      if (esc === 'x') {
        const hex = text.slice(pos + 1, pos + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail('\\x 后需要两位十六进制');
        out += String.fromCharCode(parseInt(hex, 16));
        pos += 3;
        continue;
      }
      if (esc === 'u') {
        const hex = text.slice(pos + 1, pos + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u 后需要四位十六进制');
        out += String.fromCharCode(parseInt(hex, 16));
        pos += 5;
        continue;
      }
      fail('未知转义：\\' + esc);
    }
    fail('字符串未闭合');
  }

  function parseNumber(): number {
    const rest = text.slice(pos);
    const match = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)/.exec(rest);
    if (!match) fail('无法解析的值');
    const literal = match[0];
    pos += literal.length;
    if (literal === 'Infinity' || literal === '+Infinity') return Infinity;
    if (literal === '-Infinity') return -Infinity;
    if (literal === 'NaN' || literal === '+NaN' || literal === '-NaN') return NaN;
    const signed = literal[0] === '+' || literal[0] === '-';
    const sign = literal[0] === '-' ? -1 : 1;
    const body = signed ? literal.slice(1) : literal;
    if (/^0[xX]/.test(body)) return sign * parseInt(body, 16);
    return sign * Number(body);
  }

  function parseIdentifier(): string {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(pos));
    if (!match) fail('无法解析的标识符');
    pos += match[0].length;
    return match[0];
  }

  function parseKey(): string {
    skipSpace();
    if (text[pos] === '"' || text[pos] === '\'') return parseString();
    if (/[0-9]/.test(text[pos])) return String(parseNumber());
    return parseIdentifier();
  }

  function parseValue(): unknown {
    skipSpace();
    if (pos >= len) fail('内容意外结束');
    const ch = text[pos];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"' || ch === '\'') return parseString();
    const rest = text.slice(pos);
    const keyword = /^(true|false|null)\b/.exec(rest);
    if (keyword) {
      pos += keyword[0].length;
      if (keyword[0] === 'true') return true;
      if (keyword[0] === 'false') return false;
      return null;
    }
    return parseNumber();
  }

  function parseObject(): Record<string, unknown> {
    pos++;
    const out: Record<string, unknown> = {};
    for (;;) {
      skipSpace();
      if (text[pos] === '}') {
        pos++;
        return out;
      }
      if (pos >= len) fail('对象未闭合');
      const key = parseKey();
      skipSpace();
      if (text[pos] !== ':') fail('对象 key 后缺少冒号');
      pos++;
      out[key] = parseValue();
      skipSpace();
      if (text[pos] === ',') {
        pos++;
        skipSpace();
        if (text[pos] === '}') {
          pos++;
          return out;
        }
        continue;
      }
      if (text[pos] === '}') {
        pos++;
        return out;
      }
      fail('对象里缺少逗号或右花括号');
    }
  }

  function parseArray(): unknown[] {
    pos++;
    const out: unknown[] = [];
    for (;;) {
      skipSpace();
      if (text[pos] === ']') {
        pos++;
        return out;
      }
      if (pos >= len) fail('数组未闭合');
      out.push(parseValue());
      skipSpace();
      if (text[pos] === ',') {
        pos++;
        continue;
      }
      if (text[pos] === ']') {
        pos++;
        return out;
      }
      fail('数组里缺少逗号或右方括号');
    }
  }

  skipSpace();
  if (pos >= len) fail('文件为空');
  const value = parseValue();
  skipSpace();
  if (pos < len) fail('JSON5 结束后还有多余内容');
  return value;
}

interface ReadJsonResult {
  value: Record<string, unknown> | null;
  error: string | null;
}

function readJson5File(path: string): ReadJsonResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { value: null, error: '读取失败：' + errorMessage(error) };
  }
  try {
    const parsed = parseJson5(text);
    const object = asObject(parsed);
    if (object === null) return { value: null, error: '顶层不是 JSON5 对象' };
    return { value: object, error: null };
  } catch (error) {
    return { value: null, error: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// 检查项
// ---------------------------------------------------------------------------

interface Context {
  cwd: string;
  project: string | null;
  projectAbs: string;
  projectExists: boolean;
  sdk: string;
  sdkAbs: string;
  hvigor: string;
  hvigorAbs: string;
  hvigorBin: string;
  caseDir: string | null;
  caseAbs: string;
  envSdk: string;
  envHvigor: string;
  envNodeHome: string;
  nodeHome: string;
  profile: Record<string, unknown> | null;
  profileError: string | null;
  profilePath: string;
}

function envValue(name: string): string {
  const value = process.env[name];
  if (value === undefined) return '';
  const trimmed = value.trim();
  return trimmed === '' ? '' : trimmed;
}

function checkSdk(ctx: Context): Check {
  const base = 'sdk';
  if (ctx.sdk === '') {
    return {
      id: base,
      title: 'SDK',
      status: 'FAIL',
      message: '未提供 --sdk，也没有 OHOS_BASE_SDK_HOME',
      fix: '设置 OHOS_BASE_SDK_HOME 或传 --sdk <OHOS_BASE_SDK_HOME>',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const versionDir = join(ctx.sdkAbs, SDK_VERSION);
  if (!isDirectory(versionDir)) {
    return {
      id: base,
      title: 'SDK',
      status: 'FAIL',
      message: '缺少 ' + join(ctx.sdk, SDK_VERSION) + ' 目录（SDK 组件必须放在版本号子目录下）',
      fix: '把 SDK 组件解压到 <sdk>/' + SDK_VERSION + '/{ets,js,native,toolchains,previewer}',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const missing = SDK_SUBDIRS.filter((name) => !isDirectory(join(versionDir, name)));
  if (missing.length > 0) {
    return {
      id: base,
      title: 'SDK',
      status: 'FAIL',
      message: '26.0.0 下缺子目录：' + missing.join(', ') + '（现有 ' +
        SDK_SUBDIRS.filter((name) => !missing.includes(name)).join(', ') + '）',
      fix: '重新解压 OpenHarmony SDK 7.0-Release，五个子目录必须齐全：<sdk>/' + SDK_VERSION +
        '/{' + SDK_SUBDIRS.join(',') + '}',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  return {
    id: base,
    title: 'SDK',
    status: 'PASS',
    message: join(ctx.sdk, SDK_VERSION) + '：' + SDK_SUBDIRS.join('/') + ' 齐全',
    fix: null,
    anchor: ANCHOR_TOOLCHAIN,
  };
}

function checkHvigor(ctx: Context): Check {
  const id = 'hvigor';
  if (ctx.hvigor === '') {
    return {
      id,
      title: 'hvigor',
      status: 'FAIL',
      message: '未提供 --hvigor，也没有 HVIGOR_HOME',
      fix: '设置 HVIGOR_HOME 或传 --hvigor <含 @ohos/hvigor 的 node_modules 目录>',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (!isFile(ctx.hvigorBin)) {
    return {
      id,
      title: 'hvigor',
      status: 'FAIL',
      message: '缺少 ' + join(ctx.hvigor, HVIGOR_BIN),
      fix: '从 https://repo.harmonyos.com/npm/ 安装 hvigor，--hvigor 指向其 node_modules 目录',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  return {
    id,
    title: 'hvigor',
    status: 'PASS',
    message: ctx.hvigorBin,
    fix: null,
    anchor: ANCHOR_TOOLCHAIN,
  };
}

function checkBuildProfile(ctx: Context): Check {
  const id = 'build-profile';
  const title = 'build-profile';
  if (!ctx.projectExists) {
    return {
      id,
      title,
      status: 'FAIL',
      message: ctx.project === null ? '未提供 --project' : '--project 目录不存在：' + ctx.project,
      fix: '--project 指向鸿蒙工程根目录（含 build-profile.json5 / entry / AppScope）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (!isFile(ctx.profilePath)) {
    return {
      id,
      title,
      status: 'FAIL',
      message: '缺少 ' + ctx.profilePath,
      fix: '确认 --project 指向工程根目录（build-profile.json5 在根目录）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (ctx.profileError !== null) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'build-profile.json5 解析失败：' + ctx.profileError,
      fix: '按 JSON5 修语法（允许注释/尾逗号，但不允许语法错误）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    message: '可解析（JSON5）',
    fix: null,
    anchor: ANCHOR_TOOLCHAIN,
  };
}

function productsOf(ctx: Context): Record<string, unknown>[] {
  const app = asObject(ctx.profile?.app);
  const products = asArray(app?.products);
  return products.map((product) => asObject(product)).filter((product): product is Record<string, unknown> => product !== null);
}

function productName(product: Record<string, unknown>, index: number): string {
  const name = product.name;
  return typeof name === 'string' && name !== '' ? name : '#' + index;
}

function unparsedReason(ctx: Context): string {
  if (!ctx.projectExists) return '工程目录不存在';
  if (!isFile(ctx.profilePath)) return '缺少 build-profile.json5';
  if (ctx.profileError !== null) return 'build-profile.json5 未解析';
  if (ctx.profile === null) return 'build-profile.json5 未解析';
  return '';
}

function checkSdkVersion(ctx: Context): Check {
  const id = 'sdk-version';
  const title = '版本号';
  const reason = unparsedReason(ctx);
  if (reason !== '') {
    return {
      id,
      title,
      status: 'WARN',
      message: '无法检查：' + reason,
      fix: '先修 build-profile.json5',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const products = productsOf(ctx);
  if (products.length === 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'build-profile.json5 里 app.products 为空或缺失',
      fix: '在 app.products[] 里补产品配置（含 compileSdkVersion / runtimeOS）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const bad: string[] = [];
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const label = productName(product, i);
    for (const field of ['compileSdkVersion', 'compatibleSdkVersion', 'targetSdkVersion']) {
      const value = product[field];
      if (value === undefined) {
        if (field === 'compileSdkVersion') bad.push(label + ': 缺少 ' + field);
        continue;
      }
      if (typeof value !== 'string') {
        bad.push(label + ': ' + field + '=' + JSON.stringify(value) + '（必须是字符串）');
      } else if (value.trim() === '') {
        bad.push(label + ': ' + field + '=""（不能为空）');
      }
    }
  }
  if (bad.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: bad.slice(0, 4).join('；') + (bad.length > 4 ? ' 等 ' + bad.length + ' 处' : ''),
      fix: 'API ≥ ' + SDK_VERSION + ' 的版本号必须写非空字符串，如 "compileSdkVersion": "26.0.0"（数字/空串会被拒绝）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const first = products[0];
  const maybeDefault = products.find((product, i) => productName(product, i) === 'default') ?? first;
  const version = maybeDefault.compileSdkVersion;
  return {
    id,
    title,
    status: 'PASS',
    message: 'compileSdkVersion="' + String(version) + '"（字符串）',
    fix: null,
    anchor: ANCHOR_TOOLCHAIN,
  };
}

function checkRuntimeOs(ctx: Context): Check {
  const id = 'runtime-os';
  const title = 'runtimeOS';
  const reason = unparsedReason(ctx);
  if (reason !== '') {
    return {
      id,
      title,
      status: 'WARN',
      message: '无法检查：' + reason,
      fix: '先修 build-profile.json5',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const products = productsOf(ctx);
  if (products.length === 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'build-profile.json5 里 app.products 为空，无法确定 runtimeOS',
      fix: '在 app.products[] 里写 runtimeOS: "OpenHarmony"',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const bad: string[] = [];
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const label = productName(product, i);
    const runtimeOs = product.runtimeOS;
    if (runtimeOs === undefined) bad.push(label + ': 未设置 runtimeOS（默认 HarmonyOS）');
    else if (runtimeOs !== 'OpenHarmony') bad.push(label + ': runtimeOS=' + JSON.stringify(runtimeOs));
  }
  if (bad.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: bad.join('；'),
      fix: 'build-profile.json5 → app.products[].runtimeOS 改成 "OpenHarmony"（否则 DEVECO_SDK_HOME invalid）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    message: 'OpenHarmony',
    fix: null,
    anchor: ANCHOR_TOOLCHAIN,
  };
}

function moduleProfilesOf(projectAbs: string): string[] {
  if (!isDirectory(projectAbs)) return [];
  const paths: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(projectAbs, { withFileTypes: true });
  } catch {
    return paths;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectAbs, entry.name, 'src', 'main', 'module.json5');
    if (isFile(candidate)) paths.push(candidate);
  }
  paths.sort();
  return paths;
}

function checkDeviceTypes(ctx: Context): Check {
  const id = 'device-types';
  const title = 'deviceTypes';
  if (!ctx.projectExists) {
    return {
      id,
      title,
      status: 'WARN',
      message: '无法检查：工程目录不存在',
      fix: '--project 指向鸿蒙工程根目录',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const modules = moduleProfilesOf(ctx.projectAbs);
  if (modules.length === 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: '没有找到 */src/main/module.json5（构建会报 module.json5 file not found）',
      fix: '每个模块都要有 src/main/module.json5（如 entry/src/main/module.json5）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const entryModule = join(ctx.projectAbs, 'entry', 'src', 'main', 'module.json5');
  if (!isFile(entryModule)) {
    return {
      id,
      title,
      status: 'FAIL',
      message: '缺少 entry/src/main/module.json5（构建会报 module.json5 file not found）',
      fix: '从模板补 entry/src/main/module.json5（module.name / module.deviceTypes 等）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  const parseErrors: string[] = [];
  const phone: string[] = [];
  const unknown: string[] = [];
  const missing: string[] = [];
  const emptyArrays: string[] = [];
  const wrongTypes: string[] = [];
  const seen: string[] = [];
  for (const modulePath of modules) {
    const moduleName = modulePath.slice(ctx.projectAbs.length + 1).split('/')[0];
    const parsed = readJson5File(modulePath);
    if (parsed.error !== null) {
      parseErrors.push(moduleName + ': ' + parsed.error);
      continue;
    }
    const moduleObject = asObject(parsed.value?.module);
    const deviceTypes = moduleObject?.deviceTypes;
    if (deviceTypes === undefined) {
      missing.push(moduleName);
      continue;
    }
    if (!Array.isArray(deviceTypes)) {
      wrongTypes.push(moduleName + '（' + (deviceTypes === null ? 'null' : typeof deviceTypes) +
        '：' + JSON.stringify(deviceTypes) + '）');
      continue;
    }
    if (deviceTypes.length === 0) {
      emptyArrays.push(moduleName);
      continue;
    }
    const values = deviceTypes.map((value) => String(value));
    seen.push(moduleName + ': ' + JSON.stringify(values));
    for (const value of values) {
      const normalized = value.toLowerCase();
      if (normalized === 'phone') phone.push(moduleName + '=' + value);
      else if (!ALLOWED_DEVICE_TYPES.some((allowed) => allowed.toLowerCase() === normalized)) {
        unknown.push(moduleName + '=' + value);
      }
    }
  }
  if (parseErrors.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'module.json5 解析失败：' + parseErrors.slice(0, 3).join('；'),
      fix: '修 module.json5 的 JSON5 语法',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (wrongTypes.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'deviceTypes 必须是数组，实际不是：' + wrongTypes.join('；'),
      fix: 'module.json5 的 module.deviceTypes 写成数组，如 ["default"]',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (emptyArrays.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'deviceTypes 为空：' + emptyArrays.join(', ') + '（构建会报 device type empty）',
      fix: '至少写一个合法值，如 ["default"]（可选：' + ALLOWED_DEVICE_TYPES.join('/') + '）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (phone.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'deviceTypes 含 "phone"：' + phone.join(', ') + '（OpenHarmony syscap 交集会为空）',
      fix: '改成 ' + ALLOWED_DEVICE_TYPES.join('/') + ' 之一，例如 "default"',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (unknown.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'deviceTypes 有非法值：' + unknown.join(', '),
      fix: '只允许 ' + ALLOWED_DEVICE_TYPES.join('/') + '（注意大小写：liteWearable）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (seen.length > 0) {
    return {
      id,
      title,
      status: 'PASS',
      message: seen.join('；'),
      fix: null,
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  return {
    id,
    title,
    status: 'WARN',
    message: (missing.length > 0 ? missing.join(', ') : '模块') + ' 未设置 module.deviceTypes',
    fix: '在 module.json5 的 module.deviceTypes 写 "default"',
    anchor: ANCHOR_TOOLCHAIN,
  };
}

function checkEtsDir(ctx: Context): Check {
  const id = 'ets-dir';
  const title = 'ets 目录';
  if (!ctx.projectExists) {
    return {
      id,
      title,
      status: 'WARN',
      message: '无法检查：工程目录不存在',
      fix: '--project 指向鸿蒙工程根目录',
      anchor: ANCHOR_RULES,
    };
  }
  const path = join(ctx.projectAbs, 'entry', 'src', 'main', 'ets');
  if (!isDirectory(path)) {
    return {
      id,
      title,
      status: 'FAIL',
      message: '缺少 entry/src/main/ets',
      fix: '确认 --project 是鸿蒙工程根目录（标准模板含 entry/src/main/ets）',
      anchor: ANCHOR_RULES,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    message: 'entry/src/main/ets',
    fix: null,
    anchor: ANCHOR_RULES,
  };
}

function checkEntryPage(ctx: Context): Check {
  const id = 'entry-page';
  const title = '入口页';
  if (!ctx.projectExists) {
    return {
      id,
      title,
      status: 'WARN',
      message: '无法检查：工程目录不存在',
      fix: '--project 指向鸿蒙工程根目录',
      anchor: ANCHOR_RULES,
    };
  }
  const path = join(ctx.projectAbs, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');
  if (!isFile(path)) {
    return {
      id,
      title,
      status: 'FAIL',
      message: '缺少 entry/src/main/ets/pages/Index.ets',
      fix: '标准模板入口页是 pages/Index.ets；非标准布局时把 port 的 --entry 指向真实入口',
      anchor: ANCHOR_RULES,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    message: 'entry/src/main/ets/pages/Index.ets',
    fix: null,
    anchor: ANCHOR_RULES,
  };
}

function checkAppScope(ctx: Context): Check {
  const id = 'app-scope';
  const title = 'AppScope';
  if (!ctx.projectExists) {
    return {
      id,
      title,
      status: 'WARN',
      message: '无法检查：工程目录不存在',
      fix: '--project 指向鸿蒙工程根目录',
      anchor: ANCHOR_RULES,
    };
  }
  const path = join(ctx.projectAbs, 'AppScope', 'app.json5');
  if (!isFile(path)) {
    return {
      id,
      title,
      status: 'FAIL',
      message: '缺少 AppScope/app.json5',
      fix: 'AppScope/app.json5 是应用级配置，缺了 hvigor 无法打包',
      anchor: ANCHOR_RULES,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    message: 'AppScope/app.json5',
    fix: null,
    anchor: ANCHOR_RULES,
  };
}

function checkNodeHome(ctx: Context): Check {
  const id = 'node-home';
  const title = 'NODE_HOME';
  const nodeBin = join(ctx.nodeHome, 'node');
  const explicit = ctx.envNodeHome !== '';
  if (isFile(nodeBin)) {
    return {
      id,
      title,
      status: 'PASS',
      message: nodeBin + (explicit ? '（NODE_HOME）' : '（默认 /usr/bin）'),
      fix: null,
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (explicit) {
    return {
      id,
      title,
      status: 'FAIL',
      message: 'NODE_HOME=' + ctx.nodeHome + ' 下没有 node（找的是 ' + nodeBin + '）',
      fix: 'NODE_HOME 指向含 node 可执行文件的目录（通常 /usr/bin），或取消该变量用默认值',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  return {
    id,
    title,
    status: 'WARN',
    message: '默认 ' + nodeBin + ' 不存在',
    fix: '构建时显式设置 NODE_HOME=<含 node 的目录>',
    anchor: ANCHOR_TOOLCHAIN,
  };
}

function checkEnvAlign(ctx: Context): Check {
  const id = 'env-align';
  const title = '环境变量';
  const problems: string[] = [];
  const notes: string[] = [];
  let flagOnly = 0;
  const compare = (flagName: string, flagValue: string, envName: string, envRaw: string): void => {
    if (flagValue !== '' && envRaw !== '') {
      if (resolve(ctx.cwd, flagValue) === resolve(ctx.cwd, envRaw)) notes.push(envName + ' 与参数一致');
      else problems.push(flagName + '=' + flagValue + ' ≠ ' + envName + '=' + envRaw + '（工具以参数为准）');
      return;
    }
    if (flagValue !== '') {
      flagOnly++;
      return;
    }
    if (envRaw !== '') notes.push('来自 ' + envName);
  };
  compare('--sdk', ctx.sdk, 'OHOS_BASE_SDK_HOME', ctx.envSdk);
  compare('--hvigor', ctx.hvigor, 'HVIGOR_HOME', ctx.envHvigor);
  if (problems.length > 0) {
    return {
      id,
      title,
      status: 'WARN',
      message: problems.join('；'),
      fix: '统一参数与环境变量（export OHOS_BASE_SDK_HOME/HVIGOR_HOME 后不再传 --sdk/--hvigor，或反过来）',
      anchor: ANCHOR_TOOLCHAIN,
    };
  }
  if (flagOnly > 0) notes.push('只用参数（未设置对应环境变量，port/build 会以参数为准）');
  return {
    id,
    title,
    status: 'PASS',
    message: notes.length > 0 ? notes.join('；') : '未设置 SDK/hvigor 相关环境变量',
    fix: null,
    anchor: ANCHOR_TOOLCHAIN,
  };
}

function checkCaseGolden(ctx: Context): Check {
  const id = 'case-golden';
  const title = 'case golden';
  if (ctx.caseDir === null) {
    return { id, title, status: 'PASS', message: '未指定 --case，跳过', fix: null, anchor: ANCHOR_CASE };
  }
  if (!isDirectory(ctx.caseAbs)) {
    return {
      id,
      title,
      status: 'WARN',
      message: '案例目录不存在：' + ctx.caseDir + '（跳过）',
      fix: '--case 指向已有案例目录（如 cases/legado）',
      anchor: ANCHOR_CASE,
    };
  }
  const path = join(ctx.caseAbs, 'golden.json');
  if (!isFile(path)) {
    return {
      id,
      title,
      status: 'WARN',
      message: '缺少 ' + join(ctx.caseDir, 'golden.json') + '（fidelity 阶段无法运行）',
      fix: '先产 golden 数据（cases/legado/README.md 的复现步骤）',
      anchor: ANCHOR_CASE,
    };
  }
  return {
    id,
    title,
    status: 'PASS',
    message: join(ctx.caseDir, 'golden.json'),
    fix: null,
    anchor: ANCHOR_CASE,
  };
}

function checkCaseActual(ctx: Context): Check {
  const id = 'case-actual';
  const title = 'case actual';
  if (ctx.caseDir === null) {
    return { id, title, status: 'PASS', message: '未指定 --case，跳过', fix: null, anchor: ANCHOR_CASE };
  }
  if (!isDirectory(ctx.caseAbs)) {
    return {
      id,
      title,
      status: 'WARN',
      message: '案例目录不存在：' + ctx.caseDir + '（跳过）',
      fix: '--case 指向已有案例目录（如 cases/legado）',
      anchor: ANCHOR_CASE,
    };
  }
  const path = join(ctx.caseAbs, 'actual.json');
  if (isFile(path)) {
    return {
      id,
      title,
      status: 'PASS',
      message: join(ctx.caseDir, 'actual.json'),
      fix: null,
      anchor: ANCHOR_CASE,
    };
  }
  if (isFile(join(ctx.caseAbs, 'replay.ts'))) {
    return {
      id,
      title,
      status: 'WARN',
      message: '缺少 actual.json；fidelity 会先尝试 replay.ts 重放',
      fix: '把重放结果落成 ' + join(ctx.caseDir, 'actual.json') + ' 可避免每次重跑',
      anchor: ANCHOR_CASE,
    };
  }
  return {
    id,
    title,
    status: 'WARN',
    message: '缺少 ' + join(ctx.caseDir, 'actual.json') + '（fidelity 阶段会 SKIP）',
    fix: '语义转写后重放产出 actual.json（见 cases/legado/README.md）',
    anchor: ANCHOR_CASE,
  };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function formatLine(check: Check): string {
  const head = check.status.padEnd(4) + '  ' + check.id.padEnd(13) + '  ' + check.message;
  if (check.status === 'PASS' || check.fix === null) return head;
  return head + '  → 修法：' + check.fix + '（' + check.anchor + '）';
}

function buildReport(checks: Check[], ctx: Context) {
  const counts = {
    pass: checks.filter((check) => check.status === 'PASS').length,
    warn: checks.filter((check) => check.status === 'WARN').length,
    fail: checks.filter((check) => check.status === 'FAIL').length,
  };
  return {
    ok: counts.fail === 0,
    counts,
    checks,
    inputs: {
      project: ctx.project,
      sdk: ctx.sdk,
      hvigor: ctx.hvigor,
      case: ctx.caseDir,
    },
    env: {
      OHOS_BASE_SDK_HOME: ctx.envSdk,
      HVIGOR_HOME: ctx.envHvigor,
      NODE_HOME: ctx.envNodeHome,
    },
  };
}

function writeReport(reportPath: string, report: unknown): void {
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error('doctor: 无法写入报告 ' + reportPath + '：' + errorMessage(error));
    process.exit(EXIT_USAGE);
  }
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
  const project = optional(raw, 'project');
  const sdk = optional(raw, 'sdk') ?? envValue('OHOS_BASE_SDK_HOME');
  const hvigor = optional(raw, 'hvigor') ?? envValue('HVIGOR_HOME');
  const caseDir = optional(raw, 'case');
  const reportPath = optional(raw, 'report');

  const projectAbs = project === null ? '' : resolve(cwd, project);
  const caseAbs = caseDir === null ? '' : resolve(cwd, caseDir);
  const sdkAbs = sdk === '' ? '' : resolve(cwd, sdk);
  const hvigorAbs = hvigor === '' ? '' : resolve(cwd, hvigor);
  const envNodeHome = envValue('NODE_HOME');
  const nodeHome = envNodeHome === '' ? '/usr/bin' : envNodeHome;
  const profilePath = projectAbs === '' ? '' : join(projectAbs, 'build-profile.json5');
  const profile = profilePath !== '' && isFile(profilePath) ? readJson5File(profilePath) : { value: null, error: null };

  const ctx: Context = {
    cwd,
    project,
    projectAbs,
    projectExists: projectAbs !== '' && isDirectory(projectAbs),
    sdk,
    sdkAbs,
    hvigor,
    hvigorAbs,
    hvigorBin: hvigorAbs === '' ? '' : join(hvigorAbs, HVIGOR_BIN),
    caseDir,
    caseAbs,
    envSdk: envValue('OHOS_BASE_SDK_HOME'),
    envHvigor: envValue('HVIGOR_HOME'),
    envNodeHome,
    nodeHome,
    profile: profile.value,
    profileError: profile.error,
    profilePath,
  };

  const checks: Check[] = [];
  checks.push(checkSdk(ctx));
  checks.push(checkHvigor(ctx));
  if (project !== null) {
    checks.push(checkBuildProfile(ctx));
    checks.push(checkSdkVersion(ctx));
    checks.push(checkRuntimeOs(ctx));
    checks.push(checkDeviceTypes(ctx));
    checks.push(checkEtsDir(ctx));
    checks.push(checkEntryPage(ctx));
    checks.push(checkAppScope(ctx));
  }
  checks.push(checkNodeHome(ctx));
  checks.push(checkEnvAlign(ctx));
  if (caseDir !== null) {
    checks.push(checkCaseGolden(ctx));
    checks.push(checkCaseActual(ctx));
  }

  const report = buildReport(checks, ctx);
  if (reportPath !== null) writeReport(resolve(cwd, reportPath), report);

  if (raw.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const lines = checks.map((check) => formatLine(check));
    if (report.counts.fail > 0) {
      lines.push('环境: 有 ' + report.counts.fail + ' 项 FAIL（PASS ' + report.counts.pass +
        ' / WARN ' + report.counts.warn + '）');
    } else {
      lines.push('环境: OK（PASS ' + report.counts.pass + ' / WARN ' + report.counts.warn +
        (report.counts.warn > 0 ? '，WARN 不阻塞' : '') + '）');
    }
    console.log(lines.join('\n'));
  }

  process.exit(report.ok ? EXIT_OK : EXIT_FAIL);
}

main();
