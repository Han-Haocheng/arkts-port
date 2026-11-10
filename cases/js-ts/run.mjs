#!/usr/bin/env node
/**
 * cases/js-ts/run.mjs —— js-ts 机制验证案例端到端复跑（G1-G4，见 cases/js-ts/README.md §3/§4/§5）。
 *
 * 用法（仓库根目录）：
 *   node cases/js-ts/run.mjs [--stage all|g1|g2|g3|g4] [--json] [--update]
 *                            [--sdk <path>] [--hvigor <path>]
 *
 * 阶段（固定顺序，--stage 只选子集）：
 *   g1  extract-closure + gen-golden（两次逐字节一致）→ golden + sha256（--update 同步 cases/js-ts/golden.json）
 *   g2  replay 闭包副本 → actual；verify-fidelity --key scenario --items results --field value → 100%（--update 同步 actual.json）
 *   g3  parity 工程：假绿 lint 对照 → verbatim probe（1 ERROR）→ interface 修复 → probe（0 ERROR/0 WARN）
 *   g4  adapt-arkts --ets（0 行文本变化）→ diff-gate（0 needs-review）
 *
 * 外部依赖（均不入库）：
 *   ARKTS_PORT_CASE_REFS  上游 refs 根（默认 /mnt/d/Project/legado-with-MD3/.refs）
 *   --sdk / OHOS_BASE_SDK_HOME     默认 /mnt/d/Project/legado-with-MD3/.ohos-sdk/linux
 *   --hvigor / HVIGOR_HOME         默认 /mnt/d/Project/legado-with-MD3/.ohos-tools/node_modules
 *
 * 产物：out/js-ts/（gitignored）；退出码：0 = 请求的门禁全 PASS（上游缺失时 SKIP 也 exit 0）、1 = 有 FAIL、2 = 用法。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { refsRoot, resolveSource, upstreamRoot, SOURCE_REL, sourceCandidates } from './lib/case-common.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(repoRoot, 'out', 'js-ts');
const CASE = join(repoRoot, 'cases', 'js-ts');
const DEFAULT_SDK = '/mnt/d/Project/legado-with-MD3/.ohos-sdk/linux';
const DEFAULT_HVIGOR = '/mnt/d/Project/legado-with-MD3/.ohos-tools/node_modules';
const GATES = ['g1', 'g2', 'g3', 'g4'];

const USAGE = [
  '用法：',
  '  node cases/js-ts/run.mjs [--stage all|g1|g2|g3|g4] [--json] [--update]',
  '                           [--sdk <path>] [--hvigor <path>]',
  '',
  '  g1  golden 稳定（extract-closure + gen-golden 两次一致 + sha256）',
  '  g2  保真 100%（replay 闭包副本 + verify-fidelity --items results --field value）',
  '  g3  ArkTS parity（lint 假绿对照 + verbatim 1 ERROR + interface 修复后 0 ERROR/0 WARN）',
  '  g4  无语义漂移（adapt --ets 0 行变化 + diff-gate 0 needs-review）',
  '',
  '  --update  把 golden/actual 同步到 cases/js-ts/（默认只写 out/js-ts/）',
  '  --sdk / --hvigor  覆盖 SDK 与 hvigor（默认见文件头）',
  '',
  '退出码：0 = 请求的门禁全 PASS（上游缺失 SKIP 也 0）；1 = 有 FAIL；2 = 用法错误',
].join('\n');

function parseArgv(argv) {
  const args = { stage: 'all', json: false, update: false, sdk: null, hvigor: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--update') {
      args.update = true;
    } else if (token === '--stage') {
      const value = argv[i + 1];
      if (value === undefined) usageFail('--stage 缺少取值');
      if (value !== 'all' && !GATES.includes(value)) usageFail('未知阶段：' + value + '（可用：all 或 ' + GATES.join(',') + '）');
      args.stage = value;
      i++;
    } else if (token === '--sdk') {
      args.sdk = argv[i + 1];
      if (args.sdk === undefined) usageFail('--sdk 缺少取值');
      i++;
    } else if (token === '--hvigor') {
      args.hvigor = argv[i + 1];
      if (args.hvigor === undefined) usageFail('--hvigor 缺少取值');
      i++;
    } else {
      usageFail('未知参数：' + token);
    }
  }
  return args;
}

function usageFail(message) {
  process.stderr.write('run.mjs: ' + message + '\n');
  process.stderr.write(USAGE + '\n');
  process.exit(2);
}

const args = parseArgv(process.argv.slice(2));
if (args.help === true) {
  process.stdout.write(USAGE + '\n');
  process.exit(0);
}
const sdk = args.sdk || process.env.OHOS_BASE_SDK_HOME || DEFAULT_SDK;
const hvigor = args.hvigor || process.env.HVIGOR_HOME || DEFAULT_HVIGOR;

function oneLine(text, limit) {
  const max = limit === undefined ? 200 : limit;
  const line = String(text).split('\n').map((part) => part.trim()).find((part) => part !== '') || '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

function run(argsList, timeoutMs) {
  const res = spawnSync(process.execPath, argsList, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
    timeout: timeoutMs === undefined ? 600000 : timeoutMs,
  });
  return {
    code: res.status,
    stdout: res.stdout === null || res.stdout === undefined ? '' : res.stdout,
    stderr: res.stderr === null || res.stderr === undefined ? '' : res.stderr,
    signal: res.signal,
    error: res.error,
  };
}

function runTool(name, argv, timeoutMs) {
  return run([join(repoRoot, 'cli', name + '.ts')].concat(argv), timeoutMs);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function relOut(path) {
  return relative(repoRoot, path).split(sep).join('/');
}

function gate(name, title, status, detail, metrics) {
  const record = { gate: name, title, status, detail, metrics: metrics === undefined ? {} : metrics, commands: [] };
  return record;
}

/** 复制 parity 工程（跳过构建缓存/日志，确定性；不污染 .refs）。 */
function copyProject(from, to) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (rel === '') return true;
      const segments = rel.split(sep);
      if (segments.includes('.hvigor')) return false;
      const name = segments[segments.length - 1];
      const isDir = statSync(src).isDirectory();
      if (isDir && (name === 'build' || name === 'oh_modules' || name === '.preview')) return false;
      if (!isDir && (name === 'build.log' || name === '.arkts-lint.log')) return false;
      return true;
    },
  });
}

