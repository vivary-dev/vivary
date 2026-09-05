# Portable project registry contract

Version: `vivary.project-registry-contract.v1`.
Recorded: 2026-09-05. Packet 03a defines a storage-neutral contract and synthetic
acceptance oracle. It does not implement a registry, locks, or filesystem access.
Field choices below are reversible implementation decisions under the program's
existing authority. They are not additional decisions attributed to the owner.

## Existing owners

Read [the language](../CONTEXT.md), [native owners](../native-owners.md), and
[the filesystem model](../design.md#filesystem-and-repository-model).
The thin workspace schema remains owned by `packages/create-vivary/create_vivary.py`.
Registering a folder never rewrites that schema. A graph `project` node, content
digest, Git remote URL, and Agent-Native organization are not interchangeable
with a workbench project. Native actions authorize requests and native runtimes
own sessions. This contract adds references and project-binding decisions only.

## Records and trust

All identifiers are opaque, nonempty strings of at most 128 ASCII letters,
digits, hyphens, or underscores. Equality is exact. IDs contain no paths or
credentials. Fixtures use readable IDs. Production allocation must avoid
collisions and never derive project identity from a path, remote URL, or content.

| Record | Fields | Meaning and visibility |
| --- | --- | --- |
| Portable project | `schemaVersion: 1`, `projectId`, `displayName`, `contentIdentity` | The export allowlist. `displayName` is a user-authored label. Optional content identity describes selected portable content and establishes no local access |
| Local binding | `bindingId`, `projectId`, `collectionId`, `actorId`, `deviceId`, `rootId`, `locationRef`, `bindingRevision`, `policyRevision`, `vcs` | Private association with an inspected root. A local service resolves `locationRef` through its scoped connection. It is never exported |
| Root observation | `rootId`, `locationRef`, `exists`, `isDirectory`, `identityVerified`, `contentRevision`, `vcs` | Trusted adapter observation, never a caller's assertion. `rootId` identifies the canonical directory on one device. `contentRevision` identifies a snapshot, not the project |
| VCS observation | `kind`, `repositoryId`, `checkoutId`, `mutationOwner` | `none` has null repository, checkout, and owner. `git` requires all three with owner `git`. Colocated `jj-git` has owner `jj` or null while unresolved. Unsupported layouts remain read-only |
| Execution binding | Native `sessionId`, `projectId`, `bindingId`, `bindingRevision`, `policyRevision`, `executionCopyId`, `baseContentRevision` | Private references. A BrowserPod copy and a session never become the authoritative project root |
| Operation receipt | Scoped operation key, request digest, status, bound IDs/revisions, result | Private idempotency and recovery evidence. It references native action/run evidence when available; it does not create a second task or transcript owner |

`contentIdentity` is null, or exactly `{algorithm: "sha256", manifestDigest}`.
The digest is 64 lowercase hexadecimal characters identifying a selected portable
content manifest. It is a snapshot reference, not project identity or proof of
root access. The preservation contract owns manifest creation. Registration does
not compute a content digest, rewrite thin workspace configuration, or infer
sameness from a supplied digest. A matching imported project ID is a claim to reconcile, not an
authorization to attach a root. Project display names are untrusted text and
must be escaped when rendered. Export is an explicit user operation on selected
project fields, not recursive serialization of local state.

The authenticated adapter supplies actor, collection membership, device binding,
capabilities, current policy, canonical root observations, and repository identity.
The fixture's `trusted` object models those inputs. Product callers cannot submit
or replace it. A path alias resolves to the same `rootId`. A directory recreated
at the same path has a new `rootId`. If the adapter cannot prove this distinction,
it reports `identityVerified: false` and mutation is refused.

## Registration and export rules

**R1, validation.** Reject unknown fields, wrong types, invalid IDs, unsupported
schema versions, duplicate JSON keys, and malformed JSON before planning writes.
Fixtures' symbolic references are test setup, not accepted product fields.

**R2, authorization.** Require the authenticated actor's current collection grant
and operation capability. Every operation except export additionally requires
explicit access to the observed root. Existing project/binding operations must resolve those records
inside the same actor, collection, and device scope. Return `denied` without
record details on a mismatch. Export requires `export-project`, independently of
register or mutate. Export never creates a local binding on the receiving device.

| Operation | Required capabilities | Exact caller request fields, in addition to `operationId` and `expectedPolicyRevision` |
| --- | --- | --- |
| `register` | `register-project` | `expectedRegistryRevision`, `locationRef`, `displayName`, `contentIdentity`, `attachProjectId` |
| `export` | `export-project` | `projectId` |
| `rebind` | `rebind-project` | `expectedRegistryRevision`, `bindingId`, `expectedBindingRevision`, `locationRef` |
| `admit-mutation` | `mutate-project` | `expectedRegistryRevision`, `bindingId`, `expectedBindingRevision`, `expectedContentRevision`, `requestedVcsOwner` |
| `authorize-write-back` | `mutate-project` and `write-back-project` | All `admit-mutation` fields except `expectedRegistryRevision`, plus `executionCopyId`, `patchDigest`, `selectedPaths`, `fence` |

Every listed field is required. `attachProjectId` is null or an ID. Revision and
fence fields are safe JSON integers at least 1, except registry revision may be 0.
`requestedVcsOwner` is null, `git`, or `jj`. `displayName` is 1 to 200 Unicode
characters. Content identity is the shape defined above. `patchDigest` is 64
lowercase hexadecimal characters. `selectedPaths` is a nonempty duplicate-free
list of normalized relative POSIX paths. Reject absolute paths, backslashes,
empty/dot/dot-dot components, NUL, and unpaired Unicode surrogates. The actual
adapter must also verify containment and link behavior. Other request values are
IDs under the identifier rule. JSON keys are unique. Unknown fields are invalid.

**R3, observed root.** Missing root returns `root-unavailable`, a non-directory
returns `not-directory`, and unverified canonical identity returns
`identity-unverified`. Register only from a fresh trusted observation. Probe
failures cannot silently downgrade a Git/Jujutsu folder to no VCS.

**R4, duplicate registration.** The physical-root uniqueness key is collection,
device, and canonical `rootId`. If its existing binding belongs to another actor,
return `denied` without disclosing that binding. A repeated registration by the
same authorized actor returns the existing
project and binding without allocating IDs or changing labels. Different operation
keys for the same root still converge. Equal bytes, equal display names, or equal
remote URLs do not merge different roots. Two logical subfolders may share
repository and checkout IDs while having different roots and projects.
A new operation key that resolves to `already-registered` still atomically writes
its completed receipt and advances registry revision. It changes no project or
binding fields. Subsequent same-key replay writes nothing under R9.
If observation finds overlapping writable roots without a verified common
repository/checkout reservation domain, return `ambiguous-ownership`. This includes
nested no-VCS roots and a no-VCS parent containing a separate repository. Actual
overlap detection belongs to the root adapter. A trusted `overlapSafe: false`
models that refusal. Never infer safe non-overlap just from distinct root IDs.

**R5, new registration.** Allocate new project and binding IDs only after the
scope/root checks and uniqueness lookup. A trusted allocation collision returns
`allocation-conflict`; it must not overwrite an existing record. Registration
atomically inserts the portable project, local binding at revision 1, and completed
operation receipt. It writes zero project files, initializes no VCS, adopts no
workspace, creates no remote, and starts no session. An unsupported VCS layout
can be registered for read-only inspection with its observed kind retained.

**R6, explicit attachment.** Attaching another checkout to a known project is a
separate operation requiring authority over that project and the new root.
This packet does not infer attachment from matching names, content, repositories,
or imported IDs. A non-null `attachProjectId` returns `attachment-required` after
scope/root checks and before R4's existing-root projection. Incidental name,
content, and repository matches neither attach nor prevent a new registration.
Outcome 06 owns the attachment flow. Automatic cross-actor deduplication is forbidden.

**R7, export.** Construct a fresh object containing exactly the portable-project
fields in the table, preserving their values. Never spread a binding, receipt,
execution record, credentials, local grants, repository identity, or filesystem
locator into the export. Export followed by parse preserves this portable object
only; it cannot claim a working root or session on another device.

## Relocation and operation retries

**R8, rebind.** A moved path changes `locationRef`, not `projectId`. Require the
existing binding's current revision, current policy, explicit new-root access,
and a fresh observation of the same verified `rootId`. Refuse an occupied
destination with `root-conflict`, a changed root identity with `root-replaced`, or
unresolved identity with `identity-unverified`. Accepting an
intentional replacement root requires a later explicit replacement workflow.
Increment `bindingRevision`, store the current `policyRevision`, and atomically
record the relocation receipt. Invalidate
older execution bindings. Do not move files or replay writes into the old location.

**R9, idempotency.** Keys are scoped by actor, collection, device, operation name,
and caller `operationId`. Bind each key to a canonical request digest. Reusing the
key with different request content returns `operation-conflict`. Reauthorize every
retry against current policy before returning a prior result. For `register` and
`rebind`, a completed same-key retry returns its prior result with `replayed: true`
and no writes only when the result's project, binding, root identity, and binding
revision still match current authorized records. If those records are missing or
later changed, return `superseded-operation`; do not restore old state or silently
substitute a newer result. A pending or
uncertain receipt returns `reconciliation-required`, never a fresh allocation or
second mutation. Different keys are still subject to R4 and revision checks.
Receipt keys outside the current scope are not looked up or disclosed. A mismatched
receipt supplied as a trusted lookup result is `invalid-input`. `export` is a fresh
read on every call. `admit-mutation` retries return `reconciliation-required` until
the operation owner reconciles its reservation and effects. `authorize-write-back`
rechecks every precondition on every call and never replays an authorization.

Canonical request digest means SHA-256 over UTF-8 JSON with keys sorted recursively,
array order retained, non-ASCII characters emitted as UTF-8 rather than Unicode
escapes, and no whitespace or trailing newline. Use JSON string escaping for quotes,
backslashes, and control characters, with the standard short escapes where available.
All allowed object keys are ASCII schema fields. Request objects use
integers, booleans, null, strings, arrays, and objects only. Trusted observations,
allocations, capabilities, and evidence are not caller request fields or digest
inputs. The receipt stores enough bound identity to reauthorize its result.

## Mutation and BrowserPod write-back

**R10, revision authority.** Before granting an operation, compare the requested
binding and policy revisions with current private records and trusted policy.
Require root identity to match the local binding and current content revision to
match the mutation request's `expectedContentRevision`. This request field owns
the expected snapshot. A successful file effect must emit a new observed revision
for later plans; it never silently updates the precondition of an existing plan.
Return `stale-binding`, `stale-policy`, or `content-conflict` respectively. A changed
root identity returns `root-replaced`. A changed VCS observation relative to the
binding returns `stale-binding`; refresh and authorize a new binding first. A native
session ID, BrowserPod origin, disk name, or storage key is not an access grant.

**R11, one mutation owner.** For Git, reserve both the common repository key and
checkout key. For colocated Jujutsu, require an explicitly selected `jj` owner and
reserve the same common keys; a Git mutator cannot run alongside it. For no VCS,
reserve the root key. Each key includes device identity and the adapter's canonical
resource ID, so different collections sharing a physical repository still contend.
Never key locks only by project, actor, URL, or GUI tab. Acquire the complete sorted
key set atomically or acquire none. An unresolved or unsupported VCS owner returns
`read-only`; a held key returns `busy` with no partial reservation.
Fixture keys serialize the structured tuple as `deviceId:resourceKind:resourceId`,
with kinds `repository`, `checkout`, or `root`, sorted lexically. Colons are key
separators, not part of an ID. Resource identity must be proven independently of
remote URLs. If shared network storage or another writer cannot be fenced across
devices, the adapter must withhold mutation capability rather than claim isolation.

**R12, recovery and fencing.** A granted mutation has one operation owner and a
monotonically increasing fencing token for every reserved key. The actual writer
must recheck current token, scope, policy, binding, and content at the effect boundary.
Lease expiry or a disconnected browser does not prove the previous writer stopped.
An uncertain owner keeps the keys quarantined and returns `reconciliation-required`
until cancellation and reconciliation prove whether the effect happened. A stale
token returns `stale-fence`. Never claim that an in-memory decision, JSON fixture,
or database row alone can fence an external process. Outcome 04 owns the enforceable
adapter and outcome 17 owns cross-process recovery.

**R13, execution-copy write-back.** Require an authenticated execution binding
whose project, binding revision, policy revision, and owner match the selected
root. Bind write-back to `executionCopyId`, the exact patch digest and selected
relative paths, `baseContentRevision`, current root observation, and R11/R12's
reservation. A changed root returns `content-conflict`; a different project/copy
returns `copy-mismatch`. An unverified path or patch returns `patch-unverified`.
The file adapter must refuse traversal, link escapes, and changes outside the
authorized path set. It must verify preconditions immediately before writing and
produce actual byte/conflict/recovery evidence. This contract grants permission
to attempt a bound operation; it is not evidence that bytes reached the root.

## Validation order and state effects

| Stage | Operations and exact comparison |
| --- | --- |
| 1 | All operations validate schema, current membership/capabilities, and scope of any resolved records. Foreign records return `denied` |
| 2 | Every operation compares `expectedPolicyRevision` with trusted `policyRevision`; mismatch returns `stale-policy`. Every operation except export checks current root access and R3's root observation |
| 3 | Register/rebind/admission check a scoped R9 receipt and its request digest. Completed registration/rebind replay checks its current bound result, not old requested revisions. An admission retry reconciles. Export and write-back never replay |
| 4 | New rebind/admission/write-back require the requested existing binding. Missing records return `binding-unavailable`, wrong binding revision returns `stale-binding`. Admission/write-back additionally require the binding policy to equal current trusted policy, otherwise `stale-policy` |
| 5 | Apply the operation's root, identity, overlap, VCS owner, content, reservation, and patch rules. Mutation content is compared to `expectedContentRevision`; write-back also compares it to the execution copy's base revision |
| 6 | New register, already-registered receipt creation, rebind, and admission compare `expectedRegistryRevision` with current `registryRevision` at atomic commit; mismatch returns `retry-state` with no writes. Each accepted transaction advances registry revision once. Export and write-back do not compare registry revision or change registry state |

Apply R1, then R2. Resolve current scope, policy, binding, and root as required
by the operation before accepting an idempotent replay. Check an existing receipt
under R9 before proposing any new reservation or allocation. A replay must not
repeat a successful rebind's old revision check; it reauthorizes the receipt's
current bound result instead. For a new registration, check R6's explicit
attachment trigger before R4/R5. For other new operations, evaluate the
operation-specific rules in numeric order. Refusals have no registry, reservation, project-file,
session, or remote effects. Read-only audit of a refusal is allowed only through
the existing native audit owner, without raw private values.

R11's allocation and `busy` decision apply to `admit-mutation`. Write-back does
not acquire keys again. It uses the existing-reservation checks below, followed
by R13. An uncertain required reservation takes precedence over `busy` or
`stale-fence`. An export neither inspects the live root nor processes a receipt.

An accepted registration/rebind is one compare-and-set transaction over the scoped
uniqueness key, expected registry revision, affected records, and receipt. A failed
commit returns `retry-state` and changes none of them. Mutation admission reserves
keys and records intent atomically; actual execution and durable recovery are
separate implementation work. The contract never declares a mutation complete
merely because it was admitted.

## Reference-model vocabulary

The reference model accepts exactly `operation`, `request`, and `trusted`.
Its trusted fields below are already-authenticated, already-observed inputs.
Production actions must construct them from native authorization and adapter
observations, not accept them from JSON request bodies.

| Trusted fields | Shape and use |
| --- | --- |
| `actorId`, `collectionId`, `deviceId` | Current scoped identifiers |
| `member`, `capabilities`, `rootAccess` | Boolean collection membership, exact capability strings, and accessible canonical root IDs |
| `policyRevision`, `registryRevision` | Current positive policy revision and nonnegative registry revision |
| `root` | Root observation from the record table. For `register`/`rebind`, `locationRef` must equal the request, otherwise `invalid-input` |
| `portable`, `binding` | Current selected records or null. Existing-record operations check their requested IDs and actor/collection/device scope. Wrong scope returns `denied`; a missing requested record returns `binding-unavailable` unless a matching completed receipt requires `superseded-operation` |
| `existingRootBindings` | Current bindings returned by the trusted register/rebind collision resolver. The resolver must include every binding matching the candidate physical-root key or destination. Other operations do not use this lookup. Multiple distinct matching binding IDs return `ambiguous-ownership`; a matching foreign actor returns `denied` before projection |
| `allocatedProjectId`, `allocatedBindingId`, `allocatedIdsInUse` | Trusted proposed IDs and collision observation for a new registration. Unused by duplicates, replay, and other operations |
| `overlapSafe` | Boolean verified overlap result required for registration and all mutation admission. False returns `ambiguous-ownership` |
| `receipt` | Null or `{actorId, collectionId, deviceId, operation, operationId, requestDigest, status, rootId, output}`. Status is `complete`, `pending`, or `uncertain`. Digest is 64 lowercase hex. Output is the recorded operation result. It must satisfy the exact replay rules |
| `reservations` | Array of `{keys, ownerOperationId, state, fence}`. Keys are unique sorted resource keys, state is `active` or `uncertain`, fence is a positive safe integer |
| `nextFence` | Trusted next token for an admission. It must exceed every token for the selected keys; otherwise `stale-fence`. Monotonic allocation and historical high-water storage require a real owner in later integration |
| `execution` | Null or the execution record in the table with `actorId`; required for write-back |
| `patchVerified` | Boolean adapter proof that the requested digest and exact selected path set belong to the authorized patch. False returns `patch-unverified` |
| `privateState` | Synthetic local-only `{locator, credentialRef, remoteRef}` strings used to prove export omission. They are not product request fields or new credential storage |

Every trusted field is present, though unused optional records may be null. Reject
unknown trusted fields and invalid record shapes with `invalid-input`. Record IDs
and strings follow the rules above. `root` booleans are strict booleans. VCS kinds
are `none`, `git`, `jj-git`, or `unsupported`; unsupported has null repository,
checkout, and owner. An adapter probe failure must produce unavailable/unverified
evidence, not `none`. Required Git/Jujutsu resource IDs cannot be null.

For rebind, an entry in `existingRootBindings` with the new location and a
different binding returns `root-conflict`. Same physical-root duplicates must
already satisfy the uniqueness invariant. Both root and destination conflict
observations are private adapter facts. For write-back, all required keys must be
held actively by `request.operationId` with the requested fence. Missing keys,
wrong owner, or wrong token return `stale-fence`. Any uncertain required key returns
`reconciliation-required`. Write-back must not allocate a fresh reservation.

All refusals return exactly `{code}`. Successful public results contain only:

- `registered`, `already-registered`, or `rebound`: `code`, `projectId`,
  `bindingId`, `bindingRevision`, and boolean `replayed`.
- `exported`: `code` and `project`, the exact portable allowlist object.
- `admitted`: `code`, `bindingId`, sorted `keys`, `fence`, `ownerOperationId`.
  These resource keys are returned only to the authorized effect adapter, not UI
  telemetry, cross-user errors, or portable export.
- `authorized`: `code`, `bindingId`, `executionCopyId`, `patchDigest`,
  `selectedPaths`, and `fence`. This result authorizes an attempt and reports no
  completed file effect.

## Acceptance fixture interpretation

[The JSON fixture](../fixtures/project-registry.json) is the normative synthetic
oracle for 03b. Each case names an `inputRef`, optional generic `set` operations,
and an expected decision and effects. Clone the referenced input and apply each
`set` at its JSON Pointer, replacing an existing value or adding one object field.
Array replacement replaces the whole array. There are no case-name-specific rules.
`remove` removes exactly the named existing field. Missing parent references and
unsupported fixture operations are fixture errors, not accepted product inputs.

An input has `operation`, caller `request`, and adapter-supplied `trusted` facts.
Facts use synthetic identifiers and already-inspected observations. `portable`
fixtures model the portable record separately from `binding`, `existingRoot`,
`receipt`, and `reservation` facts. They do not bypass production authorization.
Expected `effects` lists every permitted write category: `registry`, `reservation`,
`projectFiles`, `sessions`, and `remotes`. All absent or false categories mean zero
writes. An empty effect list means all state stays unchanged. `output` is an exact
allowlist of public result fields for that case; diagnostic raw facts are forbidden.
Expected `recordChanges` gives exact inserted/replaced portable and binding records,
the new registry revision, reservation records, and `insertReceipt` where relevant.
Everything not listed remains unchanged. Registration/rebind write a completed R9
receipt bound to the exact request, root, and result; admission writes a pending
intent receipt, never a completed effect receipt. The model must assert those receipts and atomic
state changes in its contender/crash schedules rather than treating `effects` as
proof that a transaction happened.

The reference evaluator must additionally reject malformed/duplicate-key JSON and
unknown input fields, check export with injected local/credential sentinel fields,
and execute two contender schedules plus crash/retry schedules. These executable
checks belong to [03b](../packets/03b-registry-contract-model.md). The synthetic
observations cannot prove actual canonicalization, OS file identity, SQLite/Postgres
transactions, cross-device locking, or BrowserPod transfer.

## Remaining implementation owners

Outcome 03 owns executable contract agreement and an explicit storage/transaction
mapping before closure. Outcome 06 owns registration/attachment UI and actions.
Outcome 12 owns Git/Jujutsu canonical identity adapters, including submodules and
unsupported layouts. Outcomes 04 and 10 own enforceable runtime binding and its
BrowserPod proof. Outcomes 11, 17, and 29 own real write-back, recovery, and handoff
behavior. Reuse existing native transfer/action/session owners before adding code.
