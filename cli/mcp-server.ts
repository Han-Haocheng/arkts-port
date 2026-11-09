#!/usr/bin/env node
/**
 * arkts-port MCP 薄包装（零依赖，JSON-RPC over stdio，newline-delimited JSON）。
 *
 * 目标：把现有 CLI 暴露成 MCP 工具，agent 直接调用；本文件只做参数映射与进程转发，
 * 不复制任何门禁/适配/分析逻辑（全部 spawn 现有 cli/*.ts 与 scripts/*.mjs）。
 *
 * 用法：
 *   node cli/mcp-server.ts [--cwd <dir>] [--allow <tool,...>] [--timeout <ms>] [--help]
 *
 * 协议（MCP 1.x）：
 *   initialize / notifications/initialized / ping / tools/list / tools/call
 *   消息按行分隔（每行一个 JSON-RPC 2.0 对象），响应同样一行一个。
 *
 * 安全：
 *   - 只暴露白名单工具；--allow 进一步收窄，且未知工具名是用法错误；
 *   - 子进程 cwd 固定为 --cwd（默认当前目录），不拼 shell（spawn + argv 数组）；
 *   - 未知参数直接报错（不做静默忽略），缺必填参数返回 isError；
 *   - 单次调用有超时（默认 10 分钟）。
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_NAME = 'arkts-port';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const DEFAULT_PROTOCOL = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TEXT_CHARS = 12000;

interface ArgSpec {
  name: string;
  flag: string;
  type: 'string' | 'boolean' | 'number' | 'strings';
  required?: boolean;
  description: string;
}

interface ToolSpec {
  name: string;
  script: string;
  description: string;
  args: ArgSpec[];
  /** 工具级参数联动校验：返回错误文本表示 isError（在必填校验之后、spawn 之前执行） */
  validate?: (args: Record<string, unknown>) => string | null;
}

interface CliOptions {
  cwd: string;
  allow: string[] | null;
  timeoutMs: number;
}

const HELP_ARG: ArgSpec = { name: 'help', flag: '--help', type: 'boolean', description: '打印该 CLI 的帮助后退出' };

function arg(name: string, flag: string, type: ArgSpec['type'], description: string, required?: boolean): ArgSpec {
  return { name: name, flag: flag, type: type, required: required === true, description: description };
}