const EXPECTED_GOLDEN = [
  { scenario: 'empty', results: [{ case: 'position=0', value: -1 }] },
  {
    scenario: 'bounds',
    results: [
      { case: 'position=0', value: 0 },
      { case: 'position=2', value: 0 },
      { case: 'position=7', value: 1 },
      { case: 'position=11', value: 1 },
      { case: 'position=12', value: 1 },
      { case: 'position=99', value: 1 },
    ],
  },
];

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stageG1(source) {
  mkdirSync(OUT, { recursive: true });
  const root = upstreamRoot(source);
  const closure = runTool('extract-closure', [
    '--root', root, '--entry', SOURCE_REL, '--lang', 'js-ts',
    '--out', 'out/js-ts/closure', '--report', 'out/js-ts/closure.json', '--json',
  ], 120000);
  if (closure.code !== 0) {
    return gate('g1', 'golden 稳定', 'FAIL', 'extract-closure 失败（exit ' + closure.code + '）：' + oneLine(closure.stderr || closure.stdout));
  }
  const closureReport = readJson(join(OUT, 'closure.json'));
  const closureFiles = closureReport.totals && typeof closureReport.totals.files === 'number' ? closureReport.totals.files : -1;
  const closureLoc = closureReport.totals && typeof closureReport.totals.includeLoc === 'number' ? closureReport.totals.includeLoc : -1;

  rmSync(join(OUT, 'golden'), { recursive: true, force: true });
  const gen = runTool('gen-golden', [
    '--lang', 'js-ts', '--main', 'cases/js-ts/harness/chapter-progress.mjs',
    '--out', 'out/js-ts/golden', '--json', '--report', 'out/js-ts/gen-golden.json',
  ], 120000);
  if (gen.code !== 0) {
    return gate('g1', 'golden 稳定', 'FAIL', 'gen-golden 失败（exit ' + gen.code + '）：' + oneLine(gen.stdout || gen.stderr));
  }
  const report = readJson(join(OUT, 'gen-golden.json'));
  const goldenPath = join(OUT, 'golden', 'golden.json');
  if (!existsSync(goldenPath)) {
    return gate('g1', 'golden 稳定', 'FAIL', 'gen-golden 未写出 ' + relOut(goldenPath));
  }
  const goldenBytes = readFileSync(goldenPath);
  const hash = sha256(goldenBytes);
  let parsed = null;
  try {
    parsed = JSON.parse(goldenBytes.toString('utf8'));
  } catch {
    parsed = null;
  }
  const scenarioCount = Array.isArray(parsed) ? parsed.length : -1;
  const itemCount = Array.isArray(parsed)
    ? parsed.reduce((sum, entry) => sum + (Array.isArray(entry.results) ? entry.results.length : 0), 0)
    : -1;
  const specMatches = parsed !== null && sameJson(parsed, EXPECTED_GOLDEN);
  const committedPath = join(CASE, 'golden.json');
  const stable = report.stable === true && report.runs === 2;
  const hashMatches = typeof report.goldenSha256 === 'string' && report.goldenSha256 === hash;
  const ok = closureFiles === 1 && closureLoc === 9 && stable && hashMatches && specMatches && scenarioCount === 2 && itemCount === 7;
  if (ok && args.update) writeFileSync(committedPath, goldenBytes);
  const committedMatches = existsSync(committedPath) ? readFileSync(committedPath).equals(goldenBytes) : null;
  const metrics = {
    scenarios: scenarioCount,
    items: itemCount,
    stable,
    runs: report.runs,
    goldenSha256: hash,
    goldenBytes: goldenBytes.length,
    closureFiles,
    closureLoc,
    specMatches,
    committedGoldenMatches: committedMatches,
  };
  const detail = 'extract-closure ' + closureFiles + ' 文件/' + closureLoc + ' 行；gen-golden stable=' + stable +
    '（runs=' + report.runs + '），' + scenarioCount + ' scenarios / ' + itemCount + ' items，' +
    'sha256=' + hash.slice(0, 12) + '…；与规格期望' + (specMatches ? '逐项一致' : '不一致') +
    '；提交的 golden.json ' + (committedMatches === null ? '尚未提交（--update 可写）' : (committedMatches ? '与本次一致' : '与本次不一致'));
  return gate('g1', 'golden 稳定', ok ? 'PASS' : 'FAIL', detail, Object.assign(metrics, { goldenPath: relOut(goldenPath) }));
}

