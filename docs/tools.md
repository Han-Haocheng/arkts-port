# Tools

[Documentation index](README.md) · [简体中文](tools.zh-CN.md)

The repository exposes **23 entrypoints**: 21 TypeScript CLIs in `cli/` plus 2 Node scripts in `scripts/`. All of them run on Node >= 22 with no runtime dependencies and no build step. Every entrypoint supports `--help`; unknown or malformed options exit 2.

Reports are deterministic JSON. Unless stated otherwise, `--json` writes the report to stdout and `--report <path>` writes the same report to a file. Paths below use placeholders: `<project>` for a HarmonyOS project, `<sdk>` for the OpenHarmony SDK, `<hvigor>` for the hvigor `node_modules` directory, `<refs>` for external case evidence, and `<case>` for a case directory.

## 1. Preparation

| Entrypoint | Purpose | Key flags | Exit codes |
|---|---|---|---|
| `cli/analyze-coupling.ts` | Triage: count source files and lines that are not coupled to the original platform, compute the auto-convertible share, and rank modules. | `--root`, `--lang`, `--top`, `--json`, `--list-langs` | 0 success; 2 usage or no matching files |
| `cli/triage-boundary.ts` | Boundary-splitting triage of Kotlin files into `splittable-candidate`, `boundary-only`, `ui`, and `not-worth` using platform coupling, dependency surface, UI markers, and size; emits funnel counts and top-N candidates. | `--root`, `--json`/`--md`, `--out`, `--min-lines` (default 100), `--top` (default 8) | 0 success; 1 read/write failure; 2 usage |
| `cli/assess-conversion.ts` | Four-share conversion assessment (automated / semi-automated / manual / non-convertible) driven by `rules/conversion-share.json` v1.1; reports `ruleVersion` and `ruleSha256`; evaluates only, never converts. Defaults to the `conservative` profile (6.67 / 12.80 / 78.01 / 2.52); `broad` keeps the older v1.0 basis (11.81 / 24.66 / 60.75 / 2.78); `--production-only` narrows the denominator to 2,093 files / 402,755 lines. | `--root`, `--lang` (`jvm`), `--profile` (`broad` or `conservative`; default `conservative`), `--production-only`, `--json`/`--md`, `--out` | 0 assessment completed; 1 invariant broken (`unclassified` > 0, the four shares do not sum to 100%, `conservative` alignment fails, or `automated` exceeds the `analyze-coupling` auto share under `broad`); 2 usage |
| `cli/doctor.ts` | 13-point preflight: SDK layout, hvigor, `build-profile.json5`, version strings, `runtimeOS`, `deviceTypes`, entry files, `NODE_HOME`, environment alignment, and case data. | `--project`, `--sdk`, `--hvigor`, `--case`, `--json`, `--report` | 0 no FAIL (WARN allowed); 1 FAIL; 2 usage |
| `cli/extract-closure.ts` | Extract a minimal dependency closure from an entry. Classifies `include`, `coupled` boundaries, and `test` files; reports unresolved symbols, removable imports, and aliases. | `--root`, `--entry`, `--lang`, `--out`, `--allow-out-in-root`, `--report`, `--json`, `--no-package-complete`, `--no-alias`, `--force` | 0 success; 1 unreadable entry; 2 usage |
| `cli/pack-context.ts` | Build a deterministic Markdown context pack: file list, signature index without function bodies, `F32:` markers, and fixed-name shards when over `--max-bytes`. | `--closure`, `--lang`, `--out`, `--max-bytes`, `--exclude`, `--no-members`, `--json`, `--report` | 0 success; 1 read failure; 2 usage |
| `cli/gen-golden.ts` | Compile and run the original implementation twice; write `golden.json` only when both runs are byte-identical. JVM uses `kotlinc`/`kotlin`; JS/TS runs a Node harness. `--manual-extractions` maps boundary symbols to stubs or replacements, copied to `<out>/.src-manual` before compilation; unresolved references fail closed and no golden is written. | `--lang` (`jvm` or `js-ts`), `--src` (JVM), `--main`, `--package`, `--manual-extractions` (JVM), `--out`, `--logs`, `--timeout`, `--json`, `--report` | 0 stable; 1 compile/run failure; 2 usage; 3 unstable output; 4 missing harness |

