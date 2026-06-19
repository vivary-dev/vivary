# Vivary GUI - Meso Canvas Plan

Date: 2026-06-16
Status: research-backed plan, not implemented
Working name: **Meso Canvas**

## Name Decision

Use **Meso Canvas** as the feature name.

Why:
- It fits the Vivary atmosphere stack: `tropo`, `strato`, `ozone`, `exo`.
- "Meso" suggests the middle atmosphere, which matches this layer's job: a spatial middle ground between raw workspace knowledge, agent action, and human review.
- It is smoother than `V-Canvas` and less generic than "Workspace Canvas."
- UI label can be short: **Meso** in the stage nav, **Meso Canvas** in docs.

Rejected names:
- `V-Canvas`: clear but generic, and it reads like a product extension instead of a Vivary-native layer.
- `Nimbus`: good atmosphere feel, but cloud metaphor can imply remote sync.
- `Aurora`: strong visual mood, but too brand-like and overloaded.
- `Aether`: atmospheric but too mystical for a tool surface.

## Research Synthesis

Miro's strongest current pattern is not an infinite whiteboard alone. It is an AI workspace where the canvas itself becomes the prompt, the output surface, and the process runner.

Important patterns to adapt:
- **Canvas as prompt**: Miro AI can use selected board content as context, not just typed chat.
- **AI-native formats**: Docs, diagrams, tables, timelines, kanban, slides, prototypes, and stickies are first-class formats on the canvas.
- **Sidekicks**: AI agents are visible on the board, act as thought partners, ask follow-up questions, preserve context, and iterate artifacts before commit.
- **Flows**: connected formats form multi-step AI workflows. One artifact becomes input for the next.
- **Focus mode**: structured formats can open into a focused editing surface without losing their place on the board.
- **Connectors**: external context is pulled into the canvas and outputs can sync back out.
- **Catch-up and summaries**: the board can summarize what changed and jump users to relevant places.

Vivary should not clone Miro's collaboration/enterprise frame. The open-source version should be sharper: a local, agent-native workspace map where every file, graph node, gate, plan, diff, run, and document can become selectable context for an agent.

## Product Thesis

**Meso Canvas turns a Vivary workspace into a navigable spatial operating surface for agents.**

The current GUI has a persistent chat and side panels. Meso adds a fourth mental model:

```text
Tree = where things live
Chat = what the agent is doing
Panels = focused inspectors
Meso = how the workspace connects
```

The canvas is not decoration. It is the context control plane.

## Core UX

### Screen Shape

- Left rail: workspace tree, canvas outline, search, saved views.
- Center: zoomable infinite canvas.
- Right rail: agent inspector, selected object details, approvals, receipts.
- Bottom or floating command bar: ask agent about selected context, create format, run flow, focus.

### Canvas Objects

Meso nodes are typed objects with stable ids:

```ts
type MesoNode =
  | { kind: 'file'; id: `file:${string}`; path: string }
  | { kind: 'doc'; id: `doc:${string}`; path: string }
  | { kind: 'graph'; id: `graph:${string}`; graphId: string }
  | { kind: 'gate'; id: `gate:${string}`; gateId: string }
  | { kind: 'run'; id: `run:${string}`; sessionId: string }
  | { kind: 'plan'; id: `plan:${string}`; sessionId: string }
  | { kind: 'diff'; id: `diff:${string}`; sessionId: string }
  | { kind: 'flow'; id: `flow:${string}`; flowId: string }
  | { kind: 'note'; id: `note:${string}`; text: string }
```

Edges are typed too:

```ts
type MesoEdgeKind =
  | 'links_to'
  | 'imports'
  | 'mentions'
  | 'generated_from'
  | 'blocked_by'
  | 'changed_by'
  | 'feeds'
  | 'approves'
```

### Zoom Behavior

Do not mount full editors everywhere.

- Far zoom: semantic mini-map cards, badges, type color, health state.
- Mid zoom: readable previews, diff stats, plan summaries, graph neighbors.
- Near zoom: one or a few selected objects mount richer previews.
- Focus mode: full document editor or inspector opens in-place or in a dedicated surface.

Use iframes only for sandboxed HTML previews or external web content. Markdown/docs should use native React editors. File previews should be virtualized.

### Selection As Prompt

Selecting objects creates an explicit context bundle:

```ts
type MesoSelectionContext = {
  nodes: string[]
  edges: string[]
  paths: string[]
  graphIds: string[]
  sessionIds: string[]
  summary: string
}
```

The composer can then say:
- "Ask about selected"
- "Summarize selected"
- "Turn selected into a plan"
- "Find missing dependencies"
- "Generate docs from this cluster"
- "Run review on this slice"

This is the Miro move, adapted to Vivary: board selection becomes agent context.

## Vivary-Native Differentiators

### 1. Workspace Truth, Not Workshop Stickies

