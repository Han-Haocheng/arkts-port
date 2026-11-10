# 语言适配器

[文档索引](../docs/README.md) · [English](README.en.md)

流水线的**阶段是语言无关的**，变的是三个钩子：

| 钩子 | 作用 | 谁提供 |
|---|---|---|
| `platformPatterns` | 判断文件是否耦合原平台（决定"可自动覆盖率"） | 每种语言一组正则 |
| `goldenRunner` | 怎么把原逻辑跑起来产出基准数据 | 每种语言的执行方式 |
| `harnessTemplate` | 基准驱动脚本的模板 | `templates/<lang>-harness/` |

**不变的部分**（所有语言共用）：

- 保真度门禁：`cli/verify-fidelity.ts`
- ArkTS 适配规则：`rules/arkts-restrictions.md`
- 全量可达检查：`cli/reachability-probe.ts`
- 构建：`cli/build-hap.ts`

## 支持矩阵

| 语言 | 可执行出 golden | 语义转写 | 状态 | 说明 |
|---|---|---|---|---|
| **Kotlin / Java（JVM）** | ✅ kotlinc / javac | Kotlin → TS | ✅ **已验证** | legado 案例：2,898 行 → 100% 保真 |
| **JavaScript / TypeScript** | ✅ node | 可跳过 | ⬜ 待接入 | ArkTS 是 TS 超集，只需过适配阶段，成本最低 |
| **Dart（Flutter）** | ✅ dart | Dart → TS | ⬜ 待接入 | 整包迁移优先用 flutter_flutter 重编 |
| **C / C++（NDK）** | ✅ clang | C → TS | ⚠️ 受限 | 只建议纯算法库；有源码应改用 OHOS NDK |
| **Swift（iOS）** | ✅ swiftc（macOS） | Swift → TS | ⬜ 待接入 | |
| C#（Unity） | ❌ | — | 不适用 | 走 Unity 官方 HarmonyOS 支持 |
| 闭源/混淆 APK | ❌ | — | 不适用 | 法律风险 + 质量不可控 |

## 新增一种语言要做什么

1. 在 `languages.json` 加一节：扩展名、平台耦合正则、golden 运行方式
2. 在 `templates/` 加 harness 模板（一个最小可跑的 `main`）
3. 在 `adapters/<lang>.md` 写这个语言的坑
4. 拿一个真实模块跑通：分诊 → golden → 转写 → 保真 100% → ArkTS 0 错误
5. 把结果写进 `cases/`
