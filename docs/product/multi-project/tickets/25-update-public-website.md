# 25: Update and verify the public website
Type: outcome
Status: planned
Blocked-by: [23, 24]
Unlocks: [26, 27, 35]

Execution: Read and claim the live [GitHub issue](https://github.com/vivary-dev/Vivary-New/issues). Its dependencies govern starting work. Use [the graph](../graph.md) for supporting references. Parent dependencies still gate outcome completion, not independent preparation.

## Goal

Publish accurate product positioning, GUI pages, screenshots, compatibility, downloads, agent-facing content, and generated canonical documentation in the site build.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Implement and test the public site in `vivary-dev/vivary-site` under that repository's `AGENTS.md`. This outcome coordinates delivery, preserves or redirects existing URLs, and retires the legacy `site/` after replacement. Reconcile pre-existing website changes before publication work.

## Done condition

The built site presents the verified GUI and standalone paths, current versions, runtime and integration support, templates, Brain, guides, and maturity limits. Generated files match canonical sources.

## Verify

Run the target repository's checks for generated documentation, tests, links, production build, and browser behavior at desktop and narrow viewports. Verify the legacy URL handover and review all changed screenshots.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-13: The new public site is its own repository, `vivary-dev/vivary-site`, with the home page locked in by Jeff. See [website-repo.md](../research/website-repo.md). The Astro `site/` here is the old site and is inspiration only. This outcome now owns the handover of URLs and the retirement of `site/`, not a rebuild.

- 2026-09-16: Home page rebuilt to Jeff's design canvas with the delivered brand system; `/what-is-vivary/` and `/commands/` added; robots, sitemap, Open Graph, JSON-LD, and `llms.txt` in place. Noindex preview at https://vivary-dev.github.io. Domain, URL handover, and publication remain open. See [website-repo.md](../research/website-repo.md).
