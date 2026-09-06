# 35: Complete DNS, headers, Markdown, skills, and ARD discovery
Type: outcome
Status: planned
Blocked-by: [25, 26, 31, 32, 33, 34]
Unlocks: [27]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Complete the remaining web discovery checks using the deployed services and the owner's actual bot and content policies.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own Link headers, content negotiation, cache variation, Content Signals, skills index, ARD manifest, DNS-AID records, redirects, and direct receipts. Read `release.md` and current primary specifications. External dependency: The repository owner must select the canonical domain, DNS authority, bot policy, and approve each DNS or policy change.

## Done condition

HTML and useful Markdown negotiate correctly. Headers and discovery documents point only to live services. DNS answers match authoritative configuration. Skills and ARD entries describe implemented operations. Commerce stays absent when the scanner marks it not applicable.

## Verify

Run header and cache tests, Markdown comparisons, schema validators, authoritative DNS queries, public resolver queries, redirect checks, crawler-policy checks, and direct production-like staging requests.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
