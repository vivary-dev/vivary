# Trusted root and VCS observation contract

Version: `vivary.root-vcs-observation-contract.v1`.
Recorded: 2026-09-06. Packet 12a defines an inspection contract and
[expected oracles](../fixtures/root-vcs-observation.json). It implements no
observer, registry, reservation, or file effect. These are technical choices
under the program's existing authority, not additional product-owner decisions.

## Boundary and existing owners

The [registry contract](project-registry.md) owns R1-R13, request fields,
authorization order, result codes, and resource-key syntax. This contract owns
the observations that those rules require. The [transaction map](project-registry-transaction-map.md)
owns the proposed integration boundaries. No new action name or storage backend
is selected here.

Only a trusted server or local service may construct an observation. A GUI,
agent tool, or headless client selects an authorized `locationRef` and supplies
the registry operation's declared preconditions. Those values request work.
They cannot establish actor/device identity, physical identity, root access,
VCS ownership, content revision, overlap, or an execution binding.

The adapter resolves the locator through the existing scoped connection and
policy owner. It binds the authenticated device namespace before filesystem
inspection. It does not accept a caller's path-to-ID map, ambient VCS environment,
or arbitrary probe command. Existing native actions, sessions, connections, and
receipts retain their owners in [the native inventory](../native-owners.md).

Vivary's `observe_checkouts` already reads Git topology. Its graph projection
uses remote URLs or paths for grouping. Those graph IDs cannot be reused as
mutation keys. The preserved Workbench host validates an absolute normalized
`canonicalCwd`. It does not prove physical identity. [The receipt](../receipts/12a-root-vcs-observation-contract.md)
records the exact inspected functions and remaining integration gaps.

## Physical identity and freshness

A verified `rootId` names one directory incarnation within one authenticated
device namespace. An incarnation is that directory's lifetime from creation to
deletion. A symlink, junction, case alias, alternate mount locator, or moved path
may resolve to that same incarnation. String normalization alone proves none of
these relationships. Resolve each authorized locator to an opened directory and
compare trusted filesystem identities.

Windows exposes volume and file identifiers through [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info).
They support comparison of open handles on one computer. They do not establish
never-reused identity after deletion, restore, filesystem cloning, or remounting.
POSIX device/inode observations likewise need a platform-specific lifetime
argument. A later implementation must document its supported filesystem and
identity lifetime, including restart behavior. This packet selects no persistence
scheme or OS API implementation.

Never derive `rootId` from a locator, content digest, timestamp alone, or remote
URL. A raw file number without verified incarnation continuity is insufficient.
If a directory is recreated at the same locator, produce a different ID. If
reuse cannot be distinguished, return `identity-unverified`. Preserve the old
binding until explicit reconciliation. Never invent a new identity merely to
make an uncertain observation appear verified.

Repository and checkout IDs follow the same lifetime rule. Derive repository
identity from the verified common administrative directory. Derive checkout
identity from its verified private administrative directory and its verified
association with the working-tree root. Recreating either checkout component
invalidates that identity. Renaming a branch or changing HEAD does not.

Every observation records a private capture reference, observer/version,
device/filesystem scope, locator resolution, handle identities, and completion
state. Fresh means collected for this authorization or effect attempt with
consistent identity and content checks. A timestamp or short cache lifetime is
insufficient. Discard partial captures, retain explicit failure, and reobserve
after access, topology, binding, or content changes.

## Observation results

The fixture's internal result is either `observed` or a refusal. It is an
inspection vocabulary, not a new public action response.

An `observed` result contains exactly `code`, `root`, `rootAccess`, `overlapSafe`,
`resourceKeys`, `mutationEligibility`, `reason`, and `diagnostics`.
`root` has the registry's exact root shape. Its three booleans are true.
`rootAccess` is the root-ID allowlist constructed for the requested operation
from current policy and actual filesystem access. `diagnostics` has `layout`,
`headState`, and `dirtyState`. Keep diagnostics, IDs, keys, and raw evidence
private to the authorized adapter. They are absent from portable export and
cross-user errors.

