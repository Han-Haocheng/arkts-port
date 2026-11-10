# case: yoga-layout js-ts 规模化案例（规格 + 实测）

> **状态：实现已落盘（2026-11-10 00:00 实测：G1-G4 PASS，G3 136→0）**。本 README 是规格与证据说明；实现文件：`stage.mjs`、`run.mjs`、`arkts-fix.mjs`、`replay.mjs`、`harness/*.mjs`、`golden.json`、`actual.json`。
> 目标：把 js-ts 机制案例（`cases/js-ts`，139 行）放大到 **3.3k 行真实模块**，验证 pipeline 在真实代码上的行为。
> 来源与选型：`docs/js-ts-scale-candidates.md` §2.1（Top 1）；不声称覆盖率，不做 UI/真机。

## 0. 定位与结论

- 模块：dsh-TUI 的 `src/native-ts/yoga-layout/`——Meta yoga 的 **纯 TypeScript 移植**（flexbox 数值引擎），无 DOM/RN/框架依赖。
- 规模：`index.ts` 3,104 行 + `enums.ts` 199 行 = **3,303 行 / 104,779 B**（`wc -lc` 实测）。
- 本案例是「**数值黄金值规模化**」：同一组固定布局输入，迁移前后必须逐值相等；ArkTS 侧只做编译门禁（0 ERROR + 0 WARN），不做 Node 重放（`.ets` 不能直接跑）。
- js-ts 的「语义转写」在本案例仍是**恒等**；价值在 3.3k 行规模下的 closure→pack→golden→adapt→probe 全链行为与错误画像。
- **一键复跑**：`node cases/js-ts-yoga/run.mjs --stage all`——实测 `pass: true`（**G1-G4 全 PASS**）：G1 stage + closure 2/3,303 + context 7,443 B + gen-golden stable 4 scenarios/44 items（sha256 `5a6d67ac…`）；G2 保真 100%（44/44、4/4），actual 与 golden 逐字节相同；G3 **ArkTS 136 ERROR → 0 ERROR / 0 WARN**（`arkts-fix.mjs` 确定性修复，probe exit 0；`--no-fix`/`--g3-record` 可复现 136 基线）；G4 adapt residual 19、diff needs-review 0。

## 1. 范围与来源（源码不入库）

| 项 | 值 |
|---|---|
| 上游目录（外部路径） | `/mnt/d/Project/dsh-TUI/src/native-ts/yoga-layout/` |
| 文件 | `index.ts`（100,293 B）、`enums.ts`（4,486 B） |
| LOC | 3,104 + 199 = **3,303** |
| sha256（2026-11-09 实测） | `index.ts` = `a7924bb6d44f19f771254bbbf86f84a8807eb4a183d7ea141f6bd66cff473d1d`；`enums.ts` = `be1742fb580c9da1e02fd8cc3b5d0bd9e66870e184ac0a6ebb24cab11f79256d` |
| 许可 | **MIT**（dsh-TUI `package.json` license=MIT；yoga 上游为 Meta，MIT） |
| 依赖 | 仅本地 `./enums`；无 Node 内置/框架/DOM 依赖 |
| 不做 | UI/Vue/终端渲染、真机、视觉/交互、性能、整包 dsh-TUI 迁移；不引用 yoga 之外的 dsh-TUI 模块 |

> 纪律：上游源码**不复制进仓库**。stage 只把 2 个文件复制到 `out/js-ts-yoga/src/yoga`（gitignored），并记录 sha256 供审计。

## 2. stage（复制 + 1 处 import 修复 + sha256）

上游是 bundler 解析（`moduleResolution: bundler`），`index.ts` 第 58 行 import 写的是 `'./enums.js'`，而实际文件是 `enums.ts`——Node 26 直接 import 会报 `Cannot find module .../enums.js`（已实测）。stage 只做这一处重写：

