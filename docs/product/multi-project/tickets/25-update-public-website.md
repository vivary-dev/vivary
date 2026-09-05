# 25: Update and verify the public website
Type: outcome
Status: planned
Blocked-by: [23, 24]
Unlocks: [26, 27, 35]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Publish accurate product positioning, GUI pages, screenshots, compatibility, downloads, agent-facing content, and generated canonical documentation in the site build.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own `site/`, source assets, redirects, and website tests. Use `site/scripts/sync-docs.mjs` for generated docs and LLM files. Preserve useful URLs. Reconcile pre-existing website changes before publication work.

## Done condition

The built site presents the verified GUI and standalone paths, current versions, runtime and integration support, templates, Brain, guides, and maturity limits. Generated files match canonical sources.

## Verify

Run site sync, zero-diff generated parity, site tests, link checks, production build, and browser checks at desktop and narrow viewports. Review all changed screenshots.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
