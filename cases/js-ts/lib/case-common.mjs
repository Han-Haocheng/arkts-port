/**
 * js-ts 机制验证案例的公共逻辑：上游源码定位、固定场景、稳定 JSON 输出。
 *
 * 上游源码是外部 GPL 依赖（不复制进仓库）：优先从
 *   <ARKTS_PORT_CASE_REFS>/js-ts/src/utils/chapterProgress.ts
 * 读取；不存在时回退到 refs 的兄弟目录（legado 检出）：
 *   <ARKTS_PORT_CASE_REFS>/../modules/web/src/utils/chapterProgress.ts
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REFS = '/mnt/d/Project/legado-with-MD3/.refs';
export const SOURCE_REL = 'src/utils/chapterProgress.ts';

export function refsRoot() {
  return process.env.ARKTS_PORT_CASE_REFS || DEFAULT_REFS;
}

/** 规格 §2.1 的固定场景：空数组 + 边界 0/2/7/11/12/99。 */
export const SCENARIOS = [
  { scenario: 'empty', paragraphs: [], positions: [0] },
  {
    scenario: 'bounds',
    paragraphs: [
      { start: 0, endExclusive: 7 },
      { start: 7, endExclusive: 12 },
    ],
    positions: [0, 2, 7, 11, 12, 99],
  },
];

export function sourceCandidates() {
  const refs = resolve(refsRoot());
  return [
    join(refs, 'js-ts', SOURCE_REL),
    join(refs, '..', 'modules', 'web', SOURCE_REL),
  ];
}

/** explicit 为 null 时按 refs 规则定位；返回绝对路径或 null（缺失时由调用方 SKIP）。 */
export function resolveSource(explicit) {
  if (explicit) {
    const candidate = resolve(explicit);
    return existsSync(candidate) ? candidate : null;
  }
  for (const candidate of sourceCandidates()) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

/** 由 <root>/src/utils/chapterProgress.ts 反推上游工程根（extract-closure 的 --root）。 */
export function upstreamRoot(sourcePath) {
  const suffix = '/' + SOURCE_REL;
  if (!sourcePath.endsWith(suffix)) {
    throw new Error('上游路径不符合预期（应以 ' + suffix + ' 结尾）：' + sourcePath);
  }
  return sourcePath.slice(0, sourcePath.length - suffix.length);
}

/** 加载上游导出的 paragraphAtPosition（兼容 default 导出）。 */
export async function loadParagraphAtPosition(filePath) {
  const mod = await import(pathToFileURL(filePath).href);
  const candidates = [mod.paragraphAtPosition, mod.default, mod.default && mod.default.paragraphAtPosition];
  for (const candidate of candidates) {
    if (typeof candidate === 'function') return candidate;
  }
  throw new Error('模块没有导出 paragraphAtPosition：' + filePath);
}

/** 输出形状（verify-fidelity 兼容）：[{scenario, results:[{case, value}]}]。 */
export function buildReport(paragraphAtPosition) {
  return SCENARIOS.map((entry) => ({
    scenario: entry.scenario,
    results: entry.positions.map((position) => ({
      case: 'position=' + position,
      value: paragraphAtPosition(entry.paragraphs, position),
    })),
  }));
}

/** 稳定输出：紧凑 JSON + 换行（golden/actual 逐字节可复现）。 */
export function printJson(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

export function skip(message) {
  process.stderr.write('SKIP: ' + message + '\n');
  process.exit(3);
}
