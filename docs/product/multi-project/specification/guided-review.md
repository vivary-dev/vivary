# A guided design review

This maintained offline guide helps contributors understand the accepted Vivary experience and review later design proposals. It presents the owned specification in smaller pieces, with the full contracts in the same HTML document. The guide does not host the product or create product authority.

## Start with a real task

Imagine returning to a project tomorrow. You choose the conversation you want, see where that work stopped, inspect a file, and ask the agent to continue. You can start another chat when the current context is full or the work deserves a separate thread. Vivary keeps those conversations and files in one project workspace.

You do not need to understand every internal module before reviewing that experience. Start with the walkthrough. Decide whether the proposed flow matches how you want to work. Then inspect one module or source document when a detail matters.

## What you have already decided

- One project workspace replaces the competing Agent, Files, Workbench and Full chat destinations.
- Each project can hold multiple independent conversations. The center shows one selected conversation at a time.
- Each conversation has bounded model context. Starting another chat provides a separate context rather than extending the old one without limit.
- Projects and their conversations organize navigation.
- Files open only when requested, with formatted reading and explicit editing/saving.
- Panels resize, close and reopen without losing work.
- The selected supported installed harness owns its tools, MCP configuration, models and native permission semantics. Vivary displays observed availability and keeps unknown states unknown. It does not add a second general tool picker.
- Vivary keeps project and host authorization plus approval, denial and Stop for each exact request.
- Switching harnesses creates a linked conversation and preserves access to exact recorded source history. It does not automatically send a message.
- Preparing a handoff is a separate agent workflow.
- Agent profiles are optional and user-authored.
- Background work, approvals, denial and Stop must remain visible and understandable.
- A local desktop instance uses that computer's projects. A remote browser connects to the explicitly selected, authenticated host.
- Project details start closed on a wide desktop. The header keeps essential project state and controls visible.
- Handoff narratives update when the user requests them. A stale indicator can update without a model call.
- Vivary provides its original engine and narrow deterministic workspace operations. Explain the capability or permission boundary before proposing another tool.
- Templates start offline. A later optional community collection can use the existing vivary-site to link to source GitHub repositories and downloads, with preview before apply and no implied execution.

