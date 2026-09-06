# 12a root and VCS observation receipt

Evidence-record: 12a
Date: 2026-09-06. Verification kind: inspection.
Result: contract and expected oracles accepted after independent review.

## Contract checkpoint

The [observation contract](../contracts/root-vcs-observation.md) assigns the
trusted sources of root, repository, checkout, access, overlap, and content
observations. The [expected fixture](../fixtures/root-vcs-observation.json)
contains 86 observation cases, 57 identity/key relations, and 25 effect-boundary
refusal assertions. All expected effects are empty.

The PR review amends registry v1 with private `jjRepositoryId` and
`jjWorkspaceId` for `jj-git` records and updates its synthetic reference
consumer. They bind Jujutsu repository and working-copy administration,
including the workspace root association, without changing Git contention keys.
Non-colocated Jujutsu remains an explicitly
unsupported, read-only projection until a later contract extension. Colocated
Jujutsu uses the same Git repository/checkout keys and requires a trusted `jj`
owner. No-VCS roots retain their root-only key and standalone operation.

## Source inspection

Installed `@agent-native/core` is `0.176.5`. Its `docs/AGENTS.md` and the
[03c source findings](03c-registry-transaction-mapping.md) were read before the
bounded package search. The preserved source was available. No source import
or new live-runtime test occurred.

| Inspected source | Finding and limit |
| --- | --- |
| `packages/core/vivary_core/workspace_observe.py:1703` and `:1931` | `_observe_one` reads Git top-level/common-directory facts. `observe_checkouts` requires an explicit allowlist. Its observations do not supply a directory-incarnation identity or mutation reservation |
| `packages/core/vivary_core/workspace_model.py:242` and `:542` | `_repository_identity` groups by remote URL or path. Checkout graph IDs derive from paths. These remain graph semantics and cannot become the registry's physical mutation keys |
| `packages/create-vivary/create_vivary.py:5280` | `_thin_target_identity` binds adoption to a resolved path and stat device/inode. It establishes no durable registry identity, common VCS reservation, or external-process fence |
| Preserved `apps/workbench/server/agent-runtime-host.ts:374` and `:454` | `validateBinding` checks normalized cwd, project, owner, sandbox object, and adapter capabilities. `workspaceBindingRef` records project/path. Neither function proves physical-root identity |
| Preserved `apps/workbench/actions/runtime-readiness.ts:97` and `:118` | The native read action returns no configured binding and no runnable session. It supplies no project-root or authenticated execution-copy proof |
| Core public declaration search | Exact `rootId`, `locationRef`, `repositoryId`, and `checkoutId` searches found no complete observation adapter. `realpath` and `gitDir` hits belong to unrelated cleanup/template declarations |

Primary Git and Jujutsu references are linked beside their claims in the
contract. Git documents common/private directories and worktree topology, not
a stable product repository UUID. Jujutsu documents shared workspaces and
colocation, not a Vivary mutation fence. Windows handle identity documentation
does not prove that an ID can never be reused after deletion.

The independent primary-source reader also identified probe effects. Git status
can refresh its index. Jujutsu may snapshot or update its working copy.
The later observer must verify unchanged user and administrative state with
its exact command/version configuration.

## Verification log

The initial inspection checks passed with Python 3.14.3 and Node 24.19.0:

