# Dart（Flutter）

**状态：待接入**

## 先判断走哪条路

| 目标 | 建议 |
|---|---|
| 把 Flutter 应用迁到鸿蒙 | **走 OpenHarmony SIG 的 `flutter_flutter` 重编**，不做源码转换 |
| 只复用 Dart 里的纯逻辑（解析、算法、协议） | 走本流水线：Dart → TS → ArkTS |

## 分诊

耦合判据：`import 'package:flutter/`、`dart:ui`、`dart:io`

Flutter 应用里 UI 占比通常 70%+，所以**可自动覆盖率天然很低**——先跑 `analyze-coupling --lang dart` 看数。

## 产 golden

```bash
dart run harness.dart > golden.json
```

## 转写注意

- Dart 的 `Future`/`Stream` → Promise / 回调
- `late`、`mixin`、扩展方法都要改写
- 数值：Dart 的 `int` 是 64 位、`double` 是 64 位；与 JS number 语义接近，比 JVM 的 Float32 好处理
