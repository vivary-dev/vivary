# Action catalog

This catalog enumerates 120 declared actions across the known product scope. IDs are stable review references, not shipped endpoints. Actual action names stay with the existing implementation owner. The JSON [feature map](feature-map.json) owns the inventory. This table is its readable projection.

## Shared action contract

Every action binds the user/organization, selected host and stable project where relevant. Reads enforce current authorization. Effects revalidate scope and expected versions immediately before execution. A visible selection is not authority. Viewing content never submits it to a model automatically.

Modes describe the initiating path: `read` is observation, `local` is deterministic application or filesystem work, `agent` is interpretation/work through the existing conversation runtime, and `external` can involve an account, connection or publication. These modes are not permission grants. The original operation owner still determines actual effects and required approval.

Scope labels describe the design: `release` participates in the selected desktop/browser experience, `later` belongs to the retained broader program, and `optional` has a working skip path. New controls proposed within a release family still require acceptance under their linked live issue. Labels never claim availability.

Each operation specifies a request ID, current source references and expected revisions where it can cause a durable effect. Results distinguish completed, denied, unavailable, conflict, failed and uncertain. A retry must reconcile the prior operation before repeating effects. Pending/failed persistence retains visible input and an explicit recovery. External side effects require their specific authority.

## States inherited by every action

| State | Required visible behavior | Required invariant |
| --- | --- | --- |
| Loading | Layout-matching skeleton. Preserve selected project and input | Never infer empty or success |
| Empty | Explain the absence and one relevant next action | Do not seed fake projects, agents or content |
| Unavailable | Name missing capability with Retry/setup where supported | No silent fallback |
| Denied/revoked | Explain scope of refusal without leaking protected content | Start no new effect |
| Conflict | Show which revision/path changed and recovery options | Preserve both authored inputs and current source |
| Failed | Stable reason and safe Retry when possible | No fabricated receipt |
| Uncertain | Explain what may have happened and reconcile | Never automatically replay a possible effect |
| Canceling | Keep Stop status visible until cleanup is observed | No new conflicting execution |
| Complete | Show actual result and source references | A model response alone is not workflow acceptance |
| Reopen/restart | Restore durable refs/drafts and reconcile active work | No implicit approval or duplicate execution |

## Accessibility and interaction profile

Every applicable action has a text label, keyboard operation, visible focus, and an announced result. Pointer resizing also has keyboard controls. Escape closes only the top transient view and returns focus. At 390 px and 200% zoom the requested panel can take focus while Back returns to the same conversation. Essential approval and Stop remain reachable. Light and dark appearances retain readable contrast. These are acceptance requirements, not claimed accessibility certification.

## M01: Workspace shell

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A001 | Open project workspace | release / local | Restore requested selection and conversation frame. No file auto-opens | Unavailable target remains selected with Retry |
| A002 | Open or close project navigation | release / local | Change layout only. Preserve active run and drafts | Focus returns to toggle |
| A003 | Open project context | release / local | Show compact host, root, VCS and readiness metadata | Unknown facts remain unknown |
| A004 | Open a requested panel | release / local | Keep the same conversation mounted | Unsupported integration explains availability |
| A005 | Resize a panel | release / local | Pointer and keyboard change bounded width | Narrow view switches to focused panel |
| A006 | Maximize or restore a panel | release / local | Preserve previous layout and conversation | Escape or Restore returns focus |
| A007 | Close and reopen a panel | release / local | Preserve document draft and prior selection | No hidden process termination |
| A008 | Navigate old workspace links | release / local | Resolve into one canonical workspace with correct project | Bad link gives scoped recovery |
| A009 | Change appearance | release / local | Persist theme without altering project state | Failed preference save exposes Retry |

## M02: Projects and roots

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A010 | Register an existing folder | release / local | Create stable registration without adopting or modifying bytes | Duplicate or unauthorized root refused |
| A011 | List and refresh projects | release / read | Return only authorized project metadata | Retain last selection on refresh failure |
| A012 | Switch projects | release / local | Retain drafts and keep runs bound to original project | Never silently choose a fallback |
| A013 | Locate a moved folder | release / local | Revalidate identity and explicit new binding | Mismatched or duplicate root needs resolution |
| A014 | Retry unavailable folder | release / local | Recheck access and root without recreating it | History stays readable if authorization permits |
| A015 | Rename project display name | later / local | Change metadata only. Stable ID and root retained | Revision conflict preserves requested name |
| A016 | Unregister project | later / local | Preview reference effects. Preserve files and retained history policy | Active bindings block or require explicit resolution |
| A017 | Merge or split project registrations | later / local | Preview selected resources and preserve origin identities | No destructive merge or silent transcript reassignment |

