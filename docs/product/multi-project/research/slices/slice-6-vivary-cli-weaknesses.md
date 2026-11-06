# Original Vivary CLI against three requirements

Supplied research input. Read the [source reconciliation](../workspace-research-reconciliation.md) before using
its claims or delivery order. The accepted plan is the program frontier.

Read on 2026-09-13 from branch `feat/vivary-gui` at SHA `6f7db030546c92f842bd56bb259ece53cf19c8a7`.

Repo path on the remote box: `<repository-root>`. All file
references below are relative to that root. Line numbers are from this SHA.

Several verdicts below were confirmed by running the code against synthetic workspaces
in `/tmp/vv-probe` on the same box (now deleted). Those runs are labeled "observed".

## The thin contract as the code writes it

`scaffold_thin_workspace` (`packages/create-vivary/create_vivary.py:656`) writes exactly
five files, listed in `THIN_WORKSPACE_FILES` (`create_vivary.py:217`) and built at
`create_vivary.py:700-716`. Observed output for a fresh target: `.gitignore`,
`.vivary/context.md`, `.vivary/workspace.toml`, `AGENTS.md`, `STATE.md`.

| File | Writer | Content the writer produces |
| --- | --- | --- |
| `AGENTS.md` | `_thin_agents_block` at `create_vivary.py:4988`, assembled at `create_vivary.py:713` | `# AGENTS.md` plus a four-line managed block between `<!-- vivary:context:start -->` and `<!-- vivary:context:end -->` that says to read `.vivary/context.md` first |
| `.gitignore` | `_thin_gitignore_block` at `create_vivary.py:4998` | A managed block holding only the three rules in `_THIN_PRIVATE_RULES` (`create_vivary.py:4491`): `.vivary/private/`, `.vivary/runtime/`, `*.vivary-tmp` |
| `.vivary/context.md` | `_thin_context_doc` at `create_vivary.py:5009` | Frontmatter `status: active` and `preset: <preset>`, then an H1, then exactly three headings: `## Work loop`, `## Routes`, `## Gates` |
| `STATE.md` | `_thin_state_doc` at `create_vivary.py:5108` | Seven empty labels, not headings: `Focus:`, `Status:`, `Next:`, `Open decisions:`, `Blockers:`, `Checks:`, `Updated:` |
| `.vivary/workspace.toml` | `_thin_workspace_toml` at `create_vivary.py:5047` | See the key table below |

`workspace.toml` keys, all written literally by `_thin_workspace_toml`
(`create_vivary.py:5060-5106`):

- `version = 1`, `exclude = [".git", ".agents", ".vivary/private", ".vivary/runtime"]`
- `[workspace]`: `contract = "thin-v0.3"`, `preset`, `state = "STATE.md"`,
  `private = [".vivary/private"]`, `runtime = [".vivary/runtime"]`, `adapters`,
  `capabilities`
- `[base]`: `derive = ["id", "title"]`, `allow_untyped = true`,
  `optional = { tags = "string-list" }`
- Six types, each a folder-to-type binding consumed by `tropo.type_for`
  (`packages/tropo/tropo.py:914`) and `Config.folder_map` (`tropo.py:769`):

| Type | Folder(s) | Required frontmatter | Notable optional fields |
| --- | --- | --- | --- |
| `project` | `.vivary`, `projects` | `status: enum:idea\|active\|paused\|shipped\|archived` | `preset`, `repo: url`, `target_ship: date` |
| `module` | `modules` | `project`, `status`, `module_area` | `source_files`, `test_files`, `verification`, `gates` |
| `change` | `changes` | `project`, `status`, `slice` | `branch`, `verification`, `gates` |
| `decision` | `decisions` | `project`, `status`, `date` | `supersedes`, `superseded_by`, `rationale` |
| `verification` | `verification` | `project`, `status`, `target` | `command`, `evidence` |
| `gate` | `gates` | `project`, `status`, `gate` | `approver`, `approved_at`, `command_intent` |

Validation of that file is `_valid_existing_thin_contract` (`create_vivary.py:5154`) plus
`tropo._validate_thin_workspace` (`tropo.py:650`). `doctor_workspace`
(`create_vivary.py:1135`) checks the five files exist, checks the three privacy patterns
via `_missing_thin_privacy_ignores` (`create_vivary.py:2262`), and then runs the whole
tree through tropo (`_doctor_graph_context`, `create_vivary.py:1364`).

`.vivary/records/` layout is set by `_record_destination` (`create_vivary.py:6539`). A
record path must be exactly `<folder>/<slug>.md` where folder is one of the five in
`_THIN_RECORD_FOLDERS` (`create_vivary.py:4502`): `modules`, `changes`, `decisions`,
`verification`, `gates`. It is written to `.vivary/records/<folder>/<slug>.md`
(`create_vivary.py:6559`).

