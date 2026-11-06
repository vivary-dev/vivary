# Original review and control tools acceptance

Evidence-record: 09c
Date: 2026-09-26
Issue: [#20](https://github.com/vivary-dev/Vivary-New/issues/20)
Latest verified source: `33cbcbb71fa606118d0c02a0d5555a65025623b6`
Hosted result: the 22-step journey passed three runs in a row on `33cbcbb` (runs `run-33cbcbb-04` to `06`), with Workbench and the bundled Python runtime built from that commit. Runs 01 to 03 on `33cbcbb` failed one step because the journey's own expectation was wrong, described under Hosted journey. Earlier heads: one run on `e96871d` passed 17 of 18 steps and found the existence oracle described under Review. Two runs on `24461c0` passed all 20 steps they ran. A local fake model provider drove the agent, so no real model was called.
Packaged Windows result: the unpublished `1249572d` package passed Review, Impact, Decide, claim, and release in Project details and all 14 checks of an agent turn on 2026-09-26, described under Packaged Windows journey. `1249572` adds only documentation to `33cbcbb`. A local fake model provider drove the agent.
Delivery status: [PR #95](https://github.com/vivary-dev/Vivary-New/pull/95) merged into `dev` as `7fb73bd` on 2026-09-26 after the owner approved its Entire trail, and the owner closed issue #20 the same day. The work came from `feat/review-control-tools`, from `dev` `a08405d`, in eight commits: `60f78a0`, `192a91b`, `f096c5c`, `eabdabb`, `e96871d`, `5aa6aa6`, `24461c0`, and `33cbcbb`.

## Result

The Details panel and the Native agent run Ozone's review and impact through the
same privacy-filtered path. Review and impact are two more operations of the
09b read module, `packages/workbench/server/project-read.ts`, and of the
`vivary-project-read` agent tool. They carry no actor, so the owner and the
agent receive the same report.

Decide and control move off the owner-only `vivary-original-command` action to
a second agent tool, `vivary-project-evaluate`, and an owner action,
`vivary-project-evaluate-owner`. Both call
`packages/workbench/server/project-evaluate.ts`. The server binds the actor.
A tool call is always this project's agent, with contributor authority. The
owner evaluates as themself or as that agent. The agent may run decide and
four control operations. Every result carries `persisted: false`, and Vivary
saves nothing. No Strato, Exo, or Core policy code changed, and no store,
table, worker, or executor was added.

Project details gains Review and Impact sections after Find, and a new
Evaluate panel with Decide and Control sections. The panel has no actor,
project, authority, or clock field. Every result starts by naming who
evaluated it, then shows this notice: "Evaluation only. Vivary did not save
this result, and it does not authorize or start any work."

## Owner decisions

The owner resolved the packet's open needs on the issue on 2026-09-26:

> Ozone review and impact get a privacy-filtered public path so the panel and
> the agent receive the same filtered result, and Native tool calls to decide
> and control bind a server-derived agent actor with contributor authority
> that the model cannot choose.

The same comment reads two limits out of the done condition: "a tool caller
cannot submit decide receipt or verdict fields, and state-returning control
operations return unpersisted results."

The implementation design, synthesized from four independent design runs,
turned these into ten decisions. The ones that shape this receipt:

- Review and impact join the 09b reads. The design gives the reason: "They
  carry no actor, so owner and agent receive byte-identical reports."
- Decide and control get their own tool, because control's runner row takes
  the per-project write lock and the read tool is annotated `readOnly: true`.
  In the design's words, "A read tool would misstate a write-locked,
  evidence-taking call."
- "The agent may run an operation only when the server can supply or verify
  every input." The operation table below applies this rule.
- Server-owned fields are refused by name. "Nothing is overwritten, so an
  elevation attempt stays visible."
- No capsule producer. "This packet does not build a producer."

## Agent operations

The agent may run decide and the first four control operations. The owner, as
themself, may run all eight and may pass decide's `receipt` and `verdict`,
which the result labels caller-provided evidence, as the original CLI accepts
them. Exo's request fields are in `packages/exo/exo.py` lines 45 to 89, and
its dispatch is in lines 760 to 819.

| Operation | Caller supplies | Server supplies | Agent | Reason |
| --- | --- | --- | --- | --- |
| claim | `state.claims`, `paths`, `lease` | `actor`, `now`, `authority_class`, `scope.project`, and host paths | Yes | Only state and scope come from the caller. The server checks each claim's project, paths, and authority. |
| release | `state.claims`, `claim_id` | `actor` | Yes | Core compares the claim holder to the bound actor. |
| expire_leases | `state.claims` | `now` | Yes | Only the clock is sensitive, and the server owns it. |
| dependencies | `state.tasks`, `task_id` | Nothing | Yes | This is a graph read over caller state. |
| task_view | `state.task`, `state.execution_log` | Nothing | No | Core calls the log "immutable execution evidence" (`packages/core/vivary_core/control_tasks.py` line 81). Only `record_execution` creates it, from a receipt (`control_execution.py` line 202). Native holds no receipt, so an agent's log is a claimed verification result. |
| complete | `state.task`, `state.execution_log` | Nothing | No | The log is the same as for task_view. `mark_task_done` ignores it (`control_tasks.py` lines 59 to 66), so an empty server log would produce a "done" with no evidence. |
| handoff | `claim_id`, `receipt`, `capsule`, `to_actor`, `workspace_revision` | `from_actor`, `created_at`, `to_authority_class` | No | It takes an execution receipt that Native cannot verify. |
| record_execution | `receipt`, `capsule`, `state.execution_log` | Nothing | No | It has the same receipt problem as handoff. |

Three of the four design runs allowed `complete` for the agent. The table
overrules them on the code cited above. Strato, Exo, and Core source did not
change on this branch, so these line numbers hold at `33cbcbb`.

An owner handoff names its recipient as `me` or `agent`, and the server
resolves the id. An agent call that names `receipt`, `verdict`, or
`execution_log` is refused by name as `agent_forbidden_evidence`.

Through the real Native tool, an owner-only operation never reaches Vivary.
Native checks each call against the tool's advertised operation list first and
answers "input/operation must be equal to one of the allowed values". Vivary's
own `owner_only_operation` refusal appears for the owner's agent mode and in
the server tests.

## Public review and impact

The CLI gains `vivary review --public` and `vivary impact --public`. Both build
their graph with `tropo.public_graph`, which takes nodes and edges only from
Tropo's privacy-filtered document snapshot. That snapshot applies the privacy
policy before it reads a file and checks it again after. A note that Git
ignores, a sensitive name, or a thin workspace's private path therefore never
becomes a node, so its path, id, type, and links never reach a rule.

- A link from a public note to a private note reads exactly like a link to a
  missing id. Both are a `broken-edge` finding that keeps its source note and
  link field and drops the target.
- Findings carry a rule code and no free-text message, because Ozone's
  `broken-edge` message names the target. The app renders each rule from a
  closed table of ten sentences, and an unknown rule makes the report
  unreadable instead of passing text through.
- Impact gives a private, missing, or unknown target one refusal,
  `target_unavailable`, and the panel shows "No shared note in this project
  has this id." Dependents come only from public links, so the count is a
  lower bound. The panel says that a note reaching the target only through a
  private file is not counted.
- Only the Structure and Editorial packs run publicly, because both take only
  nodes and edges. Context budget reads routing files from disk.
  `--pack context-budget --public` fails as an argument error.
- A folder that is neither a Git worktree nor a Vivary workspace gets
  `privacy_policy_unavailable`, as 09b find and check do.
- Public note ids longer than 256 characters are left out and counted as
  `unsafe_identifier`, so Show impact can always query an id the panel shows.

A public note linked only to a private note can draw an `orphan` or
`change-unverified` finding. That is the intended cost of hiding the private
note.

## Actor binding

The agent's id is `agent_` plus the SHA-256 of
`vivary.native-agent/v1`, the owner's actor id, and the project id, joined by
NUL bytes. It is 70 ASCII bytes, inside Core's 256-byte limit. Core's
`can_hold_authority` admits an agent contributor and refuses an agent owner
(`control_actors.py`). Tests in `192a91b` pin that Strato and Exo accept this
actor, refuse it as owner, and keep another agent from releasing its claim.

The design rejected two other ids. A per-chat id would strand claims, because
the tool context has no thread id. A workspace-wide id would let claims cross
projects.

`packages/workbench/server/governed-request.ts` builds the whole Strato or
Exo document and is the only writer of the actor, contributor authority,
project scope, and clocks. The server takes both clocks after it holds the
project lock, so Strato's `stale_capsule` measures against real time. Input
that names a server-owned field is refused by name with
`server_owned_field`. On the tool path `evaluateAs` counts as server-owned.
Each refusal happens before any child starts and writes no request file and
no receipt line.

The owner as themself cannot release a claim the agent holds, because Core
compares the holder. Exo returns `not_claim_holder`, and the panel shows it as
"Exo refused".

## Path codec

Host paths reach the model only as `.` and `./` project paths. The codec
rewrites a string only at an absolute-path position that Core, Strato, or Exo
declares, and each position names Core's spelling for it: the canonical
spelling for capsule paths and the decide scope echo, and the claim-scope
spelling for claim ledgers and claim results. `PATH_POSITIONS` in
`governed-request.ts` lists the 27 positions with their source lines. Decoding
restores the exact spelling, so a returned claim keeps its `claim_id` and a
passed-back capsule keeps its fingerprint. Every other string is text. Text is
redacted on the way out and never rewritten on the way in, so a capsule
command such as `./gradlew build` survives a round trip byte for byte.

An agent's scope and capsule paths are checked by their text alone, never on
disk. A claim on a path under an existing private file and a claim on a
random name give the same result. The owner as themself keeps the disk walk,
which refuses a link that leaves the project.

The codec fails closed where it cannot be exact:

- Core folds a path with Python's `casefold`, and the codec folds with
  `toLowerCase`. The two differ for a few characters, such as U+00DF. A root
  spelled with one of them never matches Core's claim spelling, and the codec
  returns `unencodable_evidence` instead of guessing. A looser fold is used
  only to detect that case.
- A root in the Windows device namespace, such as `\\?\` or `\\.\`, is refused
  as `unsupported_root` before any child starts. Core's two normalizers
  disagree on such a root. Node's `realpath` does not return one for an
  ordinary folder.
- A capsule task filter with `field: "path"` holds a path in
  `task.filters[*].equals` or `includes`, and its claim repeats it. The table
  cannot name a position that depends on a sibling field, so these values pass
  as text. That is safe only while no Strato or Exo output echoes a capsule,
  and none does. A comment beside `PATH_POSITIONS` records this.

A differential test runs Core's own normalizers through Python on six Windows
roots and matches the codec on all six. The packaged Windows run added a claim
and its release through the panel and the agent on a Windows project root,
which returned `./docs` and no host path. It did not test a root with a
casefold difference or a device path, so those two limits rest on the unit
tests.

## Review

Three models reviewed `e96871d` in round 1: Fable (8 findings), Opus (9), and
GPT-6 Astra with a GPT-6 Sol pass (3). All three found the first item, which
makes it the highest-confidence finding. Fixes landed in `5aa6aa6` and
`24461c0`:

- An agent claim on a path under an existing private file was refused as
  `foreign_path`, while a claim under a missing name ran. The difference
  revealed that the file exists. Agent paths are now checked by text only, and
  a test runs real Exo and Strato on a Git-ignored file and a link against a
  random name and finds equal results.
- The codec rewrote genuine capsule text, such as a `./` command, and assumed
  one spelling per location, so a capsule could fail its own fingerprint. The
  codec now works by declared position, as described above.
- A Core refusal inside an ordinary result, such as a claim with decision
  `refused`, rendered like a grant. The server now names Strato or Exo as the
  refuser, and the panel shows a decision line as an alert and hides Use this
  state.
- Refusals after a run were titled "Vivary refused before running". They now
  read "Vivary could not return this result".
- One agent policy lived in three layers with three error channels. The
  validator now returns one typed refusal.
- Ozone loaded Tropo at import and again per plain run, which made two engines
  with different error classes. The loader is now cached, and a missing Tropo
  keeps the install hint.
- `evaluateAs` on the tool path got a generic schema error. It is now refused
  by name.
- A granted claim now adds "Vivary did not record this claim. No one else can
  see it."
- Node id limits disagreed across layers. Public ids are capped at 256.
- An owner handoff needed an earlier evaluation to learn the agent's id. The
  owner now names `me` or `agent`.
- Stdout is parsed once, and the rule list is read by importing Ozone instead
  of matching its source text.

Round 1 also asked for a test that a Windows device root fails closed, which
`24461c0` adds. Folding the governed branches into one runner step was not
done, because the typed refusal did not make it smaller. A rendered component
test for the panels was declined, because the repository has no component test
harness. The hosted journey renders every state at desktop width and 360
pixels instead.

Round 2 reviewed `24461c0` with Fable and with GPT-6 Astra and a GPT-6 Sol
cross-check. Both found all eleven round 1 items fixed. The GPT-6 review
reported no new proven finding and could not verify the position table without
Core, Strato, and Exo source. Fable checked each output position against that
source and found none missing. Fable's findings, fixed in `33cbcbb`:

- A warning. `expire_leases`, `record_execution`, `complete`, and `task_view`
  refuse through reason codes with no decision field, and the panel showed
  those as successes with Use this state. An Exo result with no decision and
  any reason code now names Exo as the refuser.
- The panel hid a refused claim's conflict list, which the owner needs to
  resolve the conflict. A refusal inside a result now keeps its output.
- Any unexpected validator error became `identity`, whose message blames claim
  ownership. It is now `request_invalid`.
- Capsule path filters sit outside the position table. A code comment now
  records the gap.

The hosted journey on `24461c0` showed "Exo refused" in the same bold text as
a success line. `33cbcbb` also gives refusal titles and non-success decisions
the destructive style.

Round 3 reviewed `33cbcbb` with Fable. It found all four round 2 items and the
refusal style fixed, traced every Exo result path to confirm that no Core
success reads as a refusal, and reported no new findings.

## Hosted journey

Each hosted run built Workbench and the bundled Python runtime from the tested
commit on Zo, started from a fresh data folder and fixture, and used a local
fake model provider. The fixture holds a Git-ignored note, a public note that
links to it, and a public note that links to a missing id. A capsule for Decide
was compiled with the checkout's own `compile_task_capsule`. The steps:

- Review lists findings, and the page names no ignored note. A link to the
  private note reads the same as a link to a missing id. Show impact on a
  finding runs Impact. Private and random ids show "No shared note in this
  project has this id."
- Decide as the owner returns `act` with its notice, and a malformed capsule
  shows "Strato refused" with Strato's reason codes.
- The owner claims `docs` as this project's agent and gets "Decision:
  granted" and the claim notice. Use this state carries the ledger to a
  release, which returns "Decision: released".
- A release by the owner as themself of the agent's claim shows "Exo refused"
  with `not_claim_holder`. An expire_leases by the owner on a claim that
  passes Workbench's project check but lacks Exo's other fields shows "Exo
  refused" with `unknown_claim_shape`. An expire_leases on a claim with no
  readable scope shows "Vivary refused before running" with `request_invalid`
  and writes no receipt.
- Every refusal alert has the destructive left border and title color, and a
  non-success decision line uses the same color.
- In one agent turn, the agent's review and impact deep-equal the panel's. Its
  claim equals the owner's agent-mode claim apart from clocks and the claim id.
  Calls that name `actor` or `evaluateAs`, and a call to `complete`, are
  refused. A claim under the ignored note equals a claim under a random name.
- No tool result holds a host path. The project tree hash and authored files
  are unchanged. Each child run writes one receipt, and no refusal writes one.
- Every section fits a 360-pixel viewport with no horizontal scroll, and no
  page error appears.

The run on `e96871d` passed 17 of its 18 steps. The ignored-file claim step
failed, which is the existence oracle round 1 fixed. The two runs on `24461c0`
passed all 20 steps they ran, with 18 receipt lines for 18 child runs.

Runs 01 to 03 on `33cbcbb` passed 20 of 21 steps. Each failed the
expire_leases step because the journey's expectation was wrong. Its example
ledger, `{"claims": [{"bad": true}]}`, never reaches Exo. Workbench's own
project check cannot read that claim's scope and refuses it as
`request_invalid` first, which is the behavior `33cbcbb` added. The journey was
corrected to send a claim that passes the project check, so Exo runs and
refuses it, and a new step covers the `request_invalid` case. Runs 04, 05, and
06 then passed 22 of 22. Each wrote 19 receipt lines for 19 child runs, and
the `request_invalid`, `actor`, `complete`, and `evaluateAs` refusals wrote
none. Every 360-pixel layout measured a scroll width of 360.

Three observations are not fixed in #20:

- In light mode the destructive red that refusal titles use measures 2.75 to 1
  against the white panel, below the 4.5 to 1 that WCAG AA asks for text this
  size. The light and dark `--destructive` values in `global.css` look swapped.
  The token is app-wide and predates this work, and a follow-up is filed.
- At 360 pixels, the project header's tab strip cuts "Search" short. The page
  scroll width stays 360.
- About 1.5 seconds after the agent's final reply, the chat still shows a
  "Thinking" line and the stop button.

## Packaged Windows journey

The unpublished `1249572d` Windows ZIP has 3,118 files, 223,831,130 bytes, and
SHA-256 `74573156a2add16a2e49c677fcedfffb4df4d064503e1a4779554f751c6ecc3a`. It was built on Zo from `1249572`, which adds only
documentation to `33cbcbb`, and its hash on the Windows laptop equals the Zo
package record. Its Workbench metadata reports `sourceCommitVerified: false`,
so source identity rests on the clean build and package receipts.

On 2026-09-26 the EXE opened the isolated profile retained from the #19 check,
with a local fake model provider. In RelayService's Project details:

- Review with the Structure pack reported 5 notes reviewed, 0 warnings, and 5
  suggestions, and said 2 private files were excluded. No private note
  appeared anywhere in the page.
- Impact on `relay` reported "No shared note links to this one." with the
  private-exclusion note. Impact on the Git-ignored `private-plan` and on a
  random id showed the same alert, "No shared note in this project has this
  id."
- Decide as the owner with a malformed capsule showed "Strato refused" with
  `invalid_workspace`, `invalid_scope`, `invalid_capsule`, and
  `invalid_capsule_observed_at`, the evaluator line, and the notice.
- A claim on `docs` as this project's agent returned "Decision: granted" with
  scope `./docs`, no host path, and the claim notice. The operation list showed
  the four owner-only operations disabled and marked "(only you)". Release
  with Use this state returned "Decision: released" with no claims left.

A Native chat in RelayService then ran the journey prompt through the fake
provider, and all 14 agent-turn checks passed:

- The agent was offered the tools, and the tool bound the agent actor.
- No tool result held a host path or a private note name.
- Review and Impact reported, and private and random Impact targets got the
  same refusal.
- The claim was granted with scope `./docs`, and a claim under the ignored path
  equaled one under a random path after masking.
- Calls that named `actor` or `evaluateAs` were refused by name, and
  `complete` was refused by Native's schema check.
- The release returned `released`.

The reply read `JOURNEY-DONE release:evaluated`. After the run, the
RelayService project and fixture snapshots matched their earlier snapshots,
Vivary and the provider had stopped, and the app and provider ports were
closed. The first fixture snapshot was of a fixture folder that is not the
registered project. The registered project was snapshotted after one read-only
Review had run, so its earlier snapshot does not cover that first Review.

## Verification

On `33cbcbb` on Zo:

- The packet's pytest command passed 275 tests.
- The Tropo and front-door suites passed 291 tests with 215 subtests.
- Workbench `typecheck` passed.
- The two CI tsx lists passed 69 of 69 and 383 of 383.
- The two CI node lists passed 28 of 28 and 12 of 12.
- `git diff --check` was clean.

CLI parity ran before `f096c5c`. Five server-built documents gave identical
results from an installed bundled runtime built from `f024979` and from the
source components. They were an agent decide on a stale capsule, an owner
decide with a verdict and no receipt, and an agent claim, expire, and
malformed dependencies. This receipt records no rerun after the codec changed
in `24461c0`.

The Workbench tests cover:

- Parity. The owner's agent mode deep-equals the tool result for the same
  input and clock, and review and impact reports match between owner and chat.
- Refusals. Each server-owned field is refused by name, each owner-only
  operation and each evidence field is refused for the agent, and an absolute
  or `..` path gets `foreign_path`. The project records are unchanged after a
  server-owned field or path refusal. A state the runner cannot check gets
  `request_invalid`.
- Core outcomes. A capsule observed 301 seconds before server time gets
  Strato's `stale_capsule`. A verdict without a receipt as the owner gets
  Strato's `verdict_requires_receipt`. Exo's refusals and Core's reason codes
  pass through verbatim. Each Core refusal inside a result names its refuser.
- The codec. A claim then release round-trips on Linux and in Windows
  spelling, and a device root fails closed.
- Registration. The tool flags are pinned, and the chat resolves the project
  from its scope only.

## Known limits

- Native has no capsule producer. A capsule's scope must be absolute and
  fingerprinted, and Native cannot compile one. An agent decide without a
  capsule the owner handed over ends in Strato's own `invalid_capsule` or
  `capsule_fingerprint_mismatch`. The tool description says so.
- The server copies the workspace fingerprint from the capsule, because Native
  cannot compute one. Strato's `workspace_mismatch` is therefore a
  self-consistency check only, and every decide notice says so.
- Release version floors are not raised. `vivary-ozone` still declares
  `vivary-tropo>=0.3.0`, but `public_graph` is new, and the front door still
  requires Ozone 0.3.2. An installed Ozone paired with an older Tropo fails on
  a public read. The bundled app ships every package from one source tree, so
  the app is not affected. The floors must rise when these packages release.
- The Windows path spellings have one packaged pass. A claim and its release
  round-tripped through the panel and the agent on the `1249572d` package. A
  root that Python's casefold spells differently still fails closed as
  `unencodable_evidence`, and a device-namespace root is still refused.
- No real provider turn has run. A fake provider drove every agent step, so
  this receipt does not claim a real model's tool choices. Real Native-provider
  turns belong to [issue #50](https://github.com/vivary-dev/Vivary-New/issues/50).
- An agent can get a granted claim on a path that is a link out of the
  project, because agent paths are checked by text only. Vivary saves nothing
  and runs nothing, so this is accepted.
- Public review output from the CLI has no findings cap. The read module's
  result limit bounds what the panel and agent receive.
- The hosted runs used synthetic projects on Zo, not an ordinary user profile.
  The private handoff keeps the screenshots, provider logs, and journey
  results.
