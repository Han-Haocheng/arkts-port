# 案例

[文档索引](README.md) · [English](cases.md)

三个案例作为可复现证据提交入库。每个案例都把第三方源码留在仓库之外：只提交 harness、golden/actual 数据，以及驱动它们运行的脚本。

## 1. 环境准备

所有命令均在仓库根目录、Node >= 22 下运行。占位符如下：

| 占位符 | 含义 | 默认环境变量 |
|---|---|---|
| `<refs>` | 外部证据根目录，其中包含已 stage 的案例源码 | `ARKTS_PORT_CASE_REFS` |
| `<sdk>` | OpenHarmony SDK 根目录 | `OHOS_BASE_SDK_HOME` |
| `<hvigor>` | hvigor 的 `node_modules` 目录 | `HVIGOR_HOME` |
| `<case>` | `cases/` 下的案例目录 | — |
| `<device>:<port>` | 可选设备阶段使用的设备地址 | — |

运行产物写入 `out/` 并被忽略。上游源码绝不会被复制进仓库。

## 2. 证据总览

| 案例 | 语言 | 范围 | Golden | 保真 | ArkTS | 结论 |
|---|---|---|---|---|---|---|
| [`legado`](../cases/legado/README.md) | JVM (Kotlin) | 闭包内 22 个模块 / 2,898 行 | 62 页 / 16 个场景 | 62/62 (100%) | 原始 178 → 经 codemod 与 4 处手改后为 0 | 全链路 |
| [`js-ts`](../cases/js-ts/README.md) | JS/TS | 9 行纯函数 | 297 B / 7 项 | 7/7 (100%) | 1 个预期错误 → 0 | G1-G4 PASS |
| [`js-ts-yoga`](../cases/js-ts-yoga/README.md) | JS/TS | 3,303 行 / 104,779 B | 1,662 B / 44 项 | 44/44 (100%) | 136 → 0 | G1-G4 PASS |

该表报告的是已提交 harness 的实测结果，不是对上游项目覆盖率的估计。

## 3. `cases/legado` — JVM 全链路

### 范围与来源

本案例迁移 `HapeLee/legado-with-MD3` 的分页算法，这是一个以 GPL-3.0 许可的 Android 阅读应用。上游仓库与 TypeScript 转写均为外部内容，不入库。

| 项目 | 实测值 |
|---|---|
| 源码分诊 | 2,108 个文件 / 404,343 行；13.1% 可自动转换 |
| 依赖闭包 | 22 个模块 / 2,898 行（21 个上游文件加 1 个手工抽取的文件） |
| TypeScript 转写 | 22 个文件 / 4,925 行 |
| ArkTS 适配 | 22 个文件 / 5,597 行 |
| 场景 / 页数 | 16 / 62 |
| 语义保真 | 100%（62/62 页，逐字节一致） |
| ArkTS 错误，入口可达 | 135 |
| ArkTS 错误，全量可达 | 原始 178 = 硬错误 177 + 1 条 WARN |
| Codemod 处理量 | 43 个 options 接口、41 个 patch 接口、9 处 `as const` 改写、9 组重命名 |
| codemod 后残留 | 4 处手改点上的 8 个硬错误 → 修复后为 0 |
| 构建 | `BUILD SUCCESSFUL`；未签名 HAP（无签名配置） |

### 复现

```bash
mkdir -p out

# 1. Stage external evidence into cases/legado/ts (sha256 checked)
node scripts/stage-case.mjs --refs <refs>

# 2. Replay the TypeScript transcript and run the fidelity gate
node cases/legado/replay.ts > out/actual.json
node cli/verify-fidelity.ts \
  --golden cases/legado/golden.json --actual out/actual.json

# 3. Release regression: stage, golden, replay, adapt, ArkTS gate
node scripts/acceptance.mjs --refs <refs> --sdk <sdk> --hvigor <hvigor>
```

不带 `--sdk`/`--hvigor` 时，`acceptance.mjs` 会跳过 ArkTS 阶段并仍以 0 退出；在这里跳过不算失败。SDK 与 hvigor 齐备时，全部五个阶段均通过。