Two structural facts about the contract matter for everything below.

First, the preset is a label and nothing else. `PRESET_STARTERS`
(`create_vivary.py:307`), which holds the per-preset module, change, and verification
starter content, is referenced only at `create_vivary.py:522` and
`create_vivary.py:536`, both inside `_build_scaffold_plan`, which only
`scaffold_workspace` (the legacy v0.1/v0.2 path, `create_vivary.py:550`) calls. The thin
path never reads it. The creation guide states this outright:
"Each preset creates the same five files. A preset changes policy labels only."
(`docs/guides/create-workspace.md:35-36`).

Second, `.vivary/private/` is the only private slot in the contract, and it is listed in
the tropo `exclude` array (`create_vivary.py:5063`), so nothing placed there can be
retrieved. Observed: a file at `.vivary/private/owner.md` containing "Owner drinks tea"
was not returned by `tropo find "owner drinks tea"`.

## Scenario traces

### S1. Preset created as `second-brain`, owner wants `research`/`knowledge-work`

Verdict: refused, with a misleading error.

`vivary create --preset second-brain` and `--preset knowledge-work` produce byte-identical
workspaces except for the `preset` string in `.vivary/workspace.toml:[workspace].preset`
(`create_vivary.py:5064`) and the `preset:` frontmatter line in `.vivary/context.md`
(`create_vivary.py:5012`). Nothing else in the thin path branches on preset except the
`cocoindex-code` guard at `create_vivary.py:691`.

There is no verb to change it. `ROUTES` (`packages/vivary/vivary_cli.py:78-100`) is
`create`, `adopt`, `doctor`, `capabilities`, `check`, `find`, `decide`, `review`,
`impact`, `control`. No `migrate`, `reclassify`, `convert`, or `set-preset`.

Re-running `adopt` with the new preset does not migrate; it conflicts.
`_valid_existing_thin_contract` returns `False` when `workspace.get("preset") != preset`
(`create_vivary.py:5178`), and `plan_adopt` then classifies both `.vivary` files as
conflicts with reason `existing file is not thin-v0.3` (`create_vivary.py:5433`).
`adopt_workspace` refuses any plan with conflicts.

Observed on a `second-brain` workspace re-planned with `--preset knowledge-work`:

```
PRESET: knowledge-work | explicit --preset knowledge-work
CREATES: []
CONFLICTS: [('.vivary/context.md', 'existing file is not thin-v0.3'),
            ('.vivary/workspace.toml', 'existing file is not thin-v0.3')]
```

What the owner sees: a refusal that says their `thin-v0.3` file is not `thin-v0.3`. The
only path forward is hand-editing two files. Nothing migrates, because there is nothing
preset-specific to migrate.

Weakness: the preset is immutable after creation and the refusal names the wrong cause.

### S2. Adopt a folder of 400 Markdown notes with no frontmatter plus PDFs

Verdict: the plan is written and reports clean, then the apply fails and rolls back when
any content directory name collides with the type vocabulary. Otherwise it succeeds and
produces a graph with no edges.

`plan_adopt` (`create_vivary.py:5346`) writes only the same five thin files. It runs
`BrownfieldInventory` (`create_vivary.py:4535`), which does detect candidate module
directories (`create_vivary.py:4615-4621`), but the thin plan discards that result: the
returned plan hardcodes `"followups": []`, `"gitignore_followups": []`,
`"excluded_pre_existing": []`, `"skipped_module_collisions": []`
(`create_vivary.py:5665-5668`). The function that did use those,
`_legacy_full_plan_adopt` (`create_vivary.py:4823`), is defined and never called
anywhere in `packages/` or `tests/`. The guide confirms the behavior:
"Adoption does not scan for candidate modules. Adoption does not create graph records."
(`docs/guides/adopt-project.md:164-166`).

Observed on a PARA-shaped vault (`projects/`, `areas/`, `resources/`, `archives/`,
`refs/`, 400 `.md`, 12 `.pdf`):

```
PRESET: second-brain | markdown-majority tree (400 .md vs 0 code file(s))
candidate_modules: ['archives', 'areas', 'projects', 'resources']
CREATES: 5 files   CONFLICTS: []   privacy: planned
followups/excluded/skipped: [] [] []
```

Then `adopt_workspace` wrote the five files, ran Doctor, and raised:

```
ScaffoldError: Doctor failed after apply: tropo finding:
projects/project-1.md:1: error E101: missing required field 'status' for type 'project'
... (90 identical errors) ...
```

and rolled the whole adoption back. The cause: `projects` is a registered folder for
`[types.project]` (`create_vivary.py:5077`), `type_for` walks ancestors by basename
(`tropo.py:914-926`), and the `project` type requires the `status` enum. PARA's
`projects/` directory is therefore claimed by Vivary's own type vocabulary. `plan_adopt`
never runs Doctor, so the dry run cannot predict this.

