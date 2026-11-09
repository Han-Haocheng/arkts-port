#!/usr/bin/env node
/**
 * cases/js-ts-yoga/run.mjs —— yoga-layout 规模化 js-ts 案例端到端复跑（G1-G4 门禁；G3 默认 0/0）。
 *
 * 用法（仓库根目录）：
 *   node cases/js-ts-yoga/run.mjs [--stage g1|g2|g3|g4|all] [--json] [--update] [--restage]
 *                                 [--sdk <path>] [--hvigor <path>]
 *
 * 阶段：
 *   g1  stage.mjs（2 文件 + 1 处 import 重写 + sha256）→ gen-golden --lang js-ts（两次逐字节一致）
 *       → golden + sha256（--update 同步 cases/js-ts-yoga/golden.json）
 *   g2  replay.mjs → actual；verify-fidelity --key scenario --items results --field value → 100%
 *       （--update 同步 cases/js-ts-yoga/actual.json）
 *   g4  adapt-arkts --ets（记录 options/patches/residuals）→ diff-gate（期望 0 needs-review）
 *   g3  ArkTS parity：adapt-arkts 产物经 arkts-fix.mjs 确定性修复（const-object→enum、对象字面量类型→
 *       interface、带方法的对象字面量→类、unknown→具体类型）后放进 arkts-check 副本 → reachability-probe；
 *       **0 ERROR + 0 WARN 才 PASS**；--no-fix/--g3-record 退化为基线记录（INFO，用于对比 136 ERROR）
 *
 * 外部依赖（均不入库）：
 *   yoga 源：$ARKTS_PORT_YOGA_SRC（MIT；或 ARKTS_PORT_YOGA_SRC）
 *   --sdk / OHOS_BASE_SDK_HOME     默认 $OHOS_BASE_SDK_HOME
 *   --hvigor / HVIGOR_HOME         默认 $HVIGOR_HOME
 *   arkts-check 参照工程：$ARKTS_PORT_CASE_REFS/arkts-check（默认 legado .refs）
 *
 * 产物：out/js-ts-yoga/（gitignored）；退出码：0 = G1-G4 全 PASS（G3 默认 0/0）、1 = 有 FAIL、2 = 用法。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(repoRoot, 'out', 'js-ts-yoga');
const CASE = join(repoRoot, 'cases', 'js-ts-yoga');
const DEFAULT_SDK = process.env.OHOS_BASE_SDK_HOME || '';
const DEFAULT_HVIGOR = process.env.HVIGOR_HOME || '';
const REFS_ROOT = process.env.ARKTS_PORT_CASE_REFS || '';
const GATES = ['g1', 'g2', 'g3', 'g4'];
const YOGA_DIR_SUFFIX = '/src/native-ts/yoga-layout';

/** 规格 §3.2 的期望值（4 组 / 44 items；最终以 gen-golden 产物为准，这里是自检）。 */
const EXPECTED_GOLDEN = [
  { scenario: 's1-basic', results: [
    { case: 'root.left', value: 0 }, { case: 'root.top', value: 0 }, { case: 'root.width', value: 100 }, { case: 'root.height', value: 50 },
    { case: 'root.0.left', value: 0 }, { case: 'root.0.top', value: 0 }, { case: 'root.0.width', value: 40 }, { case: 'root.0.height', value: 20 },
  ] },
  { scenario: 's2-row-center-pad', results: [
    { case: 'root.left', value: 0 }, { case: 'root.top', value: 0 }, { case: 'root.width', value: 200 }, { case: 'root.height', value: 40 },
    { case: 'root.0.left', value: 70 }, { case: 'root.0.top', value: 10 }, { case: 'root.0.width', value: 30 }, { case: 'root.0.height', value: 10 },
    { case: 'root.1.left', value: 100 }, { case: 'root.1.top', value: 10 }, { case: 'root.1.width', value: 30 }, { case: 'root.1.height', value: 10 },
  ] },
  { scenario: 's3-col-center-gap-margin', results: [
    { case: 'root.left', value: 0 }, { case: 'root.top', value: 0 }, { case: 'root.width', value: 120 }, { case: 'root.height', value: 80 },
    { case: 'root.0.left', value: 40 }, { case: 'root.0.top', value: 8 }, { case: 'root.0.width', value: 40 }, { case: 'root.0.height', value: 10 },
    { case: 'root.1.left', value: 30 }, { case: 'root.1.top', value: 25 }, { case: 'root.1.width', value: 60 }, { case: 'root.1.height', value: 50 },
  ] },
  { scenario: 's4-percent-absolute', results: [
    { case: 'root.left', value: 0 }, { case: 'root.top', value: 0 }, { case: 'root.width', value: 200 }, { case: 'root.height', value: 100 },
    { case: 'root.0.left', value: 0 }, { case: 'root.0.top', value: 0 }, { case: 'root.0.width', value: 100 }, { case: 'root.0.height', value: 25 },
    { case: 'root.1.left', value: 10 }, { case: 'root.1.top', value: 20 }, { case: 'root.1.width', value: 30 }, { case: 'root.1.height', value: 30 },
  ] },
];