## M03: Conversations and continuity

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A018 | Create conversation | release / local | Bind one project and runtime with a new durable reference | Retry cannot create duplicates |
| A019 | Reopen conversation | release / read | Read exact authorized history and pending state | Removed harness does not erase history |
| A020 | Send a message | release / agent | Bind request and context to current project. Start through the selected runtime and surface its native action decisions | Stale scope prevents launch. A denied native action does not run |
| A021 | Continue existing conversation | release / agent | Use native resume only when supported. Expose replay otherwise | Incompatible resume offers linked conversation |
| A022 | Preserve unsent message | release / local | Scope draft to conversation and survive panel/project changes | Failed persistence retains visible draft and Retry |
| A023 | Select model in same harness | release / local | Keep conversation only if adapter supports compatible change | No silent model substitution |
| A024 | Select another harness | release / local | Create linked conversation and retain unsent input. Do not send | Failure leaves source conversation unchanged |
| A025 | Inspect linked history | release / read | Resolve source events through completed boundary with source authorization | Revoked/deleted source shows unavailable reference |
| A026 | Inspect context supplied to a turn | release / read | Show exact sources, summaries and omissions actually supplied | Unknown harness compaction is labeled |
| A027 | Rename or archive conversation | later / local | Change reference metadata. Preserve history and active work | Archive does not approve, stop or delete |
| A028 | Export or import a handoff | later / local | Preview included data and validate format, scope and provenance | No credentials or opaque cross-harness state transfer |
| A117 | Create or edit an optional agent profile | optional / local | Use the existing Native resource/settings owner or intentionally authored project instructions | No mandatory persona. Profile instructions cannot grant tool permissions |
| A118 | Select an optional profile | optional / local | Bind the chosen profile reference and revision to future requested context | No auto-send, session retargeting or approval transfer |
| A119 | Clear an optional profile | optional / local | Remove future profile selection while preserving existing history and drafts | Previously supplied instructions are not claimed erased |
| A120 | Inspect effective instructions | optional / read | Show applicable sources, scopes and profile revision without exposing secrets | Inherited or unavailable sources remain labeled. Instructions are not authority |

## M04: Harness adapters

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A029 | Discover supported harnesses | release / read | Enumerate registered adapters and bounded installation probes | Arbitrary unknown executables never auto-run |
| A030 | Refresh available models | release / read | Obtain account-effective list through supported adapter interface | Unavailable enumeration stays explicit |
| A031 | Open harness sign-in or setup | release / external | Use supported CLI/account flow and re-probe readiness | No credential copy into source or transcript |
| A032 | Register a new harness adapter | later / local | Validate interface/version/capabilities and installation consent | Incompatible adapter is unavailable before execution |
| A033 | Upgrade or disable an adapter | later / local | Preserve sessions and pin active execution identity until safe switch | Incompatible historical sessions remain readable |

## M05: Authority and approvals

For implemented Codex turns, Send starts immediately and approvals apply to native actions. Normal, Read only, and YOLO are execution modes, distinct from this catalog's action categories. See [implemented Codex behavior](harness-adapters.md#implemented-codex-behavior).

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A034 | Approve a pending request | release / local | Authorize exact request, project and revisions once | Changed input invalidates approval |
| A035 | Deny a pending request | release / local | Deny the exact requested action. An already running native turn may continue within its remaining permissions | Retry cannot convert denial into approval |
| A036 | Stop active work | release / local | Use recorded ownership to request cancellation even if folder disappears | Stopping is not stopped until observed |
| A037 | Inspect background activity | release / read | Show project, conversation, state, Stop and pending decision | Closed panel/browser never hides running work on return |
| A038 | Reconnect after host restart | release / local | Reconcile Native records with observable process state | Interrupted or uncertain remains explicit. No automatic replay |
| A039 | Change authority policy | later / local | Preview scope and persist revision | Pending work revalidates. No retrospective permission |
| A040 | Revoke remote access | release / local | Invalidate selected client grant and reconnect rights | Server enforces revocation. UI alone is insufficient |

## M06: Files and documents

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A041 | Browse project files | release / read | List authorized entries and preserve folder navigation | Private and escaped paths remain excluded |
| A042 | Open a file | release / read | Read formatted Markdown or supported source. No edit by default | Unsupported or oversized content has safe fallback |
| A043 | Enter or leave edit mode | release / local | Preserve exact source and base version | Read view never discards unsaved text |
| A044 | Save file | release / local | Revalidate root and version before writing intended bytes | External edit yields recoverable conflict |
| A045 | Rename file | release / local | Validate one same-folder filename and exclusive destination | No overwrite. Partial outcome remains explicit |
| A046 | Recover or discard draft | release / local | Show affected draft and explicit choice | Discard requires intent. Failed save keeps draft |
| A047 | Resolve file conflict | release / local | Compare disk and draft. Create deliberate reconciled version | No automatic overwrite of external edits |
| A048 | Create document or folder | later / local | Preview target and create within authorized root | Existing path conflict does not overwrite |
| A049 | Move or remove file | later / local | Show exact paths, references and recovery limits before effect | No blanket recursive delete or silent draft loss |
| A050 | Ask agent about selected file | later / agent | Stage explicit file reference in same conversation | Viewing a file alone does not submit its content |