What Tropo indexes afterward: only `.md` and `.markdown`. `iter_markdown` skips every
other file at `tropo.py:1053`. The 12 PDFs are never nodes. Edges come only from
frontmatter fields whose declared spec is `ref` or `ref-list` (`tropo.py:1133-1137`);
there is no wikilink or Markdown-link parsing anywhere in `tropo.py`.

Observed on the same vault with the colliding directory renamed: Doctor passed with
`graph: {'nodes': 403, 'edges': 0, 'broken': 0}` and zero warnings.

`governed_find` on that vault returned a capsule with zero claims, because the vault was
not a git repository:

```
claims: [] ,
unknowns: [{"fact": "is_git_repository",
            "reason": "not_a_git_repository_or_git_failed"},
           {"kind": "content_search_incomplete", "reason": "dirty_state_unknown"}]
```

After `git init` and one commit, the same query returned 12 claims drawn from 8 files,
with omission `content_files_truncated: matched-file listing capped at 8 files per
checkout`, and unknowns `['no_fetch_recorded', 'no_npm_test_script',
'no_upstream_configured']`.

Non-governed `tropo find` does work on the vault, but ranks by literal term counts
(`_score_source`, `tropo.py:3972-3995`). With 200 notes containing the same phrase it
returned `note-1, note-10, note-100, note-101, note-102`, which is slug order among tied
scores.

Weakness: adopt plans a clean transaction it cannot complete on any vault whose folder
names overlap Vivary's six type folders, and what it does adopt has no edges and no
non-Markdown content.

### S3. Merge two Vivary workspaces into one

Verdict: undefined. No code path exists.

Grepping `"merge"`, `"split"`, `"absorb"`, and `"migrate"` across
`create_vivary.py`, `vivary_cli.py`, `tropo.py`, `exo.py`, `ozone.py`, and `strato.py`
returns only `tropo migrate` (`tropo.py:6031`), which moves graph nodes between storage
backends (`file` to `embedded`) inside one workspace, and the string `"split"` as one
option in a doctor repair guidance list (`create_vivary.py:1801`).

The conflicts a merge would hit, all provable from the contract:

- Two `.vivary/workspace.toml`. `find_root` raises `ConfigError("competing thin-v0.3
  roots: ...")` when more than one thin config is found while walking up
  (`tropo.py:744-747`), and `_competing_thin_ancestor` (`tropo.py:717`) exists purely to
  detect a thin config above a root. Nesting one workspace inside another is refused,
  not merged.
- Two `STATE.md`. `plan_adopt` always classifies an existing `STATE.md` as `kept`
  (`create_vivary.py:5417-5419`), so whichever workspace becomes the target silently
  keeps its own state and the other one's is orphaned.
- Two `.vivary/records/` trees. `tropo.build_graph` keys nodes by derived id and uses
  `nodes.setdefault` (`tropo.py:1189`), and `_derive_id` (`tropo.py:946`) is the filename
  slug. Two workspaces that each hold `changes/local-ci-baseline.md` collapse to one
  node and the second document's edges silently retarget the first.

Weakness: merging is not modeled at all, and the id derivation makes a naive
file-level merge lose nodes without any error.

### S4. Split one workspace into two

Verdict: undefined. Same grep result as S3.

Worse than merge in one respect: `init` refuses a non-empty target.
`_validate_thin_init_target` raises "init requires a new or empty directory; use
create-vivary adopt for every existing workspace, including thin workspaces"
(`create_vivary.py:650-654`). So the only way to make the second half of a split is to
move files out, then `adopt` the new directory, which regenerates a fresh
`.vivary/workspace.toml` and a fresh empty `STATE.md` and leaves every cross-half
`ref`/`ref-list` edge broken. Broken edges are a hard Doctor error
(`create_vivary.py:1254`), so both halves fail Doctor until the owner hand-repairs every
reference.

Weakness: a split guarantees broken edges, and broken edges are a Doctor failure, so the
CLI blocks the workspace it just helped create.

### S5. Store a durable owner fact so retrieval surfaces it next session

Verdict: partly supported, with no named slot. The thin path dropped the two files that
used to hold this.

There is no USER, MEMORY, owner, or profile slot in the thin five files.
`THIN_WORKSPACE_FILES` (`create_vivary.py:217`) has no such entry.
`_thin_context_doc` (`create_vivary.py:5009`) has exactly three sections, `Work loop`,
`Routes`, and `Gates`, and none of them is about the owner. `_thin_workspace_toml`
(`create_vivary.py:5047`) has no owner key; `[workspace]` holds only `contract`,
`preset`, `state`, `private`, `runtime`, `adapters`, `capabilities`.

The legacy scaffold had both slots, and they are still on disk as templates:

