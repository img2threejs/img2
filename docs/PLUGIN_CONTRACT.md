# img2 Plugin Contract (v1)

Normative spec for the img2 harness and its plugins. Every MUST/MUST NOT here is
enforced by `img2 doctor` (statically) or by the CLI at the named command.

## 1. Principles

1. **Everything is a plugin.** The harness ships no domain capability. It owns only:
   install/link plumbing, the plugin registry, the workspace state envelope, the gate
   runner, and this contract.
2. **Composition is data.** The set of active plugins is `$IMG2_HOME/plugins.json` — flat
   plugin rows, editable by hand, no layering, whole-row replacement. This governs how a
   PLUGIN row is composed; it does not forbid a user-authored, non-plugin top-level key (§6,
   "Reserved: `overrides`") — that key holds the user's own pipeline choices, not
   plugin-layered composition, so the no-layering rule continues to govern plugin rows only.
3. **Fail loud.** A plugin that cannot fully activate blocks the command that touched it,
   naming the plugin and the reason. No silent partial activation.
4. **Static trust.** The harness never imports or executes plugin code during `add`,
   `doctor`, or `sync`. All checks on plugin code are static (file reads, grep/AST).
5. **Honest claim.** Adding/registering a plugin requires ZERO edits to the harness
   (mechanically tested: harness checkout stays `git status --porcelain`-clean). Adding a
   *new core capability* a plugin needs is a harness release, and is not claimed otherwise.

## 2. Terms

- **harness** — repo `img2threejs/img2`: the `img2` CLI (Node ≥18, zero dependencies) +
  `img2_core/` (Python ≥3.10, stdlib only, a real package with `__init__.py`).
- **plugin** — one git repo following §4, cloned under `$IMG2_HOME/plugins/<id>/`.
- **workspace** — the user's project directory (cwd). All state lives here, never in a
  checkout.
- **host** — an agent host with a skills dir: `claude`, `codex`, `opencode` (HOSTS table).

## 3. $IMG2_HOME layout

Default `~/.img2`. Deprecated alias: `IMG2THREEJS_HOME` (honored one release, warns).

```
$IMG2_HOME/
  harness/          # canonical harness checkout
  plugins/<id>/     # one clone per plugin row
  generated/        # ALL generated artifacts (index.md, routes.json). Never inside a checkout.
  plugins.json      # the registry (composition data)
  receipts.json     # what was linked where (same shape as today's installer)
  backups/          # displaced directories
  .lock             # advisory lock (LOCK_STALE_MS = 1h)
```

`img2 install` MUST detect a legacy `~/.img2threejs/repo` layout and migrate it (move
checkout, rewrite receipts, re-point symlinks), otherwise refuse with instructions.

## 4. Plugin repo layout (convention)

```
plugin.json        # manifest, §5 — required
SKILL.md           # the plugin's host-facing skill — required
tools/             # deterministic CLI tools (Python ≥3.10, stdlib only)
reference/         # routed reference markdown
tests/             # unittest discoverable: python3 -m unittest discover -s tests
steps.json         # workflow steps contributed (optional, §10)
gates.json         # gates contributed (optional, §9)
.gitignore         # MUST ignore _img2_local.py
```

## 5. plugin.json (manifest schema 1)

```json
{
  "schema": 1,
  "name": "img2glb",
  "version": "0.1.0",
  "description": "Image to GLB mesh via hosted TRELLIS. One line, shown in listings.",
  "capabilities": [{ "from": "image", "to": "glb" }],
  "requires": { "harness": ">=0.1.0", "coreApi": 1 }
}
```

- `schema` — integer. The harness declares the highest schema it can read
  (`MAX_PLUGIN_SCHEMA` in the CLI); a higher value MUST be refused, never best-effort
  parsed.
- `name` — `[a-z][a-z0-9-]*`, unique per registry; doubles as the row `id` and link name.
- `capabilities` — the ONLY capability declaration surface. SKILL.md frontmatter, including
  any `metadata` block, is NEVER read for capabilities. Declared `{from, to}` typed edges.
  Two plugins claiming the same edge is a LEGAL install: `img2 doctor` warns, and
  `img2 capabilities` (§13) refuses to resolve that edge, naming both claimants. No solver.
