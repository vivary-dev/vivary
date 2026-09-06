# 24a source module navigation receipt

Evidence-record: 24a
Date: 2026-09-06. Verification kind: inspection.
Result: bounded source navigation accepted after independent retrieval and adversarial review.

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
absolute or escaping paths, missing or non-file targets, and resolution failures.

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

The 13-test suite uses disposable local fixtures and the production checker. It
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
| `python -B scripts/tests/test-source-navigation.py` | 0 | 13 tests passed |
| `python -B scripts/check_multi_project_plan.py --render` | 0 | Generated frontier and graph updated |
| `python -B scripts/check_multi_project_plan.py --check` | 0 | 36 outcomes and bounded packet graph passed |
| `python -B scripts/check_line_endings.py` | 0 | 405 tracked text files checked, with 4 unchanged legacy allowlist entries |
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

The final independent rerun reported clean 16/23/11/0 checker counts, rejected the
duplicate edge probe with the exact repeated tuple, passed all 13 tests in 38.151
seconds, and passed planning, tracked line-ending, and diff checks. It reported no
remaining finding. A failed output-wrapper attempt preceded the corrected commands
and made no product assertion. Only the later commands and exact exits above count.

| Independently hashed candidate artifact | SHA-256 |
| --- | --- |
| `docs/product/multi-project/source-map/tropo.toml` | `2b1ffa1e8b10d195ff41afa736f5cb311d00569e1452869d279c5bee5c991e3c` |
| `docs/product/multi-project/source-map/modules/root-observation/index.md` | `ed380b3d3051c00f28961123bce27434f8ee92b3f5a7ab71907d29cf38a80184` |
| `scripts/check-source-navigation.py` | `033200256962e50a2f953553e71862d0ffd38aafc11c188e01e2c740644f7c96` |
| `scripts/tests/test-source-navigation.py` | `81f81c554504d6de48b19446691865acc8dec565d73386c0131a61368e8242a0` |

## Result and continuation

Independent review accepted Packet 24a as bounded maintainer navigation over source owners.
It adds no runtime behavior, source import, production registry, write-back adapter,
physical observer, installed guide, package release, or publication claim. A locator
proves where a selected source lives at validation time. It does not prove runtime
behavior or immutable physical identity.

Outcome 24 remains planned with its completion dependencies unchanged. Future agents
select a task from the generated frontier first and use this source map only when work
crosses one of its four module responsibilities. The separate physical-observer
continuation remains proposed and absent. This packet neither creates nor claims 12b.
