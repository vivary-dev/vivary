# Contributing

Vivary uses small, reviewed slices. Plan the verification before changing files, then
keep the implementation narrow enough that the tests and docs can move with it.

## Active repository

Work in `vivary-dev/vivary`, which was public when checked on 2026-09-24.
The original `vivary-dev/vivary-cli` repository retains its release workflow and
is a separate delivery target.

- `dev` integrates reviewed work.
- `main` is the default branch and receives reviewed promotions from `dev`.
- Topic branches start from current `origin/dev`. Use `feat/`, `fix/`, `docs/`,
  `chore/`, `refactor/`, `test/`, or `perf/` followed by a short purpose.
- Open topic PRs into `dev`. Do not commit directly to `dev` or `main`.
- Push reviewed source branches to GitHub (`origin`) and the Entire mirror
  (`entire`). Source mirroring does not establish agent-session capture.

Before merging, resolve review findings and require passing applicable CI plus
one approval. The `required review gate` check (`.github/workflows/review-gate.yml`) runs the
gate script from the pull request's base commit, or from the commit pinned in the workflow
when the base has no script yet, so a pull request cannot change the gate that reviews it.
It requires a completed independent review of the exact head and base, published by the
server-side `vivary-independent-review` tool, which runs outside the repository on the
Vivary host and opens one review thread per finding. It stays pending while that review
or a Codex review of the exact head runs, fails when the review is failed or covers another
head or base, and fails on any unresolved review thread, outdated ones included. GitHub
refuses a merge on it only after branch protection marks it required; changes to
`.github/` still need an owner's review, because a pull request can edit workflow files,
and the reviewer adds a finding whenever the gate's own files change. Before merging: run
`vivary-independent-review --pr N` after the final push, publish a fix or an evidence-backed
rejection for every finding, resolve each thread only after its disposition is verified,
then re-run the check, because no event re-runs it when a thread is resolved. Since 2026-09-24 the Entire gate counts the author's approval, so
Jeff can approve his own trail. An agent can add technical review but never
records a human approval. Zo is the standing owner-approved CI host. Run the
applicable workflow commands and gates on Zo against the exact PR commit. GitHub
Actions billing or runner failures do not block this verification path. Record
executed checks, omissions, logs, and review evidence as Zo CI. Keep GitHub service
failures separate from test failures. Do not relabel an unrun Actions or Windows
job as successful. Passing applicable Zo CI satisfies the CI gate, subject to the
same review and product acceptance requirements. Promotion to `main` also needs Jeff's acceptance of
the delivered product milestone. This does not authorize a public release.

On 2026-09-13, GitHub refused branch-protection configuration while this
repository was private under the organization's Free plan. These rules remain
contributor policy. On 2026-09-24, `dev` still had no branch protection.

