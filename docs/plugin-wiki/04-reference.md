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
| `name` | the plugin id; also the directory name under `$IMG2_HOME/plugins/` |
| `capabilities` | array of typed edges `{from, to}`. **The only thing resolution matches on.** Several edges draws a `doctor` WARN, not an error |
| `requires` | compatibility floor: `harness` semver range, `coreApi` integer |
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

### Placeholders — a closed set

`{plugin_dir}` · `{workspace}` · `{image}`

Anything else, including any `<…>` pseudo-placeholder, fails `doctor`. `{plugin_dir}` is substituted per
token; `{workspace}` and `{image}` are left as their own single argv elements for the caller to replace
by value — never as a shell string, and never through a shell. Shell metacharacters in any step or gate
command are refused.

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
| cross-plugin | files in `<workspace>/.img2/artifacts/` with declared `kind` identifiers — never shared mutable state |
| `--workspace` | tools take it, defaulting to cwd — **never** the skill or checkout root |

A separate load → mutate → save with the lock held only at save is a lost-update bug, and the contract
names it as one. The base pipeline must not write this file at all.

<a name="refusals"></a>
## Everything the harness refuses

| You do this | Result |
|---|---|
| `overrides` in `plugin.json` | install fails |
| `argv[0]` is a bare word on a `program` row | `doctor` FAILs |
| a placeholder outside `{plugin_dir} {workspace} {image}` | `doctor` FAILs |
| a `<…>` pseudo-placeholder | `doctor` FAILs |
| a shell metacharacter in any step or gate command | refused |
| unknown `actor` | refused, not defaulted |
| `after` names an unknown step, or forms a cycle | `doctor` error — never a guessed order |
| `setupSteps` without `setupAnchorBefore` | registry error |
| an anchor naming a base step that does not exist | fails loud, naming the anchor |
| an unknown key in `domain.json` | registry error |
| a declared file that does not exist | `doctor` FAILs |
| `_img2_local.py` not covered by `.gitignore` | `doctor` FAILs |
| two plugins declare the same typed edge | resolution refuses; never broken by install order |
| several capabilities in one plugin | WARN naming the plugin and its count — not an error |
| import `forge.*` from plugin tools | static boundary grep fails |
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

1. **Pass-id authority — a live gate bypass.** The permitted pass-id set is *defined* in the validator
   and that definition is its **only occurrence**. Nothing checks a spec's `passOrder` or `buildPasses`
   against it — only their self-consistency. Pass ids are the keys the base's visual gates are indexed
   by, so a pass named outside the base's set silently loses its render, comparison and vision gate.
   **Until this is closed, do not name a pass outside the base's set — it will look like it works.**
2. **No contract clause binds the base** from importing plugin code. The only `MUST NOT import` clause
   binds plugin tools and `img2_core`.
3. **A domain whose emitter output differs structurally** — one needing the base to emit a different
   *class* of object rather than different values — has no declared mechanism yet.
4. **`overrides` has no mechanism**, so there is no supported way to replace a base step or gate. See
   [Scenario 4](03-cookbook.md#scenario-4).
5. **Reference-asset rules straddle the boundary.** The GLB probe and node-labeller are base tools while
   subject-specific GLB pipelines are not; ownership of the `no-baseline-assets` rule is unassigned. If
   your plugin consumes an external mesh, read that rule first.