const TOOLS: ToolSpec[] = [
  {
    name: 'doctor',
    script: 'cli/doctor.ts',
    description: '环境/工程预检：SDK/hvigor/配置/目录逐项 PASS/FAIL/WARN（构建前先跑）',
    args: [
      arg('project', '--project', 'string', '鸿蒙工程根目录'),
      arg('sdk', '--sdk', 'string', 'OpenHarmony SDK 根（默认 OHOS_BASE_SDK_HOME）'),
      arg('hvigor', '--hvigor', 'string', 'hvigor node_modules 目录'),
      arg('case', '--case', 'string', '案例目录（检查 golden/actual）'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', '把 JSON 报告写到文件'),
      HELP_ARG,
    ],
  },
  {
    name: 'analyze-coupling',
    script: 'cli/analyze-coupling.ts',
    description: '耦合分诊：统计可自动转写覆盖率（决定值不值得转）',
    args: [
      arg('root', '--root', 'string', '源码根目录'),
      arg('lang', '--lang', 'string', '语言 id（jvm/js-ts/dart/c-cpp/swift）'),
      arg('top', '--top', 'number', '模块级耦合率 Top N'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('listLangs', '--list-langs', 'boolean', '列出支持的语言'),
      HELP_ARG,
    ],
  },
  {
    name: 'extract-closure',
    script: 'cli/extract-closure.ts',
    description: '从 entry 抽 JVM 最小可编译依赖闭包',
    args: [
      arg('root', '--root', 'string', '工程根目录', true),
      arg('entry', '--entry', 'string', '闭包入口（.kt/.java）', true),
      arg('lang', '--lang', 'string', '语言适配器（默认 jvm）'),
      arg('out', '--out', 'string', '把 include 文件复制到该目录'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('force', '--force', 'boolean', '允许 --out 位于 --root 内（调试用）'),
      arg('noPackageComplete', '--no-package-complete', 'boolean', '不做 package 补全'),
      HELP_ARG,
    ],
  },
  {
    name: 'pack-context',
    script: 'cli/pack-context.ts',
    description: '生成转写阶段的确定性上下文包（Markdown）',
    args: [
      arg('closure', '--closure', 'string', '闭包目录', true),
      arg('lang', '--lang', 'string', '语言适配器（默认 jvm）'),
      arg('out', '--out', 'string', 'Markdown 输出路径'),
      arg('maxBytes', '--max-bytes', 'number', '单文件字节上限'),
      arg('exclude', '--exclude', 'strings', '排除 glob，可重复'),
      arg('noMembers', '--no-members', 'boolean', '签名索引只出顶层声明'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      HELP_ARG,
    ],
  },
  {
    name: 'gen-golden',
    script: 'cli/gen-golden.ts',
    description: 'golden 生成 + 稳定性门禁（jvm 编译 Kotlin；js-ts 跑 Node harness；两次逐字节比对）',
    args: [
      arg('lang', '--lang', 'string', '语言：jvm | js-ts（js-ts 不需要 src，源根=--main 所在目录）', true),
      arg('src', '--src', 'string', 'jvm 闭包源码目录（jvm 必填；js-ts 不要传 --src）'),
      arg('main', '--main', 'string', 'jvm=Main.kt 路径；js-ts=harness.mjs/.js 路径（缺省时复制骨架并 exit 4）'),
      arg('package', '--package', 'string', '覆盖 Main.kt 里的 package（仅 jvm）'),
      arg('out', '--out', 'string', '输出目录（默认 out/gen-golden）'),
      arg('logs', '--logs', 'string', '日志目录'),
      arg('timeout', '--timeout', 'number', '单次子进程超时 ms'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      HELP_ARG,
    ],
    validate: (args) => {
      const lang = typeof args.lang === 'string' ? args.lang : '';
      const hasSrc = Object.prototype.hasOwnProperty.call(args, 'src') && args.src !== undefined && args.src !== null;
      if (lang === 'jvm' && !hasSrc) {
        return '缺少 --src：--lang jvm 需要 --src（Kotlin 闭包目录）';
      }
      if (lang === 'js-ts' && hasSrc) {
        return '不能传 --src：--lang js-ts 不需要 --src（harness 自包含，源根=--main 所在目录）';
      }
      if (lang !== '' && lang !== 'jvm' && lang !== 'js-ts') {
        return '不支持的 lang：' + lang + '（可选 jvm / js-ts）';
      }
      return null;
    },
  },
  {
    name: 'verify-fidelity',
    script: 'cli/verify-fidelity.ts',
    description: '保真度门禁：golden 与 actual 逐项比对（必须 100%）',
    args: [
      arg('golden', '--golden', 'string', 'golden JSON', true),
      arg('actual', '--actual', 'string', 'actual JSON', true),
      arg('key', '--key', 'string', '场景 key 字段名（默认 scenario）'),
      arg('items', '--items', 'string', '页数组字段名（默认 pages）'),
      arg('field', '--field', 'string', '比较字段名（默认 text）'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      HELP_ARG,
    ],
  },
  {
    name: 'adapt-arkts',
    script: 'cli/adapt-arkts.ts',
    description: 'ArkTS 机械适配 codemod（只动类型层）',
    args: [
      arg('src', '--src', 'string', 'TS 输入目录', true),
      arg('out', '--out', 'string', '输出目录', true),
      arg('ets', '--ets', 'boolean', '输出 .ets 并去掉相对 import 的 .ts 后缀'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('failOnResidual', '--fail-on-residual', 'boolean', '有 residual 时 exit 3'),
      HELP_ARG,
    ],
  },
  {
    name: 'diff-gate',
    script: 'cli/diff-gate.ts',
    description: '适配 diff 门禁：只允许 type-only / import-path 变更',
    args: [
      arg('before', '--before', 'string', '变更前目录', true),
      arg('after', '--after', 'string', '变更后目录', true),
      arg('strict', '--strict', 'boolean', 'needs-review>0 时 exit 1'),
      arg('max', '--max', 'number', '最多打印条数'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      HELP_ARG,
    ],
  },
  {
    name: 'explain-errors',
    script: 'cli/explain-errors.ts',
    description: '把 ArkTS 错误变成规则/位置/修法锚点清单',
    args: [
      arg('log', '--log', 'string', 'hvigor 日志或 errors JSON', true),
      arg('root', '--root', 'string', '源码根目录'),
      arg('rule', '--rule', 'string', '按规则过滤（支持 *）'),
      arg('max', '--max', 'number', '最多打印条数'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      HELP_ARG,
    ],
  },
  {
    name: 'lint-arkts',
    script: 'cli/lint-arkts.ts',
    description: '在工程内构建并把 ArkTS 错误按规则分类',
    args: [
      arg('project', '--project', 'string', '鸿蒙工程目录', true),
      arg('sdk', '--sdk', 'string', 'OpenHarmony SDK 根'),
      arg('hvigor', '--hvigor', 'string', 'hvigor node_modules 目录'),
      arg('log', '--log', 'string', '日志输出路径'),
      arg('logInProject', '--log-in-project', 'boolean', '日志写工程内 .arkts-lint.log'),
      arg('noClean', '--no-clean', 'boolean', '不清理构建产物'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      HELP_ARG,
    ],
  },
  {
    name: 'reachability-probe',
    script: 'cli/reachability-probe.ts',
    description: '全量可达性门禁：临时副本注入探针后构建',
    args: [
      arg('project', '--project', 'string', '鸿蒙工程目录', true),
      arg('sdk', '--sdk', 'string', 'OpenHarmony SDK 根'),
      arg('hvigor', '--hvigor', 'string', 'hvigor node_modules 目录'),
      arg('src', '--src', 'string', '工程内 .ets 根（默认 entry/src/main/ets）'),
      arg('entry', '--entry', 'string', '入口页（默认 pages/Index.ets）'),
      arg('keep', '--keep', 'boolean', '保留临时副本'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      HELP_ARG,
    ],
  },
  {
    name: 'build-hap',
    script: 'cli/build-hap.ts',
    description: '构建 HAP（不签名；BUILD SUCCESSFUL 即通过）',
    args: [
      arg('project', '--project', 'string', '鸿蒙工程目录', true),
      arg('mode', '--mode', 'string', 'debug/release'),
      arg('sdk', '--sdk', 'string', 'OpenHarmony SDK 根'),
      arg('hvigor', '--hvigor', 'string', 'hvigor node_modules 目录'),
      arg('log', '--log', 'string', '构建日志路径'),
      HELP_ARG,
    ],
  },
  {
    name: 'device-test',
    script: 'cli/device-test.ts',
    description: '真机检查/安装/启动：check/install/launch/hilog/screenshot；install 失败按 errorCode 给 AGC 修法，不绕过签名',
    args: [
      arg('target', '--target', 'string', '真机地址（ip:port，hdc tconn 用）', true),
      arg('hap', '--hap', 'string', '要安装的 .hap（必须与 install 同用）'),
      arg('install', '--install', 'boolean', '执行 hdc install -r；失败解析错误码并给官方修法'),
      arg('bundle', '--bundle', 'string', '启动的 bundleName（给了才 launch）'),
      arg('ability', '--ability', 'string', '启动的 abilityName（默认 EntryAbility）'),
      arg('check', '--check', 'boolean', '只检查连接与系统信息（不安装、不启动）'),
      arg('screenshot', '--screenshot', 'string', '截图保存到本地路径'),
      arg('hilogFilter', '--hilog-filter', 'string', '在内置过滤之外追加 hilog 正则'),
      arg('hdc', '--hdc', 'string', 'hdc 可执行文件（默认 $HDC > SDK toolchains > PATH）'),
      arg('log', '--log', 'string', '命令日志路径（默认 out/logs/device-test.log）'),
      arg('timeout', '--timeout', 'number', '单条 hdc 命令超时 ms（默认 60000，0=不超时）'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      HELP_ARG,
    ],
  },
  {
    name: 'port',
    script: 'cli/port.ts',
    description: '门禁编排器：一条命令按序跑流水线阶段，日志落盘 + 报告 JSON',
    args: [
      arg('project', '--project', 'string', '鸿蒙工程目录'),
      arg('case', '--case', 'string', '案例目录（fidelity）'),
      arg('src', '--src', 'string', '上游源码目录（analyze）'),
      arg('adaptSrc', '--adapt-src', 'string', 'adapt 输入目录（默认 --src）'),
      arg('adapted', '--adapted', 'string', 'adapt 输出目录'),
      arg('actual', '--actual', 'string', 'fidelity 的 actual JSON'),
      arg('sdk', '--sdk', 'string', 'OpenHarmony SDK 根'),
      arg('hvigor', '--hvigor', 'string', 'hvigor node_modules 目录'),
      arg('stages', '--stages', 'string', '阶段子集（analyze,adapt,diff,fidelity,lint,reach,build|all）'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      arg('logs', '--logs', 'string', '日志目录'),
      arg('mode', '--mode', 'string', 'build 模式 debug/release'),
      arg('timeout', '--timeout', 'number', '单阶段超时 ms'),
      arg('lang', '--lang', 'string', 'analyze 的语言 id'),
      arg('etsSrc', '--ets-src', 'string', 'reach 的工程内 .ets 根'),
      arg('entry', '--entry', 'string', 'reach 的入口页'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('continue', '--continue', 'boolean', 'FAIL 后继续跑后续阶段'),
      arg('strictDiff', '--strict-diff', 'boolean', 'diff 阶段 WARN 视为 FAIL'),
      arg('allowResiduals', '--allow-residuals', 'boolean', 'adapt 允许 residual>0 仍 PASS'),
      arg('noEts', '--no-ets', 'boolean', 'adapt 输出保持 .ts'),
      arg('noReplay', '--no-replay', 'boolean', 'fidelity 不尝试 replay.ts 重放'),
      HELP_ARG,
    ],
  },
  {
    name: 'docs-metrics',
    script: 'cli/docs-metrics.ts',
    description: 'canonical metrics + 文档数字一致性检查',
    args: [
      arg('case', '--case', 'string', '案例目录', true),
      arg('refs', '--refs', 'string', '外部证据根目录'),
      arg('coverage', '--coverage', 'string', 'analyze-coupling --json 输出'),
      arg('check', '--check', 'string', '逗号分隔的文档列表'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('report', '--report', 'string', 'JSON 报告路径'),
      HELP_ARG,
    ],
  },
  {
    name: 'stage-case',
    script: 'scripts/stage-case.mjs',
    description: '把外部证据（.refs 里的 TS 产物）复制进工作区并校验 sha256',
    args: [
      arg('refs', '--refs', 'string', '外部证据根目录'),
      arg('case', '--case', 'string', '案例目录'),
      arg('dest', '--dest', 'string', '复制目标（默认 <case>/ts）'),
      arg('check', '--check', 'boolean', '只校验，不复制'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      HELP_ARG,
    ],
  },
  {
    name: 'acceptance',
    script: 'scripts/acceptance.mjs',
    description: '端到端验收：stage/golden/replay/adapt/arkts-gate 一条命令回归',
    args: [
      arg('refs', '--refs', 'string', '外部证据根目录'),
      arg('sdk', '--sdk', 'string', 'OpenHarmony SDK 根'),
      arg('hvigor', '--hvigor', 'string', 'hvigor node_modules 目录'),
      arg('out', '--out', 'string', '输出目录（默认 out/acceptance）'),
      arg('json', '--json', 'boolean', '输出结构化 JSON'),
      arg('skipBuild', '--skip-build', 'boolean', '跳过 arkts-gate'),
      arg('keep', '--keep', 'boolean', '保留工程副本'),
      HELP_ARG,
    ],
  },
];

const USAGE = [
  '用法：',
  '  node cli/mcp-server.ts [--cwd <dir>] [--allow <tool,...>] [--timeout <ms>] [--help]',
  '',
  'MCP 薄包装：JSON-RPC 2.0 over stdio（每行一个 JSON），只转发到现有 CLI，不复制逻辑。',
  '支持 initialize / notifications/initialized / ping / tools/list / tools/call。',
  '',
  '参数：',
  '  --cwd <dir>       子进程工作目录（默认当前目录；必须是已存在目录）',
  '  --allow <a,b>     只暴露这些工具（逗号分隔；必须是已知工具名）',
  '  --timeout <ms>    单次工具调用超时（默认 ' + DEFAULT_TIMEOUT_MS + '）',
  '  --help, -h        打印本帮助',
  '',
  '暴露的工具（' + TOOLS.length + ' 个）：' + TOOLS.map((tool) => tool.name).join(', '),
].join('\n');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const VALUE_OPTS = new Set(['cwd', 'allow', 'timeout']);
const BOOL_OPTS = new Set(['help']);

function failUsage(message: string): never {
  console.error('mcp-server: ' + message);
  console.error('用法见：node cli/mcp-server.ts --help');
  process.exit(2);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const raw: Record<string, string | boolean> = {};
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function buildOptions(raw: Record<string, string | boolean>): CliOptions {
  const cwdRaw = typeof raw.cwd === 'string' ? raw.cwd : '.';
  const cwd = resolve(process.cwd(), cwdRaw);
  if (!isDirectory(cwd)) failUsage('--cwd 目录不存在：' + cwdRaw);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof raw.timeout === 'string') {
    const parsed = Number(raw.timeout);
    if (!Number.isInteger(parsed) || parsed <= 0) failUsage('--timeout 必须是正整数（毫秒）：' + raw.timeout);
    timeoutMs = parsed;
  }
  let allow: string[] | null = null;
  if (typeof raw.allow === 'string') {
    const names = raw.allow.split(',').map((name) => name.trim()).filter((name) => name !== '');
    if (names.length === 0) failUsage('--allow 不能为空');
    const known = new Set(TOOLS.map((tool) => tool.name));
    for (const name of names) {
      if (!known.has(name)) failUsage('--allow 里有未知工具：' + name + '（可用：' + [...known].join(',') + '）');
    }
    allow = names;
  }
  return { cwd: cwd, allow: allow, timeoutMs: timeoutMs };
}

function allowedTools(options: CliOptions): ToolSpec[] {
  if (options.allow === null) return TOOLS;
  const set = new Set(options.allow);
  return TOOLS.filter((tool) => set.has(tool.name));
}

// ---------------------------------------------------------------------------
// MCP 协议
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaOf(tool: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const item of tool.args) {
    if (item.type === 'boolean') {
      properties[item.name] = { type: 'boolean', description: item.description };
    } else if (item.type === 'number') {
      properties[item.name] = { type: 'number', description: item.description };
    } else if (item.type === 'strings') {
      properties[item.name] = { type: 'array', items: { type: 'string' }, description: item.description };
    } else {
      properties[item.name] = { type: 'string', description: item.description };
    }
    if (item.required === true) required.push(item.name);
  }
  const schema: Record<string, unknown> = { type: 'object', properties: properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } };
}

function okResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result: result };
}

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + '\n…（已截断 ' + (text.length - MAX_TEXT_CHARS) + ' 字符；完整输出见 CLI 日志）';
}

function textResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text: truncate(text) }], isError: isError };
}

function callTool(options: CliOptions, tool: ToolSpec, rawArgs: unknown): Record<string, unknown> | Record<string, unknown> {
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (!isObject(args)) return textResult('工具参数必须是对象', true);
  const specByName = new Map<string, ArgSpec>();
  for (const item of tool.args) specByName.set(item.name, item);
  const unknownKeys = Object.keys(args).filter((key) => !specByName.has(key));
  if (unknownKeys.length > 0) {
    return textResult('未知参数：' + unknownKeys.join(', ') + '（' + tool.name + ' 支持：' +
      tool.args.map((item) => item.name).join(', ') + '）', true);
  }

  // help=true 只是看用法，不要求业务必填参数（否则 --help 也需要 target/src 等）
  const helpRequested = args.help === true;
  const argv: string[] = [];
  const missing: string[] = [];
  for (const item of tool.args) {
    const value = args[item.name];
    if (item.required === true && !helpRequested && (value === undefined || value === null)) {
      missing.push(item.name + '（' + item.flag + '）');
      continue;
    }
    if (value === undefined || value === null) continue;
    if (item.type === 'boolean') {
      if (typeof value !== 'boolean') return textResult('参数 ' + item.name + ' 必须是 boolean', true);
      if (value === true) argv.push(item.flag);
      continue;
    }
    if (item.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return textResult('参数 ' + item.name + ' 必须是 number', true);
      argv.push(item.flag, String(value));
      continue;
    }
    if (item.type === 'strings') {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        return textResult('参数 ' + item.name + ' 必须是 string 数组', true);
      }
      for (const entry of value) argv.push(item.flag, String(entry));
      continue;
    }
    if (typeof value !== 'string') return textResult('参数 ' + item.name + ' 必须是 string', true);
    argv.push(item.flag, value);
  }
  if (missing.length > 0) {
    return textResult('缺少必填参数：' + missing.join(', '), true);
  }
  if (!helpRequested && tool.validate !== undefined) {
    const validation = tool.validate(args);
    if (validation !== null) return textResult(validation, true);
  }

  const scriptPath = join(repoRoot, tool.script);
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs,
    env: process.env,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  const timedOut = res.error !== undefined && res.error !== null && (res.error as { code?: string }).code === 'ETIMEDOUT';
  const spawnError = res.error !== undefined && res.error !== null && !timedOut
    ? String((res.error as { message?: string }).message ?? res.error)
    : null;
  const exitCode = res.status;

  let text = stdout.trim();
  if (text === '') text = stderr.trim();
  const isError = timedOut || spawnError !== null || exitCode !== 0;
  if (isError) {
    if (timedOut) text = '工具调用超时（' + options.timeoutMs + 'ms）：' + (stderr.trim() || stdout.trim());
    else if (spawnError !== null) text = '无法启动 CLI：' + spawnError;
    else if (stderr.trim() !== '' && text !== stderr.trim()) text += '\n[stderr]\n' + stderr.trim();
    text += '\n[exit ' + String(exitCode) + ']';
  }
  return { content: [{ type: 'text', text: truncate(text) }], isError: isError };
}

function handleInitialize(params: unknown): Record<string, unknown> {
  const requested = isObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = PROTOCOL_VERSIONS.indexOf(requested) >= 0 ? requested : DEFAULT_PROTOCOL;
  return {
    protocolVersion: protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: 'arkts-port 薄包装：只转发 CLI；优先用 --json 拿结构化结果，避免回读长日志。',
  };
}

function handleToolsCall(options: CliOptions, params: unknown): Record<string, unknown> {
  if (!isObject(params) || typeof params.name !== 'string' || params.name === '') {
    return errorResponse(undefined, -32602, 'tools/call 缺少 name');
  }
  const tool = TOOLS.find((entry) => entry.name === params.name);
  if (tool === undefined) return errorResponse(undefined, -32602, '未知工具：' + params.name);
  if (options.allow !== null && options.allow.indexOf(tool.name) < 0) {
    return errorResponse(undefined, -32602, '工具未在 --allow 白名单内：' + tool.name);
  }
  const result = callTool(options, tool, params.arguments);
  return okResponse(undefined, result);
}

function dispatch(options: CliOptions, message: unknown): Record<string, unknown> | null {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return errorResponse(undefined, -32600, 'Invalid Request');
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null;
  const method = message.method;
  const params = message.params;
  if (!hasId) {
    // notifications/initialized 等通知：无响应
    return null;
  }
  const id = message.id;
  try {
    if (method === 'initialize') return okResponse(id, handleInitialize(params));
    if (method === 'ping') return okResponse(id, {});
    if (method === 'tools/list') {
      return okResponse(id, {
        tools: allowedTools(options).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: schemaOf(tool),
        })),
      });
    }
    if (method === 'tools/call') {
      const handled = handleToolsCall(options, params);
      if (handled['error'] !== undefined) {
        // 把 name 校验错误挂回请求 id
        return { jsonrpc: '2.0', id: id, error: handled['error'] };
      }
      return { jsonrpc: '2.0', id: id, result: handled['result'] };
    }
    return errorResponse(id, -32601, '未知 method：' + method);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    return errorResponse(id, -32603, '内部错误：' + messageText);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main(): void {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.help === true) {
    console.log(USAGE);
    process.exit(0);
  }
  const options = buildOptions(raw);

  process.stdin.setEncoding('utf8');
  let buffer = '';
  const write = (payload: unknown): void => {
    process.stdout.write(JSON.stringify(payload) + '\n');
  };
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        write(errorResponse(undefined, -32700, 'Parse error'));
        continue;
      }
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const response = dispatch(options, item);
          if (response !== null) write(response);
        }
        continue;
      }
      const response = dispatch(options, parsed);
      if (response !== null) write(response);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
