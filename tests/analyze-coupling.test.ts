import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 直接测仓库里的 cli/analyze-coupling.ts（读真实的 adapters/languages.json 口径）。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'cli', 'analyze-coupling.ts');

interface TestHooks {
  after(fn: () => void): void;
}

function makeTmp(t: TestHooks, prefix = 'arkts-analyze-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function runAnalyze(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function analyzeJson(root: string, extra: string[] = []) {
  const res = runAnalyze(['--root', root, '--json', ...extra], root);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout) as {
    files: number;
    totalLoc: number;
    coupledFiles: number;
    coupledLoc: number;
    dts: { files: number; loc: number };
    dataOnly: { files: number; loc: number };
    unaudited: { files: number; loc: number };
    autoConvertibleLoc: number;
    autoConvertiblePct: number;
    verdict: string;
    largestPureFiles: Array<{ path: string; loc: number; lang: string }>;
  };
}

/** analyze-coupling 的行数口径：src.split('\n').length（文件末尾换行会让它比物理行多 1）。 */
function loc(src: string): number {
  return src.split('\n').length;
}

// ---------------------------------------------------------------------------
// platformPatterns：框架 / 资源 / 浏览器 API
// ---------------------------------------------------------------------------

test('js-ts：vue/pinia/vue-router/element-plus/@vue/axios/vite import 都判为耦合', (t) => {
  const dir = makeTmp(t);
  const files: Array<[string, string]> = [
    ['src/useRef.ts', 'import { ref } from "vue";\nexport const count = ref(0);\n'],
    ['src/store.ts', 'import { defineStore } from "pinia";\nexport const useStore = defineStore("s", {});\n'],
    ['src/router.ts', 'import { createRouter } from "vue-router";\nexport const router = createRouter({});\n'],
    ['src/plus.ts', 'import { ElButton } from "element-plus";\nexport const button = ElButton;\n'],
    ['src/atvue.ts', 'import { useI18n } from "@vue/runtime-core";\nexport const i18n = useI18n;\n'],
    ['src/http.ts', 'import axios from "axios";\nexport const http = axios;\n'],
    ['src/vite.ts', 'import { defineConfig } from "vite";\nexport default defineConfig({});\n'],
  ];
  for (const [rel, src] of files) put(dir, rel, src);
  const json = analyzeJson(dir);
  assert.equal(json.files, files.length);
  assert.equal(json.coupledFiles, files.length, '每条框架 import 都要命中');
  assert.equal(json.autoConvertibleLoc, 0);
  assert.equal(json.autoConvertiblePct, 0);
  assert.deepEqual(json.dts, { files: 0, loc: 0 });
});

test('js-ts：资源 import（css/scss/less/png/svg/vue，含 ?raw 等后缀）判为耦合', (t) => {
  const dir = makeTmp(t);
  const files: Array<[string, string]> = [
    ['src/styles.ts', 'import "./a.css";\nimport "./b.scss";\nimport "./c.less?inline";\n'],
    ['src/images.ts', 'import logo from "./logo.png";\nimport icon from "./icon.svg?raw";\nimport photo from "./photo.jpg?url";\n'],
    ['src/view.ts', 'import Comp from "./Comp.vue";\nexport const view = Comp;\n'],
  ];
  for (const [rel, src] of files) put(dir, rel, src);
  const json = analyzeJson(dir);
  assert.equal(json.coupledFiles, files.length, '资源 import 必须命中（无 from 的副作用 import 也算）');
  assert.equal(json.autoConvertibleLoc, 0);
});