```bash
# 复跑（幂等）：复制 2 文件 + 1 处 './enums.js' → './enums.ts' + sha256 清单
node cases/js-ts-yoga/stage.mjs --json

# 校验已 staged 文件（sha256 + 预处理 count=1；不一致 exit 1）
node cases/js-ts-yoga/stage.mjs --check --json

# 覆盖上游/输出目录（可选）
node cases/js-ts-yoga/stage.mjs --src /mnt/d/Project/dsh-TUI/src/native-ts/yoga-layout --out out/js-ts-yoga/src/yoga
```

实测（`out/js-ts-yoga/stage.json`）：

| 文件 | upstream sha256 | staged sha256 | 说明 |
|---|---|---|---|
| `index.ts` | `a7924bb6…` | `5bd8fe51…` | 仅 1 处 import 重写（`rewrites.count=1`），逻辑不变 |
| `enums.ts` | `be1742fb…` | `be1742fb…` | 逐字节未动 |

- 退出码：0 成功；1 `--check` 不一致；2 用法错误；**3 上游缺失（SKIP，不算失败）**。上游或 `ARKTS_PORT_YOGA_SRC` 缺失时案例跳过。
- 该步骤是**闭包副本预处理**，不改上游；长期应由 `extract-closure --out` 的 `--rewrite-relative-ext` 固化（见 `docs/js-ts-scale-candidates.md` §4）。

## 3. harness 场景与期望输出

### 3.1 harness 契约

- 场景：4 组固定树（定义在 `harness/scenarios.mjs`），覆盖 root/child 尺寸、`flexDirection`、`padding`/`gap`、`justifyContent`/`alignItems`、百分比与绝对定位。
- 运行：`node cases/js-ts-yoga/harness/yoga.mjs`，stdout **只输出 JSON**（实测可被 JSON.parse）；`gen-golden` 会跑两次并逐字节比较。
- 入口：默认 `out/js-ts-yoga/src/yoga/index.ts`（stage 产物）；可用 `--src <index.ts>` 覆盖，或用环境变量 `YOGA_CASE_ROOT` 改 stage 根（默认 `out/js-ts-yoga`）。入口缺失时 stderr 说明并 exit 3（案例 SKIP）。
- 输出形状（verify-fidelity 只比较单标量，必须拍平）：

```json
[
  { "scenario": "s1-basic", "results": [
      { "case": "root.left", "value": 0 }, { "case": "root.top", "value": 0 },
      { "case": "root.width", "value": 100 }, { "case": "root.height", "value": 50 },
      { "case": "root.0.left", "value": 0 }, { "case": "root.0.top", "value": 0 },
      { "case": "root.0.width", "value": 40 }, { "case": "root.0.height", "value": 20 } ] }
]
```

- 数值约定：`left/top/width/height` 四舍五入到 **3 位小数**（yoga 自带像素取整，本批场景输出均为整数）；`root` 为根节点路径，`root.0` 为第 0 个子节点（以此类推）。
- 复用：`harness/run-scenarios.mjs` 是 harness 与 replay 共用的同一份场景执行逻辑，保证 golden/actual 场景一致。

### 3.2 场景与期望值（4 组 / 44 items，均为本机实测）

| # | 场景 | 输入（root / children） | 期望输出（left, top, width, height） |
|---|---|---|---|
| S1 | `s1-basic` | root 100×50；child 40×20 | root (0,0,100,50)；root.0 (0,0,40,20) |
| S2 | `s2-row-center-pad` | root 200×40，`flexDirection=Row`，`justifyContent=Center`，`padding=10`；两个 child 各 30×10 | root (0,0,200,40)；root.0 (70,10,30,10)；root.1 (100,10,30,10) |
| S3 | `s3-col-center-gap-margin` | root 120×80，`flexDirection=Column`，`alignItems=Center`，`padding=5`，`gap=4`；child0 40×10 + `margin=3`；child1 60×20 + `flexGrow=1` | root (0,0,120,80)；root.0 (40,8,40,10)；root.1 (30,25,60,50) |
| S4 | `s4-percent-absolute` | root 200×100；child0 `width=50%`、`height=25%`；child1 30×30，`position=Absolute`，`left=10`、`top=20` | root (0,0,200,100)；root.0 (0,0,100,25)；root.1 (10,20,30,30) |

