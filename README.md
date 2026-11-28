# img2

**img2threejs turns a reference image into a textured, realistic 3D GLB.** `img2` is the plugin
harness behind it: it installs the domain plugins, the shared runtime they need (Blender `bpy`,
Chromium/Playwright, Three.js, vision models, CS2 tools, MCP servers). Ordinary routing uses your
current host agent/model, without a Jev plugin, account or interactive terminal. The optional **Jev**
plugin provides paid bounded routing and repair advice; acceptance stays with each plugin's own gates.

The harness itself ships no domain capability: everything is a plugin. It owns install/link
plumbing, the plugin registry, the workspace state envelope, the gate runner, and the contract.

## Get started in one command

```bash
npx --yes @img2threejs/img2@latest setup
```

Once the harness is installed, the same flow is available from the launcher:

```bash
img2 setup
```

The npm package is the scoped `@img2threejs/img2` (there is no unscoped `img2threejs` package).
The `--yes` here belongs to **npx** (permission to download the CLI package); it is not an
`img2 setup` flag. From a source checkout of this repository, or if the CLI you resolved does not
have a `setup` command yet, run `node bin/img2.mjs setup` from the checkout instead.

`setup` asks which plugins you want, then installs the pinned core and plugins, syncs, provisions the
runtime and audits the result.

| Plugin | What it provides | Git source |
|---|---|---|
| `character` | Character rigging, skin conditioning, animation and rig gates | Public |
| `cs2` | Counter-Strike 2 weapon/glove skin reconstruction and review gates | Public |
| `interior` | Image/reference to an interior scene: Blender authoring, PBR, render/repair and verified delivery | Public |
| `jev` | Bounded image-aware routing and repair advisories to the right plugin; never acceptance authority | Public |
| `pixi2d` | Explicit 2D image reconstruction in PixiJS with editable nodes and a blocking review gate | Public |

Choose a plugin set at the prompt (Enter = `character,cs2,interior,pixi2d`; Jev is opt-in), or skip
the prompt with flags:

```bash
img2 setup                                  # Enter = four domain plugins, without Jev
img2 setup --plugins cs2,jev                # explicit list including optional Jev; skips the prompt
img2 setup --minimal                        # same four-domain-plugin default bundle (see below)
img2 setup --yes                            # four domain plugins, no prompt
img2 setup --strict-hash                    # refuse hash-weak downloads (default: accept and record)
img2 setup --skip cs2-dotnet-runtime        # disable a dependency (repeatable)
img2 setup --offline                        # no network; see below
img2 setup --home /abs/path --from /path/to/harness-checkout
```

Setup flags are only `--yes`, `--plugins`, `--minimal`, `--home`, `--from` (a local harness
source), `--strict-hash`, `--skip` and `--offline` (`--allow-weak-hash` is still accepted; it is the default).

- **Selection precedence:** explicit `--plugins` beats `--minimal`, which beats `--yes`. The prompt
  accepts Enter (the four domain plugins) or a comma-separated list of the IDs above; duplicates collapse,
  and unknown or empty list items are refused. With no TTY and no flags, setup selects the same four
  without asking. An empty `--plugins` value is refused. Select `--plugins jev` explicitly to install Jev.
- **`--minimal` selects the same no-Jev default bundle**, with the full runtime profile for those
  plugins. It does not introduce a core-only install. It is **not** the `img2 provision --minimal`
  runtime profile, which drops vision, MCP servers and extra browsers.
- **Hash-weak entries are accepted by default.** The lock pins some entries only by MD5/CRC32C, git
  SHA-1 or a GCS generation (Playwright browser bundles from the CDN, model configs). `setup` proceeds,
  records a locally computed SHA-256 in `runtime/provision.json` and prints one `Notice:` line with the
  count. **`--strict-hash`** refuses them instead, in preflight and before anything is changed (combine
  with `--skip` to drop those dependencies). `img2 provision` on its own still needs `--allow-weak-hash`.
- **Plugin tools run with the provisioned Python 3.11**, never the ambient `python3`
  (`$IMG2_HOME/runtime/<digest>/runtime/python-runtime/bin/python3`). Setup prints the exact
  interpreter. If `python-runtime` is skipped, setup needs a PATH Python ≥ 3.10 and refuses before
  installing anything when it finds none; the login command it prints uses the same interpreter.
- **`--skip <dependency-id>`** disables that dependency and everything that needs it. Repeat it for
  several IDs; take the IDs from `dependencies.lock.json`.
- **`--offline`** needs an existing Git-installed harness (or a local `--from` source), selected
  Git plugin checkouts at their lock pins and a complete, verified runtime cache. No Git downloads.

