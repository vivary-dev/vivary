# 34: Publish working browser WebMCP tools
Type: outcome
Status: planned
Blocked-by: [26, 31]
Unlocks: [27, 35]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Expose selected real site operations as browser tools with truthful discovery, permissions, abort behavior, and fallback UI.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own browser tool registration, UI affordances, permission handling, abort support, and browser tests. Reuse ticket 26 routes and ticket 31 scopes. Support only verified browsers and keep ordinary site use intact.

## Done condition

A supported browser discovers and invokes each advertised tool. Unsupported browsers retain the normal UI. Permission refusal and abort produce bounded results without partial effects.

## Verify

Run browser tests in every supported engine for discovery, invocation, refusal, abort, navigation, and fallback. Compare registered tools with implemented operations.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