function stageG2() {
  const goldenPath = join(OUT, 'golden', 'golden.json');
  if (!existsSync(goldenPath)) {
    return gate('g2', '保真 100%', 'FAIL', '缺少 ' + relOut(goldenPath) + '（先跑 g1）');
  }
  const replay = run(['cases/js-ts/replay.mjs'], 120000);
  if (replay.code !== 0) {
    return gate('g2', '保真 100%', 'FAIL', 'replay 失败（exit ' + replay.code + '）：' + oneLine(replay.stderr || replay.stdout));
  }
  const actualPath = join(OUT, 'actual.json');
  writeFileSync(actualPath, replay.stdout);
  const goldenBytes = readFileSync(goldenPath);
  const actualBytes = readFileSync(actualPath);
  const verify = runTool('verify-fidelity', [
    '--golden', relOut(goldenPath), '--actual', 'out/js-ts/actual.json',
    '--key', 'scenario', '--items', 'results', '--field', 'value', '--json',
  ], 120000);
  let report = null;
  try {
    report = JSON.parse(verify.stdout);
  } catch {
    report = null;
  }
  const same = report !== null &&
    report.pass === true &&
    report.fidelityPct === 100 &&
    report.sameItems === 7 && report.totalItems === 7 &&
    report.sameScenarios === 2 && report.totalScenarios === 2 &&
    report.missingScenarios === 0;
  const byteEqual = goldenBytes.equals(actualBytes);
  const committedPath = join(CASE, 'actual.json');
  const ok = verify.code === 0 && same;
  if (ok && args.update) writeFileSync(committedPath, actualBytes);
  const committedMatches = existsSync(committedPath) ? readFileSync(committedPath).equals(actualBytes) : null;
  const metrics = {
    fidelityPct: report === null ? null : report.fidelityPct,
    sameItems: report === null ? null : report.sameItems,
    totalItems: report === null ? null : report.totalItems,
    sameScenarios: report === null ? null : report.sameScenarios,
    totalScenarios: report === null ? null : report.totalScenarios,
    missingScenarios: report === null ? null : report.missingScenarios,
    actualEqualsGolden: byteEqual,
    committedActualMatches: committedMatches,
  };
  const detail = 'verify-fidelity ' + (report === null ? '（无 JSON）' : report.fidelityPct + '%（' + report.sameItems + '/' + report.totalItems + ' items，' +
    report.sameScenarios + '/' + report.totalScenarios + ' scenarios）') +
    '；actual 与 golden ' + (byteEqual ? '逐字节相同（恒等转写）' : '不一致') +
    '；提交的 actual.json ' + (committedMatches === null ? '尚未提交（--update 可写）' : (committedMatches ? '与本次一致' : '与本次不一致'));
  return gate('g2', '保真 100%', ok ? 'PASS' : 'FAIL', detail, metrics);
}

