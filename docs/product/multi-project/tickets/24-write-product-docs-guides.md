# 24: Write installed docs, guides, and UI help
Type: outcome
Status: planned
Blocked-by: [05, 07, 08, 09, 10, 11, 15, 16, 17, 18, 19, 20, 21, 22, 23, 29, 30, 36]
Unlocks: [25, 26, 27]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Document every verified workflow, capability boundary, recovery path, migration step, and support state in canonical docs and in-product help.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own canonical `docs/`, README and changelog updates, app help, and guide verification. Read `release.md` guide inventory. Update behavior docs with their implementation tickets. Do not edit generated site mirrors by hand.

## Preparatory source navigation

[Packet 24a](../packets/24a-source-module-navigation.md) owns a bounded source graph
and four module routes over existing canonical records. It is independent preparatory
work. Its completion does not close installed guides or change the dependencies above.

## Done condition

The guide inventory in `release.md` is complete and follows installed behavior. Screens and commands match artifacts. Claims distinguish supported, optional, held, and unavailable behavior.

## Verify

Follow every guide from installed artifacts in isolated fixtures. Run documentation lint, command and package parity checks, link checks, and screenshot verification.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Preserve unresolved earlier dogfood, tutorial, and token-savings benchmark requirements through [the issue authority map](../issue-authority.md). Pilot cost metrics do not replace the separate comparative token-savings protocol.

- 2026-09-06: Prepare 24a for source navigation and module ownership after the owner requested progressive disclosure and open knowledge. Product documentation acceptance remains pending.
