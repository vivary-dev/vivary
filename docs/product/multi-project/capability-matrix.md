# Retained capability matrix

Status: retained outcome coverage for the current program.

Tickets 01 through 36 remain stable parent outcomes. Their graph dependencies are
completion dependencies. A bounded packet may start earlier when it is reversible,
uses existing inputs, respects BrowserPod gates, and cannot falsely close its parent.

Optional means the user can skip the capability. It does not remove the parent
outcome from the release program. Every optional path must prove `skip`,
`unavailable`, and failure behavior as well as its supported path.

| ID | Retained outcome and source scope | Bounded baseline path | Optional path or parent-completion work |
| --- | --- | --- | --- |
| 01 | Migration boundary for S-00A and S-00 through S-13 | Public ownership and conflict map | Private provenance, licenses, and source acceptance remain gated |
| 02 | Preserve selected source and dirty work for all retained scope | Synthetic manifest, copy, restore, and hash fixture | Approved real manifest, license dispositions, and restore proof close the parent |
| 03 | Project registry and authority, S-00 | Storage-neutral identity and no-VCS fixtures | Git, worktree, monorepo, Jujutsu, moved-root, and production-owner cases close the parent |
| 04 | Runtime and session contract, S-00A, S-00, S-04 to S-07 | Types and no-model lifecycle fixtures over native references | Selected adapter, tool, approval, and receipt behavior close the parent |
| 05 | Preserved GUI shell, S-01 | Build the imported shell with unsupported controls labeled | Connected native panels and provenance evidence close the parent |
| 06 | Register and switch projects, S-00 and S-01 | Two local no-VCS roots, read-only registration, safe switching | VCS and unavailable-root capability states complete the matrix |
| 07 | Create greenfield projects | Blank thin workspace with no VCS, host, template, or Brain | Git or Jujutsu, host, template, and Brain choices remain separate branches |
| 08 | Adopt brownfield projects | Read-only registration and approved dry-run adoption fixture | Monorepo, worktree, submodule, VCS, and populated-folder conflicts complete coverage |
| 09 | Standalone and headless parity | Existing offline CLI behavior with the GUI closed | Each supported GUI operation gains a matching structured headless contract |
| 10 | Real native runtime proof, S-00A and S-09 | 10a static BrowserPod preflight, then 10b pure-JS toolchain and persistence proof | Authenticated coding runtime start, file change, cancel, resume, and usage close the parent |
| 11 | Files, drafts, and conflict-safe editing, S-01 | Local file, reload, stale revision, and conflicting-save fixtures | Preview providers and remote-edit cases extend the supported matrix |
| 12 | No-VCS, Git, and Jujutsu identity adapters | No-VCS single-writer and read-only capability path | Git, worktree, monorepo, and colocated Jujutsu behavior close the parent |
| 13 | Optional repository hosts | Skip, local-only, custom-remote, and fake-host paths | GitHub or Gitea live writes retain per-action human gates |
| 14 | Task-source authority, S-02 through S-07 | Local native task source with stable identity | Beads and external trackers require owner-specific refresh and write behavior |
| 15 | Visual plans and dependency-aware board, S-02 and S-03 | Native Plan references and local native tasks with no VCS | Connected Plan and external task-source paths preserve revision and source authority |
| 16 | Verified workers and cost evidence, S-04, S-05, and S-13 | Deterministic policy and no-cost synthetic runner fixtures | Supported runtime execution and measured usage close the parent |
| 17 | Crash recovery and native resume, S-06 and S-07 | Checkpoint, restart, fencing, and replay fixtures | Native resume and cross-device recovery require direct evidence |
| 18 | Optional Brain and reviewed learning | Brain-off path and project-scoped learning fixtures | Connected Brain, promotion, export, correction, rollback, and deletion limits complete it |
| 19 | Workspace template program | Skip and unavailable-template paths plus wrapper contract | Held installer outcomes, approved source, compatible artifact, and recovery close it |
| 20 | Bounded factory, S-08 and S-09 | Paused mode and deterministic claim, lease, stop, and retry fixtures | Live standing authority, workers, budgets, and production gates close it |
| 21 | Research specialists, S-10 | One-agent sourced baseline and synthetic evaluation | Delegated specialists, optional Brain, and paid models require configured paths and gates |
| 22 | Signed email intake, S-11 | Signed local mailbox fixtures that produce drafts only | Live mailbox connection, sender grants, and outbound actions remain separate gates |
| 23 | Installable application proof | Local artifact build and hostless installed smoke | Supported host and platform branches complete the release support matrix |
| 24 | Installed docs, guides, and UI help | Update each behavior document with its owning slice | Final guide audit covers every supported, skipped, unavailable, and recovery path |
| 25 | Public website | Local sync, link, build, and accurate maturity copy | Deployment, redirects, downloads, and public screenshots require release evidence |
| 26 | Real read-only service and OpenAPI | Local implemented service, catalog, errors, and rate-limit tests | Publication waits for the app artifact and site release gates |
| 27 | Release and real 100 percent scanner result | Prepare exact release and scan receipts without claiming success | Publishes only approved artifacts, then remediates the live checker to an actual 100 percent |
| 28 | Deferred legacy retirement | Inventory and per-item disposition proposal | Archive, rename, redirect, or deletion requires preservation, release proof, and exact approval |
| 29 | Review, integration, and portable handoff, S-07 | No-VCS patch review and portable handoff | Git or Jujutsu integration and Portal transfer follow selected capabilities |
| 30 | Deterministic heartbeat maintenance, S-12 | Direct no-model sweep with no-op, duplicate, and retry fixtures | Live scheduler, mailbox, Brain enrichment, and notifications remain optional or gated |
| 31 | Authentication discovery and scopes | Local metadata, scope, and negative-auth fixtures | Auth-service selection, account changes, and production enablement require approval |
| 32 | Hosted MCP | Local transport and tool-schema tests over ticket 26 operations | Hosted deployment, cancellation, limits, and truthful card close the parent |
| 33 | A2A service | Local task, auth, cancellation, and card fixtures | Production endpoint and discovery use ticket 31 scopes and approved deployment |
| 34 | Browser tools | Supported-browser registration, abort, fallback, and permission tests | Public registration waits for real ticket 26 operations and ticket 31 scopes |
| 35 | Web and DNS discovery | Headers, Markdown negotiation, cache variation, skills, and ARD local tests | Canonical domain, DNS, bot policy, redirects, and deployed checks require owner decisions |
| 36 | Pilot outcomes, S-13 | Metric schema and synthetic acceptance fixtures | Bounded user pilot measures completion, intervention, latency, recovery, usage, and cost |

## Acceptance rule

A baseline packet can supply evidence before every parent dependency finishes.
The parent stays open until its full done condition, dependency set, supported
feature paths, skip paths, failure paths, and behavior verification all pass.