### What setup does

1. `install`, only if the harness checkout or installation metadata is absent.
   Setup verifies the **installed** CLI is >= 0.6.0 and advertises route interface 1 before provisioning.
   An obsolete checkout is refused, not silently upgraded: explicitly run `img2 update harness --yes`
   to a reviewed release, or move it aside and use `--from` with a reviewed checkout.
1b. `core`: check out the pinned core skill (`plugins.lock.json` `core`: repo
   `img2threejs/img2threejs`, one exact commit) at `$IMG2_HOME/core`, verify `HEAD` equals the pin, and
   link it into each detected host as `img2threejs` (a foreign file or symlink there is refused before
   any download). `img2 core-path` prints `$IMG2_HOME/core/forge/route.py`, the router. `img2 install`
   does the same unless `--no-core`; `img2 doctor` verifies commit, cleanliness, router and links.
2. `add` each selected plugin at its **pinned** commit from `plugins.lock.json`, only for plugins
   that are missing or whose managed checkout differs from the pin.
3. `sync` generated files.
4. `provision --profile full --plugins <selection>`: managed Python/Node and shared routing
   dependencies, plus the selected plugins' environments (two separate `bpy` environments when
   character and interior are selected), browsers, Three, vision, CS2 tools and MCP servers.
5. `doctor` (static installation audit).
6. `doctor --runtime` (proves each runtime piece works).
7. Only when Jev was explicitly selected: its credential status (`jev.py auth-status`, local-only,
   run with the provisioned Python), with an opt-in login hint when no credential is present.

After step 6 setup writes `$IMG2_HOME/provision.json` (harness commit and launcher SHA-256, node, the
installed plugin dirs, core path, interpreter) and prints the normal host-model `img2 route` command.
When Jev was explicitly selected but has no credential, setup also prints its optional login command and succeeds.

#### Running the core: `img2 route` / `img2 core-run`

`img2 route <route.py args>` is the one supported way to run the pinned core router from an install;
`img2 core-run <script under core/forge> <args>` runs any other core script (e.g. `preflight.py`) the same
way, without adding pins. Both read `provision.json`, refuse with the remedy when it is missing, stale or
its launcher hash differs, and then:

- resolve `IMG2_HOME` with `realpath` and export `IMG2_HOME` and `IMG2_HARNESS_DIR`;
- start the core with a minimal environment (identity, locale, TLS/proxy settings and `TYPESAFE_API_KEY`
  only; never `PYTHONPATH`, pip/npm settings or `NODE_OPTIONS`); `PATH` is the managed Python dir, the
  pinned Node dir, the dir of the `blender` already on your `PATH`, your other absolute `PATH` entries,
  then the system dirs;
- run the core under `runtime/<digest>/route-python`: a copy of the managed CPython whose only extra import
  path is the site-packages of the provisioned env whose Pillow passed its runtime probe (`jev`, then
  `pixi2d`, ...). The core's Jev image preparation resolves its interpreter and runs it with `-I`, so
  neither a venv symlink nor `PYTHONPATH` can supply Pillow;
- for `route`, add `--harness-root/--harness-sha/--harness-executable/--harness-sha256` from
  `provision.json` unless you passed them.

Ordinary routing uses core's `--decider model` default. The harness forwards arguments unchanged;
it does not answer questions or choose a model itself:

```bash
img2 route --workspace WORKSPACE --run-id RUN_ID --image IMAGE --objects OBJECTS.json
img2 route --workspace WORKSPACE --run-id RUN_ID --image IMAGE --objects OBJECTS.json \
  --decider model --model-id HOST_MODEL_ID --token-budget 256000
# Answer the core's questions with your actual host model, then resume with its typed answer file:
img2 route --workspace WORKSPACE --run-id RUN_ID --image IMAGE --objects OBJECTS.json \
  --decider model --model-id HOST_MODEL_ID --token-budget 256000 --model-answers ANSWERS.json
```

3D routing requires object proposals via `--objects OBJECTS.json`. Only explicit 2D routing
(`--expected-output 2d`) can omit object proposals.

Missing answers produce `questions-ready` with a `questionsRef`, not a Jev login requirement.
No concrete model ID is invented when `--model-id` is omitted; core uses the logical `host-agent`
selector. Answers must match the core's bound request/context. To opt in to paid Jev routing,
explicitly pass `--decider jev`; its credentials, release pins and disclosure/paid-call consent
remain required. Provisioning, integrity checks and native delivery gates are unchanged.

