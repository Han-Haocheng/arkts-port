/**
 * scripts/stage-case.mjs 的黑盒单测：临时目录里自造 refs / case，不依赖真实 .refs。
 * 覆盖：复制、provenance、--check（一致/哈希/缺文件/多余/目标不存在）、--json、退出码、幂等、环境变量。
 *
 * 跑法：node --test tests/stage-case.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = join(ROOT, 'scripts', 'stage-case.mjs');
const TEMP_DIRS: string[] = [];

const BASELINE_PREFIX = 'refs/arkts-adapt-baseline/';

const BASELINE_FILES: Record<string, string> = {
  'refs/arkts-adapt-baseline/layout/Alpha.ts': '// alpha\n\nexport const ALPHA = 1;\n',
  'refs/arkts-adapt-baseline/layout/Beta.ts': '// beta\nexport const BETA = 2;\n',
  'refs/arkts-adapt-baseline/model/Gamma.ts': '// gamma\nexport const GAMMA = 3;\n',
  'refs/arkts-adapt-baseline/style/Delta.ts': '// delta\nexport const DELTA = 4;\n',
};

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stage-case-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const absolute = join(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

/** 造一个只有假 refs + 假 case 的工作区（与真实 .refs 完全无关）。 */
function makeWorkspace(extra: Record<string, string> = {}): string {
  const root = makeTempDir();
  writeFiles(root, {
    'cases/legado/replay.ts': '// fake replay for stage-case test\nconsole.log("[]");\n',
    'cases/legado/golden.json': '{}\n',
    'cases/legado/actual.json': '[]\n',
    ...BASELINE_FILES,
    ...extra,
  });
  return root;
}

interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runStage(args: string[], cwd: string, env: Record<string, string> = {}): SpawnResult {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.ARKTS_PORT_CASE_REFS = '';
  for (const [key, value] of Object.entries(env)) merged[key] = value;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: merged });
  return {
    status: result.status === null ? -1 : result.status,
    stdout: result.stdout === null ? '' : result.stdout,
    stderr: result.stderr === null ? '' : result.stderr,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function countLines(text: string): number {
  const buffer = Buffer.from(text, 'utf8');
  let lines = 0;
  for (const byte of buffer) if (byte === 0x0a) lines++;
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) lines++;
  return lines;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('staging：复制 refs 基线 + 写确定性 provenance（无时间戳）', () => {
  const workspace = makeWorkspace();
  const result = runStage(['--refs', 'refs', '--case', 'cases/legado'], workspace);
  assert.equal(result.status, 0, result.stderr);

  const dest = join(workspace, 'cases', 'legado', 'ts');
  for (const [rel, content] of Object.entries(BASELINE_FILES)) {
    const stagedRel = rel.slice(BASELINE_PREFIX.length);
    assert.equal(readFileSync(join(dest, stagedRel), 'utf8'), content, '复制内容必须逐字节一致：' + stagedRel);
  }

  const provenance = readJson(join(dest, '.provenance.json'));
  assert.deepEqual(Object.keys(provenance).sort(), ['case', 'files', 'loc', 'sha256', 'source']);
  assert.equal(provenance.files, 4);
  const expectedLoc = Object.values(BASELINE_FILES).reduce((sum, text) => sum + countLines(text), 0);
  assert.equal(provenance.loc, expectedLoc);
  assert.equal(provenance.case, 'cases/legado');
  assert.equal(provenance.source, join(resolve(workspace, 'refs'), 'arkts-adapt-baseline').split('\\').join('/'));
  assert.equal(JSON.stringify(provenance).includes('timestamp'), false);
  assert.equal(/time|date|generated/i.test(JSON.stringify(Object.keys(provenance))), false, 'provenance 不能有时间戳字段');

  const hashes = provenance.sha256 as Record<string, string>;
  assert.deepEqual(Object.keys(hashes), ['layout/Alpha.ts', 'layout/Beta.ts', 'model/Gamma.ts', 'style/Delta.ts']);
  for (const [rel, content] of Object.entries(BASELINE_FILES)) {
    const stagedRel = rel.slice(BASELINE_PREFIX.length);
    assert.equal(hashes[stagedRel], sha256(content));
  }

  assert.equal(result.stdout.trim().split('\n').length <= 10, true, '人类摘要必须 <= 10 行');
  assert.ok(result.stdout.includes(dest.split('\\').join('/')));
  assert.ok(result.stdout.includes('4 文件'));
});

test('staging：两次运行逐字节相同（确定性），并清掉受管目录里的旧残留', () => {
  const workspace = makeWorkspace();
  const dest = join(workspace, 'cases', 'legado', 'ts');
  const first = runStage(['--refs', 'refs', '--case', 'cases/legado'], workspace);
  assert.equal(first.status, 0, first.stderr);
  const provenanceFirst = readFileSync(join(dest, '.provenance.json'), 'utf8');

  // 残留 + 受管目录之外的无关文件
  writeFileSync(join(dest, 'layout', 'Stale.ts'), '// stale\n', 'utf8');
  writeFileSync(join(dest, 'notes.txt'), 'keep me\n', 'utf8');

  const second = runStage(['--refs', 'refs', '--case', 'cases/legado'], workspace);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(existsSync(join(dest, 'layout', 'Stale.ts')), false, 'staging 必须清掉 layout 里的旧残留');
  assert.equal(readFileSync(join(dest, 'notes.txt'), 'utf8'), 'keep me\n', '受管目录之外的无关文件不能删');
  assert.equal(readFileSync(join(dest, '.provenance.json'), 'utf8'), provenanceFirst, 'provenance 必须逐字节稳定');

  // 同一个工作区换 dest：provenance 只记录 source/case/files/loc/sha256，不含 dest/时间戳
  const alt = runStage(['--refs', 'refs', '--case', 'cases/legado', '--dest', 'custom-out'], workspace);
  assert.equal(alt.status, 0, alt.stderr);
  assert.equal(readFileSync(join(workspace, 'custom-out', '.provenance.json'), 'utf8'), provenanceFirst,
    '不同 dest 的 provenance 必须逐字节相同（不含 dest/时间戳）');
});

test('--json：结构化输出形状固定且 ok=true', () => {
  const workspace = makeWorkspace();
  const result = runStage(['--refs', 'refs', '--case', 'cases/legado', '--json'], workspace);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload).sort(), ['dest', 'files', 'loc', 'mismatches', 'ok', 'source']);
  assert.equal(payload.ok, true);
  assert.equal(payload.files, 4);
  assert.deepEqual(payload.mismatches, []);
  assert.ok(payload.dest.endsWith('cases/legado/ts'));
  assert.ok(payload.source.endsWith('arkts-adapt-baseline'));
});