> 这些期望值用于规格核对，最终以 **gen-golden 产出的 `golden.json` 为准**（golden 由当前实现跑出，2 次一致才落盘；`run.mjs` 的 G1 会比对「specMatches」）。S3 的 child1 高度 = 80-5×2-4-10 = 50，与 flexGrow 拉满一致。

## 4. golden / actual / replay 命令

```bash
# 推荐：一键复跑（stage→closure→pack→gen-golden→replay→fidelity→adapt→diff→probe）
node cases/js-ts-yoga/run.mjs --stage all            # 人读摘要；--json 输出结构化
# 支持：--stage g1|g2|g3|g4、--json、--update（同步 golden/actual 到 cases/）、--restage、
#       --no-fix / --g3-record（复现 136 基线，G3 退化为记录）、--sdk <p>、--hvigor <p>；
#       退出码 0 = G1-G4 全 PASS（--no-fix/--g3-record 时 G3 只记录）

# 分步（与 run.mjs 等价；均已实测）
node cli/extract-closure.ts --root /mnt/d/Project/dsh-TUI \
  --entry src/native-ts/yoga-layout/index.ts --lang js-ts \
  --out out/js-ts-yoga/closure --report out/js-ts-yoga/closure.json --json
node cli/pack-context.ts --closure out/js-ts-yoga/closure --lang js-ts \
  --out out/js-ts-yoga/context.md --report out/js-ts-yoga/context.json --json
node cli/gen-golden.ts --lang js-ts --main cases/js-ts-yoga/harness/yoga.mjs \
  --out out/js-ts-yoga/golden --json --report out/js-ts-yoga/gen-golden.json
node cases/js-ts-yoga/replay.mjs > out/js-ts-yoga/actual.json
node cli/verify-fidelity.ts --golden out/js-ts-yoga/golden/golden.json \
  --actual out/js-ts-yoga/actual.json --items results --field value --json
```

实测基线（本机，2026-11-10 00:00；`run.mjs --stage all`）：

| 项 | 实测值 |
|---|---|
| stage | 2 文件（`index.ts` 100,293 B / `enums.ts` 4,486 B，1 处 import 重写） |
| closure | 2 文件 / 3,303 行；unresolved = 0 |
| pack-context（js-ts） | **7,443 B ≈ 1,959 token**（源 104,779 B，-92.9%，签名 203） |
| gen-golden | exit 0、`stable: true`、`runs: 2`、4 scenarios / 44 items、1,662 B；sha256 `5a6d67ac7364d47b660efda0f0dabf8364e69903e5471d22f41505a42c1a59ea` |
| replay + verify-fidelity | 100%（44/44 items、4/4 scenarios）；actual 与 golden **逐字节相同**（恒等转写） |
| 提交的 golden/actual | 各 1,662 B，同一 sha256（`5a6d67ac…`） |
| ArkTS 修复（arkts-fix） | `adapt` → `adapt-fixed`；probe **0 ERROR / 0 WARN**（`reach-fixed.json`）；sha256 `enums.ets` `b2a20ce3…`（2,640 B）/ `index.ets` `c67851d2…`（101,121 B） |

## 5. ArkTS 计划（closure → pack → adapt → parity probe）

### 5.1 机械适配（实测）

```bash
node cli/adapt-arkts.ts --src out/js-ts-yoga/src \
  --out out/js-ts-yoga/adapt --ets --json --report out/js-ts-yoga/adapt.json
node cli/diff-gate.ts --before out/js-ts-yoga/src --after out/js-ts-yoga/adapt \
  --json --report out/js-ts-yoga/diff.json
```

实测：扫描 2 / 改动 2；**changes 只有 1 条 `import-path`**（`index.ts:58`，`'./enums.ts'`→`'./enums'`）；**residuals 19 条** = `as-const-unpaired` 16 + `inline-object-type` 2 + `any-unknown` 1；diff-gate counts = `{typeOnly:0, importPath:1, needsReview:0, cannotPair:0}`。

### 5.2 parity probe（基线 → arkts-fix → 0/0）