const USAGE = [
  '用法：',
  '  node cases/js-ts-yoga/run.mjs [--stage all|g1|g2|g3|g4] [--json] [--update] [--restage]',
  '                                  [--sdk <path>] [--hvigor <path>]',
  '',
  '  g1  stage + gen-golden（两次一致 + sha256；4 scenarios / 44 items）',
  '  g2  replay + verify-fidelity（100%）',
  '  g4  adapt-arkts --ets + diff-gate（0 needs-review）',
  '  g3  arkts-fix + parity probe（默认门禁 0 ERROR / 0 WARN；--no-fix/--g3-record 只记录基线）',
  '',
  '  --update     把 golden/actual 同步到 cases/js-ts-yoga/',
  '  --restage    强制重跑 stage.mjs（默认 staged 缺失时才跑）',
  '  --no-fix     跳过 arkts-fix（G3 退化为基线记录，用于对比 136 ERROR）',
  '  --g3-record  G3 只记录基线（修复层仍然产出 adapt-fixed，但不作为门禁）',
  '  --sdk / --hvigor  覆盖 SDK 与 hvigor（默认见文件头）',
  '',
  '退出码：0 = G1-G4 全 PASS（默认 G3 0/0）；1 = 有 FAIL；2 = 用法错误',
].join('\n');

function usageFail(message) {
  process.stderr.write('run.mjs: ' + message + '\n');
  process.stderr.write(USAGE + '\n');
  process.exit(2);
}

