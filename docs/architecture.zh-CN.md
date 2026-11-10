# 架构

[文档索引](README.md) · [English](architecture.md)

## 1. 范围与不变量

arkts-port 把源码模块迁移到 HarmonyOS ArkTS。它围绕一个不变量构建：

> 只有可执行检查能证明的转换才会被接受。

因此流水线先产出证据，再产出代码；验收门禁是失败关闭的：不确定即失败，而不是通过。唯一一个建议性检查 `diff-gate` 明确说明自己是警告而非证明。

## 2. 两个转换阶段

转换被刻意拆成两个阶段，各自有独立的验收标准。

| 阶段 | 输入 | 输出 | 证明 |
|---|---|---|---|
| A. 语义转写 | 依赖闭包、上下文包、golden 基准 | 可在 Node 下运行的 TypeScript | 相对 golden 基准 100% 保真 |
| B. ArkTS 适配 | TypeScript 转写 | ArkTS（`.ets`）源码 | 0 ERROR + 0 WARN 级 `arkts-*` 诊断，外加干净的 diff 门禁 |

阶段 A 是证明行为的地方。之所以用 TypeScript 作为中间语言，是因为它可以由 Node 执行，从而能与原实现直接比较。若先产出 `.ets`，就没有可执行的参照物。

保持两阶段分离也让失败可诊断：阶段 A 的错误结果是语义错误，而阶段 B 的失败是语法或平台模型错误。把两者融合就无法区分。打包与可选的设备验证发生在转换之后，不改变这一契约。

## 3. 执行流水线

### 3.1 准备

这些步骤每个模块运行一次，位于编排的门禁序列之前。

| 步骤 | 工具 | 输出与用途 |
|---|---|---|
| 分诊 | `analyze-coupling` | 文件数、行数、可自动转换占比，以及逐模块排名。`.d.ts` 文件与纯数据配置会作为未审计单独报告，因此不会抬高可转换占比。 |
| 预检 | `doctor` | 13 项检查，覆盖 SDK 布局、hvigor、`build-profile.json5`、SDK 版本字符串、`runtimeOS`、`deviceTypes`、入口文件、`NODE_HOME`、环境对齐与 case 数据。 |
| 闭包 | `extract-closure` | 从入口得到的最小可编译闭包。文件被归类为 `include`、`coupled` 边界或 `test`；未解析符号与可移除的平台导入会被报告。 |
| 上下文 | `pack-context` | 确定性的 Markdown 包，含文件清单、签名索引（不含函数体）与 `F32:` 浮点标记。大输入会被拆成固定名称的分片。 |
| 基准 | `gen-golden` | 编译并运行原实现两次。仅当两次运行逐字节一致时才写出 `golden.json`。没有 harness 时，它生成脚手架并以退出码 4 结束。 |
| 保真 | `verify-fidelity` | 逐项、逐场景比较 golden 与 actual。golden 中存在而 actual 中缺失的场景记为 `MISSING`，门禁失败。零个可比项为 `NO_ITEMS`，仅当场景全等时通过。 |

`extract-closure --out` 可位于 `--root` 之外，也可位于其顶层安全子目录（`.refs/`、`out/`、`dist/`、`build/`）；其它子目录需 `--allow-out-in-root`（`--force` 等价但会告警）；工具会维护清单并删除过期的受管文件。对 JS/TS，相对导入（ESM、CommonJS、动态 `import()`、目录索引、扩展名替换）与非相对导入都会被解析。非相对说明符先通过 `tsconfig.json`/`jsconfig.json` 的 `baseUrl` + `paths`、再通过 `vite.config` 的 `resolve.alias` 查找，采用静态解析，不使用 `eval`；仍然无法解析的一律归为 `external`。`--no-alias` 会关闭别名解析。

### 3.2 `port` 的九个阶段

`port` 以固定顺序运行各阶段。`--stages` 可以选择子集，但从不改变顺序。`autofix` 需显式启用；不带 `--device` 与 `--autofix` 时，默认序列为七个阶段。

