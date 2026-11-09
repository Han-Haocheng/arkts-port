# arkts-port

[English](README.md) | 简体中文

**面向 HarmonyOS ArkTS 的确定性、证据优先迁移工具链，支持 Android/JVM 与 JS/TS 模块。**

arkts-port 不承诺「一键 APK 转 HAP」。它让迁移的每一步都可执行、可核验：先编译并运行原实现，产出 golden 基准；再用 TypeScript 语义转写重放并逐项比对；最后适配 ArkTS，通过编译与可达性门禁后才构建 HAP。语义转写仍由人或 agent 完成，机械适配、编排与验证交给工具。

## 提供什么

- **零依赖的确定性 CLI。** 18 个入口（16 个 `cli/*.ts` + 2 个脚本）、20 个 npm 脚本，Node >= 22 直接运行 TypeScript，无构建步骤、无运行时依赖。
- **没有 golden 就没有结论。** `gen-golden` 跑原实现两次，逐字节一致才写基准；`verify-fidelity` 要求 100% 项与场景一致。
- **两段式转换。** 先把 Kotlin/Java 或 JS/TS 表示为可运行的 TypeScript，再适配 ArkTS；可执行的中间层是行为比对的前提。
- **fail-closed 门禁。** WARN 级 `arkts-*` 计入错误；缺失保真场景判 FAIL；适配残留默认 FAIL；lint 每次干净构建，避免缓存造成假通过。
- **可达性靠实测，不靠假设。** `reachability-probe` 把全部源文件拉进工程临时副本。legado 案例中，入口可达 lint 只看到 135 条错误。

  全量可达为 178 条（硬 177 + 1 条 WARN），其中 42 条分布在 8 个 lint 未检查的文件里。
- **可复现案例。** 外部证据经 stage 与 sha256 校验；第三方源码不入库，仓库只提交 harness、golden/actual 数据与案例脚本。
- **面向 agent 的接口。** 17 个 MCP 工具通过 JSON-RPC 2.0 stdio 暴露同一批 CLI，不复制门禁逻辑。

## 流水线

```text
上游源码（Kotlin/Java、JS/TS）
  │ 准备（每个模块一次）
  │ analyze-coupling → extract-closure → pack-context → gen-golden
  │ TypeScript 语义转写 → verify-fidelity（必须 100%）
  ▼
port — 8 个阶段，固定顺序
  analyze → adapt → diff → fidelity → lint → reach → build → device*
  （* 可选：需 --device；安装还需已签名 HAP）
  ▼
未签名 HAP，或已签名 HAP 安装并启动
```

`doctor` 在构建前检查 SDK、hvigor 与工程元数据。`port` 默认失败即停（`--continue` 可继续），每阶段一行摘要、日志落盘、输出 JSON 报告。

## 快速开始

无需安装：克隆仓库后用 Node >= 22 直接运行。

```bash
node cli/analyze-coupling.ts --list-langs
node cli/doctor.ts --project <project> --sdk <sdk> --hvigor <hvigor>

# 分诊、抽闭包、生成确定性上下文包
node cli/analyze-coupling.ts --root <project> --lang jvm
node cli/extract-closure.ts --root <project> --entry <entry.kt> --out out/closure
node cli/pack-context.ts --closure out/closure --exclude Main.kt --out out/context.md

# 产出并校验 golden
node cli/gen-golden.ts --lang jvm --src out/closure --main out/closure/Main.kt --out out/golden
node cli/verify-fidelity.ts --golden out/golden/golden.json --actual out/actual.json

# 适配 ArkTS 并跑门禁
node cli/adapt-arkts.ts --src <case>/ts --out out/ets --ets --report out/adapt.json
node cli/diff-gate.ts --before <case>/ts --after out/ets
node cli/port.ts --project <project> --case <case> --stages all --report out/report.json
```

真机阶段必须显式启用：

```bash
node cli/port.ts --device <device>:<port> --signed-hap <signed.hap> \
  --bundle <bundle> --ability EntryAbility --stages device
```

## 工具

所有工具都支持 `--help`；完整参数、报告字段与退出码见 [docs/tools.md](docs/tools.md)。

