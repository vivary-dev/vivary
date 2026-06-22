# Contributing

Vivary uses small, reviewed slices. Plan the verification before changing files, then
keep the implementation narrow enough that the tests and docs can move with it.

## Branches

- `dev` is the active integration branch.
- `prod` is reserved for finished product cuts.
- Feature work happens on short-lived `feat/*` branches cut from `dev`.
- Do not push directly to `dev` or `prod`; open a PR and let CI plus review gates run.

## Before You Change Code

State the intended slice, blast radius, tests, and docs impact before editing. For
code changes, add or update focused tests first when there is a clear seam; for docs
or repo-surface changes, name the exact verification commands in the PR.

## Pull Requests

Every PR should include:

- intent: what changed and why
- blast radius: files, packages, docs, graph surfaces, and downstream effects
- verification: local commands run and CI expectations
- docs impact: docs, README, package READMEs, generated site sync, or "none"
- release/package impact: versions, package metadata, install commands, or "none"

Merges happen only after the written plan matches the delivered change, CI is green,
and the review gate is satisfied.

## Docs Sync

Docs are part of the product. If behavior, commands, flags, package names, or release
truth changes, update the affected docs in the same PR. The website under `site/` is
generated from `docs/`, so run the site sync/build when doc-source changes are in
scope.

## Local Verification

Use the smallest relevant checks while working, then run the applicable gate before
asking for review:

```bash
python packages/tropo/tests/test_tropo.py
python packages/ozone/tests/test_ozone.py
python packages/exo/tests/test_exo.py
python packages/create-vivary/tests/test_create_vivary.py
python packages/create-vivary/tests/test_assets_parity.py
node packages/create-vivary/tests/test_npm_launcher.js
python packages/tropo/tropo.py check --root packages/tropo/examples/vault
git diff --check
```
