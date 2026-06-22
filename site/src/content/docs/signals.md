---
title: "Public signals"
description: "Public npm, PyPI, and GitHub metrics snapshots."
---

Vivary tracks a small public metrics snapshot so the README and site can show real
distribution signals without a private analytics dashboard.

## Current sources

| Signal | Source | Notes |
|---|---|---|
| npm weekly downloads | `https://api.npmjs.org/downloads/point/last-week/%40vivary%2Fcreate` | Public weekly downloads for `@vivary/create`. |
| PyPI weekly downloads | `https://pypistats.org/api/packages/create-vivary/recent` | Public recent downloads for `create-vivary`. PyPI stats can lag and filter mirrors/bots. |
| GitHub stars/forks | `https://api.github.com/repos/vivary-dev/vivary` | Public repository signals only. |

The latest checked-in values live in [`stats/latest.json`](../stats/latest.json). The
history lives in [`stats/history.csv`](../stats/history.csv).

![Vivary public usage snapshot](/usage-snapshot.svg)

## Workflow

`.github/workflows/track-stats.yml` runs weekly and on manual dispatch. It calls
`tools/update_stats.py`, which updates:

- `stats/latest.json`
- `stats/history.csv`
- `stats/usage-snapshot.svg`
- `site/public/usage-snapshot.svg`

The workflow opens a PR against `dev`; it does not write directly to `dev` or `prod`.
If the normal daily stats branch already exists, the workflow creates a unique branch
for that run instead of force-pushing over it.

## How to read the chart

This is an early open-source project signal, not product analytics. Use it to see
whether the distribution surfaces are alive and whether the trend is moving; do not
over-interpret one row or compare npm and PyPI numbers as if the registries count the
same way.
