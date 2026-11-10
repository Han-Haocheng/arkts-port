# 踩坑清单

[文档索引](../docs/README.md) · [English](pitfalls.en.md)

## 构建工具链（Linux 无 DevEco）

| 现象 | 原因 | 处理 |
|---|---|---|
| `00308018 SDK management mode has changed` | OpenHarmony SDK 组件没放在版本号子目录 | 必须是 `$OHOS_BASE_SDK_HOME/26.0.0/{ets,js,native,toolchains,previewer}` |
| `00306042 Specification Limit Violation` | API ≥ 26 的 SDK 版本号必须写字符串 | `"compileSdkVersion": "26.0.0"`，写数字 26 会被拒 |
| `00303060` syscap 交集为空 | `deviceTypes` 写了 `phone` | OpenHarmony SDK 只认 `default/tablet/2in1/tv/wearable/liteWearable` |
| `DEVECO_SDK_HOME` invalid | `runtimeOS` 仍是 HarmonyOS | 改用 `runtimeOS: "OpenHarmony"` + `OHOS_BASE_SDK_HOME` |
| 插件解析失败 | 项目里没有 node_modules | 设 `NODE_PATH=<hvigor>/node_modules`，不必建软链 |

## 类型检查可达性（最容易被忽略）

ArkTS 的语义检查是**从 entry 出发的可达图**驱动的。没人 import 的文件不会被检查，
所以「构建成功」不等于「全部代码合规」。

- 实测：22 个模块，入口只引到 7 个 → 报 135 个错误；全量可达 → 177 个
- 门禁必须用 `cli/reachability-probe.ts`（在临时副本注入侧效应 import 探针）
- 探针 import 必须放在文件**最前面**，ArkTS 不允许 import 出现在其它语句之后（`arkts-no-misplaced-imports`）

## 数值语义

- **Kotlin `Float` 是 32 位，JS/ArkTS `number` 是 64 位**。分页、布局这类累加运算在边界值上会差 1 个单位，
  导致断行/分页位置不同。转写时把所有浮点累加点标 `// F32:`，出现"只差一两页"时优先在累加点加 `Math.fround`。
- Kotlin `Long` → `number` 会丢 64 位精度；涉及位运算（如 revision xor）要用 `BigInt`。

## 平台 API 差异

| Android | HarmonyOS | 坑 |
|---|---|---|
| `Context.getFilesDir()` | `context.filesDir` | 无 `Uri` 抽象；picker 返回 `file://docs/...`，要复制进沙箱 |
| Room | `relationalStore` | `beginTransaction()` 同步、`createTransaction()` 异步，不能混用；ResultSet 必须 `close()` |
| `SharedPreferences` | `preferences` | `put()` 后必须 `flush()` 才落盘 |
| `java.util.zip` | `zlib` | **没有 zip 归档模块**；`decompressFile` 要求输入后缀 `.zip` 且输出目录必须已存在。EPUB 要先改名 `.zip` |
| `XmlPullParser` | `@kit.ArkTS` 的 `xml` | 只接受 ArrayBuffer；`ParseInfo` **没有** `getAttributeValue`，属性值要走 `attributeWithTagCallbackFunction` |
| Rhino（JS 引擎） | QuickJS / ArkWeb | ArkTS 禁止反射和动态加载，Rhino 路径直接断 |
## 真机安装错误码（hdc install）

| code | 含义 | 处理 |
|---|---|---|
| `9568320` | no signature file | HAP 未签名；用 Huawei AGC 调试证书 + provisioning profile 签名后再装 |
| `9568257` | fail to verify pkcs7 | profile/签名链不被真机信任；OpenHarmony 调试签名 ≠ Huawei AGC 调试签名（本地 verify-app 通过也会被拒） |
| `9568258` | deviceType 不匹配 | module.json5 的 deviceTypes 加 `phone`/`default` 后重建 |
| `9568276` | install already exist | 残留安装记录/bundle 已存在；先 `hdc uninstall <bundle>` 清残，再 `hdc install -r`（`device-test --install`）；不要为此改 bundleName |