test('js-ts：WebSocket/FileReader/IntersectionObserver 等浏览器 API 判为耦合', (t) => {
  const dir = makeTmp(t);
  const files: Array<[string, string]> = [
    ['src/ws.ts', 'export const socket = new WebSocket("ws://localhost");\n'],
    ['src/reader.ts', 'export function read(file: File) { return new FileReader(); }\n'],
    ['src/observer.ts', 'export const io = new IntersectionObserver(() => {}, {});\n'],
    ['src/dom.ts', 'export const el = document.getElementById("app");\nexport const href = location.href;\n'],
  ];
  for (const [rel, src] of files) put(dir, rel, src);
  const json = analyzeJson(dir);
  assert.equal(json.coupledFiles, files.length);
  assert.equal(json.autoConvertibleLoc, 0);
});

test('js-ts：纯逻辑不误伤（相对 import / 函数 / 箭头函数都仍是可自动转写）', (t) => {
  const dir = makeTmp(t);
  const logic = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
  const arrow = 'import { helper } from "./helper";\nexport const run = (x: number) => helper(x);\n';
  put(dir, 'src/logic.ts', logic);
  put(dir, 'src/arrow.ts', arrow);
  put(dir, 'src/helper.ts', 'export const helper = (x: number) => x * 2;\n');
  const json = analyzeJson(dir);
  assert.equal(json.coupledFiles, 0);
  assert.deepEqual(json.dts, { files: 0, loc: 0 });
  assert.deepEqual(json.dataOnly, { files: 0, loc: 0 });
  assert.equal(json.autoConvertibleLoc, loc(logic) + loc(arrow) + loc('export const helper = (x: number) => x * 2;\n'));
  assert.equal(json.autoConvertiblePct, 100);
  assert.equal(json.verdict, 'high');
});

// ---------------------------------------------------------------------------
// .d.ts：单列 dts，不计入可自动转写
// ---------------------------------------------------------------------------

test('js-ts：.d.ts 单列 dts，即使 import vue 也不算耦合/可自动', (t) => {
  const dir = makeTmp(t);
  const dts = 'import type { Ref } from "vue";\nexport interface Box {\n  value: number;\n}\n';
  const logic = 'export const twice = (x: number) => x * 2;\n';
  put(dir, 'src/types.d.ts', dts);
  put(dir, 'src/env.d.ts', '/// <reference types="vite/client" />\n');
  put(dir, 'src/logic.ts', logic);
  const json = analyzeJson(dir);
  assert.equal(json.files, 3);
  assert.deepEqual(json.dts, { files: 2, loc: loc(dts) + loc('/// <reference types="vite/client" />\n') });
  assert.equal(json.coupledFiles, 0, '.d.ts 不能因为 import vue 就被算成耦合');
  assert.equal(json.autoConvertibleLoc, loc(logic), '.d.ts 不能计入可自动转写');
  assert.deepEqual(json.dataOnly, { files: 0, loc: 0 });
  assert.deepEqual(json.largestPureFiles.map((f) => f.path), ['src/logic.ts'], '纯逻辑候选里不能出现 .d.ts');
});

// ---------------------------------------------------------------------------
// 纯数据配置：单列 dataOnly，不计入可自动转写
// ---------------------------------------------------------------------------

test('js-ts：纯数据配置单列 dataOnly；带函数的配置不算', (t) => {
  const dir = makeTmp(t);
  const data = "export default {\n  fields: [\n    { key: 'name', type: 'String' },\n  ],\n};\n";
  const configWithFn = 'export default {\n  format: (x: number) => String(x),\n};\n';
  const logic = 'export function sum(a: number, b: number): number {\n  return a + b;\n}\n';
  put(dir, 'src/bookSourceEditConfig.ts', data);
  put(dir, 'src/themeConfig.ts', configWithFn);
  put(dir, 'src/logic.ts', logic);
  const json = analyzeJson(dir);
  assert.deepEqual(json.dataOnly, { files: 1, loc: loc(data) });
  assert.equal(json.coupledFiles, 0);
  assert.equal(json.autoConvertibleLoc, loc(configWithFn) + loc(logic), '带函数的配置仍算可自动转写');
  assert.deepEqual(json.unaudited, { files: 1, loc: loc(data) });
  assert.deepEqual(json.largestPureFiles.map((f) => f.path).sort(), ['src/logic.ts', 'src/themeConfig.ts']);
});

