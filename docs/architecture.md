# Architecture

[Documentation index](README.md) · [简体中文](architecture.zh-CN.md)

## 1. Scope and invariant

arkts-port migrates source modules to HarmonyOS ArkTS. It is built around one invariant:

> A conversion is accepted only when an executable check proves it.

The pipeline therefore produces evidence before it produces code, and acceptance gates are fail-closed: uncertainty is a failure, not a pass. The one advisory check, `diff-gate`, is explicit about being a warning rather than proof.

## 2. Two conversion phases

Conversion is deliberately split into two phases with separate acceptance criteria.

| Phase | Input | Output | Proof |
|---|---|---|---|
| A. Semantic transcript | Dependency closure, context pack, golden baseline | TypeScript that runs under Node | 100% fidelity against the golden baseline |
| B. ArkTS adaptation | TypeScript transcript | ArkTS (`.ets`) sources | 0 ERROR + 0 WARN-level `arkts-*` diagnostics, plus a clean diff gate |

Phase A is where behavior is proven. TypeScript is used as the intermediate language because it can be executed by Node and therefore compared directly with the original implementation. Producing `.ets` first would leave no executable reference.

Keeping the phases separate also keeps failures diagnosable: a wrong result in phase A is a semantic error, while a phase B failure is a syntax or platform-model error. Fusing them makes the two indistinguishable. Packaging and optional device verification happen after conversion and do not change this contract.

## 3. Execution pipeline

### 3.1 Preparation

These steps run once per module, before the orchestrated gate sequence.

| Step | Tool | Output and purpose |
|---|---|---|
| Triage | `analyze-coupling` | Files, lines, auto-convertible percentage, and per-module ranking. `.d.ts` files and pure-data configs are reported separately as unaudited, so they do not inflate the convertible share. |
| Preflight | `doctor` | 13 checks over SDK layout, hvigor, `build-profile.json5`, SDK version strings, `runtimeOS`, `deviceTypes`, entry files, `NODE_HOME`, environment alignment, and case data. |
| Closure | `extract-closure` | Minimal compilable closure from an entry. Files are classified as `include`, `coupled` boundary, or `test`; unresolved symbols and removable platform imports are reported. |
| Context | `pack-context` | Deterministic Markdown pack with a file list, signature index (no function bodies), and `F32:` floating-point markers. Large inputs are split into fixed-name shards. |
| Baseline | `gen-golden` | Compiles and runs the original twice. `golden.json` is written only when both runs are byte-identical. Without a harness, it emits a scaffold and exits 4. |
| Fidelity | `verify-fidelity` | Compares golden and actual item by item and scenario by scenario. A scenario present in golden but absent from actual is `MISSING` and fails the gate. Zero comparable items is `NO_ITEMS` and passes only when the scenarios match. |

`extract-closure --out` may stay outside `--root` or inside a safe top-level subdirectory of it (`.refs/`, `out/`, `dist/`, `build/`); other subdirectories require `--allow-out-in-root` (`--force` is equivalent but warns); the tool keeps a manifest and removes stale managed files. For JS/TS, relative imports (ESM, CommonJS, dynamic `import()`, directory indexes, extension swaps) and non-relative imports are resolved. Non-relative specifiers are looked up through `tsconfig.json`/`jsconfig.json` `baseUrl` + `paths` first and `vite.config` `resolve.alias` second, by static parsing without `eval`; anything still unresolved becomes `external`. `--no-alias` disables alias resolution.

### 3.2 The nine `port` stages

`port` runs stages in a fixed order. `--stages` selects a subset but never changes the order. `autofix` is opt-in; without `--device` and `--autofix`, the default sequence has seven stages.

| # | Stage | Tool and input | Passes when | Missing input |
|---|---|---|---|---|
| 1 | `analyze` | `analyze-coupling` on `--src` | Analysis completes | `SKIP` when no `--src` |
| 2 | `adapt` | `adapt-arkts` from `--adapt-src`/`--src` to `--adapted` | No residual, unless `--allow-residuals`; scanning zero files is a failure | `SKIP` when the adapter cannot run |
| 3 | `autofix` | `arkts-fix` from the adaptation output to a fixed copy | `arkts-fix` exits 0; zero transforms is still success; when files change, only `diff` uses the fixed copy | Opt-in only: absent `--autofix`; `SKIP` when the adaptation output is absent |
| 4 | `diff` | `diff-gate` before/after adaptation | Exit 0 (no `needs-review`) | `SKIP` when inputs are absent |
| 5 | `fidelity` | `verify-fidelity` on case golden and actual | 100% items and scenarios; no `MISSING`; zero comparable items is `NO_ITEMS` and passes only when scenarios match | `SKIP` when the case is absent |
| 6 | `lint` | `lint-arkts` on `--project` | 0 ERROR + 0 WARN-level `arkts-*` | `SKIP` without SDK or hvigor |
| 7 | `reach` | `reachability-probe` on `--project` | 0 ERROR + 0 WARN-level `arkts-*` across all modules | `SKIP` without SDK or hvigor |
| 8 | `build` | `build-hap` on `--project` | `BUILD SUCCESSFUL` | `SKIP` without SDK or hvigor |
| 9 | `device` | `device-test` | Requested steps succeed; check-only unless a signed HAP is supplied | Opt-in only: absent `--device` leaves the stage out |

