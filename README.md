# img2

Plugin harness for the img2 ecosystem: everything is a plugin. The harness ships no domain
capability — it owns install/link plumbing, the plugin registry, the workspace state envelope,
the gate runner, and the contract.

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

## Quickstart

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
npx --yes @img2threejs/img2@latest add hello-cube --yes
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
| [environment](https://github.com/img2threejs/plugin-environment) | The environment plugin, distributed from a private repository | **Private — authorized Git access required** | `img2 add environment --yes` |
| [hello-cube](https://github.com/img2threejs/plugin-hello-cube) | A small deterministic image-to-Three.js cube example | Public | `img2 add hello-cube --yes` |
| [img2glb](https://github.com/img2threejs/plugin-img2glb) | Image-to-GLB mesh generation through the hosted TRELLIS space | Public | `img2 add img2glb --yes` |

The table lists announced plugins; use `img2 plugins` for the current catalog. You do not
need to install all of them. For a small first installation:

```bash
img2 add hello-cube --yes
img2 list
img2 doctor
img2 sync --check
```

`add` resolves a bare ID through the catalog, clones its Git source, validates the requested
manifest identity, pins the resolved commit and links the skill into detected hosts. It
does **not** run a reconstruction. `doctor` is a static installation audit, not a visual
quality or reconstruction acceptance check. `sync --check` verifies that generated files
match the registered manifests.

### 4. Use the installed plugin in your agent

Start a new agent session, or restart the current one, so updated skills are loaded.
Open the plugin's linked README above for its inputs, setup and workflow; follow its
`SKILL.md` and tool instructions for the actual task. For example, ask your agent:

```text
Use the hello-cube skill with ./reference.png. Follow the plugin's instructions,
produce the Three.js output, and report the output files and checks performed.
```

The harness manages installation and capability lookup. It does not generate a model just
because a plugin was added, and it does not replace each plugin's usage instructions.

### 5. Check for updates, update or remove a plugin

```bash
img2 update hello-cube --check   # check this plugin without replacing it
img2 update hello-cube           # install a newer available version
img2 doctor                     # audit again after changes
img2 remove hello-cube          # unlink owned host links and back up the managed checkout
```

Omit the ID from `img2 update` to inspect/update all registered plugins. `update --check`
exits **1 when an update is pending**, and 0 when none is pending; no checkout is replaced.
Git updates follow the newest reachable semver tag. Local `--link` checkouts are live and
are not fetched by `update`. Removal drops the registry row and its user-authored overrides;
it does not delete the original source checkout of a local link.

### Organization npm installers

The standalone installers are public packages in the
[`@img2threejs` npm organization](https://www.npmjs.com/org/img2threejs):

| Plugin | npm package | Install, including harness setup if missing |
|---|---|---|
| character | [@img2threejs/character](https://www.npmjs.com/package/@img2threejs/character) | `npx --yes @img2threejs/character install --yes` |
| cs2 | [@img2threejs/cs2](https://www.npmjs.com/package/@img2threejs/cs2) | `npx --yes @img2threejs/cs2 install --yes` |
| environment | [@img2threejs/environment](https://www.npmjs.com/package/@img2threejs/environment) | `npx --yes @img2threejs/environment install --yes` |

Run the same command with `--dry-run` instead of `--yes` to preview without writes.
Use `doctor` to audit the installation, `update --check` to check plugin releases, and
`remove --yes` to remove an installed plugin. Installer packages contain only the CLI;
plugin source is fetched separately at the package's immutable commit pin. They use
`@img2threejs/img2@0.4.0` and do not run a reconstruction.

The npm package name and executable differ: a global installation of
`@img2threejs/cs2` provides `img2-cs2`, and likewise for character/environment.
`img2 add <id>` still resolves the plugin's Git source, not its npm installer.

### Private environment plugin

The [environment source](https://github.com/img2threejs/plugin-environment) requires a
GitHub account with repository access and working Git credentials. A private GitHub link
may appear as 404 when you are signed out or lack permission. The public
[`@img2threejs/environment` npm installer](https://www.npmjs.com/package/@img2threejs/environment) does
**not** grant access to that source.

With the harness installed and Git access configured:

```bash
img2 add environment --yes
img2 doctor
```

Alternatively, the standalone installer can preview an installation without changes and
bootstrap the harness when installing:

```bash
npx --yes @img2threejs/environment install --dry-run
npx --yes @img2threejs/environment install --yes
```

The organization installer pins SDK `0.4.0` and plugin source commit `c19f5f2`.
Newer local environment development is not included in this installer.

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
img2 add hello-cube --ref main --yes
```

Only when you deliberately want to replace an existing registration:

```bash
img2 add environment --force --yes
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
