# case: js-ts 机制验证（chapterProgress 必做 + souce 可选）

> **状态：已实现（2026-11-09，task-28）**。`harness/`、`replay.mjs`、`run.mjs`、`parity-fix.mjs`、`golden.json`、`actual.json` 已落盘；一条命令复跑与 G1-G4 证据见 §6。
> 目标：验证 js-ts 适配器的**机制**（closure → golden → replay → 保真 → adapt-arkts → ArkTS 门禁），**不声称整模块迁移**。
> 依据：`docs/js-ts-candidates.md`（task-23）§1/§3。上游模块：`<legado>/modules/web`（Vue3 + Element Plus Web SPA，GPL-3.0；本案例不复制其源码进仓库）。

## 0. 定位与结论

- task-23 结论是 **conditional GO**：modules/web 只有 139 行（4.6%）纯逻辑可建 golden（task-23 口径）；本案例只取其中 **#1 `chapterProgress.ts`（9 行）必做**，**#2 `souce.ts`（75 行）可选**。
- **口径更新（2026-11-09 21:30 实测）**：现行 `analyze-coupling` 已细化 js-ts 规则：34 文件 / 3,057 行；coupled 19 文件 / 1,561 行；.d.ts 8 文件 / 475 行；纯数据配置 2 文件 / 809 行；**可自动转写 212 行 = 6.9% [low]**（分母 3,057）。task-23 的 83.1% 是旧口径，不作为迁移规模引用。
- 这不是「Vue SPA 迁移案例」，也不声称任何覆盖率数字（无论旧 83.1% 还是新 6.9%）；它只证明 js-ts 分支的工具链能跑通并给出可审计证据。
- js-ts 源码已是 TS/JS，「语义转写」在本案例是**恒等变换**；价值在机制与门禁，不在转写质量（转写质量由 legado JVM 案例证明）。

## 1. 案例范围

| 项 | 决定 |
|---|---|
| #1 `src/utils/chapterProgress.ts` | **必做**：9 行、纯函数 `paragraphAtPosition`、无 import、Node 26 可直接跑；仓库内已有参考用例 `scripts/chapter-progress.test.mjs` |
| #2 `src/utils/souce.ts` | **可选，本次未做**：75 行、8 个导出、纯函数；需 1 处 import 扩展名 + 3 行 `@vueuse/shared` shim（验证「外部依赖/扩展名」这类 js-ts 缺口）。理由见 §6.3 G5 |
| #3 `utils.ts` | **不做**：`dateFormat` 用 `new Date()`，非确定性；task-23 已标为「只测 3/4 函数」 |
| Vue/pinia/router/axios/DOM 代码 | **不做**：无法建立固定 JSON 输入输出（task-23 分类 1,610 行，53.3%） |
| UI / 真机 / 性能 | **不做**：不属于本案例 |
| 覆盖率数字（task-23 的 83.1% / 现行 6.9%） | **不声称**：83.1% 是旧口径（含 .d.ts、配置、框架代码）；现行 6.9% 仍含 3 个纯逻辑文件之外的脚本行。本案例只看 2 个候选源码文件 |

上游路径（必须真实存在，缺失则本案例 SKIP 并说明）：

- `<legado>/modules/web/src/utils/chapterProgress.ts`（9 行）
- `<legado>/modules/web/src/utils/souce.ts`（75 行，可选）
- `<legado>/modules/web/src/utils/utils.ts`（55 行，#2 的依赖）

## 2. harness 设计

### 2.1 #1 chapterProgress（必做）

- 入口：上游 `.ts` 文件本身（Node 26 原生 type stripping 可直接 import；已实测）。
- 运行方式：`node <harness.mjs>`，stdout 只输出 JSON（一次运行）；gen-golden 会跑两次并逐字节比较。
- 输入场景（固定 JSON，覆盖空数组与边界）：

| scenario | paragraphs | positions |
|---|---|---|
| `empty` | `[]` | `[0]` |
| `bounds` | `[{"start":0,"endExclusive":7},{"start":7,"endExclusive":12}]` | `[0,2,7,11,12,99]` |

- 输出形状（verify-fidelity 兼容：`--items results --field value`，value 为标量）：