These decisions do not need another vote. The workspace, file/panel journeys, project-bound history, and focused private Windows candidate are implemented and tested within the boundaries in the [acceptance register](../desktop-acceptance-status.md). Codex selection and bounded native execution are integrated with recorded Windows acceptance. The generic harness catalog, real Native-provider turns, automation execution, linked conversations, handoff workflow, concurrency, and complete release journey remain incomplete. See the [implementation checkpoint](README.md#implementation-checkpoint-2026-09-16) before treating a walkthrough as available behavior.

## Accepted review record

Jeff accepted guide snapshot `e86d06ed592a2d3c` on 2026-09-14 through his submitted product-conversation review. He chose **Header first** for wide desktop project details and **Manual by default** for handoff updates. He submitted no additional notes. This explicit product-owner review authorizes implementation planning under the live issue. It does not merge code, update GitHub, or publish the product.

### Accepted clarification: several conversations and potential concurrency

Later on 2026-09-14, Jeff explicitly clarified that one central conversation does not mean one total conversation for a project. Projects must allow multiple chats with independent history and context. Several threads may eventually run at the same time.

This intent is settled and needs no additional design vote. The workspace must show activity and approvals for each thread and protect shared files from conflicting writes. The current runtime still permits one active root conversation run at a time, so concurrent execution remains an implementation gap. The product must show that limit accurately until runtime support changes.

### Accepted clarification: harness capabilities and permission boundaries

Later on 2026-09-14, Jeff explicitly clarified that the selected supported installed harness owns its tools, MCP configuration, models and native permission semantics. Vivary discovers and displays actual observed availability, keeps unknown states unknown and does not add a second general tool picker.

Vivary still owns project and host authorization plus approval, denial and Stop for each exact request. Its original engine and narrow deterministic workspace operations remain available. When a user capability is missing, the product must explain whether the boundary is the harness, observed host state, authorization or an existing Vivary operation before proposing another tool.

### Accepted clarification: template distribution

Later on 2026-09-14, Jeff explicitly clarified that templates start as an offline baseline. A later optional community collection can use the existing vivary-site to point at source GitHub repositories and downloads. The user previews a template before applying it. A download stays inert until a separately authorized operation applies it. This does not create a marketplace or a separate template site.

These clarifications are settled requirements and need no additional design vote.

### D1: Project details on a wide desktop

**Accepted choice and recommendation: header first.** Show the project name, host/root state, selected harness/model, and activity in the conversation header. Keep the details panel closed until requested. Remember the layout choice separately on each client.

Options considered:

- **Header first.** The conversation gets more room. Opening the full project details takes one action.
- **Compact details panel open.** Supporting information appears immediately and uses horizontal space. The panel remains closable and never opens a file automatically.

Implementation impact: the first workspace slice starts with the project details panel closed on wide desktop. Missing-folder recovery, pending approval, and Stop remain visible in the header. On phones, panels also start closed. Exact widths and breakpoints remain adjustable engineering defaults.

### D2: Handoff-update timing

**Accepted choice and recommendation: manual by default, with a stale indicator.** Code marks the record out of date when its covered work changes. The agent updates the narrative when the user requests it.

Options considered:

- **Manual by default.** The user requests each narrative update. The stale indicator changes without a model call.
- **Optional named checkpoints.** A project explicitly opts into updates at stated checkpoints within an authorized workflow.

Implementation impact: handoff freshness detection stays deterministic. Narrative updates do not run in the background by default. A later project-specific checkpoint proposal must show its behavior and preserve the applicable approval policy.

## Future design proposals

Keep this guide with the specification as contributors test and build Vivary. The multiple-conversation requirement is settled, so implementation details should not reopen it as a vote. A proposed revision is useful only when a real user-facing choice remains. It must explain the observed problem, list the available options, state each consequence, describe the implementation impact, and recommend one choice. Keep the recorded acceptance intact until Jeff explicitly accepts a later proposal.

The HTML can store draft proposal notes and unchanged option definitions in the browser. Those drafts have no authority. Copy a prepared proposal into the product conversation, then update the owning specification and live issue only after the explicit decision.

## Decisions the engineer should handle

Component composition, exact panel sizes, accessible keyboard behavior, adapter-version checks, draft storage boundaries and meaningful regression checks belong to implementation. Explain a tradeoff when it changes what Jeff can do or puts his work at risk. Do not ask him to select an internal library merely to make progress.

The existing release and later-scope split remains intact. Full kanban, factory workflows, research specialists, email intake and heartbeat are retained later capabilities. Ordinary plan and writing documents can still use the file surface. Reviewing this guide does not reopen the milestone or approve publishing.

## Principles in everyday language

### Keep the project identity steady

A project is more than its folder path. A folder can move while the project's conversations and decisions still belong together. File operations need a valid authorized folder. Reading retained history still needs authorization, even when the folder is missing.

### Give each kind of information one owner

A file owns its saved text. A draft holds unsaved edits. Native's appropriate thread, Code or harness owner keeps its conversation and run records. A panel displays information without taking ownership of it. This is what lets us replace the editor without rebuilding history or permissions.

### Separate a request from permission and completion

An agent can propose work. Approval authorizes the stated request. Execution performs it. Verification checks the result. These are different events. A confident response is not proof that a file changed correctly.

### Make replacement happen at a clear boundary

A harness is the installed agent tool, such as Claude Code. It owns its tools, MCP configuration, models and native permission semantics. An adapter connects a supported harness to the existing lifecycle and reports what Vivary can actually observe. A new CLI needs that integration and compatibility evidence. Unknown stays unknown. Harness-native permissions do not replace Vivary project and host authorization or its approval, denial and Stop controls.

### Keep history, context and resume distinct

History is the record of one conversation. Context is the material actually supplied to a model for one turn. Each conversation has its own bounded context and can reach a model limit. Starting another project conversation creates a separate context without deleting the old history. Native resume continues a supported harness session using its own state. Linking history does not guarantee that another model receives all of it.

### Preserve work when something fails

A failed save keeps the draft. A failed switch keeps the original conversation. A timeout with a possible effect needs reconciliation before retry. Recovery should explain the next safe action rather than hide the problem or repeat work blindly.

## Standards and evidence

[WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies testable accessibility criteria, including keyboard use, visible focus, contrast and reflow. We should use Level AA as a proposed acceptance target for the affected application flows. This guide and its screenshots do not establish full conformance.

The [W3C window-splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) informs keyboard resizing and pane controls. It is guidance with an explicit review caveat, not a certification of our implementation.

[OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) provides security-verification requirements. Relevant controls can inform authenticated remote access, authorization, input handling and error behavior. Applicability and verification belong to the implementation issue. No ASVS assessment or compliance claim is made here.

Clear ownership, explicit effects and replaceable adapters are engineering principles supported by the existing architecture and source review. They are not a claim that one industry standard prescribes every Vivary design choice. The first shell passed its private hosted checks. The remaining capabilities still need their own hosted evidence, followed by the intended Windows artifact checks.

## How we review together

Start with the walkthrough and the recorded decisions. During implementation, note anything confusing, missing, or awkward. Connect the observation to its source contract and explain the consequence in ordinary language.

Revision choices and notes inside the HTML guide are local drafts. Use **Prepare proposed revision**, then copy the text into the product conversation. The guide does not submit approval, start agents, change GitHub issues, update project files, or write to Git. Browser storage may be unavailable, so the copyable proposal remains the reliable sharing path.

A later proposal does not replace the accepted choice until Jeff responds with explicit authority. The live issue still owns implementation acceptance and lifecycle.