- **分诊与环境：** `analyze-coupling`、`doctor`。
- **闭包与上下文：** `extract-closure`、`pack-context`。
- **基准与保真：** `gen-golden`、`verify-fidelity`。
- **适配与诊断：** `adapt-arkts`、`diff-gate`、`explain-errors`。
- **门禁与构建：** `lint-arkts`、`reachability-probe`、`build-hap`、`port`。
- **证据与真机：** `docs-metrics`、`device-test`、`stage-case`、`acceptance`。
- **Agent 接口：** `mcp-server`（17 个工具）。

## 案例

legado 的上游 triage 覆盖 2,108 文件 / 404,343 行，其中 13.1% 可自动转换。

| 案例 | 范围 | 证据 |
|---|---|---|
| [`cases/legado`](cases/legado/README.md) | JVM（Kotlin）分页算法，上游为 GPL-3.0 Android 工程；源码外部。 | 闭包 22 文件 / 2,898 行；TS 22 文件 / 4,925 行；ArkTS 22 文件 / 5,597 行；保真 62/62 页（100%）；178 条 → 8 条残留（4 个人工点）→ 0；未签名 HAP 可构建。 |
| [`cases/js-ts`](cases/js-ts/README.md) | JS/TS 机制验证，9 行函数；源码外部。 | G1-G4 PASS；golden 297 B；2 组输入 / 7 项；逐项一致（7/7）；1 条预期 ArkTS 错误经 2 行类型抽取修复。 |
| [`cases/js-ts-yoga`](cases/js-ts-yoga/README.md) | 3,303 行 MIT yoga-layout TypeScript 移植；源码外部。 | G1-G4 PASS；golden 1,662 B；4 组输入 / 44 项；逐项一致（44/44）；ArkTS 在 47 模块探针上 136 → 0。 |

JS/TS 分析器对 legado `modules/web` 报 6.9% 可自动转换（34 文件 / 3,057 行）。这是分诊结果，不是迁移规模结论。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 阶段模型、两段式设计、fail-closed 规则、确定性与边界。 |
| [docs/tools.md](docs/tools.md) | 完整工具表、参数、退出码、MCP、npm 脚本。 |
| [docs/cases.md](docs/cases.md) | 案例证据、复跑命令与许可边界。 |
| [adapters/README.md](adapters/README.md) | 语言适配器契约与支持语言。 |
| [rules/arkts-restrictions.md](rules/arkts-restrictions.md) | ArkTS 限制与 codemod 规则。 |
| [skills/arkts-port/SKILL.md](skills/arkts-port/SKILL.md) | 给 agent 的固定操作流程。 |

## 状态与边界

- 需要 Node >= 22（已在 26.13.0 验证）；CLI 无运行时依赖。
- 18 个入口、20 个 npm 脚本、17 个 MCP 工具；测试 269 项（267 通过、2 跳过）；`docs-metrics --check` 在检查的文档目标上 0 不一致。
- JVM legado 跑通全链；JS/TS 有机制案例（`cases/js-ts`）与 3.3k 行规模化案例（`cases/js-ts-yoga`）；Dart、C/C++、Swift 只有适配器契约，未跑通真实模块；C/C++ 仅建议纯算法库。
- 只处理能产出可运行 golden 的模块；UI、布局、手势与渲染需手写重写，不做转译。
- ArkTS 侧只做编译门禁；语义等价在 TypeScript 侧证明。真机阶段验证安装、启动与界面，不验证渲染等价。
- `build-hap` 默认产出未签名 HAP；真机安装的签名在外部完成，使用 Huawei AGC debug profile。
- 真机证据：CMM-AL10、HarmonyOS 7、API 26；已签名 HAP 已安装、启动，并通过 `cli/device-test.ts` 验证 UI 与设置页。
- 仓库中没有 LICENSE 文件，也未声明许可证。

## 许可证

本仓库不包含 LICENSE 文件，也未声明许可证。第三方案例源码不入库：GPL 派生的 legado TypeScript 转写产物与 MIT 的 yoga 源码均保留在外部，通过路径或环境变量引用。案例只提交 harness、golden/actual 数据与案例脚本。再分发任何派生内容前，请先核对上游许可证。
