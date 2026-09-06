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
- GREEN: 54/54 planning tests and the actual public plan consistency check passed.
- GREEN: 28/28 restoration tests and 47/47 filesystem fixture cases passed with no skipped tests.
- Checks ran as the existing non-root user in the bounded Habitat image, with networking disabled, a read-only root, no host mounts, all capabilities dropped, and no new privileges.
- The test container is limited to one CPU, 384 MiB memory, 64 processes, and a 128 MiB temporary filesystem. It uses the existing image; no dependency installation is required.
- The empty base64 string remains valid. Invalid characters, missing or excess padding, nonzero pad bits, and malformed tree mutation entries are rejected before creating a work directory.
- Expectation typos, wrong types, missing assertions, invalid references, and attempts to disable source preservation are rejected before materialization.
- Verification-result is the sole current result field; the log retains verification details and earlier failing runs. Duplicate or ambiguous result fields cannot satisfy completion.

## Reviewed source hashes

| Artifact | SHA-256 |
| --- | --- |
| `scripts/check_multi_project_plan.py` | `d4ae65b36c49043f29b6e30e2e3bfd52776b33b8e9079ec9209affadb24c7e25` |
| `scripts/tests/test_multi_project_plan.py` | `a4956c79cb332c98de3f59f7a717f3a457fe9430996bf41f4214639ff9a88b8a` |
| `scripts/prove_multi_project_source_preservation.mjs` | `901500c89d0a08e4483025b477adedc688247f56f5d8dc1c13bab5e5ed0e3cc2` |
| `scripts/tests/test_prove_multi_project_source_preservation.mjs` | `bcfedfec49182e0a5efcf317879d74bea1d4300bd92e5d6afaf1b8514d55a18b` |

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

## Complete fixture validation

Automated review of commit `b0f0f7e` found five remaining validation gaps. This
pass checks the complete fixture description before filesystem setup and makes
each declared assertion affect the result:

| Review | Finding | Resolution |
| --- | --- | --- |
| [3942983059](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942983059) | Invalid intermediate tree entries | Validate each tree mutation immediately, including entries removed by a later mutation. |
| [3942983068](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942983068) | Ignored trees under noWrites | Compare every declared target and temporary tree even when noWrites is true. |
| [3942983073](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942983073) | Missing response assertions | Check returned verifiedPaths and ownedPaths as well as the corresponding receipt values. |
| [3942983076](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942983076) | Unchecked symbolic receipts | Validate receipt fields, references, manifest binding, and described target bytes before creating a work directory. |
| [3942983077](https://github.com/vivary-dev/vivary/pull/329#discussion_r3942983077) | Receipt directory traceback | Require regular evidence files and reject directory anchor targets with validation errors. |

The evidence-directory regression failed for both plain and anchored links before
its fix (54 planning tests, two error subcases). The four reported restoration
regressions failed before their fixes (23 tests, four failures). The fixture audit
added two failing test groups covering ignored setup fields and ineffective faults
(25 tests, six failures). Final passing counts are recorded above.

The audit also checked empty suites, exact setup and mutation fields, seed
manifests, JSON Pointer escaping and array removal, relative link targets, raw
parser input, and receipt bytes and metadata. Invalid descriptions fail before
work-directory creation. Executed assertions check both the returned result and
the receipt, including manifest/source binding and ordered output hashes and
sizes. Source preservation and every requested tree comparison remain active.

The final bounded review also rejected transient invalid policy values, unsafe
paths in unused manifest seeds, and positive raw input in parser-negative cases.
The added regression group failed before those fixes and passed afterward.
