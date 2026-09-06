# 03c registry transaction mapping receipt

Date: 2026-09-05. Verification kind: source inspection. Result: mapping accepted
after independent review. No runtime, production database, root, account, or
project file was exercised during this packet.

## Inspected revisions and artifacts

- Installed `@agent-native/core`: `0.176.5`.
- Installed resolved `drizzle-orm`: `0.45.2`.
- Canonical contract inputs: `project-registry.md`, the 03b packet and receipt,
  its 57-case decision oracle result, and `native-owners.md`.
- Workbench source was inspected as a preserved source snapshot only. Its private
  provenance and exact byte identities are retained in task staging. It was not
  imported into Vivary and does not prove current Habitat runtime behavior.

SHA-256 of installed source bytes used for the Core action and database claims:

| Source | SHA-256 |
| --- | --- |
| `node_modules/@agent-native/core/package.json` | `937ec79fc0e2d1b105e1b422c2460ea2276c51709576e5604917f46a2e4bf539` |
| `node_modules/@agent-native/core/dist/action.d.ts` | `66b30bc89faf60e763c8c2ea17c9f4f6c48ab232552fc702fe1759d675862154` |
| `node_modules/@agent-native/core/dist/action.js` | `fac0f06649c2f6e4a6554f551b583490b4e4281d2901353402da4a789ef9cf43` |
| `node_modules/@agent-native/core/dist/server/action-routes.js` | `f4a2820a0e68145a1c1101d15c4868a5f2d22a41aca198b7496859a1486344dc` |
| `node_modules/@agent-native/core/dist/server/h3-helpers.js` | `6aeffca4688952694d1aed2d86f81630de57dd8b1ce4c3e4b240e490874b7e8f` |
| `node_modules/@agent-native/core/dist/db/index.d.ts` | `2130bf5e8723572484e9cd2ef4a7394e8da5ece86e52fba68844808ec0d978d0` |
| `node_modules/@agent-native/core/dist/db/create-get-db.d.ts` | `5906b3304965bb9e2f5ad8feaf4193d3a7b48907b9952cbc2cba44e588e958fa` |
| `node_modules/@agent-native/core/dist/db/create-get-db.js` | `296ff7c031fbc8c4a55b1ed47bb776dc12bf840480803b9888b15a0ad50713a8` |
| Resolved `drizzle-orm/d1/session.d.ts` | `9e8559961af2b8bf6bf5c9a88525568c4914626dfc66434b6d5e624d6f91540f` |
| Resolved `drizzle-orm/d1/session.js` | `2c0ee59a44d772abe4a17ace3d0e49f0d3e7b67acd3b4b2aabd8f550d5dc4f96` |

## Source findings

