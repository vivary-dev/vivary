# Module catalog

These are 16 logical responsibilities, not 16 new deployable services. Current source entry points are listed where they exist. A documentation owner means the implementation remains planned. Preserve the existing Native and original Vivary owners when moving code.

The dependency list describes the target direction of capability calls, not issue scheduling. Read-only event projections can flow back to the UI. [Coverage](coverage.md) owns this specification's mapping to outcomes. Live GitHub issues own execution dependencies.

## M01: Workspace shell

One selected project conversation with optional panels.

Implementation status: the first workspace shell merged in [PR #42](https://github.com/vivary-dev/Vivary-New/pull/42) after independent review, CI and private hosted verification on 2026-09-14. This acceptance covers the first shell and integrated panels, not every issue #38 capability.

- Owns: Layout, focus, panel selection and visibility. Durable data stays with its owner.
- Calls: M02, M03, M05, M06, M09, M14.
- Replacement contract: Replace a renderer or panel without remounting an active conversation.
- Conceptual request/result: OpenProject / OpenPanel / ClosePanel / ResizePanel -> layout projection. No execution command is implied.
- Acceptance: Open a file during a running conversation, resize/close/reopen it, and confirm the same run, draft and approval remain.
- Actions: A001, A002, A003, A004, A005, A006, A007, A008, A009. See [the action catalog](actions.md#m01-workspace-shell).

Current source or design entry points:

- [packages/workbench/app/root.tsx](../../../../packages/workbench/app/root.tsx)
- [packages/workbench/app/components/layout/Layout.tsx](../../../../packages/workbench/app/components/layout/Layout.tsx)
- [packages/workbench/app/components/layout/Sidebar.tsx](../../../../packages/workbench/app/components/layout/Sidebar.tsx)
- [packages/workbench/app/components/workspace/Workspace.tsx](../../../../packages/workbench/app/components/workspace/Workspace.tsx)
- [packages/workbench/app/routes.ts](../../../../packages/workbench/app/routes.ts)
- Compatibility redirects: [agent.tsx](../../../../packages/workbench/app/routes/agent.tsx), [workbench.tsx](../../../../packages/workbench/app/routes/workbench.tsx), [files-redirect.tsx](../../../../packages/workbench/app/routes/files-redirect.tsx), and [chat.tsx](../../../../packages/workbench/app/routes/chat.tsx)

## M02: Projects and roots

Stable project identity and authorized folders.

- Owns: Project IDs, root bindings and revisions. A mutable path is not identity. A target-bound creator content plan is separate from a project grant or root binding.
- Calls: M05.
- Replacement contract: Replace a root or VCS observation adapter while preserving IDs and current grants.
- Conceptual request/result: RegisterRoot / ResolveProject / RebindRoot -> stable identity, revision and scoped capability result. Root observation is separate from adoption.
- Current recovery slice: Review connection checks one already-registered managed folder; explicit confirm rechecks its reviewed inputs before changing that project's binding. Project and conversation IDs survive loss of folder access. Cancel writes nothing; changed inputs require re-review. Reconnect changes no project files or agent state and accepts no arbitrary folder path. Old Code root metadata is provenance: continuing a saved conversation needs the same current canonical path, a new grant and current execution authorization. Native action approvals follow the runtime policy. A moved path refuses. Reconnect refuses during an active or awaiting-approval Code request.
- Verification: The bounded increment passed private hosted desktop/phone, cancel, reconnect, retained-history, fresh-approval/deny, refusal, file-hash and reload checks on 2026-09-15. That is the earlier tested candidate; the full issue #15 Create/apply goal remains open under issue #14's shared operation.
- Follow-up contract: The mounted UI keeps exact uncertain attempts through new reviews. A read-only preview can recover the original operation/hash from one current scoped receipt (`recorded: true`, `identityChanged: false`) and offer Finish reconnecting; a changed folder gets a fresh plan. One managed binding is eligible. Keyboard completion keeps focus/status stable; post-commit path change returns uncertain with the receipt intact.
- Follow-up evidence: Private hosted lost-response, recorded-preview, exact authenticated replay, desktop/390px keyboard and Cancel, reload, idle/model-zero and all 28 file hashes passed on 2026-09-15. Catalog refresh restored availability before Finish was clicked. External/multi-binding eligibility and post-commit path change passed nine real SQLite tests; a hosted rename returned EXDEV before files changed. Full #15 remains open. PR #43 is merged. Later Windows evidence belongs to the acceptance register.
- Acceptance: Register two no-VCS folders, switch away and back, remove one root, then retry without falling back to the other.
- Actions: A010, A011, A012, A013, A014, A015, A016, A017. See [the action catalog](actions.md#m02-projects-and-roots).

Current source or design entry points:

- [packages/workbench/server/project-services.mjs](../../../../packages/workbench/server/project-services.mjs)
- [packages/workbench/server/project-catalog.mjs](../../../../packages/workbench/server/project-catalog.mjs)
- [packages/workbench/app/lib/project-catalog-schema.ts](../../../../packages/workbench/app/lib/project-catalog-schema.ts)
- [packages/workbench/server/native-registry.mjs](../../../../packages/workbench/server/native-registry.mjs)
- [packages/workbench/server/root-provider.mjs](../../../../packages/workbench/server/root-provider.mjs)
- [packages/workbench/app/components/projects/ProjectContext.tsx](../../../../packages/workbench/app/components/projects/ProjectContext.tsx)
- [packages/workbench/app/components/projects/ProjectNavigation.tsx](../../../../packages/workbench/app/components/projects/ProjectNavigation.tsx)
- [packages/workbench/app/components/projects/ReconnectProjectForm.tsx](../../../../packages/workbench/app/components/projects/ReconnectProjectForm.tsx)
- [packages/workbench/server/managed-project-reconnection.mjs](../../../../packages/workbench/server/managed-project-reconnection.mjs)
- [packages/workbench/shared/managed-project-reconnection.ts](../../../../packages/workbench/shared/managed-project-reconnection.ts)
- [packages/workbench/actions/vivary-preview-managed-project-reconnection.ts](../../../../packages/workbench/actions/vivary-preview-managed-project-reconnection.ts)
- [packages/workbench/actions/vivary-confirm-managed-project-reconnection.ts](../../../../packages/workbench/actions/vivary-confirm-managed-project-reconnection.ts)

## M03: Conversations and continuity

Reopen several project conversations and link history across harnesses.

Implementation status: Code and Native conversations retain their existing owners in one workspace. Project-bound history and the maintained Native saved-head repair are integrated. Codex has native-session continuation, catalog-backed models, native action approvals, and persisted progress/subagent activity. The host admits one root run at a time. Linked cross-harness conversations and concurrent independent runs remain planned. The [acceptance register](../desktop-acceptance-status.md) separates real Windows execution, hosted fixtures, and remaining Native-provider work.

- Owns: References to Native threads, Code runs and harness sessions, plus proposed linkage metadata.
- Calls: M02, M04, M05.
- Replacement contract: Replace transcript presentation or add an adapter without rewriting retained history.
- Conceptual request/result: ListHistory / ReadHistory / LinkConversation -> opaque Native references and authorized event pages. Send and resume delegate to the selected Native owner.
- Acceptance: Reopen a Native thread and a Code conversation, then create a linked destination without copying events or granting execution.
- Actions: A018, A019, A020, A021, A022, A023, A024, A025, A026, A027, A028, A117, A118, A119, A120. See [the action catalog](actions.md#m03-conversations-and-continuity).

Current source or design entry points:

- [packages/workbench/app/components/workspace/CodeConversation.tsx](../../../../packages/workbench/app/components/workspace/CodeConversation.tsx)
- [packages/workbench/app/components/workspace/NativeConversation.tsx](../../../../packages/workbench/app/components/workspace/NativeConversation.tsx)
- [packages/workbench/app/components/layout/CodeHistory.tsx](../../../../packages/workbench/app/components/layout/CodeHistory.tsx)
- [packages/workbench/app/components/layout/ChatHistory.tsx](../../../../packages/workbench/app/components/layout/ChatHistory.tsx)
- [packages/workbench/app/lib/local-code-chat-adapter.ts](../../../../packages/workbench/app/lib/local-code-chat-adapter.ts)
- [packages/workbench/actions/vivary-code-state.ts](../../../../packages/workbench/actions/vivary-code-state.ts)
- [packages/workbench/server/local-code-agent.ts](../../../../packages/workbench/server/local-code-agent.ts)

Optional profile authoring remains with existing Native resource/settings or intentionally authored project files. This module retains only selection/reference and effective-context presentation. Profile instructions never grant deterministic tool permission.

## M04: Harness adapters

Discover observed availability for supported installed harnesses.

The selected harness owns its tools, MCP configuration, models and native permission semantics. Vivary displays only observed availability, preserves unknown states and does not add a second general tool picker.

- Owns: Capability and readiness observations. The selected harness owns its tools, MCP configuration, models and native permissions. Native owns sessions, events and opaque resume state.
- Calls: M02, M05, M14.
- Replacement contract: Add a registered adapter, model probe and compatibility evidence. No UI engine-name switch.
- Conceptual request/result: ListCatalog / ResolveChoice -> adapter identity, model observation and readiness. New native-harness sessions use the Native harness lifecycle. Preserved native-code sessions use the Code executor and controls. Dispatch by owner kind.
- Acceptance: Introduce a fake conforming adapter and an incompatible one. Only the supported catalog entry becomes selectable after readiness requirements pass.
- Actions: A029, A030, A031, A032, A033. See [the action catalog](actions.md#m04-harness-adapters).

Current source or design entry points:

- [packages/workbench/server/project-runtime-readiness.mjs](../../../../packages/workbench/server/project-runtime-readiness.mjs)
- [packages/workbench/server/local-runtime-setup.ts](../../../../packages/workbench/server/local-runtime-setup.ts)
- [packages/workbench/server/code-execution-host.ts](../../../../packages/workbench/server/code-execution-host.ts)
- [packages/workbench/server/code-execution-worker.ts](../../../../packages/workbench/server/code-execution-worker.ts)
- [packages/workbench/server/codex-models.ts](../../../../packages/workbench/server/codex-models.ts)
- [packages/workbench/server/codex-approval.ts](../../../../packages/workbench/server/codex-approval.ts)
- [packages/workbench/server/code-permissions.ts](../../../../packages/workbench/server/code-permissions.ts)
- [Maintained Core patch](../../../../packages/workbench/patches/README.md)

Codex account-effective model discovery and explicit refresh are implemented. The generic grouped harness catalog and linked cross-harness conversation behavior remain planned. See [implemented Codex behavior](harness-adapters.md#implemented-codex-behavior).

## M05: Authority and approvals

Make effects explicit, scoped and revocable.

- Owns: Actor/project grant validation, deterministic policy, and exact native action-request binding. The runtime retains originating approval state and lifecycle.
- Calls: no product module. Validates supplied identity and authoritative policy through existing framework/registry seams.
- Replacement contract: Adapters cannot widen permissions or turn unknown capability into approval. Harness-native permissions do not replace Vivary project and host authorization or its approval, denial and Stop controls.
- Conceptual request/result: ValidateScope / ApproveExactRequest / Deny / Stop -> policy decision or observed lifecycle result. Approval state stays with the originating Native owner. The facade delegates using its approval reference. Stop is an ownership-checked Native control.
- Acceptance: Deny one request, change an approved request, revoke a grant, and Stop an owned run after its folder disappears.
- Actions: A034, A035, A036, A037, A038, A039, A040. See [the action catalog](actions.md#m05-authority-and-approvals).

Current source or design entry points:

- [packages/workbench/server/code-project.ts](../../../../packages/workbench/server/code-project.ts)
- [packages/workbench/actions/vivary-code-approve.ts](../../../../packages/workbench/actions/vivary-code-approve.ts)
- [packages/workbench/actions/vivary-code-deny.ts](../../../../packages/workbench/actions/vivary-code-deny.ts)
- [packages/workbench/actions/vivary-code-stop.ts](../../../../packages/workbench/actions/vivary-code-stop.ts)
- [packages/workbench/server/local-code-agent.ts](../../../../packages/workbench/server/local-code-agent.ts)

## M06: Files and documents

Browse, read, edit, save and reconcile real files.

Implementation status: the verified workspace opens the existing file browser and document view as an optional panel. In the private hosted journey, a document opened in read mode, explicit Edit and Save wrote the file, the selected conversation draft remained intact, and a refresh reread the saved content. Delayed rename with the panel closed also passed the isolated production-composition checks. The acceptance register records later Windows file-operation proof.

- Owns: Project files own bytes. Existing draft state owns unsaved edits and base versions.
- Calls: M02, M05.
- Replacement contract: Replace the editor or Markdown renderer without replacing save/conflict rules.
- Conceptual request/result: ReadFile / SaveVersionedFile / RenameExclusive -> content/version or recoverable conflict. Never return success before the effect is established.
- Acceptance: Edit, reload, rename, externally modify and reconcile a file while preserving original bytes and scoped drafts.
- Actions: A041, A042, A043, A044, A045, A046, A047, A048, A049, A050. See [the action catalog](actions.md#m06-files-and-documents).

Current source or design entry points:

- [packages/workbench/app/components/projects/ProjectFiles.tsx](../../../../packages/workbench/app/components/projects/ProjectFiles.tsx)
- [packages/workbench/app/routes/files.tsx](../../../../packages/workbench/app/routes/files.tsx)
- [packages/workbench/server/project-files.ts](../../../../packages/workbench/server/project-files.ts)
- [packages/workbench/actions/vivary-project-files.ts](../../../../packages/workbench/actions/vivary-project-files.ts)
- [packages/workbench/actions/vivary-project-file-save.ts](../../../../packages/workbench/actions/vivary-project-file-save.ts)
- [packages/workbench/actions/vivary-project-file-rename.ts](../../../../packages/workbench/actions/vivary-project-file-rename.ts)
- [packages/workbench/app/lib/file-draft-state.ts](../../../../packages/workbench/app/lib/file-draft-state.ts)

## M07: Workspace operations

Create, adopt and run the original Vivary commands.

Vivary provides its original engine and narrow deterministic workspace operations. Explain whether a missing user capability is blocked by the harness, observed host state, authorization or an existing Vivary operation before proposing another tool.

The desktop bundles Python and the original Vivary commands. The standalone CLI retains all ten verbs. The application adapter provides previews and evaluations. The current private Windows candidate passed bundled-Python creation and the focused native journeys in the [acceptance register](../desktop-acceptance-status.md). Complete GUI/agent coverage of every original operation remains part of final product acceptance. [PR #44](https://github.com/vivary-dev/Vivary-New/pull/44) integrated the runtime package, and the [runtime receipt](../receipts/23a-bundled-original-runtime.md) preserves its earlier evidence and limits.

PR #47 merged the shared new-folder creator path into dev. Issue #14 remains open for existing-folder apply. `plan_thin_workspace` previews exact target-bound file content. `apply_thin_workspace` rechecks the accepted hash, target, and options before greenfield writes. Only an exact completed inventory qualifies for a no-write retry. The managed bridge and reviewed CLI use that same plan.

The earlier hosted candidate passed keyboard creation at 1440x900,
normal-size cancellation, and phone preview/Cancel controls at 390x844. That
viewport proof predates the PR #47 correction; the frontend output was
unchanged. The correction assigns rollback ownership per attempt, runs
read-only Doctor on exact retries, converts inspection errors to structured
refusals, and marks `--reviewed` in sanitized receipts.

The corrected bundled-Python and private hosted journeys matched five-file
CLI/bridge/Native plans, refused wrong hashes without writes, created exact
bytes, and repeated without changing files. Hosted Create selected the new
project, `STATE.md` displayed formatted content and Edit/Rename controls,
and the earlier conversation returned with panels closed and no model calls.
The repeated registration kept project, binding, and policy while its attempt
receipt advanced the registry revision. Six changed-inode saved folders
required explicit reviewed reconnection; all 33 fixture file bytes remained
unchanged. The cause of that host identity change is unknown. Existing-folder
apply remains open under issues #14/#15. The current private Windows candidate passed
managed creation and focused desktop execution. This does not complete populated-folder
adoption or the full original-operation GUI journey.

- Owns: Original workspace files, operation plans, policy results and receipts.
- Calls: M02, M05, M06.
- Replacement contract: Replace transport or packaging while retaining ten-verb behavior and receipt meanings.
- Conceptual request/result: PreviewOriginalOperation / ApplyApprovedOperation -> original result and receipt. The existing ten-verb contracts determine which operation writes.
- Acceptance: Compare the same authorized GUI/agent and bundled CLI operation against original command/receipt fixtures.
- Actions: A051, A052, A053, A054, A055, A056, A057, A058, A059, A060, A061, A062, A063, A064. See [the action catalog](actions.md#m07-workspace-operations).

Current source or design entry points:

- [packages/create-vivary](../../../../packages/create-vivary)
- [packages/create-vivary/create_vivary.py](../../../../packages/create-vivary/create_vivary.py)
- [packages/core](../../../../packages/core)
- [packages/tropo](../../../../packages/tropo)
- [packages/strato](../../../../packages/strato)
- [packages/ozone](../../../../packages/ozone)
- [packages/exo](../../../../packages/exo)
- [packages/vivary](../../../../packages/vivary)
- [packages/desktop/original-runtime.mjs](../../../../packages/desktop/original-runtime.mjs)
- [packages/desktop/build-original-wheels.py](../../../../packages/desktop/build-original-wheels.py)
- [packages/workbench/server/original-runtime.ts](../../../../packages/workbench/server/original-runtime.ts)
- [packages/workbench/server/original-runtime-location.mjs](../../../../packages/workbench/server/original-runtime-location.mjs)
- [packages/workbench/actions/vivary-original-command.ts](../../../../packages/workbench/actions/vivary-original-command.ts)
- [packages/workbench/server/managed_project_workspace.py](../../../../packages/workbench/server/managed_project_workspace.py)

## M08: Search and file memory

Find files, history and sourced project knowledge.

Implementation status: issue #21's scoped file memory is implemented and hosted-tested. Its [receipt](../receipts/18a-scoped-file-memory.md) records the hosted journey and one real Codex check. Each project fact is one Markdown file in `.vivary/knowledge/` or the folders the `memory` role names, and Tropo types it as `vivary_fact`. Code and Full chat load the project's instructions, state, and facts at the start of every message. The Details Memory section remembers, corrects, and forgets facts through their files. Packaged Windows acceptance is pending.

- Owns: Original files and Native history remain truth. Optional indexes are projections. Authored facts are project files, and `.vivary/memory/` holds only optional provider state.
- Calls: M02, M03, M05, M06, M07.
- Replacement contract: Replace an index or retrieval provider without losing source references or private exclusions.
- Conceptual request/result: Search / RetrieveScopedSources / CorrectMemory -> bounded matches and source references. Indexes never own the only copy.
- Acceptance: Search private and public fixture paths, cancel, correct a fact, rebuild an optional index and confirm no cross-project retrieval.
- Actions: A065, A066, A067, A068, A069, A070, A071. See [the action catalog](actions.md#m08-search-and-file-memory).

Current source or design entry points:

- [packages/workbench/server/project-files.ts](../../../../packages/workbench/server/project-files.ts)
- [packages/workbench/server/project-memory.ts](../../../../packages/workbench/server/project-memory.ts)
- [packages/workbench/app/lib/project-memory-schema.ts](../../../../packages/workbench/app/lib/project-memory-schema.ts)
- [packages/workbench/actions/vivary-project-memory.ts](../../../../packages/workbench/actions/vivary-project-memory.ts)
- [packages/workbench/actions/vivary-project-memory-write.ts](../../../../packages/workbench/actions/vivary-project-memory-write.ts)
- [packages/workbench/app/components/projects/ProjectMemoryPanel.tsx](../../../../packages/workbench/app/components/projects/ProjectMemoryPanel.tsx)
- [packages/workbench/actions/vivary-code-state.ts](../../../../packages/workbench/actions/vivary-code-state.ts)
- [packages/tropo](../../../../packages/tropo)

## M09: Plans and task sources

Inspect plans, dependencies and approved work.

- Owns: Selected task source owns tasks. Native/local plan owner retains revisions and feedback. The creator's target-bound file-content plan governs one workspace effect; it does not become the task or project plan owner.
- Calls: M02, M05, M06.
- Replacement contract: Swap tracker or plan view while preserving external IDs and exact revision binding.
- Conceptual request/result: ReadPlan / ProposeRevision / WriteTaskSource -> authoritative plan/task refs. Coordination binds exact revisions to existing approval and run refs.
- Acceptance: Change a plan or task revision after approval. Dispatch must refuse stale work. Board projection must agree with its source.
- Actions: A072, A073, A074, A075, A076, A077. See [the action catalog](actions.md#m09-plans-and-task-sources).

Current source or design entry points:

- [docs/product/multi-project/native-owners.md](../../../../docs/product/multi-project/native-owners.md)

## M10: Workers and review

Run bounded work, verify candidates and prepare handoffs.

- Owns: Native owns task/run lifecycle. Vivary owns workflow acceptance and candidate references.
- Calls: M02, M03, M04, M05, M06, M09, M11.
- Replacement contract: Replace worker strategy without treating a model response as verified completion.
- Conceptual request/result: DispatchBoundWork / ReviewCandidate / PrepareHandoff -> Native run refs and separate acceptance evidence. No new worker event store.
- Acceptance: Complete a model turn with failing checks. The candidate remains unaccepted. Rework and handoff preserve original evidence.
- Actions: A078, A079, A080, A081, A082, A083, A084. See [the action catalog](actions.md#m10-workers-and-review).

Current source or design entry points:

- [packages/workbench/server/local-code-agent.ts](../../../../packages/workbench/server/local-code-agent.ts)
- [packages/workbench/server/project-runtime-activity.mjs](../../../../packages/workbench/server/project-runtime-activity.mjs)
- [packages/workbench/server/code-execution-host.ts](../../../../packages/workbench/server/code-execution-host.ts)

## M11: Version control and hosts

Observe checkouts and integrate reviewed changes.

- Owns: VCS and selected repository/task hosts own their records. No-VCS folders remain supported.
- Calls: M02, M05.
- Replacement contract: Change VCS or host adapter independently from project, harness and task-source choice.
- Conceptual request/result: ObserveCheckout / PreviewIntegration / ApplyIntegration -> VCS-specific result. A no-VCS path uses file versions and conflict-aware changes.
- Acceptance: Exercise no-VCS and supported VCS paths. Change the target after preview and ensure integration conflicts rather than overwrites.
- Actions: A085, A086, A087, A088, A089. See [the action catalog](actions.md#m11-version-control-and-hosts).

Current source or design entry points:

- [packages/workbench/server/local-root-provider.mjs](../../../../packages/workbench/server/local-root-provider.mjs)
- [packages/workbench/server/root-provider.mjs](../../../../packages/workbench/server/root-provider.mjs)
- [packages/core](../../../../packages/core)

## M12: Research and learning

Develop sourced work and review lessons.

- Owns: Authored findings and learning proposals retain sources and scope. Models handle interpretation.
- Calls: M03, M05, M06, M08, M09, M10.
- Replacement contract: Replace research strategies or Brain connection without making them mandatory.
- Conceptual request/result: RequestResearch / ProposeLearning / ReviewLearning -> agent-produced artifacts and explicit evidence. Deterministic actions govern persistence.
- Acceptance: Produce sourced research with Brain disabled and reject a lesson. No skill or shared knowledge changes as a side effect.
- Actions: A090, A091, A092, A093, A094. See [the action catalog](actions.md#m12-research-and-learning).

Current source or design entry points:

- [docs/product/multi-project/native-owners.md](../../../../docs/product/multi-project/native-owners.md)

## M13: Intake and automation

Route inputs and perform bounded scheduled work.

- Owns: Native owns scheduling and messaging. Vivary owns routing, deduplication and bounded policies.
- Calls: M02, M03, M05, M09, M10, M12.
- Replacement contract: Swap configured intake/scheduler adapters. New schedules and outbound effects need authority.
- Conceptual request/result: VerifyIntake / RouteDraft / PrefilterSchedule -> Native messaging/automation refs and explicit work decisions. No new scheduler.
- Acceptance: Deliver duplicate signed input and unchanged heartbeat. No duplicate draft, model call or external effect occurs.
- Actions: A095, A096, A097, A098, A099, A100, A101. See [the action catalog](actions.md#m13-intake-and-automation).

Current source or design entry points:

- [docs/product/multi-project/native-owners.md](../../../../docs/product/multi-project/native-owners.md)

## M14: Host and desktop

Run locally or connect to an authenticated private instance.

- Owns: The host owns files, credentials and processes. Clients own presentation.
- Calls: M02, M05, M06.
- Replacement contract: Upgrade the packaged runtime or client independently with versioned compatibility checks.
- Conceptual request/result: StartLocalHost / ConnectClient / OpenPreview -> host/client capability and connection result. Client closure is not a run-state transition.
- Acceptance: Test actual local Windows folders after hosted checks, reconnect browser, revoke access and verify process/draft behavior.
- Actions: A102, A103, A104, A105, A106, A107. See [the action catalog](actions.md#m14-host-and-desktop).

Current source or design entry points:

- [packages/workbench/bin/start.mjs](../../../../packages/workbench/bin/start.mjs)
- [packages/workbench/bin/serve-preview.sh](../../../../packages/workbench/bin/serve-preview.sh)
- [packages/desktop](../../../../packages/desktop)

## M15: Distribution and discovery

Publish truthful artifacts and supported protocols.

Workspace templates remain an offline baseline. A later optional community collection can use the existing vivary-site to point at source GitHub repositories and downloads. Show a preview before apply. A download remains inert until a separately authorized operation applies it. This is not a marketplace or a separate template site.

- Owns: Release manifests and implemented protocol contracts. Website is a separate repository.
- Calls: M05, M07, M14, M16.
- Replacement contract: Add a transport over implemented actions without adding bypass permissions or publishing placeholders.
- Conceptual request/result: PrepareArtifact / ProjectProtocol / PublishApprovedArtifact -> exact artifact or operation refs with explicit publication outcome.
- Acceptance: Build and inspect exact distributable, then exercise implemented protocol errors and real release gates before publication.
- Actions: A108, A109, A110, A111, A112. See [the action catalog](actions.md#m15-distribution-and-discovery).

Current source or design entry points:

- [docs/RELEASE-WORKFLOW.md](../../../../docs/RELEASE-WORKFLOW.md)
- [docs/ORIGINAL-CLI.md](../../../../docs/ORIGINAL-CLI.md)

## M16: Evidence and contributor help

Make behavior, limits and implementation context inspectable.

- Owns: Source-linked evidence, usage observations, documentation and acceptance records.
- Calls: M02, M03, M05, M06, M07, M10.
- Replacement contract: Replace visual reports while preserving actual results and unknown measurements.
- Conceptual request/result: ReadEvidence / OpenHelp / RecordAcceptance -> source-linked observations and narrow next-context routes. Reports cannot create verification facts.
- Acceptance: Inspect missing usage, a failed check and an old receipt. All remain honest and linked to their actual source.
- Actions: A113, A114, A115, A116. See [the action catalog](actions.md#m16-evidence-and-contributor-help).

Current source or design entry points:

- [docs/product/multi-project](../../../../docs/product/multi-project)
- [packages/workbench/tests](../../../../packages/workbench/tests)

## Contract rules for replacing a module

1. Preserve its public identity and source ownership. Do not copy data into a replacement store merely to fit a component API.
2. Describe supported inputs, outputs, capabilities, versions, cancellation and error codes before implementation. Keep framework types at the owning boundary.
3. Reuse current operation actions. UI and agent tools must reach the same deterministic behavior and authorization.
4. Run the module's acceptance scenario and its direct callers' affected journey. A substitute is compatible only for the tested capability matrix.
5. Keep installed version, migration requirements and rollback limits visible. Do not hot-swap an active session's process or opaque resume state.
6. If an existing public seam cannot preserve a required invariant, propose a small upstream/shared seam. Do not edit node_modules or create a parallel framework.

The root/authority relationship uses the existing registry rather than two mutually authoritative stores. M05 evaluates current grants and exact requests. M02 supplies stable project/root identities. Permission and reference checks happen at the operation boundary, including reads of retained history.
