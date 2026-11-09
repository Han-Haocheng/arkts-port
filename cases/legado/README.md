# case: legado 分页算法

## 结论

| 指标 | 数值 |
|---|---|
| Kotlin 源（依赖闭包） | **22 模块 / 2,898 行**（21 个上游文件 + 手工抽取 ParagraphDecoration.kt；另 Main.kt 199 行） |
| TypeScript 语义转写产物 | 22 文件 / 4,925 行 |
| ArkTS 适配产物 | 22 文件 / 5,597 行（类型层新增） |
| 场景 | 16 个（中文/英文/标点/双栏/缩进/居中/字间距/空行/长正文压力） |
| 基准页数 | 62 页 |
| **语义保真度** | **100%（62/62 页逐字全等）** |
| ArkTS 编译错误（入口 7 个可达模块） | 135 处（ERROR） |
| ArkTS 编译错误（全量 22 模块可达） | **178 原始 = 硬 177 + 1 条 WARN**（多出 42 条分布在 8 个未检查文件） |
| codemod 自动量 | 43 Options + 41 Patch + 9 as const + 9 对改名 |
| codemod 后残留 / 适配后（全量可达） | **8 条硬错误（4 个人工点）→ 0**，且保真度仍 100% |

## 复现步骤

1. 抽闭包（工具）：
   ```bash
   node cli/extract-closure.ts --root <legado> \
     --entry app/src/main/java/io/legado/app/feature/reader/core/layout/ReaderPaginator.kt \
     --out out/closure --report out/closure.json
   ```
   真值：21 个上游 include + 1 个 coupled boundary（ReaderChapterBlockMeasurer.kt）；手工抽取 ParagraphDecoration.kt。
2. 产基准（工具）：
   ```bash
   node cli/gen-golden.ts --lang jvm --src <closure> --main <closure>/Main.kt --out out/golden
   ```
   等价于 ``kotlinc src -d out && kotlin -cp out io.legado...Main > golden.json``；两次输出逐字节一致才写 golden。
3. 外部证据就位 + 语义转写重放：
   ```bash
   node scripts/stage-case.mjs --refs <legado>/.refs   # 22 文件 / 4,925 行，GPL 派生不入库
   node cases/legado/replay.ts > out/actual.json
   ```
4. 门禁：
   ```bash
   node cli/verify-fidelity.ts --golden cases/legado/golden.json --actual out/actual.json
   ```

## 关键发现

- 语义转写**一次到位**，没有靠多轮修；说明纯算法类 Kotlin 的转写质量很高
- 卡点全在 **ArkTS 语法规则**：入口可达 135 条，全量可达 178 原始（硬 177 + 1 条 WARN）；其中 4 类机械变换由 codemod 自动完成，剩 8 条硬错误在 4 个人工点
- **可达性陷阱**：按 135 的清单只修可达模块，会漏掉 8 个文件、42 个错误；门禁必须用 `reachability-probe`
- **适配只动类型层有自动证据**：`diff-gate` 对 codemod 产物 0 needs-review；人工适配的 `globalThis` 运行时改动会被标出
- 52 处 `// F32:` 浮点风险点在本批场景中**一个都没触发**，但真实字体度量下仍可能触发

## 上游信息

- 仓库：HapeLee/legado-with-MD3（Android，GPL-3.0）
- 目标：HarmonyOS 7 / API 26 / OpenHarmony SDK