// ---------------------------------------------------------------------------
// 人类摘要 / JSON 字段
// ---------------------------------------------------------------------------

test('人类摘要说明 .d.ts 与纯数据配置单列；--json 有 dts 字段', (t) => {
  const dir = makeTmp(t);
  put(dir, 'src/types.d.ts', 'export interface A {\n  x: number;\n}\n');
  put(dir, 'src/config.ts', "export default {\n  a: 1,\n};\n");
  put(dir, 'src/logic.ts', 'export const one = 1;\n');
  const res = runAnalyze(['--root', dir], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /类型声明 \.d\.ts 1 个文件 \/ \d+ 行（无运行时代码，不计入可自动转写）/);
  assert.match(res.stdout, /纯数据配置 1 个文件 \/ \d+ 行（无 import\/函数\/控制流，不计入可自动转写）/);
  assert.match(res.stdout, /可自动转写 \d+ 行 = [\d.]+% {2}\[(?:low|medium|high)\]（分母 = 全部 \d+ 行；已扣除耦合\/\.d\.ts\/纯数据）/);

  const json = analyzeJson(dir);
  assert.equal(json.dts.files, 1);
  assert.equal(json.dataOnly.files, 1);
  assert.equal(json.unaudited.files, 2);
  assert.equal(json.autoConvertibleLoc, loc('export const one = 1;\n'));
});

// ---------------------------------------------------------------------------
// 其它语言回归：jvm 口径不变（dts / dataOnly 恒为 0）
// ---------------------------------------------------------------------------

test('jvm 回归：dts/dataOnly/unaudited 恒为 0，耦合口径与旧版一致', (t) => {
  const dir = makeTmp(t);
  const android = 'package demo\n\nimport android.app.Activity\n\nclass MainActivity : Activity()\n';
  const logic = 'package demo\n\nfun add(a: Int, b: Int): Int = a + b\n';
  put(dir, 'app/src/main/java/demo/MainActivity.kt', android);
  put(dir, 'app/src/main/java/demo/Logic.kt', logic);
  const json = analyzeJson(dir, ['--lang', 'jvm']);
  assert.equal(json.files, 2);
  assert.deepEqual(json.dts, { files: 0, loc: 0 });
  assert.deepEqual(json.dataOnly, { files: 0, loc: 0 });
  assert.deepEqual(json.unaudited, { files: 0, loc: 0 });
  assert.equal(json.coupledFiles, 1, 'android import 仍判耦合');
  assert.equal(json.autoConvertibleLoc, loc(logic));
  assert.equal(json.autoConvertiblePct, Math.round(loc(logic) * 1000 / (loc(android) + loc(logic))) / 10);
});

test('--help：列出 --json 的实际字段与取值（autoConvertiblePct/totalLoc/verdict/files 等）', () => {
  const res = runAnalyze(['--help'], repoRoot);
  assert.equal(res.code, 0, res.stderr);
  const help = res.stdout;
  // 参数
  for (const flag of ['--root', '--lang', '--top', '--json', '--list-langs', '--help']) {
    assert.ok(help.includes(flag), 'help 应包含参数 ' + flag);
  }
  // JSON 字段（实际形状）
  for (const field of [
    'root', 'languages', 'files', 'totalLoc', 'coupledFiles', 'coupledLoc',
    'dts', 'dataOnly', 'unaudited', 'autoConvertibleLoc', 'autoConvertiblePct', 'verdict',
    'perLanguage', 'topModules', 'largestPureFiles',
  ]) {
    assert.ok(help.includes(field), 'help 应包含 JSON 字段 ' + field);
  }
  assert.ok(help.includes('high') && help.includes('medium') && help.includes('low'), 'help 应说明 verdict 取值');
});