| # | 阶段 | 工具与输入 | 通过条件 | 缺少输入时 |
|---|---|---|---|---|
| 1 | `analyze` | 对 `--src` 运行 `analyze-coupling` | 分析完成 | 没有 `--src` 时为 `SKIP` |
| 2 | `adapt` | 从 `--adapt-src`/`--src` 到 `--adapted` 运行 `adapt-arkts` | 无残留，除非指定 `--allow-residuals`；扫描到零个文件即为失败 | 适配器无法运行时为 `SKIP` |
| 3 | `autofix` | 从适配产物运行 `arkts-fix` 到修复副本 | `arkts-fix` 退出码 0；零命中仍算成功；有修复时仅 `diff` 使用 fixed 副本 | 仅按需启用：没有 `--autofix` 时该阶段不出现；适配产物缺失时为 `SKIP` |
| 4 | `diff` | 在适配前后运行 `diff-gate` | 退出码 0（无 `needs-review`） | 输入缺失时为 `SKIP` |
| 5 | `fidelity` | 对 case 的 golden 与 actual 运行 `verify-fidelity` | 条目与场景 100%；无 `MISSING`；零个可比项为 `NO_ITEMS`，仅当场景全等时通过 | case 不存在时为 `SKIP` |
| 6 | `lint` | 对 `--project` 运行 `lint-arkts` | 0 ERROR + 0 WARN 级 `arkts-*` | 没有 SDK 或 hvigor 时为 `SKIP` |
| 7 | `reach` | 对 `--project` 运行 `reachability-probe` | 所有模块 0 ERROR + 0 WARN 级 `arkts-*` | 没有 SDK 或 hvigor 时为 `SKIP` |
| 8 | `build` | 对 `--project` 运行 `build-hap` | `BUILD SUCCESSFUL` | 没有 SDK 或 hvigor 时为 `SKIP` |
| 9 | `device` | `device-test` | 请求的步骤成功；除非提供签名 HAP，否则只做检查 | 仅按需启用：没有 `--device` 时该阶段不出现 |

对 `fidelity`，actual 数据按以下顺序选取：`--actual`，然后通过 `cases/<case>/replay.ts` 重放，最后是 `<case>/actual.json`。`lint` 或 `reach` 失败后，`port` 会自动运行 `explain-errors`，并在阶段摘要中加入精简诊断。该诊断不改变门禁结果。

## 4. 失败关闭契约

| 门禁 | 仅在以下情况通过 | 失败行为 |
|---|---|---|
| `gen-golden` | 两次运行逐字节一致 | 输出不同时退出码 3；缺少 harness 时退出码 4；不写出 golden |
| `verify-fidelity` | 100% 的条目与场景匹配，且没有缺失场景；`NO_ITEMS` 且场景全等时通过 | 退出码 1 |
| `adapt-arkts` | 设置 `--fail-on-residual` 时无残留 | 退出码 3 |
| `diff-gate` | 没有 `needs-review` 类 | 退出码 3 默认表示警告；`--strict` 会使其变为退出码 1 |
| `lint-arkts` | 0 ERROR 与 0 WARN 级 `arkts-*` | 退出码 1 |
| `reachability-probe` | 所有可达模块 0 ERROR 与 0 WARN 级 `arkts-*` | 退出码 1 |
| `build-hap` | `BUILD SUCCESSFUL` | 退出码 1 |
| `port` | 无 FAIL 且无 SKIP | 任何 FAIL 或 SKIP 都以退出码 1 结束；仅 WARN 时退出码 0 |
| `doctor` | 无 FAIL；允许 WARN | FAIL 时退出码 1，用法错误为 2 |
| `docs-metrics --check` | 无数字不一致 | 退出码 1 |

两条计数规则很重要：

1. **WARN 级规则计入。** `lint-arkts` 与 `reachability-probe` 报告的错误数是 ERROR 加上 WARN 级 `arkts-*` 诊断。“0 ArkTS 错误”始终意味着 0 ERROR 与 0 WARN 级规则违规。
2. **SKIP 不算通过。** `port` 把 `SKIP` 视为非成功退出。其他工具可以定义各自的跳过语义；例如 `acceptance.mjs` 把 SDK 不可用视为显式跳过，而不是失败。

`lint-arkts` 在每次门禁运行前清理 `.hvigor/cache` 与各模块的 `build` 目录。这会多花几秒，但能避免 hvigor 的 `UP-TO-DATE` 状态在第二次运行时产生假通过。`--no-clean` 仅供调试，不是门禁级模式。

## 5. 可达性是一等要求

ArkTS 只编译从入口页面可达的模块。因此普通工程构建可能报告成功，而未被导入的文件已经损坏。

legado case 测量了这一差距：

| 范围 | 适配前的 ArkTS 错误 |
|---|---|
| 入口可达模块（7 个） | 135 |
| 全部 22 个模块 | 178 原始 = 硬错误 177 + 1 WARN |

多出的 42 个错误分布在 8 个文件中，而入口可达的 lint 从未检查过这些文件。这就是 `reachability-probe` 成为必需阶段的原因：它把工程复制到临时目录，注入 import 使源码根下每个 `.ets` 文件进入可达图，然后编译该副本。原工程不会被修改；`--keep` 会保留副本以便检查。

该探针还暴露过若只读 WARN 就会放过的违规，其中包括一次 `globalThis` 规则命中。一个含 45 个模块的参考工程测得 0 错误，这就是各 case 使用的基准。

## 6. 确定性与证据

工具链的设计目标是让证据可以被 diff、归档与重新检查。

- 报告是 JSON，键与数组顺序稳定。它们不含时间戳与绝对路径，因此相同输入产生逐字节一致的报告。
- `gen-golden` 在写出任何内容之前先运行原实现两次，以此证明稳定性。
- 暂存的 case 证据在复制时会做 sha256 校验，并生成确定性的 provenance 文件。
- `docs-metrics` 从 case 真值文件（golden、actual、基准源码、适配后源码、错误 JSON、覆盖率 JSON）重新计算规范数字。其 `--check` 模式会扫描文档中相互矛盾的说法；当前快照 0 处不一致。
- 各 CLI 使用 Node 原生的 TypeScript 类型剥离，因此不存在会与源码漂移的构建产物。没有运行时依赖。

