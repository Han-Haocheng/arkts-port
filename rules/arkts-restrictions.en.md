# ArkTS strict-mode restriction list

[Documentation index](../docs/README.md) · [简体中文](arkts-restrictions.md)

## ⚠️ Read this first: ArkTS only checks modules reachable from the entry

A direct build only checks files the entry can import. Measured: of 22 modules, the entry referenced only 7,
so the first compile reported only **135** errors; after pulling every module into the reachability graph, that became **177 hard errors + 1 WARN (178 raw records in total)**,
with the extra 42 spread across 8 files that had **never been checked**.

**Conclusion: gates must use `cli/reachability-probe.ts` for a full check**, otherwise you get a false pass where "the build is green but half the modules were never checked".
(Self-test: inject `as const` into a file that nothing imports — a regular build reports 0 errors, and the probe catches it immediately.)

---

Measured source: 4,925 lines of TypeScript (the transcript of a Kotlin pagination algorithm) fed into the ArkTS compiler;
with full reachability, **178 raw records = 177 hard + 1 WARN**. All of them are **syntax rules**; not one is a logic error.

| Rule | Entry-reachable 135 | Full reachability 178 | Meaning | Fix |
|---|---|---|---|---|
| `arkts-no-untyped-obj-literals` | 67 + additions | 98 | Object literals must correspond to an explicitly declared class/interface | Extract the inline object type into an `interface` |
| `arkts-no-obj-literals-as-types` | 42 | 50 | Inline object types cannot be used as parameter types | Same as above; change constructor parameters to named interfaces |
| (copy Partial call sites) | — | 41 | Object-literal call sites of `copy(patch: Partial<X>)` violate the rule too | Add another `XxxPatch` interface with optional fields for each class |
| `arkts-unique-names` | 16 | 18 | A type name and a value name cannot be identical | `type X` + `const X` → rename the type to `XValue` |
| `arkts-no-as-const` | 8 | 9 | `as const` is forbidden | Delete it; annotate explicitly where a literal type is needed |
| `arkts-no-globalthis` | 1 (WARN) | 1 (WARN) | `globalThis` is forbidden | Change to a module-level variable |
| `arkts-no-any-unknown` | 1 | 1 | `unknown` is forbidden | Switch to a concrete type |
| `arkts-no-aliases-by-index` | 1 | 1 | Taking a type alias by index is forbidden | Declare it explicitly |

## codemod coverage (cli/adapt-arkts.ts)

Auto-fix (4 categories):
- Inline object types in constructors → `<Class>Options`
- `copy(patch: Partial<Self>)` → `<Class>Patch`
- Same-named `type X` + `const X = {...} as const` → rename the type to `XValue` + `<X>Map` + delete `as const`; **only type positions are changed** (value positions `= X` / `{ X }` / `X.A` are left alone); across files it accepts only `import type`, and only when all usages are in type positions, otherwise it reports `crossfile-type-ref`; when unsure it reports `rename-uncertain`
- Unpaired `as const` is report-only

Report-only as residual (needs human judgment): `globalThis`, `as unknown`, `any/unknown`, index type access `X["k"]`, inline object types outside a class, cross-file renames that cannot be judged safe.

legado measured: 43 Options / 41 Patch / 9 as const / 9 renamed pairs; 178 raw → 8 hard errors after codemod (4 manual sites) → 0.

## Kotlin idioms to avoid at transcript time

| Kotlin | ArkTS form | Notes |
|---|---|---|
| `data class` | `class` + readonly fields + hand-written `copy(patch)` | ArkTS has no data class |
| `sealed interface` | Discriminated union + `readonly kind` | Do not use `instanceof` |
| `enum class` | A real `enum` (ArkTS supports it) or a const object + type alias (renamed) | Mind unique-names |
| Extension functions | Plain functions or class methods | ArkTS has no extension functions |
| `List<T>` / `Sequence` | Arrays / explicit loops | Standard library differences |
| Coroutines / Flow | async/await + callbacks | Different concurrency model |
| `Float` (32-bit) | number (64-bit) | **The precision difference changes numeric results**, see pitfalls |
