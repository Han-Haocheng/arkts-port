# JavaScript / TypeScript（RN、小程序、Hybrid）

**状态：工具侧可用（机制验证中）**（`extract-closure` / `pack-context` / `gen-golden` 已支持 `--lang js-ts`；真实机制案例见 `cases/js-ts`；规模化案例待选纯 TS 库）

## 为什么这一类最省事

ArkTS 是 TypeScript 的**受限超集**，所以：

- **不需要语义转写**：源码本身就是 TS，直接进适配阶段
- 只需要处理两件事：
  1. ArkTS 的 7 类语法限制（见 `rules/arkts-restrictions.md`）
  2. 平台 API 替换（DOM / RN 原生模块 → ArkTS kit）

## 分诊

耦合判据（`languages.json` 里的 `js-ts`，25 条 pattern）：

- 框架：`react-native`、`@tarojs/`、`vue`/`pinia`/`vue-router`/`element-plus`/`@vue`/`axios`/`vite`
- 资源 import：`.vue/.css/.scss/.png/.svg` 等（含 `?raw`/`?url`）
- 浏览器 API：`document.*`、`window.location`、`localStorage`、`navigator.*`、`new WebSocket` 等

分诊会单列 `.d.ts`（dts）与纯数据配置（dataOnly），不计入「可自动」；分母仍是全部行数。

## 抽闭包 / 上下文包

```bash
node cli/extract-closure.ts --root <project> --lang js-ts --entry src/foo.ts --out ../out/closure
node cli/pack-context.ts --closure ../out/closure --lang js-ts --out out/context.md
```

相对 import 解析 ESM/CJS/动态 import/目录 index/扩展名互换；非相对 import 先按 `tsconfig/jsconfig` 的 `baseUrl+paths`、再按 `vite.config` 的 `resolve.alias` 解析（静态读，不 eval），解析不到才记 external（带 alias/target 标注）；`--no-alias` 可关；命中 platformPatterns 记 coupled boundary；`node_modules` 等自动跳过。

`pack-context --lang js-ts` 现在索引顶层导出 + class/interface/对象类型别名的一层成员（方法/属性/constructor，不带函数体）；`--no-members` 可关。

## 产 golden

```bash
node cli/gen-golden.ts --lang js-ts --main harness.mjs --out out/gen-golden
```

等价于 `node harness.mjs > golden.json`，但会跑两次并逐字节比较输出；缺 harness 时退出码 4 并生成骨架。模板见 `templates/node-harness/`。

因为原代码本来就能在 Node 跑，golden 最容易拿——这是这类语言相对 JVM 的优势。

## 转写注意

- 动态特性要拆：`obj[key]` 动态属性、`eval`、`arguments`、`with` 都不被 ArkTS 接受
- 结构类型 → 显式 interface（和 JVM 案例里 `arkts-no-untyped-obj-literals` 同一类问题）
- 三方库依赖要换：`axios` → `@kit.NetworkKit`，`lodash` 的部分函数 → 手写
- 如果原项目是 Vue/React 且 UI 占比高，注意：**UI 仍要重写成 ArkUI**

## 限制

- 别名只覆盖 `--root` 下的 tsconfig/jsconfig（含 references/相对 extends）与 vite `resolve.alias` 字面量；子目录独立 tsconfig、monorepo 多包、`package.json imports`、非字面量 alias 值仍记 external（不猜）。
- 不做 TS 语义解析：`export =`、非字面量 `import()`、`import x = require()` 只按 `require` 抓。
- 签名索引是启发式：跨行 `= {` 会截断，超 2000 字符截断；模板字符串/JSX 极端写法可能被掩码误判。
- UI（Vue/React 组件）仍要重写成 ArkUI；js-ts 只覆盖纯逻辑与数据层。
