import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测 cli/verify-fidelity.ts：NO_ITEMS 与 mismatch 的区分、场景全等、JSON 兼容字段。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(repoRoot, 'cli', 'verify-fidelity.ts');

interface TestHooks {
  after(fn: () => void): void;
}

function makeTmp(t: TestHooks): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-fidelity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function putJson(dir: string, name: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function runFidelity(args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface FidelityReport {
  totalItems: number;
  sameItems: number;
  fidelityPct: number | null;
  sameScenarios: number;
  totalScenarios: number;
  missingScenarios: number;
  noItems: boolean;
  verdict: string;
  pass: boolean;
  details: Array<Record<string, unknown>>;
}

function runReport(golden: string, actual: string, extra: string[] = []) {
  const res = runFidelity(['--golden', golden, '--actual', actual, '--json', ...extra]);
  let report: FidelityReport | null = null;
  try {
    report = JSON.parse(res.stdout) as FidelityReport;
  } catch {
    report = null;
  }
  return { res, report };
}

test('items 全等：exit 0、fidelityPct=100、verdict=PASS（不出现 NO_ITEMS）', (t) => {
  const dir = makeTmp(t);
  const golden = putJson(dir, 'golden.json', [{ scenario: 's1', pages: [{ text: 'a' }, { text: 'b' }] }]);
  const actual = putJson(dir, 'actual.json', [{ scenario: 's1', pages: [{ text: 'a' }, { text: 'b' }] }]);
  const human = runFidelity(['--golden', golden, '--actual', actual]);
  const { res, report } = runReport(golden, actual);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /保真度: 100%/);
  assert.ok(report !== null);
  assert.equal(report!.totalItems, 2);
  assert.equal(report!.fidelityPct, 100);
  assert.equal(report!.noItems, false);
  assert.equal(report!.verdict, 'PASS');
  assert.equal(report!.pass, true);
});

test('items 不一致：exit 1、verdict=FAIL，仍打印具体差异', (t) => {
  const dir = makeTmp(t);
  const golden = putJson(dir, 'golden.json', [{ scenario: 's1', pages: [{ text: 'a' }, { text: 'b' }] }]);
  const actual = putJson(dir, 'actual.json', [{ scenario: 's1', pages: [{ text: 'a' }, { text: 'X' }] }]);
  const human = runFidelity(['--golden', golden, '--actual', actual]);
  const { res, report } = runReport(golden, actual);
  assert.equal(res.code, 1);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /门禁: FAIL/);
  assert.match(human.stdout, /DIFF s1/);
  assert.ok(report !== null);
  assert.equal(report!.noItems, false);
  assert.equal(report!.verdict, 'FAIL');
  assert.equal(report!.pass, false);
  assert.equal(report!.totalItems, 2);
  assert.equal(report!.sameItems, 1);
  assert.equal(report!.fidelityPct, 50);
});

test('totalItems=0 且场景全等：NO_ITEMS → exit 0、输出 N/A 而不是误导的 0%', (t) => {
  const dir = makeTmp(t);
  const golden = putJson(dir, 'golden.json', [{ scenario: 's1', pages: [] }, { scenario: 's2', pages: [] }]);
  const actual = putJson(dir, 'actual.json', [{ scenario: 's1', pages: [] }, { scenario: 's2', pages: [] }]);
  const human = runFidelity(['--golden', golden, '--actual', actual]);
  const { res, report } = runReport(golden, actual);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /保真度: N\/A（0 items 可比较）/);
  assert.match(human.stdout, /警告: NO_ITEMS/);
  assert.equal(human.stdout.includes('保真度: 0%'), false, '不应打印误导的 0%');
  assert.match(human.stdout, /门禁: PASS（NO_ITEMS/);
  assert.ok(report !== null);
  assert.equal(report!.noItems, true);
  assert.equal(report!.verdict, 'NO_ITEMS');
  assert.equal(report!.pass, true);
  assert.equal(report!.totalItems, 0);
  assert.equal(report!.fidelityPct, null);
  assert.equal(report!.sameScenarios, 2);
  assert.equal(report!.totalScenarios, 2);
});

test('totalItems=0 但有缺失场景：NO_ITEMS 不能掩盖 mismatch → exit 1、verdict=FAIL', (t) => {
  const dir = makeTmp(t);
  const golden = putJson(dir, 'golden.json', [{ scenario: 's1', pages: [] }, { scenario: 's2', pages: [] }]);
  const actual = putJson(dir, 'actual.json', [{ scenario: 's1', pages: [] }]);
  const human = runFidelity(['--golden', golden, '--actual', actual]);
  const { res, report } = runReport(golden, actual);
  assert.equal(res.code, 1);
  assert.equal(human.code, 1);
  assert.equal(human.stdout.includes('保真度: 0%'), false, '不应打印误导的 0%');
  assert.match(human.stdout, /MISSING s2/);
  assert.match(human.stdout, /门禁: FAIL/);
  assert.ok(report !== null);
  assert.equal(report!.noItems, true);
  assert.equal(report!.verdict, 'FAIL');
  assert.equal(report!.pass, false);
  assert.equal(report!.missingScenarios, 1);
});

test('--json 保留原有字段（totalItems/sameItems/fidelityPct/sameScenarios/details/pass）', (t) => {
  const dir = makeTmp(t);
  const golden = putJson(dir, 'golden.json', [{ scenario: 's1', pages: [{ text: 'a' }] }]);
  const actual = putJson(dir, 'actual.json', [{ scenario: 's1', pages: [{ text: 'a' }] }]);
  const { res, report } = runReport(golden, actual);
  assert.equal(res.code, 0);
  for (const key of ['totalItems', 'sameItems', 'fidelityPct', 'sameScenarios', 'totalScenarios', 'missingScenarios', 'pass', 'details', 'noItems', 'verdict']) {
    assert.ok(report !== null && Object.prototype.hasOwnProperty.call(report, key), '缺少字段 ' + key);
  }
});

test('自定义 --key/--items/--field 仍生效', (t) => {
  const dir = makeTmp(t);
  const golden = putJson(dir, 'golden.json', [{ name: 'case-a', results: [{ value: 1 }, { value: 2 }] }]);
  const actual = putJson(dir, 'actual.json', [{ name: 'case-a', results: [{ value: 1 }, { value: 2 }] }]);
  const { res, report } = runReport(golden, actual, ['--key', 'name', '--items', 'results', '--field', 'value']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(report!.totalItems, 2);
  assert.equal(report!.fidelityPct, 100);
});
