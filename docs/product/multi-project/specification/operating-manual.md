# Contributor operating manual

Use this manual to give an LLM the exact context for one change. It is a reading and contract map, not a second task tracker or a replacement for AGENTS.md. Jeff accepted the design direction on 2026-09-14. The first workspace shell merged in PR #42 after private hosted verification, independent review and CI. Bounded Codex execution and Windows proof are recorded in the acceptance register. Broader issue #38 capabilities remain incomplete.

## One feature, one bounded context

1. Read root AGENTS.md, ENGINEERING.md and CONTRIBUTING.md, then the live owning GitHub issue. Recheck branch, dirty state and current source. Do not treat this snapshot as current task status.
2. Select the relevant [action IDs](actions.md). Read their shared state/authority rules and their [module entries](modules.md).
3. Read only the matching [journey](journeys.md), source owner, existing tests and contract. Expand to a direct dependency when the proposed change crosses its boundary.
4. State the preserved behavior and one observable outcome before edits. Identify whether this is configuration, composition, a small UI extraction or a new adapter.
5. Implement against the current installed API. Conceptual names in this specification are not exports to import. Prefer configure, compose, then the smallest supported extraction.
6. Run focused verification and the affected real hosted journey. Fix failures and repeat that journey. Run independent review when the risk warrants it. The PR gate needs one approval, and the author's approval counts.
7. Update the owning contract/evidence and its source map when behavior changes. GitHub owns lifecycle. Regenerate only views whose sources changed.
8. Follow the standing Zo CI and delivery practices in AGENTS.md and CONTRIBUTING.md. Push reviewed source to both remotes and verify matching refs. Merge only with the applicable CI, review, product acceptance, and existing authorization. Refresh the private app while idle. Test the packaged Windows EXE separately.

## Context routes

| Change | Read first | Concrete implementation entry | Verify before acceptance |
| --- | --- | --- | --- |
| Navigation, panel or composer layout | M01, J01, unified-workspace.md, packages/workbench/DESIGN.md | `app/root.tsx`. `Layout.tsx`. `Sidebar.tsx`. `workspace/Workspace.tsx`. Compatibility redirects in `app/routes/` | Same selected conversation/run/draft across close, resize, project switch, 390 px and keyboard |
| Project selection or missing folder | M02/M05, J02, project registry contract | ProjectContext. Project-services. Code-project. Vivary-code-state | No fallback, current grant checks, retained authorized history, Stop after folder loss |
| Harness/model picker or new CLI | M03/M04/M05, J03, harness-adapters.md | readiness service. Runtime setup. Native harness docs and declarations | Catalog truth, approval, no auto-send, failure preservation and real supported lifecycle |
| Saved conversation and resume | M03, J03/J05, issues #6/#9/#10 | `workspace/CodeConversation.tsx`. `workspace/NativeConversation.tsx`. Code and Chat history owners. Existing chat adapter | Several independent project conversations, distinct owner identity, exact history, truthful replay/native resume and restart |
| Document editor or save | M06, J04, issue #12 receipt | `ProjectFiles.tsx`. `routes/files.tsx`. File save/rename actions. File-draft state | Read mode first, explicit edit, external changes, draft recovery, byte/newline preservation and current root checks |
| Setup, adoption or original verbs | M07, J06, original CLI reference and issue | create-vivary. Original package contracts. Shared plan/apply owner | GUI/agent/CLI parity, stale plan, conflicts, no accidental VCS/host/Brain |
| Search or memory | M08, J09, issues #11/#13/#21 | file/history owners and Tropo | Private exclusions, cancellation, stale match, correction/forget and Brain-off |
| Plans, task source or board | M09, J07, outcomes 14/15 | Native Plan/task docs and chosen external owner | Source IDs, revision changes, cycles, stale approval and no fake Done |
| Worker, QA or handoff | M10, J05/J07/J08, outcomes 16/17/29 | Native task/run owner, activity, file writes | Exact candidate, actual checks, bounded rework, no duplicated run or false freshness |
| VCS or repository host | M11, J07, root/VCS contract | Existing root provider. Selected supported VCS/host adapter | No-VCS baseline, target drift, conflicts and separate push/merge authority |
| Research, creative work or learning | M12, J09/J10, outcomes 18/21/36 | Same agent conversation, authored files, scoped resources | Sources, rejected proposals, Brain-off, no hidden cross-project promotion |
| Inbox, factory or heartbeat | M13, J10, outcomes 20/22/30 | Native messaging/tasks/automations | Signature/dedup, no-op, bounded retries, pause and explicit activation |
| Electron, host or browser preview | M14, J11, issues #7/#8/#30/#31 | Desktop package. Existing start/lifecycle. Supported preview | Exact hosted build, actual Windows folders, revoke/reconnect, process cleanup |
| Public protocol, site or release | M15, J12, outcomes 23-35 and release owner | Original actions and separate vivary-site repository | Real implementation, auth, artifact provenance and explicit publication gate |
| Evidence, docs or help | M16, coverage.md and owning issue | Existing receipts, tests and docs | Correct source/version, no unrun proof, no conflicting ownership or stale claims |

