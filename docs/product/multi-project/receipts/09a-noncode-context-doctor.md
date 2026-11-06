# Non-code context and Doctor verification

Evidence-record: 09a
Date: 2026-09-18

[Issue #18](https://github.com/vivary-dev/Vivary-New/issues/18) and
[PR #66](https://github.com/vivary-dev/Vivary-New/pull/66) own acceptance and
delivery. The PR merged into dev on 2026-09-18 as `43ae417`. Jeff delegated
acceptance to Claude on 2026-09-18 after approving the Entire trail and the
merge; the merged result was verified end to end before this receipt.

## Verified behavior

- Doctor keeps Tropo's own severity. A typed record with one unknown field
  (W202) or a redundant `title:` (W210) is listed under `warnings` and leaves
  `ok` true and exit 0. A missing required field (E101) or invalid frontmatter
  stays an error; a dangling `ref` is a W220 warning and, as a broken graph
  edge, still fails Doctor. An edgeless graph is valid; zero typed nodes is a
  warning.
- A folder without a Git repository gets the same Doctor, `check`, and `find`
  results as its Git copy, and no Git fact appears in Doctor output. The S5
  and S7 research claims stay disproved and are not encoded anywhere.
- A checkout with no `package.json` carries no `npm_test_script` fact, known
  or unknown, in the capsule Core compiles; `required_checks` is empty and no
  `required_check_undetermined` unknown appears for writing work without a
  test command. A manifest that exists but is unusable, or that is
  git-ignored, still yields the privacy-preserving unknown.
- The Workbench `find` and `impact` verbs place their query or node id right
  after the verb, which every supported interpreter accepts; option-like
  values are refused by the schema. The previous `--` form parsed only on
  Python 3.12.5 or newer.
- Project details offers "Check project health". It runs the existing
  original-command `doctor` verb on demand, shows Healthy or Needs attention
  with typed note and link counts, lists errors and warnings apart, and says
  "Showing 50 of N" when a list is capped. The panel's findings are identical
  to `vivary doctor --json` on the same runtime.
- Non-Markdown files are not counted as nodes, edges, or findings and are not
  reported as omissions by Tropo's public `find`/`check`; Core's content search
  still surfaces committed plain-text matches. Recorded as the honest boundary;
  a per-format omission is a separate capability choice.

## Checks and limits

- create-vivary: 196 tests OK; two new Doctor severity tests; three W210
  repair tests now expect exit 0 with the warning listed. Core: the packet's
  `test_model` and `test_content` plus `test_observe` with the new manifest
  test, 132 passed. Tropo: 203 passed, package unchanged. Workbench: typecheck
  clean, both tsx CI groups green, the original-runtime test rewritten to the
  CLI's real contract, the new summarizer test in the CI list.
- Real CLI on three disposable thin `writing` fixtures (non-Git notes, typed
  records with one bad record, a Git writing root with `.txt`/`.docx` and no
  test command) through both the pinned 3.11 interpreter and the bundled
  3.12.14 runtime.
- Real-application journey on a loopback build with the bundled runtime
  against the non-Git notes fixture: register the folder, open Details,
  check health (Healthy, one W202 warning), add a bad typed record and check
  again (Needs attention, one E101 error, warning kept), remove it and return
  to Healthy, 390 px viewport, no page errors; GUI findings equal headless
  Doctor in both states. 10 of 10 steps on the PR head and again on merged
  dev `43ae417`. Screenshots retained privately on Zo.
- Zo CI on `f1b7f9e` against `fef865e`: 63 of 63 applicable Linux steps; the
  two Windows jobs and GitHub-hosted dispatch omitted there and covered by
  GitHub Actions, which passed all 8 checks including both Windows jobs.
- Independent review: Codex (GPT-6 Astra), one pass, two findings, each fixed
  in its own commit (capped-list disclosure; README wording on dangling refs).
- Packaged Windows EXE, 2026-09-18: candidate `43ae417` passed the same
  journey on the laptop (register the plain notes folder, Not checked yet,
  Check project health, break and recover) with output identical to
  `vivary doctor --json` from the bundled runtime in both states. The
  per-step table is in the [acceptance register](../desktop-acceptance-status.md).
  The published preview still predates this change.

## Acceptance

Issue #18 is accepted and closed on 2026-09-18 under Jeff's delegation. The
packet moves to done with this receipt as its evidence. Tropo `check`'s strict
default, per-format omissions, a GUI find surface (09b), and folder-type
inference (08a) remain under their own issues.