Miro starts with freeform brainstorm objects. Meso starts with the actual repo/workspace:
- files
- docs
- graph nodes
- gates
- agent sessions
- diffs
- tests
- plans
- handoffs

The canvas is useful immediately after indexing a workspace.

### 2. Agent Receipts Become Spatial Objects

Every structured observability event can pin to the canvas:
- `tool` receipt pins to touched file or command target.
- `file_change` pins to changed files.
- `plan` pins as a live checklist.
- `approval_request` pins near the risky target.
- `reasoning` remains collapsed in chat, but its durable conclusion can attach as a note.

This ties the observability redesign directly into Meso.

### 3. Flows Are Agent Playbooks

Miro Flows connect formats. Meso Flows connect workspace objects and agent actions:

```text
Selected files -> summarize architecture -> generate plan -> run tests -> produce review -> open approval
```

MVP flow blocks:
- Context input
- Agent instruction
- Test/check command
- Review lane
- Document output
- Approval gate

### 4. Focus Mode Is Where Editing Happens

Canvas cards should not become tiny broken editors. A doc/file node can enter Focus:
- markdown editor
- diff review
- graph inspector
- plan editor
- gate approval

Focus mode keeps the canvas location visible in the breadcrumb and returns cleanly.

### 5. Open Local Persistence

Default storage should be app-owned:

```text
~/.vivary-gui/canvases/<workspace-id>/meso.json
```

Later optional export:

```text
.vivary/canvas.meso.json
```

Consider JSON Canvas import/export for interoperability, but do not make Obsidian compatibility a blocker.

## Technical Direction

### Recommended Canvas Engine

Start with **React Flow / xyflow** for MVP.

Why:
- Meso is node-and-edge heavy, not freehand-whiteboard first.
- Vivary already has graph semantics.
- It supports typed nodes, edges, viewport, drag/drop, minimap, controls, keyboard interaction, and custom node rendering.
- It is easier to test deterministically than a full whiteboard SDK.

Keep **tldraw** as the phase-two candidate if we later need rich drawing, multiplayer cursors, freehand sketching, sticky-note behavior, or custom shape tools.

Decision rule:
- If Meso MVP is "workspace graph plus rich node inspectors," use React Flow.
- If Meso becomes "general-purpose whiteboard with custom tools," move to tldraw.

### Editor Strategy

- Markdown/docs: MDXEditor or Tiptap after a focused spike.
- Plain files: current file reader first, Monaco later only if code editing becomes primary.
- HTML previews: sandboxed iframe only.
- PDFs/images: previews first, annotations later.

### Backend Additions

New canvas service:

```text
app/backend/vivary_gui/services/meso.py
```

Responsibilities:
- derive initial graph from workspace tree, tropo graph, open gates, sessions
- persist node positions and saved views
- expose context bundle for selected nodes
- accept agent-created notes/flows through approval policy

New routes:

```text
GET  /api/workspaces/{id}/meso
PUT  /api/workspaces/{id}/meso/layout
POST /api/workspaces/{id}/meso/context
POST /api/workspaces/{id}/meso/nodes
POST /api/workspaces/{id}/meso/flows/{flow_id}/run
```

### Frontend Additions

New modules:

```text
app/frontend/src/meso/types.ts
app/frontend/src/meso/reducer.ts
app/frontend/src/meso/layout.ts
app/frontend/src/meso/MesoCanvas.tsx
app/frontend/src/meso/MesoNode.tsx
app/frontend/src/meso/SelectionTray.tsx
app/frontend/src/meso/FocusSurface.tsx
```

Add `meso` to the existing stage list after `graph`:

```ts
type Stage = 'state' | 'graph' | 'meso' | 'files' | 'search' | 'gates' | 'dashboard'
```

## Epic Plan

### Epic M0: Research, Spec, And Spike

Scope:
- Keep this document as the canonical Meso plan.
- Spike React Flow and tldraw in disposable prototypes, no app integration yet.
- Decide canvas engine with evidence.
- Decide markdown editor with evidence.

Acceptance:
- Engine decision recorded.
- Editor decision recorded.
- No app behavior changed.

### Epic M1: Read-Only Meso Map

Scope:
- Add Meso stage.
- Render workspace tree files, tropo graph nodes, current gates, current sessions.
- Add pan/zoom, minimap, fit view, search-to-node.
- Persist node positions under `~/.vivary-gui`.

Acceptance:
- Backend tests cover derived node/edge model and persistence.
- Frontend tests cover reducer/layout basics.
- Playwright proves add workspace, open Meso, search, select node, zoom/fit.

### Epic M2: Selection As Agent Context

Scope:
- Add multi-select and selection tray.
- Backend builds a context bundle from selected nodes.
- Chat composer accepts "selected context" as structured prompt attachment.
- Agent receipts can pin to related nodes.

Acceptance:
- Unit tests cover context bundle construction.
- E2E proves selecting files then asking the fixture runtime includes only selected context.
- Existing chat observability remains intact.

### Epic M3: Focus Formats

