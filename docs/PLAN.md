# Plan: img2 plugin harness ("everything is a plugin")

Owner: rick. Status: test phase (private repos). Created 2026-08-22.

## Goal & hard constraints

Restructure the img2threejs ecosystem so capabilities are plugins, modeled on
deepseek-ai/deepseek-harness:

1. Each plugin is its **own git repo**, versioned and released independently.
2. **One-command install** per plugin (`img2 add <org/repo>`).
3. Adding a future plugin (img2glb, glb2threejs, …) requires **zero edits to the harness**
   (registration; new *core capabilities* are a harness release — stated honestly).
4. The design is NOT anchored on the current img2threejs repo layout.

## Research inputs (summarized)

- **deepseek-harness** (verified from source): plugins are tiny uniform packages;
  composition is data rows `{id, name, config, disabled}`; no privileged core; fail-loud
  composition audit; dump==mount via shared code path; discovery by GitHub topic, no
  central registry; per-plugin docs/tests co-located.
- **Current repo audit** (275 tracked files, ~62.3K LOC): single flat skill; SKILL.md
  (620 lines) routes by literal path strings to 43 tools + ~30 docs; 28 gates with no
  registry and no shared verdict format; state written into the shared checkout instead of
  the user's project; ~47 `parents[N]` root computations in forge/ that fail silently on
  any move; clean seams worth reusing: HOSTS table in bin/cli.mjs, FamilyAdapter registry,
  integrations/ out-of-process contract, buildPasses override.
- **Adversarial design review** — 5 blockers found and resolved; decisions below.

## Final architecture

```
org img2threejs
├── img2                      # THE HARNESS (this repo)
│   ├── bin/img2.mjs          # CLI: install / add / remove / list / doctor / sync (Node ≥18, zero deps)
│   ├── img2_core/            # Python pkg (stdlib only): paths, state envelope+lock, gate_runner, api
│   ├── docs/PLUGIN_CONTRACT.md
│   └── tests/
├── plugin-hello-cube         # minimal REAL plugin: image → threejs-code, 1 gate, 1 step
├── plugin-img2glb            # image → glb (wraps the TRELLIS mesh3d integration)
├── plugin-img2threejs        # (later) today's 62K-LOC skill, migrated
└── plugin-glb2threejs        # (future) — must require zero harness edits to add
```

User-facing flow:

```
npx github:img2threejs/img2 install          # $IMG2_HOME (~/.img2), host links, settings merge
img2 add img2threejs/plugin-img2glb          # clone @tag, pin SHA, row, symlink ~/.claude/skills/img2-img2glb
img2 doctor                                  # fail-loud static audit of every row
img2 sync --check                            # generated index == manifests (CI-able)
```

## Decisions log (each was contested; alternatives rejected for cause)

