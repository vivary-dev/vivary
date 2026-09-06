# 12a root and VCS observation receipt

Evidence-record: 12a
Date: 2026-09-06. Verification kind: inspection.
Result: contract and expected oracles accepted after independent review.

## Contract checkpoint

The [observation contract](../contracts/root-vcs-observation.md) assigns the
trusted sources of root, repository, checkout, access, overlap, and content
observations. The [expected fixture](../fixtures/root-vcs-observation.json)
contains 61 observation cases, 21 identity/key relations, and 15 effect-boundary
refusal assertions. All expected effects are empty.

The contract preserves registry v1. Non-colocated Jujutsu remains an explicitly
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

Required inspection checks passed with Python 3.14.3 and Node 24.19.0:

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
passed again. The frontier lists no ready or in-progress packet. No successor
packet was created during this checkpoint.

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

The review found no caller-controlled authority, hidden mutation grant,
unsupported durable-identity claim, inconsistent resource key, or unowned
effect-boundary fact. It accepted the inspection checkpoint while retaining
the separate Windows test-helper failure. It does not approve product runtime
behavior or repository publication.

| Reviewed artifact | SHA-256 |
| --- | --- |
| `contracts/root-vcs-observation.md` | `42e5288d60582866110c717fc0de11f533cddd622a03d9c42fda42bb35767232` |
| `fixtures/root-vcs-observation.json` | `5683fc3cbf09d030ef200be187b064e298acefdf4ef36e301210a6f8f5bff55d` |

## Later implementation session

After this contract and its expected oracles are independently accepted, a
later session may prepare the bounded physical-observer implementation packet.
Do not create 12b during 12a. Keep outcome 12 and its completion dependencies
open. The generated frontier may have no ready packet at this stopping point.

The next session's owner is the root/VCS adapter agent. Its prerequisite is the
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
