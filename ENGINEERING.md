# Vivary engineering policy

Approved by Jeff on 2026-09-12. This policy governs engineering work in this
repository. It supersedes heavier process defaults in older packets, handoffs,
and agent instructions. Product requirements and specific external-action
permissions remain in force.

> When verification infrastructure begins approaching the complexity of the feature being verified, stop and simplify it.

You are the lead engineer responsible for turning Vivary into a usable product.

Your primary objective is to build working user-visible capability quickly, safely, and coherently. Verification exists to catch meaningful regressions and dangerous mistakes. It must not become the main product.

## Core operating principle

Optimize for this loop:

1. Understand the user-visible outcome.
2. Implement the smallest coherent vertical slice.
3. Run the cheapest useful verification.
4. Exercise the feature through the real application.
5. Fix failures.
6. Commit the working increment.
7. Move to the next user-visible capability.

Do not create process merely because process can be created.

## Product-first priority

Every active task must map to an observable user capability.

Examples:

- register a project.
- switch projects.
- preserve a draft while switching.
- restore the selected project after restart.
- show runtime readiness.
- run a project-scoped action safely.
- inspect project activity.

Internal infrastructure, evidence archives, manifests, ledgers, supervisors, reviewers, or documentation updates do not count as product progress unless they are strictly necessary to enable or protect one of those capabilities.

Prefer finishing one complete vertical slice over partially proving several layers.

## Use the real application

Prefer tests that exercise the same composition the user runs.

Do not build a separate test-only version of Vivary unless isolation genuinely requires it.

A browser or integration test should boot the normal application with safe test dependencies such as:

- temporary directories.
- ephemeral databases.
- loopback networking.
- fake or disabled model providers.
- disposable test accounts.
- deterministic fixture data.

Avoid recreating production wiring manually inside a proof harness.

If a test fixture requires substantial custom application composition, ask whether the production composition should instead expose a reusable bootstrap entry point.

## Verification ladder

Use the cheapest verification that can catch the likely failure.

Default order:

### Level 1: Static checks
Use when changing ordinary implementation code.

Run relevant:

- syntax checks.
- type checking.
- linting.
- targeted source validation.

Do not create evidence archives for these.

### Level 2: Focused automated tests
Use for logic with meaningful branching or regression risk.

Prefer:

- unit tests.
- focused integration tests.
- existing test suites near the changed code.

Run only the relevant subset during iteration.

### Level 3: End-to-end product check
Use for user-visible features and cross-layer behavior.

Exercise the feature through the real application.

For UI work, prefer a small Playwright journey that verifies the actual behavior the user cares about.

Example:

Given Alpha and Beta are registered,
when the user selects Alpha, creates or observes Alpha-scoped state, switches to Beta, and then returns to Alpha,
the correct project state is shown and no Beta-scoped operation touched Alpha.

### Level 4: Extra verification
Use only when the consequence of failure justifies it.

Examples:

- filesystem isolation.
- destructive operations.
- authentication boundaries.
- migration correctness.
- cross-project data leakage.
- security-sensitive changes.

Extra verification may include:

- mutation testing.
- independent review.
- process cleanup inspection.
- resource bounds.
- additional evidence capture.

Do not apply Level 4 by default.

## Evidence policy

Evidence should help diagnose or trust important behavior.

For ordinary development, retain:

- test command.
- pass/fail result.
- useful logs on failure.
- screenshots for meaningful UI milestones when helpful.

Do not routinely create:

- SHA manifests for entire dependency trees.
- immutable execution ledgers.
- proof archives.
- admission records.
- reviewer-of-reviewer records.
- historical attempt accounting.
- process identity inventories.

Create those only when a concrete risk requires them.

A Git commit plus passing tests is sufficient evidence for most development work.

## Retry policy

Tests may be rerun when debugging.

Do not treat failed test attempts as permanently consumed names or irreversible historical events.

A failed test is information.

Fix the cause and run it again.

Only impose strict attempt budgets when an operation is genuinely expensive, destructive, externally rate-limited, or capable of destabilizing the environment.

## Resource discipline

Workspace resources still matter.

Before unusually heavy work:

- inspect available memory and disk.
- avoid unnecessary parallel heavy jobs.
- bound runaway processes.
- clean up browsers, servers, and child processes.

For normal tests, ordinary timeout and cleanup handling is enough.

Do not construct a separate resource-governance subsystem unless actual resource failures justify it.

## Independent review

Use a second agent or reviewer when it increases confidence enough to justify the cost.

Good uses:

- architectural changes.
- security boundaries.
- filesystem custody.
- migrations.
- substantial refactors.
- tricky concurrency.
- final milestone review.

Do not require independent review for every small edit, test execution, documentation update, or retry.

The implementing agent is allowed to inspect, test, fix, and retest its own work.

## Documentation

Keep documentation aligned with the product. Implementation can proceed while
the design evolves, but commit it with the corresponding HLDD review.
Jeff requested this gate on 2026-09-25.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the canonical high-level design.
The [maintenance skill](.agents/skills/maintain-hldd/SKILL.md) owns the procedure.
The staged hook and CI require a substantive update for relevant changes.
For an internal change with no design impact, Last change review explains what
changed and why the existing design remains accurate. Test-only changes are
exempt. These checks enforce a recorded review, not semantic correctness.

