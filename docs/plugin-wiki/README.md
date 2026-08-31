# img2threejs plugin wiki

`img2threejs` is a plugin host. These pages cover why, how, and — mostly — how to write one.

| page | read it when |
|---|---|
| [01 — Why, and what changed](01-why.md) | you want the motivation, or you are worried something was taken away |
| [02 — How it works](02-how-it-works.md) | you need the architecture: resolution, splicing, the merge, the boundaries |
| [03 — Cookbook](03-cookbook.md) | **you are building something.** Twelve worked scenarios, each with real files |
| [04 — Reference](04-reference.md) | every field, every refusal, and the known gaps |

`PLUGIN_CONTRACT.md` is normative. Where a wiki page and the contract disagree, the contract wins.

## Start here: nothing was taken away

**If you use the base skill on its own, it does everything it did before.** Plugins are additive. There
is no reduced mode, no "community edition", no capability that got moved behind an install.

| | before | now, base alone |
|---|---|---|
| Reconstruct an arbitrary object from a reference image | yes | yes |
| The 21-step frame: intake → spec → build → review → rig | yes | yes |
| Strict spec validation, visual gates, correction loops with ceilings | yes | yes |
| Multi-angle review, detail inventory, material evidence | yes | yes |
| A **generic** (non-domain) object passes strict validation | **no — this was broken** | **yes** |

That last row is the one worth pausing on. The refactor did not trade capability for modularity; the
generic path did not exist before and now does. Previously every non-character kind fell through to the
weapon track, and that track failed strict validation unless the spec carried a domain marker — so a
plain hammer could not be built without pretending to be something it wasn't.

**What a plugin adds** is subject-specific rigour on top of the same frame: a declared intake contract
instead of an inference, a domain-specific blocking gate, a stricter quality floor, and reference
material the model reads before it starts. Same pipeline, better informed.

**What a plugin can never do** is make the frame looser. It cannot remove a gate, lower a floor,
reorder base steps, or substitute a base command. See [§ Changing behaviour](03-cookbook.md#scenario-4)
for what to do when that is what you were reaching for.

## Quick start

```bash
img2 add img2threejs/plugin-hello-cube    # the smallest complete example
img2 doctor                                # expect: ok (N plugins, 0 warnings)
img2 add --link ./my-plugin                # develop against a local checkout, no clone
```

Then read [the cookbook](03-cookbook.md) — it is organised by what you are trying to do, not by which
file a field lives in.