```console
python -m json.tool docs/product/multi-project/fixtures/root-vcs-observation.json
python -c "import json,pathlib; d=json.loads(pathlib.Path('docs/product/multi-project/fixtures/root-vcs-observation.json').read_text(encoding='utf-8')); c=d['cases']; assert d['fixtureVersion']==1 and isinstance(c,list) and c and len({x['id'] for x in c})==len(c)"
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

The JSON formatter wrote to private task storage to bound output. A private
document checker also rejected duplicate keys, expanded every JSON Pointer,
checked identity/revision symbol bindings, and compared all 21 relations.
All 61 observation cases and 15 boundary assertions retained empty effects.
This check reads expected documents only. It executes no observer or registry
decision implementation. Technical-writing lint passed for the contract and
receipt through Node after Bun could not read the installed linter path.

The additional existing planning suite ran 67 tests on Windows. One test,
`test_render_cli_repairs_missing_or_invalid_generated_files`, failed in its
`missing` and `encoding` subcases. Its helper at
`scripts/tests/test_multi_project_plan.py:55` writes platform-default newlines.
Its byte comparison at line 529 then compares that CRLF baseline with the
production renderer's explicit LF output at
`scripts/check_multi_project_plan.py:529`. Neither file changed in 12a.
This is a retained test-helper defect, not a successful suite result.

After independent acceptance, the owning planning script regenerated the graph
and frontier with `--render`. Its `--check`, line-ending check, and diff check
passed again. The initial checkpoint had no ready packet. After merging
PR #331 from `dev`, the regenerated frontier lists 20a as ready; the
[direction decision](../design.md#direction-decision-2026-09-06) gives it
first claim. No 12b was created during this checkpoint.

Two earlier restricted-process attempts failed while creating temporary test
directories, before assertions. The completed attempt used task-owned temporary
storage outside that process restriction. It established the newline failure
above. No application runtime or filesystem observer ran. A later focused
test-maintenance change should make the helper emit LF and rerun the unchanged
67-test suite. That repair is outside this packet's owned files.

## Independent review

A separate Codex reader checked the contract, all cases, and the exact key
relations against R3, R4, R8, and R10-R13. The first review found three
unsupported layouts still referring to no-VCS content evidence. The author
gave bare Git, broken gitfile, and ambiguous-marker cases distinct VCS state
evidence and matching revision symbols. The reader rechecked those changes
and accepted the contract and fixture with no residual finding.

The initial review reported no caller-controlled authority, hidden mutation grant,
unsupported durable-identity claim, inconsistent resource key, or unowned
effect-boundary fact. It accepted the inspection checkpoint while retaining
the separate Windows test-helper failure. It does not approve product runtime
behavior or repository publication.

## Initial PR #333 corrections

The [review of `97df0bc`](https://github.com/vivary-dev/vivary/pull/333#pullrequestreview-5126046129)
found five gaps after the initial local review. Jeff authorized resolving the
findings and merging the verified PR on 2026-09-06.

| Finding | Correction and evidence |
| --- | --- |
| [Read-only connection grant](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944682263) | `read-only-grant-refuses-write` requests write on an OS-writable root and expects `denied`. `read-only-grant-allows-read` supplies the positive read control |
| [Jujutsu administration identity](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944682270) | Private `jjRepositoryId` joins the existing VCS binding. Recreation and repointing change it while preserving root, content, and Git contention keys. Alias and incomplete-identity cases retain their own expectations. Two executable registry cases require `stale-binding` for admission and write-back |
| [Git administration replacement](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944682274) | `git-administration-replaced-binding` compares the old and recreated full VCS records under R10 with unchanged kind and owner; expected result is `stale-binding` |
| [Stale frontier](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944682266) | The verification log distinguishes the initial empty frontier from the current 20a-ready direction. No 12b was created |
| R13 recreated-root write-back, in the review body | `write-back-recreated-root` expects `content-conflict`, independently of R8/R10's `root-replaced` result |

At `d1af7d8`, the observation fixture had 68 cases, 28 relations, and 19 boundary
assertions. Its document checker expands each case, checks symbols and
relations, and confirms empty expected effects. It executes no observer.

The two new registry cases first failed against the old validator, which
returned `invalid-input`. After the private VCS field and exact validator were
updated together, all 39 Node tests and 59 synthetic registry fixture decisions
passed. The suite also rejects missing, null, or invalid Jujutsu IDs and a
Jujutsu field on an ordinary Git record. Historical 03a/03b receipts retain
their original counts and hashes.

```console
node --test scripts/tests/test_registry_contract_model.mjs
node scripts/registry_contract_model.mjs --fixture docs/product/multi-project/fixtures/project-registry.json --check
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

These checks cover the synthetic registry evaluator and document consistency.
They establish no physical metadata observation, database transaction, file
effect, external-process fence, or coding-runtime behavior.

