# Changelog

All notable changes to **img2** (the plugin harness) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`MAX_PLUGIN_SCHEMA` and `CORE_API` are separate compatibility surfaces from the harness version. A
change that breaks a conforming plugin bumps one of those and states the migration in
`docs/PLUGIN_CONTRACT.md` itself.

## [0.2.2] — 2026-09-02

### Added

- **`gate_runner.py --gate-timeout`** and a per-gate child environment. Each gates.json row now runs
  under its own timeout (default 300s) instead of hanging the whole run; a timed-out gate reports
  `error` with the bound named. Shipped earlier under an unchanged 0.2.1, which meant a plugin could
  not express `requires.harness` for it and an installed 0.2.1 harness silently lacked the flag —
  this release exists so the feature is addressable by version.
- `steps.json` `provides` rows and every declaration file a plugin ships are validated at doctor
  time: schema/version bounds, artifact kind/path (confined under `.img2/artifacts/<plugin-id>/`),
  and a `deterministic` boolean beside every `provides`.
- A plugin wiki under `docs/plugin-wiki/`: why the skill was refactored, how the pieces fit, eleven
  worked scenarios for building a plugin, and a field-by-field reference.
  `docs/PLUGIN_ARCHITECTURE.md` is a generated single-page build of it.
- `SECURITY.md` — the threat model, the properties the harness does and does not guarantee, and how to
  review a plugin before installing it.
- This changelog.

### Fixed

- `{plugin_dir}` is now resolved in an `instruction` row, not only in `argv`. A prose row pointing at a
  plugin's own reference page previously handed back an unresolved placeholder.

## [0.2.1] — 2026-08-25

### Fixed

- **The capability query now refuses what `doctor` refuses.** They had drifted: the query answered
  `exit 0` with `problems: []` while handing back a row whose `argv[0]` was the prose word `Read` —
  which resolves on a case-insensitive filesystem to `/usr/bin/read` and exits 0, so a caller executing
  it would report success having run something entirely unintended. Both paths now validate through one
  `rowFinding()`, so they cannot disagree about what is executable.
- **Closed the prose-as-argv hole with a declared row `actor`.** A step row is `program` (default),
  `agent`, or `human`. A `program` row's `argv[0]` must be a path form or one of
  `python3 python node bash sh` — a bare word is refused. A non-program row is returned as an
  `instruction` with **no `argv` key at all**, and an unknown actor is refused rather than defaulted.

## [0.2.0] — 2026-08-25

### Added

- **`img2 capabilities`** — resolves installed providers by **declared typed capability edge**, never
  by name similarity. Read-only, takes no lock, writes nothing. One JSON envelope on stdout for every
  outcome it owns, including failures; branch on `status` (`answered` | `ambiguous` | `data-fault`),
  never on stderr text. Step commands come back as tokenised `argv` arrays with `{plugin_dir}` resolved.
  Zero providers is a normal answer, not an error. One broken plugin lands in `problems[]` while
  `providers[]` still answers.
- `img2 --version --json` so a caller can detect feature support without parsing prose.

## [0.1.1] — 2026-08-24

### Fixed

- Link an `img2` launcher onto a writable `PATH` directory at install, and ship the CLI executable.
  Without it, the documented quickstart did not work from a fresh install.
- Derive the expected harness version in tests instead of hardcoding it — a version bump with a stale
  expectation shipped red once, which is why `CONTRIBUTING.md` now says to re-run both suites after a
  bump.

### Documentation

- `docs/WRITING_A_PLUGIN.md` and `CONTRIBUTING.md`.
- Mandate the `$SKILL_DIR` invocation convention for plugin skills.
- Warn that `node --test tests/` (directory form) walks into `tests/python/` and reports red on a green
  tree. Use the glob.

## [0.1.0] — 2026-08-24

First release. The harness ships **no domain capability** — it owns install and link plumbing, the
plugin registry, the workspace state envelope, the gate runner, and the contract.

### Added

- **CLI**: `install`, `add`, `remove`, `list`, `doctor`, `sync`. `add` accepts `org/repo`, a URL, or
  `--link <localpath>` for a symlinked local checkout. Source is allow-listed to the `img2threejs` org
  unless `--allow-any-source` is given, which prints what it will clone.
- **`img2_core`** (Python 3.10, stdlib only): `paths`, `state`, `gate_runner`, and
  `require_core_api(1)`.
- **`$IMG2_HOME` layout** with `plugins.json` as a flat registry, `receipts.json` recording what was
  linked where, and `backups/` — nothing is ever deleted in place.
- **The gate contract**: one `img2.gate-verdict` envelope per gate on stdout, exit `0` pass / `1` fail /
  `2` error, and a malformed envelope treated as `error` rather than as a pass.
- **`doctor`** as a fail-loud static audit: manifest schema, declared files exist, id and link
  uniqueness, shell-metacharacter refusal, closed-placeholder enforcement, topo-sortable steps and
  gates, and `_img2_local.py` covered by `.gitignore`.
- `docs/PLUGIN_CONTRACT.md` as the normative contract.

### Fixed

- Resolve the `_img2_local` fallback from `tools/`, and close the state lost-update window — a separate
  load → mutate → save with the lock held only at save. `img2_core.state.update_plugin_state` now holds
  the lock across the whole read-modify-write, and `tests/python/test_state.py` demonstrably catches the
  bug it guards against.

[Unreleased]: https://github.com/img2threejs/img2/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/img2threejs/img2/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/img2threejs/img2/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/img2threejs/img2/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/img2threejs/img2/releases/tag/v0.1.0
