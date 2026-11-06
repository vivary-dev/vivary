# Architecture and UX diagrams

Snapshot of `dev` at `4032e969cd6bafd3061c29508850c7013f714c1a`, prepared on 2026-09-28 UTC.
The [canonical architecture](../../../ARCHITECTURE.md) and its linked contracts own product behavior and acceptance status.
These diagrams distinguish the documented design from unfinished capabilities. They do not establish release acceptance.

Download [the editable tldraw document](vivary-architecture-and-ux.tldraw) and open it in tldraw Desktop.
Its page menu contains the six diagrams below. All 116 arrows remain bound at both ends.
The original six pages passed tldraw layout and connector lint checks on 2026-09-28.
On 2026-09-29, pages 03, 04, and 06 were corrected and re-rendered from the document's shape and binding records.
Pages 03, 04, and 06 received the additional reviewed flow corrections on 2026-09-30.
The edited records passed tldraw schema migration/validation and connector/flow checks;
all six images were visually checked for private values and consistency with the source.
The planning checker pins the exact reviewed source and export hashes. Any asset change
requires visual/source review and an intentional pin update; unknown or mismatched exports fail.
Desktop layout lint was not rerun.

Sources: [architecture](../../../ARCHITECTURE.md), [workspace interactions](../unified-workspace.md),
[desktop release](../desktop-release.md), [automation lifecycle](../receipts/51-automation-lifecycle.md),
[webhook automations](../receipts/113-webhook-automations.md), and [acceptance register](../desktop-acceptance-status.md).

## 01. System architecture

![System architecture](01-system-architecture.jpg)

## 02. Engine ownership

![Engine ownership](02-engine-ownership.jpg)

## Review corrections (2026-09-29 and 2026-09-30)

- Resume preserves the existing runtime and native session reference; only a new conversation chooses a runtime
- Denial returns to running activity, rather than declaring a terminal run outcome
- Stop remains available from the pending-request state
- Delete removes the automation definition and run rows and ends that lifecycle, while internal job thread rows remain

- Run inspection uses automation history; retained job thread rows are not openable from Settings or chat history
- Missing-folder recovery keeps history readable only under a valid grant; denied/revoked access protects transcript and file content
- Rejected webhook tokens and duplicate event IDs end without queueing a run
- Question/form requests collect the required answers and Continue separately from permission approval
- Event triggers enter condition/configuration checks and retain their snapshot acceptance limitation
- Pause holds the stored definition outside automatic dispatch; Resume re-enables it
- Only scheduled dispatches compute a next scheduled run; Run now preserves it, and event/webhook dispatches have none

These corrections preserve the dated snapshot; they are not a full refresh to the latest development state.

## 03. Start a project

![Start a project](03-start-a-project.jpg)

## 04. Work and recover

![Work and recover](04-work-and-recover.jpg)

## 05. Files and memory

![Files and memory](05-files-and-memory.jpg)

## 06. Automation lifecycle

![Automation lifecycle](06-automation-lifecycle.jpg)
