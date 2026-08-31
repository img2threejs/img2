# img2threejs Plugin Wiki

Why the skill was refactored this way, how it works, how to write a plugin, how to change the
frame's behaviour, and what the frame refuses.

Single-page build of `docs/plugin-wiki/` — the wiki is the source, this is generated.

| page | read it when |
|---|---|
| [01 — Why, and what changed](#why-and-what-changed) | you want the motivation, or you are worried something was taken away |
| [02 — How it works](#how-it-works) | you need the architecture: resolution, splicing, the merge, the boundaries |
| [03 — Cookbook](#cookbook) | **you are building something.** Twelve worked scenarios, each with real files |
| [04 — Reference](#reference) | every field, every refusal, and the known gaps |

`PLUGIN_CONTRACT.md` is normative. Where a wiki page and the contract disagree, the contract wins.

### Start here: nothing was taken away

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
reorder base steps, or substitute a base command. See [§ Changing behaviour](#scenario-4)
for what to do when that is what you were reaching for.

### Quick start

```bash
img2 add img2threejs/plugin-hello-cube    # the smallest complete example
img2 doctor                                # expect: ok (N plugins, 0 warnings)
img2 add --link ./my-plugin                # develop against a local checkout, no clone
```

Then read [the cookbook](#cookbook) — it is organised by what you are trying to do, not by which
file a field lives in.

---

## Why, and what changed

### The problem: fused, not layered

The skill and its first subject area were not layered — they were **fused**. Four concrete symptoms:

**A pipeline picked itself from a filename.** Domain recognition matched the target's *name*. A file
called `karambit-doppler.png` selected one pipeline; `kitchen-knife.png` selected another. Name
similarity is now explicitly banned as a resolution input precisely because it fails silently and
cannot be reasoned about.

**There was no generic path.** Every non-character kind fell through to the weapon track, and that track
failed strict validation unless the spec carried a domain marker. A plain hammer could not be
reconstructed without pretending to be a CS2 skin. "Generic" was not a working path — it was a hole.

**Base code held domain knowledge it had no business holding.** A bone-track domain set inside the
emitter, a 36-line domain quality gate inside the base validator, and a single conditional keyed on
*two* domain names at once (`elif is_character and is_cs2`). That last one is the shape of the whole
problem: a third domain would not have added a branch, it would have multiplied them.

**One subject area owned 34 files** in a repo meant to serve all of them.

### Why that is a correctness problem, not a tidiness problem

```mermaid
graph TD
    FUSE["Domain fused into the base"] --> C1["Adding a subject area<br/>means editing the shared skill"]
    FUSE --> C2["Every domain's change<br/>risks every other domain's output"]
    FUSE --> C3["No per-domain tests,<br/>versioning, or release cadence"]
    FUSE --> C4["A private subject area<br/>cannot stay private"]
    FUSE --> C5["Conditionals multiply<br/>as domains are added"]
    C5 --> C6["Silent wrong routing:<br/>a branch becomes unreachable<br/>and the run still reports success"]

    classDef bad stroke:#c00,stroke-width:3px
    class C6 bad
```

When two domains are entangled in one conditional, removing either leaves the other **unreachable or
wrongly reached** — and the run still exits 0 with a plausible answer. That is the failure mode that
makes this structural rather than cosmetic.

**Why not a bigger switch statement, or config flags?** Because that is what the combined conditional
already was, and its failure mode is silence. A flag-driven frame grows combinatorially in the number of
domains, and each new combination is a branch nobody tested. A frame that knows *no* domain has one path
to test, and each domain tests itself in its own repo.

### What the refactor buys

| | |
|---|---|
| A subject area is a **repo**, not a patch to a shared file | it can be private, versioned, released on its own cadence |
| The base has **one job** | reconstruct a reference image into procedural TypeScript, knowing no domain |
| With **no plugin** the frame still completes | it infers from the image — a plugin is optional, not load-bearing |
| A plugin can make the frame **stricter or better-informed** | never looser or different |
| Resolution is by **declared typed edge** | no name matching; ambiguity is refused, not guessed |

### What was *not* traded away

See the table in the [index](#start-here-nothing-was-taken-away). The short version: no
capability moved behind an install, and the generic path is strictly better than before — it now exists.

What moved out is **subject-specific knowledge**, and it comes back with one `img2 add`.

### The three decisions the architecture rests on

1. **One entry point.** There is a single base skill. Plugins do not add entry points; they add
   capability to the one that exists.
2. **Each plugin is its own repo**, installed by a single command, with its own tests that pass without
   the base test tree.
3. **The base pulls; a plugin never pushes.** A plugin publishes declarations and artifacts. The base
   reads them at points it chooses. This is what makes "no plugin installed" a working path rather than a
   broken one.

The consequence worth stating plainly: **installing a plugin never changes a pipeline behind your
back.** A plugin adds steps and gates and raises quality floors. It cannot replace or remove anything.
Replacing is a user action, not a plugin action — see
[Scenario 4](#scenario-4).

---

## How it works

Diagram conventions: **solid** = available · **dashed** = coming, do not depend on it yet · **thick
red** = no mechanism or a known gap.

### Repo topology

```mermaid
graph TB
    subgraph harness["img2-harness — the mechanism"]
        CLI["img2 CLI<br/>Node, zero deps"]
        CORE["img2_core<br/>Python 3.10 stdlib, 332 lines<br/>CORE_API = 1"]
        CONTRACT["PLUGIN_CONTRACT.md"]
    end

    subgraph base["img2threejs — the frame"]
        SKILL["SKILL.md — router"]
        FORGE["forge/ — stages 1 to 5"]
        GRIM["grimoire/ — reference pages"]
    end

    subgraph plugins["plugins — one repo each"]
        CS2["plugin-cs2<br/>private"]
        HELLO["plugin-hello-cube<br/>reference example"]
        GLB["plugin-img2glb"]
        CHAR["plugin-character<br/>coming"]
    end

    HOME[("$IMG2_HOME<br/>default ~/.img2")]

    CLI --> HOME
    CORE --> HOME
    CONTRACT -.governs.-> plugins
    CONTRACT -.governs.-> base
    CS2 --> HOME
    HELLO --> HOME
    GLB --> HOME
    CHAR -.-> HOME
    HOME -->|"host links:<br/>claude, codex, opencode"| base

    classDef coming stroke-dasharray: 5 5
    class CHAR coming
```

The harness ships **no domain capability** and the base **names no domain** — so adding a subject area
is adding a repo, not editing two.

### `$IMG2_HOME`, install, and the trust boundary

```
$IMG2_HOME/                  (default ~/.img2)
├── harness/                 the CLI + img2_core, as installed
├── plugins/<name>/          one directory per installed plugin
├── plugins.json             the registry — what is active, and user-owned overrides
├── receipts.json            what was installed, from which ref and sha
└── backups/                 pre-change copies
```

```mermaid
sequenceDiagram
    participant U as User
    participant CLI as img2 CLI
    participant GH as Source
    participant H as $IMG2_HOME
    participant D as doctor

    U->>CLI: img2 add img2threejs/plugin-cs2
    CLI->>CLI: check source against allow-list
    Note over CLI: default allowed: the img2threejs org<br/>anything else needs --allow-any-source<br/>and prints what it will clone
    CLI->>GH: fetch at ref
    GH-->>CLI: plugin.json, steps.json, gates.json,<br/>domain.json, tools/, tests/
    CLI->>CLI: validate manifest schema 1
    Note over CLI: refuses "overrides" in plugin.json
    CLI->>H: write plugins/cs2/ under a harness-owned link name
    CLI->>H: registry row in plugins.json
    CLI->>H: receipt: version, ref, resolvedSha
    CLI-->>U: added cs2 0.1.0
    U->>D: img2 doctor
    D->>H: read every active plugin
    D->>D: validate each step and gate row<br/>through one rowFinding()
    D-->>U: ok (N plugins, 0 warnings)
```

**The threat model, stated honestly in the contract**: a plugin is arbitrary code the agent will later
execute in your workspace. `add` pins (`resolvedSha`), attributes (registry row), and links under a
harness-owned name — *"it cannot make the code safe, only make what runs identifiable and
reproducible."* The harness **never runs plugin tests or imports plugin code** during `add`, `doctor` or
`sync`; validation is static.

`doctor` and the capability query validate rows through **the same function**, `rowFinding()`, so they
cannot drift apart. They once did: the query answered `exit 0` with `problems: []` while handing back a
row whose `argv[0]` was the prose word `Read` — which resolves on a case-insensitive filesystem to
`/usr/bin/read` and exits 0. That silent-success path is why `argv[0]` of a `program` row must be a path
form or one of `python3 python node bash sh`.

### Capability resolution — typed edge, never name

```mermaid
flowchart TD
    START["A run needs capability:<br/>image to interior-scene-spec"] --> SCAN["Scan active plugins<br/>for a matching typed edge"]
    SCAN --> COUNT{"How many<br/>declare it?"}
    COUNT -->|exactly 1| USE["Resolve to that provider"]
    COUNT -->|0| FAIL["FAIL LOUD<br/>error names the missing provider"]
    COUNT -->|"2 or more"| AMBIG["REFUSE<br/>ambiguity is an error,<br/>never resolved by<br/>install order"]

    NAME["A plugin merely NAMED interiors"] -.->|"NOT an input"| SCAN

    classDef bad stroke:#c00,stroke-width:3px
    class FAIL,AMBIG bad
```

No domain at all is a **valid state**, not an error. Only an *explicit* request for a domain with no
provider fails. A provider declaring several capabilities draws a `doctor` WARN naming the plugin and
its count — visible, but not an error.

### The extension surface

```mermaid
graph LR
    subgraph declare["Declarations — static, read by the harness"]
        P1["plugin.json<br/>typed edge + requires floor"]
        P2["steps.json<br/>step rows, ordered by 'after'"]
        P3["gates.json<br/>gate rows"]
        P4["domain.json<br/>domain profile + anchors"]
        P5["spec_search_profile.json<br/>evidence corpus"]
        P10["provides + deterministic<br/>on a steps.json row"]
    end

    subgraph runtime["Runtime — files, never shared mutable state"]
        P6["spec-augmentation-v1<br/>published artifact"]
        P7["workspace/.img2/artifacts/<br/>declared-kind handoff"]
        P8["workspace/.img2/state.json<br/>own subtree only"]
    end

    subgraph knowledge["Knowledge — read by the model"]
        P9["SKILL.md + grimoire/"]
    end

    subgraph frame["Where the frame reads it"]
        F1["capability resolution"]
        F2["step topo-sort"]
        F3["gate_runner, blocking verdicts<br/>LIVE via plugin-gates"]
        F4["domain registry, 2 sources"]
        F5["spec search with content_root"]
        F6["spec authoring — base PULLS"]
        F7["another plugin reads it"]
        F8["img2_core.state, locked"]
        F9["steps with actor: agent"]
        F10["target resolution --<br/>--target only, never by install"]
    end

    P1 --> F1
    P2 --> F2
    P3 --> F3
    P4 --> F4
    P5 --> F5
    P6 --> F6
    P7 --> F7
    P8 --> F8
    P9 --> F9
    P10 --> F10
```

The **domain registry** has exactly two sources: in-repo modules, and installed plugins' `domain.json`
read **through the harness registry** — never by globbing a directory. Ambiguity between the two is
refused rather than resolved by precedence.

### Runtime — one run, three cases

```mermaid
flowchart TD
    IMG(["Reference image"]) --> RESOLVE{"Domain resolution"}

    RESOLVE -->|"no domain requested"| GEN["GENERIC<br/>21 frame steps"]
    RESOLVE -->|"domain requested,<br/>plugin installed"| DOM["DOMAIN<br/>frame + contributed steps and gates"]
    RESOLVE -->|"domain requested,<br/>plugin absent"| MISS["FAIL LOUD<br/>names the missing provider"]

    GEN --> GI["Agent infers from the image:<br/>no declared contract,<br/>no domain gate"]
    DOM --> CI["Plugin contributes:<br/>steps, blocking gates,<br/>domain profile, evidence corpus,<br/>raised quality floors"]

    GI --> OUT(["Procedural TypeScript"])
    CI --> OUT

    classDef bad stroke:#c00,stroke-width:3px
    class MISS bad
```

The two paths that produce output differ in **exactness, not completeness**. Generic finishes — and
preserving that is on you: a plugin that makes the generic path stop working has broken the frame's
first principle.

#### A fourth case, orthogonal to domain resolution: the explicitly-selected emission target

The three cases above answer "how is the object built" — they are about domain resolution, and they
happen once, during the sculpting pipeline. A **target** answers a completely different question,
asked *after* the model already exists: "should this already-built model also be exported as some
other file?" It is not a fourth branch of the `RESOLVE` decision above — it composes with any of the
three. `GENERIC`, `DOMAIN` and `MISS` all still apply to how the TypeScript gets built; a target
selection is an independent axis, applied at the terminal step, regardless of which of the three
produced the model:

```mermaid
flowchart TD
    OUT(["Procedural TypeScript<br/>(from any of GENERIC / DOMAIN / MISS's non-fail outcome)"]) --> SEL{"--target requested?"}
    SEL -->|"no (the default)"| NOOP["No-op: writes nothing<br/>artifact of record = the TypeScript"]
    SEL -->|"yes, kind installed"| RUN["Bounded subprocess:<br/>invoke, verify, provenance"]
    SEL -->|"yes, kind absent or ambiguous"| FAIL["FAIL LOUD<br/>names the kind / all claimants"]

    RUN --> ART(["Produced artifact<br/>+ provenance, never base-gated"])

    classDef bad stroke:#c00,stroke-width:3px
    class FAIL bad
```

Never inferred from installation, domain, filename or spec contents — only an explicit `--target
<kind>` request selects one, and it runs at most once, only once the workspace's terminal readiness
step is recorded. See [Scenario 12](#scenario-12).

### Where a plugin splices in

```mermaid
flowchart LR
    S1["Stage 1<br/>intake"] --> S2["Stage 2<br/>spec"] --> S3["Stage 3<br/>build"] --> S4["Stage 4<br/>review"] --> S5["Stage 5<br/>rig"] --> S6["Final:<br/>emission target"] --> S7["Final:<br/>plugin-gates"]

    PS["setupSteps<br/>setupAnchorBefore"] -.->|"splice AT the anchor"| S1
    PS -.-> S2
    PP["passSteps<br/>passAnchorBefore"] -.->|"every correction pass"| S4
    PA["spec-augmentation"] -.->|base pulls| S2
    AH["admission.json<br/>probe.json"] -.->|"base publishes,<br/>plugin reads"| S1
    TG["provides + deterministic<br/>on a steps.json row"] -.->|"--target only,<br/>never mid-pass"| S6
    GT["gates.json"] -.->|"LIVE: two-clause<br/>participation rule"| S7
```

Splicing inserts your steps **immediately before** the anchored base step. An anchor naming a base step
that does not exist fails loud — the alternative, appending at the end, would put a setup step after the
steps that depend on it. The two terminal slots (`S6`, `S7`) are different: both are base-owned,
appended unconditionally to the base's own final steps — no plugin splices into either the way
`setupSteps`/`passSteps` splice earlier. `S6` runs only when an explicit `--target` is given; on the
default no-target run it is still the checklist step the agent invokes, and its printed statement
naming the artifact of record (`src/createObjectModel.ts`) is what marks that step done, the same way
any other checklist step's own output is read as evidence of completion. `S7` (`plugin-gates`) runs
right after it unconditionally, invoking every involved plugin's `gates.json` under the two-clause
participation rule (Scenario 3, Scenario 12). Step ids to anchor against are listed in
[the cookbook](#anchors).

### The augmentation merge, and every refusal

```mermaid
flowchart TD
    ART(["spec-augmentation-v1<br/>published by the plugin"]) --> MERGE["Merge, executed by BASE code<br/>never delegated to the plugin"]

    MERGE --> SEC["specSections"]
    MERGE --> PATCH["assessmentPatch"]
    MERGE --> FLOOR["qualityFloors"]

    SEC --> SECD{"key in BASE_OWNED<br/>deny-list?"}
    SECD -->|yes| R1["REFUSE, naming the key"]
    SECD -->|no| SECOK["admitted"]
    SECOK --> SECV{"does base orchestration<br/>read this section?"}
    SECV -->|yes| VAL["must be validated against<br/>what the base implements"]
    SECV -->|no| OK1["opaque, admitted"]

    PATCH --> PD{"sets objectClass.domain?"}
    PD -->|yes| R2["REFUSE<br/>only domain resolution sets it"]
    PD -->|no| OK2["merged into preSpecAssessment"]

    FLOOR --> FD{"raises or lowers?"}
    FD -->|raises| OK3["accepted"]
    FD -->|lowers| CLAMP["CLAMP to base value<br/>and RECORD the attempt"]
    FD -->|"tier looser"| R3["retain base tier"]
    FD -->|unknown key| R4["REFUSE"]

    classDef bad stroke:#c00,stroke-width:3px
    classDef warn stroke:#e69,stroke-width:2px
    class R1,R2,R3,R4 bad
    class CLAMP,VAL warn
```

`BASE_OWNED` = `qualityContract`, `preSpecAssessment`, `pipelineRouting`, `sourceImage`, `targetName`,
`localSpecSearch`. **Raise-only is the security property**, stated in the module itself: *a plugin must
never be able to lower the bar it was installed to raise.*

### Boundaries — who may read, import, write

```mermaid
graph TB
    BASE["base skill<br/>forge/"]
    PLUG["plugin<br/>tools/"]
    CORE["img2_core"]
    ART["artifacts"]
    STATE["base pipeline state"]

    PLUG -->|"MAY import<br/>declared base helpers"| BASE
    BASE -->|"PULLS"| ART
    PLUG -->|"publishes"| ART
    PLUG -->|"reads"| ART

    BASE ==>|"MUST NOT import<br/>plugin code"| PLUG
    PLUG ==>|"MUST NOT import forge.*"| BASE
    CORE ==>|"MUST NOT import<br/>plugin code"| PLUG
    PLUG ==>|"MUST NOT write"| STATE

    linkStyle 4,5,6,7 stroke:#c00,stroke-width:3px
```

**Closed — the base-import prohibition is now stated.** Until the emission target contract, the only
`MUST NOT import` clause bound *plugin tools* and *`img2_core`*; none bound the base itself, even
though the thick edge above is the rule the architecture has always assumed. `PLUGIN_CONTRACT.md` now
states it normatively (currently under its DRAFT section, pending the coordinated `## 15.`/`## 16.`
renumbering), alongside the permitted direction (a plugin may import a base helper the contract
declares importable — `img2_core`, today) and the obligations that come with invoking a plugin as a
subprocess (declared input, an env allowlist, untrusted output, bounded execution, no influence over a
base quality check). See [gaps](#gaps).

### Workspace state — one file per owner

```mermaid
graph TB
    subgraph ws["workspace/.img2/"]
        ST["state.json<br/>one subtree per plugin id"]
        AR["artifacts/<br/>declared-kind files"]
    end

    P1["plugin A tools"] -->|"update_plugin_state()<br/>lock held across<br/>read-modify-write"| ST
    P2["plugin B tools"] -->|"own subtree only"| ST
    P1 -->|"writes a declared kind"| AR
    P2 -->|"reads it"| AR
    BASE["base pipeline"] ==>|"MUST NOT write"| ST
    BASE -->|"own checklist authority"| OWN["its own state file"]

    linkStyle 4 stroke:#c00,stroke-width:3px
```

The base pipeline is **not** a plugin: it has no `_img2_local.py`, cannot import `img2_core`, and must
not write `state.json`. Its own delegation record belongs in its own state file.

---

## Cookbook

Organised by what you are trying to do. Every anchor id, field name and file name below is real — the
base pipeline's step ids are listed in [§ Anchors](#anchors) so you can point at them.

| # | I want to… | short answer |
|---|---|---|
| [1](#scenario-1) | add a whole new subject area | a new plugin repo with `domain.json` |
| [2](#scenario-2) | insert a step **before** an existing base step | `setupAnchorBefore` / `passAnchorBefore` |
| [3](#scenario-3) | add a blocking check of my own | `gates.json` + a verdict envelope |
| [4](#scenario-4) | **override / remove a base gate** | you cannot — three things to do instead |
| [5](#scenario-5) | only raise a quality bar, no new code | `qualityFloors` in the augmentation artifact |
| [6](#scenario-6) | run a step in **every correction pass** | `passSteps`, not `setupSteps` |
| [7](#scenario-7) | ship knowledge, not code | an `actor: agent` step + a grimoire page |
| [8](#scenario-8) | contribute reference material to search | `spec_search_profile.json` + `content_root` |
| [9](#scenario-9) | hand data to another plugin | a declared-`kind` file in `artifacts/` |
| [10](#scenario-10) | add a capability the frame has no opinion about | a typed edge + one step |
| [11](#scenario-11) | develop locally / keep it private | `img2 add --link`, a private repo |
| [12](#scenario-12) | declare an emission target — a whole-file export | `provides` + `deterministic` on a `steps.json` row, selected via `--target` |

---

<a name="scenario-1"></a>
### Scenario 1 — Add a whole new subject area: houses & interiors

You reconstruct rooms and furniture. The frame can already build an arbitrary object from an image, but
it has no idea that a room has a floor plane, that a doorway is ~2 m, or that a sofa's seat height is a
strong scale cue. You want those to be a **declared contract** rather than something the model
re-derives every run.

#### The repo

```
plugin-interiors/
├── plugin.json                     required
├── domain.json                     the domain profile: steps + anchors + corpus
├── gates.json                      a blocking scale-plausibility check
├── spec_search_profile.json        your reference corpus
├── steps.json                      (optional — see the note below)
├── SKILL.md                        what the model should know about you
├── grimoire/
│   └── intake/interior_contract.md the page your agent step points at
├── tools/
│   ├── interior_manifest.py
│   ├── emit_spec_augmentation.py
│   └── scale_plausibility.py
└── tests/
    ├── test_manifest.py
    └── test_suite_integrity.py
```

#### `plugin.json`

```json
{
  "schema": 1,
  "name": "interiors",
  "version": "0.1.0",
  "description": "Rooms, built-ins and furniture: room-scale contract, scale-cue extraction, material recipes for architectural surfaces, and a blocking scale-plausibility gate.",
  "capabilities": [
    { "from": "image", "to": "interior-scene-spec" }
  ],
  "requires": { "harness": ">=0.2.1", "coreApi": 1 }
}
```

`capabilities` is the **only** thing resolution matches on. Naming the plugin `interiors` does not make
it resolve for interiors — the typed edge does. Two plugins declaring the same edge is refused, not
ranked.

#### `domain.json` — the part that actually splices into the pipeline

```json
{
  "id": "interiors",
  "setupSteps": [
    ["interiors-contract-read",
     "Read {plugin_dir}/grimoire/intake/interior_contract.md completely before writing the manifest"],
    ["interiors-scale-cues",
     "Identify every scale cue visible in the reference (doorway, step riser, outlet, seat height) and record it in scale-cues.json"],
    ["interiors-manifest",
     "python3 {plugin_dir}/tools/interior_manifest.py {reference} --scale-cues scale-cues.json --admission admission.json --probe probe.json --out interior-intake.json"],
    ["interiors-spec-augmentation",
     "python3 {plugin_dir}/tools/emit_spec_augmentation.py --manifest interior-intake.json --out spec-augmentation.json"]
  ],
  "setupAnchorBefore": "local-spec-search",
  "passSteps": [
    ["interiors-scale-review",
     "python3 {plugin_dir}/tools/scale_plausibility.py --spec object-sculpt-spec.json --manifest interior-intake.json --out interiors-review.json"]
  ],
  "passAnchorBefore": "ai-review-recorded",
  "specCollection": "interiors"
}
```

**Why `local-spec-search` is the right anchor.** Your four steps land immediately *before* it, which
puts them after `reference-admission` (so `admission.json` and `probe.json` exist for your manifest to
read) and before `pre-spec-assessment` and `spec-authoring` (so the assessment sees your contract and
spec authoring can pull your `spec-augmentation.json`). Pick an anchor by asking **what must already
exist** and **what must see your output** — not by where it looks tidy.

The registry validates the profile: unknown keys are refused, and `setupSteps` without
`setupAnchorBefore` is an error. An anchor naming a base step that does not exist **fails loud**:

```
WorkflowStateError: profile 'interiors' anchors a step before unknown base step 'vision-analysis'
```

That is deliberate. The alternative — appending at the end — would put your setup step *after* the
steps that depend on it, and the run would fail somewhere confusing instead of here.

#### `domain.json` vs `steps.json` — which one?

Both contribute steps, and they are not interchangeable:

| | `domain.json` (`setupSteps` / `passSteps`) | `steps.json` |
|---|---|---|
| ordering primitive | `setupAnchorBefore` / `passAnchorBefore` — a **base** step id | `after: [step-id]` — another **contributed** step id |
| positions relative to base steps | **yes** — that is its whole job | no |
| runs only when your domain is resolved | yes | no, it is active whenever the plugin is |
| use it for | subject-specific work that must sit at a precise point in the pipeline | a capability that is not domain-gated |

For a subject area you want `domain.json`. Use `steps.json` when your step should run regardless of
which domain resolved — see [Scenario 10](#scenario-10).

#### What the frame does with it

```mermaid
sequenceDiagram
    participant F as frame
    participant R as domain registry
    participant P as plugin-interiors
    participant S as spec authoring

    F->>R: resolve capability image -> interior-scene-spec
    R-->>F: provider "interiors" (typed edge, one match)
    F->>R: read domain profile
    R-->>F: 4 setupSteps, anchor before local-spec-search
    Note over F: splice at the anchor index<br/>unknown anchor = fail loud
    F->>P: run interiors-contract-read (actor agent)
    F->>P: run interiors-manifest (program)
    P-->>F: interior-intake.json, spec-augmentation.json
    F->>S: author the spec
    S->>P: PULL spec-augmentation.json
    Note over S: merge is executed by BASE code:<br/>deny-list, no domain marker,<br/>floors raise-only
```

#### Verify it before you trust it

```bash
img2 add --link ./plugin-interiors
img2 doctor                    # zero findings, or fix and repeat
python3 -m pytest tests -q     # your suite, standalone, no base test tree

# the important one — the frame must still work WITHOUT you:
IMG2_HOME=$(mktemp -d) python3 -m unittest discover -s forge/tests -p 'test_*.py'
```

That last command is not a formality. A plugin that makes the generic path stop working has broken the
frame's first principle, and it is the single easiest thing to break by accident.

---

<a name="scenario-2"></a>
### Scenario 2 — Insert a step *before* an existing base step

This is the question people ask most, and the answer depends on which "before" you mean.

#### Before a **base** step → `setupAnchorBefore` / `passAnchorBefore`

Splicing is by anchor, and the anchor means *immediately before this base step*.

```json
{
  "id": "interiors",
  "setupSteps": [["interiors-scale-cues", "…"]],
  "setupAnchorBefore": "image-analysis"
}
```

That lands your step before the very first base step. Common anchors and what they buy you:

| you want to run… | anchor |
|---|---|
| before anything else, including the reference read | `image-analysis` |
| after admission, before local search / assessment / authoring | `local-spec-search` |
| right before the spec is authored | `spec-authoring` |
| right before strict validation | `strict-validation` |
| before the AI vision review, on **every** correction pass | `ai-review-recorded` (in `passSteps`) |
| before the pass gate decides, on every pass | `pass-gate-check` (in `passSteps`) |

#### Before another **contributed** step → `after` in `steps.json`

`after` expresses only "after X", so you order your own steps by making the later one depend on the
earlier:

```json
[
  { "id": "my-fetch",   "title": "…", "actor": "program", "command": "…", "after": [] },
  { "id": "my-analyse", "title": "…", "actor": "program", "command": "…", "after": ["my-fetch"] }
]
```

`after` may name **another plugin's** step id — that is supported and is how two plugins cooperate. A
cycle or an unknown reference is a `doctor` error, never a guessed order.

#### What you cannot do

There is **no `before` field** in `steps.json`, and no way for a plugin to make a *base* step depend on
a contributed one. If you need to run before a base step, use the anchor. If the base step you need to
precede is inside a phase you have no anchor into, say so in an issue — do not try to fake it with
ordering tricks.

---

<a name="scenario-3"></a>
### Scenario 3 — Add a blocking check of my own

A gate is a CLI: input by argv, exactly **one** verdict envelope on stdout.

#### `gates.json`

```json
[
  {
    "id": "interiors-scale-plausible",
    "command": "python3 {plugin_dir}/tools/scale_plausibility.py --spec object-sculpt-spec.json --manifest interior-intake.json",
    "blocking": true,
    "after": []
  }
]
```

#### The tool

```python
#!/usr/bin/env python3
"""Refuse a scene whose derived scale contradicts its own scale cues."""
import argparse, json, sys

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--workspace", default=".")     # never the checkout root
    args = ap.parse_args()

    reasons = []
    try:
        spec = json.load(open(args.spec))
        manifest = json.load(open(args.manifest))
    except (OSError, json.JSONDecodeError) as exc:
        # could not evaluate -> error, NOT a fail, NOT a pass
        print(json.dumps({
            "kind": "img2.gate-verdict", "version": 1,
            "gate": "interiors-scale-plausible", "plugin": "interiors",
            "status": "error", "reasons": [f"unreadable input: {exc}"], "evidence": {},
        }))
        return 2

    doorway = manifest.get("scaleCues", {}).get("doorwayHeightM")
    derived = spec.get("sceneScale", {}).get("doorwayHeightM")
    if doorway and derived and abs(derived - doorway) / doorway > 0.15:
        reasons.append(f"doorway height {derived} m contradicts the measured cue {doorway} m by >15%")

    status = "pass" if not reasons else "fail"
    print(json.dumps({
        "kind": "img2.gate-verdict", "version": 1,
        "gate": "interiors-scale-plausible", "plugin": "interiors",
        "status": status, "reasons": reasons,
        "evidence": {"measured": doorway, "derived": derived},
    }))
    return 0 if status == "pass" else 1

if __name__ == "__main__":
    sys.exit(main())
```

Three rules that decide whether your gate is trustworthy:

- **Exit code carries the verdict**: `0` pass, `1` fail (evaluated, verdict negative), `2` error or
  refused (could not evaluate). Do not conflate 1 and 2 — "the check says no" and "the check could not
  run" are different facts, and only the second means your gate is broken.
- **A malformed envelope is an `error`, not a pass.** This is what stops a crashed gate from reading as
  green. Do not add a `try/except` that swallows a failure and prints `pass`.
- **`reasons` must be non-empty when `status` is not `pass`.** A refusal with no reason is unactionable.

`blocking: true` **stops the workflow — LIVE**, executed from the base's own checklist, not merely
declared. `blocking: false` records the verdict and continues either way, so use it while you are still
calibrating.

**When the base runs them.** A `plugin-gates` step is the base's own `FINAL_STEPS` row (right after the
emission-target step), invoked by the agent like any other checklist step:
`python3 forge/stage3_build/run_gates.py --workspace .`. It runs every installed plugin's gates that
are **involved** in the current workspace, under the two-clause participation rule: (i) you contributed
a step to the resolved domain profile (your `domain.json`, owned by your own registry entry — derived
from the registry layout, never assumed from a name match) and at least one of those steps is marked
done; or (ii) you are the plugin recorded as the selected emission target (Scenario 12). A plugin that
contributed no step to either runs no gates. A blocking failure from ANY involved plugin stops the
whole `plugin-gates` run, naming the gate and the plugin that owns it. You can still exercise your own
gates directly before shipping — `python3 -m img2_core.gate_runner --plugin-dir <your repo> --workspace
<tmp>` — but a normal pipeline run now exercises them too.

---

<a name="scenario-4"></a>
### Scenario 4 — "I want to override / remove a base gate"

**You cannot, and this is deliberate.** The reasoning is one sentence: if a plugin could override a
gate, then *installing a plugin could switch off a quality check and nothing would say so.* The contract
states the consequence directly — *"installing or upgrading a plugin therefore never changes a
pipeline."*

| | |
|---|---|
| Plugin replaces a base step or gate | **No** |
| Plugin declares an override about itself or another plugin | **No** — `plugin.json` has no override field and MUST NOT gain one |
| User replaces a step or gate | reserved as `overrides` in `plugins.json` — **not implemented** |
| Harness behaviour today | refuses `overrides` in a plugin manifest; a harness that does not implement the mechanism must FAIL on the key, never proceed as if the pipeline were unmodified |

Even once implemented, two rules are already fixed: an override value is a **reference to an existing
row, never an inline command** (an inline command would bypass the placeholder and metacharacter
checks), and `overrides` is **user-owned data** that any registry-rewriting command must preserve
verbatim and report.

#### What to do instead

Almost every real "I need to override the gate" turns out to be one of these three:

**(a) The base gate is not the check I need → add yours alongside.** Both run. Yours can be stricter,
subject-specific, and blocking. The base gate is not in your way; it is checking something else.

**(b) The base threshold is too lax for my subject → raise the floor.** See
[Scenario 5](#scenario-5). Raise-only, recorded, attributed to your plugin and version.

**(c) The base step improvises badly for my subject → contribute a step with a declared contract.** The
frame defers to a declared contract over its own inference. You are not replacing the step; you are
removing the need for it to guess.

```mermaid
flowchart LR
    WANT["'override the gate'"] --> Q{"what do you<br/>actually need?"}
    Q -->|"a different check"| A["add a blocking gate<br/>-> both run"]
    Q -->|"a stricter threshold"| B["raise qualityFloors<br/>-> raise-only, recorded"]
    Q -->|"better inputs"| C["contribute a step<br/>-> contract beats inference"]
    Q -->|"the gate genuinely must go"| D["a base-skill change,<br/>or a user override.<br/>NOT a plugin."]

    classDef bad stroke:#c00,stroke-width:3px
    class D bad
```

If it really is (d) — the gate must not exist for anyone — that is a change to the base skill. Open an
issue arguing why. Routing around a gate from a plugin is the one thing this architecture is built to
prevent.

---

<a name="scenario-5"></a>
### Scenario 5 — Only raise a quality bar, no new steps or gates

Publish a `spec-augmentation-v1` artifact carrying just `qualityFloors`. The base **pulls** it during
spec authoring; the merge runs in base code and is never delegated to you.

```json
{
  "kind": "spec-augmentation-v1",
  "provider": "interiors",
  "version": "0.1.0",
  "qualityFloors": {
    "targetMinDetails": 24,
    "strictnessTier": "complex"
  }
}
```

What the merge does with it:

| you propose | result |
|---|---|
| a number **above** the base value | accepted |
| a number **below** the base value | **clamped to the base value, and your attempt is recorded** |
| a tier **stricter** than the base | accepted |
| a tier **looser** than the base | base tier retained |
| a key the base does not know | **refused**, naming the key |

Tier order, loosest to strictest: `simple → moderate → complex → ultra-complex`.

Every accepted change is attributed to the provider and version that proposed it, so a run's quality bar
can be explained afterwards instead of inferred from whatever happens to be installed.

Two things the artifact may **not** carry: any key in `BASE_OWNED` (`qualityContract`,
`preSpecAssessment`, `pipelineRouting`, `sourceImage`, `targetName`, `localSpecSearch`) inside
`specSections`, and `objectClass.domain` via `assessmentPatch` — only domain resolution sets that.

---

<a name="scenario-6"></a>
### Scenario 6 — Run a step in every correction pass

`setupSteps` run **once**. `passSteps` run **in every correction pass** — which is what you want for a
review or measurement that has to be re-taken after each correction.

```json
{
  "passSteps": [
    ["interiors-scale-review",
     "python3 {plugin_dir}/tools/scale_plausibility.py --spec object-sculpt-spec.json --out interiors-review.json"]
  ],
  "passAnchorBefore": "ai-review-recorded"
}
```

Put it before `ai-review-recorded` when your measurement should inform the AI review, or before
`pass-gate-check` when it should inform the continue/stop decision.

Correction loops have ceilings the base counts from the spec's own review history — `maxPerPass` and
`maxTotal`. On breach the run reports `status: stopped` with a `stopReason` and exits non-zero. **A
plugin does not get to raise these.** If your subject genuinely needs more passes, that is a
conversation about the base's ceilings, not a value you can set.

---

<a name="scenario-7"></a>
### Scenario 7 — Ship knowledge, not code

The most under-used extension point. A plugin can contain **zero executable tools** and still be
valuable: one `actor: agent` step plus a reference page.

```json
{
  "setupSteps": [
    ["interiors-contract-read",
     "Read {plugin_dir}/grimoire/intake/interior_contract.md completely before writing the manifest"]
  ],
  "setupAnchorBefore": "local-spec-search"
}
```

`actor: agent` means the row is an instruction to the model, not a command. It is returned as an
`instruction` with **no `argv` key at all**, and nothing is executed — so the `argv[0]` and
metacharacter rules do not apply.

**Set `actor` explicitly on every prose row.** The default is `program`, and a prose sentence handed to
an executor is how `Read the contract` once resolved to `/usr/bin/read` on a case-insensitive filesystem
and exited 0 — a silent success that looked like a completed step. An unknown `actor` is refused, not
defaulted.

This is how `plugin-cs2` starts: its first contributed step's entire job is *"read this contract page
completely before creating or validating the manifest."*

---

<a name="scenario-8"></a>
### Scenario 8 — Contribute reference material to spec search

```json
{
  "id": "interiors",
  "collections": [
    {
      "name": "interiors",
      "content_root": "{plugin_dir}/corpus",
      "include": ["**/*.md", "**/*.json"]
    }
  ]
}
```

and in `domain.json`: `"specCollection": "interiors"`.

`content_root` names a second permitted root the registry vouched for. The containment guard still
applies: no absolute paths, no `..`, and an `lstat` per path component. You are widening *where* the
base may read, not disabling the check that it stays inside.

Use this when your subject has canonical reference material — dimension standards, material catalogues,
naming conventions — that a step should search rather than a model should recall.

---

<a name="scenario-9"></a>
### Scenario 9 — Hand data to another plugin

Cross-plugin handoff is **files with declared `kind` identifiers** in `<workspace>/.img2/artifacts/` —
never shared mutable state.

```python
# plugin A writes -- under its OWN subdirectory, never bare in artifacts/
artifact = {"kind": "interiors.room-envelope-v1", "version": 1, "rooms": [...]}
(workspace / ".img2" / "artifacts" / "interiors" / "room-envelope.json").write_text(json.dumps(artifact))
```

That per-plugin subdirectory is not a style choice: `<workspace>/.img2/artifacts/<plugin-id>/` is the
same containment rule an emission target's declared `provides.artifact.path` is held to (Scenario 12) —
it is what keeps two plugins' outputs from colliding.

```python
# plugin B reads — and checks the kind, because a file name is not a contract
data = json.loads(path.read_text())
if data.get("kind") != "interiors.room-envelope-v1":
    raise SystemExit(f"unexpected artifact kind: {data.get('kind')!r}")
```

For your **own** state, `<workspace>/.img2/state.json` has one subtree per plugin id, and you touch only
yours:

```python
from img2_core.state import update_plugin_state
update_plugin_state(workspace, "interiors", lambda s: {**s, "roomsMeasured": 4})
```

Mutate **only** through `update_plugin_state`, which holds the lock across the whole
read-modify-write. A separate load → mutate → save with the lock held only at save is a lost-update bug,
and the contract names it as one.

Tools take `--workspace`, defaulting to cwd — **never** the skill or checkout root. A tool that writes
into the checkout is writing into somebody's git working tree.

---

<a name="scenario-10"></a>
### Scenario 10 — Add a capability the frame has no opinion about

Not every plugin is a subject area. `plugin-img2glb` is the shape here: it adds an ability the frame
never had and that no domain gates.

Use `steps.json` rather than `domain.json`, because the step should run whenever the plugin is active
rather than only when a domain resolves:

```json
[
  {
    "id": "glb-export",
    "title": "Export the built factory to GLB",
    "actor": "program",
    "command": "node {plugin_dir}/tools/export_glb.mjs --workspace {workspace} --out export.glb",
    "after": []
  }
]
```

Declare a typed edge that says what you convert:

```json
"capabilities": [{ "from": "threejs-factory", "to": "glb-asset" }]
```

**This is not an emission target, and "runs whenever the plugin is active" does not describe one.** A
`steps.json` capability like this one is invoked by whatever the frame's own steps do with it — here,
an agent choosing to run the export tool because the plugin is installed and the edge exists. An
emission target (Scenario 12) is a *different* thing wearing similar clothes: it is declared with a
`provides` row whose `from` is `sculpt-spec`, and — regardless of installation — it never runs unless a
user names it via `--target <kind>`. If your capability is "convert the object into another format,"
ask which one you actually have: does it run because an agent decided to, given the edge exists (this
scenario), or does it run only on an explicit `--target` request naming it, terminal and bounded
(Scenario 12)? The two are not interchangeable, and the wiki has taught only the first shape until now.

---

<a name="scenario-11"></a>
### Scenario 11 — Develop locally, and keep it private

```bash
img2 add --link ./plugin-interiors     # symlink a local checkout; no clone
img2 doctor                             # iterate until zero findings
img2 remove interiors                   # deletes the row, and any user overrides on it
```

**Private is a first-class case.** `plugin-cs2` is a private repo, and nothing in the frame requires a
plugin to be public — that was one of the reasons for the split. Installing from outside the default
`img2threejs` org needs `--allow-any-source`, which prints what it is about to clone before it does.

The harness **never runs your tests or imports your code** during `add`, `doctor` or `sync` — validation
is static. What `add` does give you is provenance: a pinned `resolvedSha`, a registry row, and a link
under a harness-owned name. The contract is honest about the limit: *"it cannot make the code safe, only
make what runs identifiable and reproducible."*

---

<a name="scenario-12"></a>
### Scenario 12 — Declare an emission target: a whole-file export

You want the frame's already-validated sculpt spec turned into a different produced file — a GLB, an
FBX, or here, a minimal deterministic JSON echo of the spec's own shape. This is **not** a domain (you
are not teaching the frame about a subject) and not an ordinary `steps.json` capability (Scenario 10):
it never runs merely because you are installed. It runs once, terminally, and only when a user asks
for it by name.

#### The repo — `plugin-sculpt-echo`, the in-tree fixture that proves this end to end

```
plugin-sculpt-echo/
├── plugin.json          required — the discovery edge
├── steps.json           the provides row: invocation + artifact
├── gates.json           a blocking structure check on YOUR artifact
├── SKILL.md
└── tools/
    ├── emit_echo.py      writes the artifact
    └── gate_echo_structure.py
```

#### `plugin.json` — discovery only

```json
{
  "schema": 1,
  "name": "sculpt-echo",
  "version": "0.1.0",
  "description": "Emission-target contract exerciser: echoes a validated sculpt spec's shape to a deterministic JSON artifact (sculpt-spec -> echo).",
  "capabilities": [{ "from": "sculpt-spec", "to": "echo" }],
  "requires": { "harness": ">=0.1.0", "coreApi": 1 }
}
```

The `from` of `sculpt-spec` is what makes this a **target edge** rather than an ordinary capability —
it names the frame's own validated-spec artifact kind as the source, which nothing but an emission
target declares. The edge still serves discovery only, exactly as any other capability does; it is not
itself an invocation surface.

#### `steps.json` — invocation and artifact, on the providing step

```json
[
  {
    "id": "emit-echo",
    "title": "Echo the validated sculpt spec's shape to a deterministic artifact",
    "actor": "program",
    "command": "python3 {plugin_dir}/tools/emit_echo.py --spec {spec} --workspace {workspace}",
    "after": [],
    "provides": {
      "version": 1,
      "from": "sculpt-spec",
      "to": "echo",
      "artifact": { "kind": "echo", "path": ".img2/artifacts/sculpt-echo/echo.json" }
    },
    "deterministic": true
  }
]
```

Three things that are easy to get wrong on a first attempt, each cost real time when this fixture was
authored from the wiki alone:

- **`provides.artifact.path` is the FULL workspace-relative path, already prefixed with
  `.img2/artifacts/<your-plugin-id>/`** — not a bare filename relative to that directory. Declaring
  `"echo.json"` alone is refused: `doctor` names exactly what it must resolve under.
- **`deterministic` and the optional `timeoutSeconds` are siblings of `provides` on the SAME row**, not
  nested inside it. `deterministic` is required — `true` here, because a pure function of the spec's
  own content is exactly what this fixture is.
- **`{spec}` and `{workspace}` are left for the caller to fill by value**, same as any `steps.json`
  command — this row is invoked by the base's own socket, never by an agent directly, so there is no
  `{plugin_dir}`-only convenience path here the way a domain-contributed step sometimes has.

#### `gates.json` — your artifact gets your own gate, like any other capability

```json
[
  { "id": "echo-structure", "command": "python3 {plugin_dir}/tools/gate_echo_structure.py --workspace {workspace}", "blocking": true, "after": [] }
]
```

This runs under the same participation rule as any other gate (Scenario 3): whenever your providing
step ran as the workspace's selected target. It checks *your own* artifact's shape — the base's own
verification (existence, size, location, and container check where one exists) is separate and does
not depend on your gate passing.

#### Selecting it

```bash
img2 add --link ./plugin-sculpt-echo
img2 doctor                                    # zero findings
img2 capabilities --from-kind sculpt-spec --to-kind echo --json   # resolves to sculpt-echo

# from the base, once the workspace has reached action-ready:
python3 forge/stage3_build/emit_target.py --spec object-sculpt-spec.json --workspace "$PWD" --target echo
```

Nothing here runs merely because the plugin is installed. With no `--target`, the export step is a
no-op that writes nothing and names `src/createObjectModel.ts` as the artifact of record — installing
`plugin-sculpt-echo` and never selecting `echo` changes not one byte of the default output.

#### What the base warrants, and what it does not

The produced `echo.json` carries provenance — the spec's content hash, `sculpt-echo`'s own id, version
and `resolvedSha`, the harness version, and the `deterministic: true` declaration (verified once per
spec-and-revision, by double-invocation, then cached). The base verifies existence, size and location
always, and the declared kind's container shape where a prober exists — `echo` has none, so it is
accepted on existence/size/location alone, with the verification level stating plainly that kind
verification was not performed. **No further base quality warranty applies.** `echo.json` is never
reported under the completion vocabulary a gated TypeScript build uses — its own gate (`echo-structure`)
is the only quality claim it carries, and that claim is `sculpt-echo`'s, not the base's.

#### Verify it before you trust it

```bash
img2 add --link ./plugin-sculpt-echo
img2 doctor                                     # zero findings, or fix and repeat
python3 -m unittest discover -s tests -p 'test_*.py'   # your suite, standalone

# the round-trip that actually proves it, run from the base:
img2 add --link ./plugin-sculpt-echo && img2 doctor && \
  python3 forge/stage3_build/emit_target.py --spec <spec> --workspace "$PWD" --target echo
git status --porcelain      # empty: installing and running a target changed no base file
```

That last line is not a formality — it is the mechanical form of "a v1.7 exporter installs, resolves,
runs and is verified with zero base changes." A target plugin that leaves the base repo dirty has
broken the one property this whole contract exists to prove.

---

<a name="anchors"></a>
### Anchors — the base pipeline's step ids

Splice targets for `setupAnchorBefore` and `passAnchorBefore`. An anchor outside this list fails loud.

**Setup phase, runs once (11):**

`image-analysis` → `reference-suitability` → `reference-admission` → `local-spec-search` →
`pre-spec-assessment` → `detail-inventory` → `projection-route` → `spec-authoring` →
`material-evidence` → `material-spec-wiring` → `strict-validation`

**Correction pass, runs every pass (8):**

`build-current-pass` → `render-capture` → `review-contract-read` → `tier1-diagnostics` →
`multi-angle-review` → `pass-gate-check` → `ai-review-recorded` → `pipeline-sync`

**Final (2):** `part-coverage` → `action-ready`

21 steps generic; contributed steps add to that count rather than replacing any of it.

---

### Anything else?

Cases this cookbook does **not** cover, because there is no mechanism:

| you want | status |
|---|---|
| remove or replace a base step or gate | no mechanism — [Scenario 4](#scenario-4) |
| reorder base steps among themselves | no mechanism |
| two plugins providing the same typed edge | refused as ambiguous, by design |
| raise the correction-loop ceilings | not a plugin-settable value |
| make the base import your code | forbidden; the base pulls artifacts instead |
| a pass id outside the base's set | ~~accepted today, and it should not be~~ **refused, closed** — see [gaps](#gaps) |

That last row was a live bug, now closed: `VALID_PIPELINE_PASS_IDS` gained its first consumers, so a
pass named outside the base's set is refused rather than silently accepted. The residual — a genuinely
visual pass renamed to a legal-but-non-visual id still validates while dropping its visual gate — is
deferred hygiene (`VISUAL_PASS_IDS`/`DEFAULT_PASS_ORDER` dedup), not a mechanism gap; see the gap entry.

---

## Reference

Every field, every refusal, the checklist, and the known gaps.

### `plugin.json` — the only required file

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

### `domain.json` — the domain profile

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

Anchor ids: see [the cookbook](#anchors).

<a name="domain-json-placeholders"></a>
#### `domain.json`'s placeholders — a DIFFERENT closed set from `steps.json`'s

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

### `steps.json` — contributed steps, ordered among themselves

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

#### `actor`

| `actor` | meaning | `argv[0]` rule | returned as |
|---|---|---|---|
| `program` | executable | must be a path form, or one of `python3 python node bash sh` — a bare word is refused | `argv` array |
| `agent` | an instruction to the model | not applicable, nothing is executed | `instruction`, **no `argv` key at all** |
| `human` | an instruction to a person | not applicable | `instruction` |

Set `actor` explicitly on every prose row. `program` is the default, and a prose sentence handed to an
executor is how `Read the contract` once resolved to `/usr/bin/read` and exited 0 — a silent success
that looked like a completed step.

#### Placeholders — a closed set, and it is `steps.json`/`gates.json`'s OWN set

`{plugin_dir}` · `{workspace}` · `{image}` · `{spec}`

Anything else, including any `<…>` pseudo-placeholder, fails `doctor`. `{plugin_dir}` is substituted per
token; `{workspace}`, `{image}` and `{spec}` are left as their own single argv elements for the caller
to replace by value — never as a shell string, and never through a shell. Shell metacharacters in any
step or gate command are refused.

**This is not the only placeholder set in the ecosystem — it is the harness's.** `domain.json` renders
its commands through the base's own checklist, not the harness's tokeniser, and has a different closed
set: see [below](#domain-json-placeholders). A placeholder legal in one file and used in the other
fails `doctor`, naming that file's own valid set — never the other file's.

### `gates.json` — blocking verdicts

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
### `provides` — declaring an emission target

Not a domain, and not the ordinary capability edge in [Scenario 10](#scenario-10): an
emission target is a terminal, whole-file transform of the already-validated sculpt spec, selected only
by an explicit `--target <kind>` request — never invoked merely because you are installed. See
[Scenario 12](#scenario-12) for the worked example (`plugin-sculpt-echo`); this is the
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

### Tools — the bootstrap stanza, and what `doctor` greps for

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

### `SKILL.md`

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

### `spec-augmentation-v1` — the pulled artifact

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

### Workspace state

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
### Everything the harness refuses

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

### Checklist for a new plugin

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
      output ([Scenario 12](#scenario-12))

### Verifying end to end

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
### Known gaps

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
   the base's own stated limit. See [`provides`](#provides) above and [Scenario 12](#scenario-12).
4. **`overrides` has no mechanism**, so there is no supported way to replace a base step or gate. See
   [Scenario 4](#scenario-4). Untouched by the emission target contract: nothing here
   replaces anything, it only adds a new terminal output alongside the existing one.
5. **Reference-asset rules straddle the boundary.** The GLB probe and node-labeller are base tools while
   subject-specific GLB pipelines are not; ownership of the `no-baseline-assets` rule is unassigned. If
   your plugin consumes an external mesh, read that rule first.