function stageG4(source) {
  const srcDir = join(OUT, 'src');
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(join(srcDir, 'utils'), { recursive: true });
  cpSync(source, join(srcDir, 'utils', 'chapterProgress.ts'));
  rmSync(join(OUT, 'adapt'), { recursive: true, force: true });
  const adapt = runTool('adapt-arkts', [
    '--src', 'out/js-ts/src', '--out', 'out/js-ts/adapt', '--ets',
    '--json', '--report', 'out/js-ts/adapt-report.json',
  ], 120000);
  if (adapt.code !== 0) {
    return gate('g4', '无语义漂移', 'FAIL', 'adapt-arkts 失败（exit ' + adapt.code + '）：' + oneLine(adapt.stderr || adapt.stdout));
  }
  const adaptReport = readJson(join(OUT, 'adapt-report.json'));
  const changeCount = Array.isArray(adaptReport.changes) ? adaptReport.changes.length : -1;
  const adaptedPath = join(OUT, 'adapt', 'utils', 'chapterProgress.ets');
  const textSame = existsSync(adaptedPath) && readFileSync(adaptedPath).equals(readFileSync(source));
  rmSync(join(OUT, 'diff-gate.json'), { force: true });
  const diff = runTool('diff-gate', [
    '--before', 'out/js-ts/src', '--after', 'out/js-ts/adapt',
    '--json', '--report', 'out/js-ts/diff-gate.json',
  ], 120000);
  let diffReport = null;
  try {
    diffReport = readJson(join(OUT, 'diff-gate.json'));
  } catch {
    diffReport = null;
  }
  const counts = diffReport === null ? null : diffReport.counts;
  const noDrift = counts !== null && counts.needsReview === 0 && counts.cannotPair === 0 &&
    counts.typeOnly === 0 && counts.importPath === 0 && Array.isArray(diffReport.files) && diffReport.files.length === 0;
  const ok = changeCount === 0 && textSame && diff.code === 0 && noDrift;
  const metrics = {
    adaptChanges: changeCount,
    adaptedTextIdentical: textSame,
    diffGateExit: diff.code,
    needsReview: counts === null ? null : counts.needsReview,
    typeOnly: counts === null ? null : counts.typeOnly,
    importPath: counts === null ? null : counts.importPath,
    diffFiles: diffReport === null ? null : diffReport.files.length,
  };
  const detail = 'adapt-arkts --ets：changes=' + changeCount + ' 行（仅 .ts→.ets 改名，文本' + (textSame ? '逐字节相同' : '不同') + '）；' +
    'diff-gate exit ' + diff.code + '，needs-review ' + (counts === null ? '?' : counts.needsReview) +
    '（type-only ' + (counts === null ? '?' : counts.typeOnly) + ' / import-path ' + (counts === null ? '?' : counts.importPath) + '）';
  return gate('g4', '无语义漂移', ok ? 'PASS' : 'FAIL', detail, metrics);
}

