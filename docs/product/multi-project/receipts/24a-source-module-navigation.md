# 24a source module navigation receipt

Evidence-record: 24a
Date: 2026-09-06. Verification kind: inspection.
Result: bounded source navigation accepted after independent PR correction review.

## Implemented boundary

The [source map](../source-map/index.md) contains one untyped router, four typed
module records, and eleven typed source-reference records. The source records own
repository-relative locators to existing canonical contracts, implementation, tests,
and accepted evidence. They do not copy the source or create another specification.

The four module records identify outcome ownership, caller-visible behavior and
errors, hidden implementation concerns, dependencies, and known gaps. In particular:

- Core supplies bounded Git topology observations, but its path-derived graph
  identities do not satisfy the trusted mutation identity required by 12a.
- The registry JavaScript model proves contract transitions, not production storage.
- Preserved host evidence does not prove a real coding-runtime session.
- Registry authorization evidence does not prove production project-file effects.

The checker loads the repository's existing Tropo implementation. It rejects any
source-map tree other than `tropo.toml`, the 16 selected Markdown records, and their
expected parent directories. It then verifies unique derived IDs, exact record paths
and types, raw typed-edge multiplicity plus the exact expected edge set, zero findings
or broken edges, and all eleven locators. Locator validation rejects noncanonical separators and segments,
absolute or escaping paths, missing or non-file targets, resolution failures, and
targets that resolve inside the source-map metadata tree. The CI contract requires
both the production checker and its focused regression suite exactly once in the
repository tests job.

## Observed graph

Tropo reported 16 documents, 16 unique nodes, 23 directed edges, and zero findings
or broken edges. The exact edge groups were:

| From | Typed relationship | To |
| --- | --- | --- |
| `source-map` | `module_refs` | `root-observation`, `project-registry`, `native-runtime`, `project-writeback` |
| `root-observation` | `contract_refs`<br>`source_refs`<br>`test_refs`<br>`evidence_refs` | `root-observation-contract`<br>`checkout-observer-code`<br>`checkout-observer-tests`<br>`observation-receipt` |
| `project-registry` | `contract_refs`<br>`source_refs`<br>`test_refs`<br>`evidence_refs`<br>`module_refs` | `registry-contract`, `registry-transactions`<br>`registry-model-code`<br>`registry-model-tests`<br>`registry-receipt`<br>`root-observation` |
| `native-runtime` | `contract_refs`<br>`source_refs`<br>`module_refs` | `program-execution`<br>`native-owners`<br>`project-registry` |
| `project-writeback` | `contract_refs`<br>`source_refs`<br>`evidence_refs`<br>`module_refs` | `registry-contract`<br>`native-owners`<br>`registry-receipt`<br>`root-observation`, `project-registry`, `native-runtime` |

`find "root observation"` returned five results at an estimated 556 of the
1,200-token budget. The first result was `root-observation`, including its four typed
outbound relationships. `blast root-observation-contract --depth 2` returned four
inbound impacts: `root-observation` at distance one, then `project-registry`,
`project-writeback`, and `source-map` at distance two.

## Focused refusal and continuity checks

The initial 13-test suite used disposable local fixtures and the production checker. It
proved refusal of a broken typed reference, duplicate derived ID, duplicate identical
edge, missing or empty locator, missing target, directory target, absolute path,
drive path, UNC path, backslash path, dot or parent segment, doubled separator,
out-of-root symlink, symlink loop, extra text file, nested config, and extra empty
directory. The duplicate-ID and duplicate-edge cases prove Tropo's set-like graph
views cannot hide repeated identities or edges.

The movement case preserved a source-reference filename and derived ID, moved its
fixture target, and changed only the owning locator. Every other source-map record and
incoming edge stayed identical. This proves navigation continuity across a target
move. It does not prove physical filesystem identity.

PR #336 review then exposed two missing refusal cases: a locator could directly
target its own or another source-map record, or reach one through a symlink outside
the source-map tree. Two focused tests reproduced that acceptance before the checker
changed. The current suite rejects both direct metadata targets and resolved aliases
into the metadata tree. Independent review then showed that resolving the source-map
root before inventory bypassed the existing root-symlink refusal. A focused test
reproduced that regression before validation restored the pre-resolution check.
Windows junction probes then exposed root and interior reparse-point indirection;
Windows-gated tests reproduced both cases before the checker added a Python 3.11
compatible `lstat` attribute check at the root and during inventory. The current
18-test suite passes. Two additional CI contract tests remove the checker and
regression-suite commands independently and prove either removal fails closed.

