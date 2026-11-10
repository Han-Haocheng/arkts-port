# arkts-port

[Documentation index](../../docs/README.md) · [简体中文](SKILL.md)

Verifiable migration: Android → HarmonyOS (ArkTS). A conversion without a golden comparison is not accepted; **the agent only makes judgments, mechanical actions go to the CLI**.

## When to use / when not to
- Use: pure logic modules; when you need to prove "it was converted correctly"; when upstream will sync repeatedly.
- Do not use: UI (Compose→ArkUI rewrite), reflection/pluginization, rendering/gestures/animation, or other modules that cannot produce golden.
- No automatic conversion below 15% coverage (hand-written port only).

## Token discipline
1. Doctor/triage first, then extract-closure; read only files inside the closure, not the entire source tree.
2. pack-context before the transcript: read the context pack (legado closure 21,244 B ≈ 5.6k tokens), not the 138 KB of source.
3. Read only packs / reports / DIFFs, never re-read full logs; complete logs go to `out/logs/` and are grepped when needed.
4. explain-errors instead of hand-written scripts; handle only residuals / needs-review.
5. Stop chaining commands by hand: prefer port; do one module per semantic transcript, with only the pack + this skill in context.

## Tool status (2026-11-10 v4)
✅ Implemented (23 entrypoints = 21 cli/*.ts + 2 scripts, including case): doctor / analyze-coupling / triage-boundary / assess-conversion / extract-closure / pack-context / gen-golden / verify-fidelity / adapt-arkts / arkts-fix / ui-skeleton / diff-gate / explain-errors / lint-arkts / reachability-probe / port / build-hap / device-test / docs-metrics / mcp-server / case + `scripts/stage-case.mjs` / `scripts/acceptance.mjs`.
All entrypoints' `--help` exits 0, an unknown argument exits 2; port/doctor are now fail-closed (empty values / missing prerequisites are not let through).

## Fixed command sequence
### 0 Environment precheck (mandatory)
```bash
node cli/doctor.ts --project <harmony> [--sdk <p>] [--hvigor <p>] [--case <dir>] [--json] [--report <path>]
```
Exit code 0 = no FAIL (WARN is allowed); fix any FAIL before running gates — never run gates on an unhealthy environment.
### 1 Triage
```bash
node cli/analyze-coupling.ts --list-langs
node cli/analyze-coupling.ts --root <project> --lang <jvm|js-ts|dart|c-cpp|swift> [--json] [--top 15]
```
`verdict=low` (<15%) → stop.
### 2 Extract the closure
```bash
node cli/extract-closure.ts --root <project> --entry <file.kt> [--lang jvm] [--out <dir>] [--report <path.json>] [--json]
```
Read only the `files/role/boundaries` report; do not read `coupled` files one by one. `--out` must point outside `--root` (rejected by default); a rerun cleans up old artifacts according to the managed manifest.
### 3 Transcript context pack
```bash
node cli/pack-context.ts --closure <dir> [--lang jvm] [--out out/context.md] [--max-bytes 200000] [--exclude <glob>] [--json] [--report <path>]
```
Read the Markdown pack (file list / signatures / F32 markers) to prepare the transcript; do not re-read the entire source.
### 3b js-ts branch (semantic transcript can be skipped)
```bash
node cli/extract-closure.ts --root <web> --lang js-ts --entry <entry.ts> --out ../out/closure
node cli/pack-context.ts --closure ../out/closure --lang js-ts --out out/context.md
node cli/gen-golden.ts --lang js-ts --main <harness.mjs> --out out/gen-golden
```
The closure resolves tsconfig/jsconfig paths and vite aliases by default (`--no-alias` turns it off; look at unresolved.alias/target for broken links); pack-context includes one level of member signatures by default (`--no-members` turns it off). After golden, go straight to adapt-arkts → diff-gate → lint/reach/build; the mechanism case is `cases/js-ts` (`node cases/js-ts/run.mjs` reruns G1-G4); the scale case is `cases/js-ts-yoga` (`node cases/js-ts-yoga/run.mjs`, MIT-licensed 3,303 lines, 4/4 PASS, ArkTS 136→0).
### 4 Produce golden (agent decides scenarios)
```bash
node cli/gen-golden.ts --lang jvm --src <dir> --main <Main.kt> [--package <pkg>] [--out <dir>] [--json] [--report <path>]
```
Scenarios cover empty/full/overlong/multi-segment/special characters; exit 3 = the two outputs differ, exit 4 = missing harness (write Main.kt first).
### 5 Semantic transcript (the agent's main arena)
Kotlin → TS: line-by-line equivalence; no any/unknown/as const/globalThis; mark floating-point accumulation points with `// F32:`; keep class and method names; use erasable syntax. For rules, consult only `rules/arkts-restrictions.en.md`.
### 6 Fidelity gate (must be 100%)
```bash
node cli/verify-fidelity.ts --golden <golden.json> --actual <actual.json> [--key scenario] [--items pages] [--field text] [--json]
```
FAIL / MISSING → locate it from the DIFF lines only; do not re-read the full text.
### 7 Mechanical ArkTS adaptation
```bash
node cli/adapt-arkts.ts --src <ts-dir> --out <ets-dir> --ets --report out/adapt-report.json [--json] [--fail-on-residual]
```
Look only at `report.residuals`; `crossfile-type-ref` / `rename-uncertain` need human review (cross-file type references through value imports are not renamed automatically; change them to import type or handle them by hand); after fixing, **rerun step 6**.
### 8 Residual error localization
```bash
node cli/explain-errors.ts --log <hvigor.log|errors.json> [--root <ets-root>] [--max 20] [--rule arkts-*] [--json] [--report <path>]
```
Output = rule / file:line:col / source snippet / fix anchor; `file="?"` is listed separately; stop writing your own scan scripts.
### 9 Compile gates (both steps required, must be 0)
```bash
node cli/lint-arkts.ts --project <harmony> [--sdk <p>] [--hvigor <p>] [--json] [--report <path>]
node cli/reachability-probe.ts --project <harmony> [--src entry/src/main/ets] [--entry pages/Index.ets] [--sdk <p>] [--hvigor <p>] [--json] [--report <path>]
```
The second step is not optional: entry reachability checks only some files, and only full reachability sees everything. **WARN-level `arkts-*` diagnostics count as violations** (globalThis was measured as a WARN). lint does a clean build every time by default (clears .hvigor/cache and the module build, about 6-7s); gates/CI must not use `--no-clean`; on failure run step 8 explain-errors first.
### 10 One-shot gate (optional, recommended)
```bash
node cli/port.ts --project <harmony> --src <src-root> --adapt-src <ts-dir> --adapted <ets-dir> --case <case-dir> --sdk <p> --hvigor <p> --stages all [--autofix] [--no-autofix] [--arkts-fix-out <dir>] [--fidelity-key <k>] [--fidelity-items <items>] [--fidelity-field <field>] --report out/port-report.json [--json] [--continue]
```
Stage order: analyze→adapt→autofix→diff→fidelity→lint→reach→build→device. **Strict by default**: adapt residuals (exit 3) → FAIL; `--allow-residuals` is the only waiver switch (the reason must be recorded in the report). **device is optional**: enabled only with `--device <ip:port>`; `--signed-hap <hap> --bundle <id> --ability EntryAbility` performs install+launch+screenshot, and without signed-hap it only checks; the default 7 stages are unchanged. **autofix is optional and off by default**: only `--autofix` enables it (requires `cli/arkts-fix.ts`), and `--no-autofix` turns it off explicitly; it affects diff only (diff uses the fixed directory when transforms>0), while lint/reach/build still use `--project`. **The diff stage is a WARN**: needs-review>0 only warns and does not block, and only `--strict-diff` treats it as a failure; report counts include warn. **lint/reach FAIL automatically runs explain-errors** (`--no-explain` disables it, `--explain-max` defaults to 5), and the summary gives the rule + file:line directly. **A device failure stops immediately**; the screenshot is written to `<logs>/device.jpeg`, and metrics include check/install/launch/screenshot.
### 11 Build
```bash
node cli/build-hap.ts --project <harmony> [--mode debug|release] [--sdk <p>] [--hvigor <p>] [--log <path>]
```

## Three gates
| Gate | Pass condition | On failure |
|---|---|---|
| Fidelity | 100% (every item equal; MISSING also counts as FAIL) | Return to step 5 and locate it by DIFF |
| ArkTS | lint 0 + full reachability 0; **including WARN-level `arkts-*`** | Fix with explain-errors + rules; changing semantics is forbidden |
| Build | BUILD SUCCESSFUL | Check `rules/pitfalls.en.md` |

## Release regression (one command)
```bash
node scripts/acceptance.mjs --refs <refs> [--sdk <p> --hvigor <p>]
```
5-stage hard assertions: stage 22/4,925, golden sha256, replay 62/62, adapt 43/41/9/9/7, arkts-gate in two framings (codemod 9 diagnostics vs reference 0 errors + build). Without an SDK it automatically SKIPs arkts-gate; if the evidence changes it FAILs.

## Real device (optional)
```bash
node cli/device-test.ts --target <ip:port> --check [--hdc <sdk>/toolchains/hdc]
node cli/device-test.ts --target <ip:port> --hap <signed.hap> --install --bundle <id> --ability EntryAbility --screenshot out/device.jpeg
```
On install failure read errorCode: 9568320 unsigned / 9568257 profile not trusted / 9568258 deviceType mismatch; do not bypass signing. After signing, use `--bundle --ability` to launch and capture hilog.

## Case reproduction (external evidence)
Cases depend on TS artifacts from external `.refs` (GPL-derived, not committed): `node scripts/stage-case.mjs --refs <refs> --case cases/legado`; `--check` verifies sha256; `cases/*/ts/` is already in `.gitignore`.

## The agent only makes judgments
- Do: whether a module is pure logic / can produce golden; scenario design; semantic transcript; residuals/needs-review judgment; deciding to give up when coverage is insufficient.
- Do not: chaining commands by hand, re-reading logs, copying errors one by one, redoing codemod adaptation, UI rewrites, real-device verification, treating diff-gate as semantic proof.

## Environment and references
Node ≥22 (measured 26.13.0); `OHOS_BASE_SDK_HOME` and `HVIGOR_HOME` come from the environment; rules `rules/arkts-restrictions.en.md`, `rules/pitfalls.en.md`, `rules/api-mapping.en.md`; adapters `adapters/README.en.md`; cases `cases/legado/README.md`.

## New case checklist (templates: `cases/legado`, `cases/js-ts`, `cases/js-ts-yoga`)
1. Triage: `node cli/analyze-coupling.ts --root <project> --lang <id> --json` (<15% stop).
2. Closure: `node cli/extract-closure.ts --root <project> --entry <entry> --lang <id> --out out/<case>/closure --report out/<case>/closure.json --json` (`--out` must be outside `--root`).
3. Context: `node cli/pack-context.ts --closure out/<case>/closure --lang <id> --out out/<case>/context.md --json`.
4. harness/golden: `node cli/gen-golden.ts --lang <id> --main cases/<case>/harness/<name>.mjs --out out/<case>/golden --json` (jvm: `--src <closure> --main <closure>/Main.kt`; `--out` outside the harness directory).
5. replay/fidelity: `node cases/<case>/replay.ts > out/<case>/actual.json` (or `cases/js-ts/replay.mjs`); `node cli/verify-fidelity.ts --golden out/<case>/golden/golden.json --actual out/<case>/actual.json` (if the shapes differ add `--items/--field`; must be 100%).
6. adapt/diff: `node cli/adapt-arkts.ts --src out/<case>/closure --out out/<case>/adapt --ets --report out/<case>/adapt.json`; `node cli/diff-gate.ts --before out/<case>/closure --after out/<case>/adapt --json`.
7. probe: `node cli/reachability-probe.ts --project <parity> --sdk $OHOS_BASE_SDK_HOME --hvigor $HVIGOR_HOME --json` (0 ERROR + 0 WARN).
8. Write to disk: `cases/<case>/README.md` (scope/commands/expected numbers/evidence) + `harness/` + `replay.*` + `golden.json`; use `stage-case`/closure copies for external evidence, and put logs in `out/` (gitignored).
9. Evidence/templates: write sha256, counts, and error counts into the README; JVM template `cases/legado/README.md`, js-ts templates `cases/js-ts/README.md`, `cases/js-ts-yoga/README.md`.