A separate reader independently reran the 39 tests, all 59 registry decisions,
and the 68/28/19 expected-document expansion and relation checks. Planning,
line endings, and diff checks passed. The reader confirmed all five review
corrections and found two wording defects: the failure table omitted Jujutsu
identity, and a later-session paragraph fixed its future priority to 20a.
Both were corrected. The final narrow recheck accepted the changes and
independently compared all six artifact hashes recorded at `d1af7d8`;
the command exited 0 with six matches. No physical or live-runtime proof
was part of that acceptance.

## Second PR #333 review

The review of `d1af7d8` found three further gaps:

| Finding | Correction and evidence |
| --- | --- |
| [Jujutsu working-copy administration](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944771957) | Private `jjWorkspaceId` binds verified per-workspace administration and its working-root association. Recreation/repointing changes it while Jujutsu repository identity, Git identities, root, content, and common keys stay equal. Alias, missing-administration, and mismatched-root cases have explicit expectations. R10 boundary oracles and synthetic admission/write-back cases require `stale-binding` on workspace identity change |
| [Successful write-access observation](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944771960) | `write-access-allowed-no-vcs`, `write-access-allowed-git`, and `write-access-allowed-colocated-jj` use a read-write grant, an OS-writable root, and requested write access. Each expects the normal observation with empty effects |
| [Release-truth entry](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944771964) | The Unreleased changelog now names the observation contract and synthetic registry milestone with its non-runtime limits. The existing site sync generated the changelog and LLM-text mirrors |

At `a789112`, the observation fixture had 77 expected cases, 37 relations, and 21
boundary assertions. The two private Jujutsu identities are absent from other
VCS shapes and portable export. They add no reservation key or state store.
The synthetic registry fixture includes separate admission and write-back
refusals for repository and workspace administration replacement.

The workspace-only admission and write-back cases first failed against the
preceding validator. After adding `jjWorkspaceId`, the commands above passed
39 tests and all 61 synthetic decisions. Exact validation rejects either
private Jujutsu field on other VCS kinds and rejects missing, null, or invalid
Jujutsu identities. The existing planning and line-ending checks passed;
the separate Windows newline-helper failure was not rerun or repaired.

The independent verifier reran the 39 tests and 61 decisions, expanded all
77 expected observation cases through 113 JSON Pointer assignments, and
checked 37 relations and 21 boundary assertions with empty effects. It checked
the two Jujutsu identity lifetimes separately, workspace root association,
all three positive write controls, and the explicit refusal counterexamples.
Its first restricted-process test launch failed with `spawn EPERM` before tests;
the unrestricted rerun passed all 39 tests with zero failures. Changelog
body and mirror comparisons passed, and all six artifact hashes recorded
at `a789112` matched.
The verifier accepted the revision with no actionable finding. This remains
synthetic model and expected-document evidence, not a physical-observer pass.

## Third PR #333 review

The review of `a789112` found four further gaps:

