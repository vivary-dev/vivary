---
title: "Triage a graph failure"
shortTitle: "Triage a graph failure"
description: "A short source-grounded lesson on triaging a tropo check failure."
order: 3
module: "01"
moduleTitle: "Tropo: graph truth"
status: "Baseline"
minutes: 9
tags: ["tropo", "tropo-check", "triage", "error-codes"]
outcomes:
  - "Sort a tropo check failure into one of three moves: run tropo fix, edit placement or schema, or get a value from a person."
  - "Distinguish the self-resolving warning (W210) from schema-lag warnings (W201, W202), a missing-value error (E101), and an invalid-value error (E103)."
  - "Explain why an agent must never guess or invent a value just to make an E101 or E103 error disappear."
sources:
  - label: "Vivary Agent Skills — the tropo skill's triage list"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/SKILLS.md"
    locator: "L57-74"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary HOWTO — dry-run recipe and strict-by-default CI"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "L21-27, L211-213"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Commands — warning and error code reference"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md"
    locator: "L103-112"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "0004-w210-flood"
    kind: "multiple-choice"
    prompt: "check reports a wall of W210 across the vault. What's the move?"
    options:
      - text: "Run tropo fix to remove noise."
        correct: true
        feedback: "Right. W210 is redundant frontmatter — a field that just repeats what tropo already derives — and tropo fix exists specifically to clear it."
      - text: "Add the field to tropo.toml now."
        correct: false
        feedback: "That's the fix for W202 — the schema hasn't caught up to a field — not for redundant frontmatter."
      - text: "Move the file under a type."
        correct: false
        feedback: "That's the fix for W201 — an untyped file — not for repeated derived metadata."
      - text: "Fill the gap with the user."
        correct: false
        feedback: "That's the fix for E101/E103 — a value genuinely missing or invalid — not for noise the tool already knows how to remove."
    success: "Correct. A flood of W210 is exactly what tropo fix exists to clear."
    reveal: "Compression: W210 is noise; the command is the fix. Dry-run it first with tropo fix --dry-run."
  - id: "0004-w201-untyped"
    kind: "multiple-choice"
    prompt: "Many files fail with W201. What does that ask for?"
    options:
      - text: "Move the files under a type root."
        correct: true
        feedback: "Right. W201 means the files aren't under any declared type yet — placement or a new type entry is the fix, never the prose."
      - text: "Run tropo fix to clear the noise."
        correct: false
        feedback: "tropo fix only clears redundant frontmatter (W210); it doesn't retype anything."
      - text: "Add the unknown field to the schema."
        correct: false
        feedback: "That answers W202 — an unknown field — not an untyped file."
      - text: "Ask the user to supply the value."
        correct: false
        feedback: "That answers E101/E103 — a required value that's missing or invalid — not a missing type."
    success: "Correct. W201 asks you to change where the file lives or what types exist — never the content."
    reveal: "Reminder: the folder is the type — placement is the fix, not the prose."
  - id: "0004-e101-error"
    kind: "multiple-choice"
    prompt: "A document fails with E101. What is true, and what must you avoid?"
    options:
      - text: "Errors mark real gaps; fill them with the user."
        correct: true
        feedback: "Right. Errors mean irreducible required metadata is genuinely absent — the value only exists once a person supplies it."
      - text: "Warnings mark cosmetic style noise; run tropo fix instead."
        correct: false
        feedback: "Redundant-frontmatter noise is W210, a warning tropo fix clears on its own — not what E101 signals."
      - text: "Errors mean the schema is behind reality; add fields."
        correct: false
        feedback: "That describes W202, a warning about the schema lagging reality — not a missing value."
      - text: "Errors are safe to guess and fill silently yourself."
        correct: false
        feedback: "Guessing invents graph truth silently — exactly the ungated mutation the baseline refuses to allow."
    success: "Correct. Errors mark genuine gaps; the value only exists once a person supplies it."
    reveal: "Invariant: no command fills an error. A person does."
---

> A red tropo check isn't yelling at you. It's telling you exactly which of three doors to open — you just have to read which one.

## Why this exists

