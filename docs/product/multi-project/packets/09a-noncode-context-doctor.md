# 09a: Verify and repair narrow non-code context and Doctor behavior
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/18
Parent: 09
Status: done
Depends-on: []
Evidence: [Non-code context and Doctor verification](../receipts/09a-noncode-context-doctor.md)
Verification-result: passed
Owner: Claude on Zo (Jeff's 2026-09-18 decision), sole original context and Doctor behavior writer; Codex (GPT-6 Astra) reviews
Scope: Characterize supported non-code work, fix demonstrated context/schema/Doctor mismatches, and preserve valid behavior and existing budgets.
Verification-kind: runtime
Timebox: One coherent user-visible increment with focused checks and review.

## Goal

Return useful, accurately scoped project context and meaningful health findings
for supported notes and writing workspaces, with VCS-specific checks optional.

## Context

Read [ENGINEERING.md](../../../../ENGINEERING.md), the [current design](../design.md),
[Agent-Native ownership](../native-owners.md), and the [original source map](../research/original-vivary-product-map.md).
Agent-Native owns application actions, runs, and conversations. The original
creator owns setup operations, and Tropo owns project retrieval. The coordinating
agent (`root`) assigns one source writer before activation. Follow the live
repository delivery rules.

Read the original context/review source map and the research claims as hypotheses.
The blanket S5 non-Git block was disproved by a current reproduction. S7 does not
make an edgeless graph invalid. Do not encode either false claim as an expected
failure or turn optional capabilities into mandatory setup requirements.

## Owned files

- Existing Core workspace observation/content selection in
  `packages/core/vivary_core/workspace_model.py`, `workspace_content.py`, and
  `workspace_observe.py`, limited to demonstrated gaps.
- Existing Tropo graph/configuration code and original Doctor checks.
- Existing Strato/Ozone/Exo adapters only for a verified caller mismatch.
- Focused existing Core/Tropo/creator tests and the corresponding GUI context display.

## Done condition

Document and verify the smallest supported cases: non-Git notes when supported
by the existing observer, ordinary Markdown/frontmatter, explicit typed records,
and writing work without a code-test command. VCS or npm facts appear only when
applicable. Missing optional capability is described honestly.

Fix demonstrated dropped content, incorrect schema selection, caller/path mismatch,
or misleading severity at its owning source. Keep valid edgeless workspaces valid.
Undefined relationships or unsupported file formats are not silently counted as
indexed evidence. Preserve private-source exclusion and bounded context selection.

The GUI and headless command expose the same corrected result for the affected
case. Source fixes do not claim a new parser, semantic index, non-code factory,
or acceptance of every research scenario.

## Verify

First reproduce each selected claim against current source using a small local
fixture. If it already works, record that result rather than adding a failing test.
Add only the regression needed for a confirmed defect. Run the affected ordinary
CLI and GUI context journey. Do not replay retained historical proof campaigns.

```console
python -m pytest packages/core/tests/test_model.py packages/core/tests/test_content.py -q
python -m pytest packages/tropo/tests/test_tropo.py -q
python -m unittest discover -s packages/create-vivary/tests -p test_create_vivary.py
git diff --check
```

## Stop conditions

Do not relax strict evidence contracts to label unobserved content verified,
remove privacy exclusions, or equate node/edge counts with product correctness.
Coordinate shared Tropo files with 08a. An unsupported extension is a separate
capability choice, not permission for a broad parser or runtime rewrite.

## Log

- 2026-09-13: Added to the combined implementation plan. Prerequisites are
  unresolved. No implementation or runtime acceptance is claimed.

- 2026-09-13: Root selected code, Markdown notes, and writing fixtures. Reproduce the documented claims first and fix only actual mismatches.

- 2026-09-18 reproduction (Claude, dev `fef865e`, disposable thin `writing`
  fixtures: non-Git notes, typed records with one bad record, and a Git
  writing root with `.txt` and `.docx` files and no test command):
  - Non-Git notes: `vivary doctor`, `check`, and `find` return the same
    result as the Git copy. No Git or npm fact appears in Doctor output. The
    S5 claim stays disproved; no change.
  - Edgeless and typed graphs: an edgeless workspace passes Doctor; edges come
    from `ref`/`ref-list` fields; a missing required field (E101) and a
    dangling ref (`graph.broken`) fail. Correct; no change.
  - Doctor severity: **defect.** Every Tropo finding was appended to errors,
    so a typed record with one unknown field (W202) or a redundant title
    (W210) failed a healthy workspace. Fixed in `doctor_workspace`: findings
    keep Tropo's level. Three repair tests that expected exit 1 from a W210
    now expect exit 0 with the warning listed.
  - Writing work without a test command: `required_checks` is empty and no
    `required_check_undetermined` unknown appears. **Defect:** the capsule
    carried an `npm_test_script: no_npm_test_script` unknown for a root with
    no `package.json`. Core now omits the fact when no manifest exists; a
    present but unusable or git-ignored manifest still yields the unknown.
  - Caller mismatch: **defect.** The Workbench built `find --root … -- <query>`
    and `impact --root … -- <id>`; tropo and ozone read their positional right
    after the verb, and the `--` form only parses on Python 3.12.5 or newer.
    The bundled 3.12.14 runtime accepted it; the CI pin (3.11) and pip
    installs exit 2. The builder now places the value after the verb and the
    schema refuses option-like text.
  - Unsupported formats: Tropo indexes `.md` and `.markdown` only. Other files
    are never counted as nodes, edges, or findings, and the public
    `find`/`check` results do not list them as omissions either. Core's
    content search still surfaces committed plain-text matches. Recorded as
    the honest boundary; adding a per-format omission would be a separate
    capability choice under the stop conditions, not taken here.
  - GUI parity (Jeff chose the panel on 2026-09-18): Project details gained
    an on-demand "Check project health" block that runs the existing
    original-command `doctor` verb and shows Healthy or Needs attention with
    node and link counts, errors, and warnings kept apart. Loopback journey
    on the non-Git fixture: 10 of 10 steps, GUI findings identical to
    `vivary doctor --json` on the same runtime for the healthy and the failed
    case, readable at 390 px; screenshots retained privately on Zo.
- 2026-09-18: PR #66 merged into dev as `43ae417` after Codex review, Zo CI
  63/63, and GitHub Actions 8/8. Accepted and closed under Jeff's delegation
  after the journey passed again on merged dev; evidence in the linked receipt.
- 2026-09-18: Windows candidate `43ae417` passed the health-check journey on
  the packaged EXE with output identical to headless Doctor; recorded in the
  desktop acceptance register. Approval and denial were not rerun on it and
  stay proven on `98515c9` with Codex Normal mode.
