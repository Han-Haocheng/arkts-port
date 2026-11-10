import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 子进程 JSON-RPC 客户端直测 cli/mcp-server.ts；不依赖真实 SDK/.refs。 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverScript = join(repoRoot, 'cli', 'mcp-server.ts');

interface TestHooks {
  after(fn: () => void): void;
}

interface RpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolInfo {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; items?: { type: string } }>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

class McpClient {
  private child: ChildProcess;
  private buffer = '';
  private pending = new Map<number, (response: RpcResponse) => void>();
  private strayQueue: RpcResponse[] = [];
  private strayResolvers: ((response: RpcResponse) => void)[] = [];
  private nextId = 1;

  constructor(args: string[], cwd: string, env?: Record<string, string>) {
    const childEnv = env === undefined ? process.env : Object.assign({}, process.env, env);
    this.child = spawn(process.execPath, [serverScript, ...args], { cwd: cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = this.child.stdout;
    const stdin = this.child.stdin;
    if (stdout === null || stdin === null) throw new Error('子进程 stdio 不可用');
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line === '') continue;
        const message = JSON.parse(line) as RpcResponse;
        if (typeof message.id === 'number') {
          const resolve = this.pending.get(message.id);
          if (resolve !== undefined) {
            this.pending.delete(message.id);
            resolve(message);
          }
        } else {
          const resolver = this.strayResolvers.shift();
          if (resolver !== undefined) resolver(message);
          else this.strayQueue.push(message);
        }
      }
    });
  }

  request(method: string, params?: unknown): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP 响应超时：' + method)), 60000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.write({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method: method, params: params });
  }

  raw(line: string): void {
    this.writeLine(line);
  }

  nextStray(): Promise<RpcResponse> {
    const queued = this.strayQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待非请求响应超时')), 10000);
      this.strayResolvers.push((response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  close(): void {
    const stdin = this.child.stdin;
    if (stdin !== null) stdin.end();
    this.child.kill();
  }

  private write(payload: unknown): void {
    this.writeLine(JSON.stringify(payload));
  }

  private writeLine(line: string): void {
    const stdin = this.child.stdin;
    if (stdin === null) throw new Error('stdin 不可用');
    stdin.write(line + '\n');
  }
}

function withServer(t: TestHooks, args: string[] = [], cwd: string = repoRoot, env?: Record<string, string>): McpClient {
  const client = new McpClient(args, cwd, env);
  t.after(() => client.close());
  return client;
}

function toolByName(tools: ToolInfo[], name: string): ToolInfo {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, 'tools/list 里缺少工具：' + name);
  return found;
}

function textOf(response: RpcResponse): string {
  const result = response.result as { content?: { type: string; text: string }[]; isError?: boolean } | undefined;
  assert.ok(result !== undefined && Array.isArray(result.content), '应有 content 数组');
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
}

function isErrorOf(response: RpcResponse): boolean {
  const result = response.result as { isError?: boolean } | undefined;
  assert.ok(result !== undefined, '应有 result');
  return result.isError === true;
}

const EXPECTED_TOOLS = [
  'doctor', 'analyze-coupling', 'extract-closure', 'pack-context', 'gen-golden',
  'verify-fidelity', 'adapt-arkts', 'diff-gate', 'explain-errors', 'lint-arkts',
  'reachability-probe', 'build-hap', 'device-test', 'port', 'docs-metrics', 'stage-case', 'acceptance',
];

// ---------------------------------------------------------------------------
// initialize / tools/list
// ---------------------------------------------------------------------------

test('initialize：返回 MCP 1.x 字段与 tools 能力', async (t) => {
  const client = withServer(t);
  const response = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });
  assert.equal(response.error, undefined);
  const result = response.result as Record<string, any>;
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.equal(typeof result.capabilities.tools, 'object');
  assert.equal(result.serverInfo.name, 'arkts-port');
  assert.equal(typeof result.serverInfo.version, 'string');
});

test('initialize：未知 protocolVersion 回落到默认版本', async (t) => {
  const client = withServer(t);
  const response = await client.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal((response.result as Record<string, any>).protocolVersion, '2024-11-05');
});

