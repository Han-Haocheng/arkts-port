# Kotlin 真值 harness 模板

把一个 Kotlin 模块的「可测纯逻辑」抽出来，用 `kotlinc` 独立编译成真值 harness，输出**确定性 JSON**；
TS 侧写一份镜像实现，用 `compare.mjs` 与 Kotlin 逐字段比较，得到转写保真度。

模板文件：

| 文件 | 作用 |
| --- | --- |
| `harness.kt` | Kotlin 真值 harness 骨架：JSON 编码器 + 纯逻辑示例 + 内存 Fake + `main()` |
| `harness.example.ts` | 与 `harness.kt` 场景逐字段一致的 TS 镜像（示例，可直接改成真实实现） |
| `compare.mjs` | 编译/运行 Kotlin、运行 TS、两次运行稳定性检查、逐字段比较（exit 1 表示不一致） |
| `Main.example.kt` | 旧的分页 golden 示例（`cli/gen-golden.ts` 复制它做 jvm 骨架；本模板不依赖它） |

## 快速开始

```bash
# 1) 只编译运行 Kotlin 真值（先看输出是否稳定）
kotlinc templates/kotlin-harness/harness.kt -d /tmp/kt-classes
kotlin -cp /tmp/kt-classes HarnessKt > /tmp/kotlin.json
kotlin -cp /tmp/kt-classes HarnessKt > /tmp/kotlin2.json
cmp /tmp/kotlin.json /tmp/kotlin2.json   # 必须一致

# 2) 与 TS 镜像比较（逐字段；Float/Long/round 语义见下）
node templates/kotlin-harness/compare.mjs \
  --ts templates/kotlin-harness/harness.example.ts \
  --classes /tmp/kt-classes \
  --out /tmp/kt-golden
```

`compare.mjs` 参数：

- `--ts <script>`（必填）：TS harness，`node <script>` 输出一个 JSON。
- `--kotlin <harness.kt>`：默认本目录 `harness.kt`；主类默认由文件名推导（`harness.kt` → `HarnessKt`），可用 `--main-class` 覆盖。
- `--classes <dir>`：给出已编译目录可跳过 `kotlinc`（CI 里先编译一次、多处比较时有用）。
- `--out <dir>`：把两份输出落盘为 `golden.kotlin.json` / `golden.ts.json`。
- `--json`：机器可读报告；`--keep`：保留临时工作目录；`--kotlinc/--kotlin-bin`：指定外部工具路径。

退出码：`0` 一致且两次运行稳定；`1` 不一致/不稳定/解析失败/编译失败；`2` 用法错误。

## 编码约定（两边必须一致）

```jsonc
{
  "int": 42,                                            // Int：普通 JSON 数字（安全整数范围内）
  "long": { "kind": "i64", "value": "123456789012" }, // Long：十进制字符串（BigInt 精确）
  "float": { "kind": "f32", "bits": "1099169792" },   // Float：无符号 32 位 raw bits
  "double": { "kind": "f64", "bits": "4624633867356078080" }, // Double：无符号 64 位 raw bits
  "text": "第1章",                                      // String/Boolean：JSON 原生
  "list": [1, 2, 3]                                      // 数组/对象：JSON 原生（对象键固定顺序）
}
```

- 保留对象：只允许恰好两个键——`{kind:"i64",value}`、`{kind:"f32",bits}`、`{kind:"f64",bits}`；
  真实数据对象不要用 `kind`/`value`/`bits` 这三个键名（见「限制」）。
- Kotlin 侧用 `Json.i64/f32/f64`；TS 侧用 `i64/f32/f64` 帮助函数（见 `harness.example.ts`）。
- 输出必须是**单个 JSON**（一行或多行皆可，stdout 只放 JSON）；调试输出走 stderr。

## Float/Long/round 语义（模板的核心）

### Float/Double：比 raw bits，不比数值

- 两端都把浮点转成 IEEE-754 raw bits（Kotlin：`Float.toRawBits()`/`Double.toRawBits()`；
  TS：`Float32Array`/`DataView`），比较器按 bits 严格比较。