function stageG3() {
  const adaptedPath = join(OUT, 'adapt', 'utils', 'chapterProgress.ets');
  if (!existsSync(adaptedPath)) {
    return gate('g3', 'ArkTS parity', 'FAIL', '缺少 adapt 产物（先跑 g4）');
  }
  const refProject = join(refsRoot(), 'arkts-check');
  if (!existsSync(refProject)) {
    return gate('g3', 'ArkTS parity', 'SKIP', '找不到参照工程（refs 后无 arkts-check）：' + refProject);
  }
  const project = join(OUT, 'parity');
  copyProject(refProject, project);
  const parityDir = join(project, 'entry', 'src', 'main', 'ets', 'parity');
  mkdirSync(parityDir, { recursive: true });
  const parityFile = join(parityDir, 'chapterProgress.ets');
  const verbatimBytes = readFileSync(adaptedPath);
  mkdirSync(join(OUT, 'verbatim'), { recursive: true });
  writeFileSync(join(OUT, 'verbatim', 'chapterProgress.ets'), verbatimBytes);
  writeFileSync(parityFile, verbatimBytes);

  // 1) 假绿对照：parity 文件没有被 entry import，lint 看不到它（仍 0 ERROR / pass）
  rmSync(join(OUT, 'lint-false-green.json'), { force: true });
  const lint = runTool('lint-arkts', [
    '--project', 'out/js-ts/parity', '--sdk', sdk, '--hvigor', hvigor,
    '--json', '--report', 'out/js-ts/lint-false-green.json', '--log', 'out/js-ts/lint-false-green.log',
  ], 600000);
  let lintReport = null;
  try {
    lintReport = readJson(join(OUT, 'lint-false-green.json'));
  } catch {
    lintReport = null;
  }

  // 2) verbatim probe：期望恰好 1 条约定 ERROR（arkts-no-obj-literals-as-types）
  rmSync(join(OUT, 'probe-verbatim.json'), { force: true });
  const probe1 = runTool('reachability-probe', [
    '--project', 'out/js-ts/parity', '--sdk', sdk, '--hvigor', hvigor,
    '--json', '--report', 'out/js-ts/probe-verbatim.json',
  ], 900000);
  let verbatim = null;
  try {
    verbatim = readJson(join(OUT, 'probe-verbatim.json'));
  } catch {
    verbatim = null;
  }

  // 3) 约定的人工类型修复（确定性脚本）：抽 interface ParagraphRange
  const fix = run(['cases/js-ts/parity-fix.mjs', '--in', parityFile, '--out', parityFile], 60000);

  // 4) fixed probe：期望 0 ERROR / 0 WARN
  rmSync(join(OUT, 'probe-fixed.json'), { force: true });
  const probe2 = runTool('reachability-probe', [
    '--project', 'out/js-ts/parity', '--sdk', sdk, '--hvigor', hvigor,
    '--json', '--report', 'out/js-ts/probe-fixed.json',
  ], 900000);
  let fixed = null;
  try {
    fixed = readJson(join(OUT, 'probe-fixed.json'));
  } catch {
    fixed = null;
  }

  const lintFalseGreen = lintReport !== null && lintReport.pass === true && lintReport.arktsErrors === 0;
  const verbatimOk = verbatim !== null && verbatim.arktsErrors === 1 && verbatim.warnArktsErrors === 0 &&
    verbatim.rules !== undefined && verbatim.rules['arkts-no-obj-literals-as-types'] === 1;
  const fixedOk = fixed !== null && fixed.arktsErrors === 0 && fixed.warnArktsErrors === 0 && fixed.pass === true && probe2.code === 0;
  const ok = lintFalseGreen && verbatimOk && fix.code === 0 && fixedOk;
  const metrics = {
    lintFalseGreen: lintFalseGreen ? (lintReport === null ? null : lintReport.arktsErrors) : (lintReport === null ? null : lintReport.arktsErrors),
    verbatimErrors: verbatim === null ? null : verbatim.arktsErrors,
    verbatimWarn: verbatim === null ? null : verbatim.warnArktsErrors,
    verbatimModules: verbatim === null ? null : verbatim.probeModules,
    verbatimRules: verbatim === null ? null : verbatim.rules,
    fixedErrors: fixed === null ? null : fixed.arktsErrors,
    fixedWarn: fixed === null ? null : fixed.warnArktsErrors,
    fixedModules: fixed === null ? null : fixed.probeModules,
    parityFixExit: fix.code,
  };
  const detail = 'lint 假绿对照 ' + (lintFalseGreen ? '0 ERROR（未 import 看不到）' : '预期 0 ERROR，实际 ' + (lintReport === null ? '?' : lintReport.arktsErrors)) +
    '；verbatim probe ' + (verbatim === null ? '无报告' : verbatim.probeModules + ' 模块 / ' + verbatim.arktsErrors + ' ERROR / ' + verbatim.warnArktsErrors + ' WARN（' + Object.keys(verbatim.rules === undefined ? {} : verbatim.rules).join(',') + '）') +
    '；parity-fix exit ' + fix.code +
    '；修复后 probe ' + (fixed === null ? '无报告' : fixed.probeModules + ' 模块 / ' + fixed.arktsErrors + ' ERROR / ' + fixed.warnArktsErrors + ' WARN');
  return gate('g3', 'ArkTS parity', ok ? 'PASS' : 'FAIL', detail, metrics);
}

