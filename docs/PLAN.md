# Plan: img2 plugin harness ("everything is a plugin")

Owner: rick. Status: test phase (private repos). Created 2026-08-22.

## Goal & hard constraints

Restructure the img2threejs ecosystem so capabilities are plugins, modeled on
deepseek-ai/deepseek-harness:

1. Each plugin is its **own git repo**, versioned and released independently.
2. **One-command install** per plugin (`img2 add <org/repo>`).
3. Adding a future plugin (img2glb, glb2threejs, …) for an ALREADY-DECLARED slot requires
   **zero edits to the harness** (registration only). Declaring a NEW slot the pipeline does
   not yet expose is a base-skill release, not a plugin install — `glb2threejs` will require
   a base-skill edit for exactly this reason, and that is stated honestly rather than folded
   into the zero-edits claim.
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
img2 sync --check                            # generated edge list == manifests' declared edges (CI-able)
```

## Decisions log (each was contested; alternatives rejected for cause)

| # | Decision | Rejected alternative & why |
|---|----------|---------------------------|
| D1 | Per-plugin host symlink `img2-<id>`; no router skill | Router-only: one truncated description hides N capabilities; selection is documented as stochastic (a 0.5 trigger rate counts as passing), and a ~1%-of-context listing budget drops descriptions starting with the least-invoked skill — exactly what an optional per-edge provider is |
| D2 | All generated artifacts in `$IMG2_HOME/generated/`; `img2 capabilities` is the runtime reader and recomputes from the registry and manifests, never parsing the `routes.json` cache directly | Index inside the harness checkout: dirties git, breaks `img2 update` (tracked-dirt refusal) |
| D3 | Flat `plugins.json` rows, whole-row replacement | dsh-style layered patches: we have no profiles/bundles — YAGNI |
| D4 | Python core linked via generated `_img2_local.py` + `IMG2_HOME` fallback; core is a real package; `require_core_api(n)` | pip install from git: PEP 668 breaks Homebrew/Debian; N interpreters on PATH = silent wrong-env installs |
| D5 | State envelope in `<workspace>/.img2/state.json`, plugin-scoped subtrees, core-owned lock | Today's behavior (state in shared checkout) is an existing defect, not a precedent |
| D6 | Version mismatch BLOCKS (add + sync + runtime assert); harness declares max readable plugin schema | Warn-and-continue: wrong core + plausible screenshot can pass the visual gate by luck |
| D7 | Trust: default source = `img2threejs/*`, `--allow-any-source` escape, pin tags/SHA, doctor static-only | Open `add <any-url>` reproduces the classic curl-pipe-sh problem inside agent skills |
| D8 | Harness repo named `img2` (`npx github:img2threejs/img2`), CLI `img2`, topic `img2threejs-plugin` | `harness` is meaningless outside org context; `img2-plugin` topic too generic; npm names verified free |
| D9 | Gate contract: argv in → one JSON verdict envelope on stdout, exit 0/1/2 | Status quo: 29 review scripts, 26 print ad-hoc JSON, no shared helper — the runner must define the contract |
| D10 | Steps as data with `after:` deps, topo-sorted, cycles = doctor error | if/elif profile insertion (today's workflow_state.py) cannot accept third-party steps |
| D11 | Capability conflicts allowed: doctor warns, `img2 capabilities` refuses to resolve the edge and names both claimants | A resolver/solver — YAGNI |
| D12 | Chains (image→glb→threejs) EXCLUDED from test phase | Depends on artifact-kind contracts not yet written; hand-glued chain proves nothing |
| D13 | **Owner's preference:** step and gate override is permitted; flexibility over paternalism, because a fork removes the gate AND the record | — |
| CUT | spec_search in core, `env`/`hostRequirements` manifest fields, `img2 test`, enable/disable, layering | No consumer today; each is an hour's work the day a consumer appears |

D13 is deliberately mechanism-free: every other row in this log carries the alternative it
rejected and why; D13's justification is not yet measured, so no mechanism is recorded until
it is. It authorizes the `overrides` reservation in `PLUGIN_CONTRACT.md` §6, not a built
feature.

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

**Follow-on change order**, each its own change, in sequence: `plugin-img2glb` (offline step
row + declared artifact kind) → `plugin-hello-cube` (`<image>` fix, exerciser edge, version
bump, new tag) → base-skill slot → `SKILL.md` heading merges. The base-skill slot step is
BLOCKED on an owner decision, not an agent's: two working copies of the base skill were
unmerged (`img2threejs` on `main`, 613-line `SKILL.md`, vs `feat/npx-skill-installer` on the
remote, 620-line `SKILL.md`, differing by 16 files / 1760 insertions / 838 deletions), and
every line number in the base-skill change had to be re-derived against whichever was
chosen — see "Decisions settled 2026-08-23" below for the resolution.

**Phase 5 — turn the base pipeline into data** (separate change, NOT now): see the
`route-pipeline-slots-through-capability-providers` design's D-J for the reframing, the
corrected step/gate inventory, and its five recorded costs (a)-(f) — this is not "move
62K LOC into a plugin", it is "turn the pipeline into data without changing what it means."
Ordering constraint this phase MUST respect (two restructures must not race over `forge/` —
a call-time failure mode): land or explicitly abandon `support-all-glove-subtypes` (29/44)
and `separate-cs2-tracks-from-forge` (0/39) before migrating. Both proposals live in
`openspec-from-img2/changes/` and must be adopted into the OpenSpec root or explicitly
retired first, because `separate-cs2-tracks-from-forge` restructures the same `forge/` tree
the migration moves — see "Decisions settled 2026-08-23" below for the resolution. The
"717-line uncommitted diff" `support-all-glove-subtypes` was said to carry was NEVER in a
working tree: `git status --porcelain` in the checkout that cited it showed only
`?? graphify-out/`, so the figure came from proposal prose, not a working tree, and nothing
was lost when that checkout was deleted.

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
`da8babc`, img2glb `353a8ea`). Unit suites: harness 22 node + 32 python; hello-cube 6; img2glb 12 — all green.
Note: the v0.1.1 launcher release bumped `package.json` without re-running the suite, leaving two
version assertions hardcoded to `0.1.0` red on `main` until they were changed to derive the expected
value from the exported `harnessVersion()`. Re-run both suites after any version bump.

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

## Change 1 applied — harness 0.2.0 (2026-08-24)

`route-pipeline-slots-through-capability-providers` sections 1-7 applied. Suites green: **59 node +
36 python**. Delivered: the three live v0.1.1 defects closed (metacharacter refusal in
`commandFinding`, `confirmOrThrow` in `cmdAdd` for out-of-org sources, `resolve_workspace` refusing
any skill or plugin checkout); `img2 capabilities` with the always-JSON envelope, argv-tokenised step
commands and per-row failure isolation; `img2 --version --json` advertising `contract: 14` and the
derived `commands` list; `img2 doctor --json`, the multi-capability WARN, the base-host-link report,
and the deletion of the false "the model picks by description" claim; `plugin.json` refusing an
`overrides` key and `img2 add --force` preserving user-authored row keys.

Acceptance re-run in a fake-`HOME` sandbox: test 18 — after `img2 add --link plugin-img2glb` the
harness checkout is porcelain-clean and `img2 capabilities --from-kind image --to-kind glb` answers
with `img2glb`; test 19 — `--version --json` lists `capabilities` in `commands`.

Two defects found during manager verification, not by the implementing agents, both fixed with
regression tests:
- **`img2 doctor` failed on a fresh install.** `cmdDoctor`'s drift check had no never-synced guard, so
  the first command a new user runs after `img2 install` exited 1 with "generated artifacts are out of
  sync". `cmdCapabilities` had the guard; `cmdDoctor` did not. The asymmetry was the bug.
- **The capabilities envelope reported the harness version in its `version` field**, where the
  envelope's own schema version belongs — a consumer branching on it would have read `"0.1.1"` instead
  of `1`. The harness version is advertised by `--version --json` and nowhere else.

`.omc/` and `_img2_local.py` added to `.gitignore` so the zero-core-edits claim is literally true of
`git status --porcelain`, not true modulo operational dirt.

## Risks

| Risk | Mitigation |
|------|------------|
| Gate-contract adaptation of 28 legacy gates blows the schedule | Contract proven on 2 gates now; legacy adapts behind a wrapper shim in Phase 5, gate-by-gate |
| Host permission behavior differs from docs | Acceptance test 4 runs against the real host before anything else depends on the layout |
| TRELLIS endpoint flaky/needs network | `--probe` offline mode is the tested path; live call manual |
| Two restructures race over forge/ | Explicit ordering rule in Phase 5; harness phase touches zero existing files |
| Legacy installs orphaned | `img2 install` migrates `~/.img2threejs`; `IMG2THREEJS_HOME` honored one release |

## Open Questions

- **Deferred: `img2 doctor --strict` (FAIL on any WARN).** `cmdDoctor` returns `EXIT.OK` with
  any number of warnings (`bin/img2.mjs`, end of `cmdDoctor`), so no WARN can fail an
  automated check today. Shipping `--strict` now would silently convert existing advisory
  WARNs into build breaks for existing installs. This change's own enforcement of its
  warnings is the query's machine-readable `problems[]`/`providers[]` split with its own exit
  codes (D-E), not `--strict`. `--strict` becomes load-bearing the day the first WARN-level
  finding must fail a build, and every such finding known today (an active override, a
  missing declared Python package) is itself deferred, so there is nothing yet for it to
  enforce.
- **Override precondition**, not yet a contract SHALL: override does not ship until the gate
  ledger has a writer, a home, and a test that fails when a disabled or overridden gate is
  omitted from the run record, and until `img2 doctor`'s surfacing of an active override is
  specified down to its message and exit consequence. Evidence: `img2_core/gate_runner.py`
  is per-plugin-directory, prints its aggregate to stdout and persists nothing (`:147`), and
  the only durable per-pass record (`reviewHistory` in the sculpt spec) has no field that
  could hold a gate roster — so two reports, one with all gates and one with three disabled,
  are byte-indistinguishable today.
- **Deferred: `requires.python.packages` detect-and-report** (D-K). When built: an optional
  additive `requires.python.packages` list in `plugin.json` (absent means unknown, no schema
  bump), and a doctor WARN naming the plugin, the missing package, the probed interpreter,
  the install command, and which steps still work without it. The CORRECTED probe is
  `python3 -I -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('X')
  else 3)"`, run with the cwd set OUTSIDE every clone; declared package names MUST match
  `^[A-Za-z_][A-Za-z0-9_]*$` and be top-level only (`find_spec('a.b')` still imports `a`);
  the interpreter is derived from the step row's `argv[0]`, never assumed to be `python3` on
  doctor's PATH. Why the correction matters: `python3 -c "import X"` puts the cwd on
  `sys.path[0]`, so it executes a plugin-supplied `X.py` during `img2 doctor` — exactly what
  §4's static-trust boundary forbids.
- **What a future `glb2threejs` provider is allowed to do.** `img2threejs/SKILL.md:88`
  states the raw GLB is never pixel evidence and its topology/materials are never copied
  into the factory; `:34` plus `CLAUDE.md`'s code-only promise forbid photogrammetry, mesh
  extraction, or downloaded art packs; the existing `integrations/` contract permits an
  external tool to produce evidence and diagnostics but not to silently provide meshes,
  decide hidden geometry, mutate the accepted source, or approve a pass. A provider that
  translates GLB geometry into Three.js code contradicts that identity; a provider that
  derives evidence from a GLB (proportions, semantic regions, comparison baselines, capture
  profiles) is consistent with it. The base skill already performs `glb → threejs-code` in
  the GLB-mediated track, so the open question is which implementation is permitted, not
  whether the step exists. Deferred to the owner — see "Decisions settled 2026-08-23" below
  for how it was closed.
- **The closed placeholder set lands ahead of pipeline-as-data and constrains it.** The base
  pipeline's own step commands use `{reference}` (9), `{spec}` (8), `{pass_id}` (4),
  `{path}`, `{total}`, `{step_id}`, `{pass_count}`, `{expected_id}`, `{current_pass}`, none
  of which are in `{plugin_dir}`/`{workspace}`/`{image}`. Phase 5 must therefore either widen
  the permitted set (undoing part of this change's hardening) or rewrite every step command
  before it can express the base pipeline as `steps.json` rows. The guard is still correct to
  land first.

## Decisions settled 2026-08-23

Three owner decisions, closing the corresponding open questions above and in Phase 5:

(a) **Base-skill work branches from `main`, NOT from `feat/npx-skill-installer`.** `main`
carries the 613-line `SKILL.md` and does not contain the npx-installer commits, which stay
unmerged on their own branch. No line number for the deferred base-skill change may be
derived from the 620-line variant.

(b) **The eleven proposals previously living only in `openspec-from-img2/` are ADOPTED into
the OpenSpec root**: `support-all-glove-subtypes` (29/44), `separate-cs2-tracks-from-forge`
(0/39), `route-cs2-family-through-adapter-registry` (0/15), `guide-unsupported-cs2-families`
(0/22), `add-npx-skill-installer` (80/83), plus six glove/typecheck changes. Phase 5's
ordering rule now points at live changes in the OpenSpec root rather than at a backup
directory.

(c) **`glb2threejs` is not scheduled and no phase reaches it.** If it is ever built it
follows whatever `SKILL.md` defines at that time, which today means the evidence-producing
kind, because `SKILL.md:88` forbids copying GLB topology or materials into the factory. The
open question above is therefore CLOSED by deferring to the product contract rather than by
choosing a design.