test('tools/list：17 个工具，name/description/inputSchema 齐全且与 --help 一致', async (t) => {
  const client = withServer(t);
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  client.notify('notifications/initialized');
  const response = await client.request('tools/list');
  const tools = (response.result as { tools: ToolInfo[] }).tools;
  assert.equal(tools.length, 17);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, tool.name + ' 缺 description');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(Object.keys(tool.inputSchema.properties).includes('help'), tool.name + ' 应有 help 参数');
  }

  const genGolden = toolByName(tools, 'gen-golden');
  // js-ts 不需要 --src：schema 里 src 必须是非必填（否则 MCP 会让 js-ts 调用缺参）
  assert.deepEqual([...(genGolden.inputSchema.required ?? [])].sort(), ['lang']);
  assert.match(genGolden.description, /jvm/);
  assert.match(genGolden.description, /js-ts/);
  assert.match(String(genGolden.inputSchema.properties.src.description), /js-ts 不要传/);
  const buildHap = toolByName(tools, 'build-hap');
  assert.equal('json' in buildHap.inputSchema.properties, false, 'build-hap 没有 --json，不应暴露 json');
  const doctor = toolByName(tools, 'doctor');
  assert.deepEqual(
    Object.keys(doctor.inputSchema.properties).sort(),
    ['case', 'help', 'hvigor', 'json', 'project', 'report', 'sdk'],
  );

  const deviceTest = toolByName(tools, 'device-test');
  assert.deepEqual([...(deviceTest.inputSchema.required ?? [])], ['target']);
  assert.match(deviceTest.description, /真机/);
  assert.match(deviceTest.description, /errorCode/);
  assert.match(deviceTest.description, /不绕过签名/);
  assert.deepEqual(
    Object.keys(deviceTest.inputSchema.properties).sort(),
    ['ability', 'bundle', 'check', 'hap', 'hdc', 'help', 'hilogFilter', 'install', 'json', 'log', 'report', 'screenshot', 'target', 'timeout'],
  );
  assert.equal(deviceTest.inputSchema.properties.check.type, 'boolean');
  assert.equal(deviceTest.inputSchema.properties.install.type, 'boolean');
});

// ---------------------------------------------------------------------------
// tools/call：成功路径（help 透传 / --json 透传）
// ---------------------------------------------------------------------------

test('tools/call：doctor help=true 透传 --help，exit 0 且 isError=false', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', { name: 'doctor', arguments: { help: true } });
  assert.equal(response.error, undefined);
  assert.equal(isErrorOf(response), false);
  const text = textOf(response);
  assert.match(text, /用法/);
  assert.match(text, /doctor/);
});

test('tools/call：docs-metrics --json 透传，返回可解析 JSON', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', {
    name: 'docs-metrics',
    arguments: { case: 'cases/legado', json: true },
  });
  assert.equal(isErrorOf(response), false);
  const parsed = JSON.parse(textOf(response)) as Record<string, any>;
  assert.equal(parsed.ok, true);
  assert.equal(parsed.case.golden.scenarios, 16);
  assert.equal(parsed.case.golden.pages, 62);
});

test('tools/call：verify-fidelity 真实比对 cases/legado，pass=true', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', {
    name: 'verify-fidelity',
    arguments: { golden: 'cases/legado/golden.json', actual: 'cases/legado/actual.json', json: true },
  });
  assert.equal(isErrorOf(response), false);
  const parsed = JSON.parse(textOf(response)) as Record<string, any>;
  assert.equal(parsed.pass, true);
  assert.equal(parsed.fidelityPct, 100);
});

