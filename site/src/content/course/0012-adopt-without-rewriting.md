---
title: "Adopt without rewriting"
shortTitle: "Adopt without rewriting"
description: "A short source-grounded lesson on adopting an existing repo or vault into Vivary safely."
order: 11
module: "06"
moduleTitle: "Workspace lifecycle"
status: "Baseline"
minutes: 11
tags: ["lifecycle", "brownfield", "adopt", "dry-run"]
outcomes:
  - "Reconstruct the seven-stage safe-adoption sequence from memory, dry-run first through CI gate."
  - "Explain what create-vivary adopt is allowed to write and what it must leave untouched."
  - "Separate doctor's structural checks from its backend-reachability check."
sources:
  - label: "Getting Started — adopt an existing repo or vault"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "§ Adopt an existing repo or vault, through §3 Check that it's healthy, L125-151"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "HOWTO — Use Vivary in CI"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "§ Use Vivary in CI, L223-233"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "README — release status and package table"
    url: "https://github.com/vivary-dev/vivary/blob/dev/README.md"
    locator: "L22-29, L43-47"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "adopt-sequence"
    kind: "sequence"
    prompt: "Click the stages in execution order. Start where nothing is written yet. End where a broken graph fails a build automatically."
    items:
      - text: "Preview the plan (dry-run adopt)"
        feedback: "Dry-run is the very first step — there is nothing to preview once files already exist."
      - text: "Apply the plan (adopt --yes)"
        feedback: "Applying without reading the plan defeats the point of a dry-run-first workflow."
      - text: "Validate the scaffold (doctor)"
        feedback: "Doctor checks a scaffold that must already exist — apply the plan first."
      - text: "Record a drift baseline (doctor --trend)"
        feedback: "A first --trend run only records a baseline; confirm the scaffold with plain doctor before tracking drift."
      - text: "Check every typed note (tropo check)"
        feedback: "tropo check validates notes the scaffold already created; adopt and doctor come first."
      - text: "Review graph relationships (ozone review --strict)"
        feedback: "Ozone reviews relationships between notes that tropo check has already validated."
      - text: "Gate CI on the exit codes"
        feedback: "CI only wraps commands that already pass locally — run them by hand first."
    success: "Sequence rebuilt. Safe adoption stays dry-run-first and ends in CI."
    reveal: "Why dry-run stays first: create-vivary adopt . --json only analyzes and prints a plan; it is dry-run by default, unlike init. Nothing is written until you rerun it with --yes."
  - id: "adopt-default"
    kind: "multiple-choice"
    prompt: "What happens when you run create-vivary adopt . with no flags?"
    options:
      - text: "Prints the plan; writes nothing yet."
        correct: true
        feedback: "Correct. Dry-run is the default — nothing is written until --yes."
      - text: "Writes every proposed file immediately anyway."
        feedback: "Dry-run is the default; writing needs an explicit --yes flag."
      - text: "Edits existing files to match preset."
        feedback: "Adopt never edits existing content, even after --yes is passed."
      - text: "Skips doctor, pushing changes straight upstream."
        feedback: "Adopt neither runs doctor automatically nor touches any git remote."
    success: "Correct. Dry-run is the default — nothing is written until --yes."
    reveal: "Compression: dry-run first, apply second — the opposite default from init."
  - id: "adopt-collision"
    kind: "multiple-choice"
    prompt: "Your repo already has a README.md. What does adopt --yes do with it?"
    options:
      - text: "Leaves it untouched and reports it kept."
        correct: true
        feedback: "Correct. adopt reports it as \"exists, kept\" and leaves it alone."
      - text: "Overwrites it fully with the generated template."
        feedback: "Adopt never overwrites a file, even one it would have created."
      - text: "Renames it and writes a fresh one."
        feedback: "Adopt never renames existing content; a kept file keeps its name."
      - text: "Merges its contents into the new file."
        feedback: "Adopt does not merge; it only adds files that don't exist."
    success: "Correct. adopt reports it as \"exists, kept\" and leaves it alone."
    reveal: "Invariant: \"exists, kept\" applies to README.md, AGENTS.md, or any other file already at that path."
  - id: "doctor-classification"
    kind: "multiple-choice"
    prompt: "Doctor reports the storage backend as unavailable. Which kind of check produced that result?"
    options:
      - text: "A backend reachability check, not a structural one."
        correct: true
        feedback: "Correct. Doctor reports structural health and backend reachability separately in one run."
      - text: "A structural check of the required scaffold files."
        feedback: "Required files and module indexes are structural checks, not this one."
      - text: "A privacy-ignore check of the git ignore rules."
        feedback: "Privacy-ignore checks confirm gitignore lines, not backend reachability status."
      - text: "A module-index check of the modules routing files."
        feedback: "Module-index checks confirm router coverage, not backend reachability status."
    success: "Correct. Doctor reports structural health and backend reachability separately in one run."
    reveal: "Separation: structural checks read the scaffold; the reachability check probes the configured backend, and semantic-memory status is reported separately again."
