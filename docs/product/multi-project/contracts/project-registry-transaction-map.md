# Project registry transaction map

Status: proposed production ownership map for
`vivary.project-registry-contract.v1`. Packet 03c records source-backed seams and
gaps; it does not select a database or implement an action, schema, adapter, or
file effect.

## Record ownership

| Contract record or state | Proposed owner | Privacy and lifecycle | Unique key | Revision or fence | Contract source |
| --- | --- | --- | --- | --- | --- |
| Portable project | Vivary Workbench registry application storage (outcome 06) | Selected fields are portable; create on accepted registration, retain across local moves, export only by explicit authorized projection | `projectId`; allocation must also prove the proposed ID unused | Changed through registry compare-and-set; the project ID never derives from a path, VCS remote, or digest | Records and trust; R4-R7 |
| Local binding | Vivary Workbench registry application storage (outcome 06) | Private to actor, collection, device, and inspected root; create at registration, revise on rebind, invalidate older execution bindings after rebind | `bindingId`; persistent uniqueness on `(collectionId, deviceId, rootId)` | `bindingRevision` and stored `policyRevision` | Records and trust; R2-R5; R8; R10 |
| Registry state | Vivary Workbench registry application storage (outcome 06) | Private scope state used by every accepted registry-changing operation | Proposed storage partition: one row per `(collectionId, deviceId)`; the contract does not explicitly settle this partition, so production review must confirm it | `registryRevision`, advanced exactly once by accepted register, already-registered receipt creation, rebind, or admission | R4-R5; validation stage 6 |
| Root and VCS observation | Trusted root/VCS adapter (outcome 12), not caller JSON or a durable identity inferred from `locationRef` | Fresh, private observation at authorization and effect boundaries; the binding retains the identifiers and VCS facts required for later comparison | Canonical `rootId`; VCS resource IDs establish repository and checkout domains | `contentRevision`; changed root or VCS facts invalidate mutation authority | Records and trust; R3-R4; R8; R10-R13 |
| Execution binding | Vivary Workbench runtime-binding storage (outcome 04), referencing the native harness session | Private, created only for an authorized execution copy; invalid after binding or policy revision changes | App-owned execution-copy identity plus a reference to native `sessionId`; do not duplicate the native session | Captures `bindingRevision`, `policyRevision`, and `baseContentRevision` | Records and trust; R10; R13 |
| Operation receipt | Vivary Workbench registry application storage (outcome 06), referencing native action/run evidence when present | Private idempotency and recovery record; completed for register/rebind, pending or uncertain for admitted mutation until recovery reconciles it | `(actorId, collectionId, deviceId, operation, operationId)` with canonical request digest | Bound project, binding, root, binding revision, policy revision, status, and result; included in the same transaction as the accepted registry change | R9; validation stages 3 and 6 |
| Reservation | Vivary Workbench mutation coordination storage, with enforcement owned by outcomes 04, 12, 17, and 29 | Private active or quarantined state; acquire the complete sorted key set atomically, retain uncertain owners until reconciliation | Each structured `(deviceId, resourceKind, resourceId)` key; repository and checkout for Git/Jujutsu, root for no VCS | Current owner operation and fencing token | R11-R12 |
| Fence high-water | Same durable coordination owner as reservations | Private history that survives release, expiry, retry, and process restart | One high-water record per structured reservation key | Monotonically increasing token; an admitted token must exceed every selected key's history | R11-R12; reference-model `nextFence` |
| Policy, membership, capabilities, and root access | Existing authenticated policy/authorization owner, resolved server-side | Current trusted facts; never copied from the caller or treated as a second policy store | Existing owner keys | Current `policyRevision` | R2; reference-model trusted fields |
| Workspace connection and grant | Agent-Native workspace connection owner | Existing scoped connection metadata, app access, and credential references remain native | Native connection/grant IDs | Native connection state; it is not a registry or root revision | Existing owners; R2-R3 |
| Harness session, run, and optimistic generation | Agent-Native harness owner | Existing native lifecycle remains native; Workbench stores references only | Native `sessionId` and run/thread IDs | Native harness `generation` protects that session record only | Existing owners; execution-binding record |
| Action audit and transcript | Agent-Native audit/chat owners | Existing after-handler action evidence and conversation history remain native | Native audit/run/thread identifiers | No registry compare-and-set field | Existing owners; R9 |