test('--check：一致时 exit 0，且不写任何文件', () => {
  const workspace = makeWorkspace();
  assert.equal(runStage(['--refs', 'refs'], workspace).status, 0);
  const dest = join(workspace, 'cases', 'legado', 'ts');
  const provenanceBefore = readFileSync(join(dest, '.provenance.json'), 'utf8');
  const check = runStage(['--refs', 'refs', '--json', '--check'], workspace);
  assert.equal(check.status, 0, check.stderr);
  const payload = JSON.parse(check.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.mismatches, []);
  assert.equal(readFileSync(join(dest, '.provenance.json'), 'utf8'), provenanceBefore, '--check 不能改文件');
});

test('--check：哈希不一致 -> exit 1 并指出文件', () => {
  const workspace = makeWorkspace();
  assert.equal(runStage(['--refs', 'refs'], workspace).status, 0);
  const tampered = join(workspace, 'cases', 'legado', 'ts', 'layout', 'Alpha.ts');
  writeFileSync(tampered, readFileSync(tampered, 'utf8') + '// tampered\n', 'utf8');

  const check = runStage(['--refs', 'refs', '--json', '--check'], workspace);
  assert.equal(check.status, 1);
  const payload = JSON.parse(check.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.mismatches.length, 1);
  assert.equal(payload.mismatches[0].file, 'layout/Alpha.ts');
  assert.equal(payload.mismatches[0].kind, 'hash');
  assert.ok(String(payload.mismatches[0].expected).length === 64);
  assert.ok(String(payload.mismatches[0].actual).length === 64);
  assert.notEqual(payload.mismatches[0].expected, payload.mismatches[0].actual);

  const human = runStage(['--refs', 'refs', '--check'], workspace);
  assert.equal(human.status, 1);
  assert.ok(human.stdout.includes('layout/Alpha.ts'), human.stdout);
  assert.ok(human.stdout.includes('FAIL'), human.stdout);
  assert.ok(human.stdout.trim().split('\n').length <= 10, '失败摘要也必须 <= 10 行');
});

test('--check：dest 缺文件 -> exit 1（kind=missing）', () => {
  const workspace = makeWorkspace();
  assert.equal(runStage(['--refs', 'refs'], workspace).status, 0);
  rmSync(join(workspace, 'cases', 'legado', 'ts', 'model', 'Gamma.ts'));
  const check = runStage(['--refs', 'refs', '--json', '--check'], workspace);
  assert.equal(check.status, 1);
  const payload = JSON.parse(check.stdout);
  assert.deepEqual(payload.mismatches.map((item: { file: string; kind: string }) => item.file + ':' + item.kind), ['model/Gamma.ts:missing']);
});