- `requires.harness` — semver range. `requires.coreApi` — integer, asserted at runtime by
  the bootstrap stanza (§8). Mismatch on either BLOCKS at `img2 add` and `img2 sync`
  (named row, both versions printed). Never a warning: a warned-through mismatch can emit
  wrong geometry that passes visual gates by luck.

Deliberately NOT in schema 1 (do not re-add without a consumer): `env`,
`hostRequirements`, `searchProfiles`, `vocab`, capability chains, enable/disable flags,
layered config, `fulfills`/slot-name fields, a `support` level enum. The documented upgrade
path for a provider that genuinely claims two edges from one manifest is per-step
`provides: {from, to, artifact: {kind, path}}` in `steps.json` (§10), doctor-validated
against the manifest — it is strictly more expressive than a manifest-level field and is
adopted the day a provider actually needs it, per the project's own CUT rule.

## 6. plugins.json (registry)

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "img2glb",
      "repo": "img2threejs/plugin-img2glb",
      "ref": "v0.1.0",
      "resolvedSha": "abc123…",
      "addedAt": "2026-08-22T00:00:00Z"
    }
  ]
}
```

- `id` = manifest `name` = host link suffix. `img2 add` on an existing id exits non-zero
  naming the row; replacement requires `--force`.
- `ref` defaults to the repo's newest reachable tag; a moving branch requires explicit
  `--ref <branch>` and is recorded as such. `resolvedSha` is always recorded so a user's
  setup is reproducible.

### Reserved: `overrides`

A future release may define an `overrides` object addressing base-pipeline steps and gates.
Its address space, replacement semantics, precedence and location are ALL OPEN and belong to
the change that implements it — this contract reserves the key and fixes only the following
four rules; it defines no mechanism.

1. **Overrides are user-authored.** `plugin.json` has NO override field and MUST NOT gain
   one; a plugin MUST NOT declare an override about itself or any other plugin — installing
   or upgrading a plugin therefore never changes a pipeline.
2. **An override value is a reference to an existing row, NEVER an inline command.** A
   command supplied through an override would bypass the placeholder and metacharacter
   checks (§10, §13).
3. **A harness that does not implement overrides MUST report the key as an unrecognised
   registry entry** — `img2 doctor` FAILs, naming the row — **and MUST NOT silently proceed
   as though the pipeline were unmodified.** It does NOT brick unaffected commands: today's
   registry reader validates only `version === 1` and `Array.isArray`, so an unknown
   top-level key draws zero findings, and preserve-silently-report-nothing is precisely the
   silent no-op this rule exists to prevent — silently ignoring a block that disables a
   quality gate is the failure this reservation exists to prevent.
4. **`overrides` is user-owned data.** Any command that rewrites a registry row MUST
   preserve it verbatim and report what it preserved. `img2 remove` deletes it with the row,
   by design.

## 7. Trust boundary

- `img2 add <spec>` accepts `org/repo`, a URL, or `--link <localpath>` (symlink a local
  checkout for development; no clone).
- Default allowed source is the `img2threejs/*` org. Anything else requires
  `--allow-any-source` and prints what it is about to clone and link.
- The harness NEVER runs plugin tests or imports plugin code during add/doctor/sync.
- Threat model: a plugin is arbitrary code the agent will later execute in the user's
  workspace. `add` therefore pins (`resolvedSha`), attributes (registry row), and links
  under a harness-owned name — it cannot make the code safe, only make what runs
  identifiable and reproducible.

## 8. Host integration & Python bootstrap

- Each plugin is linked as its OWN skill: `~/.claude/skills/img2-<id>/ →
  $IMG2_HOME/plugins/<id>/` (same pattern per host via the HOSTS table). No router skill: the
  rationale rests on the documented eviction risk and trigger rate, not on any claimed
  measurement of host scanning depth or skill→skill invocation. Skill listings are shortened
  to fit a budget of roughly 1% of the context window, dropping descriptions "starting with
  the skills you invoke least" — an optional per-edge provider is, by construction, the
  least-invoked skill. Description-based, model-triggered activation is documented as
  stochastic: the authoring guidance treats a 0.5 trigger rate as passing. A router skill
  would put every provider behind one description subject to that eviction and that trigger
  rate; a per-plugin link keeps each provider's own description live and independently
  triggerable. The link NAME is harness-derived (`img2-` prefix mandatory); plugins do not
  choose it. `img2 doctor` and `img2 remove` MUST refuse to touch a link at that path whose
  target is not under `$IMG2_HOME`.
- SKILL.md frontmatter MAY set `disable-model-invocation` to require an explicit
  slash-command invocation instead of model-triggered discovery. This is documented as
  SHOULD, not MUST: it is Claude-Code-only — other hosts ignore it — and the harness never
  parses SKILL.md frontmatter to enforce it (this is the same ground on which §5 refuses to
  read `metadata` for capabilities). The eviction-budget and 0.5-trigger-rate figures above
  come from Claude Code's own authoring documentation; their provenance is UNVERIFIED by this
  project's own measurement and is recorded here as cited, not confirmed.
- `img2 install` merges `$IMG2_HOME` into `permissions.additionalDirectories` in the
  host's settings (`~/.claude/settings.json`), idempotently, preserving unknown keys.
  Without this every plugin read is a permission prompt.
- Python interop: `img2 add` and `img2 sync` write `_img2_local.py` (a one-line module:
  `CORE = "<abs path to $IMG2_HOME/harness/img2_core parent>"`) into each plugin clone's
  root AND into its `tools/` directory — `python3 tools/x.py` puts `tools/`, not the clone
  root, at `sys.path[0]`, so the fallback import only resolves next to the script. It is
  gitignored by contract (§4; the bare-filename pattern covers both copies). Every plugin tool starts with the fixed stanza:

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

  `require_core_api(n)` raises with both versions named when the major differs — one
  assert in one place. `pip` is deliberately not used (PEP 668 markers on Homebrew/Debian
  Pythons; multiple interpreters on PATH make installs land in the wrong one).
- Plugin tools MUST NOT: compute repo roots via `Path(__file__).parents[N]`, import from
  another plugin, or import host-checkout paths (`forge.*`). `img2_core` MUST NOT import
  plugin code. All four are static `img2 doctor` failures.

## 9. Gate contract

A gate is a CLI: JSON or file paths in via argv, ONE verdict envelope on stdout:

```json
{
  "kind": "img2.gate-verdict",
  "version": 1,
  "gate": "cube-structure",
  "plugin": "hello-cube",
  "status": "pass",           // pass | fail | error
  "reasons": [],               // non-empty when status != pass
  "evidence": {}               // gate-specific, JSON-serializable
}
```

Exit codes: 0 = pass, 1 = fail (gate evaluated, verdict negative), 2 = error/refused
(could not evaluate). `gates.json` declares rows
`{ "id", "command", "blocking": true, "after": [] }`; commands are run from the workspace
by `img2_core.gate_runner`, which aggregates envelopes and stops the workflow on a
blocking fail. A gate that prints a malformed envelope is an `error`, not a pass.

## 10. Workflow steps

`steps.json` rows: `{ "id", "title", "command", "actor", "after": ["<step-id>", …] }`. `command` MAY
use only the closed placeholder set `{plugin_dir}`, `{workspace}` and `{image}` — `img2
doctor` FAILs a command containing any other `{…}` placeholder or any `<…>`
pseudo-placeholder (§12). A caller consumes `command` as an already-tokenised `argv` array:
`{plugin_dir}` is substituted per token, and `{workspace}`/`{image}` are left as their own
single elements for the caller to replace by value — never as a shell string, and never
through a shell (§13). The harness topo-sorts contributed steps from all active plugins;
`after` may reference another plugin's step id. A cycle or an unknown reference is an `img2
doctor` error (fail loud, never a guessed order).

### `actor` — who carries out the row

`actor` is OPTIONAL and MUST be one of `program`, `agent` or `human`. It defaults to `program`. An
unrecognised value is refused, never defaulted.

- **`program`** — the row is executable. It is handed back as `argv`, and its `argv[0]` MUST be
  either a path form (containing a path separator, and existing) or one of the interpreters
  `python3`, `python`, `node`, `bash`, `sh`. A bare word is REFUSED.
- **`agent`** / **`human`** — the row is prose. It is handed back as `instruction` (the raw
  `command` string) and carries **no `argv` key at all**, so there is nothing for a caller to
  execute. The shell-metacharacter and argv[0] rules do not apply, because nothing is executed; the
  closed placeholder set still does.

A gate MUST be `actor: "program"` — a gate has to produce a verdict, so it cannot be delegated to a
human or to the agent.

**Why `argv[0]` may not be a bare word.** A caller executes `argv[0]` directly, so a prose word that
merely happens to sit on `PATH` is a silent-execution hazard, not a typo. Measured on a stock macOS
box: `Read` resolves to `/usr/bin/Read` through case-insensitive APFS, and `Analyze` resolves to a
real ImageMagick binary — so the prose row `Analyze the reference image` would run ImageMagick with
the prose as its arguments and exit 0. Before this rule the capability query answered such a row
with `status: "answered"`, exit 0, `problems: []`. This supersedes the KNOWN LIMIT recorded in §13:
a static check still cannot tell prose from a command, so the row declares which it is, and the
default is the one that fails loud rather than the one that executes. A plugin that genuinely needs
a bare-word program wraps it in a script under `{plugin_dir}`, which also gives it somewhere to
check that the program is installed.

## 11. Workspace state

- Envelope at `<workspace>/.img2/state.json`:
  `{ "version": 1, "workspace": "<abs>", "plugins": { "<id>": { … } } }`.
- `img2_core.state` owns load/save/locking/versioning; a plugin reads and writes ONLY its
  own subtree, via core helpers. Mutations MUST go through
  `img2_core.state.update_plugin_state(workspace, plugin_id, fn)`, which holds the lock
  across the whole read-modify-write — a separate load→mutate→save with the lock held only
  at save is a lost-update bug. Tools take `--workspace` (default: cwd) — NEVER the
  skill/checkout root.
- Cross-plugin handoff is files in `<workspace>/.img2/artifacts/` with declared
  `"kind"` identifiers, not shared mutable state.

## 12. Enforcement summary (what doctor checks)

manifest schema + version ranges · declared files exist · id/link uniqueness and link
ownership · gitignore covers `_img2_local.py` · static boundary greps (§8) · steps/gates
JSON shape, topo-sortable, commands exist · shell-metacharacter refusal in every
`steps.json`/`gates.json` command (§10, §13) · closed-placeholder-set enforcement on the
same commands (§10, §13) · a multi-capability provider draws a WARN naming the plugin and
its capability count, without affecting doctor's exit code (§13) · the base host link's
target is reported so a wrong-working-copy install is visible · generated index in sync
(`img2 sync --check`, non-zero on drift — dump == mount).

## 13. Capability resolution

`img2 capabilities [--from-kind <k>] [--to-kind <k>] [--plugin <id>] [--json]` answers "which
installed provider serves edge X→Y". It is READ-ONLY: it takes no lock and writes nothing —
no registry mutation, no clone mutation, no generated artifact.

Resolution is by declared typed edge ONLY — the `capabilities` array in `plugin.json` (§5).
Description text, name similarity, model inference and file-system naming convention are
NEVER used to resolve an edge.

The command prints exactly one JSON envelope on stdout for every outcome it owns:

```json
{ "version": "0.2.0", "contract": 14, "query": { "from": "image", "to": "glb" },
  "status": "answered",
  "providers": [ { "plugin": "img2glb", "version": "0.1.0", "resolvedSha": "abc123…",
    "dir": "<clone path>", "steps": [ { "id": "…", "argv": ["python3", "…"] } ],
    "gateRunner": { "argv": ["python3", "-m", "img2_core.gate_runner", "…"] } } ],
  "problems": [] }
```

Each provider row carries `steps` in topological order, each with an `argv` already tokenised and
`{plugin_dir}`-resolved, leaving `{workspace}` and `{image}` as single elements for the caller to
replace by value. `gateRunner` is the argv that runs that provider's `gates.json` through
`img2_core.gate_runner`, or `null` when the plugin ships no gates.

A provider is returned in `providers` only if every row of its `steps.json` and `gates.json` passes
the same static checks `img2 doctor` applies, and every row's `argv[0]` resolves to a program on PATH
or an existing file. A provider failing either goes to `problems` and the status is `data-fault` when
no clean provider remains — the query and doctor MUST NOT disagree, because a caller is told to branch
on `status` and would otherwise execute a command doctor had already refused.

CLOSED (was a KNOWN LIMIT): a static check still cannot distinguish prose that happens to parse as a
command from a real command — `Read notes.md and analyze {image}` uses only legal placeholders and
resolves `argv[0]` on a case-insensitive filesystem. The fix is not a better heuristic but the
`actor` field in §10: the row declares whether a program, the agent or a human carries it out, a
`program` row's `argv[0]` may not be a bare word, and a non-program row is handed back as an
`instruction` with no `argv` at all.

`status` is one of `answered` | `ambiguous` | `data-fault`. A caller branches on `status`
alone — the exit code is a redundant convenience, never the primary signal. Zero providers is
`answered` with `providers: []`: a normal answer, not an error. A registered plugin whose
manifest cannot be read or validated is reported in `problems` (`{plugin, path, reason}`)
while `providers` still answers, UNLESS that plugin claims the queried edge, in which case
`status` is `data-fault`. Drift refusal is scoped to `generated/index.md` and
`generated/routes.json` ONLY — a stale `_img2_local.py` in an unrelated clone never refuses
an answer.

A provider declaring more than one DISTINCT capability edge resolves on each edge
independently; it is unresolvable only for an edge it declares more than once, because that
edge alone is ambiguous within the single provider. `--plugin <id>` disambiguates an
`ambiguous` result to a single row, or reports `data-fault` when the named plugin does not
claim the queried edge.

Each step row carries `argv`: already tokenised, `{plugin_dir}` substituted per token,
`{workspace}` and `{image}` left as their own elements for the caller to replace by value.
The caller never composes a shell string and never invokes a shell.

Exit codes reuse the table in `CONTRIBUTING.md` with nothing re-coded: **0** `answered`,
**1** `EXIT.FAIL` for `data-fault`, **3** `EXIT.NEEDS_INPUT` for `ambiguous`. **2 is never
used by this subcommand** — it stays the harness-wide "request not understood" signal, which
doubles as the absence signal below.

Absence is detected by a positive probe, never inferred from a non-zero exit.
`img2 --version --json` emits `{harness, maxPluginSchema, coreApi, contract, commands[]}`. A
caller treats capability resolution as absent when `--json` is unrecognised or
`capabilities` is missing from `commands[]` — NEVER by matching stderr text, and NEVER by
treating exit 2 alone as absence, since a legitimate refusal is also exit 2.

## 14. Workspace ownership

`<workspace>/.img2/state.json` (§11) is written ONLY by plugin tools, through
`img2_core.state.update_plugin_state`. A base pipeline is not a plugin: it has no
`_img2_local.py` and cannot import `img2_core`, so it MUST NOT write into this file — doing
so would hand-roll the envelope and duplicate the lock. A base pipeline's own delegation
record belongs in its OWN state file — for `img2threejs`, its existing checklist authority —
never in `<workspace>/.img2/state.json`. This decision is recorded now even though the
writer is deferred, so the base-skill change this contract anticipates inherits the split
rather than re-deciding it, and the workspace state surface stays at one file per owner.
