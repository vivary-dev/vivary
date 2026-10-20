# Vivary visual specification

Status: accepted design direction and maintained contributor guide, 2026-09-14. Jeff accepted guide snapshot `e86d06ed592a2d3c` in his submitted product-conversation review. He later clarified that each project needs multiple independent conversations and potentially concurrent threads. The first shell and multiple-conversation navigation are implemented and verified in the private hosted candidate. Concurrent execution and the remaining issue #38 capabilities are still incomplete. Application work proceeds under the live acceptance and lifecycle in [issue #38](https://github.com/vivary-dev/Vivary-New/issues/38).

## Implementation checkpoint, 2026-09-16

- Accepted in the private integration source: the unified workspace, reliable project and appearance state, project-bound Code and Native history, explicit file operations, reviewed managed-folder reconnection, bundled original runtime, and managed five-file creation.
- The private `26798df` Windows candidate passed Explorer extraction and launch, bundled runtimes, managed creation, project files, a real approved Claude Code file turn, restart continuity, second-instance reuse, and complete owned-process cleanup.
- New Code conversations select Claude Code or Codex. Codex models come from its account-effective catalog. The merged Codex increment passed subscription file work, native action decisions, mode checks, session resume, actual subagent display, Stop, and restart on recorded Windows candidates. Native's separate provider picker stays hidden.
- Deterministic Native journeys do not establish access to a real Native provider. Real-provider Native turns and automation execution remain separate acceptance gaps.
- Clean-profile setup, populated-folder adoption, search, memory, responsive self-hosted access, integrated preview/debugging, signing, installation, upgrades, and public release remain incomplete.