## Verification log

Python 3.14.3 and its required standard-library imports were available. The author
installed no package and started no app, container, coding runtime, schedule, or paid
service. No account or repository publication action ran.

| Command | Exit | Observed result |
| --- | ---: | --- |
| `python -B packages/tropo/tropo.py check --root docs/product/multi-project/source-map` | 0 | 16 documents, 0 errors, 0 warnings |
| `python -B packages/tropo/tropo.py graph --json --root docs/product/multi-project/source-map` | 0 | 16 nodes, 23 edges, 0 broken |
| `python -B packages/tropo/tropo.py find "root observation" --budget 1200 --json --root docs/product/multi-project/source-map` | 0 | 5 results, estimated 556 tokens |
| `python -B packages/tropo/tropo.py blast root-observation-contract --depth 2 --json --root docs/product/multi-project/source-map` | 0 | 4 inbound impacts through depth 2 |
| `python -B scripts/check-source-navigation.py --check` | 0 | 16 records, 23 edges, 11 locators, 0 broken |
| `python -B scripts/tests/test-source-navigation.py` | 0 | 18 tests passed after the new locator, root-link, and interior-junction refusal cases failed before implementation |
| `python -B scripts/check_ci_workflow.py` | 0 | Both Ubuntu tests and governed Windows verification require each source-navigation command exactly once |
| `python -B scripts/tests/test_ci_workflow.py` | 0 | 24 tests passed, including job-scoped removal of either command from Ubuntu or Windows |
| `python -B scripts/check_multi_project_plan.py --render` | 0 | Generated frontier and graph updated |
| `python -B scripts/check_multi_project_plan.py --check` | 0 | 36 outcomes and bounded packet graph passed |
| `python -B scripts/check_line_endings.py` | 0 | 425 tracked text files checked, with 4 unchanged legacy allowlist entries |
| `git diff --check` | 0 | No whitespace error |
| `npm run sync-docs` from `site/` | 0 | Changelog and LLM mirrors regenerated from canonical sources |
| `npm run build` from `site/` | 1 | Astro unavailable because this isolated worktree has no installed `site/node_modules` |

Because the repository line-ending checker inventories tracked files, a separate
carriage-return scan covered the new source-map records, receipt, checker, and tests.
All new text uses LF only.

The packet prohibited dependency installation. The site build failure occurred after
the dependency-free sync and before Astro could start. It is an environment limit,
not application or navigation behavior evidence. CI remains responsible for the site
build with installed dependencies. The known Windows planning-test helper newline
failure was not rerun or changed.

Ignored task storage retains the raw command output. Tropo JSON included the local
absolute root. This public receipt records only repository-relative nodes and edges.

## Independent review

The independent reader began at `AGENTS.md` and `docs/README.md`, then followed the
generated frontier, execution contract, 24a packet, source-map router,
`root-observation` module, typed source records, canonical contract, and accepted 12a
receipt. It found Outcome 12 and the Core implementation owner without reading the
full program specification. It inspected all eleven initial locator mappings against
their stated purposes and accepted the module distinctions.

The first adversarial pass showed that a set comparison could hide a repeated
identical edge. It also showed that the checker cannot infer locator meaning from
syntax and file existence alone. A new regression first reproduced the duplicate
edge acceptance, then passed after the checker counted raw edge tuples before set
comparison. The source-reference record remains the one locator owner. Independent
inspection establishes semantic suitability without a second hardcoded path map.

The initial final independent rerun reported clean 16/23/11/0 checker counts, rejected the
duplicate edge probe with the exact repeated tuple, passed all 13 tests in 38.151
seconds, and passed planning, tracked line-ending, and diff checks. It reported no
remaining finding. A failed output-wrapper attempt preceded the corrected commands
and made no product assertion. Only the later commands and exact exits above count.