### 发现

- 语义转写无需迭代修复即达到 100% 保真，这使该案例成为转写质量的参照。
- 难点在 ArkTS 语法，而不在算法。入口可达的 lint 报告了 135 条错误；全量可达报告了 178 条。多出的 42 条错误分布在 8 个从未被入口页 import 的文件里。
- 四项机械变换覆盖了大部分语法差异。codemod 留下 4 处手改点上的 8 个硬错误；修复这些后错误为 0，保真仍保持 100%。
- `diff-gate` 将 codemod 输出归类为仅类型变更，`needs-review` hunk 为 0。包括 `globalThis` 在内的运行时手工适配则被标记为需复核。

### 限制

- 转写中存在 52 处 `F32:` 浮点标记，但没有任何合成场景覆盖到它们。真实字体度量仍是未验证的风险。
- ArkTS 侧仅通过编译与构建验证。不声称渲染与交互等价。

## 4. `cases/js-ts` — 机制验证

### 范围与来源

本案例使用 `chapterProgress.ts`，这是 legado web 模块中一个 9 行纯函数。上游文件为 GPL-3.0 且属外部内容。目的是验证流水线的 JS/TS 分支，而不是衡量迁移规模。

| 项目 | 实测值 |
|---|---|
| 上游规模 | 9 行 |
| Golden | 297 B；2 个场景 / 7 项 |
| 保真 | 100%（7/7 项，2/2 场景） |
| ArkTS 基线 | 46 个探针模块上有 1 个预期错误（`arkts-no-obj-literals-as-types`） |
| 两行类型抽取后 | 0 ERROR / 0 WARN |
| 结论 | G1-G4 PASS |

### 复现

```bash
# One command: closure → golden → replay → fidelity → adapt → diff → probe
node cases/js-ts/run.mjs --stage all

# Machine-readable evidence
node cases/js-ts/run.mjs --stage all --json
```

runner 通过 `ARKTS_PORT_CASE_REFS` 以及 SDK/hvigor 环境变量读取上游源码。若上游文件缺失，案例会报告 `SKIP`，且不会产出伪造的 golden。

### 发现

- **假绿可复现。** `lint-arkts` 对该 parity 文件报告 0 错误，因为入口页从未 import 它。只有 `reachability-probe` 把它拉进依赖图，才暴露出内联对象类型。
- 这个唯一的预期错误可以解释：函数参数使用了内联对象类型，而 codemod 有意不改写构造函数 options 之外的这类写法。抽出 `interface ParagraphRange` 后用两行类型级代码即修复。
- 转写是恒等变换，因此 `adapt-arkts` 未做任何文本改动；唯一的适配是 `.ts → .ets` 扩展名。
- 分析器对 legado `modules/web` 目录树报告 6.9% 的可自动转换代码（34 个文件 / 3,057 行）。这是分诊结果，不应被表述为已实现的迁移覆盖率。

### 限制

- 本案例在 9 行代码上证明机制可行，而非证明大规模 JS/TS 的质量。
- 可选的 `souce.ts` 扩展未实现。它需要手工规范化 import，并加一个小型 `@vueuse/shared` shim。
- 不对 UI、设备或性能作任何声称。

## 5. `cases/js-ts-yoga` — 3.3k 行规模

### 范围与来源

本案例迁移 `src/native-ts/yoga-layout/`，这是 Meta 的 yoga flexbox 引擎（MIT）的纯 TypeScript 移植。源码属外部内容，不入库；案例提交的是 stage/run 脚本、harness、golden 与 actual 输出。

| 项目 | 实测值 |
|---|---|
| 规模 | 3,303 行 / 104,779 B（`index.ts` 3,104 行，`enums.ts` 199 行） |
| Golden | 1,662 B；4 个场景 / 44 项 |
| 保真 | 100%（44/44 项，4/4 场景） |
| ArkTS 基线 | 47 个探针模块上 136 个 ERROR（`enums.ets` 112，`index.ets` 24） |
| 确定性修复后 | 0 ERROR / 0 WARN |
| Codemod 残留 | 19（16 处 `as const`、2 处内联对象类型、1 处 `any`） |
| Diff 门禁 | 1 处 `import-path` 变更，0 处 `needs-review` |
| 结论 | G1-G4 PASS |

