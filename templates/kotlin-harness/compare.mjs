#!/usr/bin/env node
/**
 * Kotlin 真值 harness 的对比器（templates/kotlin-harness/compare.mjs）。
 *
 * 做什么：
 *  1) 编译 Kotlin harness（kotlinc，外部依赖；零 npm 依赖）并跑两次，要求两次 stdout 逐字节相同；
 *  2) 跑 TS harness（node <script>）两次，同样要求逐字节相同；
 *  3) 逐字段比较两份 JSON（Float/Double 按 raw bits、Long 按 BigInt；-0/NaN/精度差异都能报出来）；
 *  4) 不一致 exit 1；可选 --out 把两份 golden 落盘。
 *
 * 用法：
 *   node templates/kotlin-harness/compare.mjs --ts <ts harness> [--kotlin <kt harness>] [--classes <dir>]
 *        [--main-class <name>] [--out <dir>] [--json] [--keep] [--kotlinc <path>] [--kotlin-bin <path>] [--help]
 *
 * 默认 --kotlin 为本目录 harness.kt；--classes 默认临时目录（给出已编译目录可跳过 kotlinc）。
 * 主类默认由文件名推导：harness.kt → HarnessKt、Main.kt → MainKt（可用 --main-class 覆盖）。
 *
 * JSON 编码契约见本目录 README.md「编码约定」：
 *   Long   → {"kind":"i64","value":"<十进制>"}
 *   Float  → {"kind":"f32","bits":"<uint32 raw bits>"}
 *   Double → {"kind":"f64","bits":"<uint64 raw bits>"}
 *   其余   → 普通 JSON（Int 是数字；String/Boolean/数组/对象原生）
 *
 * 退出码：0 = 一致且两次运行稳定；1 = 不一致/不稳定/解析失败/编译失败；2 = 用法错误。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const VALUE_OPTS = new Set(['kotlin', 'ts', 'classes', 'main-class', 'out', 'kotlinc', 'kotlin-bin']);
const BOOL_OPTS = new Set(['json', 'keep', 'help']);

const USAGE = [
  '用法：',
  '  node templates/kotlin-harness/compare.mjs --ts <ts harness> [--kotlin <kt harness>] [--classes <dir>]',
  '       [--main-class <name>] [--out <dir>] [--json] [--keep] [--kotlinc <path>] [--kotlin-bin <path>]',
  '',
  '逐字段比较 Kotlin 真值与 TS 实现：Float/Double 比 raw bits、Long 比 BigInt、round 语义见 README。',
  '不一致或两次运行不稳定 → exit 1；用法错误 → exit 2。',
].join('\n');

function failUsage(message) {
  console.error('compare: ' + message);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    kotlin: join(scriptDir, 'harness.kt'),
    ts: null,
    classes: null,
    mainClass: null,
    out: null,
    json: false,
    keep: false,
    kotlinc: 'kotlinc',
    kotlinBin: 'kotlin',
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') return { ...args, help: true };
    if (token.startsWith('--') === false) failUsage('无法识别的参数：' + token);
    const eq = token.indexOf('=');
    if (eq > 2) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
      if (value === '') failUsage('参数 --' + key + ' 不能为空');
      assign(args, key, value);
      continue;
    }
    const key = token.slice(2);
    if (BOOL_OPTS.has(key)) {
      if (key === 'json') args.json = true;
      else if (key === 'keep') args.keep = true;
      else args.help = true;
      continue;
    }
    if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) failUsage('参数 --' + key + ' 缺少取值');
    assign(args, key, next);
    i++;
  }
  return args;
}

function assign(args, key, value) {
  if (key === 'kotlin') args.kotlin = resolve(value);
  else if (key === 'ts') args.ts = resolve(value);
  else if (key === 'classes') args.classes = resolve(value);
  else if (key === 'main-class') args.mainClass = value;
  else if (key === 'out') args.out = resolve(value);
  else if (key === 'kotlinc') args.kotlinc = value;
  else if (key === 'kotlin-bin') args.kotlinBin = value;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function mainClassFor(path) {
  const base = basename(path, '.kt');
  if (base === '') failUsage('无法从文件名推导主类：' + path);
  return base.charAt(0).toUpperCase() + base.slice(1) + 'Kt';
}
function runOnce(command, args, options) {
  const res = spawnSync(command, args, { encoding: 'utf8', timeout: 300000, ...options });
  if (res.error !== undefined && res.error !== null) return { code: -1, stdout: '', stderr: String(res.error.message) };
  return { code: res.status === null ? -1 : res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function compileKotlin(kotlinPath, classesDir, kotlinc) {
  mkdirSync(classesDir, { recursive: true });
  const res = runOnce(kotlinc, [kotlinPath, '-d', classesDir], {});
  if (res.code !== 0) {
    console.error('COMPILE_FAILED（' + kotlinc + ' exit ' + res.code + '）：');
    console.error((res.stderr || res.stdout).split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
}

function runTwice(kind, command, args, options) {
  const first = runOnce(command, args, options);
  if (first.code !== 0) {
    console.error(kind + '_FAILED（exit ' + first.code + '）：');
    console.error((first.stderr || first.stdout).split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
  const second = runOnce(command, args, options);
  if (second.code !== 0) {
    console.error(kind + '_FAILED（第二次 exit ' + second.code + '）：');
    console.error((second.stderr || second.stdout).split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
  if (first.stdout !== second.stdout) {
    console.error(kind + '_UNSTABLE：两次运行 stdout 不一致（模板要求同输入逐字节相同）');
    process.exit(1);
  }
  return { text: first.stdout, bytes: Buffer.byteLength(first.stdout, 'utf8'), sha256: sha256(first.stdout), runs: 2 };
}

function parseJson(kind, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(kind + '_BAD_JSON：' + error.message);
    console.error('stdout 前 200 字符：' + JSON.stringify(text.slice(0, 200)));
    process.exit(1);
  }
}

function decode(value) {
  if (Array.isArray(value)) return { kind: 'array', items: value.map(decode) };
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (keys.length === 2 && value.kind === 'i64' && typeof value.value === 'string' && /^-?\d+$/.test(value.value)) {
      return { kind: 'i64', value: BigInt(value.value) };
    }
    if (keys.length === 2 && value.kind === 'f32' && typeof value.bits === 'string' && /^\d+$/.test(value.bits)) {
      return { kind: 'f32', bits: BigInt(value.bits) };
    }
    if (keys.length === 2 && value.kind === 'f64' && typeof value.bits === 'string' && /^\d+$/.test(value.bits)) {
      return { kind: 'f64', bits: BigInt(value.bits) };
    }
    const entries = keys.map((key) => [key, decode(value[key])]);
    return { kind: 'object', entries };
  }
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (value === null) return { kind: 'null' };
  throw new Error('不支持的 JSON 值：' + typeof value);
}

function display(value) {
  if (value === undefined) return '<missing>';
  if (value.kind === 'i64') return value.value.toString();
  if (value.kind === 'f32') return 'f32(bits=' + value.bits.toString() + ')';
  if (value.kind === 'f64') return 'f64(bits=' + value.bits.toString() + ')';
  if (value.kind === 'number') return JSON.stringify(value.value);
  if (value.kind === 'string') return JSON.stringify(value.value);
  if (value.kind === 'bool') return String(value.value);
  if (value.kind === 'null') return 'null';
  if (value.kind === 'array') return '<array×' + value.items.length + '>';
  return '<object×' + value.entries.length + '>';
}

function compareValues(path, kotlin, ts, diffs, stats) {
  stats.nodes++;
  if (kotlin === undefined || ts === undefined) {
    diffs.push({ path, kind: 'missing', kotlin: display(kotlin), ts: display(ts) });
    return;
  }
  if (kotlin.kind !== ts.kind) {
    diffs.push({ path, kind: 'type', kotlin: display(kotlin), ts: display(ts) });
    return;
  }
  switch (kotlin.kind) {
    case 'number':
    case 'string':
    case 'bool':
    case 'i64':
      if (kotlin.value !== ts.value) diffs.push({ path, kind: 'value', kotlin: display(kotlin), ts: display(ts) });
      return;
    case 'f32':
    case 'f64':
      // 按 raw bits 比较：NaN、-0、精度差异都算不一致（模板的显式选择）
      if (kotlin.bits !== ts.bits) diffs.push({ path, kind: 'value', kotlin: display(kotlin), ts: display(ts) });
      return;
    case 'null':
      return;
    case 'array': {
      if (kotlin.items.length !== ts.items.length) {
        diffs.push({ path: path + '.length', kind: 'length', kotlin: String(kotlin.items.length), ts: String(ts.items.length) });
      }
      const length = Math.max(kotlin.items.length, ts.items.length);
      for (let index = 0; index < length; index++) {
        compareValues(path + '[' + index + ']', kotlin.items[index], ts.items[index], diffs, stats);
      }
      return;
    }
    case 'object': {
      const kotlinMap = new Map(kotlin.entries);
      const tsMap = new Map(ts.entries);
      const keys = new Set([...kotlinMap.keys(), ...tsMap.keys()]);
      for (const key of keys) {
        compareValues(path === '' ? key : path + '.' + key, kotlinMap.get(key), tsMap.get(key), diffs, stats);
      }
      return;
    }
    default:
      throw new Error('未知的 kind：' + kotlin.kind);
  }
}
const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  console.log(USAGE);
  process.exit(0);
}
if (args.ts === null) failUsage('缺少 --ts（TS harness 脚本）');
if (!existsSync(args.kotlin)) failUsage('找不到 Kotlin harness：' + args.kotlin);
if (!existsSync(args.ts)) failUsage('找不到 TS harness：' + args.ts);

const workDir = args.classes === null ? mkdtempSync(join(tmpdir(), 'kt-harness-')) : null;
const classesDir = args.classes !== null ? args.classes : join(workDir, 'classes');
const mainClass = args.mainClass !== null ? args.mainClass : mainClassFor(args.kotlin);

try {
  if (!existsSync(join(classesDir, mainClass + '.class'))) compileKotlin(args.kotlin, classesDir, args.kotlinc);
  const kotlinRun = runTwice('KOTLIN', args.kotlinBin, ['-cp', classesDir, mainClass], {});
  const tsRun = runTwice('TS', process.execPath, [args.ts], { cwd: dirname(args.ts) });
  const kotlinJson = parseJson('KOTLIN', kotlinRun.text);
  const tsJson = parseJson('TS', tsRun.text);
  const diffs = [];
  const stats = { nodes: 0 };
  compareValues('', decode(kotlinJson), decode(tsJson), diffs, stats);

  if (args.out !== null) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, 'golden.kotlin.json'), kotlinRun.text);
    writeFileSync(join(args.out, 'golden.ts.json'), tsRun.text);
  }

  const kotlinInfo = { path: args.kotlin, bytes: kotlinRun.bytes, sha256: kotlinRun.sha256, runs: kotlinRun.runs };
  const tsInfo = { path: args.ts, bytes: tsRun.bytes, sha256: tsRun.sha256, runs: tsRun.runs };
  const ok = diffs.length === 0;
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok, kotlin: kotlinInfo, ts: tsInfo, diffs, comparedNodes: stats.nodes }, null, 2) + '\n');
  } else {
    console.log('kotlin: ' + kotlinInfo.path + '（2 次运行一致，' + kotlinInfo.bytes + ' B，sha256 ' + kotlinInfo.sha256.slice(0, 12) + '…）');
    console.log('ts:     ' + tsInfo.path + '（2 次运行一致，' + tsInfo.bytes + ' B，sha256 ' + tsInfo.sha256.slice(0, 12) + '…）');
    if (ok) {
      console.log('FIDELITY_OK：逐字段一致（' + stats.nodes + ' 个节点；Long=BigInt、Float/Double=raw bits）');
    } else {
      console.log('DIFFS: ' + diffs.length);
      for (const diff of diffs.slice(0, 30)) console.log(JSON.stringify(diff));
      if (diffs.length > 30) console.log('…还有 ' + (diffs.length - 30) + ' 条');
    }
  }
  process.exit(ok ? 0 : 1);
} finally {
  if (workDir !== null && !args.keep) rmSync(workDir, { recursive: true, force: true });
}