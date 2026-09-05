# Planning audit and current execution risks

Recorded: 2026-09-05. This audit checks the plan's ability to guide work; it is
not product acceptance, a security certification, or a release result.

## Findings and dispositions

| Finding | Correction | Evidence or remaining owner |
| --- | --- | --- |
| Empty frontier and output files required before their own creation | Separate 36 outcome contracts from bounded packets; outputs are deliverables; independent contract packets can start | Generated graph, execution contract, packets 02a/03a/10a/10b, CI guard |
| Every future feature marked as missing information | Outcomes use planned/in-progress/done; only an exact packet prerequisite uses needs-info | Guard checks status and named Needs |
| Human PR review treated as blanket permission for preparatory work | Keep merge approval separate; contracts and fixtures use existing implementation authority | Execution contract and independent packet dependencies |
| BrowserPod proof scheduled after migration and architecture choices | Move compatibility inspection and the first live pod probe ahead of import | 10a and 10b; actual toolchain proof remains open |
| Historical implementation hidden by “not started” logs | Record preserved host/readiness work and historical verification; leave real BrowserPod and native runtime proof open | Native owner inventory and outcome 10 log |
| Optional connectors appear to block every start | Outcome edges gate full completion; packet edges gate starts; native/skip paths can proceed independently | Capability matrix and execution contract; full optional release coverage retained |
| Existing native tasks, sessions, plans, messaging, and automations omitted | Add an explicit native-owner inventory and require reuse before adding state | Native owners and source references |
| Manual graph could drift while checks stayed green | Generate table, completion edges, active packets, and frontier from the same records | Graph renderer and adversarial guard fixtures |
| Scope preservation checked only as ticket count | Validate 36 outcome owners and S-00A plus every S-00 through S-13 mapping | Capability matrix and guard |
| Old GitHub maps and local handoffs advertised another frontier | Canonical authority map; preserve old bodies and decisions as history; route active entry points to this program | Issue authority map and PR #328; do not dispatch a legacy issue by its old priority alone |

## Risks that still need implementation evidence

| Risk | Smallest next evidence | What it blocks |
| --- | --- | --- |
| Native Node modules, native coding CLIs, and Python may not run in BrowserPod | Actual capability/exit-code matrix on a synthetic fixture | Only operations needing those tools, not contracts or fixture preparation |
| BrowserPod disk is not automatically the user's existing project folder | Trace selected project to execution copy and guarded write-back, using supported native transfer primitives first | Real brownfield mutation and save claims |
| Browser origin and storage key are not a user authorization boundary | Two synthetic users, scoped key selection, denied cross-user requests, and reload recovery | Multi-user and persistence claims |
| Workbench source and old assets need path-specific rights and restore proof | Private source manifest, license disposition, byte restoration, and history receipt | Real-source import/publication and any retirement |
| Cross-origin isolation may affect login, sidebar, or preview | Browser regression checks on the exact selected origin | Broad header change and deployment |
| Factory, mailbox, and heartbeat need real authority and disconnect behavior | Deterministic fixtures first; approved configured activation later | Live unattended or outbound operations |
| Earlier token-savings benchmark and dogfood commitments can get lost | Bind old issue requirements to outcomes 36, 23, and 24 | Comparative claims and final release acceptance |
| The real scanner is still Level 1/5 | Implemented services plus a live all-checks 100% result | Release readiness and agent-ready announcements |

No observed BrowserPod behavior, source restoration, new artifact release, or
100% result is claimed. New findings repair the owning packet and its evidence;
they do not silently change product direction or stop unrelated ready work.

## Verification checkpoint

[CI](https://github.com/vivary-dev/vivary/actions/runs/33990271792) passed all jobs, including the 17 adversarial planning-guard tests,
graph validation, line endings, diff hygiene, site build, and Windows checks.
That audit completed outcome 01 and inspection packets 02a and 10a.
[03a's later receipt](receipts/03a-registry-contract.md) records completed registry
contract inspection. Current dispatch belongs to [the generated graph](graph.md).
These results do not prove the 33 restoration cases;
02b must execute them in the authorized Habitat fallback established by 10c.
10b retains the separate BrowserPod-specific capability proof.

The [HoH comparison](research/hoh-alignment.md) adds acceptance refinements
without advancing implementation status. Runtime-enforced roles, frozen
candidates, claim-level QA, and evidence-fed replanning remain unverified.

[03b](receipts/03b-registry-contract-model.md) now records actual Habitat model
verification and independent QA corrections. Its results do not establish the
production HoH cycle or filesystem enforcement. The next executable packet is
02b; independent transaction mapping is prepared as 03c.