| Finding | Correction and evidence |
| --- | --- |
| [Unsupported shared Jujutsu evidence](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944847499) | Private `diagnostics.jjRepositoryEvidence` retains verified Jujutsu repository and optional Git backing identities. Relations distinguish shared and different repositories across non-colocated workspaces and retain Git backing. Missing required repository evidence refuses observation. The registry projection stays unsupported, read-only, with null VCS IDs and no resource keys |
| [Stale maintained routes](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944847507) | The audit and outcome-02/03 continuation sections link the accepted 12a receipt, generated frontier, and current direction. Historical receipts and open product outcomes retain their evidence status |
| [OS-readable roots without write permission](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944847511) | Three supported-layout cases request read with a read-only grant, OS read permission, and no OS write permission. They retain the normal root observation and empty effects |
| [Linked-worktree private administration](https://github.com/vivary-dev/vivary/pull/333#discussion_r3944847516) | Recreation and repointing change only checkout identity while root, repository, and content stay equal. The common reservation key remains shared. Admission and write-back boundaries require `stale-binding`; two executable registry decisions isolate checkout-only drift |

The current observation corpus has 86 expected cases, 57 relations, and 25
boundary assertions. Its exact diagnostic shape remains private and adds no
registry field, durable store, or mutation key. The document checker verifies
the new repository evidence against the same synthetic identity symbols.

The registry implementation already compared the full VCS object. A deliberate
`ignore-checkout-identity` mutant survived the preceding 61-case fixture and
failed its selected test. The two new cases then killed that mutant; the test
asserts that those two case IDs are its exact failures. The unchanged model
passes all 63 synthetic decisions and the expanded suite passes 40 tests,
including all five mutation-test variants.

A separate reader accepted the third-review observation and registry
corrections with no actionable finding. It reran all 40 tests and 63 synthetic
registry decisions. It independently expanded 86 expected cases through 133
JSON Pointer assignments and checked 57 relations and 25 boundary assertions
with empty effects.

The reader verified the exact Jujutsu repository diagnostic, unsupported
non-colocated projections, OS-read-only controls, missing-evidence refusals,
and linked-worktree checkout-only counterexamples at admission and write-back.
Its hash comparison exited 0 with six matches. Planning, line-ending, and diff
checks passed.

That reader authored the maintained-route edits, so the coordinator separately
checked those three diffs, their receipt/frontier/direction targets, and their
preserved implementation limits. This acceptance proves no physical observer,
database transaction, file effect, or live runtime.

| Reviewed artifact after PR corrections | SHA-256 |
| --- | --- |
| `docs/product/multi-project/contracts/root-vcs-observation.md` | `24377d52856a479324ca9e62e975e255e201ecb5768d5e8faba2723fe8949dec` |
| `docs/product/multi-project/fixtures/root-vcs-observation.json` | `7dd4a295d394be268b06d991fde96b79ed43ec707642fb0133d0e2af0f55d0c4` |
| `docs/product/multi-project/contracts/project-registry.md` | `2ab2d8c00b95303c1e68713d5201e0ab382047bcab576549b238eddf7ca94e04` |
| `docs/product/multi-project/fixtures/project-registry.json` | `f56a56bdbb43b4fb28af1fe7bf7d0c86208e67cf78e121a7d873eda47bebd35a` |
| `scripts/registry_contract_model.mjs` | `e9eb2a1a75c176b196d1be47f2e54219ac0803e5121ba0c3292e242c378143d5` |
| `scripts/tests/test_registry_contract_model.mjs` | `e73a7c6e0ebaf7d79bd5502ae91dffb4dd867d7f4578c45c73b28fe17593fd60` |

## Later implementation session

After this contract and its expected oracles are independently accepted, a
later session may prepare the bounded physical-observer implementation packet.
Do not create 12b during 12a. Keep outcome 12 and its completion dependencies
open. Read the then-current frontier before selecting physical-observer work.

The later physical-observer session's owner is the root/VCS adapter agent. Its prerequisite is the
accepted 12a contract, fixture, receipt, and a fresh reading of the generated
frontier and current repository state. It must name the supported platform,
filesystem, identity lifetime, safe probe commands, and exact owning source/test
paths before implementation. No database choice or runtime login is needed to
prepare that packet.

Reuse Vivary's bounded Git observation functions where their contract fits.
Keep graph IDs separate from physical identity. Reuse native connection and
action authorization for app integration. Implement no second native session
or transcript store.

The later physical proof must create only disposable synthetic directories and
repositories in the packet's verified Habitat environment. It must test aliases,
rename, delete/recreate, file-number reuse uncertainty, restart continuity,
metadata/worktree replacement, dirty/untracked content, and capture races.
It must observe shared keys across worktrees and collections, separate checkout
identity, no-VCS ownership, ambiguous containment, and single-owner colocation.
Compare before/after file and VCS administrative state for every read probe.
Record actual OS/filesystem/Git/Jujutsu versions and every unsupported case.
Habitat filesystem results do not prove Windows handle semantics.

The operation still lacking its prerequisite is production mutation admission
or write-back using these observations. It needs an implemented platform
observer, current policy/connection composition, the outcome-06 transaction
owner, and the outcomes-04/11/17 effect/fencing/recovery boundary. Expected JSON
cannot satisfy those prerequisites. No project files, VCS repositories,
accounts, runtime processes, or production locks were exercised by 12a.
