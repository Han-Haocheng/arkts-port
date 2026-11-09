# JVM（Kotlin / Java）

**状态：已验证**（legado 分页算法，2,898 行 → 100% 保真）

## 分诊

耦合判据：`import android.*` / `androidx.*` / `kotlinx.coroutines` / `dagger.*` / `com.google.android.*`

legado 实测：2108 文件 / 404,343 行，耦合 87%，**可自动覆盖率 13.1%**。

## 抽闭包

0. 先跑工具（推荐）：
   ```bash
   node cli/extract-closure.ts --root <project> --entry <Entry.kt> --out out/closure --report out/closure.json
   ```
   `include` 是可直接复制的闭包；`boundaries` 是耦合边界（不深入）；`manualExtractions` 列出耦合文件里被闭包需要的声明（含行号）。
1. 从目标入口开始，把被引用的文件收进 `src/`
2. 删掉依赖 Android / 协程的层（往往只用于测量/调度，不是算法本体）
3. 只用到注解的（`@Stable`）→ 去掉注解
4. 声明混在无关文件里的 → 按 `manualExtractions` 抽成独立小文件

## 产 golden

```bash
node cli/gen-golden.ts --lang jvm --src src --main src/Main.kt --out out/golden
```

等价于 ``kotlinc src -d out && kotlin -cp out <package>.Main > golden.json``；工具会跑两次并逐字节比较输出，稳定后才写 golden。模板见 `templates/kotlin-harness/`。

## 转写注意

| Kotlin | TS/ArkTS |
|---|---|
| `data class` | class + readonly 字段 + 手写 `copy` |
| `sealed interface` | 判别联合 + `readonly kind` |
| `enum class` | 真 enum 或 const 对象 + 类型别名 |
| 扩展函数 | 普通函数 |
| `Float`（32 位） | number（64 位）→ 标 `// F32:` |
| `Long` 位运算 | `BigInt` |
| 协程 / Flow | async/await |

## 坑

- `Partial<T>` 在 ArkTS 不可用于对象字面量 → 每类补一个 `XxxPatch`（adapt-arkts 自动生成）
- 类型名与值名不能同名 → 类型加 `Value` 后缀（adapt-arkts 自动改名，跨文件具名 import 同步）
- 可达性：没人 import 的文件不会被检查（见 `rules/pitfalls.md`）；门禁必须跑 `reachability-probe`
- 适配后先用 `diff-gate` 确认只动类型层，再进编译门禁