With `install --auto-install` consent and an already valid runtime, a normal 3D route can add a
missing public producer **before continuing the same request**. It matches typed proposal roles and
observations against `plugins.lock.json` routing snapshots; no plugin flag or separate install
command is needed for a matching card. Object labels/IDs never become package names or commands.
The installed harness must be clean and setup-pinned. Its catalog validates the source, its lock
selects one exact Git commit, and the fetched `route.json` must match both the recorded SHA-256 and
card data. Missing/older routing metadata and unsupported runtimes refuse rather than guessing.
The current Interior snapshot supports one enclosed room; the unconstrained CS2 card is not inferred
from a name, and the old Character pin has no routing snapshot. Those are not implicit auto-install
approvals. The core still makes all actual routing, permission, producer and terminal decisions.

Concurrent requests serialize installation; an already installed exact clean pin is reused without
fetching. An install publication error restores its previous registry/generated files, links and
setup receipt. Local, dirty, foreign or differently pinned registrations are never replaced by this
path. `IMG2_AUTO_INSTALL=0` or absence of the opt-in marker prevents automatic installation.
Installer diagnostics go to stderr so stdout remains the original router response.

It never grants consent or logs in. One summary line (paths, Pillow version, blender) goes to stderr;
stdout is the router's. That file is what the
core's `scripts/e2e/route_one.py --home "$IMG2_HOME"` reads, so a clean home can route without
hand-built inputs; the core's own pin check (`forge/route.py`) also requires the launcher's import
closure to stay static (see `tests/launcher-closure.test.mjs`).

Any step that fails or throws stops the later steps. Setup then prints a summary table
(Plugin, Installed ref, Runtime units verified, Doctor, Next step) with the failing step name and
code.

### Requirements

- macOS arm64/x64 or Linux x64 for the complete runtime; Windows is refused.
- Linux arm64 supports platform-available subsets, **not** the default full setup: the locked
  character `bpy==4.5.15` and interior `bpy==4.3.0` publish no matching wheels. Provisioning refuses
  unless you explicitly omit these capabilities with `--skip character-bpy --skip interior-bpy`;
  that is not equivalent to a complete character/interior installation.
