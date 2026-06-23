---
title: "Public signals"
description: "Public npm, PyPI, and GitHub metrics snapshots."
---

Vivary tracks a small public metrics snapshot so the README and site can show real
distribution signals without a private analytics dashboard.

## Current sources

| Signal | Source | Notes |
|---|---|---|
| npm weekly downloads | `https://api.npmjs.org/downloads/point/last-week/%40vivary%2Fcreate` and `https://api.npmjs.org/versions/%40vivary%2Fcreate/last-week` | Public weekly and per-version downloads for `@vivary/create`. |
| PyPI weekly downloads | `https://pypistats.org/api/packages/<package>/recent` | Public recent downloads for `create-vivary`, `vivary-tropo`, `vivary-ozone`, and `vivary-exo`. PyPI stats can lag, rate-limit, and filter mirrors/bots. |
| GitHub repo signals | `https://api.github.com/repos/vivary-dev/vivary` | Public repository stars, forks, issues, and pushed time. |

The latest checked-in values live in [`stats/latest.json`](../stats/latest.json). The
history lives in [`stats/history.csv`](../stats/history.csv).

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

The updater retries transient registry failures. If a source fails but a previous
value exists, the snapshot is marked `stale` and records the warning in
`stats/latest.json` and `stats/history.csv`. If a source fails with no previous value,
the workflow fails instead of writing fake zeroes.

## How to read the chart

This is an early open-source project signal, not product analytics. Use it to see
whether the distribution surfaces are alive and whether the trend is moving; do not
over-interpret one row or compare npm and PyPI numbers as if the registries count the
same way.