## M07: Workspace operations

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A051 | Preview workspace creation | release / read | Compute exact files, versions, options and conflicts | Preview creates no files, VCS, account or remote |
| A052 | Apply workspace creation | release / local | Apply approved unchanged plan then register result | Partial application preserves receipt and recovery |
| A053 | Preview adoption | release / read | Inspect selected existing folder and proposed thin contract | Preserve existing instructions and tooling |
| A054 | Apply adoption | release / local | Apply approved nonconflicting operations through original owner | Stale file/root aborts affected apply |
| A055 | Choose or reconfigure built-in pattern | release / local | Preview authored versus generated file roles and selected content | Never treat a pattern as a mandatory agent persona |
| A056 | Select external template | later / external | Use approved version/source and explicit destination | Held catalog remains unavailable |
| A057 | Run doctor | release / read | Report actual workspace condition with actionable results | Diagnosis does not silently repair files |
| A058 | Inspect capabilities | release / read | Return installed supported operations and limitations | No advertised capability from unverified dependency |
| A059 | Run find | release / read | Retrieve bounded sourced context through original contract | Missing source or scope failure remains visible |
| A060 | Run check | release / read | Return original checks and receipt semantics | No clean result when a check was not run |
| A061 | Run decide | release / local | Use original decision operation and effect classification | No authority inferred from a generated recommendation |
| A062 | Run review | release / local | Use original review contract and actual evidence | Model opinion does not become passed verification |
| A063 | Run impact | release / read | Explain contract-defined affected references | Unknown impact stays unknown |
| A064 | Run control | release / local | Apply only original supported scoped control operation | Permission/refusal semantics remain unchanged |

A052 and A054 describe the release target, not a current application-adapter
permission. The issue #7 adapter previews create and adopt only. Applying to
an existing folder needs portable held custody and belongs to issues #14/#15.
The bundled standalone CLI retains the original create/adopt commands; the
existing managed New Project flow is separate.

## M08: Search and file memory

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A065 | Search file names or text | release / read | Use bounded exact search and source locations | Ignore/private policy, size and cancellation apply |
| A066 | Open a search match | release / read | Open exact path and location in requested file panel | Stale match revalidates current file |
| A067 | Search conversation contents | release / read | Query authorized retained history by content | No cross-project or revoked-source disclosure |
| A068 | Save sourced project memory | release / local | Write selected fact and provenance through file contract | No automatic promotion to shared knowledge |
| A069 | Recall memory in a new conversation | release / read | Retrieve current scoped sources and disclose supplied context | Brain-off path works |
| A070 | Correct or forget active memory | release / local | Update authoritative source and invalidate managed index references | Retained transcript/backups are not claimed erased |
| A071 | Enable or rebuild semantic index | optional / local | Keep source files authoritative and permit skip/off | Provider unavailable leaves exact search usable |

## M09: Plans and task sources

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A072 | Draft or revise a plan | later / agent | Agent proposes goals, dependencies, acceptance and evidence | Draft grants no execution permission |
| A073 | Compare or approve plan revision | later / local | Approve exact visible revision with declared scope | Changed plan requires renewed applicable approval |
| A074 | View plan graph or board | later / read | Project authoritative plan/task references | Graph view never becomes a competing task store |
| A075 | Add or edit task dependency | later / local | Write selected task source and reject cycles/stale revision | Source refusal leaves local projection unchanged |
| A076 | Move or complete a task | later / local | Validate source lifecycle and required acceptance evidence | Dragging to Done cannot fake completion |
| A077 | Connect task source | later / external | Choose supported source and grants. Preserve source IDs | Skip/off path works without an external tracker |

## M10: Workers and review

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A078 | Start bounded worker | later / agent | Bind approved task, plan, project, adapter, limits and output contract | Conflict or missing capability starts nothing |
| A079 | Delegate or follow up | later / agent | Use Native tasks and existing approval/budget scope | No second queue or duplicated task identity |
| A080 | Review candidate changes | later / read | Freeze candidate identity and inspect diff, checks and evidence | New candidate invalidates prior acceptance |
| A081 | Request bounded rework | later / agent | Keep prior evidence and explicit failure reason | No-progress or budget limit stops the loop |
| A082 | Accept or reject candidate | later / local | Record actual acceptance separately from runtime completion | Unrun checks cannot pass |
| A083 | Prepare handoff | release / agent | Gather facts. Agent updates designated document through conflict-aware write | Failure keeps previous version and shows Retry |
| A084 | Inspect handoff freshness | release / read | Compare covered revisions/events with subsequent changes | No background model call just to mark stale |

