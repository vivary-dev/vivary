---
title: "Public signals"
description: "Public npm, PyPI, and GitHub metrics snapshots."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/SIGNALS.md"
---

Vivary tracks a small public metrics snapshot so the README and site can show real
distribution signals without a private analytics dashboard.

## Current sources

| Signal | Source | Notes |
|---|---|---|
| npm weekly downloads | `https://api.npmjs.org/downloads/point/last-week/%40vivary%2Fcreate` and `https://api.npmjs.org/versions/%40vivary%2Fcreate/last-week` | Public weekly and per-version downloads for `@vivary/create`. |
| PyPI weekly downloads | `https://pypistats.org/api/packages/<package>/recent` | Public recent downloads for `create-vivary`, `vivary-tropo`, `vivary-ozone`, and `vivary-exo`. PyPI stats can lag, rate-limit, and filter mirrors/bots. |
| GitHub repo signals | `https://api.github.com/repos/vivary-dev/vivary` | Public repository stars, forks, issues, and pushed time. |

The latest checked-in values live in [`stats/latest.json`](https://github.com/vivary-dev/vivary/blob/dev/stats/latest.json). The
history lives in [`stats/history.csv`](https://github.com/vivary-dev/vivary/blob/dev/stats/history.csv).

![Vivary public usage snapshot](/usage-snapshot.svg)

## Workflow

`.github/workflows/track-stats.yml` runs daily and on manual dispatch. It calls
`tools/update_stats.py`, which updates:

- `stats/latest.json`
- `stats/history.csv`
- `stats/usage-snapshot.svg`
- `site/public/usage-snapshot.svg`

The workflow opens a PR against `dev`; it does not write directly to `dev` or `prod`.
If the normal daily stats branch already exists, the workflow creates a unique branch
for that run instead of force-pushing over it.

The updater authenticates only requests to `api.github.com` with the workflow's
short-lived repository token. That credential is never forwarded to npm or PyPI.
Transient registry failures use bounded exponential retry and honor numeric
`Retry-After` values up to 30 seconds. If a source fails but a previous value exists,
the snapshot is marked `stale` and records the warning in `stats/latest.json` and
`stats/history.csv`. If a source fails with no previous value, the workflow fails
instead of writing fake zeroes.

Every generated snapshot remains inspectable in a PR and receives an exact-head CI
dispatch. Because a PR created with the repository token otherwise receives
approval-required checks, the workflow explicitly dispatches `ci.yml` against the
stats branch. CI verifies the named PR's live head and base SHAs before running the
normal tests, graph review, and conditional site build. Only an `ok`, warning-free,
non-stale snapshot receives `automated-current` and enables auto-merge. A stale
snapshot receives `blocked`, remains open without auto-merge, and cannot supersede an
older healthy proposal.

The daily steward checks more than age: the checked-in snapshot must be fresh, `ok`,
warning-free, and free of nested stale-source flags. Every open PR must also carry
exactly one lifecycle label defined in
[Contributing](https://github.com/vivary-dev/vivary/blob/dev/CONTRIBUTING.md#pull-requests).
Automated proposals with a merge conflict or failing check remain findings and must be
reclassified `blocked`. Serialized healthy stats runs may close only older stats PRs,
with a replacement receipt; branch deletion remains a separate destructive gate.

## How to read the chart

This is an early open-source project signal, not product analytics. Use it to see
whether the distribution surfaces are alive and whether the trend is moving; do not
over-interpret one row or compare npm and PyPI numbers as if the registries count the
same way.

The SVG chart size is fixed (`760x300`). The npm and PyPI bars are proportional to
the larger of the two weekly counts in that snapshot, so a bar can shrink even when
the total package download number rises. That is a data-scale change, not a badge or
container resize.
