# Node golden harness 模板（JS/TS 源码）

**状态：可用模板**（`gen-golden --lang js-ts` 能直接跑通；真实场景需替换导入与 scenarios）

可复制 `harness.example.mjs` 作为起点；它默认输出 `[]`，替换成目标模块后即可产 golden。

```js
// harness.mjs —— 用固定输入驱动目标逻辑，输出 JSON
import { paginate } from '../src/paginate.ts';

const scenarios = [
  { name: 's1', input: { text: '一二三四五六七八九十', width: 40 } },
];

const out = scenarios.map((s) => ({
  scenario: s.name,
  result: paginate(s.input),
}));

console.log(JSON.stringify(out));
```

推荐用 `cli/gen-golden.ts --lang js-ts --main <harness> --out <外部目录>` 编译并跑两次稳定性门禁；也可手工 `node harness.mjs > golden.json`。

要点：输入固定、输出稳定（无时间戳/随机/绝对路径）。