Notes:

- `extract-closure --out` may stay outside `--root` or inside a safe top-level subdirectory of it (`.refs/`, `out/`, `dist/`, `build/`); any other subdirectory requires `--allow-out-in-root`, and `--force` is equivalent but warns. The tool keeps a manifest and removes stale files it previously wrote; it never deletes unmanaged files.
- `pack-context` output contains no timestamps or absolute paths, so identical inputs produce byte-identical packs.
- `gen-golden --out` and `--logs` must be outside the source root (JVM: `--src`; JS/TS: the directory containing `--main`). `--main` must be inside `--src` (JVM), or the main class lands outside the compilation root. A missing harness produces a scaffold under `templates/` and exit 4.

## 2. Verification and adaptation

| Entrypoint | Purpose | Key flags | Exit codes |
|---|---|---|---|
| `cli/verify-fidelity.ts` | Compare golden and actual arrays item by item and scenario by scenario. A scenario present in golden and absent from actual is `MISSING` and fails. Zero comparable items reports `N/A`/`NO_ITEMS` (JSON `verdict=NO_ITEMS`, `fidelityPct=null`); `NO_ITEMS` with identical scenarios passes, while missing scenarios or structural differences still fail. | `--golden`, `--actual`, `--key`, `--items`, `--field`, `--json` | 0 100% and no missing, or `NO_ITEMS` with identical scenarios; 1 difference, missing scenario, or structural difference; 2 usage |
| `cli/adapt-arkts.ts` | Deterministic ArkTS codemod for four mechanical patterns: constructor options, copy patches, `as const` declarations, and paired type/const renames. Writes residuals rather than unsafe rewrites. | `--src`, `--out`, `--ets`, `--report`, `--json`, `--fail-on-residual` | 0 success (residual may remain); 1 transformation error; 2 usage; 3 residual with `--fail-on-residual` |
| `cli/arkts-fix.ts` | High-confidence mechanical repair of `adapt-arkts --ets` output: `as const` object plus `typeof`/`keyof` alias → `enum`; single object-type alias → `interface`. Non-target code is left untouched; zero transforms is still success. | `--src`, `--out`, `--json`, `--report`, `--dry-run`, `--no-obj-type-alias` | 0 success (zero transforms is still success); 1 rule inconsistency or read/write failure; 2 usage |
| `cli/ui-skeleton.ts` | Generate a mechanical ArkUI skeleton from one Compose file: pick the `@Composable` with the most whitelisted nodes, map a whitelisted set of layouts/controls plus a few modifiers to ArkUI, and write `<Name>.ets` plus `mapping.md`; rules come from `rules/ui-mapping.json` v3. Skeleton only; pixel or behavioral equivalence is not promised. | `--src` (one `.kt`), `--out`, `--integrate`/`--out-project`, `--json`/`--md`, `--dry-run` | 0 success; 1 read/write or parse failure, or no mappable whitelisted component; 2 usage |
| `cli/diff-gate.ts` | Line-level diff between pre- and post-adaptation trees. Classifies hunks as `type-only`, `import-path`, or `needs-review`; zero dependencies. | `--before`, `--after`, `--max`, `--strict`, `--json`, `--report` | 0 no `needs-review`; 3 `needs-review`; 1 with `--strict` or read error; 2 usage |
| `cli/explain-errors.ts` | Turn hvigor logs or error JSON into rule, `file:line:col`, source excerpt, and remediation anchor. Errors without a position are listed separately. | `--log`, `--root`, `--max`, `--rule`, `--json`, `--report` | 0 read success (even with errors); 2 usage or unparsable input |
| `cli/lint-arkts.ts` | In-project hvigor build. Counts ERROR plus WARN-level `arkts-*` violations. Cleans build caches by default to prevent `UP-TO-DATE` false passes. | `--project`, `--sdk`, `--hvigor`, `--json`, `--report`, `--log`, `--log-in-project`, `--no-clean` | 0 no ArkTS errors; 1 errors or build failure; 2 usage or missing prerequisite |
| `cli/reachability-probe.ts` | Copy the project, inject imports so every `.ets` under the source root is reachable, and compile the copy. Counts ERROR plus WARN-level `arkts-*` violations. | `--project`, `--src`, `--entry`, `--sdk`, `--hvigor`, `--json`, `--report`, `--keep` | 0 no ArkTS errors; 1 errors or build failure; 2 usage or missing prerequisite |