`mutationEligibility: candidate` means the topology has one owner and a
derivable key set. It grants nothing. `read-only` has no usable resource keys
and names its reason. Registration can retain an unsupported layout for
inspection under R5. Mutation still requires every R10-R13 precondition and
an enforceable effect boundary. All 12a fixture effects are empty.

A refusal has exactly `code` and private `reason`. It contains no fabricated
root or placeholder IDs. Stop before constructing the registry model's trusted
input when the observation cannot satisfy its shape. Public projection uses
only the registry's `{code}` result. Scope and policy checks retain precedence
under R1/R2 and the registry validation table.

| Observation failure | Registry code | Private reason |
| --- | --- | --- |
| Locator or root permission refused, including OS inaccessibility | `denied` | `root-inaccessible` |
| Authenticated device scope unavailable | `denied` | `device-unbound` |
| Authorized locator has no object | `root-unavailable` | `missing-root` |
| Object is a file or another non-directory | `not-directory` | `non-directory-root` |
| Directory lifetime cannot be verified | `identity-unverified` | `root-incarnation-unverified` |
| VCS probe failed or repository/checkout identity is incomplete | `identity-unverified` | `vcs-probe-failed` or `vcs-identity-unverified` |
| Capture changed or content inventory is incomplete | `identity-unverified` | `unstable-capture` or `content-unverified` |
| Topology scan cannot prove ownership of overlaps | `ambiguous-ownership` | `overlap-unverified` |
| Verified containment lacks the required common reservation domain | `ambiguous-ownership` | `overlap-without-common-domain` |
| Observation authority is supplied in caller JSON | `invalid-input` | `caller-authority-field` |

These reasons distinguish private evidence while preserving the existing public
codes. `identity-unverified` can describe an unusable observation even when one
directory handle was identified. It never turns a failed VCS probe into `none`.

## VCS topology and one mutation owner

Probe the selected root, its checkout boundary, and authorized surrounding
topology. A missing `.git` entry in a project subfolder does not prove no VCS.
Bound inspection by policy and resource limits. Unknown ancestor or descendant
repository boundaries remain unknown. Do not inspect arbitrary neighboring
projects to resolve uncertainty.

