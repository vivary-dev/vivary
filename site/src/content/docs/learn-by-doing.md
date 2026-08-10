---
title: "Learn by doing"
description: "A concise, evidence-led path to inspecting Vivary, previewing additive adoption, and understanding governed context."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/LEARN-BY-DOING.md"
---

This is the shortest evidence-led path through one Vivary loop. Complete
[Getting started](/getting-started/) for installation and preset choice; the
[full walkthrough](/walkthrough/) owns the recorded public proof, and the
[command reference](/commands/) owns exact flags, output envelopes, and exit
codes. This page routes to those owners instead of replacing them.

## Create a disposable workspace

Run this in a directory you can discard:

```bash
create-vivary init demo-vivary-workspace --preset coding --no-wizard
create-vivary doctor demo-vivary-workspace
tropo check --root demo-vivary-workspace
```

The [recorded public fixture](/walkthrough/#1-scaffold-a-workspace) wrote 38
files. Its [health run](/walkthrough/#2-prove-workspace-health) recorded
`doctor`: 9 nodes, 28 edges, 0 broken refs; `memory`: disabled; and `tropo
check`: 9 documents, 0 errors, 0 warnings. Those are fixture evidence, not a
promised count for every workspace. Verified: 2026-08-09.

## Inspect the graph before changing it

```bash
ozone review --root demo-vivary-workspace
exo board --root demo-vivary-workspace
ozone impact human-gates --root demo-vivary-workspace
```

In that same public fixture, the [review and board run](/walkthrough/#3-run-review-and-coordination)
recorded 9 reviewed nodes with no Ozone warnings or notes and two Exo work
items. The [impact run](/walkthrough/#4-name-impact-before-changing-things)
found eight dependent nodes for `human-gates`. Treat those values as observed
fixture output; your workspace's graph determines its own result. Verified:
2026-08-09.

## Read findings before repairing them

- `tropo check` validates document fields **and** resolves graph references. A
  `W220` names a reference whose target document id is missing; it is not a
  topology or coverage result. [The finding-code owner](/commands/#finding-codes)
  and its [Tropo regression fixture](https://github.com/vivary-dev/vivary/blob/dev/packages/tropo/tests/test_tropo.py#L408-L429)
  define that behavior. Verified: 2026-08-09.
- `tropo fix` removes derived-noise fields reported as `W210`; it does **not**
  remove an arbitrary unknown `type` field. Correct that field manually unless
  the product behavior changes. [The `fix` regression](https://github.com/vivary-dev/vivary/blob/dev/packages/tropo/tests/test_tropo.py#L351-L368)
  demonstrates the narrow de-noising contract. Verified: 2026-08-09.
- `create-vivary doctor` already invokes Tropo analysis and promotes Tropo
  findings into its health errors. Run `tropo check` when you need Tropo's own
  finding report as well. [Doctor's graph-validation owner](https://github.com/vivary-dev/vivary/blob/dev/packages/create-vivary/create_vivary.py#L892-L909)
  and the [command contract](/commands/#create-vivary--the-scaffolder) define
  the two reporting surfaces. Verified: 2026-08-09.
- Semantic memory is opt-in. `--auto` does not select local memory; when local
  memory is intended, say so explicitly:

  ```bash
  create-vivary init my-workbench --preset knowledge-work --memory local
  ```

  [Getting started](/getting-started/#2-create-a-workspace), the [scaffolder
  command contract](/commands/#create-vivary--the-scaffolder), and the
  [selection implementation](https://github.com/vivary-dev/vivary/blob/dev/packages/create-vivary/create_vivary.py#L3481-L3505)
  record that default and explicit choice. Verified: 2026-08-09.

## Continue with the right owner

- Follow the [full walkthrough](/walkthrough/) for the complete recorded first
  cycle and its public proof artifacts.
- Use the [command reference](/commands/) for flags, JSON envelopes, exit
  codes, repair boundaries, optional providers, and adoption.
- For an existing repository or vault, use the [adoption path](/getting-started/#adopt-an-existing-repo-or-vault): inspect `create-vivary adopt . --json` first and run `--yes` only after you approve the listed additions.