## M11: Version control and hosts

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A085 | Observe VCS state | later / read | Detect none/Git/Jujutsu only when supported | No-VCS is normal, not an error |
| A086 | Create or select checkout | later / local | Preview root, branch and isolation binding | Existing session never silently retargets |
| A087 | Commit reviewed changes | later / local | Bind exact candidate and explicit operation authority | Dirty or changed candidate requires reconciliation |
| A088 | Push or open pull request | later / external | Use chosen host and exact reviewed source | No account creation or publication inferred |
| A089 | Integrate reviewed candidate | later / external | Recheck source/target and required approvals/checks | Conflict retains candidate. Never auto-force |

## M12: Research and learning

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A090 | Research or compare alternatives | later / agent | Use same conversation with sources, uncertainty and bounded scope | No invented citations or automatic paid escalation |
| A091 | Draft writing or creative material | later / agent | Create user-requested editable artifacts with provenance where relevant | No new mandatory creative agent or implied media backend |
| A092 | Connect optional Brain | later / external | Select project/shared scope and existing connection | No automatic cross-project sharing |
| A093 | Propose lesson or skill change | later / agent | Produce evidence-backed proposal with named evaluation | Proposal cannot rewrite its own authority |
| A094 | Accept, reject or roll back lesson | later / local | Review exact change and preserve provenance | Rollback changes active skill, not historical evidence |

## M13: Intake and automation

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A095 | Inspect signed intake | later / read | Verify sender, signature, scope and deduplication | Untrusted content is data, never app authority |
| A096 | Route intake to project draft | later / agent | Use explicit routing policy and scoped conversation | Ambiguous routing waits. No outbound send |
| A097 | Send approved reply | later / external | Bind recipient, content and connection to authority | Drafting does not grant send permission |
| A098 | Enable or change schedule | later / external | Configure existing Native schedule with explicit activation | No inferred standing authority |
| A099 | Run bounded factory workflow | later / agent | Claim eligible task, run accepted stages, stop on limits | No progress, conflict or unmet gate stops dispatch |
| A100 | Run heartbeat prefilter | later / read | Use deterministic change detection and no-op suppression | Unchanged state creates no model work |
| A101 | Pause, retry or stop automation | later / local | Persist desired state using Native owner | Retry does not replay an uncertain external effect |

## M14: Host and desktop

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A102 | Launch desktop | release / local | Open bundled app and local host without Vivary signup | Startup failure has visible logs/recovery |
| A103 | Connect remote browser | release / external | Explicit authenticated client to selected self-hosted instance | No access to laptop folders through Zo by implication |
| A104 | Open live project preview | release / read | Use supported project-scoped URL and isolated frame | Untrusted preview cannot access privileged app state |
| A105 | Inspect and debug preview | release / agent | Use supported browser tools through selected agent | Unsupported integration is unavailable, not simulated |
| A106 | Close browser or app window | release / local | Persist drafts and follow declared background/lifecycle policy | Window closure never invents approval |
| A107 | Upgrade or remove app | later / local | Preview version, state compatibility and data retention | No implicit deletion of projects or account secrets |

## M15: Distribution and discovery

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A108 | Prepare distributable | release / local | Bundle required runtimes, licenses, versions and checksums | Packaging alone never proves Windows execution |
| A109 | Publish accepted artifact or website | later / external | Require exact release evidence and owner acceptance | No preview/stub claimed installable |
| A110 | Expose implemented local protocol action | later / read | Project same deterministic action through supported transport | Transport cannot bypass auth or exact scope |
| A111 | Publish protocol or discovery metadata | later / external | Use verified OpenAPI/MCP/A2A/WebMCP/auth/DNS behavior | No public endpoint/resource without authority |
| A112 | Retire selected legacy item | later / local | Inventory, preserve and verify exact target first | Separate deletion/rename authority remains required |

## M16: Evidence and contributor help

| ID | Action | Scope / mode | Required result and precondition | Failure or recovery |
| --- | --- | --- | --- | --- |
| A113 | Inspect run tools, results and usage | release / read | Display actual Native events with source identity | Missing usage is unknown, not zero |
| A114 | Open contextual help | release / read | Load bounded feature/source/contract/verification route | Help cannot claim an unsupported feature ready |
| A115 | Preserve or restore approved source | later / local | Use original preservation manifest and verified restore path | Dirty history never discarded to simplify migration |
| A116 | Run consented pilot | later / external | Measure defined outcomes on fixed source with bounded authority | No success-rate claim from synthetic tests |
