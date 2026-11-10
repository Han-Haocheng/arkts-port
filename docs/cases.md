# Cases

[Documentation index](README.md) · [简体中文](cases.zh-CN.md)

Three cases are committed as reproducible evidence. Each one keeps third-party source outside the repository: only harnesses, golden/actual data, and the scripts that drive them are committed.

## 1. Setup

All commands run from the repository root with Node >= 22. The placeholders are:

| Placeholder | Meaning | Default environment variable |
|---|---|---|
| `<refs>` | External evidence root containing the staged case sources | `ARKTS_PORT_CASE_REFS` |
| `<sdk>` | OpenHarmony SDK root | `OHOS_BASE_SDK_HOME` |
| `<hvigor>` | hvigor `node_modules` directory | `HVIGOR_HOME` |
| `<case>` | Case directory under `cases/` | — |
| `<device>:<port>` | Device address for the optional device stage | — |

Run artifacts go to `out/` and are ignored. Upstream sources are never copied into the repository.

## 2. Evidence at a glance

| Case | Language | Scope | Golden | Fidelity | ArkTS | Verdict |
|---|---|---|---|---|---|---|
| [`legado`](../cases/legado/README.md) | JVM (Kotlin) | 22 modules / 2,898 lines in closure | 62 pages / 16 scenarios | 62/62 (100%) | 178 raw → 0 after codemod and 4 manual sites | Full chain |
| [`js-ts`](../cases/js-ts/README.md) | JS/TS | 9-line pure function | 297 B / 7 items | 7/7 (100%) | 1 expected error → 0 | G1-G4 PASS |
| [`js-ts-yoga`](../cases/js-ts-yoga/README.md) | JS/TS | 3,303 lines / 104,779 B | 1,662 B / 44 items | 44/44 (100%) | 136 → 0 | G1-G4 PASS |

The table reports measured results for the committed harnesses. It is not a coverage estimate for the upstream projects.

## 3. `cases/legado` — JVM full chain

### Scope and sources

The case migrates the pagination algorithm of `HapeLee/legado-with-MD3`, an Android reader app licensed under GPL-3.0. The upstream repository and the TypeScript transcript are external and are not committed.

| Item | Measured value |
|---|---|
| Source triage | 2,108 files / 404,343 lines; 13.1% auto-convertible |
| Dependency closure | 22 modules / 2,898 lines (21 upstream files plus one manually extracted file) |
| TypeScript transcript | 22 files / 4,925 lines |
| ArkTS adaptation | 22 files / 5,597 lines |
| Scenarios / pages | 16 / 62 |
| Semantic fidelity | 100% (62/62 pages, byte-equal) |
| ArkTS errors, entry-reachable | 135 |
| ArkTS errors, full reachability | 178 raw = 177 hard + 1 WARN |
| Codemod volume | 43 options interfaces, 41 patch interfaces, 9 `as const` rewrites, 9 rename pairs |
| Residual after codemod | 8 hard errors at 4 manual sites → 0 after fixes |
| Build | `BUILD SUCCESSFUL`; unsigned HAP (no signing configuration) |

### Reproduce

```bash
mkdir -p out

# 1. Stage external evidence into cases/legado/ts (sha256 checked)
node scripts/stage-case.mjs --refs <refs>

# 2. Replay the TypeScript transcript and run the fidelity gate
node cases/legado/replay.ts > out/actual.json
node cli/verify-fidelity.ts \
  --golden cases/legado/golden.json --actual out/actual.json

# 3. Release regression: stage, golden, replay, adapt, ArkTS gate
node scripts/acceptance.mjs --refs <refs> --sdk <sdk> --hvigor <hvigor>
```

Without `--sdk`/`--hvigor`, `acceptance.mjs` skips the ArkTS stage and still exits 0; a skip is not a failure there. With SDK and hvigor present, all five stages pass.

### Findings

- The semantic transcript reached 100% fidelity without iterative repair, which made this case the reference for transcript quality.
- The difficult part was ArkTS syntax, not the algorithm. Entry-reachable lint reported 135 errors; full reachability reported 178. The extra 42 errors lived in 8 files that were never imported by the entry page.
- Four mechanical transformations covered most of the syntax gap. The codemod left 8 hard errors at 4 manual sites; fixing those produced 0 errors while fidelity stayed at 100%.
- `diff-gate` classified the codemod output as type-only changes with 0 `needs-review` hunks. Manual runtime adaptations, including `globalThis`, were flagged for review.

### Limits

- 52 `F32:` floating-point markers are present in the transcript, but none of the synthetic scenarios exercised them. Real font metrics remain an unverified risk.
- The ArkTS side is validated by compilation and build only. Rendering and interaction equivalence are not claimed.

## 4. `cases/js-ts` — mechanism check

### Scope and sources

The case uses `chapterProgress.ts`, a 9-line pure function from the legado web modules. The upstream file is GPL-3.0 and external. The purpose is to prove the JS/TS branch of the pipeline, not to measure migration scale.

| Item | Measured value |
|---|---|
| Upstream size | 9 lines |
| Golden | 297 B; 2 scenarios / 7 items |
| Fidelity | 100% (7/7 items, 2/2 scenarios) |
| ArkTS baseline | 1 expected error (`arkts-no-obj-literals-as-types`) at 46 probe modules |
| After the two-line type extraction | 0 ERROR / 0 WARN |
| Verdict | G1-G4 PASS |

### Reproduce

```bash
# One command: closure → golden → replay → fidelity → adapt → diff → probe
node cases/js-ts/run.mjs --stage all

# Machine-readable evidence
node cases/js-ts/run.mjs --stage all --json
```