- 这样能暴露：单/双精度差异、累加顺序差异、`-0.0` vs `0.0`、NaN payload 差异、`fround` 漏加等；
  用 `a === b` 比浮点会漏掉这些。
- 不要用 `toFixed`/`round` 后再比较——那会把差异抹平。

### Long：BigInt 十进制字符串

- Kotlin `Long` 是 64 位；TS `number` 只有 53 位安全整数。凡是 Long 一律编码成 `{kind:"i64",value}`，
  比较器转 `BigInt` 精确比较。TS 侧写 `BigInt(...)`，不要用 `Number` 中转。

### round：ties-to-even ≠ Math.round

- Kotlin `kotlin.math.round(x)`：**ties-to-even**（2.5 → 2，3.5 → 4，-2.5 → -2）。
- Kotlin `Math.round(x)` / JS `Math.round(x)`：**ties-to-+∞**（2.5 → 3，-2.5 → -2）。
- 两个语义都要在 harness 里显式出现（模板输出 `halfEven`/`halfUp` 两列对照），TS 侧必须实现
  `roundHalfEven`，不能拿 `Math.round` 顶替——`harness.example.ts` 里有参考实现。

## 确定性要求

- 场景固定：不读时间、随机数、环境变量、网络、字体度量、文件系统。
- 输出排序：Map/对象按固定键顺序（或先排序）输出；数组顺序固定。
- 同一输入两次运行 stdout 必须**逐字节相同**；`compare.mjs` 对 Kotlin 和 TS 都各跑两次并比较字节，
  不稳定直接 exit 1（`KOTLIN_UNSTABLE`/`TS_UNSTABLE`）。

## 内存 Fake 与单线程

- `FakeChapterLengths`（`harness.kt`）用 `mutableMap` 替代 DB/SharedPreferences/Android Context：
  单线程、无 IO、无真实存储；`get/put/remove/size` 语义要与真实实现一致（尤其是缺省值）。
- 真实模块接入时，把所有平台依赖替换成内存 Fake 或固定桩；**不复制上游源码进仓库**，
  harness 场景自己构造输入。
- 需要多线程/协程语义的模块不要用这个模板（本模板只覆盖单线程纯逻辑）。

## 把模板接到一个真实模块

1. 抽依赖闭包：只保留无 Android 依赖的源文件到临时目录；注解（`@Stable` 等）去掉；
   声明散落在无关文件的，抽成小文件；协程/Android 层删掉，用更底层入口驱动。
2. 写 `harness.kt`：固定场景 → 调目标 API → 用 `Json.*` 输出；Long/浮点按上面的编码。
3. 写 TS 镜像：同一场景、同一编码；浮点用 `Math.fround`/`DataView`，Long 用 `BigInt`，round 用 ties-to-even 实现。
4. 跑 `compare.mjs`：先要求两边各自两次运行稳定，再看 `FIDELITY_OK`；不一致会打印 `path/kind/kotlin/ts`。
5. 把 golden（`--out`）与场景说明一起归档，作为后续回归的基准。

## 限制

- 只证明「fixture 覆盖的输入上两端一致」，不证明真实 Android 运行时行为（字体度量/线程/IO 不在范围内）。
- 保留对象键名（`kind`/`value`/`bits`）与真实数据键冲突时会被误判为标量；数据对象请换字段名或包一层。
- 依赖外部 `kotlinc`/`kotlin`（零 npm 依赖，但不自带 JVM 工具链）；`--classes` 可复用编译产物。
- TS 侧 `number` 与 Kotlin `Double` 的十进制解析不完全一致（如 `0.1`），凡涉及 Double 的输出建议也走
  `f64` bits；模板的示例已这样处理。

## 测试

```bash
node --test tests/kotlin-harness.test.ts
```

覆盖：模板自带的 Kotlin/TS 逐字段一致（且两份 golden 逐字节相同）、round 语义不一致、Float/Long 编码类型不一致、
两次运行确定性、用法错误退出码。