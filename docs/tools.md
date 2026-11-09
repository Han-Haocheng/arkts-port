# Tools

The repository exposes **18 entrypoints**: 16 TypeScript CLIs in `cli/` plus 2 Node scripts in `scripts/`. All of them run on Node >= 22 with no runtime dependencies and no build step. Every entrypoint supports `--help`; unknown or malformed options exit 2.

Reports are deterministic JSON. Unless stated otherwise, `--json` writes the report to stdout and `--report <path>` writes the same report to a file. Paths below use placeholders: `<project>` for a HarmonyOS project, `<sdk>` for the OpenHarmony SDK, `<hvigor>` for the hvigor `node_modules` directory, `<refs>` for external case evidence, and `<case>` for a case directory.

## 1. Preparation

| Entrypoint | Purpose | Key flags | Exit codes |
|---|---|---|---|
| `cli/analyze-coupling.ts` | Triage: count source files and lines that are not coupled to the original platform, compute the auto-convertible share, and rank modules. | `--root`, `--lang`, `--top`, `--json`, `--list-langs` | 0 success; 2 usage or no matching files |
| `cli/doctor.ts` | 13-point preflight: SDK layout, hvigor, `build-profile.json5`, version strings, `runtimeOS`, `deviceTypes`, entry files, `NODE_HOME`, environment alignment, and case data. | `--project`, `--sdk`, `--hvigor`, `--case`, `--json`, `--report` | 0 no FAIL (WARN allowed); 1 FAIL; 2 usage |
| `cli/extract-closure.ts` | Extract a minimal dependency closure from an entry. Classifies `include`, `coupled` boundaries, and `test` files; reports unresolved symbols, removable imports, and aliases. | `--root`, `--entry`, `--lang`, `--out`, `--report`, `--json`, `--no-package-complete`, `--no-alias`, `--force` | 0 success; 1 unreadable entry; 2 usage |
| `cli/pack-context.ts` | Build a deterministic Markdown context pack: file list, signature index without function bodies, `F32:` markers, and fixed-name shards when over `--max-bytes`. | `--closure`, `--lang`, `--out`, `--max-bytes`, `--exclude`, `--no-members`, `--json`, `--report` | 0 success; 1 read failure; 2 usage |
| `cli/gen-golden.ts` | Compile and run the original implementation twice; write `golden.json` only when both runs are byte-identical. JVM uses `kotlinc`/`kotlin`; JS/TS runs a Node harness. | `--lang` (`jvm` or `js-ts`), `--src` (JVM), `--main`, `--package`, `--out`, `--logs`, `--timeout`, `--json`, `--report` | 0 stable; 1 compile/run failure; 2 usage; 3 unstable output; 4 missing harness |

Notes:

- `extract-closure --out` must be outside `--root`. The tool keeps a manifest and removes stale files it previously wrote; it never deletes unmanaged files.
- `pack-context` output contains no timestamps or absolute paths, so identical inputs produce byte-identical packs.
- `gen-golden --out` and `--logs` must be outside the source root (JVM: `--src`; JS/TS: the directory containing `--main`). A missing harness produces a scaffold under `templates/` and exit 4.

## 2. Verification and adaptation

