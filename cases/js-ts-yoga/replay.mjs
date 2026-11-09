#!/usr/bin/env node
/**
 * yoga-layout 案例 replay：用与 harness 完全相同的场景驱动「转写后」的副本，输出 actual JSON。
 *
 * js-ts 的语义转写是恒等变换：stage 只改 1 处 import 扩展名，逻辑逐字节未动，
 * 所以 actual 与 golden 应逐字节相同（README §4 的实测基线）。
 *
 * 用法（仓库根目录）：node cases/js-ts-yoga/replay.mjs [--src <index.ts>] > out/js-ts-yoga/actual.json
 * 入口来源（按优先级）：--src > 环境变量 YOGA_CASE_ROOT 下的 src/yoga/index.ts（默认 out/js-ts-yoga）。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScenarios } from './harness/run-scenarios.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const caseRoot = resolve(process.env.YOGA_CASE_ROOT || resolve(repoRoot, 'out', 'js-ts-yoga'));
const STAGED_ENTRY = resolve(caseRoot, 'src', 'yoga', 'index.ts');

const argv = process.argv.slice(2);
let entry = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--src') {
    const value = argv[i + 1];
    if (value === undefined) {
      process.stderr.write('用法：node cases/js-ts-yoga/replay.mjs [--src <index.ts>]\n');
      process.exit(2);
    }
    entry = resolve(value);
    i++;
  } else {
    process.stderr.write('未知参数：' + argv[i] + '\n');
    process.exit(2);
  }
}
if (entry === null) entry = STAGED_ENTRY;
if (!existsSync(entry)) {
  process.stderr.write('SKIP: 找不到可重放的 yoga 入口 ' + entry + '（先跑 node cases/js-ts-yoga/stage.mjs）\n');
  process.exit(3);
}
process.stderr.write('# replay entry: ' + entry + '\n');

const mod = await import(pathToFileURL(entry).href);
const yoga = { mod, Node: mod.loadYoga ? (await mod.loadYoga()).Node : mod.default.Node };
process.stdout.write(JSON.stringify(runScenarios(yoga)) + '\n');