---

> A workspace that already has 40,000 lines of your work in it does not need a rewrite. It needs someone to add the missing pieces without touching a single file it already trusts.

## Why this exists

Most real workspaces are not empty. `create-vivary adopt` exists so you can bring the graph, the loop, and the gates to a codebase or notes folder you already have — without editing, renaming, or overwriting anything it did not create. That's not a nice-to-have; it's the whole reason brownfield adoption is safe enough to run on a repo you actually care about.

## How it works

**Dry-run first, always.** `create-vivary adopt . --json` analyzes the target and prints a plan; `--yes` is required before anything is written. That's the opposite default from `init`, and it's deliberate — brownfield work should never write blind.

**Adds only.** Adopt only adds files it doesn't find already there. An existing `README.md` or `AGENTS.md` comes back "exists, kept" — not overwritten, not merged, not renamed. Markdown-heavy directories it finds get a thin router under `modules/` instead of being touched directly.

**Doctor checks two different kinds of fact, in one run.** Structural findings answer "is the scaffold shaped correctly?" — required files present, privacy-ignore rules active, every module directory carrying an `index.md`, the typed graph healthy. Separately, in the same run, doctor reports whether the configured storage backend is reachable, plus semantic-memory status. A workspace can be structurally perfect and still report an unreachable backend — that's not a contradiction, it's two different questions answered honestly.

**Trend tracking needs a second data point.** `doctor --trend` is the only flag that writes `.vivary/doctor-state.json`. The first run just records a baseline; commit or cache that file if you want CI to report deltas across runs.

**CI gates on exit codes, nothing fancier.** `tropo check` validates every note (strict mode fails on warnings too), and `ozone review --strict` checks the relationships between them. CI runs both and fails the build on any warning — it blocks a bad merge, it does not repair the workspace for you.

Release status backs this up: the README puts brownfield `create-vivary adopt` and `doctor --trend` drift tracking in the same 0.3.1 line as `init` and plain `doctor` — this is baseline lifecycle tooling, not a bolt-on extra.

## Don't conflate

- **Dry-run is not a suggestion you can skip.** It's the default behavior, not an optional flag — you have to explicitly opt into writing with `--yes`.
- **"Adds only" is not "merges."** A collision with an existing file always resolves to "exists, kept." Adopt never blends its template into your file.
- **Structural health is not backend reachability.** Doctor reports both in the same run, but they're independent facts — required-files-present and backend-is-reachable can disagree with each other.
- **A first `--trend` run is not a trend.** It's a baseline. You need a second run before doctor can show you a delta.

## Try it on a real workspace

Pick a file type that already exists in a real repository — a `README.md`, a `.gitignore`, whatever you've got. Predict how `create-vivary adopt . --json` will report it before you run the dry run, then confirm the prediction without applying anything. If your prediction was wrong, that's the exact boundary this lesson exists to fix.

## One-minute recall

1. Dry-run first: `adopt . --json`, then apply with `--yes`.
2. Adds-only: existing files come back "exists, kept," never touched.
3. Doctor reports structural health and backend reachability in one run.
4. `doctor --trend` needs a second run before it can show any delta.
5. CI gates on `tropo check` and `ozone review --strict` exit codes.

## Sources

- [Getting Started — adopt an existing repo or vault](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md) (§ Adopt an existing repo or vault → §3 Check that it's healthy, L125-151)
- [HOWTO — Use Vivary in CI](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md) (§ Use Vivary in CI, L223-233)
- [README — release status and package table](https://github.com/vivary-dev/vivary/blob/dev/README.md) (L22-29, L43-47)
