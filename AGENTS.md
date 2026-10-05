# Vivary agent instructions

## Active repository and product acceptance

Jeff selected this complete new repository on 2026-09-13. It was
`vivary-dev/Vivary-New` from that date, started private, was public when checked
on 2026-09-24, and was renamed `vivary-dev/vivary` on 2026-09-30. The original
CLI repository is `vivary-dev/vivary-cli`. His later branching correction
selects typed topic
branches from `dev`, PRs into `dev`, and reviewed promotion from `dev` to `main`.
Do not commit directly to either long-lived branch. `main` is the default branch.
The `origin` remote is that GitHub repository. The `entire` remote is its Entire
mirror. Push reviewed source to both. Preserve the previous repositories and
history. This supersedes the earlier Entire-only `feat/vivary-gui` restriction.

The original public `vivary-dev/vivary-cli` repository and its `dev` branch are not
this development target. Publication, releases, and changes to the public product
still require Jeff's explicit acceptance. A working component does not establish
a finished product.

Vivary is a desktop and self-hosted web product. One instance runs on a
user-controlled computer or suitable server. The desktop and responsive browser
clients use that host's agents, files, credentials, and history. Local desktop
opens without a Vivary account. Remote browser access is explicit and authenticated.
Zo is the development and private preview host. Preserve existing preview evidence
and original Vivary contracts. Reuse Native execution and connectors.

Read [ENGINEERING.md](ENGINEERING.md). It is the governing engineering policy.
Older packet and runtime instructions cannot restore heavier process defaults.

## How we work

Jeff set this working style on 2026-10-05. It operates inside ENGINEERING.md and
the external-action gates in Delivery and authority.

- **Own the outcome.** Carry a chosen issue from understanding to a tested,
  reviewed PR that Jeff can inspect, merge, or return with requested changes, then
  through his review to closure. Make routine technical decisions yourself and
  record the reason where reviewers will see it.
- **Ask at real forks.** Bring Jeff a concise choice when scope changes
  materially, a risk is consequential or hard to reverse, or a trade-off needs his
  product judgment. Otherwise decide and keep moving.
- **Explore boldly, ship narrowly.** Unusual ideas are welcome when they could make
  Vivary clearly better. Prototype cheaply, keep what earns its place, and split
  what must ship now from follow-ups so discovery helps finish the release.
- **Self-correct.** Treat a failed check, a review finding, or a surprising
  measurement as information. Find the root cause, fix it, rerun the affected
  check, and state plainly what was wrong and what changed.
- **Prove improvement with measurements.** Before claiming an improvement, record
  a reproducible baseline proportionate to the claim. For performance, include the
  conditions, cold and warm runs, realistic small and large data, and sample counts.
  Change one thing, compare against the same baseline, and keep or revert on that
  evidence. Report real numbers, including regressions.
- **Check the environment first.** Before the first install, build, or heavy run
  in a new execution context, verify the runtime, package manager, installed
  dependencies, and sandbox limits there. Fix setup before expensive work starts.
- **Feel it in the product.** Fix what a person would notice in the built app even
  when tests pass.
- **Model roles.** GPT-6.1 Sol at xhigh reasoning effort implements. Claude Opus 5.5
  coordinates and performs independent reviews in separate subagents or sessions
  that do not edit the change.

## Working practices: Zo, CI, and clean checkpoints

Jeff confirmed these practices on 2026-09-16. They apply to this repository.

- Work over `ssh -o BatchMode=yes zo` in the existing checkout at
  `/home/workspace/Projects/vivary-integration`. Read the named Zo handoff first.
  Keep source edits, builds, automated tests, hosted QA, and continuity on Zo.
  Do not create a Windows development clone. A local handoff is supplementary.
- Run CI on Zo. Zo is the standing owner-approved CI host, including when GitHub
  Actions cannot start because of billing or runner availability. Execute the
  applicable commands and gates from `.github/workflows/ci.yml` against the exact
  candidate commit. Reuse the existing pinned tools and runners. Fix failures and
  rerun affected checks. Do not wait for GitHub billing to resume this work.
- Record the tested commit, commands, results, logs, and any platform-specific
  omissions. Report Zo CI separately from GitHub Actions. A failed or unrun job
  never becomes a pass by changing hosts. Passing applicable Zo CI can satisfy
  the CI gate together with required review and product acceptance.
