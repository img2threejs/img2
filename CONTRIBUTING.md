# Contributing

Two kinds of contribution, two paths:

- **A new capability** (image→X, X→threejs, …) is a **new plugin in its own repo** — it
  never lands in this repo. Follow `docs/WRITING_A_PLUGIN.md`; copy
  [`plugin-hello-cube`](https://github.com/img2threejs/plugin-hello-cube) as the starter. For what the
  tutorial does not cover — adding a whole domain, placing a step relative to a base step, or what to
  do when you want to override a gate — see [`docs/plugin-wiki/`](docs/plugin-wiki/README.md).
- **A change to the harness itself** (CLI, `img2_core`, the contract) belongs here. Read on.

## House rules (enforced, not aspirational)

- `bin/` is Node ≥18, ESM, **zero npm dependencies**. `img2_core/` is Python ≥3.10,
  **stdlib only**. If your change needs a dependency, the design is wrong for this repo.
- Fail loud. No silent fallbacks, no warn-and-continue on version or schema mismatches —
  a crash is strictly cheaper than a wrong model (see `docs/PLAN.md` D6).
- The harness never imports or executes plugin code; every check on plugins is static.
- Code comments only for constraints the code cannot express.
- Exit codes are API: `{OK:0, FAIL:1, REFUSED:2, NEEDS_INPUT:3}` — don't invent new ones.

## Tests

```bash
npm test                                                      # both suites
node --test tests/*.test.mjs                                  # CLI only
python3 -m unittest discover -s tests/python -p 'test_*.py'   # img2_core only
```

Use the glob, not `node --test tests/`: the directory form walks into `tests/python/` and fails on the
Python files, reporting red on a green tree.

Both suites must be green before any push. Re-run them after bumping `package.json` — the version is
asserted through the exported `harnessVersion()`, and a bump with a stale expectation shipped red
once already (v0.1.1). Behavior changes need a test that fails
without the change — the lost-update fix (`tests/python/test_state.py`) is the model:
it demonstrably catches the bug it guards against.

## Changing the contract

`docs/PLUGIN_CONTRACT.md` is normative — plugins in the wild are written against it.

- A change that breaks an existing conforming plugin bumps `MAX_PLUGIN_SCHEMA` /
  `CORE_API_VERSION` and states the migration in the contract itself.
- The §-numbered structure is load-bearing (code and docs cite sections); don't renumber.
- The v1 cut list (contract §5, plan decisions table) is deliberate: layering,
  enable/disable, capability chains, `env`/`hostRequirements` manifest fields stay out
  until a NAMED consumer needs them. "Might be useful" is not a consumer.

## Releases

Tag `vX.Y.Z` (annotated) matching `package.json`; `img2 add` and self-installs resolve
the newest semver tag. Keep `docs/PLAN.md` phase status current when a release changes
what is true.

## Publishing

The harness itself ships to npm as the scoped package `@img2threejs/img2` (the unscoped
name `img2` is too similar to an existing `img-2` and is npm-refused). `.github/workflows/ci.yml`
and `publish.yml` call reviewed shared workflows pinned by full commit SHA, never a moving
branch or tag. Update the pin only after reviewing the shared workflow change.

To release: bump `package.json`, update `CHANGELOG.md`, commit reviewed files, and push a
matching annotated `vX.Y.Z` tag. The OIDC workflow validates the version, installs dependencies
without lifecycle scripts, runs `npm test` without publish permission, packs that tested tree,
and publishes the exact artifact. Only the separate publish job can obtain an OIDC credential.
An existing version must match the tested bytes; rerunning it does not reset its dist-tag.
Stable versions publish to `latest`, prereleases such as `v0.3.0-beta.1` to `beta`.

The first version of a new package must be published manually before npm allows trusted
publisher configuration. `@img2threejs/img2@0.2.3` is the bootstrap package.
Configure the GitHub caller workflow **filename** with npm >=11.15, package write permission
and account-level 2FA:

```bash
npm exec --yes --package=npm@11 -- npm trust github @img2threejs/img2 \
  --repo img2threejs/img2 --file publish.yml --allow-publish --yes
```

The npm website settings are equivalent. Actions use no npm write token or token fallback.
Publishing runs on GitHub-hosted Node 24/npm >=11.5.1; CLI consumers still support Node >=18.
Provenance requires a public source repository and public npm package. A private-source
plugin's generated CLI workflow must use `provenance: false`; this workflow publishes
public npm packages only.
