# 27: Deploy, release, and pass the actual 100 percent readiness gate
Type: outcome
Status: planned
Blocked-by: [13, 23, 24, 25, 26, 31, 32, 33, 34, 35, 36]
Unlocks: [28]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Publish approved artifacts and the production site, verify live behavior, then obtain a real 100 percent result from isitagentready.com before any agent-ready announcement.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the coordinated release receipt and postdeployment proof described in `release.md`. External dependency: each package publish, deployment, DNS change, auth enablement, repository release, and announcement requires its own human approval. Baseline is 22 advertised checks, 16 scored, 3 passing at Level 1, commerce not applicable, and no official overall percentage.

## Done condition

Registries, downloads, production pages, redirects, API and protocol routes, auth, and supported operations match the deployed commit. The real `all` profile reports 100 percent on the canonical URL. Raw response, screenshot or result URL, timestamp, applicability, and direct service proofs are retained.

## Verify

Run clean installed-artifact smokes and live URL checks. Run the real isitagentready.com `all` profile after deployment. Do not calculate a substitute percentage or disable failed checks. Complete release notes only after the gate passes.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
