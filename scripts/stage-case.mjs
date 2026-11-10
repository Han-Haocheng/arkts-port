#!/usr/bin/env node
/**
 * stage-case —— 把 cases/<case> 依赖的**外部证据**一键复制进工作区。
 *
 * 背景：cases/legado/replay.ts 依赖 ./ts/（Kotlin 分页算法的 TS 转写产物，22 文件 / 4,925 行）。
 * 这批文件是上游 GPL-3.0 派生代码，**不入库**；它们按约定放在外部的 .refs 目录里。
 * 本脚本负责：从 .refs 复制 -> 写 provenance（sha256/文件数/行数）-> 供 replay 与门禁使用。
 * 也可以只校验（--check），用于 CI 或 reviewer 复跑。
 *
 * 用法：
 *   node scripts/stage-case.mjs [--refs <dir>] [--case cases/legado] [--dest <dir>]
 *                               [--check] [--json] [--help]
 *
 *   --refs <dir>    外部证据根目录，默认 /mnt/d/Project/legado-with-MD3/.refs
 *                   （可用环境变量 ARKTS_PORT_CASE_REFS 覆盖；显式 --refs 优先级最高）
 *   --case <dir>    案例目录，默认 cases/legado（相对当前工作目录）
 *   --dest <dir>    复制目标，默认 <case>/ts（该目录在 .gitignore 里，不入库）
 *   --check         不复制，只校验 dest 里的文件与 refs 的 sha256/文件集合一致
 *   --json          只输出结构化 JSON（便于 CI 消费）
 *   --help, -h      打印本帮助
 *
 * 行为：
 *   - 复制 <refs>/arkts-adapt-baseline/{layout,model,style} 下的全部 .ts，保留相对路径；
 *   - staging 会**重建** dest 下的 layout/model/style 三个目录（清掉上一次的残留文件），
 *     dest 里的其它文件不动；--dest 不允许位于 --refs 内（避免清掉源证据），也不允许等于 --case；
 *   - 写 <dest>/.provenance.json：{ source, case, files, loc, sha256 }，
 *     只有相对路径 + 哈希，不含时间戳，保证同一输入两次运行逐字节相同；
 *   - --check 以 refs 为准重新计算哈希，不信任 provenance（provenance 被改也不会掩盖文件被改）；
 *     除 layout/model/style 外不扫描其它目录，避免把无关文件当成"多余"。
 *
 * 退出码：0 = staging 成功 / --check 一致；
 *         1 = --check 不一致（含 dest 不存在、缺文件、哈希不符、多余文件）；
 *         2 = 用法错误（参数不合法、refs 目录不存在或缺 arkts-adapt-baseline、空基线等）。
 *
 * 报告 JSON（--json）：{ ok, files, loc, dest, source, mismatches[] }
 *   mismatches[]: { file, kind: "missing" | "hash" | "extra" | "dest-missing", expected?, actual? }
 *
 * 注意：本脚本不生成也不修改 replay.ts / golden.json / actual.json；只往 dest 写文件。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const DEFAULT_REFS = '/mnt/d/Project/legado-with-MD3/.refs';
const REFS_ENV = 'ARKTS_PORT_CASE_REFS';
const BASELINE_DIR = 'arkts-adapt-baseline';
const MANAGED_DIRS = ['layout', 'model', 'style'];
const PROVENANCE_FILE = '.provenance.json';

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

const USAGE = [
  'stage-case —— 把 cases/<case> 依赖的外部证据（.refs 里的 TS 转写产物）一键复制 / 校验',
  '',
  '用法：',
  '  node scripts/stage-case.mjs [--refs <dir>] [--case cases/legado] [--dest <dir>]',
  '                              [--check] [--json] [--help]',
  '',
  '参数：',
  '  --refs <dir>    外部证据根目录（默认 ' + DEFAULT_REFS,
  '                  也可用环境变量 ' + REFS_ENV + ' 覆盖）',
  '  --case <dir>    案例目录（默认 cases/legado）',
  '  --dest <dir>    复制目标（默认 <case>/ts；.gitignore 已忽略）',
  '  --check         只校验，不复制（一致 exit 0，不一致 exit 1）',
  '  --json          只输出 JSON：{ ok, files, loc, dest, source, mismatches[] }',
  '  --help, -h      打印本帮助',
  '',
  '复制范围：<refs>/' + BASELINE_DIR + '/{' + MANAGED_DIRS.join(',') + '} 下的全部 .ts，保留相对路径。',
  'staging 会重建 dest 下的 layout/model/style（清掉旧残留），dest 里其它文件不动。',
  '会写 <dest>/' + PROVENANCE_FILE + '：source / case / files / loc / sha256（无时间戳，确定性）。',
  '自定义 --dest 时请自行确认该目录在 .gitignore 内（默认 <case>/ts 已忽略）。',
  '',
  '退出码：0 成功或校验一致；1 校验失败；2 用法错误。',
].join('\n');

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const options = {
    refs: process.env[REFS_ENV] && process.env[REFS_ENV] !== '' ? process.env[REFS_ENV] : DEFAULT_REFS,
    caseDir: 'cases/legado',
    dest: null,
    check: false,
    json: false,
    help: false,
  };
  const valueFlags = new Set(['refs', 'case', 'dest']);
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new UsageError('不认识的参数：' + argument);
    let key = argument.slice(2);
    let value = null;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (valueFlags.has(key)) {
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw new UsageError('--' + key + ' 缺少取值');
        value = next;
        i++;
      }
      if (value === '') throw new UsageError('--' + key + ' 缺少取值');
      if (key === 'refs') options.refs = value;
      else if (key === 'case') options.caseDir = value;
      else options.dest = value;
      continue;
    }
    if (value !== null) throw new UsageError('--' + key + ' 不接受取值');
    if (key === 'check') options.check = true;
    else if (key === 'json') options.json = true;
    else throw new UsageError('不认识的参数：--' + key);
  }
  return options;
}

/* ------------------------------------------------------------------ 基础工具 */

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function countLines(buffer) {
  let lines = 0;
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0a) lines++;
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) lines++;
  return lines;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(path) {
  return path.split(sep).join('/');
}

