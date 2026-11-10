import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * 测 templates/kotlin-harness：真值一致性、不一致检测（round/Float/Long 编码）、两次运行确定性、用法错误。
 * 只编译一次 Kotlin（--classes 复用），后续用例直接跑。
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = join(repoRoot, 'templates', 'kotlin-harness');
const COMPARE = join(TEMPLATE, 'compare.mjs');
const HARNESS = join(TEMPLATE, 'harness.kt');
const EXAMPLE = join(TEMPLATE, 'harness.example.ts');
const workRoot = mkdtempSync(join(tmpdir(), 'kotlin-harness-test-'));
const classes = join(workRoot, 'classes');
after(() => rmSync(workRoot, { recursive: true, force: true }));

function runCompare(args: string[]) {
  const res = spawnSync(process.execPath, [COMPARE, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 300000 });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function runJson(args: string[]) {
  const res = runCompare([...args, '--json']);
  assert.equal(res.code, 0, res.stderr + res.stdout);
  return JSON.parse(res.stdout) as {
    ok: boolean;
    kotlin: { path: string; bytes: number; sha256: string; runs: number };
    ts: { path: string; bytes: number; sha256: string; runs: number };
    diffs: Array<{ path: string; kind: string; kotlin: string; ts: string }>;
    comparedNodes: number;
  };
}

function writeVariant(name: string, replaceFrom: string, replaceTo: string): string {
  const source = readFileSync(EXAMPLE, 'utf8');
  assert.ok(source.includes(replaceFrom), 'fixture 锚点缺失：' + name);
  const target = join(workRoot, name);
  writeFileSync(target, source.split(replaceFrom).join(replaceTo), 'utf8');
  return target;
}

test('一致：模板 Kotlin 与 TS 镜像逐字段一致（Float raw bits / Long BigInt），golden 逐字节相同', () => {
  const out = join(workRoot, 'out-consistent');
  const report = runJson(['--ts', EXAMPLE, '--classes', classes, '--out', out]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.diffs, []);
  assert.ok(report.comparedNodes > 30, '节点数应覆盖整个输出：' + report.comparedNodes);
  assert.equal(report.kotlin.runs, 2);
  assert.equal(report.ts.runs, 2);
  assert.equal(report.kotlin.sha256, report.ts.sha256, '示例两边输出应逐字节相同');
  assert.equal(readFileSync(join(out, 'golden.kotlin.json'), 'utf8'), readFileSync(join(out, 'golden.ts.json'), 'utf8'));
});

test('不一致：TS 用 Math.round 冒充 ties-to-even → exit 1，报 rounding 路径', () => {
  const bad = writeVariant('bad-round.mjs', 'function halfEven(x) {\n  return BigInt(roundHalfEven(x));\n}', 'function halfEven(x) {\n  return BigInt(Math.round(x));\n}');
  const res = runCompare(['--ts', bad, '--classes', classes]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /DIFFS: [1-9]/);
  assert.match(res.stdout, /rounding\[0\]\.halfEven/);
  assert.match(res.stdout, /rounding\[2\]\.halfEven/);
  const report = JSON.parse(runCompare(['--ts', bad, '--classes', classes, '--json']).stdout);
  assert.equal(report.ok, false);
  assert.ok(report.diffs.some((diff) => diff.path === 'rounding[0].halfEven' && diff.kind === 'value'));
});

test('不一致：Float 编码缺失（f32 变普通 number）→ kind=type', () => {
  const bad = writeVariant('bad-float.mjs', 'scaled: f32(est.scaled),', 'scaled: est.scaled,');
  const res = runCompare(['--ts', bad, '--classes', classes]);
  assert.equal(res.code, 1);
  const report = JSON.parse(runCompare(['--ts', bad, '--classes', classes, '--json']).stdout);
  const diff = report.diffs.find((item) => item.path === 'scenarios[0].scaled');
  assert.ok(diff, '应报 scenarios[0].scaled：' + JSON.stringify(report.diffs.slice(0, 5)));
  assert.equal(diff.kind, 'type');
  assert.match(diff.kotlin, /f32\(bits=/);
});

test('不一致：Long 编码缺失（i64 变 number）→ kind=type', () => {
  const bad = writeVariant('bad-long.mjs', 'chars: i64(chars),', 'chars: Number(chars),');
  const res = runCompare(['--ts', bad, '--classes', classes]);
  assert.equal(res.code, 1);
  const report = JSON.parse(runCompare(['--ts', bad, '--classes', classes, '--json']).stdout);
  const diff = report.diffs.find((item) => item.path === 'scenarios[0].chars');
  assert.ok(diff, '应报 scenarios[0].chars');
  assert.equal(diff.kind, 'type');
});

test('确定性：同参数跑两次，compare 输出与 golden 逐字节相同；--classes 复用编译产物', () => {
  const first = runCompare(['--ts', EXAMPLE, '--classes', classes, '--json']);
  const second = runCompare(['--ts', EXAMPLE, '--classes', classes, '--json']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(first.stdout, second.stdout, '两次 --json 输出必须逐字节相同');
  const out1 = join(workRoot, 'det1');
  const out2 = join(workRoot, 'det2');
  runCompare(['--ts', EXAMPLE, '--classes', classes, '--out', out1]);
  runCompare(['--ts', EXAMPLE, '--classes', classes, '--out', out2]);
  assert.equal(readFileSync(join(out1, 'golden.kotlin.json'), 'utf8'), readFileSync(join(out2, 'golden.kotlin.json'), 'utf8'));
  assert.ok(existsSync(join(classes, 'HarnessKt.class')), '--classes 目录应已有编译产物');
});

test('Kotlin 与 TS 各自单跑两次也逐字节相同', () => {
  const kotlinA = spawnSync('kotlin', ['-cp', classes, 'HarnessKt'], { encoding: 'utf8' });
  const kotlinB = spawnSync('kotlin', ['-cp', classes, 'HarnessKt'], { encoding: 'utf8' });
  assert.equal(kotlinA.status, 0, kotlinA.stderr);
  assert.equal(kotlinA.stdout, kotlinB.stdout);
  const tsA = spawnSync(process.execPath, [EXAMPLE], { encoding: 'utf8' });
  const tsB = spawnSync(process.execPath, [EXAMPLE], { encoding: 'utf8' });
  assert.equal(tsA.status, 0, tsA.stderr);
  assert.equal(tsA.stdout, tsB.stdout);
});

test('用法错误 exit 2：缺 --ts / --ts 不存在 / --kotlin 不存在', () => {
  const cases: string[][] = [
    [],
    ['--ts', join(workRoot, 'no-such.mjs')],
    ['--ts', EXAMPLE, '--kotlin', join(workRoot, 'no-such.kt')],
  ];
  for (const args of cases) {
    const res = runCompare(args);
    assert.equal(res.code, 2, '应 exit 2：' + args.join(' '));
    assert.match(res.stderr, /compare: /);
  }
});

test('模板 harness.kt 本身可编译（classes 已生成）', () => {
  assert.ok(existsSync(HARNESS));
  assert.ok(existsSync(join(classes, 'HarnessKt.class')));
});