### 复现

```bash
# Verify that the staged files match upstream hashes
node cases/js-ts-yoga/stage.mjs --check --json

# Full chain, with the deterministic ArkTS fix applied
node cases/js-ts-yoga/run.mjs --stage all

# Reproduce the 136-error baseline without applying the fix
node cases/js-ts-yoga/run.mjs --no-fix
```

runner 是幂等的：stage 只改写一个 import 说明符（`./enums.js` → `./enums.ts`），记录 sha256 值，并在改写次数不是恰好一次时拒绝继续。

### 发现

- 规模改变的是错误分布，而非方法。`enums.ets` 通过 `typeof` 类型查询、重复的 const/type 名称、index 别名、`as const` 以及无类型对象字面量，产生了 136 个错误中的 112 个。
- 一个确定性的案例内 fixer 把 16 个常量映射转换为 `enum` 声明，将类型别名改写为 interface，为 `Config`/`Yoga` 包装引入具体类，并替换那唯一一个 `unknown` 参数。该 fixer 记录每条规则的数量，数量不匹配即失败。
- 即使 fixer 随后消除了这些错误，`adapt-arkts` 给出的残留清单依然有用：它标出了通用 codemod 有意不处理的构造。
- `diff-gate` 只发现了 import 路径变更，确认 codemod 没有悄悄改写运行时逻辑。

### 限制

- `.ets` 无法在 Node 中重放。保真在 TypeScript 侧得到证明；ArkTS 侧由编译门禁把关。
- 该 fixer 是案例内、示例性的。它说明剩余错误是机械性的，并不说明通用 codemod 能处理所有项目。
- golden 锁定的是这个 TypeScript 移植的行为，并不证明与上游 C++ yoga 引擎逐值等价。
- fixer 引入了类与 enum。ArkTS 侧的运行时语义漂移无法被本案例检测，必须由 diff 复核与设备测试覆盖。

## 6. 设备证据

通过 `cli/device-test.ts` 在以下设备上安装、启动并检查了一个已签名 HAP（Huawei AGC 调试 profile）：

| 项目 | 值 |
|---|---|
| 设备 | CMM-AL10 |
| 系统 | HarmonyOS 7 |
| API 级别 | 26 |
| 签名 | Huawei AGC 调试 profile（外部） |
| 已验证 | 安装、启动、UI 界面、设置界面 |

```bash
# Connection and system check only
node cli/device-test.ts --target <device>:<port> --check

# Install a signed HAP, launch it, and capture a screenshot
node cli/device-test.ts --target <device>:<port> \
  --hap <signed.hap> --install --bundle <bundle> \
  --ability EntryAbility --screenshot out/screen.png
```

该工具从不绕过签名。未签名 HAP 会以错误 9568320 失败；陈旧的安装记录（9568276）通过先卸载来解决，而不是改 bundle 名。阅读流程、性能与渲染等价尚未验证。

## 7. 可复现性与许可

- **外部证据是 stage 而来，不是 vendored 入库。** `stage-case.mjs` 复制 legado 的 TypeScript 基线，校验 sha256，并写出确定性的来源文件。`cases/js-ts-yoga/stage.mjs` 在一次 import 改写后，对两个 yoga 文件做同样的事。
- **只提交案例产物。** harness、golden/actual JSON、案例 runner 与案例内修复都在仓库中。第三方源码、`out/` 与 parity 工程不在。
- **许可证随源码走。** legado 转写产物为 GPL 派生，yoga 源码为 MIT；两者均不入库，也不被本仓库重新许可。本仓库自身采用 MIT 许可证，见 [LICENSE](../LICENSE) 与 [THIRD_PARTY_LICENSES](../THIRD_PARTY_LICENSES)。
- **案例结果有边界。** 保真数字仅适用于已提交的场景。覆盖率、UI 行为与渲染等价明确不在范围内。
