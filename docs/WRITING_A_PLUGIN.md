# Writing an img2 plugin

The fastest path: **copy `plugin-hello-cube`** — it is the reference implementation and
exercises every surface of the contract. This guide explains what each piece is for.
The contract (`docs/PLUGIN_CONTRACT.md`) is normative; where this guide and the contract
disagree, the contract wins.

This is the linear path through a **first** plugin. It deliberately does not repeat the field-by-field
rules — those live once, in [`plugin-wiki/04-reference.md`](plugin-wiki/04-reference.md), so they cannot
drift between two documents. Once you have a plugin working, [`plugin-wiki/`](plugin-wiki/README.md)
covers what this guide does not: adding a whole domain, placing a step relative to a base pipeline
step, and what to do when you want to override a gate.

## 0. Prerequisites

```bash
npx github:img2threejs/img2 install     # once per machine
```

## 1. Repo layout

One plugin = one git repo:

```
plugin.json        # manifest — required
SKILL.md           # what the coding agent reads — required
tools/             # CLI tools, Python ≥3.10 STDLIB ONLY
reference/         # optional routed reference markdown
tests/             # python3 -m unittest discover -s tests
gates.json         # quality gates you contribute (optional)
steps.json         # workflow steps you contribute (optional)
.gitignore         # MUST ignore _img2_local.py
```

## 2. plugin.json

```json
{
  "schema": 1,
  "name": "glb2threejs",
  "version": "0.1.0",
  "description": "One line. Shown in `img2 list` and the generated index.",
  "capabilities": [{ "from": "glb", "to": "threejs-code" }],
  "requires": { "harness": ">=0.1.0", "coreApi": 1 }
}
```

Two things that catch people: `name` also becomes the host link suffix, so you do not choose the
link name; and a `requires` floor the installed harness does not meet **blocks** the install rather
than warning. Field-by-field: [`plugin-wiki/04-reference.md`](plugin-wiki/04-reference.md#pluginjson--the-only-required-file).

## 3. SKILL.md

YAML frontmatter + body. The **description is the only thing in the model's context at
session start** — it decides whether your plugin gets found. Write it as a trigger:
what the plugin does + when to use it, concrete nouns ("Converts a single image into a
GLB 3D mesh… use when the user asks to turn an image into a GLB/3D mesh").

```markdown
---
name: img2-glb2threejs
description: Converts a GLB mesh into procedural Three.js code. Use when the user has a .glb file and wants editable Three.js geometry.
---
Body: exact commands the model should run.
```

Commands in the body MUST use the `$SKILL_DIR` convention — an absolute tool path plus
the user's project as the workspace:

```bash
python3 "$SKILL_DIR/tools/my_tool.py" --image <path/to/image> --workspace "$PWD"
```

State in the body that `$SKILL_DIR` is the directory containing that SKILL.md. A bare
relative path (`python3 tools/my_tool.py`) fails: the model runs commands from the user's
project, where `tools/` does not exist. `plugin-hello-cube/SKILL.md` is the reference.

## 4. Tools

Every tool starts with the exact bootstrap stanza from contract §8 (copy it from
`plugin-hello-cube/tools/emit_cube.py`). After the stanza you have `img2_core`:

```python
from img2_core import paths, state
ws = paths.resolve_workspace(args.workspace)
state.update_plugin_state(ws, "glb2threejs", lambda s: s.update(lastRun=...) or s)
```

Rules enforced statically by `img2 doctor` — violations fail the audit:

- stdlib only in `tools/` (third-party allowed only behind a lazily-imported,
  clearly-documented network/live path, never on the probe/test path);
- no `Path(__file__).parents[N]` root computation;
- never import another plugin, never import harness-internal modules beyond `img2_core`;
- state mutations only through `update_plugin_state` (lock held across read-modify-write);
- outputs go to `<workspace>/.img2/artifacts/<plugin-id>/`, state to your own subtree —
  never write into any checkout.

## 5. Gates (gates.json)

```json
[{ "id": "my-gate", "command": "python3 {plugin_dir}/tools/gate_my.py --workspace {workspace}", "blocking": true, "after": [] }]
```

A gate prints ONE verdict envelope on stdout and exits 0 (pass) / 1 (fail) / 2 (error):

```json
{ "kind": "img2.gate-verdict", "version": 1, "gate": "my-gate", "plugin": "glb2threejs",
  "status": "pass", "reasons": [], "evidence": {} }
```

Test through the real runner, never by calling your tool directly:
`python3 -m img2_core.gate_runner --plugin-dir <your repo> --workspace <tmp>`.

The envelope rules — status and exit code must agree, `reasons` non-empty when not `pass`, a malformed
envelope is an `error` and not a pass — are in
[`plugin-wiki/04-reference.md`](plugin-wiki/04-reference.md#gatesjson--blocking-verdicts).

## 6. Steps (steps.json)

```json
[{ "id": "convert", "title": "Convert GLB to Three.js code", "command": "python3 {plugin_dir}/tools/convert.py --glb {glb} --workspace {workspace}", "after": [] }]
```

`after:` may reference another plugin's step id; the harness topo-sorts across all
active plugins and refuses cycles/unknown refs at `img2 doctor`.

`after` orders your steps against other *contributed* steps. It cannot place a step relative to a
**base pipeline** step — that needs a domain profile's anchor, which is a different mechanism. Set
`actor` explicitly on any row that is prose rather than a command. Both, plus the closed placeholder
set: [`plugin-wiki/04-reference.md`](plugin-wiki/04-reference.md#stepsjson--contributed-steps-ordered-among-themselves)
and [scenario 2](plugin-wiki/03-cookbook.md#scenario-2).

## 7. Tests

Plain unittest, no network, fixtures generated in-test. The house pattern for reaching
`img2_core` (from `plugin-hello-cube/tests/`): create a temp `$IMG2_HOME`, symlink
`harness -> <local img2 checkout>` inside it, run your tools as real subprocesses with
`env IMG2_HOME=<temp>`. Minimum coverage: tool determinism/happy path, gate pass AND
fail envelopes with correct exit codes, one end-to-end run through
`python3 -m img2_core.gate_runner`.

## 8. Local development loop

```bash
img2 add --link ~/src/plugin-glb2threejs   # symlink your checkout, no clone
img2 doctor                                 # static audit — must be clean
img2 sync --check                           # generated index matches your manifest
# iterate; edits are live because the clone is a symlink
img2 remove glb2threejs                     # when done
```

## 9. Publishing

1. Tag a semver release (`git tag -a v0.1.0 && git push --tags`) — `img2 add` resolves
   the newest tag by default and pins the SHA. An untagged repo installs from the default
   branch HEAD with a warning; don't ship that.
2. Add the GitHub topic **`img2threejs-plugin`** — topic search is the ecosystem's only
   registry.
3. Repos outside the `img2threejs` org install only with `--allow-any-source` — that is
   the trust boundary, not a bug. If the plugin belongs in the org, propose a transfer.

## 10. Pre-submit checklist (mirrors `img2 doctor`)

- [ ] `plugin.json` schema 1, honest `requires`
- [ ] SKILL.md description written as a trigger; commands use `--workspace .`
- [ ] Bootstrap stanza verbatim; no parents[N]; no cross-plugin imports; stdlib-only tools
- [ ] `.gitignore` covers `_img2_local.py`
- [ ] Gates emit the envelope; exit codes agree with status
- [ ] `python3 -m unittest discover -s tests` green with no network
- [ ] `img2 add --link` + `img2 doctor` + `img2 sync --check` all exit 0