For `fidelity`, actual data is selected in this order: `--actual`, then a replay through `cases/<case>/replay.ts`, then `<case>/actual.json`. After a `lint` or `reach` failure, `port` automatically runs `explain-errors` and adds a compact diagnostic to the stage summary. That diagnostic does not change the gate result.

## 4. Fail-closed contract

| Gate | Passes only when | Failure behavior |
|---|---|---|
| `gen-golden` | Two runs are byte-identical | Exit 3 when outputs differ; exit 4 when the harness is missing; no golden is written |
| `verify-fidelity` | 100% of items and scenarios match, with no missing scenario; `NO_ITEMS` passes when scenarios match | Exit 1 |
| `adapt-arkts` | No residual when `--fail-on-residual` is set | Exit 3 |
| `diff-gate` | No `needs-review` class | Exit 3 means warning by default; `--strict` turns it into exit 1 |
| `lint-arkts` | 0 ERROR and 0 WARN-level `arkts-*` | Exit 1 |
| `reachability-probe` | 0 ERROR and 0 WARN-level `arkts-*` across all reachable modules | Exit 1 |
| `build-hap` | `BUILD SUCCESSFUL` | Exit 1 |
| `port` | No FAIL and no SKIP | Exit 1 for any FAIL or SKIP; exit 0 with WARN only |
| `doctor` | No FAIL; WARN is allowed | Exit 1 for FAIL, 2 for usage |
| `docs-metrics --check` | No numeric mismatch | Exit 1 |

Two counting rules matter:

1. **WARN-level rules count.** The error number reported by `lint-arkts` and `reachability-probe` is ERROR plus WARN-level `arkts-*` diagnostics. "0 ArkTS errors" always means 0 ERROR and 0 WARN-level rule violations.
2. **SKIP is not a pass.** `port` treats `SKIP` as a non-success exit. Other tools may define their own skip semantics; for example, `acceptance.mjs` treats an unavailable SDK as an explicit skip, not a failure.

`lint-arkts` clears `.hvigor/cache` and module `build` directories before each gate run. This costs a few seconds but prevents hvigor's `UP-TO-DATE` state from producing a false pass on a second run. `--no-clean` exists for debugging only and is not a gate-grade mode.

## 5. Reachability is a first-class requirement

ArkTS compiles only modules that are reachable from the entry page. A normal project build can therefore report success while unimported files are broken.

The legado case measured the gap:

| Scope | ArkTS errors before adaptation |
|---|---|
| Entry-reachable modules (7) | 135 |
| All 22 modules | 178 raw = 177 hard + 1 WARN |

The additional 42 errors were spread over 8 files that an entry-reachable lint never inspected. This is why `reachability-probe` is a required stage: it copies the project to a temporary directory, injects imports so that every `.ets` file under the source root enters the reachable graph, and compiles the copy. The original project is not modified; `--keep` retains the copy for inspection.

The probe has also exposed violations that a WARN-only reading would have passed, including a `globalThis` rule hit. A reference project with 45 modules was measured at 0 errors, which is the baseline used by the cases.

## 6. Determinism and evidence

The toolchain is designed so that evidence can be diffed, archived, and re-checked.

- Reports are JSON with stable key and array ordering. They contain no timestamps and no absolute paths, so equal inputs produce byte-identical reports.
- `gen-golden` proves stability by running the original twice before writing anything.
- Staged case evidence is copied with sha256 verification and a deterministic provenance file.
- `docs-metrics` recomputes canonical numbers from the case truth files (golden, actual, baseline sources, adapted sources, error JSON, coverage JSON). Its `--check` mode scans documentation for contradicting claims and reports 0 mismatches in the current snapshot.
- The CLIs use Node's native TypeScript type stripping, so there is no build artifact that can drift from the sources. There are no runtime dependencies.

