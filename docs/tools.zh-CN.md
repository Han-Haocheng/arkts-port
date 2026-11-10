# 工具

[文档索引](README.md) · [English](tools.md)

本仓库共暴露 **23 个入口**：`cli/` 中的 21 个 TypeScript CLI，加上 `scripts/` 中的 2 个 Node 脚本。它们全部运行在 Node >= 22 上，没有运行时依赖，也没有构建步骤。每个入口都支持 `--help`；未知或格式错误的选项以退出码 2 结束。

报告是确定性的 JSON。除非另有说明，`--json` 会把报告写到 stdout，`--report <path>` 会把同一份报告写入文件。下文的路径使用占位符：`<project>` 表示 HarmonyOS 工程，`<sdk>` 表示 OpenHarmony SDK，`<hvigor>` 表示 hvigor 的 `node_modules` 目录，`<refs>` 表示外部 case 证据，`<case>` 表示 case 目录。

## 1. 准备

| 入口 | 用途 | 关键 flag | 退出码 |
|---|---|---|---|
| `cli/analyze-coupling.ts` | 分诊：统计未与原平台耦合的源文件数与行数，计算可自动转换占比，并对模块排序。 | `--root`, `--lang`, `--top`, `--json`, `--list-langs` | 0 成功；2 用法错误或无匹配文件 |
| `cli/triage-boundary.ts` | 对 Kotlin 文件做边界拆分分诊：按平台耦合、依赖面、UI 标记与行数归入 `splittable-candidate`、`boundary-only`、`ui`、`not-worth`，输出漏斗计数与 top-N 候选。 | `--root`, `--json`/`--md`, `--out`, `--min-lines`（默认 100）, `--top`（默认 8） | 0 成功；1 读写失败；2 用法错误 |
| `cli/assess-conversion.ts` | 四类转换占比评估（automated / semi-automated / manual / non-convertible），规则来自 `rules/conversion-share.json` v1.1；报告 `ruleVersion` 与 `ruleSha256`；只评估，绝不转换。默认 `conservative`（6.67 / 12.80 / 78.01 / 2.52）；`broad` 保留旧 v1.0 口径（11.81 / 24.66 / 60.75 / 2.78）；`--production-only` 把分母收窄到 2,093 文件 / 402,755 行。 | `--root`, `--lang`（`jvm`）, `--profile`（`broad` 或 `conservative`；默认 `conservative`）, `--production-only`, `--json`/`--md`, `--out` | 0 评估完成；1 不变量被破坏（`unclassified` > 0、四类合计不等于 100%、`conservative` 对齐失败，或 `broad` 下 `automated` 超出 `analyze-coupling` 的 auto 占比）；2 用法错误 |
| `cli/doctor.ts` | 13 项预检：SDK 布局、hvigor、`build-profile.json5`、版本字符串、`runtimeOS`、`deviceTypes`、入口文件、`NODE_HOME`、环境对齐以及 case 数据。 | `--project`, `--sdk`, `--hvigor`, `--case`, `--json`, `--report` | 0 无 FAIL（允许 WARN）；1 FAIL；2 用法错误 |
| `cli/extract-closure.ts` | 从入口提取最小依赖闭包。将文件归类为 `include`、`coupled` 边界与 `test` 文件；报告未解析符号、可移除导入与别名。 | `--root`, `--entry`, `--lang`, `--out`, `--allow-out-in-root`, `--report`, `--json`, `--no-package-complete`, `--no-alias`, `--force` | 0 成功；1 入口不可读；2 用法错误 |
| `cli/pack-context.ts` | 构建确定性的 Markdown 上下文包：文件清单、不含函数体的签名索引、`F32:` 标记，以及超过 `--max-bytes` 时按固定名称分片。 | `--closure`, `--lang`, `--out`, `--max-bytes`, `--exclude`, `--no-members`, `--json`, `--report` | 0 成功；1 读取失败；2 用法错误 |
| `cli/gen-golden.ts` | 编译并运行原实现两次；仅当两次运行逐字节一致时才写出 `golden.json`。JVM 使用 `kotlinc`/`kotlin`；JS/TS 运行 Node harness。`--manual-extractions` 把 boundary 符号映射到 stub 或替换片段，先复制到 `<out>/.src-manual` 再编译；未解析引用会 fail-closed，不写出 golden。 | `--lang`（`jvm` 或 `js-ts`）, `--src`（JVM）, `--main`, `--package`, `--manual-extractions`（JVM）, `--out`, `--logs`, `--timeout`, `--json`, `--report` | 0 稳定；1 编译/运行失败；2 用法错误；3 输出不稳定；4 缺少 harness |

