---
title: "Folder is the schema"
shortTitle: "Folder is the schema"
description: "A short source-grounded lesson on classifying documents by folder and declaring their tropo.toml fields."
order: 2
module: "01"
moduleTitle: "Tropo: graph truth"
status: "Baseline"
minutes: 9
tags: ["tropo", "schema", "folder-as-type", "tropo-toml"]
outcomes:
  - "Classify a document's type by the folder it lives in, without ever writing a type: field."
  - "Read a folder's required and optional fields from tropo.toml, and name what tropo fix strips as redundant noise (W210)."
sources:
  - label: "Vivary Concepts — typed documents"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/CONCEPTS.md"
    locator: "L31-32"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary HOWTO — Add a typed document; Add or change a type"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "L29-63"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "0003-runbook-placement"
    kind: "multiple-choice"
    prompt: "A teammate drafts the steps for rotating a leaked API key and sets owner: security in the frontmatter. In tropo.toml, [types.runbook] has folder = \"runbooks\", requires owner, and allows optional related_modules. Where does the file go, and what must stay set?"
    options:
      - text: "Place it in runbooks; keep owner set."
        correct: true
        feedback: "Right. The folder assigns the type, and owner is the one required field runbooks declares — nothing else to add."
      - text: "Place it in decisions; keep owner set."
        correct: false
        feedback: "decisions/ gives the wrong type. This file's kind is a runbook, not a decision record — placement is the classification."
      - text: "Place it in runbooks; drop owner entirely."
        correct: false
        feedback: "owner is required for runbooks. Drop it and tropo check fails closed with a missing-metadata error."
      - text: "Place it in runbooks; add type frontmatter."
        correct: false
        feedback: "The folder already is the type. A type: field only repeats it, and tropo fix strips it right back out as W210 noise."
    success: "Correct. Folder decides the type; owner satisfies the one required field runbooks declares."
    reveal: "Compression: folder = type. The required field is the one fact the folder still needs from you."
---

> A file doesn't become a runbook because you called it one. It becomes a runbook because you dropped it in `runbooks/`.

## Why this exists

Most note-taking systems ask you to declare what a document is twice: once by where you save it, once by typing `type: runbook` at the top. Two declarations for one fact means two places that can disagree — and disagreement is exactly what breaks an automated graph. Vivary refuses to let that happen. It calls a document **typed**: "each note has a kind … with required fields … there are rules, and a checker that enforces them" ([Concepts](https://github.com/vivary-dev/vivary/blob/dev/docs/CONCEPTS.md)). This lesson makes that mechanism concrete: classify a file by the folder it belongs in, know which fields that folder's type requires or allows, and never let a `type:` field sneak back into the frontmatter.

## How it works

Hold the rule in one line:

> **The folder is the type.** Move a file between folders and it is retyped — no edit needed.

Tropo never reads a `type:` field to decide what a document is. It reads the path. That single design choice is why the graph doesn't drift out of sync with itself: a document's type is *where it lives* — move a file between folders and it's retyped, no edit needed. A `type:` field that just repeats the folder is noise, and three ways to set one fact is harder to enforce, not easier ([HOWTO](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)).

Every typed document goes through the same two moves:

1. **Classify by folder.** Drop the file where its kind lives, then let `tropo check` name exactly what metadata that folder requires:
   ```
   cat > decisions/0002-pick-postgres.md <<'EOF'
   ---
   status: accepted
   date: 2026-06-14
   related_modules: [billing]
   ---
   # Use Postgres for billing
   Rationale...
   EOF
   tropo check decisions/0002-pick-postgres.md
   ```
   Placing the file in `decisions/` *is* the classification — nothing else sets it.

2. **Declare the type's fields.** A type is defined once, in `tropo.toml`, as a folder plus its required and optional fields:
   ```
   [types.runbook]
   folder   = "runbooks"
   required = { owner = "string" }
   optional = { related_modules = "ref-list" }
   ```
   Nested `tropo.toml` files may *tighten* rules for a subtree — add requirements — but they may never loosen what a parent already requires ([HOWTO](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)).

## Don't conflate

Required and optional fields describe the document — an owner, a status, a related module. They are not a second place to restate the type. A field that just repeats what tropo already derives (id, title, dates) is noise, and `tropo fix` removes it. The same logic applies to any hand-written `type:` field: the folder already owns that fact, so a frontmatter copy is a second owner for one fact, and it gets flagged and stripped.

Keep the three roles distinct:

- `tropo check` is a gate, not a linter — it fails by default on untyped documents and on unknown or mistyped fields.
- Redundant frontmatter — anything the folder or tropo already derives — fails too, as warning `W210`.
- `tropo fix` clears `W210` noise in one shot instead of hand-editing every file that has it.

One fact, one owner: a document's type has exactly one owner, the folder. Required and optional fields have exactly one owner each, the value you set. If you ever catch yourself writing the same fact in two places in one file, one of them is noise waiting to be flagged.

## Try it on a real workspace

Choose a document type from a real project — a runbook, a decision record, a module index, whatever exists. Identify the folder that assigns its type, open the matching entry in `tropo.toml`, and separate its truly required fields from anything that would just repeat what the folder or tropo already knows. Run `tropo check` against a real file of that type and confirm the field list matches what you predicted.

## One-minute recall

1. Find the folder that matches what the file *is* — that placement is the classification.
2. Open `tropo.toml` and read that folder's `required` and `optional` fields.
3. Fill every required field; add optional fields only if the note actually needs them.
4. Never add a `type:` field — the folder already said it, and `tropo fix` will strip it as noise.
5. Run `tropo check` before you call the note done.

Tomorrow, before opening `tropo.toml`, write from memory the required field(s) for `runbooks` and explain in one sentence why adding `type: runbook` to that file would fail `tropo check`.

## Sources

- [Vivary Concepts — typed documents](https://github.com/vivary-dev/vivary/blob/dev/docs/CONCEPTS.md)
- [Vivary HOWTO — Add a typed document; Add or change a type](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)