## 7. Reports, logs, and exit codes

`port` writes a report of this shape:

```json
{
  "stages": [
    { "name": "fidelity", "status": "PASS", "exitCode": 0,
      "durationMs": 812, "summary": "...", "logPath": "out/logs/fidelity.log",
      "metrics": {} }
  ],
  "pass": true,
  "counts": { "pass": 7, "warn": 0, "fail": 0, "skip": 0 },
  "requested": ["analyze", "adapt", "diff", "fidelity", "lint", "reach", "build"],
  "stoppedEarly": false,
  "remaining": []
}
```

Statuses are `PASS`, `WARN`, `FAIL`, and `SKIP`. `WARN` allows the run to continue; `FAIL` stops it unless `--continue` is set. Logs go to `out/logs/<stage>.log` by default. `--json` prints the same report to stdout, leaving the human summary off stdout.

Exit codes follow the same convention across CLIs: 0 for success, 1 for a failed check or execution error, 2 for usage or missing prerequisites, and 3/4 for tool-specific outcomes (unstable output, missing harness, residual, or warning-level diff). Individual tools document their exact codes in `--help` and in [tools.md](tools.md).

## 8. Language adapter boundary

The stage machine is language-agnostic. Language differences live in `adapters/` and `adapters/languages.json`, which provide three hooks:

1. coupling patterns that classify platform-bound files;
2. a golden runner (compiler and runtime invocation);
3. a harness template.

Adding a language means filling those hooks, not editing the gate sequence. The current state:

- **JVM (Kotlin/Java)** is the reference adapter and the only one exercised end to end.
- **JS/TS** is supported by the tools and exercised by two cases: a 9-line mechanism check and a 3,303-line yoga port.
- **Dart, C/C++, and Swift** have adapter contracts and templates but no validated module. C/C++ is explicitly restricted to pure algorithm libraries.

## 9. Repository layout

| Path | Role |
|---|---|
| `cli/` | Deterministic entrypoints shared by humans, CI, and MCP |
| `adapters/` | Language contracts and coupling rules |
| `rules/` | ArkTS restrictions, pitfalls, API mapping, conversion-share and UI mapping rules |
| `skills/arkts-port/` | Fixed operating procedure for agents |
| `cases/` | Reproducible harnesses, goldens, actuals, and case scripts |
| `scripts/` | External evidence staging and end-to-end acceptance |
| `templates/` | Harness scaffolds for each language |
| `tests/` | Node test suite for the CLIs and gates |
| `docs/` | Architecture, tool reference, case evidence, and the documentation index |

## 10. Limits and threats to validity

- **Golden coverage is scenario coverage.** Passing fidelity proves equivalence only for the scenarios in the harness. Uncovered branches, inputs, and error paths are not proven.
- **The ArkTS side is compile-gated, not replayed.** `.ets` cannot run under Node, so behavioral equivalence is established on the TypeScript side. ArkTS correctness is inferred from compilation, rule counts, and the diff gate.
- **Floating point remains a risk.** The legado transcript marks 52 `F32:` points, but none fired in the synthetic scenarios. Real font metrics may exercise them.
- **The codemod is lexical and intentionally conservative.** It does not rewrite template-literal interiors or nested object types, and cross-file renames only apply to `import type` usages where every use is a type position. Unhandled cases become residuals rather than unsafe rewrites.
- **`diff-gate` is not a semantic proof.** It classifies line-level changes and flags anything that may alter runtime behavior; a human must review those flags.
- **UI equivalence is out of scope.** `ui-skeleton` can generate a mechanical ArkUI skeleton from one Compose file, but layout, gesture, rendering, and behavioral equivalence remain manual rewrites. The pipeline's fail-closed gates still cover logic that can produce a deterministic golden.
- **hvigor log parsing is a compatibility surface.** WARN-level `arkts-*` extraction depends on hvigor's log format; upgrades require re-validating `lint-arkts`, `reachability-probe`, and `explain-errors` together.
- **Signing is external.** `build-hap` produces an unsigned HAP unless the project configures signing. Device installation was verified with a debug-profile signed HAP from Huawei AGC; the tool does not bypass signing.
- **Case sources carry their own licenses.** The repository is MIT-licensed (see [LICENSE](../LICENSE) and [THIRD_PARTY_LICENSES](../THIRD_PARTY_LICENSES)). GPL-derived and MIT-licensed third-party sources are kept outside the repository and are never committed.
