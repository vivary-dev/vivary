# Ticket 01 migration-boundary receipt

Evidence-record: 01
Status: initial boundary receipt retained; current audit and packet readiness live in the generated graph.

Recorded: 2026-09-05

This receipt closes the public documentation and provenance-reconciliation slice of ticket 01. It does not prove that source bytes, history, local changes, issues, reviews, assets, deployments, or runtime state have been preserved or restored. Ticket 02 owns that proof.

## Authority and publication boundary

The canonical public destination is `vivary-dev/vivary`. The public source identities are `Jeff-Kazzee/littleagent` and `The-Little-AI-Company/harnessmax`. Private planning and local-only website or design sources remain source classes rather than named repositories or machine locations.

Exact paths, branch names, commit hashes, worktree locations, dirty manifests, active-writer details, and private review material stay in the private provenance record. That record is an input to controlled preservation work; it is not part of this documentation set.

The initial documentation PR still requires the repository merge gate. That gate does not prohibit independent contract and fixture packets under existing implementation authority. The owner authorized publishing these reviewed contracts through the normal pull-request workflow on 2026-09-05. No product release, source import, source move, repository creation, remote change, retirement, archive, rename, redirect, or deletion is recorded as executed.

The live agent-readiness baseline remains Level 1/5, with three passing checks among sixteen scored checks and no official overall percentage. The required real 100 percent acceptance result has not been obtained.

## Source, ownership, and destination map

| Source identity or class | Material and dirty source classes | Known license finding | Proposed public owner and destination | Unresolved before preservation or import |
| --- | --- | --- | --- | --- |
| `vivary-dev/vivary` | Canonical product code, standalone commands, public docs, and site. Private provenance records pre-existing tracked documentation and website changes plus multiple checkouts | Root MIT license present | Existing owners remain authoritative. Program contracts belong under `docs/product/multi-project/` on the reviewed topic branch | Active ownership of unrelated changes, exact merge boundary, and license review for any new third-party material |
| `Jeff-Kazzee/littleagent` | Workbench application, product ledger, specifications, research, runtime host, tests, generated docs, package metadata, and lockfile. Private provenance records tracked modifications, apparent link-related deletions, and extensive untracked source and documentation | No repository license file or manifest license field was found in the inspected source | Selected application source is proposed for a Vivary app package; public plans and source-safe conclusions belong in Vivary canonical docs | License and attribution for every selected slice; exact file manifest; source owner; destination package; history method; treatment of generated files, lockfile, and link-related deletions |
| `The-Little-AI-Company/harnessmax` | Public legacy application and evidence source. Private provenance records an untracked handoff and linked working copies that may contain unique work | Root MIT license present | Reviewed, reusable evidence or source may move to the owning Vivary package or canonical docs | Exact accepted slices, linked-worktree ownership, unique local state, attribution, and whether any code remains useful after Vivary integration |
| Private legacy planning source | Plans, research, UX, graphs, task material, and private review context. Private provenance records modified, deleted, and untracked material | No license file was found | Keep the source private. Publish only reviewed, source-safe conclusions into the owning Vivary contract or ticket | Source owner, license and attribution, accepted conclusions, private-data review, and preservation destination |
| Local-only HarnessMax website source | Website implementation, product and architecture material, design comps, and assets. It has no public remote or public-history claim; private provenance records tracked and untracked work | No license file was found | Preserve privately first. Selected public assets or prose may later move to the Vivary site through the website ticket | Source owner, asset licenses, authorship, accepted material, history preservation method, and public destination |
| Local design and handoff sources | Generated design tokens, prompts, components, kits, handoffs, instructions, and protection configuration | No repository-wide license conclusion is available | Keep private until each item is classified as keep, adapt, or discard; publish only accepted source-safe output | Authorship, third-party asset terms, active owner, canonical replacement, and retirement effect |
| Linked worktrees and private working copies | Alternate checkouts and unique local state associated with the public or private sources above | Inherits no license conclusion merely from the parent checkout | Treat as preservation inputs, never independent repositories | Common-repository identity, active writer, unique commits and files, and safe removal procedure after preservation proof |