Paths abbreviated in this table resolve through the [module catalog](modules.md). The public website stays in its own repository. The old product Astro site is not the new website implementation target.

## Copyable task brief

```text
Work on live issue <URL> in the named existing checkout.
User-visible outcome: <one observable behavior>.
Specification actions: <A IDs>. Modules: <M IDs>. Journey: <J ID>.
Read: AGENTS.md, ENGINEERING.md, CONTRIBUTING.md, the live issue,
then <one module entry>, <one journey>, <owning contract/source/tests>.
Preserve: <project identity, Native owner, approvals, drafts and other relevant invariants>.
Ownership: <exact files or boundary>. Other writers own <known adjacent files>.
Current source/branch and resources: recheck, do not assume this brief is fresh.
API rule: verify installed exports. Specification signatures are conceptual.
Verification: <focused existing check> and <affected hosted user journey>.
Failure: preserve authored data, report denied/conflict/uncertain state, repair and repeat.
Delivery: reviewed topic PR into dev, applicable CI and one approval,
Zo CI against the exact candidate, matching GitHub/Entire refs, and authorized merge only.
Preview source verified. No automatic main/public promotion.
Stop only the operation needing a missing actual prerequisite.
Update the owning docs and existing handoff, not a parallel task ledger.
```

## Changes that cross modules

Write down the caller first. For a new harness, the caller chooses a catalog row, requests a linked conversation, then explicitly sends. The UI should not know the CLI command, token format or resume schema. Those stay behind the adapter and Native lifecycle.

For a new editor, the caller reads content with a base version, edits a draft and requests save. The editor cannot own authorization or overwrite disk directly. For a new tracker, the board reads and changes the selected source's IDs and revisions. It cannot invent a second Done state.

If a change requires a new record, first identify the missing concept. Prefer a pointer to an existing owner. A new transcript, scheduler, secret store or task queue needs evidence that the existing Native owner cannot meet the contract. Ordinary UI composition is not that evidence.

## Verification without a second product

Keep implementation, builds, automated checks, hosted QA, and continuity on Zo. Use Windows for the packaged EXE. GitHub billing does not block the standing approved Zo CI path. Record its exact candidate and executed checks without claiming unrun Windows jobs passed. Preserve one current local package after replacement acceptance. The root instructions own cleanup and the 1% remaining usage boundary.

For documentation changes, use existing plan, navigation, line-ending and diff checks. Render diagrams and exercise the drawing room links/interactions. For code, run the smallest relevant existing tests and the actual user journey. Do not build a custom runtime just to demonstrate the spec.

A substitute adapter needs a deterministic contract fixture and an authorized real host check. A screen mockup proves layout only. A build proves compilation. CI proves its executed checks. None alone proves Windows product acceptance, cross-harness resume, publication or a completed multi-agent workflow.

## Unknowns to resolve in the owning implementation issue

- Which registered adapters expose account-effective model enumeration through the installed version's supported interface?
- Which Native metadata/relation owner can retain exact-history links without a new store?
- What session-version migration and backward-read compatibility does each chosen adapter actually support?
- Which supported browser integration provides project preview debugging while preserving app isolation?
- Which task/plan, optional Brain, external template and scheduler integrations are selected for their later outcomes?
- Which scope and retention rules apply to exported history and cross-device recovery? No automatic device-folder sync is selected.

These are explicit implementation prerequisites or later product decisions, not permission to guess. The diagram and action contract remain useful while a capability is unavailable. Do not show the unavailable capability as working merely because its box exists.
