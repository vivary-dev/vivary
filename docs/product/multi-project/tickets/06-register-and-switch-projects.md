# 06: Implement project registration and switching
Type: outcome
Status: planned
Blocked-by: [03, 05]
Unlocks: [07, 08, 11, 12]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Let the GUI register existing roots read-only, display identity and capabilities, and switch projects without retargeting active sessions or losing drafts.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own project-list and project-detail UI, registry application services, and their tests. Read tickets 03 and 05 plus `design.md` project onboarding rules. Registration alone must not write project files, initialize VCS, or create a remote.

## Done condition

Two independent roots can be registered and reopened. Missing and duplicate roots are clear. Switching preserves drafts and keeps each active session bound to its original project.

## Verify

Run integration tests with two roots, one missing root, duplicate physical paths, and a session active during a switch. Assert zero project-byte changes during registration.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