const argv = process.argv.slice(2);
const args = { stage: 'all', json: false, update: false, restage: false, noFix: false, g3Record: false, sdk: null, hvigor: null, help: false };
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (token === '--json') args.json = true;
  else if (token === '--update') args.update = true;
  else if (token === '--restage') args.restage = true;
  else if (token === '--no-fix') args.noFix = true;
  else if (token === '--g3-record') args.g3Record = true;
  else if (token === '-h' || token === '--help') args.help = true;
  else if (token === '--stage') {
    const value = argv[i + 1];
    if (value === undefined) usageFail('--stage 缺少取值');
    if (value !== 'all' && !GATES.includes(value)) usageFail('未知阶段：' + value + '（可用：all 或 ' + GATES.join(',') + '）');
    args.stage = value;
    i++;
  } else if (token === '--sdk' || token === '--hvigor') {
    const value = argv[i + 1];
    if (value === undefined) usageFail(token + ' 缺少取值');
    args[token.slice(2)] = value;
    i++;
  } else usageFail('未知参数：' + token);
}
if (args.help) {
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
    timeout: timeoutMs === undefined ? 900000 : timeoutMs,
  });
  return {
    code: res.status,
    stdout: res.stdout === null || res.stdout === undefined ? '' : res.stdout,
    stderr: res.stderr === null || res.stderr === undefined ? '' : res.stderr,
    signal: res.signal,
    error: res.error,
  };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function relOut(path) {
  return relative(repoRoot, path).split(sep).join('/');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function gate(name, title, status, detail, metrics) {
  return { gate: name, title, status, detail, metrics: metrics === undefined ? {} : metrics, commands: [] };
}

const STAGED_ENTRY = join(OUT, 'src', 'yoga', 'index.ts');
const GOLDEN = join(OUT, 'golden', 'golden.json');

function ensureStaged() {
  const needStage = args.restage || !existsSync(STAGED_ENTRY);
  if (!needStage) return { staged: true, ran: false };
  const result = run([join(repoRoot, 'cases', 'js-ts-yoga', 'stage.mjs'), '--json'], 120000);
  if (result.code === 3) return { staged: false, ran: true, pending: result, reason: oneLine(result.stderr) };
  if (result.code !== 0) return { staged: false, ran: true, failed: result };
  return { staged: true, ran: true, manifest: readJson(join(OUT, 'stage.json')) };
}

function stageG1() {
  const staged = ensureStaged();
  if (staged.staged === false && staged.pending !== undefined) {
    return gate('g1', 'golden 稳定', 'SKIP', '上游 yoga-layout 缺失：' + staged.reason, {});
  }
  if (staged.staged === false) {
    return gate('g1', 'golden 稳定', 'FAIL', 'stage.mjs 失败（exit ' + staged.failed.code + '）：' + oneLine(staged.failed.stderr), {});
  }
  const manifest = readJson(join(OUT, 'stage.json'));
  const stagedSizes = manifest === null ? [] : manifest.files.map((file) => file.path + ' ' + file.bytes + ' B');
  const rewriteCount = manifest === null ? -1 : manifest.rewrites.reduce((sum, item) => sum + item.count, 0);

  rmSync(join(OUT, 'golden'), { recursive: true, force: true });
  const gen = run([
    join(repoRoot, 'cli', 'gen-golden.ts'), '--lang', 'js-ts',
    '--main', 'cases/js-ts-yoga/harness/yoga.mjs',
    '--out', 'out/js-ts-yoga/golden', '--json', '--report', 'out/js-ts-yoga/gen-golden.json',
  ], 300000);
  const report = readJson(join(OUT, 'gen-golden.json'));
  if (gen.code !== 0 || report === null) {
    return gate('g1', 'golden 稳定', 'FAIL', 'gen-golden 失败（exit ' + gen.code + '）：' + oneLine(gen.stdout || gen.stderr), {});
  }
  const goldenBytes = existsSync(GOLDEN) ? readFileSync(GOLDEN) : null;
  if (goldenBytes === null) {
    return gate('g1', 'golden 稳定', 'FAIL', 'gen-golden 未写出 ' + relOut(GOLDEN), {});
  }
  const hash = sha256(goldenBytes);
  const parsed = (() => {
    try {
      return JSON.parse(goldenBytes.toString('utf8'));
    } catch {
      return null;
    }
  })();
  const scenarios = Array.isArray(parsed) ? parsed.length : -1;
  const items = Array.isArray(parsed) ? parsed.reduce((sum, entry) => sum + entry.results.length, 0) : -1;
  // 规格 §3.2 的期望值（golden 由当前实现跑出，这里顺带核对与规格表一致）
  const specMatches = parsed !== null && JSON.stringify(parsed) === JSON.stringify(EXPECTED_GOLDEN);
  // 规格 §4 的 0) 步：closure + pack-context 证据（上下文包体积/token 估算）
  let closureEvidence = null;
  if (manifest !== null && typeof manifest.upstreamDir === 'string' && manifest.upstreamDir.endsWith(YOGA_DIR_SUFFIX)) {
    const closureRoot = manifest.upstreamDir.slice(0, -YOGA_DIR_SUFFIX.length);
    rmSync(join(OUT, 'closure'), { recursive: true, force: true });
    const closureRun = run([
      join(repoRoot, 'cli', 'extract-closure.ts'), '--root', closureRoot,
      '--entry', 'src/native-ts/yoga-layout/index.ts', '--lang', 'js-ts',
      '--out', 'out/js-ts-yoga/closure', '--report', 'out/js-ts-yoga/closure.json', '--json',
    ], 120000);
    const closureReport = readJson(join(OUT, 'closure.json'));
    if (closureRun.code === 0 && closureReport !== null) {
      rmSync(join(OUT, 'context.md'), { force: true });
      run([
        join(repoRoot, 'cli', 'pack-context.ts'), '--closure', 'out/js-ts-yoga/closure', '--lang', 'js-ts',
        '--out', 'out/js-ts-yoga/context.md', '--json', '--report', 'out/js-ts-yoga/context.json',
      ], 120000);
      const contextReport = readJson(join(OUT, 'context.json'));
      closureEvidence = {
        closureFiles: closureReport.totals.files,
        closureLoc: closureReport.totals.loc,
        closureUnresolved: Array.isArray(closureReport.unresolved) ? closureReport.unresolved.length : null,
        contextBytes: contextReport === null ? null : contextReport.totals.bytes,
        contextSignatures: contextReport === null ? null : contextReport.totals.signatures,
      };
    }
  }
  const committedPath = join(CASE, 'golden.json');
  const stable = report.stable === true && report.runs === 2;
  const hashMatches = typeof report.goldenSha256 === 'string' && report.goldenSha256 === hash;
  const ok = stagedSizes.length === 2 && rewriteCount === 1 && stable && hashMatches && specMatches && scenarios === 4 && items === 44;
  if (ok && args.update) writeFileSync(committedPath, goldenBytes);
  const committedMatches = existsSync(committedPath) ? readFileSync(committedPath).equals(goldenBytes) : null;
  return gate('g1', 'golden 稳定', ok ? 'PASS' : 'FAIL',
    'stage ' + stagedSizes.length + ' 文件（' + stagedSizes.join(' / ') + '，' + rewriteCount + ' 处 import 重写）；' +
    (closureEvidence === null ? '' : 'closure ' + closureEvidence.closureFiles + ' 文件/' + closureEvidence.closureLoc + ' 行，context ' +
      closureEvidence.contextBytes + ' B（' + closureEvidence.contextSignatures + ' 签名）；') +
    'gen-golden stable=' + stable + '（runs=' + report.runs + '），' + scenarios + ' scenarios / ' + items + ' items（与规格 §3.2 ' +
    (specMatches ? '一致' : '不一致') + '），sha256=' + hash.slice(0, 12) + '…；提交的 golden.json ' +
    (committedMatches === null ? '尚未提交（--update 可写）' : (committedMatches ? '与本次一致' : '与本次不一致')),
    { scenarios, items, specMatches, stable, runs: report.runs, goldenSha256: hash, goldenBytes: goldenBytes.length, stagedFiles: stagedSizes.length, rewrites: rewriteCount, committedGoldenMatches: committedMatches, context: closureEvidence });
}

function stageG2() {
  if (!existsSync(GOLDEN)) return gate('g2', '保真 100%', 'FAIL', '缺少 ' + relOut(GOLDEN) + '（先跑 g1）');
  const replay = run([join(repoRoot, 'cases', 'js-ts-yoga', 'replay.mjs')], 120000);
  if (replay.code !== 0) return gate('g2', '保真 100%', 'FAIL', 'replay 失败（exit ' + replay.code + '）：' + oneLine(replay.stderr));
  const actualPath = join(OUT, 'actual.json');
  writeFileSync(actualPath, replay.stdout);
  const goldenBytes = readFileSync(GOLDEN);
  const actualBytes = readFileSync(actualPath);
  const verify = run([
    join(repoRoot, 'cli', 'verify-fidelity.ts'),
    '--golden', relOut(GOLDEN), '--actual', 'out/js-ts-yoga/actual.json',
    '--key', 'scenario', '--items', 'results', '--field', 'value', '--json',
  ], 120000);
  const report = (() => {
    try {
      return JSON.parse(verify.stdout);
    } catch {
      return null;
    }
  })();
  const same = report !== null && report.pass === true && report.fidelityPct === 100 &&
    report.sameItems === 44 && report.totalItems === 44 &&
    report.sameScenarios === 4 && report.totalScenarios === 4 && report.missingScenarios === 0;
  const byteEqual = goldenBytes.equals(actualBytes);
  const ok = verify.code === 0 && same;
  const committedPath = join(CASE, 'actual.json');
  if (ok && args.update) writeFileSync(committedPath, actualBytes);
  const committedMatches = existsSync(committedPath) ? readFileSync(committedPath).equals(actualBytes) : null;
  return gate('g2', '保真 100%', ok ? 'PASS' : 'FAIL',
    'verify-fidelity ' + (report === null ? '（无 JSON）' : report.fidelityPct + '%（' + report.sameItems + '/' + report.totalItems + ' items，' +
      report.sameScenarios + '/' + report.totalScenarios + ' scenarios）') +
    '；actual 与 golden ' + (byteEqual ? '逐字节相同（恒等转写）' : '不一致') +
    '；提交的 actual.json ' + (committedMatches === null ? '尚未提交（--update 可写）' : (committedMatches ? '与本次一致' : '与本次不一致')),
    { fidelityPct: report === null ? null : report.fidelityPct, sameItems: report === null ? null : report.sameItems, totalItems: report === null ? null : report.totalItems, sameScenarios: report === null ? null : report.sameScenarios, totalScenarios: report === null ? null : report.totalScenarios, actualEqualsGolden: byteEqual, committedActualMatches: committedMatches });
}

function stageG4() {
  if (!existsSync(STAGED_ENTRY)) return gate('g4', 'adapt + diff-gate', 'FAIL', '缺少 staged 源码（先跑 g1）');
  rmSync(join(OUT, 'adapt'), { recursive: true, force: true });
  const adapt = run([
    join(repoRoot, 'cli', 'adapt-arkts.ts'), '--src', 'out/js-ts-yoga/src', '--out', 'out/js-ts-yoga/adapt',
    '--ets', '--json', '--report', 'out/js-ts-yoga/adapt.json',
  ], 300000);
  const adaptReport = readJson(join(OUT, 'adapt.json'));
  if (adapt.code !== 0 || adaptReport === null) {
    return gate('g4', 'adapt + diff-gate', 'FAIL', 'adapt-arkts 失败（exit ' + adapt.code + '）：' + oneLine(adapt.stderr || adapt.stdout));
  }
  const summary = adaptReport.summary === undefined ? {} : adaptReport.summary;
  const residuals = Array.isArray(adaptReport.residuals) ? adaptReport.residuals : [];
  const residualCodes = {};
  for (const item of residuals) residualCodes[item.code] = (residualCodes[item.code] === undefined ? 1 : residualCodes[item.code] + 1);
  const changes = Array.isArray(adaptReport.changes) ? adaptReport.changes.length : -1;

  rmSync(join(OUT, 'diff.json'), { force: true });
  const diff = run([
    join(repoRoot, 'cli', 'diff-gate.ts'), '--before', 'out/js-ts-yoga/src', '--after', 'out/js-ts-yoga/adapt',
    '--json', '--report', 'out/js-ts-yoga/diff.json',
  ], 300000);
  const diffReport = readJson(join(OUT, 'diff.json'));
  const counts = diffReport === null ? null : diffReport.counts;
  const noDrift = counts !== null && counts.needsReview === 0 && counts.cannotPair === 0;
  const ok = diff.code === 0 && noDrift;
  return gate('g4', 'adapt + diff-gate', ok ? 'PASS' : 'FAIL',
    'adapt-arkts --ets：changes ' + changes + '，options ' + (summary.options ?? '?') + ' / patches ' + (summary.patches ?? '?') +
    ' / renames ' + (summary.renames ?? '?') + ' / asConst ' + (summary.asConst ?? '?') + ' / residual ' + (summary.residuals ?? residuals.length) +
    ' 条（' + Object.keys(residualCodes).map((code) => code + ' ' + residualCodes[code]).join('，') + '）；' +
    'diff-gate exit ' + diff.code + '，needs-review ' + (counts === null ? '?' : counts.needsReview) +
    '（type-only ' + (counts === null ? '?' : counts.typeOnly) + ' / import-path ' + (counts === null ? '?' : counts.importPath) + '）',
    { adaptChanges: changes, options: summary.options, patches: summary.patches, renames: summary.renames, asConst: summary.asConst, residuals: summary.residuals, residualCodes, diffExit: diff.code, needsReview: counts === null ? null : counts.needsReview, typeOnly: counts === null ? null : counts.typeOnly, importPath: counts === null ? null : counts.importPath });
}

function copyProject(from, to) {
  const skipped = [];
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (rel === '') return true;
      const segments = rel.split(sep);
      if (segments.includes('.hvigor')) {
        skipped.push(rel);
        return false;
      }
      const name = segments[segments.length - 1];
      const isDir = statSync(src).isDirectory();
      if (isDir && (name === 'build' || name === 'oh_modules' || name === '.preview')) {
        skipped.push(rel);
        return false;
      }
      if (!isDir && (name === 'build.log' || name === '.arkts-lint.log')) return false;
      return true;
    },
  });
  return skipped.length;
}