- `packages/create-vivary/create_vivary_assets/templates/USER.template.md`, headed
  "USER — about you", with fields `Name / callsign`, `Timezone`, `Role / what you do`,
  `Teach vs do`, `Ask before`, `Never make public`, `Tools / folders the agent should
  know`, `Notes`.
- `packages/create-vivary/create_vivary_assets/templates/MEMORY.template.md`, headed
  "MEMORY — long-term", with fields `Focus`, `Preferences`, `Boundaries`,
  `Decisions (locked-in)`, `Lessons`, `Open loops`, `Superseded`.

Both are still named in `BASELINE_WORKSPACE_FILES` (`create_vivary.py:187-206`) and in
`PRIVATE_PLACEHOLDER_TEMPLATES` (`create_vivary.py:235-238`), which are the legacy v0.1
contract and its repair path. Neither is written by `scaffold_thin_workspace` or
`plan_adopt`.

What does work: put the fact in a `decision` record. Observed, a file at
`.vivary/records/decisions/owner-writing-hours.md` with frontmatter
`project`, `status: accepted`, `date`, and body "The owner writes in the morning. Never
schedule builds then." passed `tropo check` and was returned by
`tropo find "when does the owner like to write"` as the top hit, and also by the
paraphrase `"what time of day should I schedule a long build"` because the words
"schedule" and "build" appear in the body.

The costs of that route:

- The fact must be shaped as a `decision`: required `project`, `status` from
  `proposed|accepted|deferred|superseded`, and `date` (`create_vivary.py:5085-5087`). A
  standing preference has no supersession lifecycle.
- Writing it through the supported verb requires a Task Capsule. `plan_record` calls
  `_record_capsule_binding` unconditionally (`create_vivary.py:6807`) and refuses unless
  Doctor already passes and the contract is `thin-v0.3` (`create_vivary.py:6797-6805`).
  A capsule comes from `governed_find`, which needs a git repository (see S2). So
  recording an owner fact in a non-git notes workspace is blocked.
- Retrieval is lexical only. `_score_source` (`tropo.py:3972`) scores whole-word term
  counts plus a phrase bonus. A query with no shared words returns nothing, and nothing
  in the contract causes the fact to be loaded unconditionally at session start.
- `ozone review` reported it as `info orphan: node 'owner-writing-hours' is disconnected`
  (observed), because a standing fact has no reason to carry `ref` edges.

Weakness: the two files that used to answer "who is the owner" were deleted from the
scaffold, and the surviving substitute needs a git repo, a capsule, and a decision
lifecycle to hold "I write in the morning."

### S6. Knowledge-work workspace with no tests, no build, no code

Verdict: Strato is blocked by its capsule precondition; Ozone runs but its one non-code
pack cannot fire on a thin workspace; three of the five record types have code-shaped
required or optional fields.

Strato. `strato decide` is the only verb (`packages/strato/strato.py:296`).
`_validate_request` (`strato.py:101`) requires a `capsule` that passes
`is_task_capsule_shape` and `verify_task_capsule_integrity` (`strato.py:167-171`), whose
`workspace.observed_at` must be within `MAX_EVIDENCE_AGE_SECONDS = 300` of
`decision_at` (`strato.py:24`, `strato.py:193-196`). The only producer of that capsule in
the CLI is `tropo find --governed`. On a non-git workspace that capsule has zero claims
(observed, S2). The policy itself is domain-neutral; the input requirement is not.

Ozone. `cmd_review` (`packages/ozone/ozone.py:1714`) runs three packs.

- `structure_pack` (`ozone.py:1418`) is graph-shape only. On the 403-node vault it
  emitted 403 `info orphan` findings and 0 warnings (observed), which is noise, not
  review.
- `context_budget_pack` inspects only the root names in `ROOT_SURFACE_THRESHOLDS`
  (`ozone.py:99-106`): `AGENTS.md`, `CLAUDE.md`, `STRATO.md`, `SOUL.md`, `STATE.md`,
  `README.md`, plus `modules/*/index.md` (`public_routing_surfaces`, `ozone.py:1481`).
  `STRATO.md` and `SOUL.md` do not exist in a thin workspace, and `.vivary/context.md`,
  the file the contract tells the agent to read first, is not inspected at all.
- `editorial_pack` (`ozone.py:1618`) is the one genuinely non-code pack, keyed on
  `EDITORIAL_ROLE_FOLDERS` (`ozone.py:75-85`): `drafts`, `manuscripts`, `reviews`,
  `edits`, `revisions`, `outlines`, `structures`, `beats`. None of those folders is a
  registered type in the thin `workspace.toml`, and the fields it looks for
  (`EDITORIAL_REVIEW_FIELDS` and friends, `ozone.py:86-98`) are not declared as `ref` or
  `ref-list` on any thin type. `analyze_file` only records a ref when the declared spec
  is `ref`/`ref-list` (`tropo.py:1133-1137`), so those fields never become edges.