## Operation boundaries

Every operation can enter through `defineAction({ schema, authorize, run,
outputSchema, audit })`. `schema` rejects the caller shape, `authorize` runs for
all dispatch surfaces, `run` constructs trusted facts and performs work, and
`outputSchema` constrains the public projection. `ActionRunContext` supplies
`userEmail`, `orgId`, `appId`, `caller`, thread/run/turn identifiers, and an
approved tool-call key when applicable. It does not supply the contract's
`actorId`, `collectionId`, `deviceId`, membership, capabilities, root access,
policy revision, registry revision, binding, observation, reservation, or
execution-copy proof. A server-owned resolver must construct those facts.

The action `schema` validates parsed values. The inspected HTTP routes call
`Request.json()` or `readBody()` before `entry.run`, so duplicate JSON keys have
already been collapsed before the action schema runs. No supported raw-body
strict-JSON hook was found. R1 duplicate-key rejection therefore remains a
transport prerequisite; the action schema can still reject unknown fields,
types, IDs, revisions, paths, and unsupported versions after parsing.

For receipt-bearing operations, the common pipeline validates and reauthorizes
a matching completed receipt before new allocation, reservation, or old expected
registry/binding revision comparisons. A valid current replay bypasses those old
request revisions and writes nothing. A new operation proceeds to compare-and-set.

| Operation | Input validation and caller authorization | Trusted observation construction | Transaction work | External effects | Public result | Contract rules |
| --- | --- | --- | --- | --- | --- | --- |
| `register` | Action `schema` enforces the R2 shape after transport parsing; the R1 duplicate-key transport gap remains. `authorize` establishes authenticated request scope; `run` resolves membership and `register-project` capability and compares current policy | Fresh root/VCS observation; explicit root access; overlap result; all bindings matching physical-root/destination keys; proposed IDs only after authorization and uniqueness lookup | After receipt handling, a new operation uses one database transaction to lock/compare scoped registry revision and physical-root uniqueness; reject allocation collisions; either insert project plus revision-1 binding plus completed receipt, or insert only the completed `already-registered` receipt; advance registry revision once. A valid replay performs none of these comparisons or writes. A failed compare-and-set changes none | Read-only inspection only. No project bytes, VCS, remote, session, or execution copy | Exact `registered` or `already-registered` allowlist; replay is returned only after current reauthorization | R1-R6; R9; validation stages 1-6 |
| `export` | Action `schema` enforces the R2 shape after transport parsing; the R1 duplicate-key transport gap remains. `authorize` requires current membership and independent `export-project` capability. Resolve portable project and a matching binding in the authorized actor/collection/device scope before projection | No live root observation and no receipt lookup. Connection or local locator data is irrelevant | Consistent authorized read; no registry revision comparison or state change | None | Fresh object containing exactly `schemaVersion`, `projectId`, `displayName`, and `contentIdentity` | R1-R2; R7; R9; validation stages 1-2 |
| `rebind` | Action `schema` enforces the R2 shape after transport parsing; the R1 duplicate-key transport gap remains. `authorize` establishes scope; `run` resolves membership, `rebind-project`, current policy, selected binding, and explicit access to the new root | Fresh observation must prove the same `rootId`; collision resolver covers the destination; reauthorize any replay against its bound current result | After receipt handling, a new operation uses one database transaction to check expected registry revision, expected binding revision, root uniqueness/destination, and increment safety; update only `locationRef`, increment binding revision, store policy revision, invalidate old execution bindings, insert completed receipt, advance registry revision once. A valid replay performs no old revision comparison or write. Rejected compare-and-set writes nothing | No file move or project-byte write | Exact `rebound` allowlist; a valid current replay adds `replayed: true` without writes | R1-R3; R8-R10; validation stages 1-6 |
| `admit-mutation` | Action `schema` enforces the R2 shape after transport parsing; the R1 duplicate-key transport gap remains. `authorize` establishes scope; `run` resolves membership, `mutate-project`, current policy, binding, and root access | Fresh root/content/VCS observation; verified overlap; derive the complete sorted reservation-key set and selected mutation owner; inspect all selected reservations and fence high-water | After receipt handling, a new operation uses one database transaction to check expected registry and binding revisions, stored/current policy, expected content revision, VCS owner, all-key availability, and increment safety; atomically acquire every key or none, advance each selected key's fence high-water, insert a pending intent receipt, and advance registry revision once | Admission performs no project mutation. It only creates durable intent and ownership evidence | Exact `admitted` allowlist to the authorized effect adapter; keys are not general UI telemetry | R1-R3; R9-R12; validation stages 1-6 |
| `authorize-write-back` | Action `schema` enforces the R2 shape after transport parsing; the R1 duplicate-key transport gap remains. `authorize` establishes scope; `run` resolves both `mutate-project` and `write-back-project`, current policy, binding, execution binding, and root access | Immediately before effect: fresh root/content/VCS observation, verified patch digest and exact selected paths, active reservation ownership for every required key, and current fence | Read/compare current durable records. It neither reacquires reservations nor changes registry revision. A SQL row or returned action result is permission to attempt, not effect evidence | The outcome-11 file adapter must recheck scope, policy, binding, root/content identity, patch containment/link behavior, active owner, and fence at the write boundary; outcomes 17/29 own recovery/handoff evidence. Only observed bytes/conflicts can report the effect | Exact `authorized` allowlist. It never reports a completed file effect and never replays authorization | R1-R3; R9-R13; validation stages 1-5 |

