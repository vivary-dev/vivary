---
title: "Separate storage from recall"
shortTitle: "Separate storage from recall"
description: "A short source-grounded lesson on why embedded LanceDB storage and semantic recall are independent Vivary sidecar axes."
order: 12
module: "07"
moduleTitle: "Optional sidecars"
status: "Optional sidecar"
minutes: 9
tags: ["sidecars", "storage", "semantic-recall", "lancedb"]
outcomes:
  - "Separate the storage axis (file vs. embedded) from the recall axis (none/local/Cognee) as two independent choices."
  - "State the invariant that survives every combination: source files plus tropo outrank any provider."
  - "Explain why recall returns typed RecallHit candidates instead of raw text chunks."
sources:
  - label: "Semantic memory — provider model and minimal interface"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/SEMANTIC-MEMORY.md"
    locator: "§ Provider model, §Minimal interface, L68-137"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Semantic memory — non-negotiables and config"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/SEMANTIC-MEMORY.md"
    locator: "§ Non-negotiables, §Config, L29-41, L204-225"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "HOWTO — Set up LanceDB storage (embedded backend)"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "§ Set up LanceDB storage, L136-163"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "README — package table (vivary-memory-cognee as its own line)"
    url: "https://github.com/vivary-dev/vivary/blob/dev/README.md"
    locator: "L22-29, L39"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "lancedb-axis"
    kind: "multiple-choice"
    prompt: "Where does the embedded LanceDB layer belong in the sidecar wiring?"
    options:
      - text: "Embedded LanceDB is the optional storage backend axis."
        correct: true
        feedback: "Correct. LanceDB is the storage axis, and it is optional — not required."
      - text: "Embedded LanceDB is the optional recall backend axis."
        feedback: "LanceDB stores rows; recall decides how they're found again, and that's a separate provider choice."
      - text: "Embedded LanceDB is the required storage backend axis."
        feedback: "File storage stays the default; embedded is an explicit install and migrate step, not a requirement."
      - text: "Embedded LanceDB is the optional review backend axis."
        feedback: "There is no review backend — Ozone reviews relationships; LanceDB only stores graph rows."
    success: "Correct. LanceDB is the storage axis, and it is optional — not required."
    reveal: "Compression: file vs. embedded is a storage question, full stop."
  - id: "recall-return-value"
    kind: "multiple-choice"
    prompt: "What does a local or Cognee recall provider actually hand back?"
    options:
      - text: "Recall returns typed candidates mapped to known node ids."
        correct: true
        feedback: "Correct. Recall returns typed candidates mapped to known node ids — never opaque text and never new truth."
      - text: "Recall returns typed chunks mapped to known node ids."
        feedback: "The interface explicitly returns node ids, types, paths, and scores, not opaque text chunks."
      - text: "Recall returns typed candidates written as new graph truth."
        feedback: "Recall never becomes graph truth; source files and tropo win whenever they disagree with a provider."
      - text: "Recall returns typed candidates ignoring every privacy filter step."
        feedback: "Privacy filtering is a precondition for indexing and recall, not something a provider is free to skip."
    success: "Correct. Recall returns typed candidates mapped to known node ids — never opaque text and never new truth."
    reveal: "Invariant: a hit that doesn't map to a known node id gets ignored, not returned."
  - id: "privacy-gate-order"
    kind: "multiple-choice"
    prompt: "When does privacy filtering apply relative to indexing and recall?"
    options:
      - text: "Privacy filtering happens before indexing, export, or recall."
        correct: true
        feedback: "Correct. Filtering is a hard gate before any indexing, embedding, export, or cache write — not an afterthought."
      - text: "Privacy filtering happens after indexing, export, and recall."
        feedback: "The non-negotiables require filtering before indexing, embedding, export, or cache write — not after."
      - text: "Privacy filtering happens only during Cognee's optional install."
        feedback: "Filtering is a workspace-wide gate, not something scoped to one optional adapter's install step."
      - text: "Privacy filtering happens whenever a provider feels stale."
        feedback: "Filtering is a hard pre-index gate, not a staleness heuristic tied to a doctor report."
    success: "Correct. Filtering is a hard gate before any indexing, embedding, export, or cache write — not an afterthought."
    reveal: "Use it later: \"filter, then index\" is the whole safety story for this sidecar."
---

> Storage and recall get read as one "smart memory" switch — until you trace what's actually implemented behind each one, and find out they install separately, configure in separate files, and fail separately.

