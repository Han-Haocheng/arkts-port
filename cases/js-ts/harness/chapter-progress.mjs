#!/usr/bin/env node
/**
 * #1 chapterProgress harness（规格 §2.1）。
 *
 * 用法（仓库根目录）：node cases/js-ts/harness/chapter-progress.mjs
 * stdout：golden JSON = [{scenario, results:[{case, value}]}]（2 scenarios / 7 items）。
 * 上游可用 ARKTS_PORT_CASE_SRC 覆盖；默认按 lib/case-common.mjs 的规则从 refs 定位。
 * 缺失上游时 stderr 说明并 exit 3（案例 SKIP，不产出假 golden）。
 */
import { resolve } from 'node:path';
import { buildReport, loadParagraphAtPosition, printJson, resolveSource, skip, sourceCandidates } from '../lib/case-common.mjs';

const override = process.env.ARKTS_PORT_CASE_SRC ? resolve(process.env.ARKTS_PORT_CASE_SRC) : null;
const source = resolveSource(override);
if (source === null) {
  skip('找不到上游 chapterProgress.ts；尝试过：' + sourceCandidates().join(' , '));
}
process.stderr.write('# harness source: ' + source + '\n');
const paragraphAtPosition = await loadParagraphAtPosition(source);
printJson(buildReport(paragraphAtPosition));