```json
[
  { "scenario": "empty",  "results": [ { "case": "position=0", "value": -1 } ] },
  { "scenario": "bounds", "results": [
      { "case": "position=0",  "value": 0 },
      { "case": "position=2",  "value": 0 },
      { "case": "position=7",  "value": 1 },
      { "case": "position=11", "value": 1 },
      { "case": "position=12", "value": 1 },
      { "case": "position=99", "value": 1 } ] }
]
```

- 期望 golden 内容：与上面 JSON 数值一致（2 scenarios / 7 items；空数组返回 `-1`；`endExclusive > position` 命中首个分页；超过末页返回最后一个索引）。参考 `scripts/chapter-progress.test.mjs` 的断言与 task-23 的实测输出。

### 2.2 #2 souce（可选，验证依赖/扩展名缺口）

- 该文件 import `../source`（类型，Node 擦除）与 `./utils`（运行时）；`utils.ts` 又 import `@vueuse/shared`。当前工作区无 `node_modules`，直接 import 会失败（实测：`ERR_MODULE_NOT_FOUND: @vueuse/shared`、`Cannot find module .../utils`）。
- 预处理契约（执行者手工完成，确定性、可写在执行记录里；本规格不写代码）：
  1. 复制 `souce.ts` + `utils.ts` 到 `out/js-ts/closure/`（外部证据，不入库）；
  2. `souce.ts` 的 `from './utils'` 改为 `from './utils.ts'`（Node ESM 要求显式扩展名）；
  3. `utils.ts` 的 `from '@vueuse/shared'` 改指向本地 `./vueuse-shared.mjs`；该 shim 只需导出 `formatDate(date, pattern)`（本案例不调用 `dateFormat`，但模块加载需要该绑定存在）。
- 实测：完成上述 2 处修改 + shim 后，Node 26 跑通，两次输出逐字节一致。
- 注意：`extract-closure --lang js-ts --out` 已可用（实测 exit 0），但它只是**原样复制**闭包文件，不重写 import 扩展名/外部依赖（实测复制出的 `souce.ts`/`utils.ts` 仍保留 `from './utils'` 与 `from '@vueuse/shared'`），所以上面 2 处修改仍必须做。
- 输入/输出形状（scenario `sources`，value 用标量）：

```json
[
  { "scenario": "sources", "results": [
      { "case": "invalid.book", "value": true },
      { "case": "invalid.rss",  "value": false },
      { "case": "key.book",     "value": "u" },
      { "case": "key.rss",      "value": "r" },
      { "case": "name.book",    "value": "A" },
      { "case": "matches.A",    "value": true },
      { "case": "matches.zz",   "value": false },
      { "case": "mapKeys",      "value": "u,r" },
      { "case": "normalized",   "value": "{\"b\":1,\"c\":{\"e\":\"k\"}}" } ] }
]
```

- 注意：`normalizeSource` 原地修改输入（golden 前先 clone）；返回 `Map` 需转 `[...entries()]`；`isInvaildSource` 命名与行为相反，golden 锁行为不锁命名。
- #2 只做 harness + 保真，**不做 ArkTS 阶段**（`any` 与 Source 类型域不在本案例范围）。

## 3. golden / actual 生成命令（已按此落盘并实测；日常复跑用 §6.2 的 `run.mjs`）

```bash
UP=<legado>/modules/web
mkdir -p out/js-ts

# 0) 前置：上游存在（缺失则 SKIP）
test -f "$UP/src/utils/chapterProgress.ts"

# 0.1) 抽闭包（extract-closure js-ts 已可用；#1 期望 1 文件 / 9 行）
node cli/extract-closure.ts --root "$UP" --entry src/utils/chapterProgress.ts \
  --lang js-ts --out out/js-ts/closure --report out/js-ts/closure.json --json
# #2 可选：--entry src/utils/souce.ts → 3 文件（source.d.ts + souce.ts + utils.ts），unresolved: @vueuse/shared

# 1) golden（gen-golden 跑 harness 两次、逐字节一致才写 golden.json）
#    注意 --out 必须在 harness 目录之外
node cli/gen-golden.ts --lang js-ts \
  --main cases/js-ts/harness/chapter-progress.mjs \
  --out out/js-ts/golden --json --report out/js-ts/gen-golden.json

# 2) actual（replay 直接 import 闭包副本；js-ts 的「转写」是恒等）
node cases/js-ts/replay.mjs > out/js-ts/actual.json

# 3) 保真门禁（必须 100%；缺场景也算 FAIL）
node cli/verify-fidelity.ts \
  --golden out/js-ts/golden/golden.json --actual out/js-ts/actual.json \
  --key scenario --items results --field value --json

# 4) （可选）#2：先按 §2.2 准备 out/js-ts/closure，再重复 1)~3)
node cli/gen-golden.ts --lang js-ts --main cases/js-ts/harness/souce.mjs \
  --out out/js-ts/golden-souce --json --report out/js-ts/gen-golden-souce.json
```

