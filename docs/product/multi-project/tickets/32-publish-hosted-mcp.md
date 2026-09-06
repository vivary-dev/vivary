# 32: Publish a hosted MCP endpoint and card
Type: outcome
Status: planned
Blocked-by: [26]
Unlocks: [27, 35]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Expose selected real public Vivary operations through a hosted MCP transport and publish a truthful MCP card.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own hosted MCP transport, tool schemas, capability card, limits, cancellation, and tests. Keep the existing local standard-input and standard-output MCP adapter separate. Reuse only implemented ticket 26 operations.

## Done condition

An MCP client discovers the card, connects through the advertised transport, lists the exact tools, invokes them, cancels work, and receives bounded errors. The card does not claim local workspace access.

## Verify

Run the pinned MCP conformance suite, tool schema tests, cancellation and limit tests, and direct staging calls. Compare every card tool with an implemented operation.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