The tropo skill's own operating loop is "survey → see the truth → check → decide → re-run until clean." This lesson is the **decide** step: reading a `check` failure well enough to know whether the fix belongs in the file's content, in the file's placement or schema, or behind a single safe command. The primary definition comes from the [tropo skill](https://github.com/vivary-dev/vivary/blob/dev/docs/SKILLS.md). Command shapes and CI behavior are cross-checked against the [HOWTO recipes](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md) and [command reference](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md), because a skill description can compress detail that executable behavior fills back in.

## How it works

The tropo skill's own triage list boils the check failures it names down to three moves: **fix the content**, **fix the placement or schema**, or **run `tropo fix`**. Warning codes almost always mean the rules or the folder are stale, not that the writer did anything wrong. Error codes mean the graph is genuinely wrong or missing something it needs — and that gets fixed by a person, never guessed. One warning code, `W210`, is the deliberate exception: it's pure noise the tool already knows how to remove. (`check` also emits other codes not covered here, like the broken-ref warning `W220` — the same warn-vs-error logic still applies to those.)

Don't memorize a catalog of codes. Memorize which branch a code belongs to — the branch tells you where the fix lives:

1. **Noise → run the tool.** `W210` (redundant frontmatter) fires when a field just repeats what tropo already derives — id, title, dates. Preview it with `tropo fix --dry-run`, then apply. This is the one code where the command *is* the fix.
2. **Placement or schema → fix the rules.** `W201` (untyped) means the file needs to live under an existing type root, or the workspace needs a new type. `W202` (unknown field) means `tropo.toml` hasn't caught up to a field people are already using — add it there.
3. **Genuine gap → fix the content, with the user.** `E101` and `E103` are both errors, but they name different problems: `E101` means a required field is missing entirely; `E103` means a value is present but violates its type spec. No command clears either — the correct value only exists once a person supplies or corrects it.

Strictness is not the same as truth: `check` fails by default on all of these — it's a gate, not a linter. `--lenient` (per run) or `[base] strict = false` (per vault) can quiet the failure, but that changes what *blocks* you, not what the graph actually knows.

## Don't conflate

- **Never guess an error away.** Filling `E101` with a placeholder, or "correcting" an `E103` value without asking, turns a real gap or a bad value into invented graph truth — exactly the ungated mutation the baseline refuses to allow silently.
- **`tropo fix` is narrow.** It clears redundant-frontmatter noise — `W210` — in one shot. It does not retype a file, edit `tropo.toml`, or supply a missing value. Running it against the wrong failure does nothing useful.
- **Preview before you mutate.** The onboarding recipe runs `tropo check --lenient` to see what's there, then `tropo fix --dry-run` before applying anything — look at the diff before it touches a file.
- **CI applies the same triage.** In CI, `tropo check` runs strict by default and any warning fails the build. The three-branch read is identical at a keyboard or in a pipeline — only the moment you fix it changes.

## Try it on a real workspace

Run `tropo check --lenient` against a real workspace and read the first failure code it prints. Before you look anything up, classify it: noise, placement/schema, or genuine gap. Then confirm your classification against the [tropo skill's triage list](https://github.com/vivary-dev/vivary/blob/dev/docs/SKILLS.md) and apply the correct one of `tropo fix --dry-run`, an edit to `tropo.toml` or the file's folder, or a question to whoever owns the missing value.

## One-minute recall

1. Ask first: is this warning or error? Errors always route to a person.
2. If it's **W210**: preview with `tropo fix --dry-run`, then run it.
3. If it's **W201** or **W202**: change placement or edit `tropo.toml` — the rules are stale, not the writer.
4. If it's **E101**: stop, get the missing value from the person who has it. If it's **E103**: stop, get the correct value — don't silently "fix" it yourself.

Tomorrow, before opening any docs, redraw this tree from memory on a blank line. If you reach for `tropo fix` on anything but W210, name which branch you actually needed.

## Sources

- [Vivary Agent Skills — the tropo skill's triage list](https://github.com/vivary-dev/vivary/blob/dev/docs/SKILLS.md)
- [Vivary HOWTO — dry-run recipe and strict-by-default CI](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)
- [Vivary Commands — warning and error code reference](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md)
