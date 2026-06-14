---
name: update-create-vivary-package
description: Workflow command scaffold for update-create-vivary-package in vivary.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /update-create-vivary-package

Use this workflow when working on **update-create-vivary-package** in `vivary`.

## Goal

Implements or updates features in the create-vivary package, including code, documentation, and tests.

## Common Files

- `packages/create-vivary/create_vivary.py`
- `packages/create-vivary/README.md`
- `packages/create-vivary/tests/test_create_vivary.py`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit or add implementation in packages/create-vivary/create_vivary.py
- Update documentation in packages/create-vivary/README.md
- Add or update tests in packages/create-vivary/tests/test_create_vivary.py

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.