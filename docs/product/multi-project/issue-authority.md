# GitHub issue and document authority

The [program design](design.md) owns the approved product. Jeff approved the
tracker migration on 2026-09-13: GitHub `vivary-dev/Vivary-New` issues own task
goals, acceptance, dependencies, ownership, priority, and lifecycle. Documents
own architecture, code contracts, implementation guidance, and retained
evidence. The 36 outcome contracts, bounded packets, and the generated
[graph](graph.md) are synchronized references that must match the live issues;
they are not an independent dispatch queue. PR
[#328](https://github.com/vivary-dev/vivary-cli/pull/328) carries the historical
tracked plan.

Always read the live issue before work. Issue
[#29](https://github.com/vivary-dev/Vivary-New/issues/29) tracks this alignment,
[#5](https://github.com/vivary-dev/Vivary-New/issues/5) is the first reliable
project/chat state repair, and
[#7](https://github.com/vivary-dev/Vivary-New/issues/7) is the independent
desktop packaging lane. The public repository's older `priority:now` labels are
not permission to dispatch another product plan. Do not copy issue bodies back
and forth without a declared synchronization owner.

## Existing issues retained as inputs

These public `vivary-dev/vivary-cli` issues remain historical inputs. Read live
issue state before working on a linked requirement. This map does not close,
erase, or waive any accepted evidence requirement.

| Existing issue | Role in the current program | Current dispatch rule |
| --- | --- | --- |
| [151](https://github.com/vivary-dev/vivary-cli/issues/151) | Historical governed-context release map; preserve standalone package boundaries and unresolved proof | New GUI-first program controls order. Bring remaining proof into outcomes 09, 23, 24, 27, and 36 |
| [214](https://github.com/vivary-dev/vivary-cli/issues/214) | Historical decision map and links to earlier answers | Preserve decided answers unless explicitly superseded; its old “decisions before implementation” frontier does not override current implementation authority |
| [148](https://github.com/vivary-dev/vivary-cli/issues/148) | Historical platform-proof requirement | Current development uses authorized Habitat; BrowserPod is unavailable. Outcome 23 still owns supported-platform evidence |
| [211](https://github.com/vivary-dev/vivary-cli/issues/211) | Governed-loop dogfood and graduation evidence | Carry the unresolved proof into outcomes 23 and 36; check existing receipts before repeating it |
| [212](https://github.com/vivary-dev/vivary-cli/issues/212) | Repository/worktree/release hygiene | Maintenance only with ownership and preservation proof. No bulk deletion or distraction from product packets |
| [213](https://github.com/vivary-dev/vivary-cli/issues/213) | Restartable continuation and handoffs | Reconcile with outcomes 17 and 29; preserve native state owners |
| [222](https://github.com/vivary-dev/vivary-cli/issues/222) | Canonical tutorial source | Resolved and closed 2026-09-12: canonical prose stays in docs; generated site content is output-only; any interactive shell uses a distinct route under site/src/pages. Outcomes 24/25 own implementation |
| [226](https://github.com/vivary-dev/vivary-cli/issues/226) | Required token-savings benchmark definition | Outcome 36 must define corpus, comparator, units, and reproducible results before token-savings claims. It is distinct from cost-per-task pilot metrics |
| [150](https://github.com/vivary-dev/vivary-cli/issues/150) | Guides, screenshots, and evidence-backed workflows | Preserve in outcomes 24/25/36 |
| [146](https://github.com/vivary-dev/vivary-cli/issues/146) | Optional integration proof matrix | Preserve supported/skip/unavailable paths; outcomes 18/23/24 own any included capabilities |
| [140](https://github.com/vivary-dev/vivary-cli/issues/140), [20](https://github.com/vivary-dev/vivary-cli/issues/20) | Local typed-vector communities | Reviewed implementation and CLI evidence are on the private GUI branch. Public integration/release remains pending product acceptance; these issues stay open until that delivery is available |
| [159](https://github.com/vivary-dev/vivary-cli/issues/159) | Repository health findings | Keep findings separate from product completion; act only on relevant current evidence |

## GitHub Issues as the execution ledger: approved 2026-09-13

Where an issue maps to an outcome or packet, keep the stable ID in its title
and record the mapping. Architecture, contracts, and implementation guidance
remain linked canonical documents. Issue status, assignee, dependencies, and
evidence links are authoritative. Refresh the existing generated graph after
linked packet metadata changes, keeping its current format as a derived reference. No agent may silently maintain conflicting
Markdown and issue statuses. A routine issue needs no packet ceremony before it
starts. Update active implementation guidance when its issue changes. Preserve
retired packets and historical evidence.

2026-09-05 live reconciliation: issues 151 and 214 now point to this program and
no longer carry `priority:now`. Issue 148 explicitly excludes WSL for this work.
Their original bodies are preserved, no issue was closed, and PR #328 is `active`.