说明：

- `extract-closure --out` 可位于 `--root` 之外，也可位于其顶层安全子目录（`.refs/`、`out/`、`dist/`、`build/`）；其它子目录需 `--allow-out-in-root`，`--force` 等价但会告警。工具会维护清单，并删除它此前写出的过期文件；它从不删除非受管文件。
- `pack-context` 的输出不含时间戳或绝对路径，因此相同输入会产生逐字节一致的包。
- `gen-golden --out` 与 `--logs` 必须位于源码根之外（JVM：`--src`；JS/TS：包含 `--main` 的目录）。`--main` 必须位于 `--src` 目录内（JVM），否则主类会落在编译目录之外。缺少 harness 时会在 `templates/` 下生成脚手架并以退出码 4 结束。

## 2. 校验与适配

| 入口 | 用途 | 关键 flag | 退出码 |
|---|---|---|---|
| `cli/verify-fidelity.ts` | 逐项、逐场景比较 golden 与 actual 数组。golden 中存在而 actual 中缺失的场景记为 `MISSING` 并判定失败。没有任何可比较 item 时输出 `N/A`/`NO_ITEMS`（JSON `verdict=NO_ITEMS`、`fidelityPct=null`）；`NO_ITEMS` 且场景全等则通过，有缺失场景或结构差异仍失败。 | `--golden`, `--actual`, `--key`, `--items`, `--field`, `--json` | 0 100% 且无缺失，或 `NO_ITEMS` 且场景全等；1 有差异、缺失场景或结构差异；2 用法错误 |
| `cli/adapt-arkts.ts` | 针对四类机械模式的确定性 ArkTS codemod：构造函数选项、copy 补丁、`as const` 声明，以及成对的 type/const 重命名。它写出残留，而不是不安全的改写。 | `--src`, `--out`, `--ets`, `--report`, `--json`, `--fail-on-residual` | 0 成功（可能仍有残留）；1 转换错误；2 用法错误；3 在 `--fail-on-residual` 下存在残留 |
| `cli/arkts-fix.ts` | 对 `adapt-arkts --ets` 产物做高置信机械修复：`as const` 对象加 `typeof`/`keyof` 别名 → `enum`；单个对象类型别名 → `interface`。非目标代码保持不动；零命中仍算成功。 | `--src`, `--out`, `--json`, `--report`, `--dry-run`, `--no-obj-type-alias` | 0 成功（零命中仍算成功）；1 规则内部不一致或读写失败；2 用法错误 |
| `cli/ui-skeleton.ts` | 从单个 Compose 文件生成机械的 ArkUI 骨架：选取白名单节点最多的 `@Composable`，把白名单布局/控件与少数 modifier 映射为 ArkUI，写出 `<Name>.ets` 与 `mapping.md`；规则来自 `rules/ui-mapping.json` v3。只生成骨架，不承诺像素或行为等价。 | `--src`（单个 `.kt`）, `--out`, `--integrate`/`--out-project`, `--json`/`--md`, `--dry-run` | 0 成功；1 读写或解析失败，或没有可映射的白名单组件；2 用法错误 |
| `cli/diff-gate.ts` | 适配前后两棵目录树的行级 diff。将 hunk 归类为 `type-only`、`import-path` 或 `needs-review`；零依赖。 | `--before`, `--after`, `--max`, `--strict`, `--json`, `--report` | 0 无 `needs-review`；3 存在 `needs-review`；1 在 `--strict` 下或读取错误；2 用法错误 |
| `cli/explain-errors.ts` | 把 hvigor 日志或错误 JSON 转成规则、`file:line:col`、源码摘录与修复锚点。没有位置的错误单独列出。 | `--log`, `--root`, `--max`, `--rule`, `--json`, `--report` | 0 读取成功（即使存在错误）；2 用法错误或输入无法解析 |
| `cli/lint-arkts.ts` | 在工程内执行 hvigor 构建。统计 ERROR 加上 WARN 级 `arkts-*` 违规。默认清理构建缓存，以避免 `UP-TO-DATE` 造成的假通过。 | `--project`, `--sdk`, `--hvigor`, `--json`, `--report`, `--log`, `--log-in-project`, `--no-clean` | 0 无 ArkTS 错误；1 有错误或构建失败；2 用法错误或缺少前置条件 |
| `cli/reachability-probe.ts` | 复制工程，注入 import 使源码根下每个 `.ets` 都可达，然后编译该副本。统计 ERROR 加上 WARN 级 `arkts-*` 违规。 | `--project`, `--src`, `--entry`, `--sdk`, `--hvigor`, `--json`, `--report`, `--keep` | 0 无 ArkTS 错误；1 有错误或构建失败；2 用法错误或缺少前置条件 |

