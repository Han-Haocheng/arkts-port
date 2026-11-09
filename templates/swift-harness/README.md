# Swift golden harness 模板

**状态：未验证模板**

```swift
// harness.swift
import Foundation

let scenarios: [(String, String)] = [("s1", "一二三四五六七八九十")]
var out: [String] = []
for (name, input) in scenarios {
    let result = parse(input)
    out.append("{\"scenario\":\"\(name)\",\"result\":\"\(result)\"}")
}
print("[" + out.joined(separator: ",") + "]")
```

运行：`swiftc harness.swift target.swift -o harness && ./harness > golden.json`（需 macOS）