Observed, on a thin workspace containing `drafts/ch1.md` with `review: ch1-review` and
`reviews/ch1-review.md` with `draft: ch1`:

```
drafts/ch1.md: warn draft-unreviewed: draft 'ch1' has no review linked
reviews/ch1-review.md: warn review-unlinked: review 'ch1-review' is not linked to a draft
```

while `tropo check drafts reviews` reported `2 document(s), 0 error(s), 0 warning(s)`.
The link the owner wrote is real, Ozone cannot see it, and Tropo gives no signal that it
was ignored.

Records taxonomy for a writing project, from `_thin_workspace_toml`
(`create_vivary.py:5075-5106`):

| Type | Field a writing project would have to fill | Problem |
| --- | --- | --- |
| `module` | required `module_area`; optional `source_files`, `test_files` | `test_files` has no writing analogue; `source_files` reads as code |
| `change` | required `slice`; optional `branch` | `slice` and `branch` are both version-control vocabulary |
| `verification` | required `target`; optional `command`, `evidence` | `command` presumes an executable check; an editorial pass is a person reading |
| `decision` | required `date`; optional `supersedes`, `superseded_by` | usable as-is |
| `gate` | required `gate`; optional `command_intent` | `command_intent` presumes a command |

Exo. `exo board` returned "no work items (changes) found" (observed), because
`role_of` (`exo.py:182`) takes the first path segment. Records written by the supported
verb live under `.vivary/records/...`, so their first segment is `.vivary` and
`role_of` returns `None`. The same bug is in `ozone.role_of` (`ozone.py:1407`) and
`ozone.editorial_role_of` (`ozone.py:1412`). Every record `create-vivary record` writes
is invisible to Exo coordination and to Ozone's role-based checks.

Weakness: the only non-code review pack Vivary ships is structurally unable to fire on
the workspace the CLI creates, and the coordination layer cannot see records the CLI
writes.

### S7. Doctor on a non-code workspace

Verdict: supported, and it passes when it should not.

Observed on the 406-node notes workspace:

```
ok: True
errors: []
warnings: []
graph: {'nodes': 406, 'edges': 0, 'broken': 0}
backend: file
memory: {'enabled': False, 'status': 'disabled', 'provider': 'none'}
compat: {'workspace_contract': 'thin-v0.3', 'baseline_missing': [],
         'recommended_missing': []}
caps preset: second-brain
```

Irrelevant or misleading checks:

- Zero edges is not reported. `doctor_workspace` warns only when
  `graph["nodes"] == 0` (`create_vivary.py:1256`). A workspace where retrieval has no
  graph at all gets a green Doctor.
- Every tropo finding becomes a Doctor error, including warning-level ones.
  `findings` is built from all of `doc.findings` regardless of level
  (`create_vivary.py:1246`) and then extended into `errors`
  (`create_vivary.py:1252`). A `W210` "field equals its derived value (noise)" warning,
  which fires on any note declaring `title:` matching its H1 (`tropo.py:1122-1127`),
  fails Doctor. Obsidian and Notion exports commonly write exactly that field.
- The capability roster is reported for every preset but has only one preset-gated
  entry, `active-context:cocoindex-code`, restricted to `"presets": ("coding",)`
  (`create_vivary.py:7213`). A `second-brain` or `writing` workspace gets a list whose
  preset-specific section is empty by construction.
- `memory`, `backend`, and `compatibility` are reported at fixed cost on a workspace with
  no providers configured.

Weakness: Doctor is green on a workspace with no graph structure, and red on a vault
whose notes carry ordinary frontmatter.

## What the legacy scaffold had that the thin path dropped

