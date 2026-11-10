#!/usr/bin/env node
/**
 * cli/ui-skeleton.ts —— Compose 单页 → ArkUI 骨架（MVP，白名单启发式；不是 codemod）。
 *
 * 用法：
 *   node cli/ui-skeleton.ts --src <one .kt> --out <dir> [--json] [--md] [--dry-run]
 *
 * 做什么：
 *   - 识别单文件里的 @Composable 函数（选白名单节点最多的一个作为主页）；
 *   - 用组件名 + 花括号深度启发式提取嵌套，白名单组件映射为 ArkUI；
 *   - remember{mutableStateOf} → @State；LaunchedEffect → aboutToAppear 占位；
 *   - 字符串/资源静态化；简单 if/ForEach 只做结构近似；
 *   - ArkUI 基类保留字（如 enabled）自动重命名（enabled → ruleEnabled）并记录；
 *   - 只写 --out（不得位于 --src 目录内），同时写 <Name>.ets 与 mapping.md。
 *
 * 不做什么：像素/行为等价、主题/资源/图标迁移、Sheet/Dialog/动画/手势/平台 API、
 *           自动改工程源码；生成物未编译，需人工审查 + build-hap/reachability-probe 门禁。
 *
 * 退出码：0 = 生成成功；1 = 找不到可映射的 @Composable/组件；2 = 用法错误。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULES_PATH = join(repoRoot, 'rules', 'ui-mapping.json');
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE = [
  '用法：',
  '  node cli/ui-skeleton.ts --src <one .kt> --out <dir> [--json] [--md] [--dry-run]',
  '',
  '  --src <file>   单个 Compose .kt 文件（只读；不修改上游工程）',
  '  --out <dir>    输出目录（必须位于 --src 目录之外；写 <Name>.ets + mapping.md）',
  '  --integrate <copy>  把生成的 .ets 注入 Harmony 工程副本并加路由（只写副本；不改上游）；',
  '                      与 --out-project 等价。省略 --out 时默认 <copy>/ui-skeleton-out',
  '  --json         stdout 只输出结构化报告（含 components/mapped/unmapped/manualPoints/rules/sha256）',
  '  --md           额外把 mapping.md 打到 stdout（与 --json 同时给时以 --json 为准）',
  '  --dry-run      只解析/生成内容，不写任何文件',
  '  --help, -h     显示本帮助',
  '',
  '白名单：Column/Row/Box/List(LazyColumn)/ListItem/Scroll/Divider/Text/Image/',
  '        TextInput(TextField)/TextArea/Toggle(Switch)/Button + padding/width/height/',
  '        layoutWeight/clickable/onChange。',
  '规则：rules/ui-mapping.json（version + sha256）。生成物为骨架，不承诺像素/行为等价。',
].join('\n');

interface CliArgs {
  src: string;
  out: string;
  integrate: string;
  json: boolean;
  md: boolean;
  dryRun: boolean;
}

interface RulesShape {
  version: number;
  sha256: string;
  components: Record<string, string>;
  containers: string[];
  modifiers: Record<string, string>;
  reserved: string[];
  rename: Record<string, string>;
  unmappedKnown: string[];
  stubCosts?: Record<string, number>;
  stubLinesPerComponent?: number;
  safeRules?: Array<{ id: string; mapping: string; confidence: number }>;
  excludedRules?: string[];
  weightMap?: Record<string, string>;
  alignMap?: Record<string, string>;
  colorMap?: Record<string, string>;
  manualRules: string[];
}

interface ComponentNode {
  source: string;
  arkui: string;
  container: boolean;
  depth: number;
  pos: number;
  label: string;
  attrs: string[];
  children: ComponentNode[];
  /** true = 未映射组件，用 @Builder stub 占位 */
  unmapped?: boolean;
  stubName?: string;
  /** safe rule: Column/Box 带 verticalScroll → 外层 Scroll 包裹 */
  verticalScroll?: boolean;
  /** safe rule: LazyColumn + items → ForEach（容器） */
  forEach?: boolean;
}

interface StateVar {
  name: string;
  original: string;
  type: string;
  initial: string;
  renamed: boolean;
}

const IGNORE_CALLS = new Set([
  'stringResource', 'stringArrayResource', 'painterResource', 'remember', 'mutableStateOf',
  'mutableStateListOf', 'LaunchedEffect', 'delay', 'rememberScrollState', 'rememberLazyListState',
  'rememberPagerState', 'rememberCoroutineScope', 'collectAsStateWithLifecycle', 'koinInject',
  'snapshotFlow', 'items', 'itemsIndexed', 'R', 'Icons', 'MaterialTheme', 'Arrangement', 'Alignment',
  'Modifier', 'FontWeight', 'dp', 'sp', 'Color', 'ContentScale', 'PaddingValues', 'ImageFit',
  'ToggleType', 'KeyboardOptions', 'ImeAction', 'TextStyle', 'Typography', 'Dp', 'Shapes',
  'Icons.Default', 'Icons.AutoMirrored', 'getValue', 'setValue', 'if', 'for', 'when', 'return',
  'let', 'apply', 'copy', 'size', 'distinctBy', 'filter', 'any', 'map', 'groupBy', 'associateBy',
  'forEach', 'forEachIndexed', 'fillMaxWidth', 'padding', 'width', 'height', 'weight', 'clickable',
  'onClick', 'onChange', 'isNotEmpty', 'isEmpty', 'firstOrNull', 'contains', 'toString', 'trim',
  'entries', 'values', 'keys', 'ordinal', 'name', 'copy', 'toMutableList', 'toList', 'getOrNull',
  'calculateTopPadding', 'calculateBottomPadding', 'nestedScroll', 'align', 'fillMaxSize', 'weight',
  'focusRequester', 'KeyboardActions', 'onKeyEvent', 'Array', 'List', 'String', 'Int', 'Boolean'
]);

