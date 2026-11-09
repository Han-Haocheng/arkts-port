# Android → ArkTS API 映射

只记录**已实测**的映射，没验证过的不写。

## 数据

| Android | HarmonyOS | 备注 |
|---|---|---|
| `RoomDatabase` | `relationalStore.RdbStore` | 用 `executeSql/querySql` 的 Promise 版最省事 |
| `@Entity` 字段 | `CREATE TABLE` DDL | Room 实体可脚本转 SQL |
| `SharedPreferences` | `preferences.getPreferences(context, name)` | 记得 `flush()` |
| `ContentProvider` / `MediaStore` | 无直接对应 | 走 picker + 沙箱复制 |

## 文件与解析

| Android | HarmonyOS | 备注 |
|---|---|---|
| `java.io.File` | `@kit.CoreFileKit` 的 `fileIo` | kit 导出名是 `fileIo`，不是 `fs` |
| `ZipInputStream` | `zlib.decompressFile` | 只能整包解压 |
| `XmlPullParser` | `@kit.ArkTS` 的 `xml.XmlPullParser` | 见 pitfalls |
| `Charset.forName("GBK")` | `util.TextDecoder.create('gbk')` | 入参是 Uint8Array |

## UI

| Android | HarmonyOS | 备注 |
|---|---|---|
| `Activity` | `UIAbility` + `windowStage.loadContent` | |
| `Intent` 跳转 | `Navigation` + `NavPathStack` | `router` 已废弃 |
| Compose `Text` | ArkUI `Text` | 声明式但布局/测量模型不同，**不能自动转** |
| Compose `LazyColumn` | `List` + `LazyForEach` + `IDataSource` | 大数据量必须用 LazyForEach |