| File or concept | Legacy location | Thin equivalent | Consequence |
| --- | --- | --- | --- |
| `USER.md` (owner profile) | `create_vivary_assets/templates/USER.template.md`; required at `create_vivary.py:192` | none | R3. No named place for owner identity, timezone, teach-vs-do, or "ask before" rules |
| `MEMORY.md` (durable facts) | `create_vivary_assets/templates/MEMORY.template.md`; required at `create_vivary.py:193` | none | R3. No place for preferences, boundaries, or lessons that persist across sessions |
| `memory/YYYY-MM-DD.md` daily notes | `PRIVATE_PLACEHOLDER_PATHS` at `create_vivary.py:231` | none | R3. No capture surface between a session and a durable fact |
| Per-preset starter graph | `PRESET_STARTERS` at `create_vivary.py:307`; written by `_preset_writes` at `create_vivary.py:3569` | none; table is unreachable from `init` | R2. `writing` and `knowledge-work` presets produce no drafts, sources, or editorial records |
| Knowledge-work sources router | `_knowledge_work_writes` at `create_vivary.py:3586`, `_knowledge_sources_module_doc` at `create_vivary.py:3635` | none | R2. Issue 85's acceptance criterion "scaffolds a clean graph with workbench and sources routers" is not met by the thin path |
| Brownfield module routers | `_candidate_module_router_doc` at `create_vivary.py:4638`, `_preexisting_module_router_doc` at `create_vivary.py:4663`, used only by dead `_legacy_full_plan_adopt` at `create_vivary.py:4823` | none; plan returns `[]` at `create_vivary.py:5665-5668` | R1. Adopting a full folder leaves all of its content unrouted and unmentioned |
| Per-path excludes for pre-existing type-folder content | `_adopt_tropo_config` at `create_vivary.py:4719` | none | R1/R2. This is exactly the mechanism that would have prevented the observed PARA `projects/` rollback |
| `SOUL.md`, `STRATO.md`, role skills | `BASELINE_WORKSPACE_FILES` at `create_vivary.py:189-206` | none; Ozone still checks for them at `ozone.py:99-106` | R2. `context_budget_pack` looks for two files the current scaffold never writes |
| `modules/index.md` routing | `INDEXED_WORKSPACE_FILES` at `create_vivary.py:212` | none; skipped for thin at `create_vivary.py:1239` | R2. No routing layer between the context doc and 400 loose notes |

## Known gaps already recorded by the program

- `docs/product/multi-project/evidence.md:35-38`: `_thin_workspace_toml`'s project type
  "is graph data inside one workspace. It is not a registry of managed filesystem
  projects." The program already records that there is no multi-project layer, which is
  what R1's merge, split, and absorb all need.
- `docs/product/multi-project/evidence.md:40-43`: the four presets "can declare CocoIndex
  code context and optional storage or memory policy. These flags do not discover or
  supervise agent runtimes." The preset is described as a flag, not a shape.
- `docs/product/multi-project/evidence.md:51-53`: "adoption does not create records, copy
  templates or skills, enable providers, or scan for modules." This is the S2 gap, stated
  by the program as intended behavior.
- `docs/product/multi-project/evidence.md:112-115`: "Vivary does not provide a
  tool-permission broker. It has no Git lifecycle adapter for clone, init, worktree,
  branch, commit, or push." Combined with the git precondition in `governed_find`, this
  means the governed loop needs a git repo it will not create.
- `docs/product/multi-project/audit.md:26`: "An isolated execution copy is not
  automatically the user's existing project folder", blocking "Real brownfield mutation
  and save claims."
- `docs/product/multi-project/migration.md:34`: S-00 carries the correction "Remove
  unconditional Git assumptions."
- `docs/product/multi-project/migration.md:38`: S-06 and S-07 carry "Make VCS operations
  conditional."
- `docs/product/multi-project/contracts/root-vcs-observation.md:113`: "The backing Git
  value is null when the inspected layout has no Git backing", and non-colocated
  workspaces stay `unsupported` with read-only eligibility. The contract anticipates
  non-git roots; `governed_find` does not act on that.

Matching issues, from `gh issue list --repo vivary-dev/vivary-cli --state all --limit 60`:

- 85 CLOSED, "create-vivary: knowledge-work preset + capability registry". Its
  acceptance criterion "`create-vivary init --preset knowledge-work` scaffolds a clean
  graph with workbench and sources routers" is not satisfied by the thin path, which
  writes five files identical to every other preset.
- 21 CLOSED, "create-vivary: a multi-agent preset (exo role contracts wired in)".
- 266 CLOSED, "[Bug]: tropo strict check flags untyped documents and standard
  frontmatter fields despite allow_untyped=true". Same family as the observed PARA
  failure, which is a typed-by-folder-name failure rather than an untyped one.
- 314 CLOSED, "[Feature]: API surface simplification". The thin contract is the result.
- 199 CLOSED, "bug(create-vivary): make Doctor backward-compatible with legacy and
  declared-capability workspaces".
- 198 CLOSED, "bug(create-vivary): fix npm adopt dispatch and cover every public
  subcommand".
- 200 CLOSED, "proof: pin the map -> adopt -> doctor -> find loop across real workspace
  generations".
- 148 OPEN, "release: prove Vivary from WSL/Linux before the next major release".
- 150 OPEN, "docs: publish token-saving guides, screenshots, walkthroughs, and brain
  workflows".
- 151 OPEN, "release: Vivary next major — governed context, MCP, and trustworthy
  brownfield tooling".
- 211 OPEN, "proof: dogfood the Python governed loop and publish a graduation manifest".
- 214 OPEN, "wayfinder: Vivary next-major — the decisions before the integration order".
- 140 OPEN, "tropo: add clustering and community graph views over typed embeddings".

No issue in the 60 returned names workspace merge, workspace split, changing a preset
after creation, an owner-profile or memory slot in the thin contract, or running the
governed loop without git.

## Where the code assumes code

