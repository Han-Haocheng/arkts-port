# Swift（iOS）

**状态：待接入**

## 分诊

耦合判据：`import UIKit`、`import SwiftUI`、`import Foundation`

## 产 golden

```bash
swiftc harness.swift -o harness && ./harness > golden.json
```

需要 macOS（或 Linux 上的 Swift 工具链，但 UIKit 相关跑不了）。

## 转写注意

- `struct` 值语义 → class 或普通对象，注意复制语义差异
- `protocol` + extension → interface + 独立函数
- 可选值 `?` 与 `!` → ArkTS 的可空类型，别用 `!` 强解包
- `async/await` 结构接近，但 actor 并发模型没有对应物