| # | Decision | Rejected alternative & why |
|---|----------|---------------------------|
| D1 | Per-plugin host symlink `img2-<id>`; no router skill | Router-only: hosts scan skills one level deep, one truncated description hides N capabilities, no skill→skill invocation exists |
| D2 | All generated artifacts in `$IMG2_HOME/generated/`, runtime routing reads generated `routes.json` | Index inside the harness checkout: dirties git, breaks `img2 update` (tracked-dirt refusal) |
| D3 | Flat `plugins.json` rows, whole-row replacement | dsh-style layered patches: we have no profiles/bundles — YAGNI |
| D4 | Python core linked via generated `_img2_local.py` + `IMG2_HOME` fallback; core is a real package; `require_core_api(n)` | pip install from git: PEP 668 breaks Homebrew/Debian; N interpreters on PATH = silent wrong-env installs |
| D5 | State envelope in `<workspace>/.img2/state.json`, plugin-scoped subtrees, core-owned lock | Today's behavior (state in shared checkout) is an existing defect, not a precedent |
| D6 | Version mismatch BLOCKS (add + sync + runtime assert); harness declares max readable plugin schema | Warn-and-continue: wrong core + plausible screenshot can pass the visual gate by luck |
| D7 | Trust: default source = `img2threejs/*`, `--allow-any-source` escape, pin tags/SHA, doctor static-only | Open `add <any-url>` reproduces the classic curl-pipe-sh problem inside agent skills |
| D8 | Harness repo named `img2` (`npx github:img2threejs/img2`), CLI `img2`, topic `img2threejs-plugin` | `harness` is meaningless outside org context; `img2-plugin` topic too generic; npm names verified free |
| D9 | Gate contract: argv in → one JSON verdict envelope on stdout, exit 0/1/2 | Status quo: 29 review scripts, 26 print ad-hoc JSON, no shared helper — the runner must define the contract |
| D10 | Steps as data with `after:` deps, topo-sorted, cycles = doctor error | if/elif profile insertion (today's workflow_state.py) cannot accept third-party steps |
| D11 | Capability conflicts allowed: doctor warns, index lists both, model picks | A resolver/solver — YAGNI |
| D12 | Chains (image→glb→threejs) EXCLUDED from test phase | Depends on artifact-kind contracts not yet written; hand-glued chain proves nothing |
| CUT | spec_search in core, `env`/`hostRequirements` manifest fields, `img2 test`, enable/disable, layering | No consumer today; each is an hour's work the day a consumer appears |

## Phases

**Phase 0 — research + adversarial design review.** DONE (this document).

**Phase 1 — contract + plan docs.** DONE: `docs/PLUGIN_CONTRACT.md` is the normative spec.

**Phase 2 — build the thin slice (private repos, parallel):**
- `img2`: CLI (install/add/remove/list/doctor/sync), `img2_core` (paths, state, gate_runner,
  `require_core_api`), unit tests, legacy `~/.img2threejs` migration.
- `plugin-hello-cube`: image → deterministic cube .js; 1 gate (`cube-structure`, real
  verdict envelope); 1 step; tests. Exists to exercise every contract surface with zero
  domain risk.
- `plugin-img2glb`: port `integrations/mesh3d/generate_reference_mesh.py`; declares
  image→glb; `--probe` offline mode (validates inputs, emits plan JSON, no network) so
  acceptance tests are deterministic; live TRELLIS call stays manual.

**Phase 3 — acceptance run** (fresh `$IMG2_HOME` + fake `$HOME` in a scratch dir):
all 10 tests below, binary pass/fail, results in the report.

**Phase 4 — review with owner.** Repos stay private; walk through results; go/no-go for
migration phases.

**Phase 5 — migrate img2threejs into plugin-img2threejs** (separate effort, NOT now):
- Ordering rule (two restructures must not race over forge/ — call-time failure mode):
  first land or explicitly abandon `support-all-glove-subtypes` (carries a 717-line
  uncommitted diff) and `separate-cs2-tracks-from-forge`; only then migrate.
- Inside the migration: 1 shared `project_root()` replaces all `parents[N]` first; then
  adapter-registry consumers (`route-cs2-family-through-adapter-registry`, 0/15, smallest
  highest-leverage change); then move content; adapt the 28 gates to the verdict envelope
  gradually (runner accepts a legacy-wrapper shim during transition).
- Back-compat commitments: host link `img2threejs` preserved as an alias; `IMG2THREEJS_*`
  env honored inside the plugin; sculpt-spec schema unchanged; artifact kinds migrate
  mechanically (4 kinds, 6 occurrences — measured, not a crisis).

**Phase 6 — go public:** publish `img2` to npm (name verified free — reserve it), repos
public, topic `img2threejs-plugin` on every plugin, README quickstarts, deprecate the old
installer path in img2threejs/img2threejs with a pointer.

## Acceptance tests (Phase 3, all binary)

1. `npx`-equivalent install on a clean `$HOME` → host symlinks + `$IMG2_HOME` layout, exit 0.
2. `img2 add img2threejs/plugin-img2glb` → clone, row with `resolvedSha`, host symlink,
   exit 0, AND harness checkout `git status --porcelain` EMPTY (the zero-core-edits claim,
   mechanically).
3. Same `add` again → non-zero, names the existing row; no silent overwrite.
4. Fresh agent session in an EMPTY project dir, prompt "turn this image into a GLB" →
   model discovers and invokes `img2-img2glb` with zero permission prompts.
5. `img2 sync --check` non-zero after a manifest edit; zero after `img2 sync`.
6. Both plugins' gates run through `img2_core.gate_runner`, emit the same envelope; a
   deliberately failing gate stops the workflow.
7. Two plugins write state under their own key without clobbering; concurrent invocation
   serializes on the lock.
8. `requires.harness: ">=99"` → `add` and `doctor` fail loud, naming the row.
9. `doctor` fails a plugin containing `parents[N]` or a cross-plugin import (static only).
10. `img2 remove` → no dangling host symlink on ANY host, no orphan row.

## Phase 2–3 results (2026-08-22)

Thin slice built and tagged `v0.1.0` on all three repos (harness `1013a62`, hello-cube
`da8babc`, img2glb `353a8ea`). Unit suites: harness 20/20 node + 32 python; hello-cube 6;
img2glb 12 — all green, independently re-run.

Acceptance: tests 1–3, 5–10 **pass** as written (test 2's zero-core-edit check: both
harness checkouts `git status --porcelain` empty after `add`). Test 4 passed its
structural half (symlink → `$IMG2_HOME`, valid frontmatter, settings merge); the
live-model half is the remaining **manual step: open a real host session in an empty dir
and ask for an image→GLB conversion**. Substitution: private-repo clones used `file://`
local paths under the sandbox fake-HOME (https creds unavailable there); the
newest-tag-resolution path is now exercisable for real since `v0.1.0` exists.

Findings fixed before tagging: (1) `_img2_local.py` fallback only resolved next to the
running script — sync now writes it into the clone root AND `tools/` (contract §8
amended, regression-tested with an env-empty subprocess); (2) lost-update window in
state read-modify-write — `update_plugin_state()` added holding the lock across the whole
cycle (contract §11 amended; the old pattern measurably lost 20/40 writes under the new
concurrency test).

## Risks

| Risk | Mitigation |
|------|------------|
| Gate-contract adaptation of 28 legacy gates blows the schedule | Contract proven on 2 gates now; legacy adapts behind a wrapper shim in Phase 5, gate-by-gate |
| Host permission behavior differs from docs | Acceptance test 4 runs against the real host before anything else depends on the layout |
| TRELLIS endpoint flaky/needs network | `--probe` offline mode is the tested path; live call manual |
| Two restructures race over forge/ | Explicit ordering rule in Phase 5; harness phase touches zero existing files |
| Legacy installs orphaned | `img2 install` migrates `~/.img2threejs`; `IMG2THREEJS_HOME` honored one release |