test('--check：dest 多出 .ts -> exit 1（kind=extra）', () => {
  const workspace = makeWorkspace();
  assert.equal(runStage(['--refs', 'refs'], workspace).status, 0);
  writeFileSync(join(workspace, 'cases', 'legado', 'ts', 'style', 'Extra.ts'), '// extra\n', 'utf8');
  const check = runStage(['--refs', 'refs', '--json', '--check'], workspace);
  assert.equal(check.status, 1);
  const payload = JSON.parse(check.stdout);
  assert.deepEqual(payload.mismatches.map((item: { file: string; kind: string }) => item.file + ':' + item.kind), ['style/Extra.ts:extra']);
});

test('--check：dest 不存在 -> exit 1（kind=dest-missing），staging 后恢复', () => {
  const workspace = makeWorkspace();
  const missing = runStage(['--refs', 'refs', '--json', '--check'], workspace);
  assert.equal(missing.status, 1);
  const payload = JSON.parse(missing.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.mismatches.length, 1);
  assert.equal(payload.mismatches[0].kind, 'dest-missing');
  assert.equal(runStage(['--refs', 'refs'], workspace).status, 0);
  assert.equal(runStage(['--refs', 'refs', '--check'], workspace).status, 0);
});

test('环境变量 ARKTS_PORT_CASE_REFS：不给 --refs 时生效', () => {
  const workspace = makeWorkspace();
  const refs = join(workspace, 'refs');
  const withEnv = runStage(['--case', 'cases/legado'], workspace, { ARKTS_PORT_CASE_REFS: refs });
  assert.equal(withEnv.status, 0, withEnv.stderr);
  assert.ok(existsSync(join(workspace, 'cases', 'legado', 'ts', 'layout', 'Alpha.ts')));

  const checkWithEnv = runStage(['--case', 'cases/legado', '--check'], workspace, { ARKTS_PORT_CASE_REFS: refs });
  assert.equal(checkWithEnv.status, 0, checkWithEnv.stderr);
});

test('用法错误一律 exit 2；--help exit 0', () => {
  const workspace = makeWorkspace();
  const help = runStage(['--help'], workspace);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--refs'));

  assert.equal(runStage(['--nope'], workspace).status, 2);
  assert.equal(runStage(['--refs'], workspace).status, 2);
  assert.equal(runStage(['--refs', 'missing-dir'], workspace).status, 2);
  assert.equal(runStage(['--refs', 'cases/legado'], workspace).status, 2, 'refs 缺 arkts-adapt-baseline 必须 exit 2');
  assert.equal(runStage(['--refs', 'refs', '--case', 'missing-case'], workspace).status, 2);

  // 安全闸：别把源证据清掉 / 别把 GPL 派生代码落进 case 根目录
  assert.equal(runStage(['--refs', 'refs', '--dest', 'refs'], workspace).status, 2);
  assert.equal(runStage(['--refs', 'refs', '--dest', 'refs/arkts-adapt-baseline'], workspace).status, 2);
  assert.equal(runStage(['--refs', 'refs', '--dest', 'cases/legado'], workspace).status, 2);
  assert.equal(existsSync(join(workspace, 'refs', 'arkts-adapt-baseline', 'layout', 'Alpha.ts')), true, '源证据不能被删');

  // 空基线（有目录但没 .ts）也算配置错误，不能假成功
  const empty = makeTempDir();
  mkdirSync(join(empty, 'refs', 'arkts-adapt-baseline', 'layout'), { recursive: true });
  mkdirSync(join(empty, 'refs', 'arkts-adapt-baseline', 'model'), { recursive: true });
  mkdirSync(join(empty, 'refs', 'arkts-adapt-baseline', 'style'), { recursive: true });
  mkdirSync(join(empty, 'cases', 'legado'), { recursive: true });
  assert.equal(runStage(['--refs', 'refs'], empty).status, 2);
});

test('staging 不碰 case 里的 replay.ts / golden.json / actual.json', () => {
  const workspace = makeWorkspace();
  const before = new Map<string, string>();
  for (const name of ['replay.ts', 'golden.json', 'actual.json']) {
    before.set(name, readFileSync(join(workspace, 'cases', 'legado', name), 'utf8'));
  }
  assert.equal(runStage(['--refs', 'refs'], workspace).status, 0);
  for (const [name, content] of before) {
    assert.equal(readFileSync(join(workspace, 'cases', 'legado', name), 'utf8'), content, name + ' 被改了');
  }
});

test('.gitignore 忽略 cases/*/ts 与 cases/legado/ts（GPL 派生代码不入库）', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  const lines = gitignore.split('\n').map((line) => line.trim());
  assert.ok(lines.indexOf('cases/*/ts/') >= 0, '新 case 的默认 dest 也要被忽略：' + gitignore);
  assert.ok(lines.indexOf('cases/legado/ts/') >= 0, gitignore);
});

after(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});
