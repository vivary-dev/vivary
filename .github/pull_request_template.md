## Intent

What changed, why, and which Vivary layer/module it serves.

## Blast Radius

Files, packages, knowledge-graph surfaces, generated assets, downstream workflows, and
user-visible behavior touched by this PR.

## Verification

Commands run locally:

- [ ] `python packages/tropo/tests/test_tropo.py`
- [ ] `python packages/ozone/tests/test_ozone.py`
- [ ] `python packages/exo/tests/test_exo.py`
- [ ] `python packages/create-vivary/tests/test_create_vivary.py`
- [ ] `python packages/create-vivary/tests/test_assets_parity.py`
- [ ] `node packages/create-vivary/tests/test_npm_launcher.js`
- [ ] `python packages/tropo/tropo.py check --root packages/tropo/examples/vault`
- [ ] `git diff --check`

Notes:

## Docs Impact

Docs, README, package READMEs, generated site sync, or `none`.

## Release / Package Impact

Version, package metadata, install command, release note, or `none`.

## Out of Scope

What this PR deliberately does not do.
