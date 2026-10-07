# {{CLI_NAME}} quick start

The public npm installer lives in [`cli/`](cli/). Plugin implementation stays at the
repository root and is not included in the npm tarball.

## Install the plugin

Requires Node.js >=18, Git, Python >=3.10, and Claude Code, Codex or OpenCode.
Hermes is not supported by the img2 plugin harness.

```bash
npx {{CLI_NAME}} install --dry-run
npx {{CLI_NAME}} install --yes
npx {{CLI_NAME}} doctor
```

Installation creates the canonical img2 harness if missing, fetches `{{SOURCE}}`, and
links this plugin into detected hosts. It does not run a model or a reconstruction.
If no source ref was specified when generating the CLI, installation chooses the newest
semantic plugin tag, or warns and uses HEAD when the source is untagged.

For a private GitHub source, authenticate Git first:

```bash
gh auth login
gh auth setup-git
```

An authorized HTTPS Git credential helper is required. Setting `GITHUB_TOKEN` alone or
loading an SSH key does not configure credentials for this installer's HTTPS Git URL.

## Develop this installer

```bash
npm --prefix cli install
npm --prefix cli test
node cli/bin/cli.mjs install --dry-run
```

To run a globally installed CLI:

```bash
npm install -g {{CLI_NAME}}
{{CLI_NAME}} install --yes
```

## Publish the first npm version

Use Node >=22.14 and npm >=11.15 for release setup. The npm account needs package write
access and account-level 2FA. Review the package contents; never publish from the plugin root.

```bash
cd cli
npm test
npm pack --dry-run
npm publish --access public --ignore-scripts --provenance=false
cd ..
```

Then authorize the GitHub **caller** workflow filename, not the shared workflow filename:

```bash
npm exec --yes --package=npm@11 -- npm trust github {{CLI_NAME}} \
  --repo {{SOURCE}} --file cli-publish.yml --allow-publish --yes
```

The package must exist before this command can configure it. The npm website's trusted
publisher settings are equivalent. No npm write token is stored in Actions.

## Publish subsequent releases automatically

Bump `cli/package.json` and release notes, review and commit only intended changes, then
push a matching annotated `cli-vX.Y.Z` tag. For example, after bumping to `0.1.1`:

```bash
git tag -a cli-v0.1.1 -m 'CLI 0.1.1'
git push origin cli-v0.1.1
```

`.github/workflows/cli-publish.yml` tests, packs and publishes the exact tested tarball.
Stable CLI versions use npm's `latest` channel. Plugin source tags `vX.Y.Z` remain separate
from CLI release tags `cli-vX.Y.Z`.

For a private source repository, generate with `--private-repo`; provenance must be
`false`, even though the npm installer is public. Private plugin Git access is still
required by users. Restrict repository write and release-tag creation to maintainers.

See [`cli/README.md`](cli/README.md) for CLI command details and
[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) for authentication.
