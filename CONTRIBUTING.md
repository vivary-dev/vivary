# Contributing

Vivary uses small, reviewed slices. Plan the verification before changing files, then
keep the implementation narrow enough that the tests and docs can move with it.

## Branches

- `dev` is the active integration branch — and what the live site deploys from
  (Vercel's production branch is `dev`).
- `prod` is a legacy branch from an earlier cut model; it lags `dev` and nothing
  deploys from it. Don't target it.
- Work happens on short-lived typed branches such as `feat/*`, `fix/*`, `docs/*`, or
  `chore/*`, cut from current `origin/dev`.
- Do not push directly to `dev` or `prod`; open a PR and let CI plus review gates run.

### Checkout and worktree lifecycle

Treat `origin/dev` as the integration authority; a local `dev` branch can be stale. Keep
an existing dirty checkout in place and create an isolated task worktree when clean
state is required:

```bash
git fetch origin dev
git worktree add -b <typed-branch> <new-path> origin/dev
```

Before removing a worktree or branch, record its path, HEAD, upstream, tracked changes,
untracked files, and relevant ignored evidence. Prove that every commit is reachable
from a durable ref or bundle. Preserve dirty work as a binary patch plus an allowlisted
archive, and verify restoration in a disposable clone. Only then request separate
approval for each `git worktree remove`, local or remote branch deletion, and
`git worktree prune`. Never reset or clean a checkout to make it appear disposable.

## Before You Change Code

State the intended slice, blast radius, tests, and docs impact before editing. For
code changes, add or update focused tests first when there is a clear seam; for docs
or repo-surface changes, name the exact verification commands in the PR.

## Pull Requests

Every open PR carries exactly one stewardship lifecycle label:

- `active` — maintained work that can proceed;
- `automated-current` — a current proposal authored by an approved bot;
- `blocked` — valid work with a named unmet dependency or failing gate;
- `superseded` — replaced by identified newer evidence;
- `close-with-receipt` — not proceeding, with the exact reason preserved before close;
- `needs-human-decision` — evidence is complete but project judgment remains.

The final four classifications remain repository-health findings until their named
disposition occurs. Age alone never makes a PR stale or safe to close.

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

## Line Endings

Vivary normalizes text files to **LF** in both Git and the working tree. This keeps
Windows, WSL/Linux, GitHub Actions, generated site docs, and package builds from
turning tiny edits into noisy line-ending diffs. `.gitattributes` owns the Git rule,
`.editorconfig` owns editor defaults, and `scripts/check_line_endings.py` enforces
the policy.

Rules:

- Use LF for text files, including Markdown, Python, TOML, JSON, JavaScript, Astro,
  SVG, and PowerShell.
- Use CRLF only for `.bat` and `.cmd` files.
- Do not hand-normalize unrelated legacy files inside a feature PR. If a touched file
  is mixed, normalize that file in the same PR and call it out in verification.
- The checker has a temporary legacy allowlist for files that already had CRLF or
  mixed endings when the policy landed. Shrink the allowlist only through deliberate
  cleanup PRs.

Before pushing a PR that changes text files, run:

```bash
python scripts/check_line_endings.py
git diff --check
```

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
python scripts/check_line_endings.py
git diff --check
```