An action audit is deliberately separate. Core attaches it outside the validated
handler, writes it after success or failure, and swallows recorder failure. It
cannot atomically commit the project/binding change, registry revision, receipt,
or reservation. Default same-turn action serialization, native harness generation
checks, and local-artifact in-process locks likewise do not serialize independent
requests or fence an external writer.

## Predicates and constraints

These are storage-neutral requirements. The production schema must express them
with its supported constraints and transaction isolation rather than relying on
a prior application read.

| Decision | Database predicate or constraint | Accepted atomic change | Failure |
| --- | --- | --- | --- |
| Physical-root uniqueness | Persistent unique key on `(collectionId, deviceId, rootId)`; collision lookup must still authorize scope before projection | New binding, or same-actor `already-registered` receipt | `denied`, `ambiguous-ownership`, or retry after a uniqueness race under R4 |
| Scoped operation key | Persistent unique key on `(actorId, collectionId, deviceId, operation, operationId)` plus equality of canonical request digest | Insert one receipt, or read a currently reauthorized completed receipt | `operation-conflict`, `reconciliation-required`, or `superseded-operation` |
| Registry compare-and-set | Update/insert predicate requires stored `registryRevision = expectedRegistryRevision`; next value must remain a safe integer | Advance exactly once with all affected records and receipt/reservation changes | `retry-state`; zero writes |
| Binding compare-and-set | Selected binding must match scope, ID, expected binding revision, stored/current policy, root/VCS identity, and safe next revision where incremented | Rebind increments once; admission binds to unchanged current revision | `binding-unavailable`, `stale-binding`, `stale-policy`, `root-replaced`, or zero-write retry |
| Allocation collision | `projectId` and `bindingId` primary/unique keys reject an already-used proposed ID | Insert both new IDs with the registration transaction | `allocation-conflict`; never overwrite |
| Rebind destination | Physical-root uniqueness and destination collision lookup cover the candidate binding while permitting its own unchanged `rootId` | Update one binding and invalidate its older execution bindings in the same transaction | `root-conflict`, `root-replaced`, or retry |
| Complete reservation acquisition | For the sorted required key set, every key must be free and non-uncertain; ownership rows are conditional on the same transaction. No prefix may commit | Insert/update all keys to one owner and one admitted fence, plus pending receipt and registry revision | `busy` or `reconciliation-required`; no partial reservation |
| Fence high-water | Per-key durable high-water must be lower than the proposed token; the admitted token must exceed all selected keys, and all high-water updates commit together | Advance history and active reservations in the admission transaction | `stale-fence`; no admission |
| Write-back reservation check | Every required key exists, is active, and matches `ownerOperationId` and requested fence; uncertain takes precedence | No registry write; return bounded authorization only after all checks | `reconciliation-required` or `stale-fence` |
| Execution-copy binding | Selected record matches actor, project, binding, binding/policy revisions, owner, execution copy, and base content revision | No registry write; pass exact bound patch facts to the effect boundary | `copy-mismatch`, `stale-binding`, `stale-policy`, `content-conflict`, or `patch-unverified` |