The codemod's two rename-related rules are deliberately narrow: rule 3 only rewrites type positions, and cross-file renames are accepted only through `import type` when every use is a type position. Anything else becomes a residual.

## 3. Orchestration, build, and device

| Entrypoint | Purpose | Key flags | Exit codes |
|---|---|---|---|
| `cli/build-hap.ts` | Build a HAP through hvigor, keep the full log on disk, and print a short summary. The reference project produces an unsigned HAP because it has no signing configuration. | `--project`, `--mode` (`debug` or `release`), `--sdk`, `--hvigor`, `--log` | 0 `BUILD SUCCESSFUL`; 1 build failure; 2 usage or missing prerequisite |
| `cli/port.ts` | Run the nine-stage gate machine: `analyze → adapt → autofix → diff → fidelity → lint → reach → build → device`. `autofix` is opt-in via `--autofix`; the fixed copy only feeds `diff`, while `lint`/`reach`/`build` still use `--project`. Fixed order, per-stage summary, logs, JSON report. Stops on FAIL unless `--continue`. | `--project`, `--case`, `--src`, `--adapted`, `--actual`, `--fidelity-key`, `--fidelity-items`, `--fidelity-field`, `--sdk`, `--hvigor`, `--stages`, `--autofix`, `--no-autofix`, `--arkts-fix-out`, `--report`, `--device`, `--signed-hap`, `--bundle`, `--ability`, `--hdc`, `--json`, `--continue`, `--strict-diff` | 0 no FAIL and no SKIP; 1 any FAIL or SKIP; 2 usage |
| `cli/case.ts` | Manifest-driven case runner: discovers `cases/*/case.json`, runs the declared stages or the case's own runner, and aggregates the existing gate results. | `--case`, `--stage`, `--list`, `--json`, `--report`, `--update`, `--refs`, `--sdk`, `--hvigor`, `--device`, `--continue`, `--timeout`, `--case-arg` | 0 all PASS/WARN (optional SKIP allowed); 1 FAIL; 2 usage; 3 required stage SKIP without FAIL |
| `cli/device-test.ts` | Check a device, install and launch a signed HAP, collect hilog, and take a screenshot. Installation failures are mapped to documented error codes and AGC fixes; signing is never bypassed. | `--target`, `--check`, `--hap`, `--install`, `--bundle`, `--ability`, `--screenshot`, `--hilog-filter`, `--json`, `--report`, `--log`, `--timeout`, `--hdc` | 0 all requested steps succeed; 1 any failure or timeout; 2 usage or missing `hdc` |

`port` also accepts these extension flags: `--allow-residuals`, `--no-ets`, `--no-replay`, `--no-explain`, `--explain-max`, `--logs`, `--mode`, `--ets-src`, `--entry`, `--lang`, `--timeout`, `--adapt-src`, `--fidelity-key`, `--fidelity-items`, `--fidelity-field`, and `--device-timeout`. The three fidelity flags pass through to `verify-fidelity`'s `--key`, `--items`, and `--field`. See `node cli/port.ts --help` for their exact semantics.

Practical notes:

- Without `--device` and `--autofix`, `port` runs seven stages; `--autofix` adds the opt-in autofix stage. The device stage exists only when `--device <host:port>` is provided.
- `autofix` only affects `diff`: it never edits `--project`, so a repaired fixed copy changes the `diff` input, not what `lint`, `reach`, or `build` compile. The stage is `SKIP` when `--adapted` is absent or its directory does not exist, and `FAIL` when `--autofix` is enabled but `cli/arkts-fix.ts` is missing.
- Without `--signed-hap`, the device stage is check-only. Install and launch require `--signed-hap` and `--bundle`.
- A `diff` warning (exit 3) is recorded as `WARN` and does not block later stages. `--strict-diff` promotes it to `FAIL`.
- `lint` and `reach` failures automatically trigger `explain-errors`. The diagnostic is informational; it does not change the stage status.
- Common device-install error codes surface as actionable messages: 9568320 (signature), 9568257, and 9568258. Error 9568276 usually means a stale installation record; uninstall first, then reinstall, rather than changing the bundle name.