[The acceptance register](../desktop-acceptance-status.md) states the tested candidate and current gaps. [The release guide](../desktop-release.md#what-exists-and-what-is-missing) retains the full target. This visual specification explains accepted design and planned parts; it does not replace the running application or live issue lifecycle.

## Start with the work

Vivary is one visual workspace over the projects and supported agent tools on a user-controlled host. Select a project, then continue one of its conversations or start another. Each conversation has independent history and bounded model context. The center shows one selected conversation at a time. It does not limit the project to one chat or promise unlimited context. A person can write, research, plan or code through the same workspace. A project does not need Git, a Brain, a preset persona or a Vivary account for local use.

The interface stays stable when the chosen harness changes. A registered adapter translates that harness's supported lifecycle and events through Agent-Native. A future CLI needs an adapter and compatibility evidence. Installation alone never establishes support.

## Open the guided reader

Open [Vivary, step by step](guide.html) for a walkthrough, connected module map, searchable actions, recorded decisions, revision proposals, and the full reading library. It is one offline HTML file. It embeds the 12 core chapters, the walkthrough content source, all 36 outcome contracts, and rendered diagrams. External citations and code links need a connection. The guide itself does not. It is a maintained companion to the owned specifications, not a hosted product or a separate task authority.

The guide shows accepted requirements and choices with their recommendations, options, consequences, and implementation impacts. It records the multiple-conversation requirement separately because no additional design vote is needed. Draft revision notes stay in the browser until you copy them into the product conversation. The page does not submit a decision, write Git, or change GitHub.

[The guided review](guided-review.md) separates the accepted review record, later proposals, and engineering defaults. [guide-content.json](guide-content.json) owns the plain-language walkthrough and structured decision record. It does not replace the module/action contracts or GitHub issue lifecycle.

### Regenerate the reader

Run `python docs/product/multi-project/specification/render-guide.py`, then run the same command with `--check`. The authoring tools used for this revision are Python-Markdown 3.10.3 and Beautiful Soup 4.14.3. These are authoring tools only; the generated reader needs no packages. Use the existing reviewed authoring environment.

Diagram source and SVG hashes are checked against the committed manifest. When Mermaid source changes, use `--refresh-diagrams` with the existing Playwright/Chromium authoring environment. This fetches Mermaid 11.12.0 only during generation and verifies its fixed SHA-256 before execution. The bundle hash was checked against the [published npm package](https://registry.npmjs.org/mermaid/11.12.0) and its registry integrity value. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if the environment uses a separately managed Chromium. Review the resulting diagrams and reader before committing. The reader never loads Mermaid or other remote scripts.

The generated reader records a fingerprint of its source inputs. The accepted review remains bound to snapshot `e86d06ed592a2d3c`, even after later source changes produce a new fingerprint. Draft storage uses a stable key. Notes and unchanged option drafts survive a new fingerprint with a visible notice. Choices that match the accepted snapshot become recorded decisions instead of new proposals. Changed option definitions need a fresh proposal. Implementation and contributor links use accepted integration source. Project sessions, managed-project recovery, bundled runtime, and the creator path are integrated. Their bounded checks do not complete the release journey. Existing-folder apply remains open under issues #14/#15, while linked conversations, a generic harness catalog, and concurrent root conversations remain under issue #38. These refs identify the source that implements each role while delivery and release acceptance remain separate. Historical research links remain pinned to specification baseline commit `3d3a6c50c32284ebf2c7def311f6e3e80deb8bb5`. Update the matching locator when its source role changes. Do not put review notes or browser storage in Git.

## Read this specification

| Need | Read |
| --- | --- |
| Understand the whole system | [System and data diagrams](system.md) |
| Find each module, its contracts and replacement boundary | [Module catalog](modules.md) |
| Inspect every declared user action | [Action catalog](actions.md) |
| Understand harness installation, selection, resume and replacement | [Harness adapter contract](harness-adapters.md) |
| Follow interactions, approvals and recovery step by step | [Journeys and state diagrams](journeys.md) |
| Find all 36 outcomes and current release relationships | [Coverage and delivery map](coverage.md) |
| Give an LLM exactly the context for one change | [Contributor operating manual](operating-manual.md) |
| Agree on the meaning of a term | [Shared vocabulary](../CONTEXT.md) |
| Inspect the selected workspace layout | [Unified workspace interaction contract](../unified-workspace.md) |
| Review the research behind the interface | [Agent workspace ergonomics](../research/agent-workspace-ergonomics.md) |

The interactive [drawing room](atlas.html) is a generated companion view of [feature-map.json](feature-map.json). It lets a reviewer select a module and inspect its connected modules and actions. The generated atlas.html opens directly in a browser without a server or network dependency. Keep the viewer beside its Markdown files so relative links stay on the same revision. atlas.fragment.html supplies the in-conversation view. When embedding it outside the repository, set its data-doc-base to the exact source commit directory. The Markdown diagrams remain readable without either viewer. The JSON owns only this specification's module/action inventory. It does not own task status or replace GitHub issues. Regenerate it with `node docs/product/multi-project/specification/render-atlas.mjs`.

## Completeness boundary

This revision specifies the known product program: all 36 retained outcomes, issue #38's unified workspace, and the required desktop/browser issue set. The action catalog covers the declared controls and operations, including recovery. It does not pretend to enumerate future third-party features or every arbitrary request someone can type into an agent. Such requests use the same scoped action, permission and artifact contracts.

Each action inherits the shared preconditions and failure rules in the action catalog. Each module names its data owner, permitted calls, replacement boundary and acceptance scenario. Later capabilities have explicit scope and acceptance proposals, not fake enabled controls or invented implementation dates. Unsettled adapter-specific APIs remain evidence requirements before their implementation issue can start.

## Source and authority

- User decisions: one visual workspace with multiple independent conversations per project, optional panels, exact linked history, separate handoff workflow, supported installed harnesses and live models, header-first project details on wide desktop, and manual handoff updates by default. Jeff accepted the last two choices on 2026-09-14 through his submitted review of guide snapshot `e86d06ed592a2d3c`. He clarified the multiple-conversation and potential concurrency requirement later that day in the product conversation.
- Product architecture and constraints: [design.md](../design.md), [capability-matrix.md](../capability-matrix.md), [native-owners.md](../native-owners.md) and the 36 linked outcomes.
- Current implementation: `Workspace.tsx` composes `CodeConversation.tsx`, `NativeConversation.tsx`, and optional project details, files, and preview panels. The old `/agent`, `/files`, `/workbench`, and `/chat` routes redirect to `/`. Files remain read-first with explicit editing. Project-bound Native history and the saved-head repair are integrated. The tested Windows candidate adds real Claude Code, restart, and lifecycle evidence. Codex selection and bounded native execution are integrated with recorded Windows acceptance. The generic harness catalog, real Native-provider and automation acceptance, cross-harness linking, handoff workflow, and concurrent runtime remain incomplete. The module catalog owns exact paths. The pinned application baseline remains Native Core 0.176.5 and Toolkit 0.19.3.
- Delivery: live GitHub issues own goals, acceptance, dependencies, assignment and lifecycle. Issue numbers and outcome numbers are separate namespaces. Always write "issue #35" or "outcome 35".
- Product acceptance: actual hosted application checks precede Windows artifact checks. A diagram, mockup, package build or CI pass is not product acceptance.

Older source-map gap paragraphs retain pre-integration assumptions. The concrete source locators here and the recent component receipts distinguish existing implementations from remaining end-to-end gaps. Do not infer that Native has no runtime or store from an older negative finding.

## Design synthesis

Two independent candidates were compared. Candidate A emphasized the workspace and linked-conversation flow. Candidate B covered the full product through a stable core and replaceable boundary adapters. B is the organizing basis, with A's precise panel, draft, focus, history and failure behavior included.

The independent same-family review agreed with that choice. The synthesis rejects a universal replacement runtime, a plug-in-defined permission system, a second transcript store, and a plan service that competes with the selected task/plan owner. Native references remain opaque. Link metadata uses an existing suitable owner where possible. Client layout preferences are distinct from shared project records. Uncertain effects are explicit, and linking never starts a run.

## Review record and later changes

Jeff accepted guide snapshot `e86d06ed592a2d3c` on 2026-09-14. He selected header-first project details on wide desktop and manual handoff updates by default, with no additional notes. Later that day, he explicitly clarified that a project must support multiple independent chats and potentially concurrent threads. One selected conversation in the center does not mean one total project conversation or unlimited model context.

The concurrency direction is settled. Implementation must expose per-thread activity and approvals and control conflicting writes to shared files. Deferred from the desktop and self-hosted web release to issue #228 on 2026-10-16, concurrent Code conversations were then required for the release on 2026-10-19. Several Code conversations run at once, in one project or many, each with its own activity, approvals and Stop. A send beside another agent in an overlapping folder shows the owner's warning and offers a separate folder or Git worktree. The owner accepted that Vivary does not control conflicting writes to shared files. The [HLDD](../../../ARCHITECTURE.md#concurrent-code-conversations) describes the behavior. This clarification creates no new design blocker.

Keep the guide useful during implementation. A future design proposal should explain the observed problem, options, consequences, implementation impact, and recommendation. Drafting or copying a proposal creates no authority. Jeff must explicitly accept a later change before the owning specification records it.
