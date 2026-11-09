#!/usr/bin/env node
/**
 * G3 的「约定人工修复」（确定性、可复现）：把 adapted .ets 里的内联对象类型抽成 interface ParagraphRange。
 *
 * 这是 ArkTS 的限制（arkts-no-obj-literals-as-types）而不是 codemod bug：
 * adapt-arkts 的 Options/Patch 变换只覆盖构造器内联对象类型，不覆盖函数参数内联类型。
 *
 * 用法：node cases/js-ts/parity-fix.mjs --in <chapterProgress.ets> --out <chapterProgress.ets>
 * 锚点必须恰好出现一次；找不到或出现多次即 exit 1（绝不静默改坏）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const INLINE = 'ReadonlyArray<{ start: number; endExclusive: number }>';
const REPLACEMENT = 'ReadonlyArray<ParagraphRange>';
const ANCHOR = 'export const paragraphAtPosition';
const INTERFACE = 'export interface ParagraphRange {\n  start: number;\n  endExclusive: number;\n}\n\n';

const argv = process.argv.slice(2);
let inPath = null;
let outPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--in') {
    inPath = argv[i + 1] === undefined ? null : argv[i + 1];
    i++;
  } else if (argv[i] === '--out') {
    outPath = argv[i + 1] === undefined ? null : argv[i + 1];
    i++;
  } else {
    process.stderr.write('未知参数：' + argv[i] + '\n');
    process.exit(2);
  }
}
if (inPath === null || outPath === null) {
  process.stderr.write('用法：node cases/js-ts/parity-fix.mjs --in <chapterProgress.ets> --out <chapterProgress.ets>\n');
  process.exit(2);
}

const text = readFileSync(inPath, 'utf8');
const count = (needle) => text.split(needle).length - 1;
const inlineCount = count(INLINE);
const anchorCount = count(ANCHOR);
if (inlineCount !== 1) {
  process.stderr.write('FAIL: 内联对象类型锚点出现 ' + inlineCount + ' 次（期望恰好 1 次）：' + INLINE + '\n');
  process.exit(1);
}
if (anchorCount !== 1) {
  process.stderr.write('FAIL: 函数声明锚点出现 ' + anchorCount + ' 次（期望恰好 1 次）：' + ANCHOR + '\n');
  process.exit(1);
}

const fixed = text.replace(ANCHOR, INTERFACE + ANCHOR).replace(INLINE, REPLACEMENT);
writeFileSync(outPath, fixed, 'utf8');
process.stdout.write('parity-fix: ' + inPath + ' -> ' + outPath + '（+interface ParagraphRange，内联类型→ReadonlyArray<ParagraphRange>）\n');