| Package | Function | Assumption | Citation | What breaks for non-code work |
| --- | --- | --- | --- | --- |
| core | `project_workspace_graph` | the checkout is a git repository; a non-git path is added as a bare node and `continue` skips repository, branch, and content projection | `packages/core/vivary_core/workspace_model.py:545-568` | A notes vault, a Dropbox folder, or an Obsidian vault produces a capsule with zero claims (observed) |
| core | `observe_content` | searchable content is git-tracked; the search is `git grep -z -n -I -i -F` | `packages/core/vivary_core/workspace_content.py:408` | Uncommitted notes are invisible to the governed loop, and `-I` drops every binary, so PDFs never match |
| core | `observe_content` | at most 8 matching files per checkout, 3 lines each, 200 chars each | `workspace_content.py:56-58` | A 400-note vault yields at most 8 files of evidence per question; the rest is an omission record |
| core | `_observe_npm_test_script` | the project's test command lives in `package.json` `scripts.test` | `packages/core/vivary_core/workspace_observe.py:1029-1045`, unknown reason emitted at `workspace_observe.py:1745` | A writing workspace's capsule reports `no_npm_test_script` as an unknown fact (observed) |
| core | `observe_checkouts` fact set | `npm_test_script`, `is_dirty`, `worktree_root`, upstream, fetch state are the facts worth knowing about a workspace | `packages/core/vivary_core/workspace_model.py:116` | The observable facts are all VCS and JS toolchain facts; none describe notes, drafts, or sources |
| tropo | `iter_markdown` | only `.md` and `.markdown` are content | `packages/tropo/tropo.py:1053` | PDFs, `.docx`, images, CSVs, and audio are not indexable at all |
| tropo | `analyze_file` | a link is a frontmatter field with a declared `ref`/`ref-list` spec | `tropo.py:1133-1137` | Obsidian `[[wikilinks]]` and Markdown links produce no edges; observed 403 nodes, 0 edges |
| tropo | `_validate_thin_workspace` type vocabulary | the six domain nouns are module, change, decision, verification, gate, project | written at `create_vivary.py:5075-5106` | Source, draft, chapter, note, person, meeting, and habit have no type |
| tropo | `governed_find` | the tropo root equals the git worktree root, else refuse | `tropo.py:6335-6352` | A workspace inside a larger repo, or with no repo, cannot produce a capsule |
| strato | `_validate_request` | a decision needs a valid, integrity-checked capsule under 300 seconds old | `packages/strato/strato.py:167-196`, `strato.py:24` | With no capsule producer on a non-git workspace, `decide` is unreachable |
| ozone | `ROOT_SURFACE_THRESHOLDS` | the routing surfaces are `AGENTS.md`, `CLAUDE.md`, `STRATO.md`, `SOUL.md`, `STATE.md`, `README.md` | `packages/ozone/ozone.py:99-106` | Two of the six are never written by the current scaffold, and `.vivary/context.md` is never checked |
| ozone | `structure_pack` | a `change` without a linked `verification` is a warning | `ozone.py:1443-1446` | Every writing or research change warns until the owner invents a verification record |
| ozone | `role_of`, `editorial_role_of` | a node's role is its first path segment | `ozone.py:1407-1416` | Every record under `.vivary/records/` has role `None`, so role-based checks skip them |
| exo | `ROLES` | seven fixed roles, hardcoded as a Python list with no config hook | `packages/exo/exo.py:119-127` | `Builder` is "one slice + changed paths + checks" and `Verifier` is "pass / fail / skipped / risk"; no editor, researcher-of-record, or librarian role, and no way to add one |
| exo | `role_of`, `_workspace_docs` | work items live in a top-level `changes/` directory | `exo.py:113-116`, `exo.py:182-184` | `exo board` returns "no work items (changes) found" on any workspace using the supported record path (observed) |
| create-vivary | `_thin_workspace_toml` module type | a module has `source_files` and `test_files` | `create_vivary.py:5081-5083` | A chapter, a research thread, or an area of responsibility has neither |
| create-vivary | `_thin_workspace_toml` change type | a change has a `slice` and a `branch` | `create_vivary.py:5085-5087` | Version-control vocabulary imposed on a draft revision |
| create-vivary | `BrownfieldInventory.choose_preset` | the only automatic distinction is code-majority versus markdown-majority | `create_vivary.py:4602-4628` | It can only ever return `coding` or `second-brain`; `writing` and `knowledge-work` are unreachable without an explicit flag |
| create-vivary | `_CAPABILITY_DECLARATIONS` | the one preset-gated capability is for code | `create_vivary.py:7207-7221` | Non-code presets have an empty preset-specific capability set by construction |

## Ranked weaknesses

Ranked by how much each blocks the requirement.

1. R1. There is no code path anywhere for merging, splitting, or absorbing a workspace,
   and the CLI's ten verbs contain nothing that could stand in
   (`packages/vivary/vivary_cli.py:78-100`).
