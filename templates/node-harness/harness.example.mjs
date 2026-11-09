// templates/node-harness/harness.example.mjs
// 用法：node cli/gen-golden.ts --lang js-ts --main templates/node-harness/harness.example.mjs --out out/gen-golden/example
// 要求：固定输入；stdout 只输出 JSON.stringify(...)；运行两次逐字节一致（无时间戳/随机/绝对路径）。
//
// 1) 改成目标模块的真实导入（相对路径按 harness 所在位置解析）：
// import { paginate } from '../src/paginate.ts';
//
// 2) 写固定输入场景：
const scenarios = [
  // { name: 's1', input: { text: '一二三四五六七八九十', width: 40 } },
];

// 3) 把 result 换成目标函数的真实返回值；不要打印其它东西。
const out = scenarios.map((s) => ({
  scenario: s.name,
  result: s.input, // TODO: 替换为目标函数调用
}));

console.log(JSON.stringify(out));
