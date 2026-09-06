# 02: Prove source integration can preserve history and dirty work
Type: outcome
Status: in-progress
Blocked-by: [01]
Unlocks: [04, 05]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Prove an import method that preserves selected Littleagent source, provenance, and recoverability without modifying either source checkout.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own an isolated proof fixture under `sandboxes/multi-project/source-integration/` and `docs/product/multi-project/receipts/02-source-preservation.md`. Read `migration.md` and ticket 01. Reuse source slices. Do not flatten Core or nest Littleagent `.git` metadata.

## Done condition

The receipt records selected paths, hashes, commit ancestry or attribution, dirty-file capture, restore steps, license findings, and a successful restoration in a disposable target.

## Verify

Run the bounded preservation and restore script against copies or fixtures. Compare the restored manifest and hashes with the recorded source manifest. Leave both source repositories unchanged.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Next packet

[02a](../packets/02a-source-preservation-fixture.md) completed the contract and
oracle. [02b](../packets/02b-restore-fixture-harness.md) completed synthetic
filesystem restoration in Habitat.

[Packet 12a's
receipt](../receipts/12a-root-vcs-observation-contract.md) records the accepted
trusted root/VCS observation inspection. Follow [the generated
frontier](../index.md) under [the loop-first
direction](../design.md#direction-decision-2026-09-06). Real-source selection,
attribution, history capture, and restoration remain open.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Synthetic restoration is verified by 02b. This does not prove preservation of real source, ignored resources, Git history, hosted records, or runtime state.