/** 递归收集目录下全部 .ts，返回 POSIX 相对路径（相对 root），已排序。 */
function walkTs(root, prefix = '') {
  const found = [];
  const entries = readdirSync(prefix === '' ? root : join(root, prefix), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) {
      for (const nested of walkTs(root, rel)) found.push(nested);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(rel);
    }
  }
  return found.sort();
}

/* ------------------------------------------------------------------ 读取 refs 里的基线 */

function readBaseline(refsDir) {
  const baselineRoot = join(refsDir, BASELINE_DIR);
  if (!isDirectory(refsDir)) throw new UsageError('--refs 不是目录：' + refsDir);
  if (!isDirectory(baselineRoot)) {
    throw new UsageError('--refs 下缺少 ' + BASELINE_DIR + '：' + baselineRoot);
  }
  const files = new Map();
  let loc = 0;
  for (const dir of MANAGED_DIRS) {
    const dirPath = join(baselineRoot, dir);
    if (!isDirectory(dirPath)) throw new UsageError('基线目录缺少子目录：' + dirPath);
    for (const rel of walkTs(baselineRoot, dir)) {
      const buffer = readFileSync(join(baselineRoot, rel));
      const lines = countLines(buffer);
      files.set(rel, { buffer, sha256: sha256(buffer), loc: lines });
      loc += lines;
    }
  }
  if (files.size === 0) throw new UsageError('基线里没有任何 .ts 文件：' + baselineRoot);
  return { baselineRoot, files, loc };
}

/* ------------------------------------------------------------------ staging */