## Missing seams and prerequisite owners

| Missing seam | Inspected finding | Existing outcome owner and exact prerequisite |
| --- | --- | --- |
| R1 duplicate-key transport validation | `defineAction` validates an already parsed value. The HTTP action route uses `Request.json()` or `readBody()` before calling `entry.run`; the inspected action fields expose no supported raw-body strict-JSON hook | Outcome 06: identify a supported transport boundary that can reject malformed and duplicate-key JSON before ordinary parsing on every string transport used by registry actions, then test it without changing the native action endpoint contract. Until then, duplicate-key rejection is unproved |
| Workbench registry database owner | Workbench has no app schema, typed `getDb`, migration entry point, registry action, or registry table. Core exports `createGetDb`; its declaration returns `LibSQLDatabase<T>` while its implementation selects several drivers. The installed Drizzle D1 dependency does implement an async callback with begin/commit/rollback and nested savepoints, but no backend is configured or exercised here | Outcome 06: add the app-owned portable project, binding, registry state, receipt, reservation/high-water, and execution-binding references behind migrations and transaction-backed actions; verify the transaction callback, rollback, constraint handling, and contender behavior on the selected configured backend before claiming enforcement |
| Trusted physical-root and VCS observation | No inspected public callable surface produces `rootId`, `locationRef`, fresh access, `contentRevision`, overlap, `repositoryId`, `checkoutId`, and one mutation owner. Workbench's `canonicalCwd` is only an absolute normalized string | Outcome 12: implement and fixture-test one trusted observation adapter across no-VCS, Git, linked worktree, monorepo, Jujutsu, colocated Jujutsu, path aliases, recreated directories, and unsupported layouts before mutation authority is enabled |
| Runtime execution binding | Native harness storage owns session identity and optimistic generation. The preserved Workbench host adds only `projectId` plus `canonicalCwd`, has no non-test call site, disables harness configuration, and reports no configured project/isolated runtime proof | Outcome 04, with current Habitat runtime proof owned by outcome 10: persist app-owned binding/policy/root/execution-copy/content references to the native session and reauthorize them on start, reopen, stop, and write-back |
| Cross-process reservation enforcement | Core local-artifact locks are process-local and manifest-relative; a database reservation alone cannot stop an external writer | Outcomes 04 and 12: pass the durable owner and current fence into the actual runner/root adapter and refuse mutation where the environment cannot enforce it; outcome 17 owns uncertain-owner reconciliation |
| Verified file effect and recovery evidence | Action completion and SQL commit cannot prove project bytes changed; no inspected registry seam verifies patch membership, containment, link behavior, or post-write content revision | Outcome 11 owns the file adapter and byte/conflict evidence; outcomes 17 and 29 own recovery and handoff reconciliation |
| Scoped filesystem connection binding | Workspace connections can resolve app access and grants, but their opaque configuration does not establish canonical filesystem identity or fresh root access | Outcome 06 composes the selected scoped connection with the outcome-12 observer; keep connection/grant records under their native owner |

The first prerequisite selected from this map is the outcome-12 trusted
root/VCS observation adapter contract and fixtures. Without it, the registry
cannot enforce physical-root uniqueness or construct trusted mutation keys even
if its SQL transaction is correct.