Scope:
- Add focus mode for file/doc/plan/diff/gate nodes.
- Markdown document preview and edit path behind approval policy.
- Diff and approval focus surfaces reuse existing policy/gate mechanisms.

Acceptance:
- File edits require approval.
- Focus mode is keyboard accessible and returns to canvas position.
- E2E proves open doc, edit, approval, saved file, and return.

### Epic M4: Meso Flows

Scope:
- Add flow nodes and typed connectors.
- MVP flow blocks: context input, agent instruction, test command, review lane, document output, approval.
- Flow runs stream structured observability events and write outputs as Meso nodes.

Acceptance:
- Flow definitions persist.
- Flow runner is deterministic in fixture mode.
- E2E proves a selected cluster becomes a generated plan node and review node.

### Epic M5: Catch-Up And Spatial Review

Scope:
- Add "What changed?" mode.
- Show touched files, new docs, failed tests, pending approvals, and completed plan items as a spatial overlay.
- Add reviewer lanes as filters.

Acceptance:
- A user can open Meso after an agent run and jump directly to every changed artifact.
- Thermonuclear review can be run from a canvas cluster.

## Testing Matrix

Backend:
- `python -m pytest -q app/backend/vivary_gui/tests`
- Meso node derivation tests
- Meso persistence tests
- Context bundle tests
- Flow runner fixture tests
- Approval integration tests for edits and flow actions

Frontend:
- `npm run build`
- `npm run lint`
- `vitest --run`
- Meso reducer tests
- Node rendering tests
- Selection tray tests
- Focus surface tests

E2E:
- Add/open workspace
- Open Meso stage
- Select node from tree
- Search to node
- Zoom and fit view
- Build selected context
- Run fixture agent with selected context
- Open focus mode
- Edit doc with approval
- Run Meso Flow fixture

Manual:
- Large workspace performance check
- Mobile viewport check: canvas should become overview plus focused inspector, not a cramped whiteboard
- Keyboard navigation and screen reader smoke test
- Real Codex selected-context run after observability is stable

## Risks And Pushback

P1 risk: Canvas becomes a flashy second app instead of a useful operating surface.
Mitigation: MVP must derive value from real workspace objects before any freehand/sticky-note features.

P1 risk: Editable iframes everywhere create performance and focus bugs.
Mitigation: cards are previews; editing happens in Focus mode.

P1 risk: Layout persistence writes into user repos unexpectedly.
Mitigation: app-owned persistence by default, repo export only behind explicit gate.

P2 risk: React Flow may feel too diagram-like if we later want freeform whiteboard gestures.
Mitigation: make engine decision after spike; keep tldraw as fallback for whiteboard-heavy interaction.

P2 risk: Selected context can silently include too much data.
Mitigation: selection tray shows exact paths/tokens before sending to an agent.

P2 risk: Agent-generated layout can become chaotic.
Mitigation: generated nodes enter a staging area until accepted or placed.

## Research Used

- Miro AI overview: https://help.miro.com/hc/en-us/articles/28765406244498-Miro-AI-overview
- Miro AI reference: https://help.miro.com/hc/en-us/articles/20970362792210-Miro-AI-reference
- Miro Intelligent Canvas: https://miro.com/intelligent-canvas/
- Miro Sidekicks overview: https://help.miro.com/hc/en-us/articles/29902701849618-Sidekicks-overview
- Miro Docs and Focus mode: https://help.miro.com/hc/en-us/articles/20164660410898-Docs-in-Miro
- Miro AI Workflows overview: https://help.miro.com/hc/en-us/articles/29722516406546-Miro-AI-Workflows-overview
- Miro Flows: https://help.miro.com/hc/en-us/articles/29687970855442-Flows
- Miro Create with AI: https://help.miro.com/hc/en-us/articles/20164358139794-Create-with-AI
- Miro Connectors: https://miro.com/ai/connectors/
- Miro Technical Architecture playbook: https://miro.com/ai-playbooks/technical-architecture/
- Obsidian Canvas: https://obsidian.md/canvas
- JSON Canvas: https://github.com/obsidianmd/jsoncanvas
- Heptabase whiteboards/cards: https://wiki.heptabase.com/fundamental-elements
- FigJam AI: https://help.figma.com/hc/en-us/articles/16822138920343-Use-AI-tools-in-FigJam
- Muse canvas: https://museapp.com/
- React Flow: https://reactflow.dev/
- React Flow viewport: https://reactflow.dev/learn/concepts/the-viewport
- tldraw SDK: https://tldraw.dev/
- tldraw persistence: https://tldraw.dev/docs/persistence

## Next Exact Slice

Do not implement yet.

Next slice, after explicit approval:
1. Add a short Meso section/link to `OBSERVABILITY-REDESIGN.md`.
2. Create disposable React Flow and tldraw spikes outside app routing.
3. Choose engine and markdown editor.
4. Only then start Epic M1 on a feature branch slice.