| Initial independently hashed artifact at commit `445464e` | SHA-256 |
| --- | --- |
| `docs/product/multi-project/source-map/tropo.toml` | `2b1ffa1e8b10d195ff41afa736f5cb311d00569e1452869d279c5bee5c991e3c` |
| `docs/product/multi-project/source-map/modules/root-observation/index.md` | `ed380b3d3051c00f28961123bce27434f8ee92b3f5a7ab71907d29cf38a80184` |
| `scripts/check-source-navigation.py` | `033200256962e50a2f953553e71862d0ffd38aafc11c188e01e2c740644f7c96` |
| `scripts/tests/test-source-navigation.py` | `81f81c554504d6de48b19446691865acc8dec565d73386c0131a61368e8242a0` |

PR #336 review also corrected the module-owner summaries against the current outcome
contracts: root observation is owned by 12, registry identity and transactions by 03,
runtime responsibilities by 04, 10, 16, 17, and 29, and project-file effects by 11,
16, 17, and 29. Outcome 06 remains the read-only registration and switching owner.
The earlier successful CI run 34060080201 proves commit `445464e` only. It does not
prove the correction candidate described in this section.

### Independent PR correction review

The final independent reader reran the production checker and both focused suites,
removed each CI command in turn, and exercised direct metadata targets, external
symlink aliases into metadata, movement continuity, a symlinked source-map root, and
Windows junctions at the root and inside the inventory. All refusal and continuity
probes passed. It also reran the 36-outcome plan check, the 425-file line-ending
check with four unchanged legacy allowlist entries, and the diff check. No concrete
defect remained.

| Independently matched correction artifact at commit `b959e89` | SHA-256 |
| --- | --- |
| `.github/workflows/ci.yml` | `13d6a0dc214bb788391577f7be33b16794f576237ec092aaf8e481f567ecde0b` |
| `scripts/check-source-navigation.py` | `a9a1eb88d11b94688770e8d201c396cb004d314ddaae095cf45b8bfffd6e1261` |
| `scripts/check_ci_workflow.py` | `2ef66919d6347a8377ddfef532f42e3498d5964805039f99daf9a040716fddb9` |
| `scripts/tests/test-source-navigation.py` | `985932e2c0aaad7b2a5a28b77290ec5e52eeccf497e8ea9fc7238ae557e702bc` |
| `scripts/tests/test_ci_workflow.py` | `33ade99a6b6af8661397b892fe32d8600dd2c16feac77e4bfc5c66e7e2af0eae` |

### Two-platform CI enforcement

Final PR review observed that the Ubuntu job skipped the Windows-only junction tests
and the governed Windows job did not invoke the navigation suite. The Windows job now
runs the same production checker and 18-test suite under Python 3.11 while Ubuntu
retains its existing runs. The CI guard requires each command exactly once in each
job. Two new job-scoped regressions failed before that guard changed and passed in the
24-test local CI contract suite afterward. The accepted local Windows 18-test run was
not repeated; the pull-request CI gate owns the Python 3.11 Windows execution.

| Two-platform enforcement candidate | SHA-256 |
| --- | --- |
| `.github/workflows/ci.yml` | `47f54019ea9b99be8e7c74bc5b974f3fa5069fbb9e7227c7d2c1e2e049286ef0` |
| `scripts/check_ci_workflow.py` | `3549aefb4601a7c4ceb259531d80640a7a4356b9543b235458373194b5e881f5` |
| `scripts/tests/test_ci_workflow.py` | `0054aae61fab5f54011af6a45a49adecfaab305087bb58a5f8d2ab8a75a377fe` |

## Result and continuation

Independent review accepted Packet 24a as bounded maintainer navigation over source owners.
It adds no runtime behavior, source import, production registry, write-back adapter,
physical observer, installed guide, package release, or publication claim. A locator
proves where a selected source lives at validation time. It does not prove runtime
behavior or immutable physical identity.

The two-platform workflow wiring is locally contract-verified. Pull-request CI owns
the final Ubuntu and Windows runner execution for its committed candidate.

Outcome 24 remains planned with its completion dependencies unchanged. Future agents
select a task from the generated frontier first and use this source map only when work
crosses one of its four module responsibilities. The separate physical-observer
continuation remains proposed and absent. This packet neither creates nor claims 12b.
