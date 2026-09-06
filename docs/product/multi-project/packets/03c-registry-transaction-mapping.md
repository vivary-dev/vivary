# 03c: Map registry transactions to native application seams
Type: packet
Parent: 03
Status: done
Depends-on: [03b]
Owner: Codex registry_model, sole map writer; coordinating Codex owns independent review
Scope: Source-backed action, storage, transaction, and root-adapter map only. No production schema, action, adapter, or database selection.
Verification-kind: inspection
Evidence: [Transaction mapping receipt](../receipts/03c-registry-transaction-mapping.md)
Timebox: One context window. Stop after a second reader can trace every map row to the contract and an inspected source.

## Goal

Map the portable registry contract onto existing Agent-Native and Workbench
owners. Name every missing implementation prerequisite without inventing an API
or choosing a production database.

## Context

Read [the registry contract](../contracts/project-registry.md), [03b](03b-registry-contract-model.md),
its execution receipt, and [native owners](../native-owners.md). Treat 03b as the
decision oracle. It does not prove SQL transactions, root identity, file access,
or process fencing.

Inspect the version-matched package before naming a framework seam. Start with
`node_modules/@agent-native/core/package.json`, the package docs for actions,
action access control, run context, database use, audit, and sandbox adapters,
then the matching declarations and compiled source under
`node_modules/@agent-native/core/dist/`. Record the exact package version in the
receipt.

Run package and Workbench source searches from the preserved `Jeff-Kazzee/littleagent`
checkout. Run the planning checks from the canonical Vivary worktree. No source
import is needed for these reads. Inspect the preserved Workbench source at `apps/workbench/actions/`,
`apps/workbench/server/`, `apps/workbench/agent-native.config.ts`, and
`packages/shared/src/server/`. Read the root, shared, and app instructions before
reading source. These files are evidence inputs. Their presence does not make
them imported Vivary production code.

## Owned files

- Create `docs/product/multi-project/contracts/project-registry-transaction-map.md`.
- Create `docs/product/multi-project/receipts/03c-registry-transaction-mapping.md`.
- Update this packet's log and evidence link after independent review.
- Prepare only the next missing-prerequisite packet selected by the completed
  map. Do not combine production implementation with this inspection.

## Required map

The contract map must contain four traceable tables.

1. Map each contract record to its proposed storage owner, privacy scope,
   lifecycle, unique keys, and revision or fencing field. Keep native session,
   action audit, connection, and transcript records under their existing owners.
2. Map `register`, `export`, `rebind`, `admit-mutation`, and
   `authorize-write-back` to input validation, caller authorization, trusted
   observation construction, transaction work, external effects, and public
   results. Cite the corresponding contract rules for every row.
3. Map each compare-and-set and uniqueness decision to a database predicate or
   constraint. Cover the physical-root key, scoped operation key, registry and
   binding revisions, allocation collisions, complete reservation acquisition,
   and fencing-token high-water state. Describe requirements without writing
   dialect-specific SQL.
4. Map every missing seam to its existing outcome owner and an exact prerequisite.
   A gap is a result. Do not fill it with a proposed function name.

For registry-changing operations, the map must keep the project or binding
change, registry revision, operation receipt, and reservation change in one
database transaction. A rejected compare-and-set changes none of them. The map
must distinguish that transaction from the framework action audit, which records
an action after its handler resolves and cannot replace the contract receipt.

The map must also distinguish SQL commit from a filesystem effect. Write-back
must recheck authority, root and content identity, active reservation ownership,
and fence at the effect boundary. A SQL row or successful action result cannot
claim that project bytes changed.

## Inspection ledger

| Concern | Inspect | Question the map must answer |
| --- | --- | --- |
| Shared operation entry | `actions-defining.mdx`, `actions-access-control.mdx`, `actions-run-context.mdx`, `dist/action.d.ts`, `dist/action.js`, and Workbench's action registry plugin | Which public `defineAction` fields validate input, authorize every caller, expose request identity, and record audit? Which contract facts still need a server-owned resolver? |
| App transaction | `server-database.mdx`, `dist/db/index.d.ts`, `dist/db/create-get-db.d.ts`, `dist/db/create-get-db.js`, and the Workbench database-file inventory | Does the installed `createGetDb` client expose a transaction callback for every configured dialect? Does Workbench already own a typed database client, schema, and migration entry point? |
| Scoped connection | `workspace-connections.mdx` and `dist/workspace-connections/` | Can an app resolve an authorized connection and grant? Does that public result establish a canonical filesystem root or only connection metadata and access? |
| Local files | `dist/local-artifacts/index.d.ts` and `dist/local-artifacts/index.js` | Are manifest-relative file helpers sufficient for external project identity, repository identity, cross-process reservations, and write-back fencing? |
| Runtime binding | `harness-agents.mdx`, `dist/agent/harness/`, `apps/workbench/server/agent-runtime-host.ts`, and all non-test call sites | Which native session ID and optimistic generation remain native? Which project, binding, policy, root, execution-copy, and content revisions still need app-owned references? |
| Root and VCS observation | Workbench server code plus installed public exports searched for `rootId`, `locationRef`, canonical filesystem identity, repository identity, and checkout identity | Is there a callable trusted adapter that distinguishes a path alias from a recreated directory and reports no-VCS, Git, linked-worktree, monorepo, and colocated Jujutsu identity? |
| Runtime filesystem boundary | `sandbox-adapters.mdx`, installed sandbox declarations, and Workbench runtime configuration | Does an installed adapter resolve a registered project root or Habitat execution copy? Do not substitute the `run-code` sandbox seam for a coding-harness or project-root adapter. |