An MIT license in one repository does not license another repository, private planning material, generated assets, or third-party dependencies. Ticket 02 must bind each imported path to a reviewed source and license disposition.

## Littleagent scope disposition

The table maps every retained S-00A and S-00 through S-13 responsibility to a public Vivary owner. It records the latest available implementation evidence without treating uncommitted source or deterministic fixtures as preservation or real-runtime proof.

| Source scope | Surviving responsibility | Current evidence and limit | Proposed Vivary owner | Unresolved prerequisite |
| --- | --- | --- | --- | --- |
| S-00A | Native runtime composition and lifecycle proof | A thin Workbench host uses public Core 0.176.5 Harness APIs. Eleven deterministic tests passed against the real Core run manager and SQL store. No actual coding runtime, authenticated file mutation, operating-system process-tree cancellation, or native reopen-and-continue result has passed | Tickets 04 and 10; proposed Workbench app host | Approved source packet, destination package, compatible installed runtime peer, authenticated execution boundary, and AC-135 evidence |
| S-00 | Project, checkout, policy, native-reference, and state contracts | Detailed specifications exist. No accepted multi-project registry or persistence owner is implemented | Tickets 03 and 04 | Portable identity schema, machine-local binding owner, serialization rule, and exact app files |
| S-01 | GUI shell, project switching, sessions, conversation, files, preview, and evidence panels | Exploratory workbench source exists. Dirty drafts, reload loss, save races, and remote-deletion conflicts remain product risks | Tickets 05, 06, and 11 | Accepted source manifest, license disposition, destination app package, and conflict-safe editor proof |
| S-02 | Visual planning and revision authority | Specification and UI research exist; no accepted application contract is evidenced | Ticket 15, using ticket 14's selected task source | Plan owner, revision persistence, exact implementation files, and executable contract tests |
| S-03 | Dependency-aware task and kanban views | Specification exists; no verified multi-source board implementation is evidenced | Tickets 14 and 15 | Task identity mapping, cycle behavior, source authority, exact files, and browser tests |
| S-04 | Authorized worker execution and intervention | Policy contracts exist. Deterministic host tests cover bounded host behavior only | Ticket 16, using tickets 04 and 10 | Enforceable execution binding, worker owner, verification target, cancellation chain, and real run receipts |
| S-05 | Isolation, verification, usage, and cost evidence | Resource-profile prose and a supplied sandbox object do not enforce containment. No real runtime usage or cost receipt exists | Ticket 16 | Selected execution mode, enforceable limits, measured usage source, timeout behavior, and direct isolation evidence |
| S-06 | Crash recovery and native session resume | Core persists opaque resume state and deterministic tests cover stored state. Cross-process native session recovery is unproved | Ticket 17 | Recovery coordinator owner, replay ledger, runtime files, crash fixtures, and no-duplicate-effect proof |
| S-07 | Review, conditional integration, and portable handoffs | Specifications exist; no verified Git, Jujutsu, or no-VCS integration flow is evidenced | Ticket 29, with recovery in ticket 17 | Selected VCS capability, diff or patch contract, conflict handling, handoff import/export files, and tests |
| S-08 | Bounded factory operation | Proposed contracts exist; no production factory is active or authorized | Ticket 20 | Scheduler owner, worker ownership, authority and budget enforcement, stop conditions, and production gates |
| S-09 | Runtime expansion and factory policy | Claude Code and Codex are intended runtimes; Pi remains an adapter to evaluate. No runtime is selected as the default | Tickets 10 and 20 | Per-adapter start, approval, sandbox, stop, resume, and usage evidence; no copied credentials |
| S-10 | Research specialists and measured delegation | Research-role specifications and source research exist; no completed comparative pilot is evidenced | Ticket 21 | Frozen task set, source and citation contract, no-cost runtime, evaluation method, and comparison limits |
| S-11 | Signed email intake and event routing | Specification exists; no live account, outbound email, or production intake is enabled | Ticket 22 | Signed local fixture, deduplication ledger, routing authority, adapter files, and account gates |
| S-12 | Heartbeat and deterministic maintenance | Specification exists; no recurring job or external scheduler is activated | Ticket 30 | Framework scheduler seam, deterministic no-op rule, notification policy, retry state, and operator controls |
| S-13 | Pilot outcomes and economics | Measurement requirements exist; no pilot outcome, affordability result, or adoption result is claimed | Ticket 36 | Consent and privacy plan, frozen tasks, raw receipts, metric definitions, runtime budget, and reviewer trace |