- Node.js ≥ 18, Git (for bootstrap) and Python ≥ 3.10
- At least one detected agent host: Claude Code, Codex or OpenCode (see [Prerequisites](#prerequisites))
- Network access for the first run; authorized Git access is needed for any private source you explicitly select.
- Disk: a full provision downloads about **2.3 GB** (`img2 provision --plan` reports
  `>= 2.29 GB` plus entries whose size the lock does not publish). Expanded size, cache and peak
  disk are additional and platform-dependent; run `img2 provision --plan` (it writes nothing) for
  the breakdown on your machine.

### Optional Jev login

Setup never logs in and never reads, stores or prints your API key. If you explicitly selected Jev
and it has no credential, setup prints the exact opt-in login command and still succeeds:

```bash
IMG2_HOME="${IMG2_HOME:-$HOME/.img2}"
python3 "$IMG2_HOME/plugins/jev/tools/jev.py" login
```

`IMG2_HOME` defaults to `~/.img2`. `login` needs an interactive terminal and macOS Keychain. For
automation, provide `TYPESAFE_API_KEY` through your host's secret manager; the Jev plugin reads it
and it takes precedence over the Keychain entry. Check status at any time (local-only: it never
contacts TypeSafe and never prints the key):

```bash
python3 "${IMG2_HOME:-$HOME/.img2}/plugins/jev/tools/jev.py" auth-status   # 0 present, 3 missing, 1 storage error
```

A stored key may still be rejected on the first provider call. Login and setup do **not** grant
workspace disclosure or paid-call consent. Jev has separate consent: a per-workspace grant
(`consent authorize`) for the legacy Environment checkpoints, and a per-run grant
(`consent authorize-decisions`) for image-aware decisions that covers image/reference/render
disclosure to TypeSafe **and** paid calls, with an explicit run id and token budget. You approve
those yourself; see the Jev plugin's `SKILL.md` and `DECISIONS.md`.

After setup, start a new agent session (or restart the current one) so the updated skills load,
then follow the instructions of the plugin you want to use.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Installed and verified; missing optional Jev credentials do not block success or host-model routing |
| 1 | A step failed (including unreachable Git), or Jev auth status is unavailable/malformed |
| 2 | Refused: invalid options, unsupported platform, protected local/dirty/foreign checkout, unmet offline preconditions or missing hash consent. Earlier completed steps are retained. |
| 3 | Interactive input ended (EOF), or a required setup step requested input |

### Re-running, repair and refusals

Setup is idempotent. Re-running keeps correctly pinned managed plugins, repairs a managed checkout
whose HEAD differs from the pin or that is missing, and still runs sync, provision and both
doctors. A plugin registered as a local link, with local modifications, or from a foreign source is
**refused**, not overwritten; resolve it yourself, or replace it deliberately with
`img2 add <id> --force --yes`.

### Known limitation: current pins

All current core/plugin pins are marked `on-origin`: their commits are on the feature branches named
in `plugins.lock.json`, **not yet on `main` or an accepted release**. They must be reviewed and
merged or re-pinned before release. Setup uses the exact commits and never substitutes another ref;
final plugin fixes and the corresponding core/harness lock closure are still pending.

### Troubleshooting

```bash
img2 doctor            # static installation audit
img2 doctor --runtime  # proves each runtime piece works; non-zero on any failure
img2 provision --plan  # what would be downloaded; writes nothing
```

- **`upstream-wheel-tag-mismatch`:** PyPI's `bpy` cp311 macOS wheels carry an internal `cp39`
  `WHEEL` tag, so `pip check` reports the wheel as unsupported. The harness waives *only that* case,
  and only when the wheel's SHA-256 equals the lock pin, the filename tag matches the platform, only
  the Python tag differs, and the `bpy` probes pass. Any other `pip check` line, package, hash or
  tag difference stays fatal. The waiver is recorded in `provision.json`.
- **Playwright MCP browser:** `browser-mcp-playwright` installs only pinned Chromium and its headless
  shell. `@playwright/mcp` 0.0.78 defaults to system Chrome; launch it with `--browser chromium`
  (plus `--headless` for headless use) and `PLAYWRIGHT_BROWSERS_PATH` pointing to this unit's `browsers`
  directory. Its probes use that same Chrome-for-Testing channel and require a real page load and WebGL
  render. Firefox and WebKit are opt-in server modes, not dependencies of this runtime. Firefox rev 1534
  times out on macOS arm64 with sandbox-extension denials and a SWGL framebuffer error; provisioning
  does not disable its sandbox or substitute a different build. `--skip browser-mcp-playwright`
  explicitly disables the whole unit and `mcp-playwright`.
- **Git authentication/transport:** HTTPS credential helpers, SSH commands, proxy and CA settings are
  accepted from the caller's direct global Git config (without includes) or transport-only
  `GIT_CONFIG_COUNT` entries; `GIT_SSH`/`GIT_SSH_COMMAND` are honored only for transport. Put approved
  transport settings in that trusted configuration, not a plugin checkout. Checkout-controlled
  executable config/includes are refused before fetch; hooks, filters, external diffs, `ext` protocol
  and TLS-verification bypass remain disabled.
- **Failed reprovision:** units, selectors, `env.sh` and the previous successful `runtime/provision.json`
  are restored together. The failed attempt is recorded separately in `runtime/provision-failed.json`;
  without a prior successful runtime, `provision.json` honestly reports failure.
- **Abandoned provision lock:** empty/malformed records and dead/reused PIDs do not authorize stealing
  the lock. Verify the original provisioner has exited, explicitly remove
  `$IMG2_HOME/runtime/.provision.lock`, then rerun provision to recover parked units. Never remove a live owner's lock.

The rest of this README is the detailed reference: the document map, the manual step-by-step
install, explicit add/update/remove, discovery and layout.

## Documentation, and which one to read

| Document | Its job |
|---|---|
| [docs/PLUGIN_CONTRACT.md](docs/PLUGIN_CONTRACT.md) | **Normative.** The rules. Where anything else disagrees with it, it wins |
| [docs/WRITING_A_PLUGIN.md](docs/WRITING_A_PLUGIN.md) | **Your first plugin, start to finish.** A linear tutorial — copy [plugin-hello-cube](https://github.com/img2threejs/plugin-hello-cube) and follow it |
| [docs/plugin-wiki/](docs/plugin-wiki/README.md) | **Everything after that.** Why the architecture is shaped this way, eleven worked scenarios — add a domain, insert a step before a base step, add a gate, what to do instead of overriding one — and a field-by-field reference |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Changing the harness itself |
| [SECURITY.md](SECURITY.md) | The threat model, and how to review a plugin before installing it |
| [CHANGELOG.md](CHANGELOG.md) | What changed per release |
| [docs/PLAN.md](docs/PLAN.md) | Phase status and the decisions behind it |

`docs/PLUGIN_ARCHITECTURE.md` is a generated single-page build of the wiki — read the wiki instead,
unless you want the whole thing in one file.

Ecosystem discovery: `img2 plugins` reads the [official catalog](catalog.json). GitHub topic
`img2threejs-plugin` can also surface community repositories outside that catalog.

## Manual step-by-step install (reference)

`img2 setup` above does all of this for you. Use the manual steps when you want to control each
phase, or install a single plugin by hand.

### 1. Install the harness

You need **Node.js ≥ 18, Git and Python ≥ 3.10**. Configure at least one supported agent
host first: Claude Code, Codex or OpenCode. See [Prerequisites](#prerequisites) for detection
paths. Use CLI **0.4.0 or newer** for short plugin IDs and the branded table output.

```bash
npx --yes @img2threejs/img2@latest install --yes
```

This prepares the harness checkout and registry under `~/.img2`, configures supported host
access, and links an `img2` launcher into a writable directory on your `PATH` when possible.
Read the install output for the actual launcher location.

The first `--yes` belongs to **npx** and allows downloading the CLI package. The final
`--yes` belongs to **img2** and skips its confirmation prompt; omit it if you want to confirm
interactively. Neither flag authorizes replacement of an existing plugin.

### 2. Choose how to run the CLI

If the installed launcher is available, check it with:

```bash
img2 --version
img2 --help
```

If `img2` is not found, or its version is older than 0.4.0, use the latest CLI directly:

```bash
npx --yes @img2threejs/img2@latest plugins
npx --yes @img2threejs/img2@latest add cs2 --yes
```

For short commands that always use the latest published CLI, set this **bash/zsh alias**:

```bash
alias img2='npx --yes @img2threejs/img2@latest'
```

The alias takes precedence over an older launcher and lasts for the current shell session.
For zsh, add that line to `~/.zshrc` and run `source ~/.zshrc` to keep it in future sessions.
Every `img2 ...` example below also works as `npx --yes @img2threejs/img2@latest ...`.

**Existing installations:** `install` keeps the existing harness checkout; it does not
automatically upgrade an old launcher. Use the alias or the explicit `npx ...@latest` form
to get the new CLI without replacing your current registrations.

### 3. Browse plugins and install only what you need

```bash
img2 plugins       # official plugins available to install
img2 list          # plugins already registered on this machine
```

These are different lists. `plugins` reads the live official catalog; it does not install
anything and can run before harness setup. `list` reads your local registry.

| Plugin / source README | What it provides | Git source | Install after harness setup |
|---|---|---|---|
| [character](https://github.com/img2threejs/plugin-character) | Character rigging, skin conditioning, animation and rig gates | Public | `img2 add character --yes` |
| [cs2](https://github.com/img2threejs/plugin-cs2) | Counter-Strike 2 weapon/glove skin reconstruction and review gates | Public | `img2 add cs2 --yes` |
| [interior](https://github.com/img2threejs/plugin-interior) | Image/reference to an interior scene: Blender authoring, PBR, render/repair and verified delivery | Public | `img2 add interior --yes` |
| jev | Bounded image-aware decision advisories and repair advice; never acceptance authority | **Private — authorized Git access required** | `img2 add jev --yes` |
| [pixi2d](https://github.com/img2threejs/plugin-pixi2d) | Explicit 2D image reconstruction in PixiJS with editable nodes and a blocking review gate | Public | `img2 add pixi2d --yes` |

The table lists announced plugins; use `img2 plugins` for the current catalog. You do not
need to install all of them. For a small first installation:

```bash
img2 add cs2 --yes
img2 list
img2 doctor
img2 sync --check
```

`add` resolves a bare ID through the catalog, clones its Git source, validates the requested
manifest identity, pins the resolved commit and links the skill into detected hosts. It
does **not** run a reconstruction. `doctor` is a static installation audit, not a visual
quality or reconstruction acceptance check. `sync --check` verifies that generated files
match the registered manifests.

#### Runtime dependencies

`img2 provision` installs and verifies everything the plugins run on (Blender `bpy` in two separate
environments, Playwright + Chromium, Three, NumPy/Pillow, Source2Viewer-CLI + .NET, the vision stack and the
MCP servers) from `dependencies.lock.json` into `$IMG2_HOME/runtime/`:

```bash
img2 provision --plan            # sizes per environment; writes nothing
img2 provision                   # default:true plugins only (four domains, no Jev); one confirmation, --yes skips it
img2 provision --minimal         # provision profile: no vision, MCP servers or extra browsers (not `setup --minimal`)
img2 provision --plugins character,jev --skip cs2-dotnet-runtime
img2 doctor --runtime            # proves each piece works; non-zero exit on any failure
img2 provision --remove          # removes only what provisioning created
```

Artifacts are verified against the lock before use (SHA-256, or SHA-512 SRI for npm and .NET); entries
the lock pins only by MD5/CRC32C/git SHA-1 (Playwright browser bundles, some model files) are refused
unless `--allow-weak-hash`, which records a locally computed SHA-256 in `provision.json`. Exit codes: 0 ok,
1 failed step or red doctor, 2 refused before running, 3 declined. Windows is refused.

### 4. Use the installed plugin in your agent

Start a new agent session, or restart the current one, so updated skills are loaded.
Open the plugin's linked README above for its inputs, setup and workflow; follow its
`SKILL.md` and tool instructions for the actual task. For example, ask your agent:

```text
Use the cs2 skill with ./reference.png. Follow the plugin's instructions,
produce the reconstruction output, and report the output files and checks performed.
```

The harness manages installation and capability lookup. It does not generate a model just
because a plugin was added, and it does not replace each plugin's usage instructions.

### 5. Check for updates, update or remove a plugin

```bash
img2 update cs2 --check   # check this plugin without replacing it
img2 update cs2           # install a newer available version
img2 doctor                     # audit again after changes
img2 remove cs2          # unlink owned host links and back up the managed checkout
```

Omit the ID from `img2 update` to inspect/update the harness checkout and all registered
plugins; `img2 update harness` handles only the harness. The harness checkout moves to the newest
tag only when its origin is the official repository, it has no local changes, and it is behind
that tag. `update --check`
exits **1 when an update is pending**, and 0 when none is pending; no checkout is replaced.

### Automatic plugin installation by agent skills

`npx --yes @img2threejs/img2@latest install --yes --auto-install` additionally records your
opt-in in `$IMG2_HOME/auto-install`. Afterwards an agent skill may run
`img2 ensure <plugin-id>`, which only adds a missing **public** official plugin, never updates
or replaces one, and accepts no options. Without the marker, or with `IMG2_AUTO_INSTALL=0`,
`ensure` exits 3 and changes nothing. Delete the marker to opt out. The marker records your
choice; it is not a security boundary. Agent skills are instructed never to write it, but an
agent that can write files under `$IMG2_HOME` could create it, which is why `ensure` is limited
to public official catalog plugins.
Git updates follow the newest reachable semver tag, but a full-SHA pin is never compared to tag text:
an ancestor tag leaves the pin intact, only a proven descendant release may advance it, and an
unrelated history is refused. Use a reviewed updated setup lock or explicit `add --ref` for a
deliberate pin change. Local `--link` checkouts are live and
are not fetched by `update`. Removal drops the registry row and its user-authored overrides;
it does not delete the original source checkout of a local link.

### Organization npm installers

The standalone installers are public packages in the
[`@img2threejs` npm organization](https://www.npmjs.com/org/img2threejs):

| Plugin | npm package | Install, including harness setup if missing |
|---|---|---|
| character | [@img2threejs/character](https://www.npmjs.com/package/@img2threejs/character) | `npx --yes @img2threejs/character install --yes` |
| cs2 | [@img2threejs/cs2](https://www.npmjs.com/package/@img2threejs/cs2) | `npx --yes @img2threejs/cs2 install --yes` |

Run the same command with `--dry-run` instead of `--yes` to preview without writes.
Use `doctor` to audit the installation, `update --check` to check plugin releases, and
`remove --yes` to remove an installed plugin. Installer packages contain only the CLI;
plugin source is fetched separately at the package's immutable commit pin. They use
`@img2threejs/img2@0.4.0` and do not run a reconstruction.

The npm package name and executable differ: a global installation of
`@img2threejs/cs2` provides `img2-cs2`, and likewise for character.
`img2 add <id>` still resolves the plugin's Git source, not its npm installer.

### Refs, replacement and common refusals

| Situation / option | What to do |
|---|---|
| No harness checkout | Run `img2 install --yes` before `img2 add <id>` |
| Unknown plugin ID | Check `img2 plugins`; bare IDs must be in the official catalog |
| Catalog/network unavailable | Retry when reachable, or use a known explicit Git/npm/local source |
| Git access denied for a private source | Obtain repository permission and configure Git authentication |
| Plugin already registered | Use `img2 list` and `img2 update <id>`; adding it again does not silently replace it |
| Registered as a local link | Keep using that checkout, or explicitly choose replacement with `--force` |
| `--ref <ref>` | Select an existing Git tag, branch or full commit SHA instead of automatic tag selection |
| `--home <absolute-path>` | Select the same harness home for every related command; the default is `~/.img2` |
| `--yes` | Skip consent prompts; it is **not** permission to overwrite a registration |

For a ref-pinned install, use a real ref from that plugin's repository:

```bash
img2 add cs2 --ref main --yes
```

Only when you deliberately want to replace an existing registration:

```bash
img2 add cs2 --force --yes
```

`--force` backs up the previous managed checkout or mount before replacement. If the
registration is a local link, the original linked checkout remains intact. Without
`--force`, a local registration is refused before catalog access or cloning.

Explicit `org/repo`, Git URLs, `npm:<name>` and `--link` continue to work without catalog
access. Sources outside the default GitHub org/npm scope need `--allow-any-source`;
review them before authorizing installation. Unknown catalog IDs and identity mismatches
exit 2; catalog/network failures exit 1 without changing install state.

### Discover plugins

```bash
npx --yes @img2threejs/img2@latest plugins
npx --yes @img2threejs/img2@latest plugins --json
```

No harness installation, GitHub credentials or local registry is needed to list the catalog;
only Node.js ≥ 18 and internet access. Each call fetches the maintained
[`catalog.json`](https://raw.githubusercontent.com/img2threejs/img2/main/catalog.json) from GitHub
with a ten-second request/body timeout. Catalog updates do not require a new npm release.

The count covers officially announced plugins, including private sources with public installers;
it is not npm search, a census of hidden repositories, or the locally registered set (`img2 list`).
Each entry includes its description, GitHub source, source visibility, optional npm CLI and a
copyable install command. Private-source installation still requires authorized repository access.
Listing never installs plugins, reads registrations or creates a harness home.

`--json` returns `counts` (`total`, `public`, `private`, `npmClis`) and `plugins`, with each
`install` represented as an argv array. Fetch/validation errors exit 1 with `status: "error"` and
`counts: null`, never a false zero. Invalid command arguments exit 2 before fetching.
Maintainers add or update announced entries in the root `catalog.json` (schema 1); unpublished
private repositories must remain outside the public catalog.

### CLI presentation

Human output includes the img2threejs wordmark, a colored pixel-to-cube terminal logo,
and the brand slogan: “Rebuild the object in a reference image as a code-only, procedural
Three.js model.” Catalogs, registrations, audit findings, metadata, help and update outcomes
use bounded-width tables; narrow multi-column records become Field/Value tables.

`install` and `add` show numbered phases, actual host-link outcomes, the selected ref/pin,
backup locations when replacing an installation, and a copyable `doctor` command on success.
Plugin CLI wrappers using SDK 0.4.0 use the same presentation for offline previews and
already-registered installs. Wrappers pinned to an older SDK retain their existing UI.
Registration alone is not a health check; run `doctor` for that.

Color is enabled only on the corresponding terminal stream. Set `NO_COLOR=1` to disable it;
`TERM=dumb` is also plain. Redirected/piped output stays uncolored even with `FORCE_COLOR`.
Narrow terminals stack fields and wrap messages without truncating paths or refs.
Machine-readable `--json` output, implicitly-JSON `capabilities`, and exit codes are unchanged;
they never include a banner or table.

Use `npx @img2threejs/img2@latest <command>` to pick up installer updates.
`install` keeps an existing harness checkout; it does not automatically upgrade an older
`img2` launcher pointing into that checkout.

The harness publishes to npm as the scoped package `@img2threejs/img2`. There is no unscoped
fallback: a wrapper that depends on `img2` resolves a different package on npm and will not
satisfy the wrapper's `@img2threejs/img2/plugin-cli` import.

## Plugin CLI wrapper

A plugin's author can ship a CLI wrapper alongside the plugin repo. The wrapper lives in the
plugin's `cli/` subdirectory, is published to npm under a name like `img2-<plugin-id>`, and lets
end users install/update/remove the plugin without the harness on their machine first:

```bash
npx --package=@img2threejs/img2 create-img2-plugin-cli \
    --directory ~/src/plugin-foo \
    --name img2-foo \
    --source img2threejs/plugin-foo \
    --workflow-ref 7ef63107b39f77df3a11062a1a0a2245f500921c
```

The generator creates an installer-only `cli/` package, isolated-home regression tests,
public CLI README/license, `.gitignore`, a SHA-pinned `.github/workflows/cli-publish.yml`,
and a complete root `CLI_QUICKSTART.md`. For a private GitHub source, add `--private-repo`.
End users run `npx img2-foo install --dry-run`, then `npx img2-foo install --yes`.
The package ships only its executable, package metadata and public README/license—not the
plugin repository's README, tools or assets. The shared runtime is pinned to the generator's
exact harness version.

See [`docs/WRITING_A_PLUGIN.md`](docs/WRITING_A_PLUGIN.md) and the
[generated quick-start template](templates/plugin-cli/CLI_QUICKSTART.md).

## Prerequisites

- Node.js ≥ 18
- Git (the harness uses it for clone/checkout)
- Python 3.10+ (the bundled `img2_core/` is stdlib-only Python)

Detected agent hosts: **Claude Code** (`~/.claude`), **Codex** (`~/.codex`), and
**OpenCode** (`$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`). The harness does not
support any other host; check `img2 doctor --json` for the current host detection on your
machine.

## Asking which provider serves a capability

`img2 capabilities` answers "which installed plugin turns X into Y" for a caller — a base pipeline
consulting it at a step, or you at a prompt. It is read-only, takes no lock and writes nothing.

```bash
img2 capabilities --from-kind image --to-kind glb --json
```

```json
{ "version": 1, "contract": 14,
  "query": { "from": "image", "to": "glb" },
  "status": "answered",
  "providers": [{ "plugin": "img2glb", "version": "0.1.0", "resolvedSha": "353a8ea…",
                  "dir": "/Users/you/.img2/plugins/img2glb",
                  "steps": [{ "id": "generate-glb", "argv": ["python3", "…/tools/img2glb.py",
                              "--image", "{image}", "--workspace", "{workspace}"] }],
                  "gateRunner": { "argv": ["python3", "-m", "img2_core.gate_runner", "…"] } }],
  "problems": [] }
```

Four properties a caller can rely on:

- **One JSON envelope on stdout for every outcome it owns**, including failures. Branch on `status`
  (`answered` | `ambiguous` | `data-fault`) — never on stderr text.
- **Step commands come back as `argv` arrays**, already tokenised, with `{plugin_dir}` resolved and
  `{workspace}`/`{image}` left as single elements to replace by value. You never build a shell string,
  so a path containing a space cannot split and a plugin cannot smuggle in a second command.
- **Exit codes reuse the harness table**: `0` answered (zero providers is a normal answer), `1` a data
  fault, `3` an ambiguous edge — resolve it with `--plugin <id>`. This subcommand never exits `2`, so
  `2` still means "this harness does not understand you".
- **One broken plugin cannot deny an unrelated answer.** A plugin whose manifest fails to read lands
  in `problems[]` while `providers[]` still answers.

To detect whether a harness supports this at all, without parsing prose:

```bash
img2 --version --json    # {"harness":"0.4.0","maxPluginSchema":1,"coreApi":1,
                         #  "contract":14,"commands":[…,"capabilities"]}
```

An unrecognised `--json`, or `capabilities` missing from `commands`, means the feature is absent —
treat that as "no provider" and take your built-in path, rather than as an error.

Developing a plugin locally:

```bash
img2 add --link ~/src/plugin-hello-cube   # symlink, no clone; ref/sha recorded as "local"
```

A plugin can also be distributed as an npm package instead of a git repo — `img2 add npm:<name>`
or `img2 add npm:<name>@<version>` (default source trust is the `@img2threejs` scope, same rule as
the `img2threejs/*` git org: anything else needs `--allow-any-source`). `ref` records the resolved
version and `resolvedSha` records npm's own `dist.integrity` (a `sha512-…` string) rather than a git
SHA — the harness's own notion of "pinned content hash" for a package it fetched instead of cloned.
`img2 update [<id>] [--check]` re-checks every row's source (npm version, git's newest semver tag) for
something newer and fetches it in place; `--check` reports what is pending without changing anything.

Layout under `$IMG2_HOME` (default `~/.img2`; the deprecated `IMG2THREEJS_HOME` is honoured
for one release with a warning):

```
harness/        canonical harness checkout (img2_core lives here)
plugins/<id>/   one clone (or --link symlink, or npm fetch) per registry row
generated/      index.md + routes.json, regenerated by `img2 sync`
plugins.json    the registry: flat rows {id, repo, ref, resolvedSha, addedAt}
                repo is "org/repo", a git URL, "npm:<name>", or "link:<path>"
receipts.json   what was linked where
backups/        displaced directories; nothing is ever deleted in place
```

Plugin tools reach the Python core through the generated `_img2_local.py` (gitignored by
contract) or `$IMG2_HOME`; `img2_core.require_core_api(1)` asserts the core API at runtime.
Gates run through `python3 -m img2_core.gate_runner --plugin-dir <dir> --workspace <dir>`,
which topo-sorts `gates.json`, expects one `img2.gate-verdict` JSON envelope per gate on
stdout, and stops on a blocking fail.

## Tests

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests/python -p 'test_*.py'
```

Both suites are dependency-free (node:test and unittest only). Run them from the repo root.
