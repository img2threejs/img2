← [wiki index](README.md)

# How it works

Diagram conventions: **solid** = available · **dashed** = coming, do not depend on it yet · **thick
red** = no mechanism or a known gap.

## Repo topology

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

## `$IMG2_HOME`, install, and the trust boundary

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

## Capability resolution — typed edge, never name

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

## The extension surface

```mermaid
graph LR
    subgraph declare["Declarations — static, read by the harness"]
        P1["plugin.json<br/>typed edge + requires floor"]
        P2["steps.json<br/>step rows, ordered by 'after'"]
        P3["gates.json<br/>gate rows"]
        P4["domain.json<br/>domain profile + anchors"]
        P5["spec_search_profile.json<br/>evidence corpus"]
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
        F3["gate_runner, blocking verdicts"]
        F4["domain registry, 2 sources"]
        F5["spec search with content_root"]
        F6["spec authoring — base PULLS"]
        F7["another plugin reads it"]
        F8["img2_core.state, locked"]
        F9["steps with actor: agent"]
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
```

The **domain registry** has exactly two sources: in-repo modules, and installed plugins' `domain.json`
read **through the harness registry** — never by globbing a directory. Ambiguity between the two is
refused rather than resolved by precedence.

## Runtime — one run, three cases

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

## Where a plugin splices in

```mermaid
flowchart LR
    S1["Stage 1<br/>intake"] --> S2["Stage 2<br/>spec"] --> S3["Stage 3<br/>build"] --> S4["Stage 4<br/>review"] --> S5["Stage 5<br/>rig"]

    PS["setupSteps<br/>setupAnchorBefore"] -.->|"splice AT the anchor"| S1
    PS -.-> S2
    PP["passSteps<br/>passAnchorBefore"] -.->|"every correction pass"| S4
    PA["spec-augmentation"] -.->|base pulls| S2
    AH["admission.json<br/>probe.json"] -.->|"base publishes,<br/>plugin reads"| S1
```

Splicing inserts your steps **immediately before** the anchored base step. An anchor naming a base step
that does not exist fails loud — the alternative, appending at the end, would put a setup step after the
steps that depend on it. Step ids to anchor against are listed in
[the cookbook](03-cookbook.md#anchors).

## The augmentation merge, and every refusal

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

## Boundaries — who may read, import, write

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

**Gap — the base-import prohibition is not in the contract yet.** The only `MUST NOT import` clause
binds *plugin tools* and *`img2_core`*; none binds the base itself. The thick edge from `base` to
`plugin` is the rule the architecture assumes and the document does not yet state. See
[gaps](04-reference.md#gaps).

## Workspace state — one file per owner

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