- harness 骨架：可先跑 `node cli/gen-golden.ts --lang js-ts --out out/js-ts/scaffold`（exit 4，写出基于 `templates/node-harness/harness.example.mjs` 的骨架；已实测），补场景后再用 `--main` 跑正式 golden。
- 建议把 `out/js-ts/golden/golden.json`（约 200 B、确定性）提交为 `cases/js-ts/golden.json` 作为证据；`actual.json` 与日志留在 `out/`（gitignored）。

## 4. ArkTS 阶段计划（仅 #1）

目标：证明 9 行模块在 ArkTS 工程里可编译，且期望的失败/修复是**可解释、可复现**的。

1. **准备 parity 工程**（不污染 `.refs`）：
   ```bash
   mkdir -p out/js-ts
   cp -a <legado>/.refs/arkts-check out/js-ts/parity
   ```
   该工程是已验证 0 错误的 ArkTS 工程（entry 可达 45 模块 + 本案例 1 个 = 46）。
2. **机械适配入口**：
   ```bash
   mkdir -p out/js-ts/src && cp "$UP/src/utils/chapterProgress.ts" out/js-ts/src/
   node cli/adapt-arkts.ts --src out/js-ts/src --out out/js-ts/adapt --ets --json --report out/js-ts/adapt-report.json
   ```
   期望：`adapt-arkts` 对 chapterProgress **0 行文本变化**（实测 `changes: []`、输出 `.ets` 与源一致），仅 `.ts→.ets` 改名。
3. **放进 parity 工程**：`cp out/js-ts/adapt/chapterProgress.ets out/js-ts/parity/entry/src/main/ets/parity/chapterProgress.ets`；reachability-probe 会自动把它拉进可达图（无需手改 `pages/Index.ets`）。
4. **ArkTS 门禁**（SDK/hvigor 用 legado 现成路径）：
   ```bash
   node cli/reachability-probe.ts --project out/js-ts/parity \
     --sdk <legado>/.ohos-sdk/linux \
     --hvigor <legado>/.ohos-tools/node_modules --json
   ```
   **期望（已实测基线）**：`probeModules: 46`、`arktsErrors: 1`、`warnArktsErrors: 0`，规则 `arkts-no-obj-literals-as-types`，定位 `parity/chapterProgress.ets:3:29`（内联对象类型 `ReadonlyArray<{start;endExclusive}>`）。
5. **约定的人工类型修复（2 行，非运行时改动；已脚本化）**：`node cases/js-ts/parity-fix.mjs --in <parity 里的 chapterProgress.ets> --out <同文件>` 把内联对象类型抽成 `interface ParagraphRange { start: number; endExclusive: number }`，签名改为 `ReadonlyArray<ParagraphRange>`；重跑 probe → `arktsErrors: 0`、`warnArktsErrors: 0`（已实测）。脚本要求锚点恰好出现 1 次，否则 exit 1（不静默改坏）。
   - 这是**约定残留**，不是 codemod bug：`adapt-arkts` 的 Options/Patch 变换只覆盖构造器内联对象类型，不覆盖函数参数内联类型（见 task-23 §4）。
6. **可达性陷阱对照（记录证据）**：同一工程上先跑 `lint-arkts`（parity 文件未被 entry import）→ 实测 `arktsErrors: 0`、`pass: true`（假绿）；必须用 probe。该对照写进本案例的「关键发现」。
7. **可选**：`diff-gate --before out/js-ts/src --after out/js-ts/adapt` 期望 0 needs-review（本步骤只证明 codemod 未改运行时；人工 interface 修复不在 diff-gate 范围，需人工 diff 2 行）。
8. **可选**：`build-hap --project out/js-ts/parity`（工程级构建）——不是本案例的门禁，parity 工程可构建即可。

