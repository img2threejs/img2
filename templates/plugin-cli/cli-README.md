# {{CLI_NAME}}

Public installer for the img2 plugin **{{PLUGIN_ID}}**, sourced from `{{SOURCE}}`.
This package contains the installer only; plugin implementation is fetched separately.

## Quick start

Requires Node >=18, Git, Python >=3.10, and Claude Code, Codex or OpenCode.
For a private source, configure an authorized HTTPS Git credential helper first;
`gh auth login` followed by `gh auth setup-git` is one supported setup.

```bash
npx {{CLI_NAME}} install --dry-run
npx {{CLI_NAME}} install --yes
npx {{CLI_NAME}} doctor
```

The shared runtime is `@img2threejs/img2`, pinned to an exact version. Installation
bootstraps the canonical harness under `$IMG2_HOME` (default `~/.img2`) and links this
plugin into detected hosts. Installing this npm package alone does not install a skill.
The harness does not support Hermes. Model/provider and reconstruction prerequisites
remain the plugin's responsibility; installation is not reconstruction acceptance proof.

## Commands

```text
{{CLI_NAME}} install [--ref <vX.Y.Z|40-char SHA>] [--home <absolute path>] [--yes] [--force] [--dry-run]
{{CLI_NAME}} update [--home <absolute path>] [--yes] [--check]
{{CLI_NAME}} remove [--home <absolute path>] [--yes]
{{CLI_NAME}} doctor [--home <absolute path>] [--json]
{{CLI_NAME}} version [--json]
{{CLI_NAME}} help
```

`--dry-run` performs no downloads, subprocesses or writes. `--force` changes only this
plugin's registered ref; local links and registrations from another source are protected.
An explicit `--ref` overrides the CLI's metadata pin. Without a pin, install chooses the
newest semantic plugin tag, or warns and uses HEAD if untagged. Use `update` to check or
apply subsequent semantic plugin releases. CLI and plugin versions are independent.

`doctor` audits the entire installed harness, including other plugins.
Exit codes: `0` success, `1` failure, `2` refused, `3` confirmation requires a terminal.

## Installer development

From the repository root:

```bash
npm --prefix cli install
npm --prefix cli test
npm --prefix cli pack --dry-run
```

The repository's `CLI_QUICKSTART.md` documents initial publication, trusted publisher
configuration and automatic `cli-vX.Y.Z` releases.
