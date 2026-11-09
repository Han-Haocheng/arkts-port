# ArkTS 严格模式限制清单

## ⚠️ 先看这条：ArkTS 只检查「从 entry 可达」的模块

直接构建只会检查 entry 能 import 到的文件。实测：22 个模块里，入口只引到 7 个，
所以第一次编译只报 **135** 个错误；把全部模块拉进可达图后变成 **177 个硬错误 + 1 条 WARN（共 178 条原始记录）**，
多出的 42 条分布在 8 个**从未被检查过**的文件里。

**结论：门禁必须用 `cli/reachability-probe.ts` 做全量检查**，否则会出现「编译绿了但一半模块没检查」的假通过。
（自测：往一个无人 import 的文件注入 `as const`，普通构建 0 错误，探针立刻抓到。）

---

实测来源：把 4,925 行 TypeScript（Kotlin 分页算法转写产物）丢进 ArkTS 编译器，
全量可达时 **178 条原始记录 = 硬 177 + 1 条 WARN**。全部是**语法规则**，没有一条是逻辑错误。

| 规则 | 入口可达 135 | 全量可达 178 | 含义 | 修法 |
|---|---|---|---|---|
| `arkts-no-untyped-obj-literals` | 67 + 补充 | 98 | 对象字面量必须对应显式声明的 class/interface | 把内联对象类型抽成 `interface` |
| `arkts-no-obj-literals-as-types` | 42 | 50 | 不能用内联对象类型做参数类型 | 同上，构造器参数改为具名 interface |
| （copy Partial 调用点） | — | 41 | `copy(patch: Partial<X>)` 的对象字面量调用点也违规 | 每类再补一个 `XxxPatch` 可选字段 interface |
| `arkts-unique-names` | 16 | 18 | 类型名与值名不能同名 | `type X` + `const X` → 类型改名 `XValue` |
| `arkts-no-as-const` | 8 | 9 | 禁止 `as const` | 删掉，需要字面量类型处显式标注 |
| `arkts-no-globalthis` | 1（WARN） | 1（WARN） | 禁止 `globalThis` | 改模块级变量 |
| `arkts-no-any-unknown` | 1 | 1 | 禁止 `unknown` | 换具体类型 |
| `arkts-no-aliases-by-index` | 1 | 1 | 禁止按索引取类型别名 | 显式声明 |

## codemod 覆盖范围（cli/adapt-arkts.ts）

自动修（4 类）：
- 构造器内联对象类型 → `<Class>Options`
- `copy(patch: Partial<Self>)` → `<Class>Patch`
- 同名 `type X` + `const X = {...} as const` → 类型改名 `XValue` + `<X>Map` + 删 `as const`；**只改类型位置**（值位置 `= X` / `{ X }` / `X.A` 不动）；跨文件只认 `import type` 且全部用法为类型位置，否则报 `crossfile-type-ref`，拿不准报 `rename-uncertain`
- 未配对的 `as const` 只报告

只报告为 residual（需人判断）：`globalThis`、`as unknown`、`any/unknown`、索引取类型 `X["k"]`、类外内联对象类型、无法安全判定的跨文件改名。

legado 实测：43 Options / 41 Patch / 9 as const / 9 对改名；178 原始 → codemod 后 8 条硬错误（4 个人工点）→ 0。

## 转写时就应该避开的 Kotlin 惯用法

| Kotlin | ArkTS 写法 | 说明 |
|---|---|---|
| `data class` | `class` + readonly 字段 + 手写 `copy(patch)` | ArkTS 无 data class |
| `sealed interface` | 判别联合 + `readonly kind` | 不要用 `instanceof` |
| `enum class` | 真 `enum`（ArkTS 支持）或 const 对象 + 类型别名（改名） | 注意 unique-names |
| 扩展函数 | 普通函数或类方法 | ArkTS 无扩展函数 |
| `List<T>` / `Sequence` | 数组 / 显式循环 | 标准库差异 |
| 协程 / Flow | async/await + 回调 | 并发模型不同 |
| `Float`（32 位） | number（64 位） | **精度差异会改变数值结果**，见 pitfalls |