- Reserve Windows for checks requiring the packaged application. Build on Zo,
  verify the downloaded artifact, then use Computer Use and screenshots to test
  the real EXE. Verify actual tools, files, approvals, Stop, persistence, cleanup,
  and visual fidelity. Plan a complete journey, observing after each dependent
  action. Separate simulated protocol checks from real model and tool execution.
- Keep one current local test version. After its replacement passes, remove exact
  superseded package folders and archives. Preserve user profiles, credentials,
  fixtures, and evidence. Make source fixes on Zo and rebuild there.
- Use the existing supported coding runtime's subscription, tools, skills, and
  configured connections. Do not assemble a duplicate tool system in Vivary.
  Use GPT-6 Astra for this integration's own model calls unless Jeff explicitly
  changes that choice. Agent roles are in How we work. OpenCode remains a separate
  integration.
- Carry an authorized slice through implementation, review, fixes, automated
  checks, and affected real UI testing. Routine reversible work needs no new
  phase confirmation. Do not merge or publish merely because tests pass.
- Aim for a complete, usable checkpoint before usage is exhausted. Check usage
  between bounded work waves. Jeff's stop boundary is 1% remaining. Reserve enough
  capacity to finish the current unit, stop task-owned jobs, update the canonical
  handoff and acceptance docs, commit reviewed work, push GitHub and Entire, and
  verify matching remote refs and a clean checkout. Do not start another large
  unit if it would leave unfinished work at the boundary.
- Preserve Windows Defender and file associations. Dismiss unexpected Open With
  prompts and fix their launcher cause. Do not disable protection, add broad
  exclusions, or change associations as a workaround.

## Team and visual testing

Jeff clarified on 2026-09-12: use up to three concurrent subagents as useful for
implementation, research, independent review, and documentation. Keep one owner
per shared file and coordinate through the primary agent. Keep one heavy build,
browser, or model job active at a time.