```bash
# 一键（run.mjs g3）：adapt → arkts-fix → 复制 arkts-check → 放 adapt-fixed .ets → probe（0/0 门禁）
node cases/js-ts-yoga/run.mjs --stage g3
# 手工（与 run.mjs 等价）：先修复，再 probe（0/0）
node cases/js-ts-yoga/arkts-fix.mjs --json
mkdir -p out/js-ts-yoga/parity
cp -a /mnt/d/Project/legado-with-MD3/.refs/arkts-check out/js-ts-yoga/parity
mkdir -p out/js-ts-yoga/parity/entry/src/main/ets/parity/yoga
cp out/js-ts-yoga/adapt-fixed/yoga/index.ets out/js-ts-yoga/adapt-fixed/yoga/enums.ets \
   out/js-ts-yoga/parity/entry/src/main/ets/parity/yoga/
node cli/reachability-probe.ts --project out/js-ts-yoga/parity \
  --sdk /mnt/d/Project/legado-with-MD3/.ohos-sdk/linux \
  --hvigor /mnt/d/Project/legado-with-MD3/.ohos-tools/node_modules --json \
  --report out/js-ts-yoga/reach-fixed.json
# 基线复现（136）：改用 out/js-ts-yoga/adapt/yoga/*.ets 走同一命令，--report out/js-ts-yoga/reach-baseline.json
```

**实测基线**（`out/js-ts-yoga/reach-baseline.json`）：`probeModules 47`（45 基线 + 2）、**136 ERROR / 0 WARN**、`pass:false`。按规则：

| 规则 | 数量 | 实际分布 |
|---|---|---|
| `arkts-no-type-query` | 32 | `enums.ets` 的 `(typeof X)[keyof typeof X]` |
| `arkts-unique-names` | 32 | `enums.ets` 的 const 与同名 type |
| `arkts-no-untyped-obj-literals` | 28 | `enums.ets` 16 + `index.ets` 12 |
| `arkts-no-aliases-by-index` | 16 | `enums.ets` 的索引类型 |
| `arkts-no-as-const` | 16 | `enums.ets` 的 16 组 `as const` |
| `arkts-no-obj-literals-as-types` | 11 | `index.ets` 的内联对象类型 |
| `arkts-no-any-unknown` | 1 | `index.ets` |

按文件（probe 输出精确统计，非估算）：**`enums.ets` 112 条**（32 type-query + 32 unique-names + 16 aliases + 16 as-const + 16 untyped-obj-literals），**`index.ets` 24 条**（12 untyped-obj-literals + 11 obj-literals-as-types + 1 any-unknown）。

**修复后（默认路径，实测）**：`run.mjs` 在 adapt 后执行 `node cases/js-ts-yoga/arkts-fix.mjs`（`out/js-ts-yoga/adapt` → `adapt-fixed`，命中写入 `out/js-ts-yoga/fix.json`），再 probe → **47 模块 / 0 ERROR / 0 WARN / pass:true**（`out/js-ts-yoga/reach-fixed.json`，probe exit 0）。

- 修复后 sha256：`enums.ets` = `b2a20ce3…`（2,640 B；`enums→enum` ×16）；`index.ets` = `c67851d2…`（101,121 B；13 类变换）。
- 基线复现：`node cases/js-ts-yoga/run.mjs --no-fix` 或 `--g3-record` → 136 ERROR 基线（`reach-baseline.json`），用于对比；该模式下 G3 只记录（退出码仍 0）。

### 5.3 修复实现（arkts-fix.mjs）与人工点（已由工具完成）

`node cases/js-ts-yoga/arkts-fix.mjs [--in <adapt dir>] [--out <fixed dir>] [--json]`：对 adapt 产物做确定性修复，每条规则命中数必须等于期望值（`fix.json` 记录），否则 exit 1；输出 `out/js-ts-yoga/adapt-fixed`。

