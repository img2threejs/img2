# Security

## Reporting

Open a private security advisory on this repository, or contact the maintainers directly. Do not open a
public issue for anything exploitable.

Include the command you ran, the harness version (`img2 --version --json`), and a reproduction against
a clean `$IMG2_HOME`. A reproduction is worth more than a description.

## Threat model, stated plainly

This repository is the component that **installs and later executes third-party code on a developer's
machine**. `docs/PLUGIN_CONTRACT.md` §7 states the limit, and it is the honest one:

> A plugin is arbitrary code the agent will later execute in the user's workspace. `add` therefore pins
> (`resolvedSha`), attributes (registry row), and links under a harness-owned name — it cannot make the
> code safe, only make what runs identifiable and reproducible.

So the harness does not claim to sandbox plugins. It claims that **what ran is knowable after the
fact**, and that **nothing runs by surprise**. Those are the properties to attack.

## What the harness guarantees

| Property | Where it is enforced |
|---|---|
| **Plugin code never runs during `add`, `doctor` or `sync`.** All validation is static — the harness never imports or executes a plugin to inspect it. | contract §7, CONTRIBUTING house rules |
| **Nothing is executed through a shell.** Step and gate commands are returned as tokenised `argv` arrays; a caller never builds a shell string, so a path with a space cannot split and a plugin cannot append a second command. | contract §10, §13 |
| **Shell metacharacters are refused** in every `steps.json` / `gates.json` command. | `doctor`, contract §12 |
| **`argv[0]` must be a path form or a known interpreter** (`python3 python node bash sh`). A bare word is refused. | contract §10 |
| **Placeholders are a closed set** — `{plugin_dir}`, `{workspace}`, `{image}`. Anything else fails `doctor`. | contract §10, §12 |
| **Installs are pinned and attributed** — `resolvedSha` in `receipts.json`, a row in `plugins.json`, linked under a harness-owned name. | contract §7 |
| **Source is allow-listed.** The default is the `img2threejs` org; anything else requires `--allow-any-source`, which prints what it is about to clone. | contract §7 |
| **Nothing is deleted in place.** Displaced directories move to `backups/`. | `$IMG2_HOME` layout |
| **A plugin cannot change a pipeline.** `overrides` is user-authored in `plugins.json`; a plugin manifest declaring it is refused at install. | contract §6 |
| **A plugin cannot lower a quality floor.** The augmentation merge is raise-only and runs in base code, never delegated to the plugin. | base skill |
| **A plugin writes only its own state subtree**, through a lock held across the whole read-modify-write. | contract §11, §14 |

### Why `argv[0]` may not be a bare word

This one exists because of a real silent-success path, not a hypothetical. A step row whose command was
the prose sentence `Read the contract…` was handed back as `argv`. On a case-insensitive filesystem
`Read` resolves to `/usr/bin/read`, which exits 0 — so the step reported success having executed
something entirely unintended. On a stock macOS with Homebrew, `Analyze` resolves to an ImageMagick
binary, which would have run with the prose as its arguments.

The fix was structural: `doctor` and the capability query now validate every row through **one**
function, so they cannot disagree about what is executable, and a row that is prose declares
`actor: agent` and is returned with **no `argv` key at all**.

## What the harness does not protect you from

- **A malicious or compromised plugin.** Once a step runs, it runs with your privileges. Pinning tells
  you *what* ran; it does not stop it.
- **A plugin you installed with `--allow-any-source`.** That flag is the boundary; past it, provenance
  is yours to judge.
- **A plugin's own network egress or subprocesses.** The harness does not mediate them. Read a
  plugin's `SECURITY.md` before installing it.
- **`img2 add --link`.** A symlinked local checkout is live: every edit takes effect immediately, with
  no pin and no review step. It is a development convenience, not a trusted-install path.

## Reviewing a plugin before you install it

```bash
img2 add --allow-any-source <owner>/<repo>   # prints what it will clone, first
img2 doctor --json                            # every row, statically validated
img2 list                                     # id, version, ref, resolvedSha
```

Then read, at minimum: `plugin.json` (what capability it claims), `steps.json` and `gates.json` (what
commands will actually run), and anything under `tools/` that those commands invoke.

## Local files that must not be shared

`_img2_local.py` is generated per machine and holds an absolute path to your harness core. It is
gitignored by contract, and `doctor` fails a plugin whose `.gitignore` does not cover it. Do not commit
it and do not paste its contents into an issue.

`$IMG2_HOME/receipts.json` and `plugins.json` record local paths. Redact before sharing.

## Secrets

The harness requires no credentials, reads no environment secrets, and writes none. If you find a value
that looks like a token in this tree, treat it as a defect and report it.

## Supported versions

Security fixes land on the latest tag. There is no long-term support branch.

| Version | Supported |
|---|---|
| 0.2.x | yes |
| 0.1.x | no |
