# arkts-port

**Deterministic, evidence-first toolchain for migrating Android/JVM and JS/TS modules to HarmonyOS ArkTS.**

arkts-port does not promise one-click APK-to-HAP conversion. It makes each migration step executable and checkable: the original implementation is compiled and run to produce a golden baseline, a TypeScript transcript is replayed against that baseline, and the ArkTS adaptation must pass compile and reachability gates before a HAP is built. Semantic rewriting remains human or agent work; mechanical adaptation, orchestration, and verification are automated.

## What you get

- **Zero-dependency deterministic CLIs.** 18 entrypoints (16 `cli/*.ts` + 2 scripts) and 20 npm scripts run directly on Node >= 22, with no build step and no runtime dependencies.
- **A golden baseline or no result.** `gen-golden` runs the original twice and writes a baseline only when both runs are byte-identical; `verify-fidelity` requires 100% item and scenario equality.
- **Two-phase conversion.** Kotlin/Java or JS/TS is first represented as runnable TypeScript, then adapted to ArkTS. The executable intermediate layer is what makes behavioral comparison possible.
- **Fail-closed gates.** WARN-level `arkts-*` diagnostics count as errors, missing fidelity scenarios fail, adaptation residuals fail unless explicitly waived, and lint rebuilds cleanly to avoid cache-driven false passes.
- **Reachability is tested, not assumed.** `reachability-probe` pulls every source file into a temporary copy of the project. In the legado case, entry-reachable lint saw 135 errors; full reachability found 178 (177 hard + 1 WARN), including 42 errors in 8 files lint never checked.
- **Reproducible cases.** External evidence is staged and sha256-checked; third-party sources stay outside the repository while harnesses, goldens, and actual outputs are committed.
- **Agent-ready interface.** 17 MCP tools expose the same CLIs over JSON-RPC 2.0 stdio without duplicating gate logic.

## Pipeline

```text
upstream source (Kotlin/Java, JS/TS)
  │ prepare, once per module
  │ analyze-coupling → extract-closure → pack-context → gen-golden
  │ semantic transcript in TypeScript → verify-fidelity (100%)
  ▼
port — eight stages in fixed order
  analyze → adapt → diff → fidelity → lint → reach → build → device*
  (* opt-in: requires --device; install also requires a signed HAP)
  ▼
unsigned HAP, or a signed HAP installed and launched on a device
```

`doctor` checks the SDK, hvigor, and project metadata before any build. `port` stops at the first failure unless `--continue` is passed, writes one summary line per stage, keeps logs, and emits a JSON report.

## Quick start

No install step: clone the repository and run the CLIs with Node >= 22.

```bash
node cli/analyze-coupling.ts --list-langs
node cli/doctor.ts --project <project> --sdk <sdk> --hvigor <hvigor>

# Triage, closure, and a deterministic context pack
node cli/analyze-coupling.ts --root <project> --lang jvm
node cli/extract-closure.ts --root <project> --entry <entry.kt> --out out/closure
node cli/pack-context.ts --closure out/closure --exclude Main.kt --out out/context.md

# Produce and verify the golden baseline
node cli/gen-golden.ts --lang jvm --src out/closure --main out/closure/Main.kt --out out/golden
node cli/verify-fidelity.ts --golden out/golden/golden.json --actual out/actual.json

# Adapt to ArkTS and run the gate sequence
node cli/adapt-arkts.ts --src <case>/ts --out out/ets --ets --report out/adapt.json
node cli/diff-gate.ts --before <case>/ts --after out/ets
node cli/port.ts --project <project> --case <case> --stages all --report out/report.json
```

The optional device stage is explicit:

```bash
node cli/port.ts --device <device>:<port> --signed-hap <signed.hap> \
  --bundle <bundle> --ability EntryAbility --stages device
```

## Tools

Every tool supports `--help`. Full flags, report fields, and exit codes are in [docs/tools.md](docs/tools.md).

