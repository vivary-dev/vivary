# Vivary multi-project ticket graph

Updated: 2026-09-05

Program: [design](design.md), [evidence](evidence.md), [migration](migration.md),
[release](release.md), and [terms](CONTEXT.md).

This graph plans the complete Vivary evolution. It preserves Littleagent S-00A and
S-00 through S-13, standalone Vivary, templates, integrations, public delivery, and
deferred legacy retirement. The first usable milestone does not narrow later scope.

Frontier: none. Ticket 01 is ready for human review of the documentation pull
request only. Earlier Littleagent implementation authority remains applicable only
where the accepted ticket 01 boundary reconciles it with the changed contracts.

## Tickets

| Ticket | Status | Outcome | Blocked by |
| --- | --- | --- | --- |
| [01](tickets/01-reconcile-migration-boundaries.md) | ready-for-human | Reconcile provenance and boundaries | [] |
| [02](tickets/02-prove-source-preservation.md) | needs-info | Prove source preservation | 01 |
| [03](tickets/03-define-project-registry.md) | needs-info | Define registry and authority | 01 |
| [04](tickets/04-define-runtime-session-contracts.md) | needs-info | Define runtime and session contracts | 02, 03 |
| [05](tickets/05-integrate-workbench-shell.md) | needs-info | Integrate the workbench shell | 02, 03 |
| [06](tickets/06-register-and-switch-projects.md) | needs-info | Register and switch projects | 03, 05 |
| [07](tickets/07-create-new-projects.md) | needs-info | Create new projects | 03, 06 |
| [08](tickets/08-adopt-existing-projects.md) | needs-info | Adopt existing projects | 03, 06 |
| [09](tickets/09-preserve-headless-parity.md) | needs-info | Preserve headless parity | 04, 07, 08 |
| [10](tickets/10-prove-native-runtime.md) | needs-info | Prove a native runtime | 04 |
| [11](tickets/11-finish-workspace-editor.md) | needs-info | Finish conflict-safe editing | 05, 06, 08 |
| [12](tickets/12-implement-vcs-identity-adapters.md) | needs-info | Support none, Git, and Jujutsu | 03, 06 |
| [13](tickets/13-connect-repository-hosts.md) | needs-info | Connect optional repository hosts | 07, 12 |
| [14](tickets/14-integrate-task-sources.md) | needs-info | Integrate optional task authorities | 03, 12 |
| [15](tickets/15-deliver-plans-and-kanban.md) | needs-info | Deliver plans and kanban | 05, 12, 14 |
| [16](tickets/16-run-verified-workers.md) | needs-info | Run verified workers | 04, 10, 12, 14, 15 |
| [17](tickets/17-deliver-recovery-review-handoffs.md) | needs-info | Recover and resume sessions | 04, 11, 12, 14, 15, 16 |
| [18](tickets/18-add-scoped-brain-learning.md) | needs-info | Add Brain and reviewed learning | 03, 05 |
| [19](tickets/19-integrate-template-program.md) | needs-info | Integrate the held template program after prerequisites | 07, 08, external program |
| [29](tickets/29-deliver-review-integration-handoffs.md) | needs-info | Review, integrate, and hand off | 04, 11, 12, 14-17 |
| [20](tickets/20-run-bounded-factory.md) | needs-info | Run bounded factory work | 04, 10, 14-17, 29 |
| [21](tickets/21-add-research-specialists.md) | needs-info | Add research specialists | 04, 15, 16, 18 |
| [22](tickets/22-add-intake-and-maintenance.md) | needs-info | Add signed email intake | 04, 10, 18 |
| [30](tickets/30-add-heartbeat-maintenance.md) | needs-info | Add heartbeat maintenance | 04, 10, 18 |
| [36](tickets/36-measure-pilot-outcomes.md) | needs-info | Measure S-13 pilot outcomes | 10, 16-22, 29, 30 |
| [23](tickets/23-package-and-prove-app.md) | needs-info | Prove installed application behavior | 09, 10, 13, 29 |
| [24](tickets/24-write-product-docs-guides.md) | needs-info | Write installed docs and guides | product tickets and pilot |
| [25](tickets/25-update-public-website.md) | needs-info | Update the public website | 23, 24 |
| [26](tickets/26-publish-real-agent-protocols.md) | needs-info | Publish a real read-only API and OpenAPI | 23-25 |
| [31](tickets/31-implement-auth-discovery.md) | needs-info | Implement auth discovery and scopes | 26 |
| [32](tickets/32-publish-hosted-mcp.md) | needs-info | Publish hosted MCP | 26 |
| [33](tickets/33-publish-a2a-service.md) | needs-info | Publish A2A | 26, 31 |
| [34](tickets/34-publish-browser-tools.md) | needs-info | Publish browser tools | 26, 31 |
| [35](tickets/35-complete-web-agent-discovery.md) | needs-info | Complete web and DNS discovery | 25, 26, 31-34 |
| [27](tickets/27-deploy-release-and-pass-readiness.md) | needs-info | Release and pass the actual 100 percent gate | release dependencies |
| [28](tickets/28-retire-legacy-assets.md) | needs-info | Review deferred retirement per item | 27 |