1. **enums.ets（修复前 112 errors）**：16 个 `const X = {...} as const` + typeof/索引类型 → **`export enum` ×16**（数值不变）；enums.ets 2,640 B，sha256 `b2a20ce3…`。
2. **index.ets（修复前 24 errors）**：13 类变换 = `Value/Layout/Style/Config/Size` type→interface（各 1）、`MeasureFunction return→Size`、`getComputedLayout return→ComputedLayout`、`getYogaCounters return→YogaCounters`、`Yoga nested→named interfaces`、`createConfig→class ConfigImpl`、`YOGA_INSTANCE→class YogaImpl`、`setDirtiedFunc unknown→concrete`、`insert fix interfaces`；index.ets 101,121 B，sha256 `c67851d2…`。
3. `any/unknown` 1 条已由 `setDirtiedFunc unknown→concrete` 修复；修复引入 `class ConfigImpl/YogaImpl` 后 probe 仍 0（class/private 未产生新错误）。
4. `adapt-arkts` 的 19 条 residual 是**修复前**的 codemod 清单（16 `as const`、2 内联对象类型、1 any）；修复后 probe 0，不代表 residual 归零。
5. 修复后 probe **0 ERROR + 0 WARN（exit 0）**；修复是类型层确定性变换，TS 侧 golden/actual 不变（仍 100%）。
6. 边界：ArkTS 侧无法 Node 重放；保真门禁只在 TS 侧成立，ArkTS 侧以「编译通过 + 修复规则计数 + diff-gate」兜底。

## 6. 验收标准（G1-G5）

| # | 门禁 | 通过条件 | 当前状态（2026-11-10 00:00） |
|---|---|---|---|
| G1 | golden 稳定 | `gen-golden --lang js-ts` exit 0、`stable: true`、`runs: 2`、两次逐字节一致、记录 `goldenSha256` | **PASS**：4 scenarios / 44 items，sha256 `5a6d67ac…` |
| G2 | 保真 | `verify-fidelity --items results --field value` → 100% | **PASS**：44/44、4/4；actual 与 golden 逐字节相同 |
| G3 | ArkTS | `arkts-fix.mjs` 修复后 **0 ERROR + 0 WARN**（probe exit 0，47 模块）；`--no-fix`/`--g3-record` 可复现 136 ERROR 基线（只记录） | **PASS（0/0）**：默认门禁；基线复现见 §5.2 |
| G4 | 无语义漂移 | `diff-gate --before src --after adapt` → 0 needs-review（仅 import-path） | **PASS**：needs-review 0 |
| G5 | 证据可审计 | `golden.json`/`actual.json` 提交、sha256 记录、上游源码不在仓库、不声称覆盖率；复跑命令可执行 | **PASS**：提交文件与 sha 一致；`run.mjs --stage all` 可复跑 |

> `run.mjs` 退出码：0 = G1-G4 全 PASS（默认 G3 为 0/0 门禁；`--no-fix`/`--g3-record` 时 G3 只记录基线）；1 = 有 FAIL；2 = 用法错误。

## 7. 落盘与证据

| 文件 | 说明 |
|---|---|
| `cases/js-ts-yoga/README.md` | 本规格与证据说明 |
| `cases/js-ts-yoga/stage.mjs` | 复制 2 文件 + 1 处 import 重写 + sha256 清单；`--check` 校验 |
| `cases/js-ts-yoga/run.mjs` | 端到端复跑（G1-G4 门禁；G3 默认 0/0，`--no-fix`/`--g3-record` 退化为基线记录）；`--update` 同步 golden/actual |
| `cases/js-ts-yoga/arkts-fix.mjs` | 确定性 ArkTS 修复（enums→enum、interface/class、unknown→concrete）；`fix.json` 记录命中计数 |
| `cases/js-ts-yoga/harness/{yoga,scenarios,run-scenarios}.mjs` | 4 场景定义 + 执行逻辑（harness 与 replay 共用） |
| `cases/js-ts-yoga/replay.mjs` | 重放，输出 `actual.json` |
| `cases/js-ts-yoga/golden.json` / `actual.json` | 已提交（各 1,662 B，sha256 相同） |
| `out/js-ts-yoga/` | stage、closure、context、golden、adapt、`adapt-fixed`、parity、`fix.json`、`reach-baseline.json`、`reach-fixed.json`、`evidence.json`（gitignored，不入库） |

