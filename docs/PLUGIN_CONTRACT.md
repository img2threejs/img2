# img2 Plugin Contract (v1)

Normative spec for the img2 harness and its plugins. Every MUST/MUST NOT here is
enforced by `img2 doctor` (statically) or by the CLI at the named command.

## 1. Principles

1. **Everything is a plugin.** The harness ships no domain capability. It owns only:
   install/link plumbing, the plugin registry, the workspace state envelope, the gate
   runner, and this contract.
2. **Composition is data.** The set of active plugins is `$IMG2_HOME/plugins.json` — flat
   rows, editable by hand, no layering, whole-row replacement.
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
- `capabilities` — declared `{from, to}` typed edges. Conflicts (two plugins claiming the
  same edge) are ALLOWED: `img2 doctor` warns, the generated index lists both, the model
  picks by description. No solver.
- `requires.harness` — semver range. `requires.coreApi` — integer, asserted at runtime by
  the bootstrap stanza (§8). Mismatch on either BLOCKS at `img2 add` and `img2 sync`
  (named row, both versions printed). Never a warning: a warned-through mismatch can emit
  wrong geometry that passes visual gates by luck.

Deliberately NOT in schema 1 (do not re-add without a consumer): `env`,
`hostRequirements`, `searchProfiles`, `vocab`, capability chains, enable/disable flags,
layered config.

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
  $IMG2_HOME/plugins/<id>/` (same pattern per host via the HOSTS table). No router skill:
  hosts scan one level deep, skill descriptions are truncated in listings, and there is no
  skill→skill invocation. The link NAME is harness-derived (`img2-` prefix mandatory);
  plugins do not choose it. `img2 doctor` and `img2 remove` MUST refuse to touch a link at
  that path whose target is not under `$IMG2_HOME`.
- `img2 install` merges `$IMG2_HOME` into `permissions.additionalDirectories` in the
  host's settings (`~/.claude/settings.json`), idempotently, preserving unknown keys.
  Without this every plugin read is a permission prompt.
- Python interop: `img2 add` and `img2 sync` write `_img2_local.py` (a one-line module:
  `CORE = "<abs path to $IMG2_HOME/harness/img2_core parent>"`) into each plugin clone.
  It is gitignored by contract (§4). Every plugin tool starts with the fixed stanza:

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

`steps.json` rows: `{ "id", "title", "command", "after": ["<step-id>", …] }`. The harness
topo-sorts contributed steps from all active plugins; `after` may reference another
plugin's step id. A cycle or an unknown reference is an `img2 doctor` error (fail loud,
never a guessed order).

## 11. Workspace state

- Envelope at `<workspace>/.img2/state.json`:
  `{ "version": 1, "workspace": "<abs>", "plugins": { "<id>": { … } } }`.
- `img2_core.state` owns load/save/locking/versioning; a plugin reads and writes ONLY its
  own subtree, via core helpers. Tools take `--workspace` (default: cwd) — NEVER the
  skill/checkout root.
- Cross-plugin handoff is files in `<workspace>/.img2/artifacts/` with declared
  `"kind"` identifiers, not shared mutable state.

## 12. Enforcement summary (what doctor checks)

manifest schema + version ranges · declared files exist · id/link uniqueness and link
ownership · gitignore covers `_img2_local.py` · static boundary greps (§8) · steps/gates
JSON shape, topo-sortable, commands exist · generated index in sync (`img2 sync --check`,
non-zero on drift — dump == mount).