Ticket 19 depends on the six outcomes in the [external dependency
contract](external-dependencies.md#held-template-installer-program). The repository
owner must explicitly lift the implementation hold, the outcomes must have evidence,
a canonical approved source packet must exist, and a compatible installed API must be
available. This named condition avoids a dangling ticket ID and keeps the full
template program out of the wrapper ticket.

Tickets 13, 26, 27, 28, 31, and 35 contain later external actions or choices. Their
dependencies remain open, so each has `needs-info` status. When one exact outward
action becomes the only remaining work, change its status to `ready-for-human` and
name that action. Do not batch approvals.

## Dependency view

```mermaid
graph TD
 T01[01 Boundaries] --> T02[02 Preservation]
 T01 --> T03[03 Registry]
 T02 --> T04[04 Runtime contracts]
 T03 --> T04
 T02 --> T05[05 Workbench shell]
 T03 --> T05
 T03 --> T06[06 Projects]
 T05 --> T06
 T03 --> T07[07 Create]
 T06 --> T07
 T03 --> T08[08 Adopt]
 T06 --> T08
 T04 --> T09[09 Headless]
 T07 --> T09
 T08 --> T09
 T04 --> T10[10 Native runtime]
 T05 --> T11[11 Editor]
 T06 --> T11
 T08 --> T11
 T03 --> T12[12 VCS]
 T06 --> T12
 T07 --> T13[13 Hosts]
 T12 --> T13
 T03 --> T14[14 Task sources]
 T12 --> T14
 T05 --> T15[15 Plans]
 T12 --> T15
 T14 --> T15
 T04 --> T16[16 Workers]
 T10 --> T16
 T12 --> T16
 T14 --> T16
 T15 --> T16
 T04 --> T17[17 Recovery]
 T11 --> T17
 T12 --> T17
 T14 --> T17
 T15 --> T17
 T16 --> T17
 T03 --> T18[18 Brain]
 T05 --> T18
 T07 --> T19[19 Template wrapper]
 T08 --> T19
 XTI[External template program done and hold lifted] --> T19
 T04 --> T29[29 Review and handoff]
 T11 --> T29
 T12 --> T29
 T14 --> T29
 T15 --> T29
 T16 --> T29
 T17 --> T29
 T04 --> T20[20 Factory]
 T10 --> T20
 T14 --> T20
 T15 --> T20
 T16 --> T20
 T17 --> T20
 T29 --> T20
 T04 --> T21[21 Research]
 T15 --> T21
 T16 --> T21
 T18 --> T21
 T04 --> T22[22 Email]
 T10 --> T22
 T18 --> T22
 T04 --> T30[30 Maintenance]
 T10 --> T30
 T18 --> T30
 T10 --> T36[36 Pilot]
 T16 --> T36
 T17 --> T36
 T18 --> T36
 T19 --> T36
 T20 --> T36
 T21 --> T36
 T22 --> T36
 T29 --> T36
 T30 --> T36
 T09 --> T23[23 Packaging]
 T10 --> T23
 T13 --> T23
 T29 --> T23
 T05 --> T24[24 Docs]
 T07 --> T24
 T08 --> T24
 T09 --> T24
 T10 --> T24
 T11 --> T24
 T15 --> T24
 T16 --> T24
 T17 --> T24
 T18 --> T24
 T19 --> T24
 T20 --> T24
 T21 --> T24
 T22 --> T24
 T23 --> T24
 T29 --> T24
 T30 --> T24
 T36 --> T24
 T23 --> T25[25 Website]
 T24 --> T25
 T23 --> T26[26 API and OpenAPI]
 T24 --> T26
 T25 --> T26
 T26 --> T31[31 Auth]
 T26 --> T32[32 MCP]
 T26 --> T33[33 A2A]
 T31 --> T33
 T26 --> T34[34 Browser tools]
 T31 --> T34
 T25 --> T35[35 Web discovery]
 T26 --> T35
 T31 --> T35
 T32 --> T35
 T33 --> T35
 T34 --> T35
 T13 --> T27[27 Release and 100 percent]
 T23 --> T27
 T24 --> T27
 T25 --> T27
 T26 --> T27
 T31 --> T27
 T32 --> T27
 T33 --> T27
 T34 --> T27
 T35 --> T27
 T36 --> T27
 T27 --> T28[28 Retirement review]
```

## Status rule

Tickets are authoritative. Update this graph after each transition. A ticket becomes
`done` only after its Verify section passes and its Log records the result. Retirement
remains deferred until ticket 27 passes and the repository owner decides each item's disposition.
