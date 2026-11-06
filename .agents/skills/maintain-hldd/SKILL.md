---
name: maintain-hldd
description: Keep Vivary's canonical high-level design aligned with source, product contracts, and acceptance evidence. Use when changing Vivary implementation, configuration, architecture, delivery checks, or durable product documentation.
---

# Maintain Vivary's high-level design

Read `docs/ARCHITECTURE.md` before implementation. It is the canonical HLDD.
Detailed contracts stay in their existing documents. GitHub issues own task status.

Read the source owners and evidence linked from the affected sections. Preserve
Jeff's stated intent, success criteria, and editorial remarks. Do not invent a
rationale or relabel planned or untested behavior as implemented or accepted.

Update affected design sections alongside source changes. Keep the explanation
at component, flow, persistence, or trust-boundary level. Link deeper details
instead of copying them. If the design remains accurate, update Last change
review with the specific changed area, why its description still holds, and
the evidence inspected. A date, hash, generic acknowledgement, or unrelated
sentence is not a review.

Keep the staged change coherent:
1. Inspect `git diff --cached` and update the relevant HLDD sections.
2. Stage the document with the source change.
3. Run `python scripts/check_hldd.py --staged`.
4. Review the actual text against the implementation. The gate checks that a
   review was recorded, not whether its claims are true.

Install the repository hook in each checkout with
`python scripts/check_hldd.py --install-hook`. It preserves existing hooks and
refuses to replace a hook manager or a different pre-commit hook. Integrate the
same staged command into an existing chain when needed. Linked worktrees share
Git hooks. The supplied hook only runs in trees that track this checker.

CI checks each introduced commit using
`python scripts/check_hldd.py --base <base-ref> --head <head-ref>`.
Commits preceding gate adoption remain historical. Source changes on merged
side branches are checked too. Test-only and generated site-mirror changes
do not require documentation churn. Source, delivery scripts,
workflow, project instruction, and durable documentation changes do. Whitespace,
comments, and date-only edits do not satisfy the gate. Do not bypass a failure.
The branch check, never the staged hook, passes a Dependabot-authored commit whose
relevant changes are version-only edits to dependency manifests or workflow
action refs, or lockfile changes. It does not inspect lockfile content. It also
passes a merge commit whose change against its first parent is version-only
when it takes a merged branch's copy of a dependency file the other line left
alone. The range must have checked every commit on that branch, counting
commits already on the base branch as checked. The dependency review in
`CONTRIBUTING.md` covers what a lockfile brings in.

The application bundles this same Markdown at build time in Settings >
Documentation. Do not hand-maintain a second copy. Check the built reader when
its rendering or navigation changes. Run the existing site documentation sync
when canonical docs change.

Before delivery, report what the HLDD now explains, what evidence supports it,
and any remaining acceptance gaps. Preserve the existing review and approval
requirements. This skill grants no publication or transcript-upload authority.