function stage(options) {
  const refs = resolve(options.refs);
  const caseArg = options.caseDir;
  const caseDir = resolve(caseArg);
  if (!isDirectory(caseDir)) throw new UsageError('--case 不是目录：' + caseArg);
  const destArg = options.dest !== null ? options.dest : toPosix(join(caseArg, 'ts'));
  const dest = resolve(destArg);
  if (existsSync(dest) && !isDirectory(dest)) throw new UsageError('--dest 已存在但不是目录：' + destArg);
  // 两道安全闸：别把源证据清掉，也别把 GPL 派生代码落到 gitignore 之外的 case 目录里
  if (dest === refs || dest.startsWith(refs + sep)) {
    throw new UsageError('--dest 不能位于 --refs 内（staging 会重建 layout/model/style，会清掉源证据）：' + destArg);
  }
  if (dest === caseDir) {
    throw new UsageError('--dest 不能等于 --case（GPL 派生代码必须落在 gitignore 的目录里，默认是 <case>/ts）');
  }

  const baseline = readBaseline(refs);

  // 重建受管目录，保证重复 staging 的产物只由 refs 决定（无上次残留）
  for (const dir of MANAGED_DIRS) {
    rmSync(join(dest, dir), { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });

  const sha256Map = {};
  for (const rel of [...baseline.files.keys()].sort()) {
    const file = baseline.files.get(rel);
    const target = join(dest, rel.split('/').join(sep));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.buffer);
    sha256Map[rel] = file.sha256;
  }

  // 只写「从哪来 + 有哪些文件 + 各自 sha256」，不写时间戳/dest，保证确定性
  const provenance = {
    source: toPosix(baseline.baselineRoot),
    case: caseArg,
    files: baseline.files.size,
    loc: baseline.loc,
    sha256: sha256Map,
  };
  writeFileSync(join(dest, PROVENANCE_FILE), JSON.stringify(provenance, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    files: baseline.files.size,
    loc: baseline.loc,
    dest: toPosix(dest),
    source: toPosix(baseline.baselineRoot),
    mismatches: [],
    provenancePath: toPosix(join(dest, PROVENANCE_FILE)),
  };
}

/* ------------------------------------------------------------------ --check */

function check(options) {
  const refs = resolve(options.refs);
  const caseArg = options.caseDir;
  const caseDir = resolve(caseArg);
  if (!isDirectory(caseDir)) throw new UsageError('--case 不是目录：' + caseArg);
  const destArg = options.dest !== null ? options.dest : toPosix(join(caseArg, 'ts'));
  const dest = resolve(destArg);

  const baseline = readBaseline(refs);
  const mismatches = [];

  if (!isDirectory(dest)) {
    mismatches.push({ file: toPosix(dest), kind: 'dest-missing' });
    return {
      ok: false,
      files: baseline.files.size,
      loc: baseline.loc,
      dest: toPosix(dest),
      source: toPosix(baseline.baselineRoot),
      mismatches,
    };
  }

  for (const rel of [...baseline.files.keys()].sort()) {
    const expected = baseline.files.get(rel);
    const target = join(dest, rel.split('/').join(sep));
    if (!existsSync(target) || !statSync(target).isFile()) {
      mismatches.push({ file: rel, kind: 'missing', expected: expected.sha256 });
      continue;
    }
    const actual = sha256(readFileSync(target));
    if (actual !== expected.sha256) {
      mismatches.push({ file: rel, kind: 'hash', expected: expected.sha256, actual });
    }
  }

  // 只在受管目录里找"多余文件"，避免把 dest 里无关的文件判成不一致
  for (const dir of MANAGED_DIRS) {
    const dirPath = join(dest, dir);
    if (!isDirectory(dirPath)) continue;
    for (const rel of walkTs(dest, dir)) {
      if (!baseline.files.has(rel)) {
        mismatches.push({ file: rel, kind: 'extra', actual: sha256(readFileSync(join(dest, rel.split('/').join(sep)))) });
      }
    }
  }

  mismatches.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return {
    ok: mismatches.length === 0,
    files: baseline.files.size,
    loc: baseline.loc,
    dest: toPosix(dest),
    source: toPosix(baseline.baselineRoot),
    mismatches,
  };
}

/* ------------------------------------------------------------------ 输出 */

function printHumanStage(result, options) {
  const lines = [];
  lines.push('stage-case：' + options.caseDir);
  lines.push('refs: ' + result.source + '  →  ' + result.dest);
  lines.push('复制 ' + result.files + ' 文件 / ' + result.loc + ' 行（保留相对路径）');
  lines.push('provenance: ' + result.provenancePath + '（source/files/loc/sha256，无时间戳）');
  lines.push('复现: node ' + toPosix(join(options.caseDir, 'replay.ts')) + ' > actual.json');
  lines.push('门禁: node cli/verify-fidelity.ts --golden ' + toPosix(join(options.caseDir, 'golden.json')) +
    ' --actual ' + toPosix(join(options.caseDir, 'actual.json')));
  process.stdout.write(lines.join('\n') + '\n');
}

function printHumanCheck(result) {
  const lines = [];
  lines.push('stage-case --check：' + result.dest);
  if (result.ok) {
    lines.push(result.files + ' 文件 sha256 与 refs 一致（' + result.loc + ' 行）');
    lines.push('门禁: PASS');
  } else {
    lines.push('不一致 ' + result.mismatches.length + ' 处：');
    const shown = result.mismatches.slice(0, 6);
    for (const item of shown) {
      let detail = item.kind;
      if (item.kind === 'hash') detail = 'hash  期望=' + String(item.expected).slice(0, 12) + '… 实际=' + String(item.actual).slice(0, 12) + '…';
      else if (item.kind === 'missing') detail = 'missing（期望 sha256=' + String(item.expected).slice(0, 12) + '…）';
      else if (item.kind === 'extra') detail = 'extra（基线里没有这个文件）';
      else if (item.kind === 'dest-missing') detail = 'dest-missing（目标目录不存在）';
      lines.push('  ' + item.file + '  ' + detail);
    }
    if (result.mismatches.length > shown.length) lines.push('  …（其余 ' + (result.mismatches.length - shown.length) + ' 处见 --json）');
    lines.push('门禁: FAIL（重新 stage 可修复: node scripts/stage-case.mjs --refs <dir>）');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function printJson(result) {
  const payload = {
    ok: result.ok,
    files: result.files,
    loc: result.loc,
    dest: result.dest,
    source: result.source,
    mismatches: result.mismatches,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

/* ------------------------------------------------------------------ main */

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(USAGE + '\n');
      return EXIT_OK;
    }
    if (options.check) {
      const result = check(options);
      if (options.json) printJson(result);
      else printHumanCheck(result);
      return result.ok ? EXIT_OK : EXIT_MISMATCH;
    }
    const result = stage(options);
    if (options.json) printJson(result);
    else printHumanStage(result, options);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write('错误：' + error.message + '\n\n' + USAGE + '\n');
      return EXIT_USAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write('stage-case 失败：' + message + '\n');
    return EXIT_MISMATCH;
  }
}

process.exitCode = main(process.argv.slice(2));