test('tools/call gen-golden js-ts：不需要 src，两次 golden 逐字节稳定', async (t) => {
  const client = withServer(t);
  const dir = mkdtempSync(join(tmpdir(), 'arkts-port-mcp-js-ts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runAt = async (outDir: string) => {
    const response = await client.request('tools/call', {
      name: 'gen-golden',
      arguments: {
        lang: 'js-ts',
        main: 'tests/fixtures/mcp/harness.mjs',
        out: outDir,
        logs: join(dir, 'logs'),
        json: true,
      },
    });
    assert.equal(isErrorOf(response), false, textOf(response));
    return JSON.parse(textOf(response)) as Record<string, any>;
  };
  const first = await runAt(join(dir, 'golden-a'));
  const second = await runAt(join(dir, 'golden-b'));
  assert.equal(first.lang, 'js-ts');
  assert.equal(first.src, null);
  assert.equal(first.stable, true);
  assert.equal(typeof first.goldenSha256, 'string');
  assert.equal(first.goldenSha256, second.goldenSha256, '两次运行 golden 必须逐字节一致');
  assert.ok(existsSync(join(dir, 'golden-a', 'golden.json')));
  assert.equal(first.goldenPath.endsWith('golden.json'), true);
});

test('tools/call gen-golden 联动校验：jvm 缺 src / js-ts 传 src / 未知 lang → isError', async (t) => {
  const client = withServer(t);
  const missingSrc = await client.request('tools/call', {
    name: 'gen-golden',
    arguments: { lang: 'jvm' },
  });
  assert.equal(isErrorOf(missingSrc), true);
  assert.match(textOf(missingSrc), /缺少 --src/);

  const srcWithJsTs = await client.request('tools/call', {
    name: 'gen-golden',
    arguments: { lang: 'js-ts', src: 'cases/legado', main: 'tests/fixtures/mcp/harness.mjs' },
  });
  assert.equal(isErrorOf(srcWithJsTs), true);
  assert.match(textOf(srcWithJsTs), /不能传 --src/);
  assert.match(textOf(srcWithJsTs), /js-ts/);

  const badLang = await client.request('tools/call', {
    name: 'gen-golden',
    arguments: { lang: 'kotlin' },
  });
  assert.equal(isErrorOf(badLang), true);
  assert.match(textOf(badLang), /不支持的 lang/);
});

test('tools/call device-test help=true 透传 --help（不需要 target）', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', {
    name: 'device-test',
    arguments: { help: true },
  });
  assert.equal(isErrorOf(response), false);
  const text = textOf(response);
  assert.match(text, /--target/);
  assert.match(text, /--check/);
  assert.match(text, /不绕过签名/);
});

test('tools/call device-test 缺 target：isError 且不碰设备', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', {
    name: 'device-test',
    arguments: { check: true },
  });
  assert.equal(isErrorOf(response), true);
  const text = textOf(response);
  assert.match(text, /缺少必填参数/);
  assert.match(text, /target/);
});

test('tools/call device-test check：参数拼装正确（fake hdc；无设备时 isError 带 [exit 1] 不崩）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arkts-port-mcp-device-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeHdc = join(dir, 'fake-hdc.sh');
  writeFileSync(fakeHdc, '#!/bin/sh\necho "fake hdc: no device (10.42.0.48:40135)" >&2\nexit 1\n', 'utf8');
  chmodSync(fakeHdc, 0o755);
  const logPath = join(dir, 'device-test.log');
  const client = withServer(t, [], repoRoot, { HDC: fakeHdc });
  const response = await client.request('tools/call', {
    name: 'device-test',
    arguments: { target: '10.42.0.48:40135', check: true, log: logPath, timeout: 5000 },
  });
  assert.equal(isErrorOf(response), true, '无设备时应 isError=true');
  const text = textOf(response);
  assert.match(text, /\[exit 1\]/);
  assert.doesNotMatch(text, /Cannot find module|未捕获/);

  // 参数拼装：确实执行了 hdc tconn <target>，且 --check 模式不产生 install
  const logText = readFileSync(logPath, 'utf8');
  assert.match(logText, /tconn 10\.42\.0\.48:40135/);
  assert.doesNotMatch(logText, /## install/);
  assert.match(logText, /# hdc: /);
  assert.match(logText, /# target: 10\.42\.0\.48:40135/);
});

// ---------------------------------------------------------------------------
// 错误路径：未知工具 / 白名单 / 缺参数 / 未知参数 / CLI 失败 / 超时
// ---------------------------------------------------------------------------

test('未知工具：JSON-RPC error -32602', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', { name: 'no-such-tool', arguments: {} });
  assert.equal(response.result, undefined);
  assert.equal((response.error as { code: number }).code, -32602);
  assert.match((response.error as { message: string }).message, /未知工具/);
});

test('--allow 白名单：tools/list 只列白名单，调用其它工具报 -32602', async (t) => {
  const client = withServer(t, ['--allow', 'doctor']);
  const list = await client.request('tools/list');
  const tools = (list.result as { tools: ToolInfo[] }).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['doctor']);
  const blocked = await client.request('tools/call', { name: 'analyze-coupling', arguments: { root: '.' } });
  assert.equal((blocked.error as { code: number }).code, -32602);
  assert.match((blocked.error as { message: string }).message, /白名单/);
});

