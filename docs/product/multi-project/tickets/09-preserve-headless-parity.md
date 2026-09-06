# 09: Preserve standalone and headless operation parity
Type: outcome
Status: planned
Blocked-by: [04, 07, 08]
Unlocks: [23, 24]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Keep existing Vivary commands and structured project operations usable without the GUI, registry daemon, account, or network.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own headless application entry points, parity fixtures, and command docs. Read the static router in `packages/vivary/vivary_cli.py`, `design.md`, and tickets 04, 07, and 08. Avoid changing existing command meanings to fit the GUI.

## Done condition

Every supported GUI project operation has a deterministic headless contract. Existing `vivary`, `create-vivary`, Tropo, Strato, Ozone, and Exo flows retain characterized behavior.

## Verify

Run existing command characterization suites plus GUI-to-headless parity fixtures from installed artifacts. Prove the GUI process can remain closed.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
