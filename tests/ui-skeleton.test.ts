import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const toolPath = join(repoRoot, 'cli', 'ui-skeleton.ts');
const rulesPath = join(repoRoot, 'rules', 'ui-mapping.json');

interface TestHooks {
  after(fn: () => void): void;
}

interface Report {
  ok: boolean;
  src: string;
  out: string;
  dryRun: boolean;
  composable: string;
  struct: string;
  components: string[];
  mapped: string[];
  unmapped: string[];
  manualPoints: string[];
  state: { count: number; renamed: Array<{ from: string; to: string }> };
  coverage: { nodes: number; mappedNodes: number; unmappedNodes: number; pct: number };
  rules: { version: number; sha256: string };
  sha256: string;
  mappingSha256: string;
  sourceLines: number;
  generatedLines: number;
  files: { ets?: string; md?: string };
}

function makeTmp(t: TestHooks): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-port-ui-skeleton-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runTool(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [toolPath, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function writeText(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function reportOf(stdout: string): Report {
  return JSON.parse(stdout) as Report;
}

const ABOUT_KT = [
  'package demo.about',
  '',
  'import androidx.compose.runtime.Composable',
  'import androidx.compose.runtime.LaunchedEffect',
  'import androidx.compose.runtime.getValue',
  'import androidx.compose.runtime.mutableStateOf',
  'import androidx.compose.runtime.remember',
  'import androidx.compose.runtime.setValue',
  '',
  '@Composable',
  'private fun DemoAboutScreen(state: Int) {',
  '    var enabled by remember { mutableStateOf(true) }',
  '    LaunchedEffect(state) {',
  '        if (state == 0) enabled = false',
  '    }',
  '    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {',
  '        AppText(text = stringResource(R.string.app_name), fontSize = 18.sp)',
  '        Image(painter = painterResource(R.drawable.logo), contentDescription = null)',
  '        TextCard(text = "v1")',
  '        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {',
  '            Button(onClick = {}) {',
  '                Text("OK")',
  '            }',
  '            FilledTonalIconButton(onClick = {}) {',
  '                Icon(Icons.Default.MoreVert, null)',
  '            }',
  '        }',
  '        SettingItem(title = stringResource(R.string.settings), onClick = {})',
  '    }',
  '}',
  '',
].join('\n');

const LIST_KT = [
  'package demo.list',
  '',
  '@Composable',
  'fun DemoListPage(items: List<String>) {',
  '    val sources = remember(items) { items.distinctBy { it } }',
  '    LazyColumn(modifier = Modifier.fillMaxWidth()) {',
  '        items(sources) { item ->',
  '            SelectionItemCard(title = item, subtitle = "n modules", onClick = {})',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

const FORM_KT = [
  'package demo.form',
  '',
  '@Composable',
  'fun DemoFormSheet(onSave: (String) -> Unit) {',
  '    var title by remember { mutableStateOf("") }',
  '    var pattern by remember { mutableStateOf("") }',
  '    var enabled by remember { mutableStateOf(true) }',
  '    var showMenu by remember { mutableStateOf(false) }',
  '    AppModalBottomSheet(title = "Demo") {',
  '        Column(modifier = Modifier.padding(16.dp)) {',
  '            AppTextField(value = title, onValueChange = { title = it }, label = "Title")',
  '            AppTextField(value = pattern, onValueChange = { pattern = it }, label = "Pattern")',
  '            Row {',
  '                AppText(text = "启用")',
  '                AdaptiveSwitch(checked = enabled, onCheckedChange = { enabled = it })',
  '            }',
  '            Button(onClick = { onSave(title) }) {',
  '                Text("保存")',
  '            }',
  '            RoundDropdownMenu(expanded = showMenu) { }',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

const SAFE_KT = [
  'package demo.safe',
  '',
  '@Composable',
  'fun DemoSafeScreen() {',
  '    var enabled by remember { mutableStateOf(true) }',
  '    LaunchedEffect(Unit) {',
  '        enabled = true',
  '    }',
  '    Column(',
  '        modifier = Modifier',
  '            .fillMaxSize()',
  '            .verticalScroll(rememberScrollState())',
  '    ) {',
  '        Spacer(modifier = Modifier.height(8.dp))',
  '        Text(',
  '            text = "Hi",',
  '            fontSize = 18.sp,',
  '            fontWeight = FontWeight.Bold,',
  '            textAlign = TextAlign.Center,',
  '            fontColor = Color.White,',
  '            modifier = Modifier.fillMaxWidth()',
  '        )',
  '        Button(onClick = { }) {',
  '            Text("OK")',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

function fixture(t: TestHooks, name: string, kt: string): { src: string; out: string } {
  const root = makeTmp(t);
  const src = join(root, 'case', name + '.kt');
  writeText(src, kt);
  return { src, out: join(root, 'out-' + name) };
}

test('--help：包含 --src/--out/--json/--md/--dry-run，exit 0', () => {
  const res = runTool(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /node cli\/ui-skeleton\.ts/);
  for (const flag of ['--src', '--out', '--json', '--md', '--dry-run']) {
    assert.ok(res.stdout.includes(flag), '--help 应包含 ' + flag);
  }
});

test('用法错误一律 exit 2（缺参数/坏路径/非 .kt/out 在源目录内/未知参数）', (t) => {
  const dir = makeTmp(t);
  const src = join(dir, 'case', 'A.kt');
  writeText(src, ABOUT_KT);
  const notKt = join(dir, 'case', 'a.txt');
  writeText(notKt, 'x');
  const cases: string[][] = [
    [],
    ['--src', src],
    ['--out', join(dir, 'out')],
    ['--src', join(dir, 'missing.kt'), '--out', join(dir, 'out')],
    ['--src', notKt, '--out', join(dir, 'out')],
    ['--src', src, '--out', join(dir, 'case', 'out')],
    ['--bogus'],
    ['--src', src, '--out', join(dir, 'out'), '--timeout', '1'],
  ];
  for (const args of cases) {
    const res = runTool(args);
    assert.equal(res.code, 2, '应 exit 2：' + JSON.stringify(args) + '\n' + res.stdout + res.stderr);
    assert.match(res.stderr, /ui-skeleton: /);
  }
});

test('About 类 fixture：生成 .ets + mapping，@State/保留字/未映射/指标齐全', (t) => {
  const { src, out } = fixture(t, 'about', ABOUT_KT);
  const res = runTool(['--src', src, '--out', out, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, false);
  assert.equal(report.composable, 'DemoAboutScreen');
  assert.deepEqual(report.rules.version, 3);
  assert.match(report.rules.sha256, /^[0-9a-f]{64}$/);
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  assert.ok(report.coverage.nodes > 0);
  assert.ok(report.coverage.pct > 0 && report.coverage.pct <= 100);
  assert.ok(report.mapped.includes('Column'));
  assert.ok(report.mapped.includes('AppText'));
  assert.ok(report.unmapped.includes('TextCard'));
  assert.ok(report.unmapped.includes('SettingItem'));
  assert.ok(report.manualPoints.length > 0);
  assert.ok(report.state.renamed.some((entry) => entry.from === 'enabled' && entry.to === 'ruleEnabled'));
  assert.ok(report.stubs.length > 0, '未映射组件应生成 stub 记录');
  assert.ok(report.stubLines > 0);
  assert.ok(report.manualLinesEstimate > 0);
  assert.equal(report.compileFixLinesEstimate, 0);

  const etsPath = join(out, report.struct + '.ets');
  const mdPath = join(out, 'mapping.md');
  assert.ok(existsSync(etsPath), '应生成 ' + etsPath);
  assert.ok(existsSync(mdPath), '应生成 mapping.md');
  assert.ok(String(report.files.ets).endsWith('.ets'));
  const ets = readFileSync(etsPath, 'utf8');
  assert.match(ets, /struct DemoAboutScreen/);
  assert.match(ets, /@State ruleEnabled: boolean = true/);
  assert.match(ets, /aboutToAppear\(\): void/);
  assert.match(ets, /TODO\(ui-skeleton\): LaunchedEffect/);
  assert.match(ets, /Text\(/);
  assert.match(ets, /Image\(/);
  assert.match(ets, /Button\(/);
  assert.match(ets, /Column\(\) \{/);
  assert.match(ets, /@Builder/);
  assert.match(ets, /this\.StubTextCard\(\)/);
  assert.match(ets, /this\.StubSettingItem\(\)/);
  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /# UI 骨架映射/);
  assert.match(md, /## 未映射组件/);
  assert.match(md, /## 人工点/);
  assert.match(md, /rules\/ui-mapping\.json version=3 sha256=/);
});

test('List 类 fixture：LazyColumn → List，SelectionItemCard 计入未映射', (t) => {
  const { src, out } = fixture(t, 'list', LIST_KT);
  const res = runTool(['--src', src, '--out', out, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  assert.ok(report.mapped.includes('LazyColumn'));
  assert.ok(report.unmapped.includes('SelectionItemCard'));
  const ets = readFileSync(join(out, report.struct + '.ets'), 'utf8');
  assert.match(ets, /List\(\) \{/);
  assert.match(ets, /ForEach\(this\.items/);
  assert.match(ets, /@State items: string\[\]/);
  assert.ok(report.safeRules.some((rule: { id: string; count: number }) => rule.id === 'lazyItems' && rule.count > 0));
  assert.match(String(report.coverage.pct), /^\d+(\.\d)?$/);
});

test('Form 类 fixture：TextInput/TextArea 绑定 @State，Toggle 用重命名后的布尔 state，菜单未映射', (t) => {
  const { src, out } = fixture(t, 'form', FORM_KT);
  const res = runTool(['--src', src, '--out', out, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  assert.equal(report.state.count, 4);
  assert.ok(report.unmapped.includes('RoundDropdownMenu'));
  assert.ok(report.mapped.includes('AppTextField'));
  assert.ok(report.mapped.includes('AdaptiveSwitch'));
  const ets = readFileSync(join(out, report.struct + '.ets'), 'utf8');
  assert.match(ets, /@State ruleEnabled: boolean = true/);
  assert.match(ets, /TextInput\(\{ placeholder: 'Title', text: this\.title \}\)/);
  assert.match(ets, /TextInput\(\{ placeholder: 'Pattern', text: this\.pattern \}\)/);
  assert.match(ets, /Toggle\(\{ type: ToggleType\.Switch, isOn: this\.ruleEnabled \}\)/);
  assert.doesNotMatch(ets, /@State enabled/);
});

test('--dry-run：不写任何文件，仍返回指标与 sha256', (t) => {
  const { src, out } = fixture(t, 'dry', FORM_KT);
  const res = runTool(['--src', src, '--out', out, '--dry-run', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.files, {});
  assert.equal(existsSync(out), false);
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
});

test('--md：把 mapping.md 打到 stdout（同时也写文件）', (t) => {
  const { src, out } = fixture(t, 'md', LIST_KT);
  const res = runTool(['--src', src, '--out', out, '--md']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /# UI 骨架映射/);
  assert.ok(existsSync(join(out, 'mapping.md')));
});

test('确定性：同输入两次运行，.ets/mapping.md 逐字节相同，JSON 相同', (t) => {
  const { src, out } = fixture(t, 'det', FORM_KT);
  const first = runTool(['--src', src, '--out', out, '--json']);
  assert.equal(first.code, 0);
  const report = reportOf(first.stdout);
  const ets1 = readFileSync(join(out, report.struct + '.ets'), 'utf8');
  const md1 = readFileSync(join(out, 'mapping.md'), 'utf8');
  const second = runTool(['--src', src, '--out', out, '--json']);
  assert.equal(second.code, 0);
  assert.equal(second.stdout, first.stdout, '同参数两次 JSON 应逐字节相同');
  assert.equal(readFileSync(join(out, report.struct + '.ets'), 'utf8'), ets1);
  assert.equal(readFileSync(join(out, 'mapping.md'), 'utf8'), md1);
});

test('无 @Composable / 无白名单组件 → exit 1', (t) => {
  const dir = makeTmp(t);
  const plain = join(dir, 'case', 'Plain.kt');
  writeText(plain, 'fun helper() = 1\n');
  const noWhitelist = join(dir, 'case', 'Empty.kt');
  writeText(noWhitelist, '@Composable\nfun Empty() { TextCard(text = "x") }\n');
  const first = runTool(['--src', plain, '--out', join(dir, 'out1')]);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /Composable/);
  const second = runTool(['--src', noWhitelist, '--out', join(dir, 'out2')]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /白名单/);
});

test('rules/ui-mapping.json：version=3，sha256 与 payload 自洽', () => {
  const raw = JSON.parse(readFileSync(rulesPath, 'utf8')) as Record<string, unknown>;
  assert.equal(raw.version, 3);
  const payload = {
    version: raw.version,
    components: raw.components,
    containers: raw.containers,
    modifiers: raw.modifiers,
    safeRules: raw.safeRules,
    excludedRules: raw.excludedRules,
    weightMap: raw.weightMap,
    alignMap: raw.alignMap,
    colorMap: raw.colorMap,
    reserved: raw.reserved,
    rename: raw.rename,
    unmappedKnown: raw.unmappedKnown,
    stubCosts: raw.stubCosts,
    stubLinesPerComponent: raw.stubLinesPerComponent,
    manualRules: raw.manualRules,
  };
  const sha = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  assert.equal(raw.sha256, sha);
  assert.match(String(raw.sha256), /^[0-9a-f]{64}$/);
});

function relativeOf(path: string): string {
  const rel = path.startsWith(repoRoot + '/') ? path.slice(repoRoot.length + 1) : path;
  return rel;
}

test('stub：未映射组件生成 @Builder 占位并计入 manualLinesEstimate', (t) => {
  const { src, out } = fixture(t, 'stub', ABOUT_KT);
  const res = runTool(['--src', src, '--out', out, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  const stubNames = report.stubs.map((entry: { component: string; stub: string }) => entry.stub);
  assert.ok(stubNames.includes('StubTextCard'));
  assert.ok(stubNames.includes('StubSettingItem'));
  assert.ok(stubNames.includes('StubIcon'));
  const ets = readFileSync(join(out, report.struct + '.ets'), 'utf8');
  for (const stub of stubNames) {
    assert.match(ets, new RegExp('@Builder\\s+' + stub + '\\(\\)'));
  }
  assert.match(ets, /\[stub\] TextCard/);
  assert.match(ets, /非真实 UI/);
});

interface CopyFixture {
  copy: string;
  src: string;
}

function makeCopyFixture(t: TestHooks): CopyFixture {
  const root = makeTmp(t);
  const copy = join(root, 'project');
  const pages = join(copy, 'entry', 'src', 'main', 'ets', 'pages');
  const profile = join(copy, 'entry', 'src', 'main', 'resources', 'base', 'profile');
  mkdirSync(pages, { recursive: true });
  mkdirSync(profile, { recursive: true });
  writeText(join(copy, 'build-profile.json5'), '{}\n');
  writeText(join(profile, 'main_pages.json'), JSON.stringify({ src: ['pages/Index'] }, null, 2) + '\n');
  const src = join(root, 'case', 'Form.kt');
  writeText(src, FORM_KT);
  return { copy, src };
}

test('--integrate：注入 .ets + 路由到工程副本，默认 out 在副本内，重跑不重复加路由', (t) => {
  const { copy, src } = makeCopyFixture(t);
  const first = runTool(['--src', src, '--integrate', copy, '--json']);
  assert.equal(first.code, 0, first.stderr);
  const report = reportOf(first.stdout);
  assert.equal(report.integration.enabled, true);
  assert.equal(report.integration.routeAdded, true);
  const pageFile = join(copy, report.integration.page);
  assert.ok(existsSync(pageFile), '副本应注入页面 ' + pageFile);
  const pagesJson = JSON.parse(readFileSync(join(copy, 'entry/src/main/resources/base/profile/main_pages.json'), 'utf8')) as { src: string[] };
  assert.ok(pagesJson.src.includes(report.integration.route));
  assert.ok(existsSync(join(copy, 'ui-skeleton-out', 'mapping.md')), '默认 out 应在副本内');

  const second = runTool(['--src', src, '--out-project', copy, '--json']);
  assert.equal(second.code, 0, second.stderr);
  const again = reportOf(second.stdout);
  assert.equal(again.integration.routeAdded, false, '重跑不应重复加路由（--out-project 别名）');
  const pagesAgain = JSON.parse(readFileSync(join(copy, 'entry/src/main/resources/base/profile/main_pages.json'), 'utf8')) as { src: string[] };
  assert.equal(pagesAgain.src.filter((item) => item === again.integration.route).length, 1);
});

test('--integrate 安全检查：非工程副本/不存在/位于 src 目录内 → exit 2', (t) => {
  const { copy, src } = makeCopyFixture(t);
  const dir = makeTmp(t);
  const res1 = runTool(['--src', src, '--integrate', join(dir, 'missing')]);
  assert.equal(res1.code, 2);
  const res2 = runTool(['--src', src, '--integrate', dir]);
  assert.equal(res2.code, 2);
  assert.match(res2.stderr, /build-profile\.json5/);
  const res3 = runTool(['--src', src, '--integrate', join(dirname(src), 'project')]);
  assert.equal(res3.code, 2);
  assert.match(res3.stderr, /--src 目录内/);
});

test('--integrate --dry-run：不写副本、不加路由、不建 out', (t) => {
  const { copy, src } = makeCopyFixture(t);
  const beforePages = readFileSync(join(copy, 'entry/src/main/resources/base/profile/main_pages.json'), 'utf8');
  const res = runTool(['--src', src, '--integrate', copy, '--dry-run', '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.integration.dryRun, true);
  assert.equal(existsSync(join(copy, 'ui-skeleton-out')), false);
  assert.equal(readFileSync(join(copy, 'entry/src/main/resources/base/profile/main_pages.json'), 'utf8'), beforePages);
  assert.equal(existsSync(join(copy, 'entry/src/main/ets/pages', report.struct + '.ets')), false);
});

test('safe rules：Spacer→Blank、verticalScroll→Scroll、Text 样式、size、onClick/LaunchedEffect TODO', (t) => {
  const { src, out } = fixture(t, 'safe', SAFE_KT);
  const res = runTool(['--src', src, '--out', out, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  const byId = new Map(report.safeRules.map((rule: { id: string; count: number }) => [rule.id, rule.count]));
  assert.ok((byId.get('spacer') ?? 0) > 0, '应命中 Spacer');
  assert.ok((byId.get('verticalScroll') ?? 0) > 0, '应命中 verticalScroll');
  assert.ok((byId.get('text') ?? 0) >= 4, '应命中 Text 样式');
  assert.ok((byId.get('onClick') ?? 0) > 0, '应命中 onClick');
  assert.ok((byId.get('launchedEffect') ?? 0) > 0, '应命中 LaunchedEffect');
  assert.ok((byId.get('size') ?? 0) > 0, '应命中 size/fillMaxSize');
  assert.ok((byId.get('state') ?? 0) > 0, '应命中 @State');
  const ets = readFileSync(join(out, report.struct + '.ets'), 'utf8');
  assert.match(ets, /Blank\(\)\.height\(8\)/);
  assert.match(ets, /Scroll\(\) \{/);
  assert.match(ets, /\.fontSize\(18\)/);
  assert.match(ets, /\.fontWeight\(FontWeight\.Bold\)/);
  assert.match(ets, /\.textAlign\(TextAlign\.Center\)/);
  assert.match(ets, /\.fontColor\('#FFFFFF'\)/);
  assert.match(ets, /\.width\('100%'\)\.height\('100%'\)/);
  assert.match(ets, /TODO\(ui-skeleton\): 回调体未生成/);
  assert.match(ets, /TODO\(ui-skeleton\): LaunchedEffect/);
});

test('safe rules 不做资源映射：stringResource 保持字面量，不生成 $r 资源引用', (t) => {
  const { src, out } = fixture(t, 'nores', ABOUT_KT);
  const res = runTool(['--src', src, '--out', out, '--json']);
  assert.equal(res.code, 0, res.stderr);
  const report = reportOf(res.stdout);
  const ets = readFileSync(join(out, report.struct + '.ets'), 'utf8');
  assert.doesNotMatch(ets, /\$r\('app\.string/);
  assert.doesNotMatch(ets, /\$r\('app\.media\.(?!app_icon)/);
  const raw = JSON.parse(readFileSync(rulesPath, 'utf8')) as { excludedRules: string[] };
  assert.ok(raw.excludedRules.some((rule) => rule.includes('stringResource')));
});

test('真实三页 smoke：About/List/Form 输出非空、指标合理、未映射合理', (t) => {
  const pages = [
    {
      label: 'About',
      path: '/mnt/d/Project/legado-with-MD3/app/src/main/java/io/legado/app/ui/about/AboutScreen.kt',
      unmapped: 'TextCard',
    },
    {
      label: 'List',
      path: '/mnt/d/Project/legado-with-MD3/app/src/main/java/io/legado/app/ui/main/homepage/manage/BrowseSourcesPage.kt',
      unmapped: 'SelectionItemCard',
    },
    {
      label: 'Form',
      path: '/mnt/d/Project/legado-with-MD3/app/src/main/java/io/legado/app/ui/highlightTagRule/HighlightTagRuleEditSheet.kt',
      unmapped: 'RoundDropdownMenu',
    },
  ];
  for (const page of pages) {
    if (!existsSync(page.path)) {
      continue;
    }
    const out = join(makeTmp(t), 'out');
    const res = runTool(['--src', page.path, '--out', out, '--json']);
    assert.equal(res.code, 0, page.label + ' 应成功：' + res.stderr);
    const report = reportOf(res.stdout);
    assert.ok(report.coverage.nodes > 0, page.label + ' 应解析到节点');
    assert.ok(report.coverage.mappedNodes > 0, page.label + ' 应有映射节点');
    assert.ok(report.manualPoints.length > 0, page.label + ' 应有手动点');
    assert.ok(report.unmapped.includes(page.unmapped), page.label + ' 未映射应包含 ' + page.unmapped);
    assert.ok(report.generatedLines > 10, page.label + ' 输出应非空');
    const ets = readFileSync(join(out, report.struct + '.ets'), 'utf8');
    assert.match(ets, /@Component/);
    console.log('real-page ' + page.label + ': ' + report.coverage.mappedNodes + '/' + report.coverage.nodes +
      ' nodes (' + report.coverage.pct + '%), lines ' + report.sourceLines + '→' + report.generatedLines +
      ', unmapped=' + report.unmapped.join(','));
  }
});