const source = resolveSource(null);
if (source === null) {
  const payload = { case: 'js-ts-chapter-progress', skipped: true, reason: '找不到上游 ' + SOURCE_REL, tried: sourceCandidates() };
  if (args.json === true) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else process.stdout.write('SKIP: 找不到上游 ' + SOURCE_REL + '（尝试过：' + sourceCandidates().join(' , ') + '）\n');
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
const selected = args.stage === 'all' ? GATES : [args.stage];
// 依赖顺序：g3 需要 g4 的 adapt 产物，所以 g4 先跑；输出仍按 G1→G4 排列
const execution = selected.slice().sort((a, b) => {
  const rank = { g1: 0, g2: 1, g4: 2, g3: 3 };
  return rank[a] - rank[b];
});
const results = [];
const prerequisites = [];
for (const name of execution) {
  if (name === 'g1') results.push(stageG1(source));
  else if (name === 'g2') results.push(stageG2());
  else if (name === 'g4') results.push(stageG4(source));
  else if (name === 'g3') {
    if (!existsSync(join(OUT, 'adapt', 'utils', 'chapterProgress.ets'))) {
      prerequisites.push(stageG4(source));
    }
    results.push(stageG3());
  }
}

const pass = results.every((item) => item.status !== 'FAIL');
const evidence = {
  case: 'js-ts-chapter-progress',
  source,
  prerequisites,
  selected,
  updateMode: args.update,
  sdk,
  hvigor,
  pass,
  gates: results,
};
writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');

if (args.json === true) {
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} else {
  process.stdout.write('js-ts case  chapterProgress  source=' + source + '\n');
  for (const item of results) {
    process.stdout.write(item.status.padEnd(4) + '  ' + item.gate.toUpperCase() + '  ' + item.title + '：' + item.detail + '\n');
  }
  const passed = results.filter((item) => item.status === 'PASS').length;
  process.stdout.write('结果: ' + (pass ? 'PASS' : 'FAIL') + '（' + passed + '/' + results.length + '）  证据: ' + relOut(join(OUT, 'evidence.json')) + '\n');
}
process.exit(pass ? 0 : 1);