## 5. 验收标准

| # | 门禁 | 通过条件 | 实测（2026-11-09，#1） |
|---|---|---|---|
| G1 | golden 稳定 | `gen-golden --lang js-ts` exit 0；报告 `stable: true`；两次 stdout 逐字节一致；记录 `goldenSha256` | **PASS**：stable=true、runs=2、两次逐字节一致；2 scenarios / 7 items；golden 297 B，sha256 `088634ad98c7…92ef` |
| G2 | 保真 | `verify-fidelity --key scenario --items results --field value` → 100%（7/7 items、2/2 scenarios），exit 0 | **PASS**：100%（7/7、2/2），actual 与 golden 逐字节相同 |
| G3 | ArkTS | 修 interface 后 `reachability-probe`：0 ERROR + 0 WARN 级 `arkts-*`，exit 0；**且** verbatim 基线恰好 1 条约定 ERROR（可解释） | **PASS**：verbatim 1 ERROR（`arkts-no-obj-literals-as-types`，46 模块）→ 抽 interface 后 0 ERROR / 0 WARN；lint 假绿对照 0 ERROR |
| G4 | 无语义漂移 | `diff-gate` 0 needs-review；人工 diff 仅 2 行类型层 | **PASS**：adapt `changes=[]`（仅 `.ts→.ets` 改名）；diff-gate 0 needs-review |
| G5 | #2（可选） | 同 G1/G2（souce 100%）；不要求 ArkTS 阶段 | **未做**：需 2 处手工 import 规范化 + shim，机制证据与 #1 重复（见 §6.3） |

**当前工具状态（2026-11-09 21:30 实测；以工作区 `--help` 为准）**：

| 工具 | js-ts 状态 | 证据 |
|---|---|---|
| `analyze-coupling` | ✅ 可用 | 现行 js-ts 口径：34 文件 / 3,057；coupled 19/1,561；.d.ts 475；配置 809；auto 212/6.9% [low] |
| `extract-closure` | ✅ 可用（js-ts 已支持） | 实测 exit 0：#1 → 1 文件/9 行；#2 → 3 文件 + unresolved `@vueuse/shared`；`--out` 原样复制、不重写 import |
| `pack-context` | ✅ 已支持 | js-ts 顶层 + 一层成员签名（`--no-members` 可关） |
| `gen-golden` | ✅ 本案例已用（工作区版本；HEAD 未提交时 CI 会 exit 2） | 实测 exit 0、`stable: true`、`runs: 2`、`goldenSha256` 与提交值一致 |
| `adapt-arkts` | ✅ 可复用 | chapterProgress 0 改动；souce 1 条 `any` residual |
| `lint-arkts` / `reachability-probe` | ✅ 可复用（工程级） | 实测 0 / 1→0（见 §4） |
| `verify-fidelity` | ✅ 支持标量字段 | 实测 `--key scenario --items results --field value`：PASS/FAIL/MISSING 均正确 |
| `build-hap` | ✅ 可复用 | 工程级，非本案例门禁 |
| `diff-gate` | ✅ 本案例已用（G4，仅告警） | `--before out/js-ts/src --after out/js-ts/adapt` → exit 0、0 needs-review |
| `stage-case` | ⚠️ legado 专用布局 | js-ts 案例若走外部证据需参数化（0.5 天，非本案例阻塞） |

> `pack-context` 的 js-ts 分支已支持（本案例不依赖）：本案例只用到 closure → golden → replay → 保真 → adapt → ArkTS 门禁，这条链已在 §6.3 全部实测通过。

## 6. 实现状态、复跑命令与证据（2026-11-09 落盘）

### 6.1 提交物清单（本仓库内）