Jeff clarified the testing sequence on 2026-09-13: implement on Zo and test the
latest application changes through the existing private hosted Zo version first.
Then build Electron packages for further local testing on his laptop. This
replaces the earlier blanket restriction of all runtime testing to Zo. See the
[testing decision](docs/product/multi-project/design.md#hosted-and-desktop-testing-decision-2026-09-13).

Exercise completed UI flows extensively: real desktop and narrow layouts,
keyboard interactions, empty/error states, navigation, persistence, and actual
tool results. Fix a failure and repeat the affected journey. Then continue the
product work. Do not turn visual testing into new verification infrastructure,
repeat unrelated checks, or change historical evidence and budgets.

Local desktop use requires no Vivary account or signup and stays on loopback by
default. Remote browser access to the same host requires explicit setup and owner
authentication. The private Zo service keeps its existing owner-login boundary.
Internal Native session identity still scopes actions and records. Model-provider
login remains separate from access to Vivary.

## Start with the product

Jeff's 2026-09-13 target is a working `Vivary.exe` with project workspaces,
searchable persistent sessions, file memory, fast project search, and the original
Vivary operations, plus responsive browser access and live project preview/debugging. Follow [the desktop release queue](docs/product/multi-project/desktop-release.md).
Keep at most two independent implementation issues active. Select the next ready
issues from the live release milestone after checking accepted and held work. Keep the existing 36 outcomes as coverage, not parallel
workstreams. Do not mark the desktop finished from packaging or CI alone.

Jeff approved GitHub issues as the execution ledger on 2026-09-13. Issues in
`vivary-dev/vivary` own task goals, acceptance, dependencies, ownership,
priority, and lifecycle. Documents own architecture, code contracts,
implementation guidance, and retained evidence. Packets and the generated
frontier are synchronized references; refresh them when a linked issue changes,
but a routine issue needs no packet before it starts. Read the live issue before
work. Issue [#29](https://github.com/vivary-dev/vivary/issues/29) tracks this
alignment. State repair [#5](https://github.com/vivary-dev/vivary/issues/5) and
runtime packaging [#7](https://github.com/vivary-dev/vivary/issues/7) are accepted.
[Project sessions #6](https://github.com/vivary-dev/vivary/issues/6) records
verified project conversations, Native persistence, and history controls.
[Windows first-launch #8](https://github.com/vivary-dev/vivary/issues/8)
has accepted candidate evidence in the
[Windows receipt](docs/product/multi-project/receipts/23b-windows-desktop-acceptance.md).
The [desktop acceptance register](docs/product/multi-project/desktop-acceptance-status.md)
separates that result from the remaining full-release gates under #23. Follow
[the issue-led delivery rule](ENGINEERING.md#issue-led-delivery). A new active
task must advance this release or fix a demonstrated blocker. Broader product
outcomes retain their later milestones and evidence.

Read the claimed issue, then [the current frontier](docs/product/multi-project/index.md)
and any linked packet for implementation guidance and evidence.
[The execution contract](docs/product/multi-project/execution-contract.md)
owns program metadata and delivery details. Implement one coherent slice
through the real application.

Use the workspace and execution environment authorized for the task. Reuse the
current checkout and handoff when provided. Inspect live Git and preserve dirty
work before editing. Keep one writer per shared file.

Use existing implementations and tests. Run the cheapest relevant checks,
exercise the actual application, fix failures, and review the diff.
Use another reviewer when the risk or complexity warrants it.

Before unusually heavy work, check memory and disk. Keep one heavy job active,
bound runaway processes, and clean up task-owned servers, browsers, and children.
Normal tests need ordinary timeouts and cleanup.

Invoke [high-assurance mode](docs/verification/high-assurance-mode.md) only for a
named dangerous failure. Select controls for that risk.

## Delivery and authority

Follow [CONTRIBUTING.md](CONTRIBUTING.md). Branch from current `origin/dev`,
use a typed topic branch, and open a PR into `dev`. Review and verify each
increment before committing and pushing to GitHub and Entire.
Never create draft PRs. Open PRs ready for review.
Do not promote this work into the original repository or its release branches.

Make small, coherent, reviewed commits. Preserve unrelated work, accepted
evidence, and historical budgets. Keep private handoffs, credentials, transcripts,
and machine-specific continuity notes outside public source and Git history.
Source hosting does not establish agent-session capture. Follow
[the Entire contributor setup](docs/ENTIRE.md) before supported agent work.
Verify enabled hooks and the private checkpoint destination. Use Entire session
and checkpoint commands to confirm capture, then search prior checkpoints when
past decisions matter. Never claim MCP controller edits were captured locally.

Use the user's existing authorization. Complete reversible preparation before
requesting any missing approval for pushes, PR creation, merges, publication,
account changes, paid calls, scheduled activation, outbound messages, or
destructive actions.
A material scope or authority change needs alignment before that action.
Do not modify the read-only source repositories loam, braincheck, throughline,
or flywheel.

Follow [the release workflow](docs/RELEASE-WORKFLOW.md) when release operations
apply. Source implementation and passing tests do not establish publication.
[The original CLI reference](docs/ORIGINAL-CLI.md#release-status) owns package release status.

## Contributor readability

Jeff confirmed on 2026-09-13 that another contributor is joining. Write code that
someone new can follow. Keep responsibilities in their existing owner modules,
use names that explain purpose, and keep functions focused. Add comments for
non-obvious decisions and contracts. Avoid narration, speculative abstractions,
duplicate checks, and wrappers that only pass arguments. Explain unfamiliar
primitives in the contributor guide when they affect implementation choices.
Review the diff for readability before committing.

## High-level design maintenance

Read [the canonical HLDD](docs/ARCHITECTURE.md) before implementation.
Use [maintain-hldd](.agents/skills/maintain-hldd/SKILL.md) when changing source,
configuration, architecture, or durable product documentation. Stage the design
update with the source change. The pre-commit and CI checks enforce this review.
Keep owner intent and editorial remarks intact. The application bundles this
same document in Settings > Documentation.

## Keep knowledge useful

Use the [source map](docs/product/multi-project/source-map/index.md) when work
crosses project identity, root custody, runtime, or project writes.
Read [the architecture](docs/ARCHITECTURE.md) when a design decision needs it.
Reuse existing Native owners and installed dependencies. Review relevant
deny-lists and advisories before adding packages.

Update durable docs when behavior, architecture, contracts, or lasting
constraints change. Give each fact one owner and refresh generated views when
their inputs change. Keep the existing handoff concise. Failed or unrun
verification remains incomplete regardless of a policy change.