The runner reads the upstream source through `ARKTS_PORT_CASE_REFS` and the SDK/hvigor environment variables. If the upstream file is absent, the case reports `SKIP` and does not produce a fake golden.

### Findings

- **False green is reproducible.** `lint-arkts` reported 0 errors for the parity file because the entry page never imported it. Only `reachability-probe` pulled it into the graph and exposed the inline object type.
- The single expected error is explainable: the function parameter used an inline object type, which the codemod intentionally does not rewrite outside constructor options. Extracting `interface ParagraphRange` fixed it with two type-level lines.
- The transcript is an identity transform, so `adapt-arkts` made zero text changes; the only adaptation was the `.ts → .ets` extension.
- The analyzer reports 6.9% auto-convertible code for the legado `modules/web` tree (34 files / 3,057 lines). That is a triage result and should not be presented as achieved migration coverage.

### Limits

- This case proves the mechanism on 9 lines, not large-scale JS/TS quality.
- The optional `souce.ts` extension was not implemented. It would require manual import normalization and a small `@vueuse/shared` shim.
- No UI, device, or performance claims are made.

## 5. `cases/js-ts-yoga` — 3.3k-line scale

### Scope and sources

The case migrates `src/native-ts/yoga-layout/`, a pure TypeScript port of Meta's yoga flexbox engine (MIT). The source is external and is not committed; the case commits the stage/run scripts, harness, golden, and actual output.

| Item | Measured value |
|---|---|
| Size | 3,303 lines / 104,779 B (`index.ts` 3,104 lines, `enums.ts` 199 lines) |
| Golden | 1,662 B; 4 scenarios / 44 items |
| Fidelity | 100% (44/44 items, 4/4 scenarios) |
| ArkTS baseline | 136 ERROR at 47 probe modules (`enums.ets` 112, `index.ets` 24) |
| After deterministic fix | 0 ERROR / 0 WARN |
| Codemod residual | 19 (16 `as const`, 2 inline object types, 1 `any`) |
| Diff gate | 1 `import-path` change, 0 `needs-review` |
| Verdict | G1-G4 PASS |

### Reproduce

```bash
# Verify that the staged files match upstream hashes
node cases/js-ts-yoga/stage.mjs --check --json

# Full chain, with the deterministic ArkTS fix applied
node cases/js-ts-yoga/run.mjs --stage all

# Reproduce the 136-error baseline without applying the fix
node cases/js-ts-yoga/run.mjs --no-fix
```

The runner is idempotent: staging rewrites exactly one import specifier (`./enums.js` → `./enums.ts`), records sha256 values, and refuses to proceed if the rewrite count is not exactly one.

### Findings

- Scale changes the error profile, not the method. `enums.ets` produced 112 of the 136 errors through `typeof` type queries, duplicate const/type names, index aliases, `as const`, and untyped object literals.
- A deterministic case-local fixer converts the 16 constant maps to `enum` declarations, rewrites type aliases to interfaces, introduces concrete classes for `Config`/`Yoga` wrappers, and replaces the single `unknown` parameter. The fixer records every rule count and fails if a count does not match.
- The residual list from `adapt-arkts` is useful even when the fixer later removes the errors: it identifies the constructs the general codemod intentionally leaves alone.
- `diff-gate` found only the import-path change, confirming that the codemod did not silently rewrite runtime logic.

### Limits

- `.ets` cannot be replayed in Node. Fidelity is proven on the TypeScript side; ArkTS is compile-gated.
- The fixer is case-local and illustrative. It shows that the remaining errors are mechanical, not that the general codemod handles every project.
- The golden locks the behavior of this TypeScript port. It does not prove value-for-value parity with the upstream C++ yoga engine.
- The fixer introduces classes and enums. Runtime semantic drift on the ArkTS side is not detectable by this case and must be covered by diff review and device testing.

## 6. Device evidence

A signed HAP (Huawei AGC debug profile) was installed, launched, and inspected through `cli/device-test.ts` on:

| Item | Value |
|---|---|
| Device | CMM-AL10 |
| OS | HarmonyOS 7 |
| API level | 26 |
| Signing | Huawei AGC debug profile (external) |
| Verified | install, launch, UI screen, settings screen |

```bash
# Connection and system check only
node cli/device-test.ts --target <device>:<port> --check

# Install a signed HAP, launch it, and capture a screenshot
node cli/device-test.ts --target <device>:<port> \
  --hap <signed.hap> --install --bundle <bundle> \
  --ability EntryAbility --screenshot out/screen.png
```

The tool never bypasses signing. An unsigned HAP fails with error 9568320; stale installation records (9568276) are resolved by uninstalling first, not by changing the bundle name. Reading flow, performance, and rendering equivalence are not yet verified.

## 7. Reproducibility and licensing

- **External evidence is staged, not vendored.** `stage-case.mjs` copies the legado TypeScript baseline, verifies sha256, and writes a deterministic provenance file. `cases/js-ts-yoga/stage.mjs` does the same for the two yoga files after one import rewrite.
- **Only case artifacts are committed.** Harnesses, golden/actual JSON, case runners, and case-local fixes are in the repository. Third-party source, `out/`, and parity projects are not.
- **Licenses stay with the sources.** The legado transcript is GPL-derived; the yoga source is MIT. Neither is committed, and neither license is relicensed by this repository. The repository itself is MIT-licensed; see [LICENSE](../LICENSE) and [THIRD_PARTY_LICENSES](../THIRD_PARTY_LICENSES).
- **Case results are scoped.** Fidelity numbers apply to the committed scenarios only. Coverage, UI behavior, and rendering equivalence are explicitly out of scope.