证据路径：`out/js-ts-yoga/stage.json`、`closure.json`、`context.json`/`context.md`、`gen-golden.json`、`adapt.json`、`diff.json`、`fix.json`、`reach-baseline.json`、`reach-fixed.json`、`evidence.json`。

## 8. 许可、边界与风险

- **许可**：dsh-TUI MIT；yoga 上游 Meta MIT。仓库只提交 README + stage/run/replay/harness/golden/actual（自产数据），**不提交上游源码**；上游缺失时 `stage.mjs` exit 3（SKIP）。
- **边界**：不声称覆盖率/整包迁移；不做 UI/真机/视觉；yoga 是 C++ 引擎的 TS 移植，golden 锁「当前移植行为」，不证明与上游 C++ 逐值一致。
- **浮点**：本批场景输出整数（§3.2 实测）；后续加场景若出现小数，harness 约定四舍五入 3 位，golden 会记录该约定。
- **工具时效**：`extract-closure`/`pack-context` 的 js-ts 支持当前是工作区未提交修改（git `M`），HEAD 可能只支持 jvm；复跑前先 `--help` 确认。
- **更新 golden/actual**：只在有意变更 harness/场景时用 `node cases/js-ts-yoga/run.mjs --update`，否则保持提交值；`run.mjs` 会对比提交值（`committedGoldenMatches`/`committedActualMatches`）。
- **风险**：`arkts-fix.mjs` 把 enums 改为 `export enum`、引入 `class ConfigImpl/YogaImpl`——需保证调用方数字/方法语义不变（否则 TS 侧 golden 仍过、ArkTS 侧语义漂移无法由本案例发现；这是本案例的已知盲区，需 diff-gate + 人工 diff 兜底）。
- **不做**：不把 `out/` 提交；不把 parity 工程提交；不声称覆盖率；G3 已 0/0（默认门禁），`--no-fix`/`--g3-record` 仅用于复现并保留 136 基线。

## 9. 复跑命令（汇总，均已实测）

```bash
# 0) 一键（推荐）：stage → closure → pack → gen-golden → replay → fidelity → adapt → diff → fix → probe
node cases/js-ts-yoga/run.mjs --stage all
node cases/js-ts-yoga/run.mjs --stage g1 --json    # 只跑 golden 稳定
node cases/js-ts-yoga/run.mjs --stage g3            # 默认：fix 后 0/0 门禁
node cases/js-ts-yoga/run.mjs --no-fix              # 复现 136 基线（G3 只记录）
node cases/js-ts-yoga/run.mjs --g3-record           # 同上，显式记录模式
node cases/js-ts-yoga/arkts-fix.mjs --json          # 单独跑修复，命中写 out/js-ts-yoga/fix.json

# 1) 单独校验 stage
node cases/js-ts-yoga/stage.mjs --check --json

# 2) 手工分步（等价）
node cli/extract-closure.ts --root /mnt/d/Project/dsh-TUI \
  --entry src/native-ts/yoga-layout/index.ts --lang js-ts \
  --out out/js-ts-yoga/closure --report out/js-ts-yoga/closure.json --json
node cli/pack-context.ts --closure out/js-ts-yoga/closure --lang js-ts \
  --out out/js-ts-yoga/context.md --report out/js-ts-yoga/context.json --json
node cli/gen-golden.ts --lang js-ts --main cases/js-ts-yoga/harness/yoga.mjs \
  --out out/js-ts-yoga/golden --json --report out/js-ts-yoga/gen-golden.json
node cases/js-ts-yoga/replay.mjs > out/js-ts-yoga/actual.json
node cli/verify-fidelity.ts --golden out/js-ts-yoga/golden/golden.json \
  --actual out/js-ts-yoga/actual.json --items results --field value --json
node cli/adapt-arkts.ts --src out/js-ts-yoga/src \
  --out out/js-ts-yoga/adapt --ets --json --report out/js-ts-yoga/adapt.json
node cli/diff-gate.ts --before out/js-ts-yoga/src --after out/js-ts-yoga/adapt --json
```
