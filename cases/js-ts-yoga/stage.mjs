#!/usr/bin/env node
/**
 * cases/js-ts-yoga/stage.mjs —— 把 yoga-layout 的 2 个 TS 源文件 staged 到 out/js-ts-yoga/src/yoga。
 *
 * 源是外部依赖（dsh-TUI，MIT，约 3,303 行），不复制进仓库。
 * 唯一预处理：index.ts 的 from './enums.js' → from './enums.ts'（Node 26 ESM 要求显式扩展名；
 * extract-closure --out 只原样复制，不重写说明符，见 docs/js-ts-scale-candidates.md §4）。
 *
 * 用法（仓库根目录）：
 *   node cases/js-ts-yoga/stage.mjs [--src <dir>] [--out <dir>] [--json]
 *   node cases/js-ts-yoga/stage.mjs --check [--json]     # 校验已 staged 文件（sha256 + 预处理）
 *
 * --src 默认 /mnt/d/Project/dsh-TUI/src/native-ts/yoga-layout（或 ARKTS_PORT_YOGA_SRC）。
 * 退出码：0 成功；1 --check 不一致；2 用法错误；3 上游缺失（SKIP，不算失败）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const OUT_ROOT = resolve(repoRoot, 'out', 'js-ts-yoga');
const DEFAULT_SRC = '/mnt/d/Project/dsh-TUI/src/native-ts/yoga-layout';
const FILES = ['index.ts', 'enums.ts'];
const REWRITE = { path: 'index.ts', from: "from './enums.js'", to: "from './enums.ts'" };

const USAGE = [
  '用法：',
  '  node cases/js-ts-yoga/stage.mjs [--src <dir>] [--out <dir>] [--json]',
  '  node cases/js-ts-yoga/stage.mjs --check [--out <dir>] [--json]',
  '',
  '把 yoga-layout 的 index.ts + enums.ts staged 到 <out>（默认 out/js-ts-yoga/src/yoga），',
  '并把 index.ts 的 ./enums.js 说明符改成 ./enums.ts（1 处，必须恰好 1 处）。',
  '--check 按 out/js-ts-yoga/stage.json 校验 sha256 与预处理是否与 staged 文件一致。',
  '',
  '上游：/mnt/d/Project/dsh-TUI/src/native-ts/yoga-layout（MIT；或 ARKTS_PORT_YOGA_SRC）',
  '退出码：0 成功；1 --check 不一致；2 用法错误；3 上游缺失（SKIP）',
].join('\n');

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function usageFail(message) {
  process.stderr.write('stage.mjs: ' + message + '\n');
  process.stderr.write(USAGE + '\n');
  process.exit(2);
}

const argv = process.argv.slice(2);
const args = { src: null, out: null, check: false, json: false, help: false };
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (token === '--check') args.check = true;
  else if (token === '--json') args.json = true;
  else if (token === '-h' || token === '--help') args.help = true;
  else if (token === '--src' || token === '--out') {
    const value = argv[i + 1];
    if (value === undefined || value === '') usageFail(token + ' 缺少取值');
    args[token.slice(2)] = resolve(value);
    i++;
  } else usageFail('未知参数：' + token);
}
if (args.help) {
  process.stdout.write(USAGE + '\n');
  process.exit(0);
}

const sourceDir = args.src === null ? resolve(process.env.ARKTS_PORT_YOGA_SRC || DEFAULT_SRC) : args.src;
const stagedDir = args.out === null ? join(OUT_ROOT, 'src', 'yoga') : args.out;
const manifestPath = join(OUT_ROOT, 'stage.json');

function readUpstream() {
  const result = { missing: [], files: [], texts: {} };
  for (const name of FILES) {
    const path = join(sourceDir, name);
    if (!existsSync(path)) {
      result.missing.push(path);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    result.texts[name] = text;
    result.files.push({ path: name, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) });
  }
  return result;
}

function emit(payload, humanLines) {
  if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else process.stdout.write(humanLines.join('\n') + '\n');
}

if (args.check) {
  if (!existsSync(manifestPath)) {
    process.stderr.write('stage.mjs: 缺少 ' + manifestPath + '（先跑一次不带 --check 的 stage.mjs）\n');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const problems = [];
  for (const entry of manifest.files) {
    const stagedPath = join(stagedDir, entry.path);
    if (!existsSync(stagedPath)) {
      problems.push('缺少 staged 文件：' + stagedPath);
      continue;
    }
    const text = readFileSync(stagedPath, 'utf8');
    const actual = sha256(text);
    if (actual !== entry.sha256) problems.push('staged sha256 不一致：' + entry.path + '（' + actual + ' != ' + entry.sha256 + '）');
    if (entry.path === REWRITE.path) {
      if (text.includes("from './enums.js'")) problems.push('staged ' + entry.path + ' 仍含 ./enums.js（预处理未生效）');
      if (!text.includes("from './enums.ts'")) problems.push('staged ' + entry.path + ' 缺少 ./enums.ts 说明符');
    }
  }
  const upstream = readUpstream();
  if (upstream.missing.length > 0) {
    problems.push('上游缺失（无法核对）：' + upstream.missing.join(', '));
  } else {
    for (const entry of manifest.upstream) {
      const current = upstream.files.find((file) => file.path === entry.path);
      if (current === undefined || current.sha256 !== entry.sha256) {
        problems.push('上游 sha256 变化：' + entry.path + '（先重新 stage）');
      }
    }
  }
  const payload = { ok: problems.length === 0, stagedDir: manifest.stagedDir, problems, manifest };
  emit(payload, [
    'stage --check: ' + (problems.length === 0 ? 'OK（staged 与上游一致）' : '不一致 ' + problems.length + ' 项'),
    ...problems.map((problem) => '  - ' + problem),
  ]);
  process.exit(problems.length === 0 ? 0 : 1);
}

const upstream = readUpstream();
if (upstream.missing.length > 0) {
  process.stderr.write('SKIP: 上游 yoga-layout 源码缺失：' + upstream.missing.join(', ') + '\n');
  process.exit(3);
}

mkdirSync(stagedDir, { recursive: true });
const rewrites = [];
const stagedFiles = [];
for (const name of FILES) {
  let text = upstream.texts[name];
  if (name === REWRITE.path) {
    const count = text.split(REWRITE.from).length - 1;
    if (count !== 1) {
      process.stderr.write('stage.mjs: ' + name + ' 里 ' + REWRITE.from + ' 出现 ' + count + ' 次（期望恰好 1 次）\n');
      process.exit(1);
    }
    text = text.replace(REWRITE.from, REWRITE.to);
    rewrites.push({ path: name, from: REWRITE.from, to: REWRITE.to, count });
  }
  writeFileSync(join(stagedDir, name), text, 'utf8');
  stagedFiles.push({ path: name, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) });
}

const manifest = {
  case: 'js-ts-yoga',
  upstreamDir: sourceDir,
  stagedDir: 'out/js-ts-yoga/src/yoga',
  files: stagedFiles,
  upstream: upstream.files,
  rewrites,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

emit(manifest, [
  'stage: ' + stagedFiles.length + ' 文件 → ' + manifest.stagedDir,
  ...stagedFiles.map((file) => '  - ' + file.path + '  ' + file.bytes + ' B  sha256 ' + file.sha256.slice(0, 12) + '…'),
  'rewrite: ' + rewrites.map((item) => item.path + '（' + item.count + ' 处 ./enums.js → ./enums.ts）').join(', '),
  '上游: ' + sourceDir + '（源不入库）',
]);
