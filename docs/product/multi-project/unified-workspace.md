# Unified project workspace

[Issue #38](https://github.com/vivary-dev/Vivary-New/issues/38) owns acceptance and lifecycle. The [research report](research/agent-workspace-ergonomics.md) supplies evidence and limitations. Jeff selected this direction on 2026-09-14 after inspecting the private application. He then accepted guide snapshot `e86d06ed592a2d3c` through his submitted product-conversation review. This is the target interaction contract. The first unified shell merged in [PR #42](https://github.com/vivary-dev/Vivary-New/pull/42).

## Product decisions

One project workspace replaces Agent, Files, Workbench and Full chat as peer destinations. Projects and their conversations organize the left navigation. Each project can hold multiple independent conversations. The main area shows one selected conversation, its activity and one composer at a time. This central selection does not limit the project to one chat or give one conversation unlimited model context. A compact context view shows the project and execution environment. Large file or tool surfaces do not open automatically when a project is selected.

Jeff explicitly clarified this requirement on 2026-09-14 in the product conversation. A user can start another chat when a conversation reaches its context limit or when separate work needs separate history. Conversations may eventually run concurrently within one project. That settled intent needs no further design vote.

Vivary is a visual workspace over supported user-selected harnesses. A conversation runtime is either a coding harness session or an existing Native agent thread. The grouped harness picker governs new coding conversations; it does not convert or relabel preserved Native history. Agent profiles are optional user-authored resources. The application must not require choosing a predefined researcher, planner or coder persona. Planning, documentation, research and creative artifacts belong alongside code in the same project.

The harness control groups choices by harness name, such as Claude Code, Codex and OpenCode, with appropriately sized brand marks and accessible text. The selected supported installed harness owns its tools, MCP configuration, models and native permission semantics. Vivary shows actual observed availability from the selected execution host, keeps unknown states unknown and does not add a second general tool picker. A cross-harness selection starts a linked conversation without a handoff wizard. Preparing and maintaining a handoff is a separate agent workflow.

## Workspace composition

Default desktop state:

```text
Projects / conversations | Project > Conversation        Details  Files  Changes
                        | Host and folder / branch when present
Project A               |------------------------------------------------------
  Conversation 1        | Conversation and recorded activity
  Conversation 2        |
Project B               |
                        | Context attachments
New conversation        | Composer
                        | Harness / model picker                         Send
```

Jeff accepted **Header first** on 2026-09-14 through his submitted review of guide snapshot `e86d06ed592a2d3c`. Project details start closed on a wide desktop. The conversation header keeps project identity, activity, urgent recovery, approval, and Stop visible. The full project details panel opens on request, remains closable, and never selects a file on the user's behalf. Remember the preference separately on each client. On narrow screens, panels also start closed.

Requested file state:

```text
Projects / conversations | Same conversation           | README.md       Close
                        | Same scroll position        | Files / document tabs
                        | Same active run              | Formatted document
                        | Same unsent draft            | Edit / Save / Rename
                        | Composer remains reachable   | Maximize / restore
```

Files opens a contextual browser, then a selected file opens in reading mode. Edit explicitly changes to source editing. Save and Rename reuse the existing project actions. A document can maximize for sustained work and restore without navigating to another application. Reading does not automatically attach a file to the model. Add to conversation is explicit and names the file in the composer context.

Other surfaces use the same open/close/activate contract. Plans and documents are editable project resources. Changes presents actual changes, and Preview presents a supported running project. A terminal may use a bottom drawer when the supported Native integration exists. Do not expose a nonfunctional terminal or debugging button to imply those integrations are complete. Context-sensitive unavailability explains a concrete missing prerequisite.

Settings remains accessible as a secondary utility. Removing the four competing destinations does not mean every configuration page must render inside the transcript.

## Panel interaction contract

Use the installed Toolkit resizable components. Proposed desktop starting dimensions are 240 px for project navigation and 260 px for project details after the user opens them. A requested document starts wider, but preserves at least a usable 360 px conversation region. These are initial test values, not fixed product requirements or research-derived optima.

- Both sidebars resize with pointer and keyboard controls. Every open panel has a visible Close control and an obvious reopening control.
- Closing a panel never ends a run, sends a message, discards a draft or forgets a selected resource. Maximize is reversible.
- Remember safe layout preferences per client. Opening a phone must not overwrite the desktop's preferred widths. Clamp restored widths to the actual available space.
- Restore focus to the opener when a panel closes. Resizing must not steal editor or composer content. Escape closes an appropriate transient overlay, not the current run.
- Collapse panels before compressing the conversation below its usable minimum. At 390 px, show one focused primary surface with navigation and tools available on request. Returning to the conversation preserves scroll and draft.
- Active work, pending approval and Stop remain discoverable with either sidebar closed. Completed and denied work move to history rather than permanent global banners.

The [W3C splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) informs keyboard and accessibility behavior; validate the actual component and its caveats. Do not treat a splitter role or a passing typecheck as accessibility proof.

## Harness choice and observed availability

The control presents a grouped list. Group headings identify the harness, use a small reviewed logo or a neutral fallback, and expose readiness when it affects selection. Rows show models actually observed through that harness. Different registered instances remain distinguishable by a short account/endpoint label when needed, without exposing credentials. The selected harness owns its tools, MCP configuration, models and native permission semantics. Vivary does not provide a second general tool picker.

The server catalog must distinguish registered, installed, authenticated, supported and ready. Reuse the runtime registry and documented harness APIs. A package being installed is not proof that its CLI can launch, its account is authenticated or its model list is current. Unknown model, tool, MCP or permission availability stays unknown. Refresh after installation/login/configuration changes and make a manual refresh available.

Vivary retains project and host authorization plus approval, denial and Stop for the exact request. It provides its original engine and narrow deterministic workspace operations. When a user capability is missing, explain whether the boundary is the harness, observed host state, authorization or an existing Vivary operation before proposing another tool.

Same-harness selection changes the model in the existing conversation only when the harness supports that operation. A cross-harness selection creates a new conversation under the same project and links the exact recorded source history through its last completed event. The original remains accessible. Preserve the unsent draft without silently submitting it. A failed switch leaves the original selection and draft usable with Retry.

An active or approval-pending run is not transferred by selecting another model. Existing approval remains tied to its original request, harness, project, and runtime. A new linked conversation may open without granting execution permission. Before a conflicting write can start, the workspace must show the existing run and control access to shared files. Potentially concurrent conversations require visible per-thread activity and approvals plus shared-file conflict handling. The current runtime permits one active run at a time. Treat that as an explicit implementation limitation, not the final product model. Switching and approval are distinct actions.

Three facts must be visible on demand: recorded history available, context supplied for this turn, and harness-native session continuity. These are not interchangeable. Paginated read tools retrieve exact existing messages and artifact references. Do not copy transcripts into another app-state store, replay raw tool calls as new commands, or share opaque resume state between harnesses. If full context exceeds capacity or an event type cannot be translated, describe what is omitted or summarized and retain access to the original.

## Prepare handoff

This action submits a named workflow to the existing agent conversation. It does not happen automatically just because the user picks another harness. The agent reviews the actual project and updates the designated existing handoff/documentation surface. Deterministic actions gather facts, check scope and versions, validate required fields, and write through existing conflict-aware file owners.

Proposed handoff fields: goal, current source/file versions, decisions, changes, checks with actual outcomes, unfinished work, risks, linked source conversation/event boundary, and the next concrete action. A dirty working tree is a legitimate reported state. No automatic clean, discard, commit, merge or deletion is part of preparing a handoff.

Freshness is explicit. A reviewed handoff records the project version and completed-event boundary it covers. Later changes can mark it Out of date deterministically. Jeff accepted **Manual by default** on 2026-09-14 through his submitted review of guide snapshot `e86d06ed592a2d3c`. The agent updates the narrative when the user requests it, and the work follows normal authorization. A failed update retains the previous readable version and shows Retry. It does not report a fresh handoff. A future project may propose named completion checkpoints through a separate explicit opt-in.

## Template distribution

Templates start as an offline baseline. A later optional community collection can use the existing vivary-site to point at source GitHub repositories and downloads. Show a preview before apply. A download remains inert until a separately authorized operation applies it. This is not a marketplace or a separate template site.

## Unavailable folders and activity

Missing local folder and revoked access are different states. A missing folder leaves authorized conversation history readable, retains drafts and offers Locate folder or Retry. File-dependent execution is disabled. Revoked authorization must continue to protect transcript and file content. Neither case silently selects another project.

Show one scoped recovery message in the workspace, with the actual selected project identified. Keep the navigation and conversation frame. A denied request is an outcome in its conversation history. A compact activity control can lead back to other ongoing work; it must not cover unrelated work with a stale terminal outcome.

## Existing implementation owners

Implementation status: the first shell merged in [PR #42](https://github.com/vivary-dev/Vivary-New/pull/42) after independent review, CI, and private hosted verification. [PR #43](https://github.com/vivary-dev/Vivary-New/pull/43) adds project-bound Native conversations and shared project history. The PR owns its final acceptance and merge status. Its [Native persistence and composer blockers](receipts/04a-project-chat-sessions.md) keep it in draft. This status covers the shell and integrated project, conversation, details, and file journeys. It does not complete the supported harness catalog, cross-harness linking, handoff workflow, concurrent runtime, model execution, or Windows proof. Paths are relative to `packages/workbench`.

| Owner | Reuse and change boundary |
| --- | --- |
| `app/root.tsx`, `app/components/layout/Layout.tsx` | Preserve Native, query, appearance, project, and file-draft providers. `Layout` now mounts the canonical `Workspace` below those owners while settings keep their separate utility view. |
| `app/components/workspace/Workspace.tsx` | Own the selected conversation area, header-first Details control, optional Files, Preview, and Search panels, responsive single-surface behavior, and panel focus/width preferences. |
| `app/components/projects/ProjectSearch.tsx`, `app/lib/project-search-state.ts`, `app/lib/project-file-location.ts` | Scoped filename, text, and regex search inside the optional Search panel; results open the file at a line. The reducer owns request staleness; file locations are URL state with one href owner. |
| `actions/vivary-project-search.ts`, `server/project-search.ts`, `app/lib/project-search-schema.ts` | Bounded, read-only project search that reuses the project file boundary, skip, and secret rules. No index, shell, or bundled binary; limits and a continuation cursor replace streaming. |
| `app/components/workspace/CodeConversation.tsx` | Compose existing Code history, selected run, approval, Stop, model control, and draft behavior in the canonical workspace. The current runtime still permits one active run. |
| `app/components/workspace/NativeConversation.tsx` | Compose Native `AgentChatSurface` with server-derived actor/organization/project scope and thread URL synchronization. Legacy v1 chats use their unchanged identity under Unassigned. |
| `app/components/projects/ProjectFiles.tsx`, `app/routes/files.tsx` | Open the real project file browser and document view inside the optional panel. Documents remain read-first. Edit, Save, Rename, conflict recovery, and drafts retain their existing owners. |
| `app/routes.ts`, `app/routes/agent.tsx`, `app/routes/workbench.tsx`, `app/routes/files-redirect.tsx`, `app/routes/chat.tsx` | Make `/` canonical. Preserve old entry URLs as compatibility redirects. `/files` opens the Files panel and `/chat` selects the unassigned Native conversation view. |
| `app/components/layout/Sidebar.tsx` | Show projects, a shared Code/Native project conversation list, unassigned legacy chats, settings, and search. |
| `app/components/projects/ProjectContext.tsx` | Keep the existing project selection owner. Separate unavailable-folder execution state from authorized history visibility. |
| `app/components/layout/ProjectHistory.tsx`, `CodeHistory.tsx` | Compose authorized Native thread and Code run references with runtime labels. Code history remains available if Native identity loading fails. |
| `actions/vivary-chat-identity.ts`, `server/chat-identity.ts`, `server/native-chat-project.ts` | Derive stable actor/organization/project identity, preserve legacy scope, and revalidate project access before Native sends. Native owns threads and messages; no second transcript store is added. |
| `actions/vivary-code-state.ts`, `server/code-project.ts` | Separate authenticated project metadata and history reads from live folder resolution. Keep owner, organization, and current project-grant checks on reads. File access and execution still require an available authorized root. |
| `server/project-runtime-readiness.mjs`, `server/project-services.mjs` | Extend the existing project-scoped readiness owner with supported adapter model discovery. Preserve binding and policy revision checks. Installation, authentication, authorization, and runnable state remain distinct. |
| `server/local-code-agent.ts` | Retain Native as the transcript, run, and session owner. Future catalog and linked-conversation work must consume the existing readiness and history owners instead of adding competing services. |
| Toolkit public UI exports | Compose `ResizablePanelGroup`, `ResizablePanel`, and `ResizableHandle`; do not add another panel library. |

The installed Native registry includes harness registration and package detection primitives. Those are discovery seams, not proof of model enumeration or runnable account state. Confirm each adapter's documented model and session interfaces before wiring the catalog. Existing Native agent resources can hold optional profiles. Their instructions are not a substitute for deterministic action permissions.

## First shell acceptance evidence, 2026-09-14

The current branch candidate was built, refreshed to the existing private hosted preview while idle, and exercised through the actual interface.

- The reviewer created a project through the preview/create flow. Details and Files started closed, as accepted.
- A project file opened in read mode. **Edit** and **Save** wrote the file, the selected conversation draft remained intact, and refresh reread the saved content.
- Two real conversation requests were created and denied before any model or tool execution. The first conversation reopened from history. Authorized history remained readable for an unavailable project, and returning to the original project restored the selected conversation.
- The Details panel opened, resized from the keyboard, and closed. The isolated production-composition acceptance passed eight groups, including pointer and keyboard resize, maximize, delayed rename after panel closure, catalog `503` recovery with identity and path retained, 800 px and 390 px viewports, navigation return, and project-scoped conversation restoration. No JavaScript errors were observed.

The `files-desktop`, `files-phone`, and `workspace-desktop` images received visual inspection. The final source reviewer approved the code. TypeScript checks and the production build passed. The affected suite passed 82 of 82 tests across local access, Native state and actions, the code agent and its approval, restart, and lifecycle behavior, managed projects, project files and drafts, and the local root provider. The final private preview was idle with no pending approval. This evidence proves the first hosted shell slice on the tested candidate. It does not prove CI, merge, model execution, Windows behavior, the supported harness catalog, cross-harness linking, the handoff workflow, or concurrent runtime execution.

## Implementation sequence

1. Maintain the verified first shell composition using existing conversations, files, project state, and approvals. Keep `/` canonical and preserve `/agent`, `/files`, `/workbench`, and `/chat` as compatibility redirects. Opening a panel must not remount the selected conversation or create another session.
2. Finish project/session binding under #6, including authorized legacy Native history and non-code conversations. Establish durable links without merging transcript stores.
3. Implement the supported harness/model catalog and one-selection linked-conversation behavior. Verify exact-history access, context disclosure, failed switching and same-harness compatibility separately.
4. Add the explicit handoff workflow and freshness checks over existing files and Native history references. Connect #9 restart/drafts and #21 scoped memory where they own the behavior.
5. Complete surface integrations under their owners: #13 search, #31 supported preview/debugging, #30 responsive browser use, then #8 Windows GUI acceptance using the runtime delivered under #7. Do not wait for every future surface before testing the coherent shell.

Each implementation unit gets focused checks and affected real hosted verification. Use independent review when its risk or complexity warrants it. Each PR still requires applicable CI and an independent approval under CONTRIBUTING.md before sequential merge. Refresh the private preview for completed application changes. No public release or main promotion follows from this design. Research does not close #38 or reopen completed #12 backend work merely to rename its acceptance.

## Acceptance journeys

| Journey | Required result |
| --- | --- |
| Open an existing project | One workspace appears; metadata is compact and no file opens automatically. |
| Open a previous conversation | Existing history, harness identity and unsent draft remain intact. No duplicate session. |
| Start another conversation in the same project | The new chat has separate history, bounded context and draft state. The earlier conversation remains available. |
| Inspect potentially concurrent work | Each thread has visible activity and approvals. Conflicting edits to shared files are controlled. Until concurrency lands, the interface states that only one run can be active. |
| Open a file, edit, close and reopen | Formatted read view first; explicit edits and recoverable draft survive. Composer and run are unchanged. |
| Resize and close panels | Pointer and keyboard work; focus returns; minimum chat space and remembered widths remain usable. |
| Use a 390 px viewport and 200% zoom | Navigation, composer, context, approval and Stop remain reachable without crushed columns. |
| Make a folder unavailable | Authorized history remains readable; one recovery path; no fallback or lost draft. Revocation still denies access. |
| Select another harness | One linked conversation in the same project; exact source history accessible; no automatic send, persona or full handoff wizard. |
| Select an unavailable model | Accurate readiness state and supported recovery; no invented capability or silent fallback. |
| Prepare handoff, then change files | Existing designated document updates with actual evidence; later changes mark it stale; failure retains previous content. |
| Close all panels during work | Active work and Stop remain visible; no hidden execution or lost approval. |
| Use a non-Git writing/research project | Plans and documents work normally; Git-specific controls explain absence only when relevant. Project details offers an on-demand health check that shows the same result as `vivary doctor --json`: redundant or unknown frontmatter stays a warning, a missing required field or a broken link is an error, and no Git or npm fact appears for a folder without a repository or a package manifest. |

The first shell and integrated file, conversation, project-recovery, and panel journeys passed on the tested private hosted candidate and merged in PR #42. The acceptance evidence above defines that scope. No model ran, and no Windows artifact was tested. The supported harness catalog, cross-harness linking, handoff workflow, and concurrent runtime remain incomplete.