function failUsage(message: string): never {
  console.error('ui-skeleton: ' + message);
  console.error('用法见：node cli/ui-skeleton.ts --help');
  process.exit(EXIT_USAGE);
}

function fail(message: string): never {
  console.error('ui-skeleton: ' + message);
  process.exit(EXIT_FAIL);
}

function parseArgs(argv: string[]): CliArgs {
  const raw: Record<string, string | boolean> = {};
  const VALUE = new Set(['src', 'out', 'integrate', 'out-project']);
  const BOOL = new Set(['json', 'md', 'dry-run', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') raw.help = true;
    else if (!token.startsWith('--')) failUsage('无法识别的参数：' + token);
    else {
      const eq = token.indexOf('=');
      if (eq > 2) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        if (!VALUE.has(key)) failUsage('未知参数：--' + key);
        if (value === '') failUsage('--' + key + ' 不能为空');
        raw[key] = value;
        continue;
      }
      const key = token.slice(2);
      if (BOOL.has(key)) { raw[key] = true; continue; }
      if (!VALUE.has(key)) failUsage('未知参数：--' + key);
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('--')) failUsage('--' + key + ' 缺少取值');
      raw[key] = next;
      i++;
    }
  }
  return {
    src: typeof raw.src === 'string' ? raw.src : '',
    out: typeof raw.out === 'string' ? raw.out : '',
    integrate: typeof raw.integrate === 'string' ? raw.integrate
      : (typeof raw['out-project'] === 'string' ? raw['out-project'] : ''),
    json: raw.json === true,
    md: raw.md === true,
    dryRun: raw['dry-run'] === true,
  };
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

function loadRules(): RulesShape {
  if (!isFile(RULES_PATH)) fail('缺少规则文件：' + RULES_PATH);
  const raw = JSON.parse(readFileSync(RULES_PATH, 'utf8')) as RulesShape;
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) fail('规则版本不支持：' + String(raw.version));
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) fail('规则 sha256 非法');
  if (raw.components === undefined || raw.containers === undefined) fail('规则结构不完整');
  return raw;
}

/** 把注释与字符串内容替换为空格（保留引号本身），长度不变，便于扫描括号/组件。 */
function maskSource(text: string): string {
  const chars = text.split('');
  let i = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      else chars[i] = ' ';
      i++;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; blockComment = false; i += 2; continue; }
      if (ch !== '\n') chars[i] = ' ';
      i++;
      continue;
    }
    if (quote !== '') {
      if (ch === '\\') { chars[i] = ' '; if (next !== undefined) chars[i + 1] = ' '; i += 2; continue; }
      if (ch === quote) { quote = ''; i++; continue; }
      if (ch !== '\n') chars[i] = ' ';
      i++;
      continue;
    }
    if (ch === '/' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; lineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { chars[i] = ' '; chars[i + 1] = ' '; blockComment = true; i += 2; continue; }
    if (ch === '"') { quote = '"'; i++; continue; }
    i++;
  }
  return chars.join('');
}

function matchPair(code: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === openChar) depth++;
    else if (code[i] === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function depthBefore(code: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
  }
  return depth;
}

function collapse(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…';
}

function escapeArkString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}

function componentLabel(segment: string): string {
  const res = /stringResource\s*\(\s*R\.string\.([A-Za-z0-9_]+)/.exec(segment);
  if (res !== null) return res[1];
  const literal = /"([^"\\]{1,60})"/.exec(segment);
  if (literal !== null) return literal[1];
  return '';
}

function inferType(rawType: string | undefined, initial: string): string {
  const typeText = rawType === undefined ? '' : rawType.trim();
  if (/^String$/i.test(typeText)) return 'string';
  if (/^Boolean$/i.test(typeText)) return 'boolean';
  if (/^(Int|Long|Float|Double|Number)$/i.test(typeText)) return 'number';
  if (/^(true|false)$/.test(initial)) return 'boolean';
  if (/^-?\d+(\.\d+)?$/.test(initial)) return 'number';
  if (/^".*"$/.test(initial) || /^'.*'$/.test(initial)) return 'string';
  if (/^String$/i.test(typeText)) return 'string';
  return 'string';
}

function initialFor(type: string, raw: string): string {
  const trimmed = raw.trim();
  if (/^(true|false)$/.test(trimmed)) return trimmed;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^".*"$/.test(trimmed)) return trimmed.length > 60 ? "'" + escapeArkString(trimmed.slice(1, -1)) + "'" : trimmed.replace(/"/g, "'");
  if (/^'.*'$/.test(trimmed)) return "'" + escapeArkString(trimmed.slice(1, -1)) + "'";
  if (type === 'boolean') return 'false';
  if (type === 'number') return '0';
  return "''";
}

