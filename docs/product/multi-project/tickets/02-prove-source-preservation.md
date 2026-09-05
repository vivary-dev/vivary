# 02: Prove source integration can preserve history and dirty work
Status: needs-info
Blocked-by: [01]
Needs: Human acceptance of ticket 01, an owner-approved private source manifest, and a license disposition for every selected slice. The future proof script, test, fixture, and receipt paths below must exist before this ticket becomes actionable.
Unlocks: [04, 05]

## Goal

Prove an import method that preserves selected Littleagent source, provenance, and recoverability without modifying either source checkout.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own an isolated proof fixture under `sandboxes/multi-project/source-integration/` and `docs/product/multi-project/receipts/02-source-preservation.md`. Read `migration.md` and ticket 01. Reuse source slices. Do not flatten Core or nest Littleagent `.git` metadata.

## Done condition

The receipt records selected paths, hashes, commit ancestry or attribution, dirty-file capture, restore steps, license findings, and a successful restoration in a disposable target.

## Verify

Run the bounded preservation and restore script against copies or fixtures. Compare the restored manifest and hashes with the recorded source manifest. Leave both source repositories unchanged.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Next packet

- Scope: prove a copy-and-restore method with disposable fixtures. Do not edit a source checkout, import product code, or retire anything.
- Files: `scripts/prove_multi_project_source_preservation.py`, `scripts/tests/test_prove_multi_project_source_preservation.py`, `tests/fixtures/multi-project/source-preservation/`, and `docs/product/multi-project/receipts/02-source-preservation.md`.
- Acceptance: the approved manifest binds source class, selected relative paths, content hashes, history or attribution method, dirty-file capture, license disposition, restore destination, and owner. A disposable restoration matches the manifest, and both source repositories remain unchanged.
- Behavior commands after the missing inputs and files exist:

```console
python -m pytest scripts/tests/test_prove_multi_project_source_preservation.py -q
python scripts/prove_multi_project_source_preservation.py --fixture tests/fixtures/multi-project/source-preservation --output docs/product/multi-project/receipts/02-source-preservation.md --check
```

These commands define the required future interface. This ticket does not claim that the files exist or the commands pass.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