| Concern | Evidence | Result |
| --- | --- | --- |
| Action boundary | `node_modules/@agent-native/core/package.json:91-94`; `dist/action.d.ts:44-123,588-618,811-812`; `dist/action.js:80-158,321-380` | `defineAction` exposes schema, authorization, output validation, run context, and audit. Authorization wraps every dispatch path. Audit runs after handler success/error and deliberately swallows recorder failure, so it cannot replace the atomic contract receipt |
| Strict JSON transport | `dist/server/action-routes.js:481-512,525-531`; `dist/server/h3-helpers.js:80-81`; generated deployment route in `dist/deploy/build.js:938-944` | HTTP bodies are parsed through `Request.json()` or `readBody()` before `entry.run`. Duplicate keys are therefore unavailable to the action schema, and no supported raw-body strict-JSON hook was found. R1 duplicate-key rejection remains unproved at the transport boundary |
| Database client | `package.json:108-112`; `dist/db/index.d.ts:23`; `dist/db/create-get-db.d.ts:88-95`; `dist/db/create-get-db.js:304-396,400-495`; resolved `drizzle-orm/d1/session.d.ts:34-38`; resolved `drizzle-orm/d1/session.js:63-89`; `docs/content/server-database.mdx:198-207` | Core publicly exports `createGetDb`. Its declaration returns `LibSQLDatabase<T>` while the implementation constructs D1, PGlite, Neon/Postgres, better-sqlite, and libSQL branches and patches better-sqlite async transactions. The installed D1 dependency expressly implements an async transaction callback using begin/commit/rollback and nested savepoints. These source reads establish callable seams, but no Workbench backend is configured and no driver was executed, so production isolation, durability, rollback, constraint handling, and contender behavior remain unproved |
| Workbench database owner | `rg --files apps/workbench/actions apps/workbench/server packages/shared/src/server`; action inventory and absence of schema/drizzle/migration/registry matches | Workbench has navigation, screen, and runtime-readiness actions, but no registry action, app schema, typed database owner, or migration entry point |
| Scoped connections | `dist/workspace-connections/store.d.ts:94-158,238-244`; `store.js:391-439,697-771`; `docs/content/workspace-connections.mdx:14-23` | Public resolution enforces app access/grant and can require connected state. Returned metadata/configuration does not prove canonical root identity or fresh filesystem access |
| Local artifacts | `dist/local-artifacts/index.d.ts:1-99,123-157`; `index.js:288-330,350-439,507-578`; `package.json:324-326` | Helpers resolve configured relative roots, hash content, reject links, use an in-process map lock, and replace through a temporary file. They do not provide stable physical-root, repository/checkout, cross-process reservation, or external-writer fence evidence |
| Native harness ownership | `dist/agent/harness/store.d.ts:6-45`; `store.js:119-217`; `types.d.ts:15-46`; `runner.d.ts:4-19`; `runner.js:5-52` | Native storage retains session/run/thread identity, workspace reference, owner/org, resume state, and optimistic generation. The app should reference those IDs, not create another session owner |
| Preserved Workbench host | `apps/workbench/server/agent-runtime-host.ts:41-65,104-168,190-228,282-343,374-419,454-459`; `apps/workbench/actions/runtime-readiness.ts:97-111`; `apps/workbench/agent-native.config.ts:3-6` | The host binds `projectId` to an absolute normalized `canonicalCwd` and native workspace/session data, but does not establish canonical physical identity. There is no non-test composition call site; harness is disabled and readiness reports the project workspace and isolated runtime prerequisites missing |
| Root/VCS public seam | Exact searches for `rootId`, `locationRef`, `repositoryId`, `checkoutId`, canonical identity, `realpath`, `gitdir`, and `commondir` under Workbench, shared server code, and public Core declarations | No callable trusted observation adapter was found. The only Core declaration hits were unrelated CLI internals (`dist/cli/clean.d.ts:7,47,61` and `dist/cli/template-baseline.d.ts:5`) |
| Run-code sandbox | `docs/content/sandbox-adapters.mdx:16-45,93-167`; `dist/coding-tools/sandbox/adapter.d.ts:1-77`; `dist/coding-tools/sandbox/index.d.ts:1-54`; `index.js:35-87` | This seam runs supplied module source with environment, timeout, and bridge settings. It does not resolve a registered project root or execution copy and cannot stand in for the coding harness/root adapter |

## Exact read-only commands

```console
rg -n '"version"|"./action"|"./db"|"./workspace-connections"|"./local-artifacts"' node_modules/@agent-native/core/package.json
rg -n "defineAction|ActionRunContext|authorize|audit" node_modules/@agent-native/core/dist/action.d.ts node_modules/@agent-native/core/dist/action.js
rg -n "Request\.json|readBody|entry\.run" node_modules/@agent-native/core/dist/server/action-routes.js node_modules/@agent-native/core/dist/server/h3-helpers.js node_modules/@agent-native/core/dist/deploy/build.js
rg -n "createGetDb|transaction|atomicBatch" node_modules/@agent-native/core/dist/db -g '*.d.ts' -g '*.js'
rg -n "transaction|savepoint|rollback" node_modules/.pnpm/drizzle-orm@0.45.2_@libsql+_bdd2b2029f2ca78dfb5d5ce73569a47d/node_modules/drizzle-orm/d1/session.d.ts node_modules/.pnpm/drizzle-orm@0.45.2_@libsql+_bdd2b2029f2ca78dfb5d5ce73569a47d/node_modules/drizzle-orm/d1/session.js
rg -n "resolveWorkspaceConnectionForApp|WorkspaceConnectionAppAccess" node_modules/@agent-native/core/dist/workspace-connections -g '*.d.ts'
rg -n "rootId|locationRef|repositoryId|checkoutId|realpath|workspaceRef|canonicalCwd" apps/workbench node_modules/@agent-native/core/dist -g '*.ts' -g '*.d.ts'
rg --files apps/workbench/actions apps/workbench/server packages/shared/src/server
rg -n "createNativeRuntimeHost" apps/workbench -g '*.ts' -g '!*.test.ts'
```