- **Triage and environment:** `analyze-coupling`, `doctor`.
- **Closure and context:** `extract-closure`, `pack-context`.
- **Baselines and fidelity:** `gen-golden`, `verify-fidelity`.
- **Adaptation and diagnostics:** `adapt-arkts`, `diff-gate`, `explain-errors`.
- **Gates and build:** `lint-arkts`, `reachability-probe`, `build-hap`, `port`.
- **Evidence and device:** `docs-metrics`, `device-test`, `stage-case`, `acceptance`.
- **Agent interface:** `mcp-server` (17 tools).

## Cases

| Case | Scope | Evidence |
|---|---|---|
| [`cases/legado`](cases/legado/README.md) | JVM (Kotlin) pagination algorithm from a GPL-3.0 Android project; source external. | 2,108 files / 404,343 lines triaged, 13.1% auto-convertible; 22 modules / 2,898 lines in closure; 22 TS files / 4,925 lines; 22 ArkTS files / 5,597 lines; fidelity 62/62 pages (100%); 178 errors → 8 residual (4 manual sites) → 0; unsigned HAP builds. |
| [`cases/js-ts`](cases/js-ts/README.md) | JS/TS mechanism check on a 9-line function; source external. | G1-G4 PASS; golden 297 B; 2 scenarios / 7 items; 100% fidelity; one expected ArkTS error fixed by a two-line type extraction. |
| [`cases/js-ts-yoga`](cases/js-ts-yoga/README.md) | 3,303-line MIT yoga-layout TypeScript port; source external. | G1-G4 PASS; golden 1,662 B; 4 scenarios / 44 items; 100% fidelity; ArkTS 136 → 0 errors on a 47-module probe. |

The JS/TS analyzer reports 6.9% auto-convertible code for the legado `modules/web` tree (34 files / 3,057 lines). That is a triage result, not a migration claim.

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Stage model, two-phase design, fail-closed rules, determinism, limits. |
| [docs/tools.md](docs/tools.md) | Full tool table, flags, exit codes, MCP, npm scripts. |
| [docs/cases.md](docs/cases.md) | Case evidence, commands, and licensing boundaries. |
| [adapters/README.md](adapters/README.md) | Language adapter contract and supported languages. |
| [rules/arkts-restrictions.md](rules/arkts-restrictions.md) | ArkTS restrictions and the codemod's rule set. |
| [skills/arkts-port/SKILL.md](skills/arkts-port/SKILL.md) | Fixed operating procedure for agents. |

## Status and boundaries

- Node >= 22 is required (validated on 26.13.0); the CLIs have no runtime dependencies.
- 18 entrypoints, 20 npm scripts, 17 MCP tools. Test suite: 269 tests, 267 passing, 2 skipped. `docs-metrics --check` reports 0 mismatches on the checked documentation targets.
- The JVM legado case exercises the full chain end to end. JS/TS is validated at mechanism scale (`cases/js-ts`) and at 3.3k-line scale (`cases/js-ts-yoga`). Dart, C/C++, and Swift have adapter contracts but no end-to-end module validation; C/C++ is restricted to pure algorithm libraries.
- Only modules that can produce a runnable golden baseline are in scope. UI, layout, gesture, and rendering code are rewritten by hand, not transpiled.
- ArkTS behavior is compile-gated on the ArkTS side; semantic equivalence is proven on the TypeScript side. The device stage verifies installation, launch, and screens on a real device, not rendering equivalence.
- `build-hap` produces an unsigned HAP unless the project has its own signing configuration. Signing for device installation is external and uses a Huawei AGC debug profile.
- Device evidence: CMM-AL10, HarmonyOS 7, API 26; a signed HAP was installed, launched, and its UI and settings screens were verified through `cli/device-test.ts`.
- There is no LICENSE file in this repository, and no license is declared.

## License

This repository contains no LICENSE file and declares no license. Third-party case sources are not committed: the GPL-derived legado TypeScript transcript and the MIT-licensed yoga source remain external, referenced through paths or environment variables. Cases commit only harnesses, golden/actual data, and case scripts. Review the upstream licenses before redistributing anything derived from those sources.
