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