## Native-runtime evidence boundary

The implemented host belongs in the proposed Workbench application layer. Core owns the run manager, normalized events, SQL Harness session record, follow-up, approval where supported, stop control, and rehydration. The application must provide the authenticated project, canonical working directory, owner and organization scope, permission mode, selected adapter, and real execution boundary.

The existing `harness: true` configuration is a hosted tools-only picker and cannot prove repository reads, writes, code execution, cancellation, or session continuation. The app host has no user-facing start action, does not authenticate HTTP callers, and does not create a sandbox. Its deterministic adapter proves host wiring and errors, not a native CLI or model run.

Current evidence supports these statements only:

- Eleven focused tests passed in Habitat against Core 0.176.5 and its SQL-backed run and session owners.
- The tests cover normalized event persistence, native identifiers, saved opaque resume state, owner and project refusal, generation claims during concurrent reopen, startup cancellation, missing prerequisites, and adapter-creation errors.
- Workbench type checking passed after the host refinements. A browser pass verified mounted routes, the native chat/setup handoff, and mobile layout without page errors. The Dispatch repository doctor finding remains unresolved; this is not a workspace-wide clean check.
- Optional Harness runtime peers remain uninstalled and unexecuted in the source checkout.
- No host authentication was copied, no paid model call occurred, and no real coding-runtime proof passed.
- Core's Codex adapter does not declare approval support, and its Pi adapter does not declare sandbox support. Capability policy must reflect those limits.
- A saved resume token does not prove that required runtime session files survive or that a different process can continue the session.

Ticket 10 retains the real runtime acceptance work. Ticket 01 does not close AC-135 or any product-behavior gate.

## Ticket 01 review result

The public boundary map now covers the public repositories, private and local-only source classes, dirty-work categories, S-00A and S-00 through S-13 responsibilities, known license-file findings, proposed public owners, destination classes, and unresolved authority. The map deliberately omits private coordinates and does not state that any source has been restored.

The documentation and provenance outcome is complete. Two-reader scope review, the generated-plan guard, all 17 adversarial guard tests, line endings, and diff hygiene passed in [CI](https://github.com/vivary-dev/vivary/actions/runs/33990271792). PR merge remains a separate human gate. This receipt does not authorize or prove source import.

## Successor packets

Current dispatch belongs to [the generated graph](../graph.md). The earlier
embedded task proposals are superseded by the bounded packet files:

- [02a](../packets/02a-source-preservation-fixture.md) defines the synthetic
  preservation contract and fixture oracle; it needs no real-source import.
- [02b](../packets/02b-restore-fixture-harness.md) executed the synthetic
  restoration harness in Habitat. Only real-source import requires the selected
  private manifest and applicable license dispositions.
- [03a](../packets/03a-project-registry-contract.md) owns portable registry
  contract inspection. Its current status belongs to the graph. Choosing a persistence owner is part of subsequent
  integration; planned output files are not start prerequisites.

These packet files own implementation paths, commands, and exact prerequisites.
Do not dispatch from historical commands embedded in older receipt revisions.
