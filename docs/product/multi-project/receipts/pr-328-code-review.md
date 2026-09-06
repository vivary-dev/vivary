# PR 328 code-review verification

Date: 2026-09-05. Scope: the existing Vivary program and proof-tool PR.
The owner authorized fixing review findings and then merging PR 328 into `dev`.
Review began at `b4fd6f387a369a8e8ead10c6897ea99cbe563e49` against base
`df8a1c33b046e4af21f36a0aee6019f995dbe290`.

## Standards review

The independent standards review covered repository rules, planning integrity,
scope ownership, source citations, entry points, privacy checks, and release
truth. Confirmed findings have corrections or regression evidence below.
Four old execution comments are superseded by the owner's BrowserPod
unavailability decision and completed Habitat work. The inactive BrowserPod
packet cannot be reactivated without addressing its deferred checks.

## Spec review

Independent registry and restoration reviews compared the code with the owning
contracts. Fixes bind reservation ownership to authenticated scope, reject
relocated bindings and unsafe paths, preserve historical receipt identity,
validate malformed atomic inputs, and prevent duplicate fixture coverage.
The coordinating reader additionally reproduced an old owner being authorized
alongside a newer overlapping reservation. The final model rejects that state
and retains the valid disjoint-reservation control.

## Verification

The existing Habitat image was used without installation: Linux, Node 22.23.2,
Python 3.11.16, user 1000:1000, no network or host/credential mounts, read-only
root filesystem, all capabilities dropped, and no-new-privileges. Limits were
384 MiB memory and swap combined, one CPU, 64 processes, and a 128 MiB temporary
filesystem. Image SHA-256:
`ffdba5d54dd6f91875fa60fc15103b6b30bb23ecaaf2d8ed65559d3cdff05bee`.

The original registry/restoration suites passed 39 tests. New registry tests
then demonstrated seven failing groups; planning regressions demonstrated
14 failures. Restoration's first expanded run also caught a malformed test
mutation, which was corrected before acceptance. The registry replay setup and
deliberate-mutant replacement were corrected when the stricter representation
exposed outdated test assumptions. The final results were:

| Verification | Result |
| --- | --- |
| Registry Node suite | 38 passed; 0 failed |
| Registry exact decision oracle | 57/57 passed |
| Restoration Node suite | 16 passed; 0 failed; 0 skipped |
| Real synthetic restoration oracle | 47/47 passed |
| Planning Python suite | 33 passed |
| Independent scope, device, historical replay, relocation, and conflict probes | 5/5 passed |
| Public planning overlay render, links, and frontier | Passed |

Commands executed inside Habitat:

```console
node --test scripts/tests/test_registry_contract_model.mjs
node scripts/registry_contract_model.mjs --fixture docs/product/multi-project/fixtures/project-registry.json --check
node --test scripts/tests/test_prove_multi_project_source_preservation.mjs
node scripts/prove_multi_project_source_preservation.mjs --fixture docs/product/multi-project/fixtures/source-preservation.json --check
python3 scripts/tests/test_multi_project_plan.py
python3 scripts/check_multi_project_plan.py --render
```

The root-only permission-skip probe could not start under the retained isolation
profile: UID 0 cannot traverse the image's Node installation with all capabilities
dropped, and the temporary filesystem is `noexec`. The explicit skip condition
was reviewed; real unprivileged permission refusal passed. No isolation setting
was relaxed. This limitation does not establish root-process execution behavior.

## Verified artifact identities

The installed artifacts matched these reviewed and executed source bytes:

| Artifact | SHA-256 |
| --- | --- |
| `scripts/registry_contract_model.mjs` | `58b283317f3b3a4e80622935c18e174203aec6bf44f1ce98e01efed8121cd38d` |
| `scripts/tests/test_registry_contract_model.mjs` | `ea274c0fbce7fa103f6699afecc9c2b157d3b58e3fa67895a931ccffca90dc42` |
| `scripts/prove_multi_project_source_preservation.mjs` | `49e38da368cef3aea3bf7d3060a911ca9a0953924d4769a4b7543227238224b3` |
| `scripts/tests/test_prove_multi_project_source_preservation.mjs` | `447d74ff6a8ad8c97bc80b6a6580e13a6ab278b35381949587b958d7ea150b98` |
| `docs/product/multi-project/fixtures/project-registry.json` | `a9f918f0b4df2e6fdc63ade4bf26b5f19e135d9291191244466a22f413b8715b` |
| `docs/product/multi-project/fixtures/source-preservation.json` | `741917e81dec48dc900cde26f95756fac2945a4d0b91f57fccef7ea7864f0d4d` |
| `scripts/check_multi_project_plan.py` | `8ed867af86e079b74c8333d0f14cbe734c023d9dffd43e91f743d0482e0eb6fc` |
| `scripts/tests/test_multi_project_plan.py` | `c4e23014824e5cd4670524392ea9f3c4c2be95ae707c0036d096f0b449c338e1` |

## Review-thread dispositions

Every fetched review thread has one disposition. `fixed` includes findings
already corrected before this pass; `obsolete` records superseded execution
authority, not an implemented BrowserPod capability.