test('缺必填参数：isError=true 并说明缺什么', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', { name: 'gen-golden', arguments: {} });
  assert.equal(isErrorOf(response), true);
  const text = textOf(response);
  assert.match(text, /缺少必填参数/);
  assert.match(text, /lang/);
});

test('未知参数：isError=true 且列出该工具支持的参数（不静默忽略）', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', { name: 'doctor', arguments: { bogus: true } });
  assert.equal(isErrorOf(response), true);
  const text = textOf(response);
  assert.match(text, /未知参数：bogus/);
  assert.match(text, /project/);
});

test('CLI 非 0 退出：isError=true 且末尾带 [exit N]', async (t) => {
  const client = withServer(t);
  const response = await client.request('tools/call', {
    name: 'doctor',
    arguments: { project: '/nonexistent-arkts-port-xyz' },
  });
  assert.equal(isErrorOf(response), true);
  assert.match(textOf(response), /\[exit 1\]/);
});

test('--timeout：超时调用返回 isError=true 且写明超时', async (t) => {
  const client = withServer(t, ['--timeout', '1']);
  const response = await client.request('tools/call', {
    name: 'analyze-coupling',
    arguments: { listLangs: true },
  });
  assert.equal(isErrorOf(response), true);
  assert.match(textOf(response), /超时/);
});

test('--cwd：子进程工作目录被限制在该目录（root="." 只扫到本地文件）', async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'arkts-port-mcp-cwd-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  mkdirSync(join(sandbox, 'src'), { recursive: true });
  writeFileSync(join(sandbox, 'src', 'A.kt'), 'package a;\n\nfun a() = 1\n', 'utf8');
  const client = withServer(t, ['--cwd', sandbox]);
  const response = await client.request('tools/call', {
    name: 'analyze-coupling',
    arguments: { root: '.', lang: 'jvm', json: true },
  });
  assert.equal(isErrorOf(response), false);
  const parsed = JSON.parse(textOf(response)) as Record<string, any>;
  assert.equal(parsed.files, 1);
  assert.ok(typeof parsed.totalLoc === 'number' && parsed.totalLoc >= 3);
});

// ---------------------------------------------------------------------------
// 协议错误 / 用法错误
// ---------------------------------------------------------------------------

test('非法 JSON：-32700 且随后请求仍正常', async (t) => {
  const client = withServer(t);
  client.raw('this is not json');
  const stray = await client.nextStray();
  assert.equal((stray.error as { code: number }).code, -32700);
  const response = await client.request('ping');
  assert.deepEqual(response.result, {});
});

test('未知 method：-32601', async (t) => {
  const client = withServer(t);
  const response = await client.request('resources/list');
  assert.equal((response.error as { code: number }).code, -32601);
});

test('通知（无 id）不产生响应', async (t) => {
  const client = withServer(t);
  client.notify('notifications/initialized');
  client.notify('notifications/whatever');
  const response = await client.request('ping');
  assert.deepEqual(response.result, {});
});

test('用法错误 exit 2；--help exit 0', () => {
  const good = spawnSync(process.execPath, [serverScript, '--help'], { encoding: 'utf8' });
  assert.equal(good.status, 0);
  assert.match(good.stdout, /node cli\/mcp-server\.ts/);

  const cases: string[][] = [
    ['--bogus'],
    ['--cwd'],
    ['--cwd', '/nonexistent-arkts-port-xyz'],
    ['--allow', 'nope'],
    ['--timeout', 'abc'],
  ];
  for (const args of cases) {
    const res = spawnSync(process.execPath, [serverScript, ...args], { encoding: 'utf8' });
    assert.equal(res.status, 2, '应 exit 2：' + JSON.stringify(args));
    assert.match(res.stderr, /mcp-server: /);
  }
});
