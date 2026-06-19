# Meso Canvas Implementation Spec

Date: 2026-06-16
Status: implementation target for `feat/meso-canvas`

## Purpose

**Meso Canvas** is the Vivary spatial middle layer: a local, workspace-native
canvas where files, docs, graph nodes, gates, agent runs, diffs, plans, reviews,
and flows become selectable agent context.

Meso is not a decorative whiteboard. It is the context control plane between the
workspace tree, chat, focused inspectors, and Vivary's typed graph.

## Engine Decision

Use **React Flow / `@xyflow/react`** for the first spike and MVP.

Reasons:
- Meso is node-and-edge heavy, matching Vivary's graph substrate.
- The first useful surface is a typed workspace map with custom node renderers,
  selection, viewport controls, minimap, and deterministic layout.
- React Flow is easier to test deterministically than a general-purpose drawing
  editor.

Keep **tldraw** as the deferred candidate only if Meso becomes a freeform
whiteboard with drawing tools, sticky-note-first behavior, custom shape tools, or
multiplayer cursors.

## UX Contract

- Add `meso` to the stage tabs after `graph`.
- Keep chat as the persistent centerpiece.
- Render semantic previews on the canvas; full editing belongs in Focus mode.
- Canvas selection must become an explicit context bundle before sending to an
  agent.
- Do not mount hundreds of live editors or editable iframes.
- Persist app-owned canvas state under `~/.vivary-gui/canvases/<workspace-id>/`.
- Repo-local export is a later explicit gate.

## Data Model

```ts
type MesoNodeKind = 'file' | 'doc' | 'graph' | 'gate' | 'run' | 'plan' | 'diff' | 'flow' | 'note'
type MesoEdgeKind = 'links_to' | 'imports' | 'mentions' | 'generated_from' | 'blocked_by' | 'changed_by' | 'feeds' | 'approves'

type MesoNode = {
  id: `${MesoNodeKind}:${string}`
  kind: MesoNodeKind
  title: string
  path?: string
  graphId?: string
  gateId?: string
  sessionId?: string
  flowId?: string
  summary?: string
  position: { x: number; y: number }
  status?: 'ok' | 'warning' | 'blocked' | 'changed'
  private?: boolean
}

type MesoSelectionContext = {
  nodes: string[]
  edges: string[]
  paths: string[]
  graphIds: string[]
  sessionIds: string[]
  summary: string
}
```

## Backend Interfaces

Routes:
- `GET /api/workspaces/{wsid}/meso`
- `PUT /api/workspaces/{wsid}/meso/layout`
- `POST /api/workspaces/{wsid}/meso/context`
- `POST /api/workspaces/{wsid}/meso/nodes`
- `POST /api/workspaces/{wsid}/meso/flows/{flow_id}/run`

New modules:
- `app/backend/vivary_gui/services/meso.py`
- `app/backend/vivary_gui/routers/meso.py`

Derived objects:
- file/doc nodes from the workspace filesystem
- graph nodes/edges from `tropo graph`
- gate nodes from existing gate files
- run/plan/diff nodes from live manager sessions and events
- app-owned note/flow nodes from Meso persistence

## Frontend Interfaces

New modules:
- `app/frontend/src/meso/types.ts`
- `app/frontend/src/meso/reducer.ts`
- `app/frontend/src/meso/layout.ts`
- `app/frontend/src/meso/MesoPanel.tsx`
- `app/frontend/src/meso/MesoCanvas.tsx`
- `app/frontend/src/meso/MesoNode.tsx`
- `app/frontend/src/meso/SelectionTray.tsx`
- `app/frontend/src/meso/FocusSurface.tsx`

The first slice renders read-only Meso, supports search, selection, position
persistence, context preview, and read-only Focus inspection.

## Tests

Backend:
- model derivation for files, docs, graph nodes, graph edges, gates, and sessions
- app-owned layout persistence under monkeypatched `config.APP_DIR`
- selected-context bundle construction, including private file markers

Frontend:
- reducer tests for selection and context application
- layout tests for React Flow position serialization
- component tests for selection tray and focus surface

E2E:
- add workspace
- open Meso
- search/select nodes
- build selected context
- open Focus and return to canvas

## Out Of Scope

- repo-local canvas export
- JSON Canvas import/export
- tldraw integration
- live markdown editing
- flow execution beyond a stable route and fixture-shaped response
