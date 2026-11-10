#!/usr/bin/env node
/**
 * 边界拆分 adapter 模板的跑法（templates/kotlin-adapters/run.mjs）。
 *
 * 1) 编译 adapters.kt + harness.kt（kotlinc，外部依赖；零 npm 依赖）；
 * 2) 委托 templates/kotlin-harness/compare.mjs 跑 Kotlin/TS 两次、逐字段比较（Float/Double raw bits、Long BigInt）。
 *
 * 用法：
 *   node templates/kotlin-adapters/run.mjs [--ts <script>] [--classes <dir>] [--out <dir>] [--json] [--rebuild] [--keep]
 *
 * 默认：--ts 为本目录 harness.example.ts；--classes 为 <repo>/out/kotlin-adapters/classes（首次自动编译，之后复用）。
 * 退出码：沿用 compare.mjs：0 一致；1 不一致/不稳定/编译失败；2 用法错误。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const KOTLIN_FILES = [join(scriptDir, 'adapters.kt'), join(scriptDir, 'harness.kt')];
const HARNESS_FILE = join(scriptDir, 'harness.kt');
const COMPARE = join(repoRoot, 'templates', 'kotlin-harness', 'compare.mjs');

const USAGE = [
  '用法：',
  '  node templates/kotlin-adapters/run.mjs [--ts <script>] [--classes <dir>] [--out <dir>] [--json] [--rebuild] [--keep]',
  '',
  '编译 adapters.kt + harness.kt，再调用 templates/kotlin-harness/compare.mjs 做 Kotlin/TS 逐字段比较。',
].join('\n');

function usageError(message) {
  console.error('run: ' + message);
  console.error(USAGE);
  process.exit(2);
}

const args = { ts: join(scriptDir, 'harness.example.ts'), classes: join(repoRoot, 'out', 'kotlin-adapters', 'classes'), out: null, json: false, rebuild: false, keep: false };
for (let i = 0; i < process.argv.length - 2; i++) {
  const token = process.argv[i + 2];
  if (token === '-h' || token === '--help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (token === '--json') { args.json = true; continue; }
  if (token === '--rebuild') { args.rebuild = true; continue; }
  if (token === '--keep') { args.keep = true; continue; }
  const eq = token.indexOf('=');
  const key = eq > 2 ? token.slice(2, eq) : token.startsWith('--') ? token.slice(2) : null;
  if (key === null) usageError('无法识别的参数：' + token);
  const value = eq > 2 ? token.slice(eq + 1) : process.argv[i + 3];
  if (value === undefined || value === '' || value.startsWith('--')) usageError('参数 --' + key + ' 缺少取值');
  if (key === 'ts') args.ts = resolve(value);
  else if (key === 'classes') args.classes = resolve(value);
  else if (key === 'out') args.out = resolve(value);
  else usageError('未知参数：--' + key);
  if (eq > 2) continue;
  i++;
}

for (const file of KOTLIN_FILES) {
  if (!existsSync(file)) usageError('缺少 Kotlin 文件：' + file);
}
const mainClassFile = join(args.classes, 'HarnessKt.class');
if (args.rebuild || !existsSync(mainClassFile)) {
  mkdirSync(args.classes, { recursive: true });
  const compiled = spawnSync('kotlinc', [...KOTLIN_FILES, '-d', args.classes], { encoding: 'utf8', timeout: 300000 });
  if (compiled.status !== 0) {
    console.error('run: kotlinc 失败（exit ' + compiled.status + '）：');
    console.error((compiled.stderr || compiled.stdout || '').split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
}

const compareArgs = [COMPARE, '--kotlin', HARNESS_FILE, '--ts', args.ts, '--classes', args.classes];
if (args.out !== null) compareArgs.push('--out', args.out);
if (args.json) compareArgs.push('--json');
const compared = spawnSync(process.execPath, compareArgs, { stdio: 'inherit', timeout: 300000 });
process.exit(compared.status === null ? 1 : compared.status);