| 文件 | 作用 | 备注 |
|---|---|---|
| `cases/js-ts/lib/case-common.mjs` | 上游定位（`ARKTS_PORT_CASE_REFS`）、固定场景、稳定 JSON 输出 | 无 GPL 源码 |
| `cases/js-ts/harness/chapter-progress.mjs` | #1 harness：stdout = golden JSON | 2 scenarios / 7 items |
| `cases/js-ts/replay.mjs` | 重放闭包副本 → actual（恒等转写） | 默认读 `out/js-ts/closure/`，`--src` 可覆盖 |
| `cases/js-ts/parity-fix.mjs` | G3 约定的 2 行类型修复（确定性脚本） | 锚点必须恰好 1 次，否则 exit 1 |
| `cases/js-ts/run.mjs` | G1-G4 端到端复跑（`--stage g1|g2|g3|g4|all`） | `--update` 同步 golden/actual |
| `cases/js-ts/golden.json` | 提交的 golden（297 B，紧凑 JSON + 换行） | sha256 `088634ad98c741b00d87b7cd5692c0f89bc4fa31397d45f7492ab940501892ef` |
| `cases/js-ts/actual.json` | 提交的 actual（与 golden 逐字节相同） | 恒等转写的直接证据 |
| `cases/js-ts/README.md` | 规格 + 实现状态 + 证据 | 本文 |

`out/js-ts/**`（parity 工程副本、closure、adapt、probe/lint 报告、`evidence.json`）是运行产物，已 gitignore，不入库；上游 `.ts` 源码（GPL-3.0）不入库。

### 6.2 复跑命令（一条命令 + 分阶段）

```bash
# 端到端（G1-G4；在仓库根目录执行；默认用 legado 现成 SDK/hvigor）
node cases/js-ts/run.mjs                       # 人类摘要 + out/js-ts/evidence.json
node cases/js-ts/run.mjs --json                # 机器可读（同一份 evidence）
node cases/js-ts/run.mjs --stage g1 --update   # 只跑 G1，并把 golden 同步到 cases/js-ts/
node cases/js-ts/run.mjs --stage g2            # G2（需先 g1；--update 可同步 actual）
node cases/js-ts/run.mjs --stage g4            # G4（g3 依赖它）
node cases/js-ts/run.mjs --stage g3            # G3（缺 adapt 时会先自动跑 g4）

# 环境变量（默认值即 legado 检出；换机器时改这三个）
export ARKTS_PORT_CASE_REFS=<legado>/.refs
export OHOS_BASE_SDK_HOME=<legado>/.ohos-sdk/linux
export HVIGOR_HOME=<legado>/.ohos-tools/node_modules
```

上游缺失时：`run.mjs` 打印 `SKIP:` 并 exit 0（不算失败）；`harness` 打印 SKIP 并 exit 3（gen-golden 会因此失败，不会产出假 golden）。

### 6.3 验收证据（2026-11-09 实测，命令均按 `--help`）

| 门禁 | 结果 | 实测数字 |
|---|---|---|
| G1 golden 稳定 | **PASS** | `gen-golden --lang js-ts` stable=true、runs=2；两次 stdout 逐字节一致；scenarios=2 / items=7；golden 297 B；sha256 `088634ad98c7…92ef`；提交的 `golden.json` 与再生逐字节一致（外部再跑一次 gen-golden 三方相同） |
| G2 保真 100% | **PASS** | `verify-fidelity --key scenario --items results --field value` → 保真度 100%（7/7）、场景全等 2/2、missing 0；`actual.json` 与 `golden.json` 逐字节相同（恒等转写） |
| G3 ArkTS parity | **PASS** | lint 假绿对照：arktsErrors 0 / pass true（parity 文件未被 entry import）；verbatim probe：probeModules 46 / arktsErrors 1 / warnArktsErrors 0，规则 `arkts-no-obj-literals-as-types`，位置 `parity/chapterProgress.ets:3:29`；`parity-fix.mjs` exit 0；修复后 probe：46 模块 / 0 ERROR / 0 WARN，exit 0 |
| G4 无语义漂移 | **PASS** | `adapt-arkts --ets`：`changes=[]`、输出与源文本逐字节相同（仅 `.ts→.ets` 改名）；`diff-gate` exit 0，needsReview 0 / typeOnly 0 / importPath 0 / files [] |
| G5 #2 souce（可选） | 未做 | 需 2 处手工 import 规范化 + `@vueuse/shared` shim（§2.2），机制证据与 #1 重复；留作可选扩展，不影响 G1-G4 闭环 |