2. R1. `adopt` plans a transaction it cannot finish on any folder whose directory names
   overlap Vivary's six type folders, and the dry run cannot warn because `plan_adopt`
   never runs Doctor while `adopt_workspace` does and rolls back on failure
   (`create_vivary.py:6524`; observed 90 `E101` errors and a full rollback on a PARA
   vault whose `projects/` directory is claimed by `[types.project]`,
   `create_vivary.py:5077`).
3. R3. The thin scaffold dropped both files that ever held owner facts. `USER.md` and
   `MEMORY.md` are still required by the legacy contract at `create_vivary.py:192-193`
   and their templates are still on disk, but `THIN_WORKSPACE_FILES`
   (`create_vivary.py:217`) has no owner slot of any kind.
4. R2/R3. The governed loop, which is the only input Strato and Ozone's verify surface
   accept, produces nothing without git: `project_workspace_graph` adds a bare node and
   skips all content projection when `is_git_repository` is not true
   (`packages/core/vivary_core/workspace_model.py:545-568`; observed capsule with zero
   claims on a 400-note vault).
5. R2. The typed graph has no edges on a note corpus because edges come only from
   frontmatter fields declared `ref`/`ref-list`, and there is no wikilink or
   Markdown-link parsing (`packages/tropo/tropo.py:1133-1137`; observed 403 nodes and 0
   edges).
6. R1/R2. The preset is a label that nothing reads, so a `second-brain` and a `writing`
   workspace are byte-identical apart from one string, and changing it later is refused
   as a conflict (`create_vivary.py:5178` and `create_vivary.py:5433`; observed
   "existing file is not thin-v0.3" on a genuine thin-v0.3 file).
7. R2. The one non-code review pack Vivary ships cannot fire on the workspace the CLI
   creates, because its folders and fields are not registered types in the thin
   `workspace.toml` (`packages/ozone/ozone.py:1618` against
   `create_vivary.py:5075-5106`; observed `draft-unreviewed` on a draft whose review was
   correctly linked).
8. R3. The only private slot in the contract is excluded from retrieval:
   `.vivary/private` is in the tropo `exclude` array `_thin_workspace_toml` writes
   (`create_vivary.py:5063`; observed, a fact placed there was not returned by
   `tropo find`).
9. R2/R3. Retrieval evidence is capped at 8 files per checkout with no relevance
   ranking, so a large corpus is answered from whatever `git grep` prints first
   (`packages/core/vivary_core/workspace_content.py:56` and the lexical scorer at
   `tropo.py:3972-3995`; observed `note-1, note-10, note-100` among 200 tied matches).
10. R2. Doctor is green on a workspace whose graph has zero edges, because only
    `nodes == 0` warns (`create_vivary.py:1256`), while it is red on a vault whose notes
    carry an ordinary `title:` field, because every tropo finding including warnings is
    promoted to an error (`create_vivary.py:1246` and `create_vivary.py:1252`).

## Uncertainties

- `exo control` and `ozone verify` were not exercised. Both take a governed request
  built on a capsule, so the S6 conclusion for them is traced from the capsule
  precondition rather than observed. `ozone.verify_governed` is at `ozone.py:1304` and
  `_validate_governed_request` at `ozone.py:1013`.
- `governed_find` ran only after I put `packages/core` on `PYTHONPATH`. The installed
  environment on the box does not have `vivary-core`, so the first attempt printed
  "vivary-core>=0.2.7 is required". The behavior I observed is the in-repo code at this
  SHA, not a released install.
- `tropo find --governed "question"` failed with "unrecognized arguments" when the flag
  came before the question and worked when it came after. That looks like the known
  argparse limitation with an interspersed `nargs="*"` positional
  (`tropo.py:6548`, `text = " ".join(args.paths)`), but I did not read the parser
  construction closely enough to be certain it is not intentional.
- The vault I built had uniform synthetic note bodies, so the observed lexical tie
  ordering is a clean demonstration of the ranking rule but overstates how often real
  notes tie.
- `docs/product/multi-project/evidence.md` cites line ranges in `create_vivary.py`
  (for example 5047-5105 for `_thin_workspace_toml`) that match this SHA, so the
  evidence doc appears current. I did not verify every range it cites.
- I did not read `packages/create-vivary/create_vivary_assets/loops-skill`,
  `strato-skill`, or `active-context-skill` contents. The thin path copies none of them,
  which is why they are out of the dropped-files table beyond the row for role skills.
- `_legacy_full_plan_adopt` (`create_vivary.py:4823`) has no caller in `packages/` or
  `tests/` at this SHA. I did not check the npm launcher under a different directory, so
  I cannot rule out an external caller, though the thin plan's hardcoded empty lists
  make that unlikely to matter.
