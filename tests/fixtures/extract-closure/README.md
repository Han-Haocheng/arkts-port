# extract-closure fixtures

自造 fixture（不依赖上游仓库），供 `node --test tests/extract-closure.test.ts` 复跑。

## kotlin-basic/project

| 文件 | 覆盖点 |
|---|---|
| `src/main/java/com/acme/app/Entry.kt` | entry；显式 import + `model.*` star import + 缺失的内部 import（`com.acme.app.ghost.Ghost`） |
| `src/main/java/com/acme/app/Local.kt` | 同 package 无 import 的引用（`Local()`）与同文件多声明（`EngineState`） |
| `src/main/java/com/acme/app/Stale.kt` | 同 package 内没人引用的纯逻辑文件：严格模式不纳入，package 补全模式纳入 |
| `src/main/java/com/acme/app/model/Widget.kt` | star import 实际用到的内部符号 |
| `src/main/java/com/acme/app/model/UnusedModel.kt` | star import 目标 package 里没被用到的符号：不得纳入 |
| `src/main/java/com/acme/app/model/Annotated.kt` | `import androidx.compose.runtime.Stable` 只用于 `@Stable` → 不算耦合（removableImports） |
| `src/main/java/com/acme/app/util/Helper.kt` | 普通跨 package import |
| `src/main/java/com/acme/app/cycle/CycleA.kt` / `CycleB.kt` | 循环依赖（A↔B）各出现一次、不重复不丢 |
| `src/main/java/com/acme/app/platform/Clock.kt` | 命中 platformPatterns 且被引用 → coupled boundary（android.os.SystemClock） |
| `src/main/java/com/acme/app/platform/UnusedPlatform.kt` | 耦合但没人引用 → 不得出现在报告里 |
| `src/test/java/com/acme/app/EntryTest.kt` | 测试源集：生产闭包不含 test 文件；以它为 entry 时角色记 test |

## java-basic/project

`.java` 的 package/import/同包引用解析；未使用的 `java.util.List` 记 external unresolved。

## invalid/project

`src/main/java/Broken.kt` 没有 package 声明 → entry 无法解析，退出码 1。

## 复跑

```bash
node --test tests/extract-closure.test.ts
node cli/extract-closure.ts --root tests/fixtures/extract-closure/kotlin-basic/project \
     --entry src/main/java/com/acme/app/Entry.kt --json
```