## Done condition

1. Every field and state change in `vivary.project-registry-contract.v1` has one
   proposed storage owner or a named gap. The map does not create a second task,
   session, transcript, connection, or action-audit record.
2. Every operation names the exact `defineAction` boundary it can use. The map
   identifies which authenticated facts are present in `ActionRunContext` and
   which contract facts are absent. Caller requests cannot supply the trusted
   object.
3. The receipt cites the installed Core version and the public export or source
   file that proves each claimed action and transaction capability. It also
   records whether Workbench has an app schema, typed `getDb`, migration owner,
   and registry action.
4. The map states how one database transaction enforces each accepted registry
   change. It also explains why default same-turn action serialization, automatic
   audit, a harness-session generation check, and an in-process file lock do not
   provide the registry's cross-request transaction or external-process fence.
5. The root-adapter inspection covers canonical physical identity, fresh root
   access, content revision, overlap, repository ID, checkout ID, and mutation
   owner. If one callable adapter does not provide these facts, the receipt proves
   the inspected gap. Outcome 06 then owns the registry application service,
   outcome 12 owns root and VCS identity plus common reservation keys, outcome 04
   owns runtime execution binding, and outcomes 11, 17, and 29 own file effects,
   recovery, and enforceable fencing.
6. The connection inspection distinguishes a scoped connection or grant from a
   verified filesystem root. Opaque configuration and credential references do
   not become `rootId`, `locationRef`, or root-access evidence.
7. A second reader selects at least one success, refusal, replay, collision, and
   write-back case from the 03b oracle. The reader traces each case through the
   map and reports any field without an owner or any atomic change split across
   owners.
8. The receipt records exact read-only commands, results, inspected revision,
   unresolved questions, and successor prerequisite. Parent outcome 03 remains
   open until its production transaction mapping and owning adapter checks have evidence.
   Prepare the next executable packet without adding a blanket human approval gate.

## Verify

Use bounded source searches. Do not run an application or create persistent
state during this packet.

```console
rg -n '"version"|"./action"|"./db"|"./workspace-connections"|"./local-artifacts"' node_modules/@agent-native/core/package.json
rg -n "defineAction|ActionRunContext|authorize|audit" node_modules/@agent-native/core/dist/action.d.ts node_modules/@agent-native/core/dist/action.js
rg -n "createGetDb|transaction|atomicBatch" node_modules/@agent-native/core/dist/db -g '*.d.ts' -g '*.js'
rg -n "resolveWorkspaceConnectionForApp|WorkspaceConnectionAppAccess" node_modules/@agent-native/core/dist/workspace-connections -g '*.d.ts'
rg -n "rootId|locationRef|repositoryId|checkoutId|realpath|workspaceRef|canonicalCwd" apps/workbench node_modules/@agent-native/core/dist -g '*.ts' -g '*.d.ts'
rg --files apps/workbench/actions apps/workbench/server packages/shared/src/server
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

Review the contract map and receipt separately from generated graph changes. A
green documentation check proves packet consistency only.

## Stop conditions

Do not add a schema, migration, action, route, storage adapter, root resolver,
lock, session store, runtime, or test. Do not import the preserved Workbench
source into Vivary. Do not choose SQLite, Postgres, D1, Turso, PGlite, or a hosted
provider as the production database.

Do not start a runtime, probe a live root, mutate project files, connect an
account, install a dependency, or publish. Do not treat package documentation,
an app-relative file helper, a normalized path string, an action audit row, or a
passing 03b fixture as proof of durable transaction or filesystem enforcement.

If the installed database client lacks a public transaction callback, record the
missing export and make it the exact prerequisite for the next storage packet.
If no callable root adapter produces the contract observation, record that gap
and route implementation to outcomes 06 and 12. Do not invent an interface in
this packet.

## Log

- 2026-09-05: Prepared after 03b's deterministic registry model passed its full fixture, schedule, and deliberate-mutation checks in the authorized Habitat fallback. This packet maps future production transactions and adapters. It does not implement them or complete outcome 03.

- 2026-09-05: Claimed after 02b completed. The sole map writer will inspect existing native APIs and stage the four contract tables; the coordinator owns review and graph integration. No runtime or production schema is created by this packet.

- 2026-09-05: Completed the four source-backed mapping tables and independent five-case trace. Recorded the strict-JSON transport gap, proposed registry partition, missing database/root owners, replay ordering, and filesystem-effect limits. Packet 12a is ready for the trusted root/VCS observation contract. No production implementation is claimed.
