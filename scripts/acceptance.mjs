#!/usr/bin/env node
/**
 * acceptance —— 端到端验收：把完整证据链固化成一条可复跑命令（发布前回归）。
 *
 * 用法：
 *   node scripts/acceptance.mjs [--refs <dir>] [--sdk <p>] [--hvigor <p>]
 *                               [--out out/acceptance] [--json] [--skip-build] [--keep]
 *
 * 阶段（每阶段一行 PASS/FAIL/SKIP + 关键数字 + 日志路径；默认 FAIL 即停）：
 *   stage        scripts/stage-case.mjs 复制 baseline -> <out>/ts，并 --check sha256（22 文件 / 4,925 行）
 *   golden       cli/gen-golden.ts 在 .refs/pag-exp/src 上产 <out>/golden.json，sha256 必须等于 cases/legado/golden.json
 *   replay       用 <out>/ts 重放 cases/legado/replay.ts，verify-fidelity 必须 100%（62/62），actual md5 等于 cases
 *   adapt        cli/adapt-arkts.ts baseline -> <out>/ets，summary 必须 43/41/9/9/7；diff-gate needs-review 0
 *   arkts-gate   复制 .refs/arkts-check 并替换 parity 为 <out>/ets（codemod 残留口径：45 模块/9 诊断=8 硬+1 WARN）；
 *                再换回参考适配产物（0 错误）；lint 0、build SUCCESSFUL。
 *                缺少 --sdk/--hvigor 或传了 --skip-build 时 SKIP。
 *
 * 注意：codemod 产物有 7 处约定残留，不能直接要求 0 错误；脚本把「codemod 残留口径」与
 *       「参考适配产物 0 错误口径」分开报告，不混成一个 PASS。
 *       参考适配产物 = .refs/arkts-check 自带的 parity（22 个 .ets）；.refs/pag-exp/ts 是 TS 源，不能直接替换 parity。
 *
 * 输出：每阶段一行 + 最多 15 行人类摘要；--json 把汇总 JSON 打到 stdout；
 *       汇总 JSON 始终写到 <out>/acceptance.json（{ ok, stages[], refs, out, counts, ... }）。
 *       --keep 保留 harmony 工程副本与 reference-parity（默认测完删除，省空间）。
 *
 * 退出码：0 = 全部 PASS（SKIP 不算失败）；1 = 任一 FAIL；2 = 用法错误。
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REFS = process.env.ARKTS_PORT_CASE_REFS || '';
const DEFAULT_OUT = join('out', 'acceptance');
const CASES_DIR = join(repoRoot, 'cases', 'legado');
const STAGE_ORDER = ['stage', 'golden', 'replay', 'adapt', 'arkts-gate'];

const EXPECT = {
  tsFiles: 22,
  tsLoc: 4925,
  pages: 62,
  adapt: { filesScanned: 22, filesChanged: 22, options: 43, patches: 41, renames: 9, asConst: 9, residuals: 7 },
  probeModules: 45,
  codemodDiagnostics: 9,
  codemodWarn: 1,
  referenceErrors: 0,
};

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE = [
  '用法：',
  '  node scripts/acceptance.mjs [--refs <dir>] [--sdk <p>] [--hvigor <p>]',
  '                              [--out out/acceptance] [--json] [--skip-build] [--keep]',
  '',
  '阶段（默认 FAIL 即停；arkts-gate 缺 --sdk/--hvigor 或 --skip-build 时 SKIP）：',
  '  stage       stage-case 复制 baseline -> <out>/ts，--check sha256（' + EXPECT.tsFiles + ' 文件 / ' + EXPECT.tsLoc + ' 行）',
  '  golden      gen-golden 产 golden，sha256 必须等于 cases/legado/golden.json',
  '  replay      重放 replay.ts，保真必须 100%（' + EXPECT.pages + '/' + EXPECT.pages + '），actual md5 等于 cases',
  '  adapt       adapt-arkts baseline -> <out>/ets，summary 必须 ' +
    [EXPECT.adapt.options, EXPECT.adapt.patches, EXPECT.adapt.renames, EXPECT.adapt.asConst, EXPECT.adapt.residuals].join('/') +
    '；diff-gate needs-review 0',
  '  arkts-gate  codemod 残留口径：' + EXPECT.probeModules + ' 模块/' + EXPECT.codemodDiagnostics +
    ' 诊断（' + (EXPECT.codemodDiagnostics - EXPECT.codemodWarn) + ' 硬 + ' + EXPECT.codemodWarn + ' WARN）；',
  '              参考适配产物口径：0 错误；lint 0；build SUCCESSFUL',
  '',
  '参数：',
  '  --refs <dir>      外部证据根目录（默认 ' + DEFAULT_REFS + '）',
  '  --sdk <p>         OpenHarmony SDK（缺省时 arkts-gate SKIP）',
  '  --hvigor <p>      hvigor node_modules（缺省时 arkts-gate SKIP）',
  '  --out <dir>       输出目录（默认 ' + DEFAULT_OUT + '；会先清空，不允许指向 cwd/仓库根/refs 内）',
  '  --json            只把汇总 JSON 打到 stdout（同时仍写 <out>/acceptance.json）',
  '  --skip-build      跳过 arkts-gate（不需要 SDK；SKIP 不算失败）',
  '  --keep            保留 <out>/harmony 与 <out>/reference-parity（默认测完删除）',
  '  --help, -h        打印本帮助',
  '',
  '退出码：0 = 全部 PASS（SKIP 不算失败）；1 = 任一 FAIL；2 = 用法错误。',
].join('\n');

// ---------------------------------------------------------------------------
// 参数与上下文
// ---------------------------------------------------------------------------

const VALUE_OPTS = new Set(['refs', 'sdk', 'hvigor', 'out']);
const BOOL_OPTS = new Set(['json', 'skip-build', 'keep', 'help']);

function failUsage(message) {
  console.error('acceptance: ' + message);
  console.error('用法见：node scripts/acceptance.mjs --help');
  process.exit(EXIT_USAGE);
}

function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      raw.help = true;
      continue;
    }
    if (!token.startsWith('--')) failUsage('无法识别的参数：' + token);
    const eq = token.indexOf('=');
    if (eq > 2) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
      if (value === '') failUsage('参数 --' + key + ' 不能为空');
      raw[key] = value;
      continue;
    }
    const key = token.slice(2);
    if (BOOL_OPTS.has(key)) {
      raw[key] = true;
      continue;
    }
    if (!VALUE_OPTS.has(key)) failUsage('未知参数：--' + key);
    const next = argv[i + 1];
    if (next === undefined || next === '' || next.startsWith('--')) failUsage('参数 --' + key + ' 缺少取值');
    raw[key] = next;
    i++;
  }
  return raw;
}

function buildContext(raw) {
  const cwd = process.cwd();
  const refsRaw = typeof raw.refs === 'string' ? raw.refs : DEFAULT_REFS;
  const outRaw = typeof raw.out === 'string' ? raw.out : DEFAULT_OUT;
  const refsAbs = resolve(cwd, refsRaw);
  const outAbs = resolve(cwd, outRaw);
  if (!isDirectory(refsAbs)) failUsage('--refs 目录不存在：' + refsRaw);
  if (outAbs === repoRoot || outAbs === cwd) failUsage('--out 不能是仓库根或当前目录：' + outRaw);
  if (isWithin(outAbs, refsAbs)) failUsage('--out 不能位于 --refs 内（会删掉外部证据）：' + outRaw);
  return {
    cwd,
    raw,
    refsRaw,
    refsAbs,
    outRaw,
    outAbs,
    logsDir: join(outAbs, 'logs'),
    reportPath: join(outAbs, 'acceptance.json'),
    sdk: typeof raw.sdk === 'string' ? raw.sdk : '',
    hvigor: typeof raw.hvigor === 'string' ? raw.hvigor : '',
    skipBuild: raw['skip-build'] === true,
    keep: raw.keep === true,
    json: raw.json === true,
  };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(child, parent) {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function md5File(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

function formatSeconds(durationMs) {
  return (durationMs / 1000).toFixed(2) + 's';
}

function formatNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function oneLine(text, max) {
  const limit = max === undefined ? 160 : max;
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 1) + '…';
}

function relPath(cwd, path) {
  const rel = relative(cwd, path);
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return path;
  return rel;
}

function parseJsonText(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const start = Math.min(
    text.indexOf('{') >= 0 ? text.indexOf('{') : Number.MAX_SAFE_INTEGER,
    text.indexOf('[') >= 0 ? text.indexOf('[') : Number.MAX_SAFE_INTEGER,
  );
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start === Number.MAX_SAFE_INTEGER || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function firstMeaningfulLine(text) {
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return oneLine(trimmed, 160);
  }
  return '(无输出)';
}

function copyTree(src, dest, skipRel) {
  cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = relative(src, source).split(sep).join('/');
      if (rel === '') return true;
      for (const skip of skipRel) {
        if (rel === skip || rel.startsWith(skip + '/')) return false;
      }
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

function runProcess(ctx, scriptPath, args, options) {
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ctx.cwd,
    encoding: (options && options.buffer) ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = res.stdout === null || res.stdout === undefined ? '' : res.stdout;
  const stderr = res.stderr === null || res.stderr === undefined ? '' : res.stderr;
  const outText = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
  const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr;
  let spawnError = null;
  if (res.error) spawnError = (res.error && res.error.message) ? res.error.message : String(res.error);
  const command = ['node', scriptPath, ...args].map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(' ');
  return {
    exitCode: res.status,
    stdout,
    stderr,
    output: outText + errText,
    durationMs,
    spawnError,
    command,
  };
}

function runTool(ctx, toolName, args) {
  return runProcess(ctx, join(repoRoot, 'cli', toolName + '.ts'), args);
}

function runScript(ctx, relScript, args) {
  return runProcess(ctx, join(repoRoot, relScript), args);
}

function logChild(lines, run) {
  lines.push('');
  lines.push('# 命令: ' + run.command);
  lines.push('# 退出码: ' + (run.exitCode === null ? '-' : String(run.exitCode)));
  lines.push('# 耗时: ' + run.durationMs + 'ms');
  if (run.spawnError !== null) lines.push('# 启动错误: ' + run.spawnError);
  lines.push('---');
  lines.push(run.output);
}

// ---------------------------------------------------------------------------
// 阶段结果
// ---------------------------------------------------------------------------

function pass(summary, metrics, exitCode, lines) {
  return { status: 'PASS', summary: summary, metrics: metrics || undefined, exitCode: exitCode === undefined ? 0 : exitCode, logLines: lines || [] };
}

function fail(summary, exitCode, lines) {
  return { status: 'FAIL', summary: summary, metrics: undefined, exitCode: exitCode === undefined ? null : exitCode, logLines: lines || [] };
}

function childFailure(prefix, run) {
  if (run.spawnError !== null) return prefix + '：' + run.spawnError;
  const detail = run.stderr.trim() !== '' ? firstMeaningfulLine(run.stderr) : firstMeaningfulLine(run.stdout);
  return prefix + '（exit ' + String(run.exitCode) + '）：' + detail;
}

// ---------------------------------------------------------------------------
// 阶段 1：stage-case（TS 证据 staging + sha256 校验）
// ---------------------------------------------------------------------------

function runStageStage(ctx) {
  const lines = [];
  const tsDir = join(ctx.outAbs, 'ts');
  const stage = runScript(ctx, join('scripts', 'stage-case.mjs'), ['--refs', ctx.refsAbs, '--dest', tsDir, '--json']);
  logChild(lines, stage);
  const staged = parseJsonText(stage.stdout);
  if (stage.exitCode !== 0 || staged === null || staged.ok !== true) {
    return fail(childFailure('stage-case 复制失败', stage), stage.exitCode, lines);
  }
  if (staged.files !== EXPECT.tsFiles || staged.loc !== EXPECT.tsLoc) {
    return fail('ts 证据数量不符：expected ' + EXPECT.tsFiles + ' 文件 / ' + EXPECT.tsLoc + ' 行，actual ' +
      String(staged.files) + ' 文件 / ' + String(staged.loc) + ' 行', 0, lines);
  }
  const check = runScript(ctx, join('scripts', 'stage-case.mjs'), ['--refs', ctx.refsAbs, '--dest', tsDir, '--check', '--json']);
  logChild(lines, check);
  const checked = parseJsonText(check.stdout);
  if (check.exitCode !== 0 || checked === null || checked.ok !== true) {
    const mismatches = checked && Array.isArray(checked.mismatches) ? checked.mismatches : [];
    return fail('stage-case --check sha256 不一致（' + mismatches.length + ' 处）', check.exitCode, lines);
  }
  return pass('ts ' + staged.files + ' 文件 / ' + formatNumber(staged.loc) + ' 行（staging + sha256 校验一致）',
    { files: staged.files, loc: staged.loc, check: true }, 0, lines);
}

// ---------------------------------------------------------------------------
// 阶段 2：golden
// ---------------------------------------------------------------------------

function runGoldenStage(ctx) {
  const lines = [];
  const srcDir = join(ctx.refsAbs, 'pag-exp', 'src');
  const mainPath = join(srcDir, 'Main.kt');
  const goldenOut = join(ctx.outAbs, 'golden');
  const reportPath = join(goldenOut, 'report.json');
  if (!isDirectory(srcDir) || !isFile(mainPath)) {
    return fail('缺少 .refs/pag-exp/src 或 Main.kt：' + srcDir, null, lines);
  }
  const run = runTool(ctx, 'gen-golden', [
    '--lang', 'jvm',
    '--src', srcDir,
    '--main', mainPath,
    '--out', goldenOut,
    '--logs', ctx.logsDir,
    '--json',
    '--report', reportPath,
  ]);
  logChild(lines, run);
  const report = parseJsonText(run.stdout) !== null ? parseJsonText(run.stdout) : readJsonFile(reportPath);
  if (run.exitCode !== 0 || report === null || report.ok !== true || report.stable !== true) {
    const detail = report !== null && typeof report.message === 'string' && report.message !== ''
      ? 'stage=' + String(report.stage) + '：' + report.message
      : childFailure('gen-golden 失败', run);
    return fail('gen-golden 失败（exit ' + String(run.exitCode) + '）：' + detail, run.exitCode, lines);
  }
  const goldenPath = join(goldenOut, 'golden.json');
  if (!isFile(goldenPath)) return fail('gen-golden 报告 ok 但 ' + goldenPath + ' 不存在', 0, lines);
  const actualSha = typeof report.goldenSha256 === 'string' ? report.goldenSha256 : sha256File(goldenPath);
  const expectedSha = sha256File(join(CASES_DIR, 'golden.json'));
  if (actualSha !== expectedSha) {
    return fail('golden sha256 与 cases/legado/golden.json 不一致：expected ' + expectedSha.slice(0, 16) +
      '… actual ' + actualSha.slice(0, 16) + '…', run.exitCode, lines);
  }
  const bytes = typeof report.goldenBytes === 'number' ? report.goldenBytes : statSync(goldenPath).size;
  return pass('golden sha256 ' + actualSha.slice(0, 12) + '…（与 cases/legado/golden.json 一致），' + formatNumber(bytes) + ' 字节',
    {
      goldenSha256: actualSha,
      expectedSha256: expectedSha,
      goldenBytes: bytes,
      stable: true,
      compileMs: report.compile ? report.compile.durationMs : null,
    }, 0, lines);
}

// ---------------------------------------------------------------------------
// 阶段 3：replay（重放 + 保真 + actual md5）
// ---------------------------------------------------------------------------

function runReplayStage(ctx) {
  const lines = [];
  const replayDir = join(ctx.outAbs, 'replay');
  const replayTs = join(CASES_DIR, 'replay.ts');
  const stagedTs = join(ctx.outAbs, 'ts');
  if (!isFile(replayTs) || !isDirectory(stagedTs)) {
    return fail('缺少 cases/legado/replay.ts 或 <out>/ts（先跑 stage 阶段）', null, lines);
  }
  rmSync(replayDir, { recursive: true, force: true });
  mkdirSync(replayDir, { recursive: true });
  cpSync(replayTs, join(replayDir, 'replay.ts'));
  cpSync(stagedTs, join(replayDir, 'ts'), { recursive: true });
  const actualPath = join(replayDir, 'actual.json');
  const replay = runProcess(ctx, join(replayDir, 'replay.ts'), [], { buffer: true });
  lines.push('');
  lines.push('# 命令: node ' + join(replayDir, 'replay.ts') + ' > ' + actualPath);
  lines.push('# 退出码: ' + (replay.exitCode === null ? '-' : String(replay.exitCode)));
  lines.push('# 耗时: ' + replay.durationMs + 'ms');
  if (replay.spawnError !== null) lines.push('# 启动错误: ' + replay.spawnError);
  lines.push('---');
  lines.push(replay.output);
  if (replay.exitCode !== 0 || replay.spawnError !== null) {
    return fail('replay.ts 运行失败（exit ' + String(replay.exitCode) + '）：' + firstMeaningfulLine(replay.output), replay.exitCode, lines);
  }
  const stdoutBuffer = Buffer.isBuffer(replay.stdout) ? replay.stdout : Buffer.from(String(replay.stdout), 'utf8');
  writeFileSync(actualPath, stdoutBuffer);

  const verify = runTool(ctx, 'verify-fidelity', [
    '--golden', join(CASES_DIR, 'golden.json'),
    '--actual', actualPath,
    '--json',
  ]);
  logChild(lines, verify);
  const result = parseJsonText(verify.stdout);
  if (verify.exitCode !== 0 || result === null || result.pass !== true) {
    if (result !== null && result.pass === false) {
      const missing = typeof result.missingScenarios === 'number' ? result.missingScenarios : 0;
      return fail('verify-fidelity 未通过：保真 ' + String(result.fidelityPct) + '%（' +
        String(result.sameItems) + '/' + String(result.totalItems) + ' 页），缺失场景 ' + String(missing) +
        '，actual=' + actualPath, verify.exitCode, lines);
    }
    return fail(childFailure('verify-fidelity 未通过', verify), verify.exitCode, lines);
  }
  if (result.sameItems !== EXPECT.pages || result.totalItems !== EXPECT.pages || result.fidelityPct !== 100) {
    return fail('保真度不符：expected ' + EXPECT.pages + '/' + EXPECT.pages + '（100%），actual ' +
      String(result.sameItems) + '/' + String(result.totalItems) + '（' + String(result.fidelityPct) + '%）',
    verify.exitCode, lines);
  }
  const actualMd5 = md5File(actualPath);
  const expectedMd5 = md5File(join(CASES_DIR, 'actual.json'));
  if (actualMd5 !== expectedMd5) {
    return fail('actual md5 与 cases/legado/actual.json 不一致：expected ' + expectedMd5 + ' actual ' + actualMd5,
      verify.exitCode, lines);
  }
  return pass('保真 ' + EXPECT.pages + '/' + EXPECT.pages + '（100%），actual md5 ' + actualMd5.slice(0, 12) +
    '…（与 cases/legado/actual.json 一致）',
  { fidelityPct: 100, sameItems: result.sameItems, totalItems: result.totalItems, actualMd5: actualMd5, expectedMd5: expectedMd5 },
  0, lines);
}

// ---------------------------------------------------------------------------
// 阶段 4：adapt（codemod + diff-gate）
// ---------------------------------------------------------------------------

function runAdaptStage(ctx) {
  const lines = [];
  const baseline = join(ctx.refsAbs, 'arkts-adapt-baseline');
  if (!isDirectory(baseline)) return fail('缺少 .refs/arkts-adapt-baseline：' + baseline, null, lines);
  const etsDir = join(ctx.outAbs, 'ets');
  const reportPath = join(ctx.outAbs, 'adapt-report.json');
  const run = runTool(ctx, 'adapt-arkts', [
    '--src', baseline,
    '--out', etsDir,
    '--ets',
    '--report', reportPath,
    '--json',
  ]);
  logChild(lines, run);
  const report = parseJsonText(run.stdout) !== null ? parseJsonText(run.stdout) : readJsonFile(reportPath);
  if (run.exitCode !== 0 || report === null || typeof report.summary !== 'object' || report.summary === null) {
    return fail(childFailure('adapt-arkts 失败', run), run.exitCode, lines);
  }
  const summary = report.summary;
  const mismatches = [];
  for (const key of ['filesScanned', 'filesChanged', 'options', 'patches', 'renames', 'asConst', 'residuals']) {
    const expected = EXPECT.adapt[key];
    const actual = summary[key];
    if (actual !== expected) mismatches.push(key + ': expected ' + expected + ' actual ' + String(actual));
  }
  if (mismatches.length > 0) {
    return fail('adapt summary 不符：' + mismatches.join('；'), run.exitCode, lines);
  }

  const diff = runTool(ctx, 'diff-gate', ['--before', join(ctx.outAbs, 'ts'), '--after', etsDir, '--strict', '--json']);
  logChild(lines, diff);
  const diffReport = parseJsonText(diff.stdout);
  if (diff.exitCode !== 0 || diffReport === null || diffReport.ok !== true) {
    return fail(childFailure('diff-gate 未通过（needs-review 必须为 0）', diff), diff.exitCode, lines);
  }
  const counts = diffReport.counts || {};
  if (counts.needsReview !== 0) {
    return fail('diff-gate needs-review=' + String(counts.needsReview) + '（必须 0）', diff.exitCode, lines);
  }
  return pass('options ' + summary.options + ' / patches ' + summary.patches + ' / renames ' + summary.renames +
    ' / asConst ' + summary.asConst + ' / residuals ' + summary.residuals +
    '（约定残留）；diff-gate needs-review 0（type-only ' + String(counts.typeOnly) + ' / import-path ' + String(counts.importPath) + '）',
  {
    filesScanned: summary.filesScanned,
    filesChanged: summary.filesChanged,
    options: summary.options,
    patches: summary.patches,
    renames: summary.renames,
    asConst: summary.asConst,
    residuals: summary.residuals,
    needsReview: counts.needsReview,
    typeOnly: counts.typeOnly,
    importPath: counts.importPath,
  }, 0, lines);
}

// ---------------------------------------------------------------------------
// 阶段 5：arkts-gate（codemod 残留口径 vs 参考适配产物口径）
// ---------------------------------------------------------------------------

function probeNumbers(report) {
  const errors = typeof report.arktsErrors === 'number' ? report.arktsErrors : null;
  const warn = typeof report.warnArktsErrors === 'number' ? report.warnArktsErrors : null;
  const modules = typeof report.probeModules === 'number' ? report.probeModules : null;
  return { modules: modules, errors: errors, warn: warn };
}

function runArktsGateStage(ctx) {
  const lines = [];
  const projectSrc = join(ctx.refsAbs, 'arkts-check');
  if (!isDirectory(projectSrc)) return fail('缺少 .refs/arkts-check：' + projectSrc, null, lines);
  const harmony = join(ctx.outAbs, 'harmony');
  const referenceParity = join(ctx.outAbs, 'reference-parity');
  const parity = join(harmony, 'entry', 'src', 'main', 'ets', 'parity');
  const etsDir = join(ctx.outAbs, 'ets');
  if (!isDirectory(etsDir)) return fail('缺少 <out>/ets（先跑 adapt 阶段）', null, lines);

  rmSync(harmony, { recursive: true, force: true });
  copyTree(projectSrc, harmony, ['entry/build', '.hvigor', 'build', 'node_modules', 'oh_modules']);
  if (!isDirectory(parity)) return fail('arkts-check 里没有 entry/src/main/ets/parity，无法替换参考产物', null, lines);
  rmSync(referenceParity, { recursive: true, force: true });
  cpSync(parity, referenceParity, { recursive: true });
  rmSync(parity, { recursive: true, force: true });
  cpSync(etsDir, parity, { recursive: true });
  lines.push('# 工程副本: ' + harmony + '（排除 entry/build/.hvigor/build）');
  lines.push('# codemod 产物 -> parity：' + etsDir + ' -> ' + parity);

  const codemodProbe = runTool(ctx, 'reachability-probe', ['--project', harmony, '--sdk', ctx.sdk, '--hvigor', ctx.hvigor, '--json']);
  logChild(lines, codemodProbe);
  const codemodReport = parseJsonText(codemodProbe.stdout);
  if (codemodReport === null) {
    return fail(childFailure('reachability-probe（codemod 产物）失败', codemodProbe), codemodProbe.exitCode, lines);
  }
  const codemod = probeNumbers(codemodReport);
  const codemodHard = codemod.errors === null || codemod.warn === null ? null : codemod.errors - codemod.warn;
  if (codemod.modules !== EXPECT.probeModules || codemod.errors !== EXPECT.codemodDiagnostics ||
      codemod.warn !== EXPECT.codemodWarn || codemodHard !== EXPECT.codemodDiagnostics - EXPECT.codemodWarn) {
    return fail('codemod 残留口径不符：expected ' + EXPECT.probeModules + ' 模块 / ' + EXPECT.codemodDiagnostics +
      ' 诊断（' + (EXPECT.codemodDiagnostics - EXPECT.codemodWarn) + ' 硬 + ' + EXPECT.codemodWarn + ' WARN），actual ' +
      String(codemod.modules) + ' 模块 / ' + String(codemod.errors) + ' 诊断（' + String(codemodHard) + ' 硬 + ' + String(codemod.warn) + ' WARN）',
    codemodProbe.exitCode, lines);
  }

  rmSync(parity, { recursive: true, force: true });
  cpSync(referenceParity, parity, { recursive: true });
  lines.push('# 参考适配产物 -> parity（恢复 arkts-check 自带 parity）');
  const referenceProbe = runTool(ctx, 'reachability-probe', ['--project', harmony, '--sdk', ctx.sdk, '--hvigor', ctx.hvigor, '--json']);
  logChild(lines, referenceProbe);
  const referenceReport = parseJsonText(referenceProbe.stdout);
  if (referenceReport === null) {
    return fail(childFailure('reachability-probe（参考产物）失败', referenceProbe), referenceProbe.exitCode, lines);
  }
  const reference = probeNumbers(referenceReport);
  if (reference.modules !== EXPECT.probeModules || reference.errors !== EXPECT.referenceErrors) {
    return fail('参考适配产物口径不符：expected ' + EXPECT.probeModules + ' 模块 / ' + EXPECT.referenceErrors +
      ' 错误，actual ' + String(reference.modules) + ' 模块 / ' + String(reference.errors) + ' 错误',
    referenceProbe.exitCode, lines);
  }

  const lint = runTool(ctx, 'lint-arkts', ['--project', harmony, '--sdk', ctx.sdk, '--hvigor', ctx.hvigor, '--json']);
  logChild(lines, lint);
  const lintReport = parseJsonText(lint.stdout);
  if (lint.exitCode !== 0 || lintReport === null || lintReport.pass !== true || lintReport.arktsErrors !== 0) {
    return fail(childFailure('lint-arkts 未通过（参考产物必须 0 错误）', lint), lint.exitCode, lines);
  }

  const build = runTool(ctx, 'build-hap', ['--project', harmony, '--sdk', ctx.sdk, '--hvigor', ctx.hvigor]);
  logChild(lines, build);
  if (build.exitCode !== 0 || !/BUILD SUCCESSFUL/.test(build.stdout + build.stderr)) {
    return fail(childFailure('build-hap 未成功（期望 BUILD SUCCESSFUL）', build), build.exitCode, lines);
  }

  if (!ctx.keep) {
    rmSync(harmony, { recursive: true, force: true });
    rmSync(referenceParity, { recursive: true, force: true });
    lines.push('# 已清理 harmony / reference-parity（--keep 可保留）');
  }
  return pass('codemod 产物 ' + EXPECT.probeModules + ' 模块 / ' + EXPECT.codemodDiagnostics + ' 诊断（' +
    (EXPECT.codemodDiagnostics - EXPECT.codemodWarn) + ' 硬 + ' + EXPECT.codemodWarn + ' WARN，约定残留口径）；' +
    '参考适配产物 ' + EXPECT.probeModules + ' 模块 / 0 错误；lint 0；build SUCCESSFUL',
  {
    codemodProbeModules: codemod.modules,
    codemodErrors: codemod.errors,
    codemodHard: codemodHard,
    codemodWarn: codemod.warn,
    referenceProbeModules: reference.modules,
    referenceErrors: reference.errors,
    lintErrors: lintReport.arktsErrors,
    buildSuccessful: true,
  }, 0, lines);
}

const STAGE_RUN = {
  stage: runStageStage,
  golden: runGoldenStage,
  replay: runReplayStage,
  adapt: runAdaptStage,
  'arkts-gate': runArktsGateStage,
};

function skipReason(ctx, name) {
  if (name !== 'arkts-gate') return null;
  if (ctx.skipBuild) return '--skip-build 指定，跳过需要构建的 arkts-gate';
  if (ctx.sdk === '' || ctx.hvigor === '') return '缺少 --sdk/--hvigor，跳过构建类 arkts-gate（SKIP 不算失败）';
  return null;
}

// ---------------------------------------------------------------------------
// 执行与汇总
// ---------------------------------------------------------------------------

function writeStageLog(ctx, name, outcome, durationMs) {
  const logPath = join(ctx.logsDir, name + '.log');
  mkdirSync(ctx.logsDir, { recursive: true });
  const body = [
    '# acceptance stage: ' + name,
    '# 命令: node scripts/acceptance.mjs（阶段内部命令见下）',
    '# 状态: ' + outcome.status,
    '# 耗时: ' + durationMs + 'ms',
    '---',
  ].concat(outcome.logLines).join('\n');
  writeFileSync(logPath, body + '\n', 'utf8');
  return relPath(ctx.cwd, logPath);
}

function executeStage(ctx, name) {
  const skip = skipReason(ctx, name);
  if (skip !== null) {
    const outcome = { status: 'SKIP', summary: skip, metrics: undefined, exitCode: null, logLines: ['# 状态: SKIP', '# 原因: ' + skip, '# 命令: 未执行'] };
    const logPath = writeStageLog(ctx, name, outcome, 0);
    return { name: name, status: 'SKIP', exitCode: null, durationMs: 0, summary: skip, logPath: logPath };
  }
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = STAGE_RUN[name](ctx);
  } catch (error) {
    outcome = fail('编排器异常：' + (error && error.message ? error.message : String(error)), null, ['# 编排器异常', String(error && error.stack ? error.stack : error)]);
  }
  const durationMs = Date.now() - startedAt;
  const logPath = writeStageLog(ctx, name, outcome, durationMs);
  const result = {
    name: name,
    status: outcome.status,
    exitCode: outcome.exitCode,
    durationMs: durationMs,
    summary: oneLine(outcome.summary, 400),
    logPath: logPath,
  };
  if (outcome.metrics !== undefined) result.metrics = outcome.metrics;
  return result;
}

function formatStageLine(result) {
  const parts = [result.status.padEnd(4), result.name.padEnd(11), oneLine(result.summary, 150)];
  if (result.exitCode !== null && result.exitCode !== 0) parts.push('[exit ' + result.exitCode + ']');
  if (result.status !== 'SKIP') parts.push(formatSeconds(result.durationMs));
  parts.push(result.logPath);
  return parts.join('  ').replace(/\s+$/, '');
}

function buildReport(ctx, stages, remaining, stoppedEarly) {
  const counts = {
    pass: stages.filter((stage) => stage.status === 'PASS').length,
    fail: stages.filter((stage) => stage.status === 'FAIL').length,
    skip: stages.filter((stage) => stage.status === 'SKIP').length,
  };
  return {
    ok: counts.fail === 0,
    stages: stages,
    refs: ctx.refsRaw,
    out: ctx.outRaw,
    counts: counts,
    stoppedEarly: stoppedEarly,
    remaining: remaining,
    skipBuild: ctx.skipBuild,
  };
}

function humanLines(ctx, report) {
  const lines = ['acceptance  refs=' + ctx.refsRaw + '  out=' + ctx.outRaw];
  for (const stage of report.stages) lines.push(formatStageLine(stage));
  if (report.stoppedEarly) {
    lines.push('已停止：遇到 FAIL 未继续' + (report.remaining.length > 0 ? '；未运行：' + report.remaining.join(',') : ''));
  }
  lines.push('结果: ' + (report.ok ? 'PASS' : 'FAIL') + '（PASS ' + report.counts.pass + ' / FAIL ' + report.counts.fail +
    ' / SKIP ' + report.counts.skip + '）  报告：' + relPath(ctx.cwd, ctx.reportPath));
  return lines.slice(0, 15);
}

function main() {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.help === true) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }
  const ctx = buildContext(raw);

  rmSync(ctx.outAbs, { recursive: true, force: true });
  mkdirSync(ctx.logsDir, { recursive: true });

  const stages = [];
  const remaining = [];
  let stoppedEarly = false;
  for (const name of STAGE_ORDER) {
    if (stoppedEarly) {
      remaining.push(name);
      continue;
    }
    const result = executeStage(ctx, name);
    stages.push(result);
    if (result.status === 'FAIL') stoppedEarly = true;
  }

  const report = buildReport(ctx, stages, remaining, stoppedEarly);
  writeFileSync(ctx.reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (ctx.json) console.log(JSON.stringify(report, null, 2));
  else console.log(humanLines(ctx, report).join('\n'));
  process.exit(report.ok ? EXIT_OK : EXIT_FAIL);
}

main();
