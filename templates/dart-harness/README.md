# Dart golden harness 模板（Flutter 项目里的纯逻辑）

**状态：未验证模板**

```dart
// harness.dart
import 'dart:convert';
import '../lib/src/parser.dart';

void main() {
  final scenarios = [
    {'name': 's1', 'text': '一二三四五六七八九十'},
  ];
  final out = scenarios.map((s) => {
        'scenario': s['name'],
        'result': parse(s['text'] as String),
      }).toList();
  print(jsonEncode(out));
}
```

运行：`dart run harness.dart > golden.json`

注意：只对不依赖 `flutter` 包的纯逻辑生效；带 Widget 的部分跑不起来，也就进不了流水线。