codemod 中两条与重命名相关的规则刻意保持狭窄：规则 3 只改写类型位置；跨文件重命名只有在每次使用都是类型位置时才通过 `import type` 接受。其余情况都会变成残留。

## 3. 编排、构建与设备

| 入口 | 用途 | 关键 flag | 退出码 |
|---|---|---|---|
| `cli/build-hap.ts` | 通过 hvigor 构建 HAP，将完整日志留在磁盘上，并打印简短摘要。参考工程没有签名配置，因此产出未签名的 HAP。 | `--project`, `--mode`（`debug` 或 `release`）, `--sdk`, `--hvigor`, `--log` | 0 `BUILD SUCCESSFUL`；1 构建失败；2 用法错误或缺少前置条件 |
| `cli/port.ts` | 运行九阶段门禁机：`analyze → adapt → autofix → diff → fidelity → lint → reach → build → device`。`autofix` 需 `--autofix` 显式启用；fixed 副本只供 `diff`，`lint`/`reach`/`build` 仍按 `--project`。固定顺序、逐阶段摘要、日志、JSON 报告。遇到 FAIL 即停止，除非指定 `--continue`。 | `--project`, `--case`, `--src`, `--adapted`, `--actual`, `--fidelity-key`, `--fidelity-items`, `--fidelity-field`, `--sdk`, `--hvigor`, `--stages`, `--autofix`, `--no-autofix`, `--arkts-fix-out`, `--report`, `--device`, `--signed-hap`, `--bundle`, `--ability`, `--hdc`, `--json`, `--continue`, `--strict-diff` | 0 无 FAIL 且无 SKIP；1 任一 FAIL 或 SKIP；2 用法错误 |
| `cli/case.ts` | 清单驱动的 case runner：发现 `cases/*/case.json`，按清单跑 stages 或委托 case 自带 runner，聚合现有门禁结果。 | `--case`、`--stage`、`--list`、`--json`、`--report`、`--update`、`--refs`、`--sdk`、`--hvigor`、`--device`、`--continue`、`--timeout`、`--case-arg` | 0 全 PASS/WARN（允许 optional SKIP）；1 FAIL；2 用法错误；3 无 FAIL 但必需 stage 因外部前置缺失 SKIP |
| `cli/device-test.ts` | 检查设备、安装并启动签名 HAP、采集 hilog 并截图。安装失败会映射到已记录的错误码与 AGC 修复方法；签名从不被绕过。 | `--target`, `--check`, `--hap`, `--install`, `--bundle`, `--ability`, `--screenshot`, `--hilog-filter`, `--json`, `--report`, `--log`, `--timeout`, `--hdc` | 0 所有请求步骤成功；1 任一步骤失败或超时；2 用法错误或缺少 `hdc` |

`port` 还接受以下扩展 flag：`--allow-residuals`、`--no-ets`、`--no-replay`、`--no-explain`、`--explain-max`、`--logs`、`--mode`、`--ets-src`、`--entry`、`--lang`、`--timeout`、`--adapt-src`、`--fidelity-key`、`--fidelity-items`、`--fidelity-field` 与 `--device-timeout`。三个 fidelity flag 会透传给 `verify-fidelity` 的 `--key`、`--items` 与 `--field`。其确切语义见 `node cli/port.ts --help`。

实践提示：

- 不带 `--device` 且不带 `--autofix` 时，`port` 运行七个阶段；`--autofix` 会增加可选的 autofix 阶段。仅当提供 `--device <host:port>` 时才会出现 device 阶段。
- `autofix` 只影响 `diff`：它从不修改 `--project`，因此修复后的 fixed 副本改变的是 `diff` 的输入，而不是 `lint`、`reach`、`build` 所编译的内容。缺少 `--adapted` 或其目录不存在时该阶段为 `SKIP`；已启用 `--autofix` 但缺少 `cli/arkts-fix.ts` 时为 `FAIL`。
- 不带 `--signed-hap` 时，device 阶段只做检查。安装与启动需要 `--signed-hap` 与 `--bundle`。
- `diff` 警告（退出码 3）记为 `WARN`，不会阻塞后续阶段。`--strict-diff` 会将其提升为 `FAIL`。
- `lint` 与 `reach` 失败会自动触发 `explain-errors`。该诊断仅供参考，不会改变阶段状态。
- 常见的设备安装错误码会以可操作的消息呈现：9568320（签名）、9568257 与 9568258。错误 9568276 通常意味着安装记录过期；应先卸载再重装，而不是修改 bundle 名。