Dependabot reads configuration from `main`. Its version updates target `dev`
once this configuration reaches `main`. GitHub security updates still target
`main`, so review those changes and bring equivalent fixes into `dev` before
promotion. Do not merge a security update that leaves the integration branch
unfixed. See [GitHub's target-branch behavior](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#target-branch-).

Dependency-only Dependabot commits pass the HLDD gate without a design update,
so the dependency review before merge is the gate that catches a bad update.
Review each new or changed package version in the diff, including new transitive
packages in the lockfile:

- It was published more than 72 hours earlier, or it carries a provenance
  attestation from its stated repository.
- It runs no `preinstall`, `install`, or `postinstall` script beyond one that
  selects a platform binary.
- It ships no `binding.gyp` with an `actions` block.

The seven-day `cooldown` in `.github/dependabot.yml` delays version updates, but
GitHub states that `cooldown` "is only available for version updates, not
security updates"
([Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown-)).
A security update can bring a version published hours earlier, so the 72-hour
check matters most there.

Give a new or low-download package a closer look. The owner's approval of the
Entire trail stays required before merge.

### Entire session capture

[Enable Entire](docs/ENTIRE.md) in your working checkout before supported agent
work. The guide covers agent hooks, worktree discovery, private checkpoint
routing, and checking that a session was actually recorded. Source mirroring
alone does not provide this record. Keep local settings and transcripts untracked.

### Checkout and worktree lifecycle

Fetch `origin/dev` before starting a topic branch. Reuse the assigned checkout
and preserve dirty work. Keep one writer per shared file. When work needs
isolation, use a separate worktree with a named owner and purpose.

Before removing a worktree or branch, record its path, HEAD, upstream, tracked changes,
untracked files, and relevant ignored evidence. Prove that every commit is reachable
from a durable ref or bundle. Preserve dirty work as a binary patch plus an allowlisted
archive, and verify restoration in a disposable clone. Use existing explicit
approval only within its named cleanup scope. Otherwise request approval before
worktree removal, local or remote branch deletion, or worktree pruning.
Never reset or clean a checkout to make it appear disposable.

## Find the implementation owner

Start with the ready GitHub issue you claim in `vivary-dev/vivary`; since
2026-09-13 issues own task goals, acceptance, dependencies, ownership, and
lifecycle. Use [the program frontier](docs/product/multi-project/index.md) and
any linked packet for implementation guidance and retained evidence, and
[the source map](docs/product/multi-project/source-map/index.md) when a change
crosses ownership boundaries. A packet is a synchronized implementation brief.
An outcome describes the user capability that several issues deliver. A routine
issue needs no packet before it starts.

| Module | Responsibility | Start here |
| --- | --- | --- |
| `packages/create-vivary` | Workspace creation, adoption, and Doctor checks | `create_vivary.py` and `tests/test_init_thin.py` |
| `packages/tropo` | File configuration, indexing, relationships, and context retrieval | `tropo.py` and `tests/test_tropo.py` |
| `packages/core` | Shared filesystem and root-observation contracts | The [root source map](docs/product/multi-project/source-map/modules/root-observation/index.md) |
| `packages/workbench` | GUI, Native actions, and adapters into the Python suite | The [root instructions](AGENTS.md) and [Native owners](docs/product/multi-project/native-owners.md) |
| `docs/product/multi-project` | Product decisions, architecture, implementation guidance, and accepted evidence; GitHub issues own task dependencies | `design.md` and the generated `index.md` |

Agent-Native owns runs, conversations, actions, and connectors. Reuse those
owners when connecting product behavior. The creator writes workspace files,
and Tropo reads their configuration and retrieves project context.

Keep each change in its owning module. Extract a helper when it gives a coherent
operation a name or removes duplication. Avoid layers that only forward calls.
Use direct names and focused functions. Comments should explain decisions,
invariants, or unfamiliar contracts that the code cannot explain on its own.
Update the relevant guide when a contributor would otherwise need chat history.

## Before you change code

State the intended slice, blast radius, tests, and docs impact before editing. For
code changes, add or update focused tests when there is a clear seam. For docs
or repository changes, name the verification commands in the PR.

## Pull requests

Every open PR carries exactly one stewardship lifecycle label:

- `active`: maintained work that can proceed.
- `automated-current`: a current proposal authored by an approved bot.
- `blocked`: valid work with a named unmet dependency or failing gate.
- `superseded`: replaced by identified newer evidence.
- `close-with-receipt`: not proceeding, with the exact reason preserved before close.
- `needs-human-decision`: evidence is complete but project judgment remains.

The final four classifications remain repository-health findings until their named
disposition occurs. Age alone never makes a PR stale or safe to close.

Every PR links its owning GitHub issue. Close the issue after its acceptance
passes and the reviewed change merges into `dev`.

Every PR should include:

- intent: what changed and why
- blast radius: files, packages, docs, graph surfaces, and downstream effects
- verification: local commands run and CI expectations
- docs impact: docs, README, package READMEs, generated site sync, or "none"
- release/package impact: versions, package metadata, install commands, or "none"

Merges happen only after the written plan matches the delivered change, the
applicable CI or explicitly approved alternative gate passes, and review is complete.

## High-level design gate

Read [the HLDD](docs/ARCHITECTURE.md) and use
[maintain-hldd](.agents/skills/maintain-hldd/SKILL.md) for relevant changes.
Update the affected sections in the same commit as source or contract changes.
If no design changes, record the specific reasoning in Last change review.

Install the hook once per Git checkout:

```bash
python scripts/check_hldd.py --install-hook
```

The installer preserves Entire and other hooks. It refuses to replace an
existing pre-commit hook or hook manager. Add the staged command to that
existing chain when needed. Linked worktrees share hooks, but this hook runs
only in source trees that track the HLDD checker.

Before committing, stage the source and its design review, then run:

```bash
python scripts/check_hldd.py --staged
```

CI runs the same rule for every introduced commit using explicit base and head
refs. A prior documentation commit does not cover a later code-only commit.
Whitespace, comments, and dates alone do not count as a review. Test-only and generated site-mirror
changes are exempt. Commits before gate adoption remain historical. CI also
checks introduced side-branch commits. Neither check can establish the truth of the prose.
Review the description against its source and evidence. Local hooks can be
bypassed by Git, so passing CI and the existing human review remain necessary.

The built application exposes this same document at Settings > Documentation.
Its text is bundled at build time and remains readable without a network.
Linked source and detailed references require internet access.

## Documentation sync

Docs are part of the product. If behavior, commands, flags, package names, or release
truth changes, update the affected docs in the same PR. The legacy CLI documentation
site under `site/` copies selected `docs/` sources. Run its existing sync/build
when those sources change. The desktop marketing site lives in the separate
private `vivary-dev/vivary-site` repository. Read that repository's instructions
before editing it. Do not rebuild the desktop website inside the old Astro site.

Keep the [offline guide](docs/product/multi-project/specification/README.md#regenerate-the-reader)
aligned with its Markdown and JSON sources. Regenerate owned views after editing
their sources. Current instructions must use retained source links. Dated receipts
and historical logs remain evidence, not instructions to resume old branches.

## Line endings

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

## Local verification

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
