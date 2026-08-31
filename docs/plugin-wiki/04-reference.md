← [wiki index](README.md)

# Reference

Every field, every refusal, the checklist, and the known gaps.

## `plugin.json` — the only required file

```json
{
  "schema": 1,
  "name": "interiors",
  "version": "0.1.0",
  "description": "One sentence on what this plugin knows and what it refuses.",
  "capabilities": [
    { "from": "image", "to": "interior-scene-spec" }
  ],
  "requires": { "harness": ">=0.2.1", "coreApi": 1 }
}
```

| field | notes |
|---|---|
| `schema` | manifest schema version. `1` today |
| `name` | `[a-z][a-z0-9-]*`. Becomes the registry id, the directory under `$IMG2_HOME/plugins/`, **and** the host link suffix (`~/.claude/skills/img2-<name>`) — you do not choose the link name |
| `description` | one line. Shown in `img2 list` and the generated index |
| `capabilities` | array of typed edges `{from, to}`. **The only thing resolution matches on.** Several edges draws a `doctor` WARN, not an error |
| `requires` | compatibility floor: `harness` semver range, `coreApi` integer. **A mismatch BLOCKS at `img2 add` and `img2 sync`** — pick honest floors. Only `>=X.Y.Z` parses; nothing else does |
| ~~`overrides`~~ | **must never exist.** Install fails if present |

## `domain.json` — the domain profile

Read through the harness registry, never by globbing.

| field | required | notes |
|---|---|---|
| `id` | yes | domain id |
| `setupSteps` | no | array of `[step_id, command]`; run **once** |
| `setupAnchorBefore` | **when `setupSteps` is non-empty** | base step id; your steps splice immediately *before* it |
| `passSteps` | no | array of `[step_id, command]`; run in **every correction pass** |
| `passAnchorBefore` | **when `passSteps` is non-empty** | base step id |
| `specCollection` | no | name of your contributed spec-search collection |

The registry refuses unknown keys, and refuses `setupSteps` without `setupAnchorBefore`. An anchor
naming a base step that does not exist fails loud:

```
WorkflowStateError: profile 'interiors' anchors a step before unknown base step 'vision-analysis'
```

