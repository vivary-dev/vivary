# Late PR 328 review fixes

The first [review receipt](pr-328-code-review.md) records 40 resolved threads.
Six additional findings arrived on the reviewed commit after PR 328 merged.
This follow-up closes those validation gaps under the same owner instruction
to fix the review findings and merge the corrected work into dev.

## Dispositions

| Review | Finding | Resolution |
| --- | --- | --- |
| [3942709830](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942709830) | Duplicate external gate metadata | Reject repeated fields before the final value can replace an owner hold. |
| [3942709831](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942709831) | Negated verification prose | Require an explicit Verification-result: passed field on each done record. |
| [3942709832](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942709832) | Unrelated evidence receipts | Require a unique Evidence-record header matching the record ID. |
| [3942709833](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942709833) | Credentials in public JSON | Scan public text and decoded JSON strings, preserving duplicate-key values. |
| [3942709835](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942709835) | Malformed fixture base64 | Require canonical base64 in declared trees and tree mutation entries before work-directory creation. |
| [3942709836](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942709836) | Incomplete fixture assertions | Validate every expectation field and require source preservation plus no writes or complete expected post-state. |

## Verification

- RED: the four planning regressions failed against the accepted validator (37 tests, four failures).
- RED: both restoration regressions failed against the accepted runner (18 tests, two failures); canonical cases still reported 47/47.
- Independent review added six failing boundary cases to the first planning candidate (49 tests, six failures): empty gate IDs, duplicate gate fields, malformed/non-UTF-8/BOM JSON, and historical log details under the explicit result field.
- GREEN: 53/53 planning tests and the actual public plan consistency check passed.
- GREEN: 19/19 restoration tests and 47/47 filesystem fixture cases passed with no skipped tests.
- Checks ran as the existing non-root user in the bounded Habitat image, with networking disabled, a read-only root, no host mounts, all capabilities dropped, and no new privileges.
- The test container is limited to one CPU, 384 MiB memory, 64 processes, and a 128 MiB temporary filesystem. It uses the existing image; no dependency installation is required.
- The empty base64 string remains valid. Invalid characters, missing or excess padding, nonzero pad bits, and malformed tree mutation entries are rejected before creating a work directory.
- Expectation typos, wrong types, missing assertions, invalid references, and attempts to disable source preservation are rejected before materialization.
- Verification-result is the sole current result field; the log retains verification details and earlier failing runs. Duplicate or ambiguous result fields cannot satisfy completion.

## Reviewed source hashes

| Artifact | SHA-256 |
| --- | --- |
| `scripts/check_multi_project_plan.py` | `6d43f48aac569e6188fea8674666aa9f9b1a658f5dc04437815dff18a88ad5d0` |
| `scripts/tests/test_multi_project_plan.py` | `79a8f2bbe2d7b1500d949cbe5306c62738f034c68e382d28131c7cfe6f098cf4` |
| `scripts/prove_multi_project_source_preservation.mjs` | `6f8e23817c29262a107910b0faca71d7639798d50b245280882fe3d0dac0d5f2` |
| `scripts/tests/test_prove_multi_project_source_preservation.mjs` | `5cdc785c7a6cc69953e972b102d7aa638a4566917e21fbe3b99de0e2e7b7f270` |

These checks establish fixture and planning validation behavior. They do not
complete a product outcome, activate a factory, prove a coding runtime, or
change published package versions. [Packet 12a](../packets/12a-root-vcs-observation-contract.md)
remains the next prepared implementation packet.

## PR 329 review

Automated review of commit `196117b` identified four additional issues. The final
follow-up fixes them before merge:

| Review | Finding | Resolution |
| --- | --- | --- |
| [3942902152](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942902152) | Changelog chronology | Move the validation fix into the current September 2 development entry and regenerate its mirrors. |
| [3942902153](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942902153) | Incomplete mutation preflight | Compose each fixture case with the existing mutation logic and validate all resulting trees before creating a work directory. |
| [3942902155](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942902155) | Non-standard JSON constants | Reject NaN, Infinity, and negative Infinity through the JSON parser's constant callback. |
| [3942902157](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942902157) | Symlink traversal in plan scanning | Reject symlinks before reading plan content or rendering outputs, and verify containment for remaining entries. |

The mutation regression failed before its fix (19 tests, one failure). The JSON
constant and symlink regressions failed before their fixes (51 tests, six failing
subcases). Final passing counts are recorded above. Refused render operations
preserve their existing graph and index. These checks use synthetic fixtures;
they do not read real private source files.