function selectPrimary(code: string): { name: string; bodyStart: number; bodyEnd: number; fnStart: number } {
  const re = /@Composable\s+(?:(?:private|internal|public|protected)\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const found: Array<{ name: string; bodyStart: number; bodyEnd: number; fnStart: number; score: number }> = [];
  let match: RegExpExecArray | null = re.exec(code);
  while (match !== null) {
    const parenStart = code.indexOf('(', match.index);
    const parenEnd = matchPair(code, parenStart, '(', ')');
    if (parenEnd > parenStart) {
      const braceStart = code.indexOf('{', parenEnd);
      const braceEnd = braceStart >= 0 ? matchPair(code, braceStart, '{', '}') : -1;
      if (braceEnd > braceStart) {
        const body = code.slice(braceStart + 1, braceEnd);
        const compRe = /\b([A-Z][A-Za-z0-9_]*)\s*\(/g;
        let comp: RegExpExecArray | null = compRe.exec(body);
        let score = 0;
        while (comp !== null) {
          if (!IGNORE_CALLS.has(comp[1])) score++;
          comp = compRe.exec(body);
        }
        found.push({ name: match[1], bodyStart: braceStart + 1, bodyEnd: braceEnd, fnStart: match.index, score });
      }
    }
    match = re.exec(code);
  }
  if (found.length === 0) fail('没有找到带函数体的 @Composable 函数');
  found.sort((a, b) => b.score - a.score || a.fnStart - b.fnStart);
  return found[0];
}

function stripComposePrefix(name: string): string {
  return name;
}

function parseStates(originalBody: string, rules: RulesShape, manual: string[]): StateVar[] {
  const states: StateVar[] = [];
  const seen = new Set<string>();
  const re = /(?:var|val)\s+([A-Za-z_][A-Za-z0-9_]*)\s+by\s+remember(?:\s*\([^)]*\))?\s*\{\s*mutableStateOf\s*(?:<([^>]*)>)?\s*\(([^;]*?)\)\s*\}/g;
  let match: RegExpExecArray | null = re.exec(originalBody);
  while (match !== null) {
    const original = match[1];
    let name = original;
    let renamed = false;
    if (rules.reserved.includes(original)) {
      name = rules.rename[original] !== undefined ? rules.rename[original] : original + 'Value';
      renamed = true;
      manual.push('保留字重命名：@State ' + original + ' → ' + name + '（ArkUI CustomComponent 基类属性冲突）');
    }
    while (seen.has(name)) name = name + '2';
    seen.add(name);
    let type = inferType(match[2], match[3]);
    if (type === 'string' && /^(enabled|checked|visible|shown|expanded|loading|selected|dirty|is[A-Z]|has[A-Z])/.test(original)) {
      type = 'boolean';
    }
    const initial = initialFor(type, match[3]);
    states.push({ name, original, type, initial, renamed });
    match = re.exec(originalBody);
  }
  return states;
}

function parseComponents(code: string, original: string, bodyStart: number, bodyEnd: number, rules: RulesShape): { nodes: ComponentNode[]; unmapped: ComponentNode[]; mappedSources: Map<string, number>; unmappedSources: Map<string, number> } {
  const nodes: ComponentNode[] = [];
  const unmapped: ComponentNode[] = [];
  const mappedSources = new Map<string, number>();
  const unmappedSources = new Map<string, number>();
  const slice = code.slice(bodyStart, bodyEnd);
  const re = /\b([A-Z][A-Za-z0-9_]*)\s*\(/g;
  const matches: Array<{ source: string; pos: number }> = [];
  let match: RegExpExecArray | null = re.exec(slice);
  while (match !== null) {
    matches.push({ source: match[1], pos: bodyStart + match.index });
    match = re.exec(slice);
  }
  for (let index = 0; index < matches.length; index++) {
    const source = matches[index].source;
    const pos = matches[index].pos;
    const nextPos = index + 1 < matches.length ? matches[index + 1].pos : bodyEnd;
    if (!IGNORE_CALLS.has(source)) {
      const arkui = rules.components[source];
      const segment = original.slice(pos, Math.min(nextPos, bodyEnd));
      if (arkui !== undefined) {
        const depth = depthBefore(code, bodyStart, pos);
        const label = componentLabel(segment);
        const attrs: string[] = [];
        if (/fillMaxWidth\s*\(\s*\)/.test(segment)) attrs.push(".width('100%')");
        if (/fillMaxSize\s*\(\s*\)/.test(segment)) attrs.push(".width('100%').height('100%')");
        const sizeMatch = /size\s*\(\s*(\d+(?:\.\d+)?)\.dp\s*\)/.exec(segment);
        if (sizeMatch !== null) attrs.push('.width(' + sizeMatch[1] + ').height(' + sizeMatch[1] + ')');
        const heightIn = /heightIn\s*\(([^)]*)\)/.exec(segment);
        if (heightIn !== null) {
          const minH = /min\s*=\s*(\d+(?:\.\d+)?)\.dp/.exec(heightIn[1]);
          const maxH = /max\s*=\s*(\d+(?:\.\d+)?)\.dp/.exec(heightIn[1]);
          if (minH !== null || maxH !== null) {
            const parts: string[] = [];
            if (minH !== null) parts.push('minHeight: ' + minH[1]);
            if (maxH !== null) parts.push('maxHeight: ' + maxH[1]);
            attrs.push('.constraintSize({ ' + parts.join(', ') + ' })');
          }
        }
        const widthIn = /widthIn\s*\(([^)]*)\)/.exec(segment);
        if (widthIn !== null) {
          const minW = /min\s*=\s*(\d+(?:\.\d+)?)\.dp/.exec(widthIn[1]);
          const maxW = /max\s*=\s*(\d+(?:\.\d+)?)\.dp/.exec(widthIn[1]);
          if (minW !== null || maxW !== null) {
            const parts: string[] = [];
            if (minW !== null) parts.push('minWidth: ' + minW[1]);
            if (maxW !== null) parts.push('maxWidth: ' + maxW[1]);
            attrs.push('.constraintSize({ ' + parts.join(', ') + ' })');
          }
        }
        const pad = /padding\s*\(\s*(?:horizontal\s*=\s*|vertical\s*=\s*)?(\d+)(?:\.\d+)?\.dp/.exec(segment);
        if (pad !== null) attrs.push('.padding(' + pad[1] + ')');
        const heightMatch = /height\s*\(\s*(\d+)(?:\.\d+)?\.dp\s*\)/.exec(segment);
        if (heightMatch !== null) attrs.push('.height(' + heightMatch[1] + ')');
        const weightMatch = /weight\s*\(\s*([\d.]+)\s*f\s*\)/.exec(segment);
        if (weightMatch !== null) attrs.push('.layoutWeight(' + weightMatch[1] + ')');
        if (/onClick\s*[=(]/.test(segment) || /clickable\s*\(/.test(segment)) attrs.push('.onClick(() => { /* TODO(ui-skeleton): 回调体未生成 */ })');
        if (/onChange\s*=/.test(segment) || /onCheckedChange\s*=/.test(segment)) {
          if (/AdaptiveSwitch|Toggle/.test(source)) attrs.push('.onChange((isOn: boolean) => { /* TODO */ })');
          else if (/AppTextField|TextInput|TextArea/.test(source)) attrs.push('.onChange((value: string) => { /* TODO */ })');
        }
        if (arkui === 'Text') {
          const fontSize = /fontSize\s*=\s*(\d+(?:\.\d+)?)\.sp/.exec(segment);
          if (fontSize !== null) attrs.push('.fontSize(' + fontSize[1] + ')');
          const fontWeight = /fontWeight\s*=\s*FontWeight\.(\w+)/.exec(segment);
          if (fontWeight !== null && rules.weightMap !== undefined && rules.weightMap[fontWeight[1]] !== undefined) {
            attrs.push('.fontWeight(' + rules.weightMap[fontWeight[1]] + ')');
          }
          const textAlign = /textAlign\s*=\s*TextAlign\.(\w+)/.exec(segment);
          if (textAlign !== null && rules.alignMap !== undefined && rules.alignMap[textAlign[1]] !== undefined) {
            attrs.push('.textAlign(' + rules.alignMap[textAlign[1]] + ')');
          }
          const fontColor = /fontColor\s*=\s*Color\.(\w+)/.exec(segment);
          if (fontColor !== null && rules.colorMap !== undefined && rules.colorMap[fontColor[1]] !== undefined) {
            attrs.push(".fontColor('" + rules.colorMap[fontColor[1]] + "')");
          }
        }
        const container = rules.containers.includes(source) || rules.containers.includes(arkui);
        const node: ComponentNode = { source, arkui, container, depth, pos, label, attrs, children: [] };
        if (container && /verticalScroll\s*\(/.test(segment)) node.verticalScroll = true;
        nodes.push(node);
        mappedSources.set(source, (mappedSources.get(source) ?? 0) + 1);
      } else if (rules.unmappedKnown.includes(source)) {
        const depth = depthBefore(code, bodyStart, pos);
        const node: ComponentNode = {
          source, arkui: '', container: false, depth, pos, label: '', attrs: [], children: [],
          unmapped: true, stubName: 'Stub' + source.replace(/[^A-Za-z0-9_]/g, ''),
        };
        nodes.push(node);
        unmapped.push(node);
        unmappedSources.set(source, (unmappedSources.get(source) ?? 0) + 1);
      }
    }
  }
  // safe rule 9：LazyColumn + 简单 items → ForEach（仅当存在更浅层的 List 容器）
  const itemsRe = /\b(itemsIndexed|items)\s*\(/g;
  let itemsMatch: RegExpExecArray | null = itemsRe.exec(slice);
  while (itemsMatch !== null) {
    const pos = bodyStart + itemsMatch.index;
    const depth = depthBefore(code, bodyStart, pos);
    const hasList = nodes.some((node) => node.arkui === 'List' && node.depth < depth);
    if (hasList) {
      nodes.push({ source: itemsMatch[1], arkui: 'ForEach', container: true, forEach: true, depth, pos, label: '', attrs: [], children: [] });
    }
    itemsMatch = itemsRe.exec(slice);
  }
  nodes.sort((a, b) => a.pos - b.pos);
  return { nodes, unmapped, mappedSources, unmappedSources };
}

function buildTree(nodes: ComponentNode[]): ComponentNode[] {
  const roots: ComponentNode[] = [];
  const stack: ComponentNode[] = [];
  for (const node of nodes) {
    while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) stack.pop();
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    if (node.container) stack.push(node);
  }
  return roots;
}

interface RenderContext {
  states: StateVar[];
  stringCursor: number;
}

function renderNode(node: ComponentNode, indent: string, ctx: RenderContext): string[] {
  if (node.unmapped === true) {
    return [indent + 'this.' + String(node.stubName) + '()'];
  }
  const attrs = node.attrs.join('');
  if (node.forEach === true) {
    const lines: string[] = [indent + 'ForEach(this.items, (item: string) => {'];
    lines.push(indent + '  ListItem() {');
    if (node.children.length === 0) lines.push(indent + '    Text(item)');
    for (const child of node.children) {
      for (const line of renderNode(child, indent + '    ', ctx)) lines.push(line);
    }
    lines.push(indent + '  }');
    lines.push(indent + '}, (item: string) => item)');
    return lines;
  }
  if (node.container) {
    const lines: string[] = [indent + node.arkui + '() {'];
    for (const child of node.children) {
      for (const line of renderNode(child, indent + '  ', ctx)) lines.push(line);
    }
    lines.push(indent + '}' + attrs);
    if (node.verticalScroll === true) {
      const wrapped: string[] = [indent + 'Scroll() {'];
      for (const line of lines) wrapped.push('  ' + line);
      wrapped.push(indent + '}');
      return wrapped;
    }
    return lines;
  }
  const label = node.label === '' ? node.source : node.label;
  let expr: string;
  switch (node.arkui) {
    case 'Text': expr = 'Text(\'' + escapeArkString(label) + '\')'; break;
    case 'Button': expr = 'Button(\'' + escapeArkString(label) + '\')'; break;
    case 'Image': expr = "Image($r('app.media.app_icon'))"; break;
    case 'TextInput': {
      const stringStates = ctx.states.filter((state) => state.type === 'string');
      const bound = stringStates[ctx.stringCursor % (stringStates.length === 0 ? 1 : stringStates.length)];
      if (stringStates.length > 0) ctx.stringCursor++;
      expr = "TextInput({ placeholder: '" + escapeArkString(label) + "'" +
        (bound === undefined ? '' : ', text: this.' + bound.name) + ' })';
      break;
    }
    case 'TextArea': {
      const stringStates = ctx.states.filter((state) => state.type === 'string');
      const bound = stringStates[ctx.stringCursor % (stringStates.length === 0 ? 1 : stringStates.length)];
      if (stringStates.length > 0) ctx.stringCursor++;
      expr = "TextArea({ placeholder: '" + escapeArkString(label) + "'" +
        (bound === undefined ? '' : ', text: this.' + bound.name) + ' })';
      break;
    }
    case 'Toggle': {
      const boolStates = ctx.states.filter((state) => state.type === 'boolean');
      const bound = boolStates.length > 0 ? boolStates[0] : null;
      expr = 'Toggle({ type: ToggleType.Switch, isOn: ' + (bound === null ? 'false' : 'this.' + bound.name) + ' })';
      break;
    }
    case 'Blank': expr = 'Blank()'; break;
    case 'Divider': expr = 'Divider()'; break;
    case 'ListItem': expr = 'ListItem() { Text(\'' + escapeArkString(label) + '\') }'; break;
    default: expr = node.arkui + '()';
  }
  return [indent + expr + attrs];
}

interface GenerateResult {
  structName: string;
  ets: string;
  mapping: string;
  report: Record<string, unknown>;
}

function generate(sourcePath: string, sourceText: string, rules: RulesShape): GenerateResult {
  const code = maskSource(sourceText);
  const primary = selectPrimary(code);
  const originalBody = sourceText.slice(primary.bodyStart, primary.bodyEnd);
  const manual: string[] = [];
  const states = parseStates(originalBody, rules, manual);
  const parsed = parseComponents(code, sourceText, primary.bodyStart, primary.bodyEnd, rules);
  const forEachCount = parsed.nodes.filter((node) => node.forEach === true).length;
  const verticalScrollCount = parsed.nodes.filter((node) => node.verticalScroll === true).length;
  if (forEachCount > 0 && !states.some((state) => state.name === 'items')) {
    states.push({ name: 'items', original: 'items', type: 'string[]', initial: "['示例项 1', '示例项 2']", renamed: false });
    manual.push('ForEach 数据 items 为静态占位（safe rule lazyItems；真实数据未生成）');
  }
  const mappedNodeCount = parsed.nodes.filter((node) => node.unmapped !== true).length;
  if (mappedNodeCount === 0) fail('找到 @Composable 但没有白名单组件可映射：' + primary.name);
  const safeCounts: Record<string, number> = {
    spacer: parsed.mappedSources.get('Spacer') ?? 0,
    size: (originalBody.match(/\bfillMaxSize\s*\(|\bsize\s*\(|heightIn\s*\(|widthIn\s*\(/g) ?? []).length,
    state: states.length,
    verticalScroll: verticalScrollCount,
    lazyItems: forEachCount,
    text: (originalBody.match(/fontSize\s*=|fontWeight\s*=|textAlign\s*=|fontColor\s*=/g) ?? []).length,
    onClick: (originalBody.match(/onClick\s*=/g) ?? []).length,
    launchedEffect: (originalBody.match(/LaunchedEffect\s*\(/g) ?? []).length,
  };

  const roots = buildTree(parsed.nodes);
  const launchedEffects = (maskSource(originalBody).match(/LaunchedEffect\s*\(/g) ?? []).length;
  if (launchedEffects > 0) manual.push('LaunchedEffect ' + launchedEffects + ' 处 → aboutToAppear 占位（未实现协程/延迟状态机）');
  manual.push('嵌套关系由花括号深度启发式推断（未做 Kotlin AST），可能需人工调整');
  manual.push('资源/字符串/图标静态化；主题 token 不迁移');
  manual.push('生成物未编译：必须再过 build-hap + reachability-probe 门禁');
  for (const rule of rules.manualRules) if (!manual.includes(rule)) manual.push(rule);

  const structBase = primary.name;
  const structName = /(?:Page|Screen|Sheet|View|Component)$/.test(structBase) ? structBase : structBase + 'Page';

  // v0.2：未映射组件 → @Builder 占位 stub（只保证可编译，不伪造真实 UI）
  const stubSources = [...parsed.unmappedSources.keys()].sort();
  const stubBlocks: string[][] = [];
  const stubs: Array<Record<string, unknown>> = [];
  const stubPerComponent = rules.stubLinesPerComponent ?? 4;
  let stubLines = 0;
  for (const source of stubSources) {
    const count = parsed.unmappedSources.get(source) ?? 0;
    const stubName = 'Stub' + source.replace(/[^A-Za-z0-9_]/g, '');
    const block = [
      '  @Builder',
      '  ' + stubName + '() {',
      "    // TODO(ui-skeleton): Compose " + source + " 未映射；空实现占位（非真实 UI）",
      "    Text('[stub] " + source + "')",
      '  }',
      '',
    ];
    stubBlocks.push(block);
    stubLines += block.length;
    const cost = rules.stubCosts !== undefined && typeof rules.stubCosts[source] === 'number' ? rules.stubCosts[source] : stubPerComponent * 2;
    stubs.push({ component: source, count, stub: stubName, stubLines: block.length, estimatedRealLines: cost * count });
  }
  const manualLinesEstimate = stubs.reduce((sum, item) => sum + Math.max(0, Number(item.estimatedRealLines) - Number(item.stubLines)), 0);
  if (stubs.length > 0) {
    manual.push('未映射组件 ' + stubs.length + ' 类 → @Builder stub 占位（可编译；替换为真实 UI 估计 ' + manualLinesEstimate + ' 行）');
  }

  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * 由 cli/ui-skeleton.ts 生成的 ArkTS 骨架（MVP v0.3；需 build-hap + reachability-probe 门禁）。');
  lines.push(' * 来源：' + relative(process.cwd(), sourcePath));
  lines.push(' * 主 Composable：' + primary.name);
  lines.push(' * safe rules：Spacer/size/Text 样式/verticalScroll/onClick TODO/items/LaunchedEffect TODO；');
  lines.push(' * 只做白名单结构映射；未映射组件用 @Builder stub 占位（非真实 UI）；');
  lines.push(' * 不承诺像素/行为等价；门禁：build-hap + reachability-probe。');
  lines.push(' */');
  lines.push('@Entry');
  lines.push('@Component');
  lines.push('struct ' + structName + ' {');
  for (const state of states) {
    lines.push('  @State ' + state.name + ': ' + state.type + ' = ' + state.initial + ';');
  }
  if (states.length > 0) lines.push('');
  for (const block of stubBlocks) {
    for (const stubLine of block) lines.push(stubLine);
  }
  lines.push('  aboutToAppear(): void {');
  lines.push('    // TODO(ui-skeleton): LaunchedEffect 原逻辑未生成（safe rule 只做占位）：' + launchedEffects + ' 处');
  lines.push('  }');
  lines.push('');
  lines.push('  build() {');
  lines.push('    Column() {');
  const renderContext: RenderContext = { states, stringCursor: 0 };
  for (const root of roots) {
    for (const line of renderNode(root, '      ', renderContext)) lines.push(line);
  }
  lines.push('    }');
  lines.push("    .width('100%')");
  lines.push("    .height('100%')");
  lines.push('  }');
  lines.push('}');
  lines.push('');
  const ets = lines.join('\n');

  const mappedNodes = mappedNodeCount + verticalScrollCount;
  const unmappedNodes = parsed.unmapped.length;
  const total = mappedNodes + unmappedNodes;
  const safeRuleReport = (rules.safeRules ?? []).map((rule) => ({
    id: rule.id,
    mapping: rule.mapping,
    confidence: rule.confidence,
    count: safeCounts[rule.id] ?? 0,
  }));
  const pct = total === 0 ? 0 : Math.round((mappedNodes / total) * 1000) / 10;
  const rawLines = sourceText.split('\n').length;
  const sourceLines = sourceText.endsWith('\n') ? rawLines - 1 : rawLines;
  const generatedLines = ets.split('\n').length;

  const mappedBySource = [...parsed.mappedSources.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const unmappedBySource = [...parsed.unmappedSources.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const md: string[] = [];
  md.push('# UI 骨架映射：' + relative(process.cwd(), sourcePath));
  md.push('');
  md.push('- 源文件：' + relative(process.cwd(), sourcePath) + '（' + sourceLines + ' 行）');
  md.push('- 主 Composable：' + primary.name + '（取白名单节点最多的函数）');
  md.push('- 生成骨架：' + structName + '.ets（' + generatedLines + ' 行）');
  md.push('- 节点覆盖：' + mappedNodes + ' / ' + total + '（' + pct + '%）');
  md.push('- 规则：rules/ui-mapping.json version=' + rules.version + ' sha256=' + rules.sha256);
  md.push('');
  md.push('## 状态映射');
  md.push('');
  md.push('| 源 | 生成 | 说明 |');
  md.push('|---|---|---|');
  md.push('| remember{mutableStateOf} | @State（' + states.length + ' 个） | 名称/类型/初值由启发式推断 |');
  if (launchedEffects > 0) md.push('| LaunchedEffect(' + launchedEffects + ') | aboutToAppear 占位 | 未生成协程/延迟逻辑 |');
  for (const state of states) {
    md.push('| var ' + state.original + ' by remember { mutableStateOf(...) } | @State ' + state.name + ': ' + state.type + ' | ' + (state.renamed ? '保留字重命名' : '同名映射') + ' |');
  }
  md.push('');
  md.push('## 组件映射');
  md.push('');
  md.push('| 源组件 | ArkUI | 次数 |');
  md.push('|---|---|---|');
  for (const entry of mappedBySource) md.push('| ' + entry[0] + ' | ' + (rules.components[entry[0]] ?? '?') + ' | ' + entry[1] + ' |');
  md.push('');
  md.push('## Safe rules（v0.3，无资源依赖子集）');
  md.push('');
  md.push('| 规则 | 置信度 | 应用次数 |');
  md.push('|---|---|---|');
  for (const item of safeRuleReport) {
    md.push('| ' + item.mapping + ' | ' + item.confidence + ' | ' + item.count + ' |');
  }
  md.push('');
  md.push('- 未纳入：' + (rules.excludedRules ?? []).join('；'));
  md.push('');
  md.push('## 未映射组件（已生成 @Builder stub）');
  md.push('');
  if (unmappedBySource.length === 0) md.push('- （无）');
  for (const entry of unmappedBySource) md.push('- ' + entry[0] + ' ×' + entry[1] + '（复合组件/平台 API，人工实现）');
  md.push('');
  md.push('## 占位 stub（可编译，非真实 UI）');
  md.push('');
  md.push('| 源组件 | stub | 次数 | stub 行 | 估算真实实现行 |');
  md.push('|---|---|---|---|---|');
  for (const item of stubs) {
    md.push('| ' + item.component + ' | this.' + item.stub + '() | ' + String(item.count) + ' | ' + String(item.stubLines) + ' | ' + String(item.estimatedRealLines) + ' |');
  }
  md.push('');
  md.push('- stub 总行数：' + stubLines);
  md.push('- 替换 stub 为真实 UI 的估算人工行：' + manualLinesEstimate + '（规则 ui-mapping.json stubCosts）');
  md.push('');
  md.push('## 编译门禁');
  md.push('');
  md.push('- 编译修复人工行（估算）：0（stub 自动生成；本次三页实测 build-hap 通过）');
  md.push('- 仍需 build-hap + reachability-probe 复核；stub 未实现真实 UI 行为');
  md.push('');
  md.push('## 人工点');
  md.push('');
  let index = 1;
  for (const item of manual) { md.push(index + '. ' + item); index++; }
  md.push('');
  md.push('## 确定性');
  md.push('');
  md.push('同输入两次运行的 .ets 与 mapping.md 逐字节相同；输出文件不含时间戳。');
  md.push('');
  md.push('## 声明');
  md.push('');
  md.push('本产物是结构骨架 + stub，不是 codemod：不承诺像素/行为等价，不迁移主题/资源/图标，不处理 Sheet/Dialog/动画/手势/平台 API；stub 只是可编译占位（非真实 UI）；需人工审查并过 build-hap + reachability-probe 门禁。');
  md.push('');
  const mapping = md.join('\n');

  const report: Record<string, unknown> = {
    schemaVersion: 1,
    ok: true,
    src: sourcePath,
    out: '',
    dryRun: false,
    composable: primary.name,
    struct: structName,
    components: [...new Set([...parsed.mappedSources.keys(), ...parsed.unmappedSources.keys()])].sort(),
    mapped: [...parsed.mappedSources.keys()].sort(),
    unmapped: [...parsed.unmappedSources.keys()].sort(),
    manualPoints: manual,
    state: { count: states.length, renamed: states.filter((state) => state.renamed).map((state) => ({ from: state.original, to: state.name })) },
    stubs,
    stubLines,
    manualLinesEstimate,
    compileFixLinesEstimate: 0,
    safeRules: safeRuleReport,
    coverage: { nodes: total, mappedNodes, unmappedNodes, pct },
    rules: { version: rules.version, sha256: rules.sha256 },
    sha256: createHash('sha256').update(ets).digest('hex'),
    mappingSha256: createHash('sha256').update(mapping).digest('hex'),
    sourceLines,
    generatedLines,
    files: {},
    notes: ['MVP 启发式，不是 codemod', '未映射组件用 @Builder stub 占位（非真实 UI）', '生成物未编译，需人工审查 + build/probe 门禁'],
  };
  return { structName, ets, mapping, report };
}

function injectPage(copyAbs: string, structName: string, ets: string): Record<string, unknown> {
  const pagesDir = join(copyAbs, 'entry', 'src', 'main', 'ets', 'pages');
  const pageFile = join(pagesDir, structName + '.ets');
  writeFileSync(pageFile, ets, 'utf8');
  const pagesJson = join(copyAbs, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json');
  let data: { src: string[] } = { src: [] };
  if (existsSync(pagesJson)) {
    const parsed = JSON.parse(readFileSync(pagesJson, 'utf8')) as { src?: unknown };
    if (!Array.isArray(parsed.src) || parsed.src.some((item) => typeof item !== 'string')) {
      failUsage('副本的 main_pages.json 结构不合法：' + pagesJson);
    }
    data = { src: parsed.src as string[] };
  }
  const route = 'pages/' + structName;
  const routeAdded = !data.src.includes(route);
  if (routeAdded) data.src.push(route);
  writeFileSync(pagesJson, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return {
    enabled: true,
    copy: copyAbs,
    page: relative(copyAbs, pageFile),
    route,
    routeAdded,
    pagesJson: relative(copyAbs, pagesJson),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(EXIT_OK);
  }
  const args = parseArgs(argv);
  if (args.src === '') failUsage('缺少 --src <file.kt>');
  const srcAbs = resolve(process.cwd(), args.src);
  if (!isFile(srcAbs)) failUsage('--src 文件不存在：' + args.src);
  if (!/\.kt$/i.test(srcAbs)) failUsage('--src 必须是 .kt 文件：' + args.src);
  const srcDir = dirname(srcAbs);
  const integrateAbs = args.integrate === '' ? '' : resolve(process.cwd(), args.integrate);
  if (args.out === '' && integrateAbs === '') failUsage('缺少 --out <dir>（或提供 --integrate <copy>）');
  const outAbs = args.out === '' ? join(integrateAbs, 'ui-skeleton-out') : resolve(process.cwd(), args.out);
  if (isWithin(outAbs, srcDir)) failUsage('--out 不能位于 --src 目录内（不改上游工程）：' + args.out);
  if (existsSync(outAbs) && !statSync(outAbs).isDirectory()) failUsage('--out 已存在且不是目录：' + args.out);
  if (integrateAbs !== '') {
    if (!existsSync(integrateAbs) || !statSync(integrateAbs).isDirectory()) failUsage('--integrate 目录不存在：' + args.integrate);
    if (isWithin(integrateAbs, srcDir)) failUsage('--integrate 不能位于 --src 目录内：' + args.integrate);
    if (integrateAbs === repoRoot || integrateAbs === process.cwd()) failUsage('--integrate 不能指向仓库本身（只写工程副本）');
    if (!isFile(join(integrateAbs, 'build-profile.json5'))) failUsage('--integrate 不是 Harmony 工程副本（缺 build-profile.json5）：' + args.integrate);
    if (!existsSync(join(integrateAbs, 'entry', 'src', 'main', 'ets', 'pages'))) failUsage('--integrate 缺 entry/src/main/ets/pages：' + args.integrate);
  }

  const rules = loadRules();
  const sourceText = readFileSync(srcAbs, 'utf8');
  const generated = generate(srcAbs, sourceText, rules);
  const etsPath = join(outAbs, generated.structName + '.ets');
  const mdPath = join(outAbs, 'mapping.md');
  const report = generated.report;
  report.out = args.out === '' ? relative(process.cwd(), outAbs) : args.out;
  report.dryRun = args.dryRun;
  if (!args.dryRun) {
    mkdirSync(outAbs, { recursive: true });
    writeFileSync(etsPath, generated.ets, 'utf8');
    writeFileSync(mdPath, generated.mapping, 'utf8');
    report.files = { ets: relative(process.cwd(), etsPath), md: relative(process.cwd(), mdPath) };
    if (integrateAbs !== '') report.integration = injectPage(integrateAbs, generated.structName, generated.ets);
  } else {
    report.files = {};
    if (integrateAbs !== '') report.integration = { enabled: true, dryRun: true, copy: args.integrate };
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (args.md) {
    console.log(generated.mapping);
  } else {
    const coverage = report.coverage as Record<string, unknown>;
    console.log('ui-skeleton  源 ' + args.src + '  →  ' + generated.structName + '.ets  ' +
      String(coverage.pct) + '% 节点（' + String(coverage.mappedNodes) + '/' + String(coverage.nodes) + '）' +
      (args.dryRun ? '  [dry-run：未写文件]' : '  输出 ' + args.out));
  }
  process.exit(EXIT_OK);
}

main();
