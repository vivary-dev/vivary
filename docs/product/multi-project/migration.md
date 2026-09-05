# Consolidate Littleagent and legacy HarnessMax sources

Updated: 2026-09-05. This is the public preservation and ownership map for [the Vivary program](design.md). It authorizes no repository move, rename, archive, deletion, or history rewrite.

## Surviving direction

Vivary is the main product and the name for this evolution. The canonical public owner is `vivary-dev/vivary`. `Jeff-Kazzee/littleagent` supplies the Agent-Native workbench implementation, native-runtime host, specifications, and research. `The-Little-AI-Company/harnessmax` supplies reusable public evidence and design work where it still fits. Its earlier continuation is superseded as the next product plan.

Recommended source destination: an application package in the Vivary repository. Verify framework workspace assumptions, licenses, and source provenance before choosing the exact package path. Do not nest another repository's `.git` directory inside Vivary or flatten application code into Vivary's pure Core.

Until a verified integration checkpoint exists, each source stays with its present owner. Littleagent's detailed JSON and specifications remain its implementation ledger, subordinate to this cross-product plan. The public plan records source identities and preservation requirements. Exact machine paths, branch names, commit hashes, dirty manifests, active writers, and private review material belong in a private provenance receipt.

## Source identities and preservation classes

| Source identity or class | Public role | Preservation requirement |
| --- | --- | --- |
| `vivary-dev/vivary` | Canonical product repository, engine, standalone commands, public docs, and website | Preserve accepted work and use the repository's branch, review, and release process |
| `Jeff-Kazzee/littleagent` | Public source identity for the Agent-Native GUI, specifications, runtime-host work, and research | Preserve selected source, history, resources, tests, and attribution before integration |
| `The-Little-AI-Company/harnessmax` | Public legacy implementation and evidence source | Classify reusable source and public history before any retirement action |
| Private legacy planning source | Private planning, research, UX, and graph material | Keep private; preserve required facts in private provenance and publish only reviewed, source-safe conclusions |
| Local-only HarnessMax website source | Website and product-design source with no public remote or public-history claim | Preserve commits, working files, assets, and provenance privately before selecting public material |
| Local design and handoff sources | Generated design materials and coordination records | Classify each item as keep, adapt, or discard; publish no private review or machine-specific context |
| Linked worktrees and private working copies | Additional checkout state, which may contain unique changes | Resolve ownership and unique state privately; never treat a linked worktree as an independent repository |

The identity map does not prove that remote refs, issues, pull requests, releases, assets, licenses, or deployments are unchanged. Recheck them before import, publication, or retirement. Repository and source licenses remain an explicit outstanding risk until ticket 01 records reviewed findings.

## Littleagent scope carried forward

Source identity: `Jeff-Kazzee/littleagent`. Expected source areas are `docs/product/workbench-plan.json`, the S-00A packet, and specifications S-00 through S-13. Ticket 01 must record a canonical approved source packet before implementation relies on material that is not present in the public source identity.

| Source scope | Surviving Vivary responsibility | Preserve or correct |
| --- | --- | --- |
| S-00A and native runtime proof | Supported native session binding and lifecycle | Preserve host, readiness screen, tests, public API map, and incomplete real-runtime evidence |
| S-00 and domain/state | Workspace collection, project and checkout identity, policy, native references | Keep native run/session/task owners. Remove unconditional Git assumptions |
| S-01 and workbench UX | Project switcher, conversation, files, preview, plan and evidence panels | Preserve shell work. Fix save races, dirty-draft loss, and delete conflicts before release |
| S-02 and S-03 | Visual planning, revision authority, dependency-aware task views | Reference the selected task source. Do not silently mirror Beads or external issues |
| S-04 and S-05 | Authorized execution, checkout or folder isolation, verification, usage | Preserve runtime capability distinctions. No hard budget claims without enforcement |
| S-06 and S-07 | Recovery, review, integration, portable handoffs | Preserve native resume state and underlying runtime files. Make VCS operations conditional |
| S-08 and S-09 | Bounded factory operation and runtime expansion | Use configured authority. Preserve stop, ownership, budgets, and production gates |
| S-10 | Research specialists and evaluation | Retain cited evidence and measured value of delegation |
| S-11 and S-12 | Email intake, event routing, heartbeat and maintenance | Preserve signed intake, deduplication, deterministic no-op checks, and notification policy |
| S-13 and pilot/economics | User trials, intervention, completion, latency, and costs | Keep measured outcomes separate from follower counts or adoption promises |
| Specs 00 to 18 and advisor log | Detailed contract and unresolved findings | Preserve original review records privately. Public conclusions require source-safe evidence |
| Resource, connection, execution, app, plan, and orchestration research | Native composition evidence | Preserve version-matched source citations. Verify only changed or missing seams |
| BrowserPod and sandbox/trigger research | Optional execution modes | No automatic provider selection, paid account, or transferred credentials |
| Design and layout work | Product GUI direction and accessibility | Reconcile with Vivary visual direction before source styles or assets change |

Agent-Native's personal resource editor is not the user's project filesystem. Its app templates and emitted integration blueprints are not Vivary workspace-template archives. Its multi-app workspace is not the user's independent multi-project collection. Preserve these distinctions in APIs and UI labels.

## Preservation risks

- Public repository history alone may omit uncommitted or local-only work. Preserve selected files, manifests, and restore evidence privately before import or retirement.
- A clean public branch does not prove that every relevant working copy, linked worktree, issue, review, asset, or deployment has been captured.
- Runtime-host lifecycle checks do not establish real file mutation, process cancellation, or native session resume. Preserve those limits until ticket 10 supplies evidence.
- Editor prototypes may contain save races, reload loss, and deletion conflicts. Ticket 11 must give each risk a verified disposition.
- License and attribution requirements remain unresolved for every imported source slice until ticket 01 records them.
- Private planning, credentials, personal paths, and review context must not enter the public repository.

## Migration checks before removal

1. Verify all source identities, repository common directories, worktrees, active writers, dirty changes, unpushed commits, remote refs, open issues, pull requests, releases, assets, licenses, and deployments in private provenance.
2. Read path-keyed agent memories and salvage applicable facts using the reorganization procedure. Do not publish or merge private memory files into source.
3. Preserve code history, working files, private research, media, and issue or review records at a verified destination. A Git bundle alone does not preserve untracked files, hosted issues, or deployment state.
4. Record source-to-destination paths, hashes or commits, ownership, license and provenance findings, and restore instructions in the private receipt. Test restoration before claiming preservation.
5. Reconcile instructions, launchers, integrations, automations, task graphs, skills, and links that name old roots. Keep one canonical public entry and short source-safe pointers.
6. Verify the Vivary workbench integration and standalone compatibility from preserved source. Do not remove a source whose accepted material is still missing.
7. Present exact local and remote retirement actions per item. Apply an archive, rename, redirect, or delete operation only with the matching authority. Retirement remains deferred until the release gate and per-item decisions are complete.

No repository removal, remote rename, new GitHub repository, or source-history rewrite is needed to complete this public planning contract.
