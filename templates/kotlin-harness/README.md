# Kotlin golden harness 模板

把目标模块的依赖闭包抽出来，用 `kotlinc` 独立编译，写一个 `main` 输出 JSON。

## 步骤

1. 复制闭包源码到一个空目录 `src/`（只留无 Android 依赖的文件）
2. 处理挡路的依赖：
   - 只用到注解的（如 `@Stable`）→ 去掉注解
   - 声明混在无关文件里的 → 抽成单独小文件（见 cases/legado 的 `ParagraphDecoration.kt`）
   - 依赖协程/Android 的整层 → 直接删，用更底层的入口驱动
3. 写 `Main.kt`：构造固定场景 → 调用目标 API → 输出 JSON
4. 编译运行：

```bash
kotlinc src -d out
kotlin -cp out <package>.Main > golden.json
```

## 注意

- 场景要覆盖边界：空输入、刚好填满、超长、多段、特殊字符
- 输出要稳定：不要带时间戳、随机数、绝对路径
- **不要用真实字体度量**（除非你能保证两边一致），用显式给定的宽度数组更可靠