## 4. 证据与接口

| 入口 | 用途 | 关键 flag | 退出码 |
|---|---|---|---|
| `cli/docs-metrics.ts` | 从 case 真值文件重新计算规范数字，并扫描文档中相互矛盾的说法。覆盖保真、闭包、转写/适配体积、错误数、codemod 计数、构建/签名与覆盖率。 | `--case`, `--refs`, `--coverage`, `--check`, `--json`, `--report` | 0 成功或无差异；1 `--check` 发现不一致；2 用法错误或读取失败 |
| `cli/mcp-server.ts` | 基于 stdio 的 JSON-RPC 2.0 MCP 服务器。对现有 CLI 的薄封装；不重新实现任何门禁逻辑。 | `--cwd`, `--allow`, `--timeout` | 长时间运行的 stdio 服务器；协议错误以 JSON-RPC 错误返回 |
| `scripts/stage-case.mjs` | 把外部 case 证据复制到 `<case>/ts` 并校验 sha256。写出确定性的 `.provenance.json`；GPL 派生源码从不入库。 | `--refs`, `--case`, `--dest`, `--check`, `--json` | 0 成功或校验一致；1 不一致；2 用法错误 |
| `scripts/acceptance.mjs` | 五阶段发布回归：`stage → golden → replay → adapt → arkts-gate`。没有 SDK/hvigor 时 `arkts-gate` 会跳过；跳过不算失败。 | `--refs`, `--sdk`, `--hvigor`, `--out`, `--json`, `--skip-build`, `--keep` | 0 全 PASS（允许 SKIP）；1 任一 FAIL；2 用法错误 |

`docs-metrics` 检查八组已知漂移，包括 178 = 硬错误 177 + 1 WARN 的错误拆分以及 codemod 计数。任何不一致都会以退出码 1 结束。

## 5. MCP 服务器

`cli/mcp-server.ts` 在 stdio 上实现 JSON-RPC 2.0：每行一个 JSON 对象。它支持 `initialize`、`notifications/initialized`、`ping`、`tools/list` 与 `tools/call`。

它暴露 17 个工具：

```text
doctor, analyze-coupling, extract-closure, pack-context, gen-golden,
verify-fidelity, adapt-arkts, diff-gate, explain-errors, lint-arkts,
reachability-probe, build-hap, device-test, port, docs-metrics,
stage-case, acceptance
```

客户端配置：

```json
{"mcpServers":{"arkts-port":{"command":"node","args":["cli/mcp-server.ts","--cwd","<repo>"]}}}
```

错误语义：未知工具返回 JSON-RPC `-32602`；缺少必需参数、CLI 退出码非零或超时都会返回 `result.isError = true`，并附上 CLI 的退出码 `[exit N]`。`--allow` 限制暴露的工具子集，`--timeout` 以毫秒设置每次调用的超时。

## 6. npm 脚本

共 20 个脚本。它们都不需要 `npm install`。

```text
coupling      doctor        closure       context       gen-golden
fidelity      adapt         diff-gate     explain       lint
reach         build         port          stage         acceptance
mcp           js-ts-case    device-test   docs-metrics  test
```

`js-ts-case` 运行 `cases/js-ts/run.mjs`。`stage` 与 `acceptance` 映射到上面两个脚本。`test` 通过 `node --test tests/` 运行 Node 测试套件（范围限定在 `tests/`，因此 `out/` 下的副本不会被发现）。其余脚本与 `cli/<name>.ts` 一一对应。有 5 个 CLI 没有 npm 别名，需直接调用：`case`、`triage-boundary`、`assess-conversion`、`arkts-fix` 与 `ui-skeleton`。

## 7. 约定

- **确定性：** 稳定排序；报告中没有时间戳或绝对路径；相同输入产生逐字节一致的输出。
- **日志：** 阶段日志默认写入 `out/logs/`。构建日志包含完整的 hvigor 输出；stdout 只保留摘要。
- **JSON：** `--json` 表示 stdout 只包含合法 JSON。`--report` 把同一对象写入文件。
- **依赖：** 零依赖。Node >= 22 直接剥离 TypeScript 类型；没有编译步骤。