## Why this exists

The goal here is narrow: stop collapsing embedded LanceDB storage and semantic recall into a single decision. They're two independent axes, and neither one is allowed to outrank the typed graph. Get this wrong and you'll ship a workspace where "turning on memory" silently means five different things depending on which file someone edited last.

## How it works

Hold both axes in one line: **storage decides where graph rows live. Recall decides how an agent finds them again — and source files plus tropo outrank both.**

**Storage axis — file vs. embedded.** File storage is the default; it needs no new dependencies. Embedded storage adds LanceDB through `pip install vivary-tropo[embedded]`, then an explicit `tropo migrate --from file --to embedded` step — preview with `--dry-run`, apply with `--yes`. It configures in `.vivary/storage.toml`. `tropo query` and `tropo find` already search analyzed typed graph nodes directly — id/title, frontmatter, path, body, edge context — without needing LanceDB at all. Embedded storage is a separate opt-in backend for migrated node rows and future local retrieval work, not a prerequisite for search.

**Recall axis — none vs. local vs. Cognee.** Recall is disabled by default. `--memory local` and `--memory cognee` both write separate retrieval policy into `.vivary/memory.toml`, on top of a `tropo` graph snapshot — never a database choice. Only the Cognee path has a shipped runtime today: the separate `vivary-memory-cognee` package with `vivary-cognee doctor / index / recall / forget`. Whether a local runtime provider ships before Cognee is an open question in the source docs — treat "local runtime" as unconfirmed, not shipped, until that changes.

**Four rules neither axis may break.** Graph truth outranks candidates: a provider may keep an index or embeddings, but that state is rebuildable from the typed graph and approved source files, and when they disagree, source files plus `tropo` win. The return contract is candidates, not chunks: `recall` returns a typed `RecallHit` — node id, type, path, score, reason, edge context — and the adapter ignores any hit that fails to map back to a known Vivary node id. The gate order is privacy-filters-before-indexing: `index()` is documented to receive only privacy-approved typed nodes and edges, so filtering is a precondition, never a cleanup step. And config stays separated: `.vivary/storage.toml` holds the database choice, `.vivary/memory.toml` holds retrieval policy — a workspace can pick file storage with no memory, embedded storage with no memory, or embedded storage plus memory, three independent combinations that imply nothing about each other.

## Don't conflate

- **A storage choice says nothing about a recall choice, or vice versa.** Bumping the LanceDB dependency version doesn't mean anything shipped on the recall side, and enabling `--memory local` doesn't require embedded storage.
- **Provider state is cache, not truth.** If a recall provider and the source files disagree about anything, the source files plus `tropo` win, every time, no exceptions.
- **Recall hits are structured records, not text dumps.** A `RecallHit` carries a node id an agent can look up in the graph — an unmapped hit gets dropped, not returned as loose text.
- **Package versions are independent.** `vivary-memory-cognee` ships its own version line in the README, separate from `vivary-tropo`, `vivary-ozone`, and `vivary-exo`. Don't infer sidecar readiness from a version bump on a different package.

## Try it on a real workspace

Take one storage choice — file or embedded — and one recall choice — none, local, or Cognee — and write down which config file each one touches. Then check current command help (`tropo migrate --help`, `create-vivary wizard --help`) against what you wrote, since this lesson's assigned sources document only the file and embedded storage backends; don't assume a cloud or sqlite backend is confirmed shipped without checking.

## One-minute recall

1. Draw one horizontal axis: file → embedded. Label it `storage.toml`.
2. Draw one vertical axis: none → local → Cognee. Label it `memory.toml`.
3. Mark the origin where both are off: still a complete, file-backed, graph-only workspace.
4. Underneath both axes, write the shared law: source files + tropo win when a provider disagrees.

## Sources

- [Semantic memory — provider model and minimal interface](https://github.com/vivary-dev/vivary/blob/dev/docs/SEMANTIC-MEMORY.md) (§ Provider model, §Minimal interface, L68-137)
- [Semantic memory — non-negotiables and config](https://github.com/vivary-dev/vivary/blob/dev/docs/SEMANTIC-MEMORY.md) (§ Non-negotiables, §Config, L29-41, L204-225)
- [HOWTO — Set up LanceDB storage (embedded backend)](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md) (§ Set up LanceDB storage, L136-163)
- [README — package table (vivary-memory-cognee as its own line)](https://github.com/vivary-dev/vivary/blob/dev/README.md) (L22-29, L39)
