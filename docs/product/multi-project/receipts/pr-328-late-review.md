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
- GREEN: 49/49 planning tests and the actual public plan consistency check passed.
- GREEN: 18/18 restoration tests and 47/47 filesystem fixture cases passed with no skipped tests.
- Checks ran as the existing non-root user in the bounded Habitat image, with networking disabled, a read-only root, no host mounts, all capabilities dropped, and no new privileges.
- The test container is limited to one CPU, 384 MiB memory, 64 processes, and a 128 MiB temporary filesystem. It uses the existing image; no dependency installation is required.
- The empty base64 string remains valid. Invalid characters, missing or excess padding, nonzero pad bits, and malformed tree mutation entries are rejected before creating a work directory.
- Expectation typos, wrong types, missing assertions, invalid references, and attempts to disable source preservation are rejected before materialization.
- Verification-result is the sole current result field; the log retains verification details and earlier failing runs. Duplicate or ambiguous result fields cannot satisfy completion.

## Reviewed source hashes

| Artifact | SHA-256 |
| --- | --- |
| `scripts/check_multi_project_plan.py` | `8d65ba743ae1d5988be69344a90d0fe52afa0106fce2f93f856adf4acb37829d` |
| `scripts/tests/test_multi_project_plan.py` | `e752d50fd050ed88607a27f93e0090dce0c3d3c29d848ac0371e387fdd07cea3` |
| `scripts/prove_multi_project_source_preservation.mjs` | `3bb81e9d2a9e30a20ae8711a6fcac482d25f042b4162724916706b1876ed10c9` |
| `scripts/tests/test_prove_multi_project_source_preservation.mjs` | `28bd8872eb9f5d4ffb06cfb36390af5f53c50ca1011cab2f36e609d4b55d9013` |

These checks establish fixture and planning validation behavior. They do not
complete a product outcome, activate a factory, prove a coding runtime, or
change published package versions. [Packet 12a](../packets/12a-root-vcs-observation-contract.md)
remains the next prepared implementation packet.