| Review thread | Disposition | Evidence |
| --- | --- | --- |
| [3941799695](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799695) | fixed | Exact `render_graph()` equality covers tables and Mermaid edges; current tests `test_frontier_drift_fails` and `test_mermaid_drift_fails`. |
| [3941799701](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799701) | fixed | All 36 outcome files link the canonical planning checks in execution-contract.md, including the line-ending check. |
| [3941799709](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799709) | fixed | `PRIVATE_TEXT_SUFFIXES` and `test_private_path_in_raw_evidence_fails` cover the added `.txt` evidence format. |
| [3941799714](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799714) | fixed | Done records now require a resolvable receipt link and a log containing a recorded completed/passed/verified result; both false-green forms have regressions. |
| [3941799721](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799721) | fixed | Start-dependency enforcement includes `ready-for-human`; regression uses a planned dependency plus an exact `Needs` value. |
| [3941799730](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799730) | fixed | The guard validates Markdown fragments; the missing-anchor regression passes. |
| [3941799733](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799733) | fixed | `evidence.md` cites verified source ranges: `plan_adopt` 5346-5660 and `adopt_workspace` 6342-6536. |
| [3941799739](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799739) | fixed | `AGENTS.md` starts at generated `multi-project/index.md`; `render_index()` derives ready/in-progress links from the same records as `graph.md`. |
| [3941799744](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941799744) | fixed | CHANGELOG.md records the development program, executable proof tools, and 33-test planning verification without release claims. |
| [3941984905](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941984905) | fixed | Receipt 01 routes through the generated graph and packet links; staged text also records 02b's actual Habitat execution instead of BrowserPod. |
| [3941984906](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941984906) | obsolete | 10b lines 10 and 24-27 say the packet and procedure are inactive and must not be prepared or run. Reopening 10b must move or implement the app-bridge isolation proof. |
| [3941984908](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941984908) | fixed | Ticket 19 declares `External-gates: [template-installer]`; external dependencies name its held status, owner, and required outcome; the guard rejects done while held. |
| [3941984910](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941984910) | fixed | The 47-case restoration oracle and an independent unreadable outside sentinel cover intermediate source links and unchanged output trees. |
| [3941984913](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941984913) | fixed | Packet 03a now uses branch-aware `gh pr checks`, which selects the pull request belonging to the current branch. |
| [3941984917](https://github.com/vivary-dev/vivary/pull/328#discussion_r3941984917) | obsolete | 10b is explicitly inactive at lines 10 and 24-27, so no install may occur. Reactivation must restore deny-list, audit, and version-vetting gates. |
| [3942014268](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942014268) | fixed | `parse_header()` reads only the contiguous header block, reports duplicates, allows the canonical blank line after H1, and ignores later `Status:` log text. |
| [3942014271](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942014271) | fixed | Outcome dependencies are rejected unless their target record is an outcome; a packet-edge regression proves the boundary. |
| [3942014273](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942014273) | fixed | Packet numeric prefix must equal `Parent`; `02a` with `Parent: 03` is rejected. |
| [3942014274](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942014274) | fixed | Retained scopes are extracted only from the second cell of the 36 outcome rows; a footer token cannot hide a missing row mapping. |
| [3942014276](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942014276) | fixed | Nine added fixture cases cover nested history, attribution, and exclusion field sets, types, and semantics. |
| [3942014277](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942014277) | obsolete | 10b's procedure is retained only as inactive historical planning. Reactivation must add a command that executes and asserts the probe effects. |
| [3942158434](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942158434) | fixed | A direct registry regression proves export refuses a mismatched project binding. |
| [3942158438](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942158438) | fixed | Filename-derived IDs must match the H1 ID before graph rendering; copied `# 99` content is rejected. |
| [3942158442](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942158442) | obsolete | The unavailable-BrowserPod premise was superseded by authorized Habitat 10c; 03b is now done with 10c as its satisfied runtime dependency. |
| [3942158445](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942158445) | fixed | The contract explicitly rejects unpaired surrogates, and direct display-name object input has a passing refusal regression. |
| [3942158446](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942158446) | fixed | Complete and incomplete receipt cases reject changed selected and unselected source bytes before another write. |
| [3942359401](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942359401) | fixed | A done outcome now enumerates child packets and rejects every non-done child; regression keeps 02a ready while marking 02 done. |
| [3942359406](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942359406) | fixed | Write-back requires one complete matching reservation and rejects any other overlapping active owner. Split-record and newer-owner regressions pass. |
| [3942359409](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942359409) | fixed | Drive-absolute and drive-relative Windows prefixes are rejected by relativePath and focused regressions. |
| [3942359412](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942359412) | fixed | applyAtomicTransition validates the envelope before dereference; null, empty, and partial inputs return invalid-input without changing state. |
| [3942500033](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942500033) | fixed | Reservations record actor, collection, and device ownership. Foreign-scope operation-ID reuse is denied; device/key consistency is validated. |
| [3942500039](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942500039) | fixed | Admission and write-back compare the observed location with the binding and return stale-binding after relocation. |
| [3942500040](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942500040) | fixed | Registry fixture case IDs are validated for uniqueness before any case evaluation. |
| [3942500041](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942500041) | fixed | The fixture set operation defines own enumerable fields, including __proto__, without mutating prototypes. |
| [3942536366](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942536366) | fixed | `native-owners.md` now names Habitat as current and BrowserPod as unavailable/inactive; the 10c receipt is consistent. |
| [3942536369](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942536369) | fixed | Restoration validates unique nonempty string case IDs before creating a temporary directory; duplicate-ID regression passes. |
| [3942536370](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942536370) | fixed | The permission test skips Windows and UID 0. Its unprivileged behavior passed; the root-only execution limit is recorded below. |
| [3942536371](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942536371) | fixed | The restoration receipt links the generated graph rather than repeating a next-packet ID. |
| [3942536374](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942536374) | fixed | `has_receipt_link()` requires a resolvable Markdown file under the program receipts directory; `Evidence: pending` is rejected. |
| [3942536375](https://github.com/vivary-dev/vivary/pull/328#discussion_r3942536375) | fixed | Admission receipts retain immutable VCS facts. Replay checks the complete stored resource IDs while legitimate later observation changes still reconcile. |

## Limits and continuation

No production database, trusted physical-root adapter, real-source import,
coding-agent runtime, factory, outbound mail, package release, or repository
retirement is proved by this work. The generated [frontier](../index.md) owns
the next implementation packet. Later receipts retain their historical results.
