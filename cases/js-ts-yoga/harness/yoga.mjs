#!/usr/bin/env node
/**
 * yoga-layout 规模化案例 harness（规格：cases/js-ts-yoga/README.md §3）。
 *
 * 用法（仓库根目录）：node cases/js-ts-yoga/harness/yoga.mjs [--src <index.ts>]
 * stdout = golden JSON（[{scenario, results:[{case, value}]}]，4 scenarios / 44 items）。
 * stage 目录：环境变量 YOGA_CASE_ROOT（默认 out/js-ts-yoga）→ 导入其 src/yoga/index.ts。
 * 上游源码是外部依赖（MIT，dsh-TUI），不复制进仓库；缺失时 stderr 说明并 exit 3（案例 SKIP）。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScenarios } from './run-scenarios.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const caseRoot = resolve(process.env.YOGA_CASE_ROOT || resolve(repoRoot, 'out', 'js-ts-yoga'));
const DEFAULT_ENTRY = resolve(caseRoot, 'src', 'yoga', 'index.ts');

const argv = process.argv.slice(2);
let entry = DEFAULT_ENTRY;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--src') {
    const value = argv[i + 1];
    if (value === undefined) {
      process.stderr.write('用法：node cases/js-ts-yoga/harness/yoga.mjs [--src <index.ts>]\n');
      process.exit(2);
    }
    entry = resolve(value);
    i++;
  } else {
    process.stderr.write('未知参数：' + argv[i] + '\n');
    process.exit(2);
  }
}
if (!existsSync(entry)) {
  process.stderr.write('SKIP: 找不到 yoga 入口 ' + entry + '（先跑 node cases/js-ts-yoga/stage.mjs）\n');
  process.exit(3);
}

const mod = await import(pathToFileURL(entry).href);
const yoga = { mod, Node: mod.loadYoga ? (await mod.loadYoga()).Node : mod.default.Node };
process.stderr.write('# harness entry: ' + entry + '\n');
process.stdout.write(JSON.stringify(runScenarios(yoga)) + '\n');