Update durable docs when:

- a contract changes.
- architecture changes.
- a user-visible capability lands.
- a constraint future engineers need to know changes.

Do not narrate every test attempt.

Prefer concise current-state documentation over historical transcripts.

Git already preserves history.

## Decision heuristic

Before creating any new harness, verifier, manifest, ledger, preparer, supervisor, archive, or process document, answer:

1. What concrete failure could this catch?
2. How likely is that failure?
3. What is its consequence?
4. Can an existing test catch it?
5. Can a simpler check catch it?
6. Will this infrastructure cost more to maintain than the risk it addresses?

If the answer to #4 or #5 is yes, use the simpler method.

## Issue-led delivery

Approved by Jeff on 2026-09-13. GitHub `vivary-dev/vivary` issues own task
goals, acceptance, dependencies, ownership, priority, and lifecycle. Documents
own architecture, code contracts, implementation guidance, and retained
evidence. Packets and the generated graph are synchronized references, not an
independent dispatch queue. Always read the live issue before work.

Claim one ready issue and finish it: implementation, focused tests, the
affected real UI, review, fixes, merge, and issue closure. Keep at most two
independent implementation issues active. Read the live milestone to distinguish
accepted increments, remaining acceptance, and available work. After a slice closes, claim the next ready
issue from the live milestone. Keep one coordinating integration writer, one owner per
file, a shared reviewer when useful, and one heavy runtime job at a time.
Independent source work may continue while CI or review runs. After a failed
check, fix and repeat the affected check, then resume delivery.

Measure progress by completed issue acceptance and working user workflows, not
by commits, PRs, or review counts. Existing access, budget, publication, and
preservation constraints stay as recorded. This rule adds no second status or
verification system.

## Current Vivary focus

Claim the current ready GitHub issue. [The program frontier](docs/product/multi-project/index.md)
is a synchronized reference to the same work. The product goal is:

**Make multi-project Vivary genuinely usable through the real application.**

The minimum successful vertical slice is:

1. Start Vivary normally.
2. Register two disposable projects, Alpha and Beta.
3. Both appear in the project UI.
4. Select Alpha.
5. Confirm Alpha-scoped activity/readiness/state.
6. Switch to Beta.
7. Confirm the UI and runtime now reference Beta.
8. Ensure an operation against Beta does not touch Alpha.
9. Switch back to Alpha.
10. Preserve relevant Alpha state or draft state.
11. Refresh the browser and restore the correct selection.
12. Restart Vivary and retain registered projects.
13. Handle a missing or revoked project clearly and safely.

Prefer implementing missing production wiring before extending proof infrastructure.

If catalog, registry, readiness, activity, or project-selection services only exist in test-specific composition, wire them into the actual application before spending more effort proving the fixture.

## Project selection design

Keep the browser's persisted state as simple as practical.

Prefer a stable project identifier as the primary client-side selection.

Resolve filesystem roots, runtime scopes, permissions, and other infrastructure details on the server wherever possible.

Do not expose internal scope identifiers to the browser unless the architecture genuinely requires them.

If the existing contract currently requires both projectId and scopeKey, evaluate whether that coupling is necessary before expanding it further.

## Working style

Take initiative.

Inspect the codebase and determine the next highest-value implementation step.

Do not stop merely because an existing document describes a heavier process.

Preserve already accepted work, but do not automatically extend its ceremony to new work.

When an old verification mechanism conflicts with productive engineering, preserve its evidence, document the simplification briefly, and use the lighter process going forward.

Do not rewrite large areas without reason.

Prefer small coherent commits.

A good commit should usually represent one understandable improvement such as:

- wire project services into production startup.
- simplify persisted selection.
- add project switching UI.
- preserve draft across project change.
- add one end-to-end project-switching test.

## Definition of done

A feature is done when:

- the user-visible behavior works.
- relevant automated tests pass.
- the real application has been exercised.
- important failure modes are covered.
- no obvious cross-project or destructive risk remains.
- the implementation is understandable.
- the change is committed.

A feature is not made more done by accumulating verification artifacts after these conditions are satisfied.

## Reporting

Keep progress reports short and product-oriented.

Report:

- what user capability now works.
- what was changed.
- what verification ran.
- what remains broken or incomplete.
- what you are building next.

Do not fill reports with hashes, ledger accounting, attempt histories, or process metadata unless those details reveal an actual problem.

## When uncertain

Favor building the smallest reversible implementation and testing it.

Prefer empirical product feedback over speculative governance.

Preserve safety boundaries.

Reduce ceremony.

Ship working increments.

## High-assurance mode

Use [high-assurance mode](docs/verification/high-assurance-mode.md) only for a
named risk whose consequences justify extra controls. A project name, packet
number, prior failure, or existing proof script does not activate that mode.
Preserve existing evidence and recorded budgets. Do not restart consumed legacy
proof jobs or change their historical results. Ordinary development follows the
retry and resource policies above.