## 4. Evidence and interfaces

| Entrypoint | Purpose | Key flags | Exit codes |
|---|---|---|---|
| `cli/docs-metrics.ts` | Recompute canonical numbers from case truth files and scan documents for contradictory claims. Covers fidelity, closure, transcript/adaptation sizes, error counts, codemod counts, build/signing, and coverage. | `--case`, `--refs`, `--coverage`, `--check`, `--json`, `--report` | 0 success or no mismatch; 1 `--check` mismatch; 2 usage or read failure |
| `cli/mcp-server.ts` | MCP server over JSON-RPC 2.0 on stdio. Thin wrappers around the existing CLIs; no gate logic is reimplemented. | `--cwd`, `--allow`, `--timeout` | Long-running stdio server; protocol errors are JSON-RPC errors |
| `scripts/stage-case.mjs` | Copy external case evidence into `<case>/ts` and verify sha256. Writes a deterministic `.provenance.json`; GPL-derived sources are never committed. | `--refs`, `--case`, `--dest`, `--check`, `--json` | 0 success or matching check; 1 mismatch; 2 usage |
| `scripts/acceptance.mjs` | Five-stage release regression: `stage → golden → replay → adapt → arkts-gate`. Without SDK/hvigor, `arkts-gate` is skipped; skip is not a failure. | `--refs`, `--sdk`, `--hvigor`, `--out`, `--json`, `--skip-build`, `--keep` | 0 all PASS (SKIP allowed); 1 any FAIL; 2 usage |

`docs-metrics` checks eight groups of known drift, including the 178 = 177 hard + 1 WARN error split and the codemod counts. It exits 1 on any mismatch.

## 5. MCP server

`cli/mcp-server.ts` implements JSON-RPC 2.0 over stdio: one JSON object per line. It supports `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`.

It exposes 17 tools:

```text
doctor, analyze-coupling, extract-closure, pack-context, gen-golden,
verify-fidelity, adapt-arkts, diff-gate, explain-errors, lint-arkts,
reachability-probe, build-hap, device-test, port, docs-metrics,
stage-case, acceptance
```

Client configuration:

```json
{"mcpServers":{"arkts-port":{"command":"node","args":["cli/mcp-server.ts","--cwd","<repo>"]}}}
```

Error semantics: an unknown tool returns JSON-RPC `-32602`; a missing required parameter, a non-zero CLI exit, or a timeout returns `result.isError = true` with the CLI's exit code appended as `[exit N]`. `--allow` limits the exposed subset, and `--timeout` sets the per-call timeout in milliseconds.

## 6. npm scripts

There are 20 scripts. None of them requires `npm install`.

```text
coupling      doctor        closure       context       gen-golden
fidelity      adapt         diff-gate     explain       lint
reach         build         port          stage         acceptance
mcp           js-ts-case    device-test   docs-metrics  test
```

`js-ts-case` runs `cases/js-ts/run.mjs`. `stage` and `acceptance` map to the two scripts above. `test` runs the Node test suite via `node --test tests/` (scoped to `tests/` so copies under `out/` are not discovered). The rest map one-to-one to `cli/<name>.ts`. Five CLIs have no npm alias and must be invoked directly: `case`, `triage-boundary`, `assess-conversion`, `arkts-fix`, and `ui-skeleton`.

## 7. Conventions

- **Determinism:** stable ordering; no timestamps or absolute paths in reports; byte-identical outputs for identical inputs.
- **Logs:** stage logs default to `out/logs/`. Build logs contain the full hvigor output; stdout keeps only the summary.
- **JSON:** `--json` means stdout is valid JSON only. `--report` writes the same object to a file.
- **Dependencies:** zero. Node >= 22 strips TypeScript types directly; there is no compilation step.