[Git rev-parse](https://git-scm.com/docs/git-rev-parse) provides working-tree,
private Git directory, common directory, and superproject locations.
[Git repository layout](https://git-scm.com/docs/gitrepository-layout) allows
`.git` to be a gitfile. These outputs identify locations to inspect. They are
not durable resource IDs.

| Observed layout | Registry VCS projection | Keys and restrictions |
| --- | --- | --- |
| Confirmed no VCS | `none`, null repository/checkout/owner | Root key only. No branch, merge, or Git rollback claim |
| Ordinary Git, including detached or dirty checkout | `git`, verified repository and checkout IDs, owner `git` | Common repository and checkout keys. HEAD and dirty state are separate observations |
| Linked Git worktree | Same repository ID as its common Git directory, distinct checkout ID, owner `git` | Both keys. A separate worktree does not remove repository contention |
| Nested project or monorepo sibling inside one checkout | Distinct root IDs, same repository and checkout IDs, owner `git` | Same two keys, independently of project or collection identity |
| Verified colocated Jujutsu | `jj-git`, verified common Git repository and checkout IDs | Owner `jj` only after trusted selection. Reserve the same keys a Git-only view would use |
| Colocated Jujutsu without resolved selection | `jj-git`, verified IDs, null owner | Read-only. A caller's requested owner cannot select the trusted owner |
| Non-colocated Jujutsu workspace | `unsupported`, null IDs and owner | Read-only under registry v1. Retain layout diagnostic, including Git-backed or shared-repository workspace evidence |
| Submodule inspected alone | Distinct verified Git repository and checkout IDs, owner `git` | Child keys only if no overlapping writable superproject scope exists |
| Bare repository, conflicting markers, broken gitfile, unsupported storage layout | `unsupported`, null IDs and owner | Read-only. Incomplete probes instead return an unverified refusal |

[Git worktrees](https://git-scm.com/docs/git-worktree) share common repository
state and retain private administrative directories. A submodule instead has
its own history and a containing superproject relationship, as
[Git submodules](https://git-scm.com/docs/gitsubmodules) documents.
Submodule and superproject keys do not automatically form one safe domain.

[Jujutsu compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/)
describes a colocated working copy shared with Git.
[Jujutsu workspaces](https://docs.jj-vcs.dev/latest/working-copy/)
can share one repository. Registry v1 only represents colocated `jj-git`, not
a general `jj` kind. This packet preserves that vocabulary. A later contract
revision and physical tests must precede non-colocated Jujutsu mutation support.
The distinction does not remove Jujutsu from outcome 12.

Git and Jujutsu observations must leave project bytes and administrative state
unchanged. Disable ambient repository overrides and verify bounded command,
configuration, hook/filter, timeout, and output handling. Git documents
`--no-optional-locks` for background [status inspection](https://git-scm.com/docs/git-status).
The [Jujutsu CLI](https://docs.jj-vcs.dev/latest/cli-reference/)
documents `--ignore-working-copy`, but it can expose a stale working-copy
commit and does not make mutating commands safe. Later tests must compare
before/after administrative state as well as user files. No probe is run here.

## Overlap and reservation keys

The observer combines physical containment evidence with the trusted resolver's
complete set of relevant writable bindings on this device. Include bindings
from other collections and actors without disclosing their records. Distinct
root IDs or different locator strings do not establish disjointness.

For equal/contained project scopes, require the same verified repository and
checkout domain and compatible single mutation owner. This permits a nested
project within its monorepo checkout. For distinct worktrees, roots may be
disjoint, but their shared repository key still creates contention.

Nested no-VCS roots, a no-VCS parent containing an independent repository,
overlapping independent repositories, and writable superproject/submodule scopes
return `ambiguous-ownership`. Registry v1 does not define a composite parent/child
reservation domain. An incomplete scan, inaccessible metadata, or link ambiguity
cannot be replaced with `overlapSafe: true`.

Resource keys use the exact structured tuple
`(deviceId, resourceKind, resourceId)`. Fixture serialization is
`deviceId:resourceKind:resourceId`, sorted lexically without duplicates.
Git and resolved colocated Jujutsu produce repository plus checkout keys.
No VCS produces only its root key. IDs obey the registry's ASCII domain and
contain no colons. Paths, URLs, actors, collections, projects, and tabs are
never the common resource identity.

R11 owns atomic acquisition of the entire set. The observer allocates no
reservation or fence. Shared/network storage or an uncontrolled writer requires
withholding mutation when the effect adapter cannot enforce exclusion across
the relevant devices and processes. A complete topology result cannot prove
that exclusion. The fixture records this capability refusal separately.

## Content and effect-boundary rechecks

`contentRevision` refers to an exact, stable, authorized snapshot. Its private
evidence includes the inventory policy, scope, included relative paths, entry
types, file bytes, relevant modes/link targets, and relevant VCS state.
Include authorized dirty and untracked content. Ignored or sparse content is
not silently writable without coverage. A Git commit ID, clean status, mtime,
or cached Jujutsu working-copy commit alone is insufficient.

The inventory must state exclusions and reject writes outside its verified
coverage. VCS administrative state is observed separately from user-file
payloads. Registration does not create the optional portable `contentIdentity`
manifest or store blobs in SQL. A capture reference belongs to the observation
owner and establishes no new snapshot storage service.

If inventory limits, races, links, or permissions prevent a complete stable
capture, refuse the observation. Rechecking equal bytes at two instants does
not close the interval between checking and writing. The later file adapter
must prove containment and prevent intervening changes through its actual
effect mechanism or withhold the operation. Emit a new revision after a
successful effect. Never replace an existing request's expected revision.

| Authority fact consumed by registry operations | Trusted source and effect-boundary duty |
| --- | --- |
| `actorId`, `collectionId`, `deviceId`, membership, capabilities, `policyRevision` | Existing authenticated policy/connection owner. Reauthorize current scope and policy. No value in a prompt or caller observation establishes them |
| `projectId`, `bindingId`, `bindingRevision`, stored `locationRef` and `vcs` | Current private registry records. Resolve in scope and compare under R8/R10 before effects |
| Root `locationRef`, existence/type, `rootId`, `identityVerified` | Scoped locator resolution and live directory-incarnation evidence. Match request for register/rebind and binding for mutations. Refuse replacement or stale locator |
| `rootAccess` | Current root grant plus actual access for the operation, resolved against the opened root. Neither a connection's configured state nor an OS permission alone grants access |
| `repositoryId`, `checkoutId`, `mutationOwner` | Verified administrative and working-copy topology plus trusted owner selection. Recheck at the effect boundary and compare with stored VCS facts |
| `overlapSafe`, complete resource keys | Current physical containment, complete relevant binding set, and verified common domain. Recheck topology and preserve the admission-time keys for recovery |
| `contentRevision` | Complete stable snapshot under the bound inventory policy. Compare caller `expectedContentRevision` and execution `baseContentRevision`. Refuse mismatch with `content-conflict` |
| Existing-root/destination collisions | Trusted registry resolver plus observed identities. It must include all relevant bindings. Rebind to a different incarnation returns `root-replaced` |
| `executionCopyId`, native `sessionId`, bound actor/project/revisions | Outcome-04 runtime-binding owner references native session storage. Recheck the authenticated copy association. A session ID or resume token proves no root access |
| Reservations, owner, fence, high-water history | Durable coordination and effect adapter under R11/R12. Verify the complete key set and authenticated operation owner. Quarantine uncertainty until reconciled |
| `patchVerified`, patch digest, exact `selectedPaths` | Outcome-11 file adapter verifies actual patch bytes, links, traversal, containment, and snapshot coverage immediately before writing |

The fixture's `boundaryCases` lists exact R8/R10-R13 refusal expectations and
their owning inputs. They are contract assertions only. The observer cannot
authenticate a runtime, inspect durable reservations, validate arbitrary patch
bytes, or claim an effect on those owners' behalf.

## Fixture interpretation and proof limit

Each case clones its `inputRef` from `inputs` and applies `set` replacements by
JSON Pointer. Replacements require existing parents. Arrays replace whole
arrays. No case-name dispatch is permitted. `caller` contains only the locator
selector in this observation fixture. Actual action request fields remain
owned by R2. `authority` and `platform` model trusted service and platform
observations. Product clients cannot send them.

`identitySymbols` names complete synthetic volume/file/incarnation tuples and
checkout associations. Expected IDs are fixture labels for those tuples.
`revisionSymbols` labels complete snapshot evidence. Neither map is a proposed
product store or an API argument. Later physical tests must establish the
relationships from real observations, with one consistent substitution of
opaque IDs, rather than injecting verified flags into a production endpoint.

`expected` is the exact internal result. `effects: []` forbids every project,
registry, reservation, runtime, and remote effect. `relations` compares named
case outputs for equal/different identities and key intersections. Boundary
cases compare trusted current observations with declared preconditions. They
do not execute those comparisons or grant mutation.

JSON validation proves structure. Independent review checks the expected
decisions against the owning rules. Neither proves physical identity, content
capture, safe probing, transaction isolation, cross-process fencing, file
write-back, or native runtime execution. The receipt owns the later session's
prerequisites. Outcome 12 remains open.