完整机器可读证据：`out/js-ts/evidence.json`（每次 `run.mjs` 覆盖）；逐阶段报告：`out/js-ts/{closure,gen-golden,probe-verbatim,probe-fixed,lint-false-green,diff-gate,adapt-report}.json`。

关键发现（写进结论）：

- **假绿可复现**：`lint-arkts` 对未被 entry import 的 `parity/chapterProgress.ets` 报 0 ERROR（pass），只有 `reachability-probe` 把它拉进可达图后才报出 1 条内联对象类型错误——ArkTS 门禁必须用 probe。
- **唯一预期 ERROR 可解释**：`ReadonlyArray<{ start: number; endExclusive: number }>` 是函数参数内联对象类型；`adapt-arkts` 的 Options/Patch 变换只覆盖构造器内联对象类型，不覆盖函数参数，所以这是**约定残留**而非 codemod bug；抽 `interface ParagraphRange` 后 0 ERROR / 0 WARN。
- **恒等转写闭环**：`extract-closure --out` 原样复制（1 文件 / 9 行、无 import）；`replay` 从闭包副本跑出的 actual 与 golden 逐字节相同；`diff-gate` 确认 adapt 只改了扩展名。

### 6.4 外部依赖与 GPL 边界

- 上游是外部路径 `<legado>/modules/web`（GPL-3.0）：**不复制源码进仓库**；`lib/case-common.mjs` 按以下顺序定位：
  1. `$ARKTS_PORT_CASE_REFS/js-ts/src/utils/chapterProgress.ts`（推荐：把上游 staged 到 refs）
  2. `$ARKTS_PORT_CASE_REFS/../modules/web/src/utils/chapterProgress.ts`（refs 的兄弟目录 = legado 检出；本次实测走这条）
  3. `ARKTS_PORT_CASE_SRC` 可显式覆盖单个文件（harness / replay 支持）
- 若 refs 里没有 `js-ts/`，首次运行前手工 staging 一次即可（GPL 源留在 refs，仍不入库）：
  ```bash
  mkdir -p "$ARKTS_PORT_CASE_REFS/js-ts/src/utils"
  cp <legado>/modules/web/src/utils/chapterProgress.ts "$ARKTS_PORT_CASE_REFS/js-ts/src/utils/"
  ```
- SDK / hvigor 同样是外部依赖；`run.mjs` 默认值与 legado 检出一致，可用 `--sdk` / `--hvigor` 或环境变量覆盖。

## 7. 风险与边界

- **上游是外部路径**（`<legado>/...`，GPL-3.0）：harness 通过路径引用，不复制源码进仓库；路径缺失时案例 SKIP。
- **`gen-golden` js-ts 使用工作区版本**：本案例实测依赖当前工作区的 `cli/gen-golden.ts`（`M`）；若 HEAD 复核时该修改未提交，G1 会 exit 2（用法/缺能力）。提交后本风险消失。
- **上游解析顺序**：`$ARKTS_PORT_CASE_REFS/js-ts/...` 优先，其次 refs 的兄弟目录 `modules/web/...`（本次实测走这条）；两条都不存在时整个案例 SKIP（`run.mjs` exit 0、harness exit 3），不会产出假 golden。
- **恒等转写**：本案例不验证「语义转写质量」，只验证「机制与门禁」；不要据此声称 js-ts 适配器已在大规模代码上验证（139 行 vs legado 2,898 行 = 4.8%，见 task-23）。
- **口径随工具演进**：`analyze-coupling` 的 js-ts 规则在 2026-11-09 21:30 前后更新（83.1% → 6.9%，并排除 .d.ts/纯配置）；引用数字必须带日期与分母。
- **闭包复制不规范化 import**：`extract-closure --out` 按契约原样复制；Node ESM 仍需扩展名/依赖 shim（见 §2.2），不要误以为闭包产物可直接 `node` 跑。
- **假绿风险**：常规 `lint-arkts` 对未 import 的 parity 文件报 0（已实测），必须用 `reachability-probe`；本案例把这一对照写进 G3 证据。
- **#2 的 shim/扩展名是手工 2 处修改**（本次未做，G5）：若后续补做，必须记录在案保证复跑一致；它是验证「js-ts 闭包需要 import 规范化」的最小证据。
- **不做**：Vue SPA 迁移、UI、真机、性能、83.1% 覆盖率结论。
