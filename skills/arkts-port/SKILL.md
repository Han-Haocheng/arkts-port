# arkts-port
Android → HarmonyOS（ArkTS）的可验证迁移。没有 golden 对照的转换不予采信；**agent 只做判断，机械动作交给 CLI**。

## 何时用 / 不用
- 用：纯逻辑模块；需要证明「转对了」；上游会反复同步。
- 不用：UI（Compose→ArkUI 重写）、反射/插件化、渲染/手势/动画等跑不出 golden 的模块。
- 覆盖率 <15% 不做自动转换（只做人写移植）。

## Token 纪律
1. 先 doctor/分诊，再 extract-closure；只读闭包内文件，不读整棵源码树。
2. 先 pack-context 再转写：读上下文包（legado 闭包 21,244 B ≈ 5.6k token），不读 138 KB 源码。
3. 只读包 / 报告 / DIFF，不复读全文日志；完整日志落盘 `out/logs/`，需要时再 grep。
4. explain-errors 替代手写脚本；只处理 residuals / needs-review。
5. 不再手工串命令：优先 port；语义转写一次一个模块，上下文只放 pack + 本 skill。

## 工具状态（2026-11-09 v2）
✅ 已实现（18 个入口 = 16 个 cli/*.ts + 2 个脚本）：doctor / analyze-coupling / extract-closure / pack-context / gen-golden / verify-fidelity / adapt-arkts / diff-gate / explain-errors / lint-arkts / reachability-probe / port / build-hap / device-test / docs-metrics / mcp-server + `scripts/stage-case.mjs` / `scripts/acceptance.mjs`。
所有入口 `--help` exit 0、未知参数 exit 2；port/doctor 已按 fail-closed 收口（空值/缺前置不放过）。

## 固定命令序列
### 0 环境预检（必做）
```bash
node cli/doctor.ts --project <harmony> [--sdk <p>] [--hvigor <p>] [--case <dir>] [--json] [--report <path>]
```
退出码 0 = 无 FAIL（WARN 允许）；有 FAIL 先修环境，不带病跑门禁。
### 1 分诊
```bash
node cli/analyze-coupling.ts --list-langs
node cli/analyze-coupling.ts --root <project> --lang <jvm|js-ts|dart|c-cpp|swift> [--json] [--top 15]
```
`verdict=low`（<15%）→ 停。
### 2 抽闭包
```bash
node cli/extract-closure.ts --root <project> --entry <file.kt> [--lang jvm] [--out <dir>] [--report <path.json>] [--json]
```
只读报告 `files/role/boundaries`；`coupled` 文件不要逐个读。`--out` 必须指向 `--root` 之外的目录（默认拒绝）；重跑会按受管清单清理旧产物。
### 3 转写上下文包
```bash
node cli/pack-context.ts --closure <dir> [--lang jvm] [--out out/context.md] [--max-bytes 200000] [--exclude <glob>] [--json] [--report <path>]
```
读 Markdown 包（文件清单/签名/F32 标记）做转写准备；不要重读整份源码。
### 3b js-ts 分支（可跳过语义转写）
```bash
node cli/extract-closure.ts --root <web> --lang js-ts --entry <entry.ts> --out ../out/closure
node cli/pack-context.ts --closure ../out/closure --lang js-ts --out out/context.md
node cli/gen-golden.ts --lang js-ts --main <harness.mjs> --out out/gen-golden
```
closure 默认解析 tsconfig/jsconfig paths 与 vite alias（`--no-alias` 可关；断链看 unresolved.alias/target）；pack-context 默认带一层成员签名（`--no-members` 可关）。golden 后直接 adapt-arkts → diff-gate → lint/reach/build；机制案例见 `cases/js-ts`（`node cases/js-ts/run.mjs` 复跑 G1-G4）；规模化案例见 `cases/js-ts-yoga`（`node cases/js-ts-yoga/run.mjs`，3,303 行 MIT，4/4 PASS，ArkTS 136→0）。
### 4 产 golden（agent 判断场景）
```bash
node cli/gen-golden.ts --lang jvm --src <dir> --main <Main.kt> [--package <pkg>] [--out <dir>] [--json] [--report <path>]
```
场景覆盖空/满/超长/多段/特殊字符；exit 3 = 两次输出不一致，exit 4 = 缺 harness（先写 Main.kt）。
### 5 语义转写（agent 主战场）
Kotlin → TS：逐行等价；禁 any/unknown/as const/globalThis；浮点累加点标 `// F32:`；保留类名方法名；用可擦除语法。规则只查 `rules/arkts-restrictions.md`。
### 6 保真门禁（必须 100%）
```bash
node cli/verify-fidelity.ts --golden <golden.json> --actual <actual.json> [--key scenario] [--items pages] [--field text] [--json]
```
FAIL / MISSING → 只读 DIFF 行定位，不回读全文。
### 7 ArkTS 机械适配
```bash
node cli/adapt-arkts.ts --src <ts-dir> --out <ets-dir> --ets --report out/adapt-report.json [--json] [--fail-on-residual]
```
只看 `report.residuals`；`crossfile-type-ref` / `rename-uncertain` 要人工看（值 import 的跨文件类型引用不会自动改名；改成 import type 或手工处理）；修完**重跑第 6 步**。
### 8 残余错误定位
```bash
node cli/explain-errors.ts --log <hvigor.log|errors.json> [--root <ets-root>] [--max 20] [--rule arkts-*] [--json] [--report <path>]
```
输出 = 规则 / file:line:col / 源码片段 / 修法锚点；`file="?"` 单列；不再自己写扫描脚本。
### 9 编译门禁（两步都要，必须 0）
```bash
node cli/lint-arkts.ts --project <harmony> [--sdk <p>] [--hvigor <p>] [--json] [--report <path>]
node cli/reachability-probe.ts --project <harmony> [--src entry/src/main/ets] [--entry pages/Index.ets] [--sdk <p>] [--hvigor <p>] [--json] [--report <path>]
```
第二步不可省：入口可达只检查一部分文件，全量可达才看得到全部。**WARN 级 arkts-* 也算违规**（globalThis 实测 WARN）。lint 默认每次干净构建（清 .hvigor/cache 与模块 build，约 6-7s），门禁/CI 禁止 `--no-clean`；失败先跑第 8 步 explain-errors。
### 10 一键门禁（可选，推荐）
```bash
node cli/port.ts --project <harmony> --src <src-root> --adapt-src <ts-dir> --adapted <ets-dir> --case <case-dir> --sdk <p> --hvigor <p> --stages all --report out/port-report.json [--json] [--continue]
```
阶段顺序：analyze→adapt→diff→fidelity→lint→reach→build→device。**默认 strict**：adapt 残留（exit 3）→ FAIL；`--allow-residuals` 是唯一放行开关（需在报告中记录理由）。**device 可选**：`--device <ip:port>` 才启用；`--signed-hap <hap> --bundle <id> --ability EntryAbility` 做 install+launch+screenshot，无 signed-hap 只 check；默认 7 阶段不变。**diff 阶段是 WARN**：needs-review>0 只告警不阻断，`--strict-diff` 才把它当失败；报告 counts 含 warn。**lint/reach FAIL 自动跑 explain-errors**（`--no-explain` 关闭，`--explain-max` 默认 5），摘要直接给规则 + file:line。**device 失败即停**；截图写 `<logs>/device.jpeg`，metrics 含 check/install/launch/screenshot。
### 11 构建
```bash
node cli/build-hap.ts --project <harmony> [--mode debug|release] [--sdk <p>] [--hvigor <p>] [--log <path>]
```

## 三道门禁
| 门禁 | 通过条件 | 不通过 |
|---|---|---|
| 保真 | 100%（逐项全等；MISSING 也算 FAIL） | 回第 5 步，按 DIFF 定位 |
| ArkTS | lint 0 + 全量可达 0；**含 WARN 级 arkts-*** | explain-errors + rules 修，禁止改语义 |
| 构建 | BUILD SUCCESSFUL | 查 `rules/pitfalls.md` |

## 发布回归（一条命令）
```bash
node scripts/acceptance.mjs --refs <refs> [--sdk <p> --hvigor <p>]
```
5 阶段硬断言：stage 22/4,925、golden sha256、replay 62/62、adapt 43/41/9/9/7、arkts-gate 两种口径（codemod 9 诊断 vs 参考 0 错误 + build）。无 SDK 自动 SKIP arkts-gate；证据变了就 FAIL。

## 真机（可选）
```bash
node cli/device-test.ts --target <ip:port> --check [--hdc <sdk>/toolchains/hdc]
node cli/device-test.ts --target <ip:port> --hap <signed.hap> --install --bundle <id> --ability EntryAbility --screenshot out/device.jpeg
```
安装失败读 errorCode：9568320 未签名 / 9568257 profile 不被信任 / 9568258 deviceType 不匹配；不绕过签名。签名后用 `--bundle --ability` 启动并抓 hilog。

## 案例复现（外部证据）
案例依赖外部 `.refs` 的 TS 产物（GPL 派生，不入库）：`node scripts/stage-case.mjs --refs <refs> --case cases/legado`；`--check` 校验 sha256；`cases/*/ts/` 已在 `.gitignore`。

## agent 只做判断
- 做：模块是否纯逻辑/能否产 golden；场景设计；语义转写；residuals/needs-review 判断；覆盖率不足时决定放弃。
- 不做：手工串命令、复读日志、逐条复制错误、重做 codemod 适配、UI 重写、真机验证、把 diff-gate 当语义证明。

## 环境与参考
Node ≥22（实测 26.13.0）；`OHOS_BASE_SDK_HOME`、`HVIGOR_HOME` 见 README；规则 `rules/arkts-restrictions.md`、`rules/pitfalls.md`、`rules/api-mapping.md`；适配器 `adapters/README.md`；案例 `cases/legado/README.md`。

## 新案例落盘清单（模板：`cases/legado`、`cases/js-ts`、`cases/js-ts-yoga`）
1. 分诊：`node cli/analyze-coupling.ts --root <project> --lang <id> --json`（<15% 停）。
2. 闭包：`node cli/extract-closure.ts --root <project> --entry <entry> --lang <id> --out out/<case>/closure --report out/<case>/closure.json --json`（`--out` 必须在 `--root` 外）。
3. 上下文：`node cli/pack-context.ts --closure out/<case>/closure --lang <id> --out out/<case>/context.md --json`。
4. harness/golden：`node cli/gen-golden.ts --lang <id> --main cases/<case>/harness/<name>.mjs --out out/<case>/golden --json`（jvm：`--src <closure> --main <closure>/Main.kt`；`--out` 在 harness 目录外）。
5. replay/保真：`node cases/<case>/replay.ts > out/<case>/actual.json`（或 `cases/js-ts/replay.mjs`）；`node cli/verify-fidelity.ts --golden out/<case>/golden/golden.json --actual out/<case>/actual.json`（形状不同加 `--items/--field`；必须 100%）。
6. adapt/diff：`node cli/adapt-arkts.ts --src out/<case>/closure --out out/<case>/adapt --ets --report out/<case>/adapt.json`；`node cli/diff-gate.ts --before out/<case>/closure --after out/<case>/adapt --json`。
7. probe：`node cli/reachability-probe.ts --project <parity> --sdk $OHOS_BASE_SDK_HOME --hvigor $HVIGOR_HOME --json`（0 ERROR + 0 WARN）。
8. 落盘：`cases/<case>/README.md`（范围/命令/期望数字/证据）+ `harness/` + `replay.*` + `golden.json`；外部证据用 `stage-case`/闭包副本、日志进 `out/`（gitignored）。
9. 证据/模板：sha256、条数、错误数写进 README；JVM 模板 `cases/legado/README.md`，js-ts 模板 `cases/js-ts/README.md`、`cases/js-ts-yoga/README.md`。