Anchor ids: see [the cookbook](03-cookbook.md#anchors).

<a name="domain-json-placeholders"></a>
### `domain.json`'s placeholders — a DIFFERENT closed set from `steps.json`'s

`{plugin_dir}` · `{reference}` · `{spec}` · `{pass_id}`

This file's `command` strings are rendered by the base, not the harness: `{plugin_dir}` is substituted
by a plain string replace when the base splices your profile in, and `{reference}`, `{spec}`,
`{pass_id}` are substituted by the base's own checklist renderer (Python `str.format()`) when your
entry is next up. That renderer **raises on any other name** — so `{workspace}` and `{image}`, legal in
`steps.json`/`gates.json`, would crash it. Use this set here, not the other one; `doctor` refuses either
file for using the other's placeholder, naming which set applies.

`domain.json` rows carry no `actor` field, so `doctor` classifies each by its own leading token: a path
form or a known interpreter (`python3 python node bash sh`) is a **command row** and gets
shell-metacharacter refusal; anything else is a **prose instruction row** the base's checklist never
executes as an argv, so its punctuation is not a hazard and it is not held to the `argv[0]` rule either
— there is no `actor` key here for a finding to suggest setting to `"agent"`. Both kinds still have
their placeholders checked against the set above. This is exactly how the cookbook's own `interiors`
example is a mix: `interiors-contract-read` and `interiors-scale-cues` are prose (the second contains
parentheses, which is fine — it is not a command row), while `interiors-manifest` and
`interiors-spec-augmentation` are `python3`-led command rows.

## `steps.json` — contributed steps, ordered among themselves

```json
[
  {
    "id": "interiors-contract-read",
    "title": "Read the interior intake contract completely",
    "actor": "agent",
    "command": "Read {plugin_dir}/grimoire/intake/interior_contract.md completely",
    "after": []
  }
]
```

| field | notes |
|---|---|
| `id` | unique across all active plugins |
| `title` | human-readable |
| `actor` | `program` (default) · `agent` · `human`. Unknown values are refused, not defaulted |
| `command` | see placeholders below |
| `after` | array of step ids; **may name another plugin's step**. A cycle or unknown ref is a `doctor` error |

### `actor`

| `actor` | meaning | `argv[0]` rule | returned as |
|---|---|---|---|
| `program` | executable | must be a path form, or one of `python3 python node bash sh` — a bare word is refused | `argv` array |
| `agent` | an instruction to the model | not applicable, nothing is executed | `instruction`, **no `argv` key at all** |
| `human` | an instruction to a person | not applicable | `instruction` |

Set `actor` explicitly on every prose row. `program` is the default, and a prose sentence handed to an
executor is how `Read the contract` once resolved to `/usr/bin/read` and exited 0 — a silent success
that looked like a completed step.

### Placeholders — a closed set, and it is `steps.json`/`gates.json`'s OWN set

`{plugin_dir}` · `{workspace}` · `{image}` · `{spec}`

Anything else, including any `<…>` pseudo-placeholder, fails `doctor`. `{plugin_dir}` is substituted per
token; `{workspace}`, `{image}` and `{spec}` are left as their own single argv elements for the caller
to replace by value — never as a shell string, and never through a shell. Shell metacharacters in any
step or gate command are refused.

**This is not the only placeholder set in the ecosystem — it is the harness's.** `domain.json` renders
its commands through the base's own checklist, not the harness's tokeniser, and has a different closed
set: see [below](#domain-json-placeholders). A placeholder legal in one file and used in the other
fails `doctor`, naming that file's own valid set — never the other file's.

## `gates.json` — blocking verdicts

```json
[
  {
    "id": "interiors-scale-plausible",
    "command": "python3 {plugin_dir}/tools/scale_plausibility.py --spec object-sculpt-spec.json",
    "blocking": true,
    "after": []
  }
]
```

One verdict envelope on stdout:

```json
{
  "kind": "img2.gate-verdict",
  "version": 1,
  "gate": "interiors-scale-plausible",
  "plugin": "interiors",
  "status": "pass",
  "reasons": [],
  "evidence": {}
}
```

| exit | meaning |
|---|---|
| `0` | pass |
| `1` | fail — gate evaluated, verdict negative |
| `2` | error or refused — could not evaluate |

`reasons` must be non-empty when `status` is not `pass`. **A malformed envelope is an `error`, not a
pass** — the rule that keeps a broken gate from reading as green. `img2_core.gate_runner` aggregates
envelopes and stops the workflow on a blocking fail.

**The envelope's `status` and the exit code must agree.** A gate printing `status: "pass"` and exiting
`1`, or `status: "fail"` and exiting `0`, is downgraded to `error` — the runner checks
`returncode != EXPECTED_EXIT[status]` and does not take your word for either half.

Test through the real runner, not by calling your tool directly:

```bash
python3 -m img2_core.gate_runner --plugin-dir <your repo> --workspace <tmp>
```

The runner itself prints one more envelope after every gate has run, aggregating all of them:

```json
{ "kind": "img2.gate-run", "version": 1,
  "results": [ { "gate": "interiors-scale-plausible", "status": "pass", "blocking": true, "exitCode": 0, "reasons": [] } ],
  "stopped": false }
```

Runner exit: `0` nothing blocking failed, `1` a blocking gate failed or errored (`stopped: true`, the
skipped gates after it are recorded with `status: "skipped"`), `2` the runner itself could not evaluate
anything (malformed `gates.json`, a cycle) — in which case `results` is empty and a top-level `error`
string explains why.

**When your gates actually run — LIVE**, not merely declared: `plugin-gates` is a base-owned
`FINAL_STEPS` checklist row (`python3 forge/stage3_build/run_gates.py --workspace .`, right after the
emission-target step), executed from a normal pipeline run, not just from the command above. It runs
your gates when either clause of the participation rule holds: (i) you are the registry-derived owner
of the resolved domain profile (your `domain.json`'s own `id`, read from `$IMG2_HOME/plugins/<your-id>/
domain.json` — never assumed from a name match) and at least one of its contributed steps is marked
done; or (ii) you are the plugin recorded as the selected emission target. A plugin that contributed no
step under either clause runs no gates. It runs every involved plugin's gates through the exact same
`img2_core.gate_runner` invocation the command above uses (the argv is drift-guarded against
`img2.mjs`'s own `gateRunnerArgv`), and a blocking failure from any one of them stops the whole
`plugin-gates` run, naming the gate and the plugin.

<a name="provides"></a>
## `provides` — declaring an emission target

Not a domain, and not the ordinary capability edge in [Scenario 10](03-cookbook.md#scenario-10): an
emission target is a terminal, whole-file transform of the already-validated sculpt spec, selected only
by an explicit `--target <kind>` request — never invoked merely because you are installed. See
[Scenario 12](03-cookbook.md#scenario-12) for the worked example (`plugin-sculpt-echo`); this is the
field-by-field reference.

```json
{
  "id": "emit-echo",
  "title": "…",
  "actor": "program",
  "command": "python3 {plugin_dir}/tools/emit_echo.py --spec {spec} --workspace {workspace}",
  "after": [],
  "provides": {
    "version": 1,
    "from": "sculpt-spec",
    "to": "echo",
    "artifact": { "kind": "echo", "path": ".img2/artifacts/<your-plugin-id>/echo.json" }
  },
  "deterministic": true
}
```

| field | notes |
|---|---|
| `provides.version` | the target-contract version this row is written against, independent of the harness's own `CONTRACT_REVISION`. Refused if newer than this harness reads, naming both |
| `provides.from` | MUST be `"sculpt-spec"` — this is what makes the manifest edge a **target edge** rather than an ordinary capability |
| `provides.to` | the target kind, matched against a `plugin.json` capability edge of the same `{from, to}` |
| `provides.artifact.kind` | your artifact's declared kind — verified by container check where the base has a prober (`glb` today), else by existence/size/location alone, with the limit stated in the result |
| `provides.artifact.path` | **the FULL workspace-relative path, already prefixed with `.img2/artifacts/<your-plugin-id>/`** — not a bare filename relative to that directory. Get this wrong and `doctor` names exactly what it must resolve under |
| `deterministic` | **sibling of `provides`, not nested inside it.** Required boolean. `true` → verified once per `(resolvedSha, spec content hash)` by double-invocation, then cached — no flag exists to skip this. `false` is legal (a hosted generative exporter genuinely may not reproduce) and forfeits the byte check, recorded in provenance instead |
| `timeoutSeconds` | optional sibling of `provides`; overrides the 300s default, capped at 1800s — refused before invocation if declared over the cap |

**Manifest ↔ step cross-validation**, `doctor`-checked at install time: a manifest target edge with no
step providing it, or a step providing a kind no manifest edge declares, each FAILs naming the plugin
and the missing half. Two steps in one plugin providing the same kind FAILs naming both. A providing
step that is not terminal — something else in the merged step order runs after it — FAILs naming it and
what runs after.

**`doctor` checks `deterministic` and `timeoutSeconds` too**, at install time, matching the base's own
target reader's rules exactly (`forge/_shared/targets.py`) — a missing `deterministic` or a non-positive
`timeoutSeconds` FAILs `doctor` naming which. The base re-validates both again at selection time (the
registry can drift after `doctor` last ran), so the two are never the only place either check runs, but
neither can disagree with the other about what is legal.

**Selection, bounds, provenance and the warranty boundary** are the base's own obligations, not this
file's schema — see `PLUGIN_CONTRACT.md`'s emission-target-contract section for the full normative
statement (bounds table, determinism verification, deprecation path).

## Tools — the bootstrap stanza, and what `doctor` greps for

Every tool opens with this stanza **verbatim** (contract §8). Copy it from
`plugin-hello-cube/tools/emit_cube.py` rather than retyping it:

```python
import os, sys
root = os.environ.get("IMG2_HOME")
if root: sys.path.insert(0, os.path.join(root, "harness"))
else:
    try: import _img2_local; sys.path.insert(0, _img2_local.CORE)
    except ImportError: sys.exit("img2: core not linked - run `img2 sync`")
from img2_core import require_core_api
require_core_api(1)
```

After it you have `img2_core`:

```python
from img2_core import state as core_state
from img2_core.paths import resolve_workspace

ws = resolve_workspace(args.workspace)
core_state.update_plugin_state(ws, PLUGIN_ID, lambda s: {**s, "lastRun": stamp})
```

Static rules `img2 doctor` enforces by grep — a violation fails the audit, it does not warn:

| Rule | Why |
|---|---|
| **stdlib only** in `tools/` | third-party is allowed only behind a lazily-imported, documented network or live path — never on the probe or test path |
| **no `Path(__file__).parents[N]`** root computation | it breaks the moment the plugin is linked rather than cloned |
| **never import another plugin** | there is no plugin-to-plugin API; hand off through an artifact |
| **never import harness internals beyond `img2_core`** | everything else is private and will move |
| **state mutations only through `update_plugin_state`** | the lock must be held across the whole read-modify-write |
| **outputs to `<workspace>/.img2/artifacts/<plugin-id>/`** | a per-plugin subdirectory, so two plugins cannot collide |
| **never write into any checkout** | that is somebody's git working tree |

## `SKILL.md`

YAML frontmatter plus a body. The **`description` is the only thing in the model's context at session
start**, so it decides whether your plugin is ever found. Write it as a trigger — what it does plus
when to use it, in concrete nouns:

```markdown
---
name: img2-glb2threejs
description: Converts a GLB mesh into procedural Three.js code. Use when the user has a .glb file and wants editable Three.js geometry.
---
Body: the exact commands the model should run.
```

Commands in the body use the **`$SKILL_DIR` convention** — an absolute tool path, with the user's
project as the workspace:

```bash
python3 "$SKILL_DIR/tools/my_tool.py" --image <path/to/image> --workspace "$PWD"
```

State in the body that `$SKILL_DIR` is the directory containing that `SKILL.md`. A bare relative path
(`python3 tools/my_tool.py`) **fails**: the model runs commands from the user's project, where `tools/`
does not exist.

## `spec-augmentation-v1` — the pulled artifact

Three partitions, three authority rules:

| partition | rule |
|---|---|
| `specSections` | refused if the key is in `BASE_OWNED`. A section base orchestration reads must be validated against what the base implements, not admitted opaquely |
| `assessmentPatch` | merged into `preSpecAssessment`; **refused** if it sets `objectClass.domain` |
| `qualityFloors` | **raise-only.** Numbers clamp to the max and the attempt is recorded; tiers move only stricter; unknown keys refused |

`BASE_OWNED` = `qualityContract` · `preSpecAssessment` · `pipelineRouting` · `sourceImage` ·
`targetName` · `localSpecSearch`

Tier order, loosest → strictest: `simple` → `moderate` → `complex` → `ultra-complex`

Every accepted change is attributed to the provider and version that proposed it.

## Workspace state

| | |
|---|---|
| location | `<workspace>/.img2/state.json` |
| shape | `{version, workspace, plugins: {"<id>": {…}}}` — one subtree per plugin |
| mutation | **only** `img2_core.state.update_plugin_state(workspace, plugin_id, fn)`, which holds the lock across the whole read-modify-write |
| your outputs | `<workspace>/.img2/artifacts/<plugin-id>/` — a per-plugin subdirectory, so two plugins cannot collide |
| cross-plugin | files under `<workspace>/.img2/artifacts/` with declared `kind` identifiers — never shared mutable state |
| `--workspace` | tools take it, defaulting to cwd — **never** the skill or checkout root |

A separate load → mutate → save with the lock held only at save is a lost-update bug, and the contract
names it as one. The base pipeline must not write this file at all.

<a name="refusals"></a>
## Everything the harness refuses

| You do this | Result |
|---|---|
| `overrides` in `plugin.json` | install fails |
| `argv[0]` is a bare word on a `steps.json`/`gates.json` COMMAND row | `doctor` FAILs |
| a `steps.json`/`gates.json` placeholder outside `{plugin_dir} {workspace} {image} {spec}` | `doctor` FAILs |
| a `domain.json` placeholder outside `{plugin_dir} {reference} {spec} {pass_id}` (its OWN, different set) | `doctor` FAILs |
| a `<…>` pseudo-placeholder | `doctor` FAILs |
| a shell metacharacter in a COMMAND row (any file) | refused |
| a shell metacharacter in a PROSE instruction row (`actor: agent`/`human`, or `domain.json` prose) | **not** refused — it is not executed, and this is deliberate |
| unknown `actor` | refused, not defaulted |
| `after` names an unknown step, or forms a cycle | `doctor` error — never a guessed order |
| `setupSteps` without `setupAnchorBefore` | registry error, `doctor` FAILs |
| an anchor naming a base step that does not exist | fails loud, naming the anchor |
| an unknown key in `domain.json` | registry error, `doctor` FAILs |
| a `spec_search_profile.json` path escaping the plugin's own directory | `doctor` FAILs |
| a `provides` object with a bad shape, a `version` newer than this harness reads, or an `artifact.path` outside `.img2/artifacts/<plugin-id>/` | `doctor` FAILs |
| a target-providing step missing `deterministic`, or a non-boolean value | `doctor` FAILs |
| a target-providing step's `timeoutSeconds` that is not a positive integer | `doctor` FAILs |
| a manifest target edge with no providing step, or vice versa | `doctor` FAILs, naming the missing half |
| two steps in one plugin providing the same target kind | `doctor` FAILs, naming both |
| a providing step that is not terminal in the merged step order | `doctor` FAILs, naming what runs after it |
| a declared file that does not exist | `doctor` FAILs |
| `_img2_local.py` not covered by `.gitignore` | `doctor` FAILs |
| two plugins declare the same typed edge | resolution refuses; never broken by install order |
| several capabilities in one plugin | WARN naming the plugin and its count — not an error |
| import `forge.*` from plugin tools | static boundary grep fails |
| a `requires` floor the installed harness does not meet | **blocks** at `img2 add` and `img2 sync` |
| a `requires` range that is not `>=X.Y.Z` | does not parse |
| a non-stdlib import in `tools/` on the probe or test path | `doctor` FAILs |
| `Path(__file__).parents[N]` root computation | `doctor` FAILs |
| importing another plugin, or a harness internal beyond `img2_core` | `doctor` FAILs |
| gate envelope `status` disagreeing with the exit code | downgraded to `error` |
| `assessmentPatch` sets `objectClass.domain` | merge refuses |
| `qualityFloors` lowers a floor | clamped to the base value, attempt recorded |
| `specSections` carries a `BASE_OWNED` key | merge refuses, naming the key |
| gate prints a malformed envelope | `error`, not a pass |
| write outside your own `state.json` subtree | contract violation |
| generated index out of sync | `img2 sync --check` exits non-zero |
| install from outside the default org | needs `--allow-any-source`, which prints what it will clone |

## Checklist for a new plugin

- [ ] `plugin.json` with a typed `capabilities` edge and a `requires` floor
- [ ] Every step and gate passes `img2 doctor` with zero findings
- [ ] `actor` set explicitly on every prose row — never rely on the `program` default
- [ ] No import of `forge.*` anywhere in `tools/`
- [ ] Tools take `--workspace`, defaulting to cwd — never the checkout root
- [ ] State mutation goes through `update_plugin_state`, not load → mutate → save
- [ ] Cross-plugin handoff is a declared-`kind` file in `artifacts/`, not shared state
- [ ] Own test suite passes **standalone**, without the base test tree
- [ ] A `test_suite_integrity.py` asserting the **collected** count against a recorded floor — a single
      indentation error once silently dropped three tests, and only counting caught it
- [ ] If you raise floors, verify each change is recorded with the provider and version
- [ ] With the plugin **absent**, the base still completes generically, and an explicit request for your
      domain fails loud naming the missing provider
- [ ] If you declare an emission target: `provides.artifact.path` is the FULL path already prefixed
      with `.img2/artifacts/<your-plugin-id>/`, `deterministic` is declared beside `provides` (not
      inside it), and installing you with no `--target` selected changes not one byte of the default
      output ([Scenario 12](03-cookbook.md#scenario-12))

## Verifying end to end

```bash
img2 add --link ./my-plugin      # develop against a local checkout, no clone
img2 doctor                      # expect: ok (N plugins, 0 warnings)
img2 sync --check                # generated index in sync; non-zero on drift

# the base must still pass with NO plugins installed:
IMG2_HOME=$(mktemp -d) python3 -m unittest discover -s forge/tests -p 'test_*.py'
```

Two measurement rules, both learned by getting them wrong:

- **Assert `collected`, never the run count.** The run/skipped split depends on which optional
  toolchains are present, so the same tree yields different splits on different machines. Collected is a
  property of the tree.
- **Never read a test's own stdout as a verdict.** A test exercising a failure path prints its own
  `FAILED:` line at column 0. Anchor on `Ran N tests` and the line after it, or use the exit code.

<a name="gaps"></a>
## Known gaps

1. ~~Pass-id authority — a live gate bypass. The permitted pass-id set is *defined* in the validator and
   that definition is its only occurrence; nothing checks a spec's `passOrder`/`buildPasses` against
   it.~~ **Closed.** `VALID_PIPELINE_PASS_IDS` gained its first consumers in `validate_sculpt_spec.py`'s
   `buildPasses` and `passOrder` validators (`pass-identifier-authority`, lead-verified, both gate
   states green). A pass named outside the base's set is now refused, not silently accepted.
   **Residual, deferred as hygiene, not a bypass:** `VISUAL_PASS_IDS` and `VALID_PIPELINE_PASS_IDS` are
   two separate sets. Renaming a genuinely-visual pass to a legal-but-non-visual id still validates
   while silently dropping its render/comparison/vision gate — closing *that* needs the
   `VISUAL_PASS_IDS`/`DEFAULT_PASS_ORDER` dedup this capability deferred, not a new mechanism.
2. ~~No contract clause binds the base from importing plugin code.~~ **Closed.** `PLUGIN_CONTRACT.md`'s
   emission-target-contract change states the prohibition normatively (currently under its DRAFT
   section, pending the `## 15.`/`## 16.` renumbering coordination) — the base SHALL NOT import, load,
   or bind plugin code into its own process, and the permitted direction (a plugin importing a declared
   base helper — `img2_core`) is stated alongside it.
3. ~~A domain whose emitter output differs structurally has no declared mechanism.~~ **Closed.** This is
   exactly what the emission target contract is: a plugin can now declare a terminal, whole-different-
   *class* export (`provides`, `sculpt-spec -> <kind>`), selected explicitly via `--target`, verified to
   the base's own stated limit. See [`provides`](#provides) above and [Scenario 12](03-cookbook.md#scenario-12).
4. **`overrides` has no mechanism**, so there is no supported way to replace a base step or gate. See
   [Scenario 4](03-cookbook.md#scenario-4). Untouched by the emission target contract: nothing here
   replaces anything, it only adds a new terminal output alongside the existing one.
5. **Reference-asset rules straddle the boundary.** The GLB probe and node-labeller are base tools while
   subject-specific GLB pipelines are not; ownership of the `no-baseline-assets` rule is unassigned. If
   your plugin consumes an external mesh, read that rule first.