## 7. 报告、日志与退出码

`port` 写出的报告形如：

```json
{
  "stages": [
    { "name": "fidelity", "status": "PASS", "exitCode": 0,
      "durationMs": 812, "summary": "...", "logPath": "out/logs/fidelity.log",
      "metrics": {} }
  ],
  "pass": true,
  "counts": { "pass": 7, "warn": 0, "fail": 0, "skip": 0 },
  "requested": ["analyze", "adapt", "diff", "fidelity", "lint", "reach", "build"],
  "stoppedEarly": false,
  "remaining": []
}
```

状态为 `PASS`、`WARN`、`FAIL` 与 `SKIP`。`WARN` 允许继续运行；`FAIL` 会停止运行，除非设置 `--continue`。日志默认写入 `out/logs/<stage>.log`。`--json` 会把同一份报告打印到 stdout，人类可读摘要不再输出到 stdout。

各 CLI 的退出码遵循同一约定：0 表示成功，1 表示检查失败或执行错误，2 表示用法错误或缺少前置条件，3/4 表示工具特定结果（输出不稳定、缺少 harness、残留，或警告级 diff）。各工具在 `--help` 与 [tools.zh-CN.md](tools.zh-CN.md) 中记录其确切退出码。

## 8. 语言适配器边界

阶段机与语言无关。语言差异放在 `adapters/` 与 `adapters/languages.json` 中，它们提供三个钩子：

1. 用于归类平台绑定文件的耦合模式；
2. golden runner（编译器与运行时调用）；
3. harness 模板。

新增一门语言意味着填充这些钩子，而不是修改门禁序列。当前状态：

- **JVM（Kotlin/Java）** 是参考适配器，也是唯一被端到端跑通的适配器。
- **JS/TS** 受工具支持，并由两个 case 验证：一个 9 行的机制检查和一个 3,303 行的 yoga 移植。
- **Dart、C/C++ 与 Swift** 有适配器契约与模板，但没有已验证的模块。C/C++ 被明确限制为纯算法库。

## 9. 仓库布局

| 路径 | 作用 |
|---|---|
| `cli/` | 供人类、CI 与 MCP 共用的确定性入口 |
| `adapters/` | 语言契约与耦合规则 |
| `rules/` | ArkTS 限制、陷阱、API 映射、conversion-share 与 UI 映射规则 |
| `skills/arkts-port/` | 给 agent 的固定操作流程 |
| `cases/` | 可复现的 harness、golden、actual 与 case 脚本 |
| `scripts/` | 外部证据暂存与端到端验收 |
| `templates/` | 各语言的 harness 脚手架 |
| `tests/` | CLI 与门禁的 Node 测试套件 |
| `docs/` | 架构、工具参考、case 证据与文档索引 |

## 10. 局限与有效性威胁

- **golden 覆盖即场景覆盖。** 通过保真只能证明 harness 中场景的等价性。未覆盖的分支、输入与错误路径都未被证明。
- **ArkTS 侧是编译门禁，而非重放。** `.ets` 无法在 Node 下运行，因此行为等价性在 TypeScript 侧建立。ArkTS 的正确性由编译、规则计数与 diff 门禁推断。
- **浮点仍是风险。** legado 转写标记了 52 个 `F32:` 点，但在合成场景中一个都没有触发。真实字体度量可能会触发它们。
- **codemod 是词法级的，且刻意保守。** 它不改写模板字面量内部或嵌套对象类型；跨文件重命名只作用于每次使用都是类型位置的 `import type` 用法。未处理的情况会变成残留，而不是不安全的改写。
- **`diff-gate` 不是语义证明。** 它对行级变更分类，并标记任何可能改变运行时行为的内容；这些标记必须由人复核。
- **UI 等价不在范围内。** `ui-skeleton` 能从单个 Compose 文件生成机械的 ArkUI 骨架，但布局、手势、渲染与行为等价仍需人工改写。流水线的 fail-closed 门禁仍覆盖可产出确定性 golden 的逻辑。
- **hvigor 日志解析是一个兼容面。** WARN 级 `arkts-*` 的提取依赖 hvigor 的日志格式；升级时需要一起重新验证 `lint-arkts`、`reachability-probe` 与 `explain-errors`。
- **签名是外部的。** 除非工程配置了签名，`build-hap` 产出未签名的 HAP。设备安装已用来自华为 AGC 的 debug profile 签名 HAP 验证；工具不会绕过签名。
- **案例源码保留各自许可证。** 本仓库采用 MIT 许可证（见 [LICENSE](../LICENSE) 与 [THIRD_PARTY_LICENSES](../THIRD_PARTY_LICENSES)）。GPL 派生与 MIT 许可的第三方源码保留在仓库之外，从不入库。
