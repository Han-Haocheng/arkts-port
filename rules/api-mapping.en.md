# Android → ArkTS API mapping

[Documentation index](../docs/README.md) · [简体中文](api-mapping.md)

Only mappings that have been **measured in practice** are recorded; unverified ones are not written down.

## Data

| Android | HarmonyOS | Notes |
|---|---|---|
| `RoomDatabase` | `relationalStore.RdbStore` | The Promise forms of `executeSql/querySql` are the least trouble |
| `@Entity` fields | `CREATE TABLE` DDL | Room entities can be scripted into SQL |
| `SharedPreferences` | `preferences.getPreferences(context, name)` | Remember `flush()` |
| `ContentProvider` / `MediaStore` | No direct equivalent | Go through a picker + sandbox copy |

## Files and parsing

| Android | HarmonyOS | Notes |
|---|---|---|
| `java.io.File` | `fileIo` from `@kit.CoreFileKit` | The kit export name is `fileIo`, not `fs` |
| `ZipInputStream` | `zlib.decompressFile` | Can only decompress a whole archive |
| `XmlPullParser` | `xml.XmlPullParser` from `@kit.ArkTS` | See pitfalls |
| `Charset.forName("GBK")` | `util.TextDecoder.create('gbk')` | The argument is a Uint8Array |

## UI

| Android | HarmonyOS | Notes |
|---|---|---|
| `Activity` | `UIAbility` + `windowStage.loadContent` | |
| `Intent` navigation | `Navigation` + `NavPathStack` | `router` is deprecated |
| Compose `Text` | ArkUI `Text` | Declarative, but the layout/measure model differs — **cannot be auto-converted** |
| Compose `LazyColumn` | `List` + `LazyForEach` + `IDataSource` | Large data sets must use LazyForEach |
