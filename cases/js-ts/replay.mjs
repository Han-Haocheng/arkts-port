#!/usr/bin/env node
/**
 * 重放：用与 harness 完全相同的场景驱动「转写后」的闭包副本，输出 actual JSON。
 *
 * js-ts 的语义转写在本案例是恒等变换：extract-closure --out 原样复制（逐字节等于上游），
 * 所以 actual 与 golden 应逐字节相同——这正是本案例要证明的机制闭环。
 *
 * 用法（仓库根目录）：node cases/js-ts/replay.mjs [--src <file.ts>] > out/js-ts/actual.json
 * actual 来源（按优先级）：
 *   1) --src <file.ts>
 *   2) <repo>/out/js-ts/closure/src/utils/chapterProgress.ts（extract-closure 产物，默认）
 *   3) 上游 refs 路径（无闭包副本时的回退）
 * 用闭包副本时会校验它与上游逐字节相同，不一致直接 exit 1（actual 不可信）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, loadParagraphAtPosition, printJson, resolveSource, skip, SOURCE_REL, sourceCandidates } from './lib/case-common.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const argv = process.argv.slice(2);
let explicit = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--src') {
    const value = argv[i + 1];
    if (value === undefined) {
      process.stderr.write('用法：node cases/js-ts/replay.mjs [--src <file.ts>]\n');
      process.exit(2);
    }
    explicit = resolve(value);
    i++;
  } else {
    process.stderr.write('未知参数：' + argv[i] + '（用法：node cases/js-ts/replay.mjs [--src <file.ts>]）\n');
    process.exit(2);
  }
}

const closurePath = resolve(repoRoot, 'out/js-ts/closure', SOURCE_REL);
let source = explicit;
let origin = '--src';
if (source === null && existsSync(closurePath)) {
  source = closurePath;
  origin = 'closure 副本';
}
if (source === null) {
  source = resolveSource(null);
  origin = '上游 refs 回退';
}
if (source === null) {
  skip('找不到可重放的源码；尝试过：' + [closurePath].concat(sourceCandidates()).join(' , '));
}

if (origin === 'closure 副本') {
  const upstream = resolveSource(null);
  if (upstream !== null) {
    const same = readFileSync(closurePath).equals(readFileSync(upstream));
    process.stderr.write('# replay source: ' + closurePath + '（closure 副本；与上游逐字节相同：' + (same ? 'yes' : 'NO') + '）\n');
    if (!same) {
      process.stderr.write('FAIL: 闭包副本与上游不一致，actual 不可信\n');
      process.exit(1);
    }
  } else {
    process.stderr.write('# replay source: ' + closurePath + '（closure 副本）\n');
  }
} else {
  process.stderr.write('# replay source: ' + source + '（' + origin + '）\n');
}

printJson(buildReport(await loadParagraphAtPosition(source)));
