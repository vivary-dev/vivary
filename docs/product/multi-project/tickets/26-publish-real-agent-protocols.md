# 26: Publish one real read-only service and OpenAPI catalog
Type: outcome
Status: planned
Blocked-by: [23, 24, 25]
Unlocks: [27, 31, 32, 33, 34, 35]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Publish one useful read-only Vivary HTTP service and an OpenAPI catalog that describes only its implemented operations.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the read-only service, OpenAPI document, API catalog entry, errors, rate limits, and direct tests. Read `release.md` and its raw receipt. Reuse an actual Agent-Native application or action only after version-matched proof. Tickets 31-35 own auth, MCP, A2A, browser tools, and web discovery.

## Done condition

The OpenAPI document matches a deployed staging service. Every operation returns real Vivary data within declared privacy and authority. Unsupported operations remain absent.

## Verify

Run OpenAPI validation, contract tests, rate-limit tests, privacy cases, and direct staging requests. Compare every catalog operation with the implemented router.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
