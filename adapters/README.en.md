# Language adapters

[Documentation index](../docs/README.md) · [简体中文](README.md)

The pipeline's **stages are language-agnostic**; only three hooks vary:

| Hook | Role | Provided by |
|---|---|---|
| `platformPatterns` | Decides whether a file is coupled to the original platform (determines the "auto-convertible rate") | One regex set per language |
| `goldenRunner` | How to run the original logic to produce baseline data | Each language's execution mechanism |
| `harnessTemplate` | Template for the baseline driver script | `templates/<lang>-harness/` |

**What does not change** (shared by all languages):

- Fidelity gate: `cli/verify-fidelity.ts`
- ArkTS adaptation rules: `rules/arkts-restrictions.en.md`
- Full reachability check: `cli/reachability-probe.ts`
- Build: `cli/build-hap.ts`

## Support matrix

| Language | Can produce golden | Semantic transcript | Status | Notes |
|---|---|---|---|---|
| **Kotlin / Java (JVM)** | ✅ kotlinc / javac | Kotlin → TS | ✅ **Validated** | legado case: 2,898 lines → 100% fidelity |
| **JavaScript / TypeScript** | ✅ node | Can be skipped | ⬜ Pending | ArkTS is a superset of TS, so only the adaptation stage is needed — lowest cost |
| **Dart (Flutter)** | ✅ dart | Dart → TS | ⬜ Pending | For whole-package migration, prefer rebuilding with flutter_flutter |
| **C / C++ (NDK)** | ✅ clang | C → TS | ⚠️ Restricted | Recommended only for pure algorithm libraries; with source available, use the OHOS NDK instead |
| **Swift (iOS)** | ✅ swiftc (macOS) | Swift → TS | ⬜ Pending | |
| C# (Unity) | ❌ | — | Not applicable | Use Unity's official HarmonyOS support |
| Closed-source/obfuscated APK | ❌ | — | Not applicable | Legal risk + uncontrollable quality |

## What it takes to add a language

1. Add a section to `languages.json`: extensions, platform-coupling regexes, how golden runs
2. Add a harness template under `templates/` (a minimal runnable `main`)
3. Write that language's pitfalls in `adapters/<lang>.md`
4. Get one real module through the whole chain: triage → golden → transcript → 100% fidelity → 0 ArkTS errors
5. Write the result into `cases/`