The exact-identifier root/VCS search found no registry identity declarations.
`workspaceRef` and `canonicalCwd` hits belong to native session binding and the
preserved host; `realpath`/`gitDir` hits belong only to unrelated CLI cleanup or
template internals. The Workbench inventory found no database or registry owner.

## Limits and unresolved questions

- The eventual production database has not been selected or configured. The
  installed D1 source contains the callback and rollback path, but no driver has
  been exercised for isolation, durability, rollback, constraint-error
  projection, contender races, or crash behavior.
- No physical root, alias, recreated directory, linked worktree, monorepo,
  Jujutsu workspace, or Habitat execution copy was probed.
- Database reservation rows still need an enforceable adapter boundary; they
  cannot alone fence another process or device.
- Actual patch containment, link handling, byte writes, post-write content
  revision, cancellation, and uncertain-owner recovery remain unproved.

## Author trace through the 03b oracle

This trace confirms that the map has an owner and zero-write boundary for five
representative cases. It is separate from the coordinating reader's independent
review.

| Case | Record and operation path | Predicate and gap path | Expected oracle |
| --- | --- | --- | --- |
| `register-external-no-vcs` | Portable project, binding, registry state, and completed receipt rows; `register` action constructs the no-VCS root observation | Physical-root, allocation, and registry compare-and-set predicates; outcome-06 database and outcome-12 observation gaps remain | `registered`; registry revision 7 to 8; insert project, binding, and receipt; only `registry` effect |
| `root-not-authorized` | Root access comes from the existing policy owner; `register` stops during authorization/observation before transaction work | No uniqueness or compare-and-set change is accepted; scoped filesystem authorization remains an outcome-06 composition prerequisite | `denied`; zero effects and record changes |
| `allocation-collision` | Trusted ID allocation is consulted only after register authorization and uniqueness inspection | Project/binding unique constraints reject a used proposed ID without overwrite; app database owner remains missing | `allocation-conflict`; zero effects and record changes |
| `same-operation-replayed` | Scoped completed receipt is reauthorized against the current portable project, binding, root, and policy before new work | Scoped operation-key/digest predicate returns the current result; old expected registry revision 7 is not compared with current revision 8, and no allocation or CAS runs | `registered` with `replayed: true`; zero effects and record changes |
| `write-back-bound-copy-authorized` | Execution binding, active reservations, fence 8, exact patch digest/path, and fresh root/content facts pass `authorize-write-back` reads | Reservation and execution-copy predicates pass; file-effect/recovery seam remains missing and no SQL or byte write is claimed | `authorized`; exact copy/patch/path/fence allowlist; zero effects and record changes |

## Successor prerequisite

The staged successor packet is `12a-root-vcs-observation-contract.md`. It owns a
fixture-backed trusted observation boundary for stable physical-root identity,
fresh access/content revision, overlap, repository/checkout identity, and the
common mutation key set. It does not select the registry database or perform
write-back. Outcome 03 remains open until its production owners supply
transaction and adapter evidence.

## Independent review

The coordinating Codex independently read the five named oracle cases and all
four mapping tables. Each accepted state change has one transaction owner;
denial, collision, replay, and write-back authorization preserve their zero-write
boundaries. No unowned field or split atomic change remained in those traces.

The reader also inspected Core's action parsing, authorization/audit order,
public database return type, driver-selection and async transaction code, and
the installed Drizzle D1 transaction implementation. The preserved Workbench
host and local-artifact helpers do not establish physical-root identity. Source
inspection does not establish configured backend behavior.

Review corrections made before acceptance:

- Mark raw JSON duplicate-key rejection as an unresolved transport requirement.
- Describe the registry-counter partition as a proposal, not a contract fact.
- Resolve valid current replay before comparing old request revisions.
- Retain private checkout provenance outside the public artifacts.
- Make 12a ready with only 03c as its start dependency, three exact outputs,
  inspection-only verification, and Habitat as the current environment.

The next packet is executable contract preparation. Its expected oracles will
still require later implementation and physical verification.