| Entrypoint | Purpose | Key flags | Exit codes |
|---|---|---|---|
| `cli/verify-fidelity.ts` | Compare golden and actual arrays item by item and scenario by scenario. A scenario present in golden and absent from actual is `MISSING` and fails. | `--golden`, `--actual`, `--key`, `--items`, `--field`, `--json` | 0 100% and no missing; 1 difference or missing; 2 usage |
| `cli/adapt-arkts.ts` | Deterministic ArkTS codemod for four mechanical patterns: constructor options, copy patches, `as const` declarations, and paired type/const renames. Writes residuals rather than unsafe rewrites. | `--src`, `--out`, `--ets`, `--report`, `--json`, `--fail-on-residual` | 0 success (residual may remain); 1 transformation error; 2 usage; 3 residual with `--fail-on-residual` |
| `cli/diff-gate.ts` | Line-level diff between pre- and post-adaptation trees. Classifies hunks as `type-only`, `import-path`, or `needs-review`; zero dependencies. | `--before`, `--after`, `--max`, `--strict`, `--json`, `--report` | 0 no `needs-review`; 3 `needs-review`; 1 with `--strict` or read error; 2 usage |
| `cli/explain-errors.ts` | Turn hvigor logs or error JSON into rule, `file:line:col`, source excerpt, and remediation anchor. Errors without a position are listed separately. | `--log`, `--root`, `--max`, `--rule`, `--json`, `--report` | 0 read success (even with errors); 2 usage or unparsable input |
| `cli/lint-arkts.ts` | In-project hvigor build. Counts ERROR plus WARN-level `arkts-*` violations. Cleans build caches by default to prevent `UP-TO-DATE` false passes. | `--project`, `--sdk`, `--hvigor`, `--json`, `--report`, `--log`, `--log-in-project`, `--no-clean` | 0 no ArkTS errors; 1 errors or build failure; 2 usage or missing prerequisite |
| `cli/reachability-probe.ts` | Copy the project, inject imports so every `.ets` under the source root is reachable, and compile the copy. Counts ERROR plus WARN-level `arkts-*` violations. | `--project`, `--src`, `--entry`, `--sdk`, `--hvigor`, `--json`, `--report`, `--keep` | 0 no ArkTS errors; 1 errors or build failure; 2 usage or missing prerequisite |

The codemod's two rename-related rules are deliberately narrow: rule 3 only rewrites type positions, and cross-file renames are accepted only through `import type` when every use is a type position. Anything else becomes a residual.

## 3. Orchestration, build, and device

| Entrypoint | Purpose | Key flags | Exit codes |
|---|---|---|---|
| `cli/build-hap.ts` | Build a HAP through hvigor, keep the full log on disk, and print a short summary. The reference project produces an unsigned HAP because it has no signing configuration. | `--project`, `--mode` (`debug` or `release`), `--sdk`, `--hvigor`, `--log` | 0 `BUILD SUCCESSFUL`; 1 build failure; 2 usage or missing prerequisite |
| `cli/port.ts` | Run the eight-stage gate machine: `analyze → adapt → diff → fidelity → lint → reach → build → device`. Fixed order, per-stage summary, logs, JSON report. Stops on FAIL unless `--continue`. | `--project`, `--case`, `--src`, `--adapted`, `--actual`, `--sdk`, `--hvigor`, `--stages`, `--report`, `--device`, `--signed-hap`, `--bundle`, `--ability`, `--hdc`, `--json`, `--continue`, `--strict-diff` | 0 no FAIL and no SKIP; 1 any FAIL or SKIP; 2 usage |
| `cli/device-test.ts` | Check a device, install and launch a signed HAP, collect hilog, and take a screenshot. Installation failures are mapped to documented error codes and AGC fixes; signing is never bypassed. | `--target`, `--check`, `--hap`, `--install`, `--bundle`, `--ability`, `--screenshot`, `--hilog-filter`, `--json`, `--report`, `--log`, `--timeout`, `--hdc` | 0 all requested steps succeed; 1 any failure or timeout; 2 usage or missing `hdc` |

`port` also accepts these extension flags: `--allow-residuals`, `--no-ets`, `--no-replay`, `--no-explain`, `--explain-max`, `--logs`, `--mode`, `--ets-src`, `--entry`, `--lang`, `--timeout`, `--adapt-src`, and `--device-timeout`. See `node cli/port.ts --help` for their exact semantics.

Practical notes:

- Without `--device`, `port` runs seven stages. The device stage exists only when `--device <host:port>` is provided.
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

`js-ts-case` runs `cases/js-ts/run.mjs`. `stage` and `acceptance` map to the two scripts above. `test` runs the Node test suite. The rest map one-to-one to `cli/<name>.ts`.

## 7. Conventions

- **Determinism:** stable ordering; no timestamps or absolute paths in reports; byte-identical outputs for identical inputs.
- **Logs:** stage logs default to `out/logs/`. Build logs contain the full hvigor output; stdout keeps only the summary.
- **JSON:** `--json` means stdout is valid JSON only. `--report` writes the same object to a file.
- **Dependencies:** zero. Node >= 22 strips TypeScript types directly; there is no compilation step.
