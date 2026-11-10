# 文档索引 / Documentation index

根 README 只列入门线索，完整文档都在这里。英文主文件无后缀；英文主文件的中文译本用 `.zh-CN.md`，中文主文件的英文译本用 `.en.md`。中文单语范围包括 adapters 语言细则、harness 模板、tests fixture 与案例 README；代码块与命令保持原文（英文），不翻译。内部设计、审计与交接文档不随公开快照发布。
The root README only lists entry points; the complete documentation lives here. English source files have no suffix; Chinese translations of English sources use `.zh-CN.md`, and English translations of Chinese sources use `.en.md`. Chinese-only material includes the per-language adapter notes, harness templates, test fixtures, and case READMEs; code blocks and commands stay in their source form (English). Internal design, audit, and handoff notes are not part of the public snapshot.

## 核心文档 / Core docs

| 文档 / Doc | English | 中文 | 讲什么 / What it covers |
|---|---|---|---|
| 架构 / Architecture | [architecture.md](architecture.md) | [architecture.zh-CN.md](architecture.zh-CN.md) | 阶段模型、两段式设计、fail-closed 规则、确定性与边界。 / Stage model, two-phase design, fail-closed rules, determinism, and limits. |
| 工具参考 / Tool reference | [tools.md](tools.md) | [tools.zh-CN.md](tools.zh-CN.md) | 23 个入口的参数、退出码、MCP 与 npm 脚本。 / Flags, exit codes, MCP, and npm scripts for all 23 entrypoints. |
| 案例证据 / Case evidence | [cases.md](cases.md) | [cases.zh-CN.md](cases.zh-CN.md) | 三个案例的可复跑证据与许可边界。 / Reproducible evidence and licensing boundaries for the three cases. |

## 支撑文档 / Supporting docs

| 文档 / Doc | English | 中文 | 讲什么 / What it covers |
|---|---|---|---|
| 语言适配器 / Adapters | [README.en.md](../adapters/README.en.md) | [README.md](../adapters/README.md) | 适配器三钩子、支持矩阵与新增语言步骤。 / Three hooks, support matrix, and adding a language. |
| 语言适配器细则 / Adapter details | — | [jvm](../adapters/jvm.md) · [js-ts](../adapters/js-ts.md) · [dart](../adapters/dart.md) · [c-cpp](../adapters/c-cpp.md) · [swift](../adapters/swift.md) | 每种语言的状态、边界与坑。 / Per-language status, boundaries, and pitfalls. |
| ArkTS 限制 / ArkTS restrictions | [arkts-restrictions.en.md](../rules/arkts-restrictions.en.md) | [arkts-restrictions.md](../rules/arkts-restrictions.md) | ArkTS 严格模式限制与 codemod 覆盖范围。 / ArkTS strict-mode rules and codemod coverage. |
| API 映射 / API mapping | [api-mapping.en.md](../rules/api-mapping.en.md) | [api-mapping.md](../rules/api-mapping.md) | 已实测的 Android → HarmonyOS API 映射。 / Measured Android-to-HarmonyOS API mappings. |
| 踩坑清单 / Pitfalls | [pitfalls.en.md](../rules/pitfalls.en.md) | [pitfalls.md](../rules/pitfalls.md) | 构建工具链与类型检查的坑。 / Build-toolchain and type-checking pitfalls. |
| 转换占比规则 / Conversion-share rules | — | [conversion-share.json](../rules/conversion-share.json) | 四类转换占比的规则、v1.1 conservative/broad profile 与版本。 / Rules, v1.1 conservative/broad profiles, and version for the four conversion shares. |
| UI 映射规则 / UI mapping rules | — | [ui-mapping.json](../rules/ui-mapping.json) | UI 骨架白名单、safe/excluded 规则与 version 3 / sha256。 / UI skeleton allowlist, safe/excluded rules, and version 3 / sha256. |
| Agent 流程 / Agent workflow | [SKILL.en.md](../skills/arkts-port/SKILL.en.md) | [SKILL.md](../skills/arkts-port/SKILL.md) | 给 agent 的固定操作流程与 token 纪律。 / Fixed agent procedure and token discipline. |

## 案例与模板 / Cases and templates

| 文档 / Doc | English | 中文 | 讲什么 / What it covers |
|---|---|---|---|
| legado 案例 / legado case | — | [legado/README.md](../cases/legado/README.md) | JVM 全链案例的范围、命令与硬数字。 / Scope, commands, and hard numbers for the JVM case. |
| js-ts 机制案例 / js-ts case | — | [js-ts/README.md](../cases/js-ts/README.md) | 9 行函数的 G1-G4 机制验证。 / G1-G4 mechanism check on a 9-line function. |
| js-ts 规模化案例 / js-ts-yoga case | — | [js-ts-yoga/README.md](../cases/js-ts-yoga/README.md) | 3,303 行 yoga-layout 的规模化验证。 / Scale validation on the 3,303-line yoga-layout port. |
| harness 模板 / Harness templates | — | [kotlin](../templates/kotlin-harness/README.md) · [kotlin-adapters](../templates/kotlin-adapters/README.md) · [node](../templates/node-harness/README.md) · [dart](../templates/dart-harness/README.md) · [cpp](../templates/cpp-harness/README.md) · [swift](../templates/swift-harness/README.md) | 每种语言的 golden harness 模板；kotlin-adapters 为 Kotlin/TS 边界拆分 adapter 套件。 / Golden-harness templates per language; kotlin-adapters is the Kotlin/TS boundary-split adapter kit. |
| 测试 fixture / Test fixtures | — | [extract-closure/README.md](../tests/fixtures/extract-closure/README.md) | extract-closure 的自造 fixture 说明。 / Self-contained fixtures for extract-closure. |

## 许可 / Licensing

| 文档 / Doc | English | 中文 | 讲什么 / What it covers |
|---|---|---|---|
| MIT 许可证 / MIT license | [LICENSE](../LICENSE) | [LICENSE](../LICENSE) | 本仓库的 MIT 许可与版权声明。 / MIT license and copyright notice for this repository. |
| 第三方许可 / Third-party licenses | [THIRD_PARTY_LICENSES](../THIRD_PARTY_LICENSES) | [THIRD_PARTY_LICENSES](../THIRD_PARTY_LICENSES) | 外部案例源码的许可证与再分发边界。 / Licenses and redistribution boundaries for external case sources. |

## 快速入口 / Quick links

- English README: [README.md](../README.md) · 中文说明: [README.zh-CN.md](../README.zh-CN.md)
- 工具与 npm 脚本 / Tools and npm scripts: [tools.md](tools.md) · [tools.zh-CN.md](tools.zh-CN.md)
- 案例 / Cases: [cases/](../cases/) · 规则 / Rules: [rules/](../rules/) · 模板 / Templates: [templates/](../templates/) · 适配器 / Adapters: [adapters/](../adapters/)
