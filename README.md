<p align="center"><strong>English</strong> | <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Node.js >= 22" src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Runtime dependencies: 0" src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen?style=flat-square">
  <img alt="HarmonyOS ArkTS" src="https://img.shields.io/badge/HarmonyOS-ArkTS-0A59F7?style=flat-square">
  <img alt="MCP tools: 17" src="https://img.shields.io/badge/MCP-17%20tools-5c4ee5?style=flat-square">
  <img alt="Status: pre-release" src="https://img.shields.io/badge/status-pre--release-7da1de?style=flat-square">
</p>

# arkts-port

**Deterministic, evidence-first toolchain for migrating Android/JVM and JS/TS modules to HarmonyOS ArkTS.**

arkts-port does not promise one-click APK-to-HAP conversion. It makes each migration step executable and checkable: the original implementation is compiled and run to produce a golden baseline, a TypeScript transcript is replayed against that baseline, and the ArkTS adaptation must pass compile and reachability gates before a HAP is built. Semantic rewriting remains human or agent work; mechanical adaptation, orchestration, and verification are automated.

## What you get

- **Zero-dependency deterministic CLIs.** 23 entrypoints (21 `cli/*.ts` + 2 scripts) and 20 npm scripts run directly on Node >= 22, with no build step and no runtime dependencies.
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
port — nine stages in fixed order (autofix opt-in)
  analyze → adapt → autofix* → diff → fidelity → lint → reach → build → device*
  (* autofix requires --autofix; device requires --device; install also requires a signed HAP)
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

- **Triage and environment:** `analyze-coupling`, `triage-boundary`, `assess-conversion`, `doctor`.
- **Closure and context:** `extract-closure`, `pack-context`.
- **Baselines and fidelity:** `gen-golden`, `verify-fidelity`.
- **Adaptation and diagnostics:** `adapt-arkts`, `arkts-fix`, `ui-skeleton`, `diff-gate`, `explain-errors`.
- **Gates and build:** `lint-arkts`, `reachability-probe`, `build-hap`, `port`.
- **Evidence and device:** `case`, `docs-metrics`, `device-test`, `stage-case`, `acceptance`.
- **Agent interface:** `mcp-server` (17 tools).

## Cases

Upstream triage of the legado project covered 2,108 files / 404,343 lines; 13.1% was auto-convertible.

| Case | Scope | Evidence |
|---|---|---|
| [`cases/legado`](cases/legado/README.md) | JVM (Kotlin) pagination algorithm from a GPL-3.0 Android project; source external. | 22 modules / 2,898 lines in closure; 22 TS files / 4,925 lines; 22 ArkTS files / 5,597 lines; fidelity 62/62 pages (100%); 178 errors → 8 residual (4 manual sites) → 0; unsigned HAP builds. |
| [`cases/js-ts`](cases/js-ts/README.md) | JS/TS mechanism check on a 9-line function; source external. | G1-G4 PASS; golden 297 B; 2 scenarios / 7 items; 100% fidelity (7/7); 1 expected ArkTS error fixed by a 2-line type extraction. |
| [`cases/js-ts-yoga`](cases/js-ts-yoga/README.md) | 3,303-line MIT yoga-layout TypeScript port; source external. | G1-G4 PASS; golden 1,662 B; 4 scenarios / 44 items; 100% fidelity (44/44); ArkTS 136 → 0 errors on a 47-module probe. |

The case READMEs under [cases/](cases/) are Chinese-only; the table above is the English summary of the same evidence.

## Documentation

| Document | Contents |
|---|---|
| [docs/README.md](docs/README.md) | Documentation index: entry points for readers and agents. |
| [docs/architecture.md](docs/architecture.md) | Stage model, two-phase design, fail-closed rules, determinism, limits. |
| [docs/tools.md](docs/tools.md) | Full tool table, flags, exit codes, MCP, npm scripts. |
| [docs/cases.md](docs/cases.md) | Case evidence, commands, and licensing boundaries. |
| [adapters/README.en.md](adapters/README.en.md) | Language adapter contract and supported languages. |
| [rules/arkts-restrictions.en.md](rules/arkts-restrictions.en.md) | ArkTS restrictions and the codemod's rule set. |
| [skills/arkts-port/SKILL.en.md](skills/arkts-port/SKILL.en.md) | Fixed operating procedure for agents. |

## Status and boundaries

- Node >= 22 is required (validated on 26.13.0); the CLIs have no runtime dependencies.
- 23 entrypoints (21 `cli/*.ts` + 2 scripts), 20 npm scripts, 17 MCP tools. Test suite: 388 tests, 386 passing, 2 skipped. `docs-metrics --check` reports 0 mismatches.
- The JVM legado case exercises the full chain end to end. JS/TS is validated at mechanism scale (`cases/js-ts`) and at 3.3k-line scale (`cases/js-ts-yoga`). Dart, C/C++, and Swift have adapter contracts but no end-to-end module validation; C/C++ is restricted to pure algorithm libraries.
- Only modules that can produce a runnable golden baseline are in scope. UI skeleton generation (`ui-skeleton`) is mechanical, but layout, gesture, and rendering equivalence are not claimed and remain manual.
- ArkTS behavior is compile-gated on the ArkTS side; semantic equivalence is proven on the TypeScript side. The device stage verifies installation, launch, and screens on a real device, not rendering equivalence.
- `build-hap` produces an unsigned HAP unless the project has its own signing configuration. Signing for device installation is external and uses a Huawei AGC debug profile.
- Device evidence: CMM-AL10, HarmonyOS 7, API 26; a signed HAP was installed, launched, and its UI and settings screens were verified through `cli/device-test.ts`.

## License

[MIT](LICENSE) © 2026 Han-Haocheng. Third-party case sources are not committed: the GPL-3.0-derived legado TypeScript transcript and the MIT-licensed yoga source remain external, referenced through paths or environment variables. Cases commit only harnesses, golden/actual data, and case scripts. See [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) for the full boundary, and review the upstream licenses before redistributing anything derived from those sources.
