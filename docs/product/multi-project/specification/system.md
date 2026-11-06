# System and data diagrams

These diagrams describe target responsibilities. A box is a logical module, not a request for a new package, service or database. [Modules](modules.md) names current code and planned composition. [Actions](actions.md) defines observable operations.

The implemented Codex route keeps Native Code records and uses Codex app-server execution through the maintained Core patch. It supports native session resume and action approvals. The broader registry/linking design remains a target. See [the implemented behavior](harness-adapters.md#implemented-codex-behavior).

## Context

```mermaid
flowchart LR
  Person[Person] --> Desktop[Electron desktop client]
  Person --> Browser[Authenticated remote browser]
  Desktop --> Host[User-controlled Vivary host]
  Browser --> Host
  Host --> Native[Agent-Native lifecycle and actions]
  Host --> Engine[Original Vivary operations]
  Native --> Adapter[Supported harness adapter]
  Adapter --> CLI[Installed CLI and its model access]
  Host --> Files[Authorized project files]
  Engine --> Files
  CLI --> Bound[Bound local root or supported execution copy]
  Host -. explicit optional connection .-> External[Task sources / hosts / Brain / messaging]
```

The host owns authoritative Vivary state and coordinates execution. Each session records its actual execution and storage locations, including any supported sandbox or execution copy. A browser on a phone controls that host. It does not mount the phone's or laptop's folders. Desktop use defaults to loopback and no Vivary signup. Remote access is explicitly authenticated and revocable. A model provider can still receive supplied model context according to the selected harness and account. Local storage is not a claim of offline model inference.

## Stable core and replaceable edges

```mermaid
flowchart TB
  Shell[M01 Workspace shell] --> Projects[M02 Project identity]
  Shell --> Conversation[M03 Conversation projection]
  Shell --> Panels[M06 Files / M09 Plans / preview]
  Conversation --> Runtime[M04 Harness catalog and adapter binding]
  Runtime --> Native[Existing Native registry and lifecycle]
  Projects --> Authority[M05 Authority and revisions]
  Conversation --> Authority
  Panels --> Authority
  Native --> Claude[Claude Code adapter]
  Native --> Codex[Codex adapter]
  Native --> Future[New supported adapter]
  Panels --> Operations[M07 Original workspace operations]
  Operations --> Files[Project filesystem]
  Search[M08 Search and memory] --> Files
  Search --> Native
  Work[M10 Worker and review coordination] --> Native
  Work --> Plans[M09 Authoritative plans and tasks]
  Work --> VCS[M11 VCS and host adapters]
  Research[M12 Research and learning] --> Work
  Automation[M13 Intake and automation] --> Work
  Packaging[M14 Host and desktop] --> Native
  Publish[M15 Distribution and discovery] --> Authority
  Evidence[M16 Evidence and help] --> Native
```

The stable contract covers identity, authorization, revisions, effect outcomes and source references. Replacement code can change how a supported external system is reached. It cannot redefine another module's IDs, claim a grant or mutate a transcript behind its owner.

## Original Vivary module composition

```mermaid
flowchart LR
  Entry[GUI action / agent tool / original CLI] --> Meta[Vivary command routing]
  Meta --> Create[create-vivary: create and adopt]
  Meta --> Tropo[Tropo: observe and retrieve]
  Meta --> Strato[Strato: evaluate authority]
  Meta --> Ozone[Ozone: verify]
  Meta --> Exo[Exo: project claims and dependencies]
  Create --> Core[Core: shared validation and projection]
  Tropo --> Core
  Strato --> Core
  Ozone --> Core
  Exo --> Core
  Create --> Files[Project files and original receipts]
  Meta --> Files
```

The original command owner determines each verb's semantics. The adapter translates inputs and results. It does not reimplement create, adopt, doctor, capabilities, find, check, decide, review, impact or control. App-invoked receipts belong in private app data where the packaging contract requires them. Standalone CLI behavior remains usable without the GUI.

## Data ownership

```mermaid
erDiagram
  PROJECT ||--o{ ROOT_BINDING : authorizes
  PROJECT ||--o{ CONVERSATION_REFERENCE : organizes
  CONVERSATION_REFERENCE ||--|| NATIVE_RECORD : references
  CONVERSATION_REFERENCE ||--o{ HISTORY_LINK : links
  NATIVE_RECORD ||--o{ RUN_REFERENCE : contains_or_references
  RUN_REFERENCE ||--o{ EVENT_REFERENCE : exposes
  RUN_REFERENCE ||--o{ APPROVAL_REFERENCE : requests
  PROJECT ||--o{ FILE_REFERENCE : scopes
  FILE_REFERENCE ||--o{ DRAFT : retains_unsaved_version
  PROJECT ||--o{ PLAN_REFERENCE : organizes
  PLAN_REFERENCE ||--o{ TASK_REFERENCE : constrains
  TASK_REFERENCE ||--o{ RUN_REFERENCE : dispatches
  FILE_REFERENCE ||--o{ MEMORY_REFERENCE : sources
  RUN_REFERENCE ||--o{ EVIDENCE_REFERENCE : supports
```

This is a conceptual relationship diagram, not a proposed SQL schema. NATIVE_RECORD denotes one of the existing Native thread, Code run or harness-session owners. Their schemas and lifecycle are distinct. A history link stores a source reference and completed-event boundary. It never copies the transcript or transfers opaque resume state. A file reference is not a replacement for its actual filesystem bytes.

| Information | Authoritative owner | Stored elsewhere only as |
| --- | --- | --- |
| Project identity and root grants | Existing registry/binding services | Stable ID and current revision |
| Conversation content and run events | Appropriate Native thread, Code or harness owner | Authorized projection or source reference |
| Resume state | Originating Native harness/session owner | Opaque reference, never cross-harness state |
| Project document bytes | Authorized project filesystem | Draft with base version or rebuildable index |
| Unsaved document/composer draft | Existing scoped app-state/draft owner | Client projection with persistence failure visible |
| Panel width and open state | Safe client-specific preferences | Presentation only, not shared execution state |
| Task lifecycle | User-selected task source | External ID, version and display projection |
| Plan and approved revision | Selected Native/local plan owner | Exact revision reference |
| Credentials | Existing scoped secrets or harness login | Readiness observation, never raw secret |
| Knowledge | Sourced project files or explicitly selected Brain | Retrieval result with provenance |
| Usage/cost | Observed Native/harness event data | Labeled report. Absent data stays unknown |

## Effect boundary

```mermaid
sequenceDiagram
  actor Person
  participant UI as Workspace control
  participant Action as Existing action boundary
  participant Auth as Project and authority owner
  participant Owner as Native or original operation owner
  Person->>UI: Request operation
  UI->>Action: Request ID, source refs, expected revisions
  Action->>Auth: Revalidate caller, scope and capability
  alt Denied or stale
    Auth-->>Action: Stable reason and safe recovery
    Action-->>UI: No new effect
  else Authorized
    Auth-->>Action: Current bound scope
    Action->>Owner: Execute the one permitted operation
    Owner-->>Action: Result or explicit uncertain outcome
    Action-->>UI: Updated authoritative reference
  end
```

A preflight result is not permanent permission. Revalidate immediately before effects. A timeout after a possible effect is uncertain until reconciled. Do not retry by creating a second run, file operation or external publication. Display refresh reads the owner. It does not replay the action.
