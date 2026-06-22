# Changelog

Notable changes to Vivary. The project ships several **independently versioned**
packages, so each entry names the package(s) it affects. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the initial suite release is
the `v0.1.0` line.

**Current versions:** `vivary-tropo` **0.2.0** · `create-vivary` / `@vivary/create` **0.2.2** · `vivary-ozone` / `vivary-exo` **0.1.0**.

## [0.2.2] — 2026-06-21

Affects `create-vivary` (PyPI) and `@vivary/create` (npm) only.

### Fixed

- **Supersedes 0.2.1** — use 0.2.2 for new installs. PyPI 0.2.1 was installable,
  but it was replaced by a clean CI-reviewed release after generated build artifacts
  were removed from the source tree. npm 0.2.1 was not live; 0.2.2 is the npm/PyPI
  lockstep release users should install.
- **Clean release provenance** — the repository source tree no longer includes the
  generated 0.2.1 wheel/sdist artifacts, and the release was re-cut after branch
  protection and CI-gated PR flow were restored.

No runtime API changes are expected for users already on 0.2.1; this is a source
and release-hygiene hotfix.

## [0.2.1] — 2026-06-21

Affects `create-vivary` (PyPI) only; no live `@vivary/create` npm 0.2.1 release was
published.

### Fixed

- **Wizard installs LanceDB inline** — when the interactive wizard's user picks "on this
  computer" (embedded storage), LanceDB now installs immediately as part of the wizard
  conversation. Previously, a second standalone "Install lancedb? [Y/n]" prompt appeared
  after the wizard ended, which was jarring and broke the mental model (the wizard IS the
  consent step).
- **`--auto` implies `--yes` for installs** — `create-vivary init . --auto --size large`
  no longer hangs on the install prompt. `--auto` means fully unattended; it now implies
  `yes=True` for every install step, so agents don't need to pass both `--auto` and `--yes`.
- **`wizard` subcommand** has the same two fixes applied.

## [0.2.0] — 2026-06-21

Affects `vivary-tropo` and `create-vivary`. `vivary-ozone` and `vivary-exo` are unchanged at 0.1.0.

### Added

- **Storage layer in tropo** — tiered storage abstraction: `file` (default, no new deps),
  `embedded` (LanceDB on disk, `pip install vivary-tropo[embedded]`), and `cloud` adapter
  interface (0.3.x). Config lives in `.vivary/storage.toml`. Optional extras:
  `vivary-tropo[embedded]`, `vivary-tropo[cloud]`, `vivary-tropo[astra]`.
- **`tropo migrate`** — move graph nodes between backends
  (`--from file --to embedded [--dry-run] [--json] [--yes]`).
- **`tropo query`** — text search over the workspace knowledge graph
  (`tropo query "auth module" [--k N] [--json]`).
- **Agent-mode flags on `create-vivary init`** — `--json`, `--dry-run`, `--auto`,
  `--yes`, `--no-wizard`, `--storage`, `--provider`, `--size`, `--privacy`.
  Agents can now self-configure a workspace end-to-end without human interaction.
- **`create-vivary wizard` subcommand** — reconfigure storage on an existing workspace.
- **Interactive setup wizard** — `create-vivary init` now prompts interactively when
  run from a TTY (human-friendly, no database jargon). `--no-wizard` or `--auto` skips it.
- **`.vivary/data/` in scaffolded `.gitignore`** — runtime storage data is always ignored.
- **`doctor` reports `backend` field** — JSON output now includes `"backend": "file|embedded|cloud"`.
- **Spec:** `docs/SPEC-data-layer.md` — full architecture rationale and agent CLI contract.

### Changed

- `create-vivary init` with `--storage embedded` self-installs `vivary-tropo[embedded]`
  (with confirmation unless `--yes`).
- `--dry-run` on `init` simulates the full scaffold without writing any files.

## [create-vivary 0.1.1] — 2026-06-14

Affects `create-vivary` (PyPI) and its npm launcher `@vivary/create`, released in
lockstep. The other three packages are unchanged at 0.1.0.

### Fixed

- A bare target now defaults to the `init` subcommand, so the documented
  `npm create @vivary <name>` and `uvx create-vivary <name>` scaffold a workspace
  without an explicit `init` (previously failed with argparse `invalid choice: …`).
  Explicit `init` / `doctor` and leading flags (`-h` / `--help`) pass through unchanged.
  npm launcher: [#33](https://github.com/vivary-dev/vivary/pull/33). Python CLI parity:
  [#35](https://github.com/vivary-dev/vivary/pull/35).

## [0.1.0] — 2026-06-14

Initial public release — all four layers on PyPI, the scaffolder also on npm.

### Added

- `vivary-tropo` — typed knowledge-graph CLI (`check` / `signal` / `types` / `stats` /
  `graph` / `blast` / `view` / `plan` / `fix` / `init`); `check` is strict by default.
- `vivary-ozone` — review layer (`review` / `impact` / `packs`).
- `vivary-exo` — coordination layer (`conflicts` / `board` / `roles`).
- `create-vivary` (PyPI) / `@vivary/create` (npm) — agent-workspace scaffolder
  (`init` / `doctor`; presets: `coding` · `second-brain` · `writing`).
