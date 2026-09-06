# Registry contract inspection receipt

Historical inspection receipt. The later owner decision marks BrowserPod
unavailable and Habitat current. Follow [the execution rules](../execution-contract.md)
and [generated frontier](../index.md) for current work; the earlier execution
selection described below is superseded.

Recorded: 2026-09-05. Packet 03a is contract and fixture inspection only.
Source and two-reader contract/fixture inspection are complete. Final publication
checks are recorded on PR #328.

## Delivered boundary

The [registry contract](../contracts/project-registry.md) separates stable project
identity, portable content identity, private root binding, repository/checkout
identity, native session identity, and BrowserPod execution-copy identity.
[Fifty-seven synthetic fixtures](../fixtures/project-registry.json) define exact decisions,
permitted effect categories, and inserted/replaced record values.

Registration is read-only with respect to project files. It does not adopt a
workspace, initialize VCS, create remotes, or start a session. Export constructs a
portable allowlist. Relocation requires current authority and root identity.
Mutation admission requires common-resource ownership, revisions, and fencing;
it never reports that file changes have happened.

## Source evidence inspected

- `packages/create-vivary/create_vivary.py`, `_thin_workspace_toml`, preserves
  the existing `thin-v0.3` workspace declaration and graph record schemas.
- The same file's `_thin_target_identity`, `_thin_plan_payload`, and
  `_thin_approval_hash` bind an adoption plan to one physical directory and exact
  inputs. Their machine-local coordinates are not portable project identity.
- `packages/core/vivary_core/workspace_observe.py` records common Git-directory
  evidence and distinguishes unavailable/failed probes from proven no-VCS state.
- `packages/core/vivary_core/workspace_model.py`, `_repository_identity`, prefers
  a remote URL before common-directory/path fallback. That graph identity is useful
  observation evidence, but is unsuitable as a stable project ID or mutation key.
- [Native ownership](../native-owners.md) keeps sessions, runs, actions, tasks,
  connections, and resources with their existing framework owners.

The reader inspected existing adoption, observation, and topology tests as evidence
for invariants. Those tests were not rerun here and do not establish BrowserPod
behavior. No production module was imported to create these fixtures.

## Review and verification

An independent source reader identified six initial gaps: exact capabilities,
cross-actor root uniqueness, attachment trigger, snapshot ownership, overlapping
no-VCS roots, and replay after later relocation. The contract now names the request
fields, refusal codes, physical-root key, expected-content revision, overlap refusal,
and current-result replay requirements. The second reader checked all 57 cases.
Corrections also made initial registry state coherent, completed Git reservation
sets, added exact receipt/digest changes, and fixed revision-check ordering.
The final equal-content case now supplies the same digest for two distinct roots.
The proposed missing packet-link finding was checked against the full worktree:
the existing 03a packet is present; the candidate folder contained only new files.

JSON parsing, unique case IDs, fixture references, and generic mutation setup were
checked without executing the product evaluator. Root inspected exact new records,
request digests, duplicate receipts, pending admission intent, and replay outputs.
The plan/link guard, line endings, diff hygiene, and both local generated-document
parity checks accompany installation. CI supplies the final documentation regression
checks on the published commit.

The JSON was rendered as synthetic data, not evaluated as registry behavior.
Packet [03b](../packets/03b-registry-contract-model.md) owns the executable model,
exact fixture assertions, concurrency/crash schedules, and deliberate failing
mutations. Outcome 03 remains in progress.

## Execution and authority limits

The owner requested Browserbase on 2026-09-05 while directing the agent to take the
next task. No Browserbase tool or usable connection was exposed by the inspected
session configuration. That observation is local to this session, not a claim that
the owner has no account. BrowserPod remains the recorded project execution choice;
the Browserbase request does not establish runtime compatibility or change hosting.
No browser, pod, app server, Habitat, WSL, model call, or credential transfer ran for
03a. Existing CI supplies documentation checks only.

The next runtime prerequisites belong to 10b. Actual file identity, native VCS
ownership, durable transaction/fencing behavior, and revision-checked write-back
remain integration evidence. Source import, product publication, account changes,
spending, and PR merge keep their existing separate gates.