function stageG3() {
  const adaptDir = join(OUT, 'adapt');
  if (!existsSync(adaptDir)) return gate('g3', 'ArkTS parity', 'SKIP', '缺少 adapt 产物（先跑 g4）');
  const refProject = join(REFS_ROOT, 'arkts-check');
  if (!existsSync(refProject)) return gate('g3', 'ArkTS parity', 'SKIP', '找不到参照工程：' + refProject);
  const recordMode = args.noFix || args.g3Record;
  let sourceDir = adaptDir;
  let fixReport = null;
  if (!recordMode) {
    const fix = run([join(repoRoot, 'cases', 'js-ts-yoga', 'arkts-fix.mjs'), '--json'], 120000);
    try {
      fixReport = JSON.parse(fix.stdout);
    } catch {
      fixReport = null;
    }
    if (fix.code !== 0 || fixReport === null || !existsSync(join(OUT, 'adapt-fixed', 'yoga', 'index.ets'))) {
      return gate('g3', 'ArkTS parity', 'FAIL',
        'arkts-fix 失败（exit ' + fix.code + '）：' + oneLine(fix.stderr || fix.stdout));
    }
    writeFileSync(join(OUT, 'fix.json'), JSON.stringify(fixReport, null, 2) + '\n');
    sourceDir = join(OUT, 'adapt-fixed');
  }

  const project = join(OUT, 'parity');
  rmSync(project, { recursive: true, force: true });
  copyProject(refProject, project);
  const parityDir = join(project, 'entry', 'src', 'main', 'ets', 'parity', 'yoga');
  mkdirSync(parityDir, { recursive: true });
  for (const name of ['index.ets', 'enums.ets']) {
    const from = join(sourceDir, 'yoga', name);
    if (!existsSync(from)) continue;
    writeFileSync(join(parityDir, name), readFileSync(from));
  }

  const reportName = recordMode ? 'reach-baseline.json' : 'reach-fixed.json';
  rmSync(join(OUT, reportName), { force: true });
  const probe = run([
    join(repoRoot, 'cli', 'reachability-probe.ts'), '--project', 'out/js-ts-yoga/parity',
    '--sdk', sdk, '--hvigor', hvigor, '--json', '--report', 'out/js-ts-yoga/' + reportName,
  ], 1800000);
  const report = readJson(join(OUT, reportName));
  const adaptReport = readJson(join(OUT, 'adapt.json'));
  const residuals = adaptReport === null || !Array.isArray(adaptReport.residuals) ? [] : adaptReport.residuals;
  const rules = report === null || report.rules === undefined ? {} : report.rules;
  const ruleText = Object.keys(rules).map((rule) => rule + ' ' + rules[rule]).join('，');
  const ruleSummary = ruleText === '' ? '无规则命中' : ruleText;
  const probeSummary = report === null
    ? '无报告（probe exit ' + probe.code + '）'
    : report.probeModules + ' 模块 / ' + report.arktsErrors + ' ERROR / ' + report.warnArktsErrors + ' WARN（' + ruleSummary + '）';
  const metrics = {
    probeExit: probe.code,
    modules: report === null ? null : report.probeModules,
    arktsErrors: report === null ? null : report.arktsErrors,
    warnArktsErrors: report === null ? null : report.warnArktsErrors,
    rules,
    adaptResiduals: residuals.length,
    record: recordMode,
    reportPath: 'out/js-ts-yoga/' + reportName,
    fix: fixReport === null ? null : {
      inDir: fixReport.inDir,
      outDir: fixReport.outDir,
      files: fixReport.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, transforms: file.transforms })),
    },
  };

  if (recordMode) {
    return gate('g3', 'ArkTS 基线记录', 'INFO',
      'probe（' + (args.noFix ? '--no-fix' : '--g3-record') + ' 基线记录，不设门禁）：' + probeSummary +
      '；adapt residual ' + residuals.length + ' 条；基线 136 ERROR / 0 WARN（README §5.2）',
      metrics);
  }

  const ok = report !== null && report.arktsErrors === 0 && report.warnArktsErrors === 0 && probe.code === 0;
  const fixSummary = fixReport === null ? '' :
    fixReport.files.map((file) => file.path + '（' + file.transforms.map((item) => item.label + ' ×' + item.count).join('，') + '）').join('；');
  return gate('g3', 'ArkTS parity', ok ? 'PASS' : 'FAIL',
    'arkts-fix：' + fixSummary + '；probe（修复后）：' + probeSummary + '；基线 136 → 现在 ' + (report === null ? '?' : report.arktsErrors),
    metrics);
}

