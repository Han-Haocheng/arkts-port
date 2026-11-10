# Pitfall list

[Documentation index](../docs/README.md) · [简体中文](pitfalls.md)

## Build toolchain (Linux without DevEco)

| Symptom | Cause | Handling |
|---|---|---|
| `00308018 SDK management mode has changed` | OpenHarmony SDK components are not under a version-number subdirectory | Must be `$OHOS_BASE_SDK_HOME/26.0.0/{ets,js,native,toolchains,previewer}` |
| `00306042 Specification Limit Violation` | For SDK versions with API ≥ 26 the version number must be written as a string | `"compileSdkVersion": "26.0.0"`; writing the number 26 is rejected |
| `00303060` syscap intersection is empty | `deviceTypes` says `phone` | The OpenHarmony SDK only accepts `default/tablet/2in1/tv/wearable/liteWearable` |
| `DEVECO_SDK_HOME` invalid | `runtimeOS` is still HarmonyOS | Switch to `runtimeOS: "OpenHarmony"` + `OHOS_BASE_SDK_HOME` |
| Plugin resolution fails | The project has no node_modules | Set `NODE_PATH=<hvigor>/node_modules`; no symlink needed |

## Type-check reachability (the easiest thing to overlook)

ArkTS semantic checking is driven by the **reachability graph starting from the entry**. Files that nobody imports are not checked,
so "the build succeeded" does not mean "all code is compliant".

- Measured: 22 modules, the entry referenced only 7 → 135 errors reported; full reachability → 177
- Gates must use `cli/reachability-probe.ts` (injects a side-effect import probe into a temporary copy)
- The probe import must be placed at the **very top** of the file; ArkTS does not allow imports after other statements (`arkts-no-misplaced-imports`)

## Numeric semantics

- **Kotlin `Float` is 32-bit; JS/ArkTS `number` is 64-bit.** Accumulating arithmetic such as pagination and layout is off by one unit at boundary values,
  which produces different line-break/page-break positions. During the transcript, mark every floating-point accumulation point with `// F32:`; when you see "off by only a page or two", add `Math.fround` at the accumulation point first.
- Kotlin `Long` → `number` loses 64-bit precision; anything involving bit operations (such as revision xor) must use `BigInt`.

## Platform API differences

| Android | HarmonyOS | Pitfall |
|---|---|---|
| `Context.getFilesDir()` | `context.filesDir` | No `Uri` abstraction; the picker returns `file://docs/...`, which must be copied into the sandbox |
| Room | `relationalStore` | `beginTransaction()` is synchronous and `createTransaction()` is asynchronous — do not mix them; ResultSet must be `close()`d |
| `SharedPreferences` | `preferences` | After `put()` you must `flush()` before it reaches disk |
| `java.util.zip` | `zlib` | **There is no zip archive module**; `decompressFile` requires an input suffix of `.zip` and an output directory that already exists. Rename EPUB to `.zip` first |
| `XmlPullParser` | `xml` from `@kit.ArkTS` | Accepts ArrayBuffer only; `ParseInfo` has **no** `getAttributeValue` — attribute values must go through `attributeWithTagCallbackFunction` |
| Rhino (JS engine) | QuickJS / ArkWeb | ArkTS forbids reflection and dynamic loading, so the Rhino path breaks outright |

## Real-device install error codes (hdc install)

| code | Meaning | Handling |
|---|---|---|
| `9568320` | no signature file | The HAP is unsigned; sign it with a Huawei AGC debug certificate + provisioning profile before installing |
| `9568257` | fail to verify pkcs7 | The profile/signature chain is not trusted by the real device; OpenHarmony debug signing ≠ Huawei AGC debug signing (it is rejected even if local verify-app passes) |
| `9568258` | deviceType mismatch | Add `phone`/`default` to deviceTypes in module.json5 and rebuild |
| `9568276` | install already exist | A residual install record/bundle already exists; run `hdc uninstall <bundle>` to clean it up first, then `hdc install -r` (`device-test --install`); do not change bundleName for this |