mkdirSync(OUT, { recursive: true });
const selected = args.stage === 'all' ? GATES : [args.stage];
const execution = selected.slice().sort((a, b) => {
  const rank = { g1: 0, g2: 1, g4: 2, g3: 3 };
  return rank[a] - rank[b];
});
const results = [];
for (const name of execution) {
  if (name === 'g1') results.push(stageG1());
  else if (name === 'g2') results.push(stageG2());
  else if (name === 'g4') results.push(stageG4());
  else if (name === 'g3') results.push(stageG3());
}
const ordered = results.slice().sort((a, b) => GATES.indexOf(a.gate) - GATES.indexOf(b.gate));
const pass = ordered.every((item) => item.status !== 'FAIL');
const manifest = readJson(join(OUT, 'stage.json'));
const evidence = {
  case: 'js-ts-yoga',
  source: manifest === null ? null : manifest.upstreamDir,
  staged: manifest === null ? null : manifest.stagedDir,
  updateMode: args.update,
  sdk,
  hvigor,
  pass,
  gates: ordered,
};
writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');

if (args.json) {
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} else {
  process.stdout.write('js-ts yoga case  source=' + (manifest === null ? '?' : manifest.upstreamDir) + '\n');
  for (const item of ordered) {
    process.stdout.write(item.status.padEnd(4) + '  ' + item.gate.toUpperCase() + '  ' + item.title + '：' + item.detail + '\n');
  }
  const gates = ordered.filter((item) => item.status !== 'INFO');
  const passed = gates.filter((item) => item.status === 'PASS').length;
  const tally = gates.length === 0 ? 'G3 仅记录' : passed + '/' + gates.length + (ordered.some((item) => item.status === 'INFO') ? ' + G3 记录' : '');
  process.stdout.write('结果: ' + (pass ? 'PASS' : 'FAIL') + '（' + tally + '）  证据: ' + relOut(join(OUT, 'evidence.json')) + '\n');
}
process.exit(pass ? 0 : 1);
