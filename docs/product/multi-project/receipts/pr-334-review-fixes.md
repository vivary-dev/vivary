# PR 334 review corrections

PR #334 merged at `a81438e169d8dcf99dbb6b668e476a96256e21e5` while its
review was running. The review left eight findings. This follow-up makes the
next executable packet coherent before its implementation, under the owner's
2026-09-06 instruction to finish current PR work and continue the next tasks.
Runtime proof and application acceptance remain open.

## Dispositions

| Finding | Correction |
| --- | --- |
| [Iteration cap](https://github.com/vivary-dev/vivary/pull/334#discussion_r3944672848) | 20a owns three Claude iterations and both fault cases. Its required continuation owns the same bounded Codex proof; no packet silently doubles its cap |
| [Missing second-runtime proof](https://github.com/vivary-dev/vivary/pull/334#discussion_r3944672849) | Outcome 04 requires both runtime proofs. A missing Codex prerequisite keeps parity incomplete while preserving accepted Claude evidence |
| [Repeated owner decision](https://github.com/vivary-dev/vivary/pull/334#discussion_r3944672852) | The design owns decision four. Packet and outcome logs link to it and record their scoped impact |
| [Receipt index paths](https://github.com/vivary-dev/vivary/pull/334#discussion_r3944672853) | Each runtime owns a receipt root, and roles read that root's index and detail files |
| [One context window](https://github.com/vivary-dev/vivary/pull/334#discussion_r3944894822) | Each runtime proof is one packet and one context window. Prepare the dependent parity packet at the first proof's verified checkpoint |
| [Release truth](https://github.com/vivary-dev/vivary/pull/334#discussion_r3944894828) | The Unreleased entry records the direction and proof requirements with their unimplemented limits. The existing sync script generates its mirrors |
| [Adapter module ownership](https://github.com/vivary-dev/vivary/pull/334#discussion_r3944894833) | 20a names its common protocol, Claude adapter, prompts, sequencer, fixture, and tests. The continuation names the Codex adapter and parity evidence |
| [Decision provenance](https://github.com/vivary-dev/vivary/pull/334#discussion_r3944894843) | The design separates decision four from the three brief answers and links its subsequent source |
| Independent review: mutable runtime starting state | Record an immutable baseline and matching spec/oracle/prompt hashes. Each healthy or fault run uses a separate disposable copy. Codex starts from the baseline |
| Independent review: adapter invariant existed only in a log | Outcome 04's done condition owns the normative shared contract and incomplete-proof rule |
| Independent review: incomplete starter verification | A passing baseline harness asserts the starter's exact expected failures. Product tests must pass in the completed disposable candidate |
| Independent review: unspecified fault commands | A test-owned controller and exact commands reproduce the checkpoint interruption and the candidate regression |
| Independent review: missing usage ceiling | Each runtime packet requires a verified pre-call maximum within its 100,000-token balance; PR #335 follow-up below records why live calls are stopped |
| Independent review: private draft prerequisite | The tracked 20a continuation section defines the complete required 20b outputs and acceptance |
| Independent review: temporary evidence loss | A verified persistent task mount and a hash-bound export preserve the baseline and evidence across container stops |
| Independent review: candidate-only write authority | Role-specific mounts and read-only oracle/prompt views must pass live permission checks before role output can count as proof |
| Primary-source check: planner access ambiguity | Choose the paper appendix's spec/evidence-only planner boundary and enforce it through role input trees and runtime permissions |
| Primary-source check: unequal usage semantics | Retain vendor usage and separate turn definitions. Record prompt bytes and hashes without relabeling aggregate input usage as prompt tokens |

The existing planning guard requires completed dependencies for a ready packet.
It also forbids using `needs-info` for unfinished dependencies. The correction
requires 20a to create 20b before closing in the same valid graph update. The
follow-up below blocks live execution on the unsupported token bound. Separate
Codex prerequisites determine 20b's status. This introduces no packet state or
policy bypass.

## Runtime preflight

Offline disposable containers verified Python `3.11.16`, Claude Code `2.1.241`,
Git `2.43.0`, and Codex CLI `0.143.0` in image
`sha256:ffdba5d54dd6f91875fa60fc15103b6b30bb23ecaaf2d8ed65559d3cdff05bee`.
The probes ran as `ubuntu` with no network, a read-only root, all capabilities
dropped, no-new-privileges, two CPUs, 1 GiB memory, and 128 processes.
Read-only mounts of the existing authentication volumes reported Claude
`loggedIn: true`, `authMethod: claude.ai`, `subscriptionType: max`, and Codex
`Logged in using ChatGPT`. The probes made no model calls or credential copies.

`python3 -m pytest --version` failed because the image has no pytest module.
The packet uses Python's standard-library `unittest` for its new tests and
fixture oracle, removing that unnecessary install prerequisite.

Installed help controls adapter flags. Claude's `--tools` restricts available
built-ins, while `--allowedTools` approves tool use. The installed version lacks
the newer restricted-mode flags described by the current
[CLI reference](https://code.claude.com/docs/en/cli-usage). Its `--bare` option
disables subscription authentication. Role isolation still needs filesystem
boundaries and live enforcement probes. Codex exposes sandbox modes and JSONL
output, whose usage semantics follow its
[non-interactive reference](https://developers.openai.com/codex/noninteractive).

The [HoH appendix](https://arxiv.org/pdf/2609.01481v1), pages 22 to 25,
provides schematic role prompts but no reusable schemas or public runtime
implementation. The packet owns its schema and enforcement proof.

## PR 335 follow-up

| Finding | Correction |
| --- | --- |
| [Pre-call token bound](https://github.com/vivary-dev/vivary/pull/335#discussion_r3944993308) | Require an enforceable whole-invocation maximum before reserving usage; an unsupported bound stops live calls |
| [Ignored export location](https://github.com/vivary-dev/vivary/pull/335#discussion_r3944993311) | Resolve the Littleagent checkout explicitly and require ignore and containment checks before export |
| [Credential exposure](https://github.com/vivary-dev/vivary/pull/335#discussion_r3944993314) | Separate authenticated CLI state from model tool filesystems and prove canary denials |
| [Closure release truth](https://github.com/vivary-dev/vivary/pull/335#discussion_r3944993317) | Both runtime closures own canonical changelog updates and generated mirrors |
| [Parity cleanup](https://github.com/vivary-dev/vivary/pull/335#discussion_r3944993321) | The parity owner prepares itemized, restore-proven cleanup for explicit approval and retains archives for outcome 04 |
| [Claimable deterministic preparation](https://github.com/vivary-dev/vivary/pull/335#discussion_r3945089814) | Packet 20c owns preparation and deterministic tests with a receipt; 20a depends on it and keeps only its actual native-call prerequisite blocked |
| [Exact export paths](https://github.com/vivary-dev/vivary/pull/335#discussion_r3945089827) | Check each archive, manifest, and temporary output path separately for an ignore match and resolved containment before writing |

The first remote review of `2c497d6` found five additional issues. The follow-up
binds exports to the verified absolute Littleagent checkout and requires
`git check-ignore` plus containment checks. Both proof closures own their
changelog and generated mirrors. The 20b owner must prepare a restore-proven,
itemized cleanup request, preserve archives for outcome 04, and record a dated
pending approval. Model tools must have a credential-free filesystem and pass
canary probes before acceptance. The authenticated CLI remains the owner of
native authentication. The packet requires a verified maximum invocation charge
before token reservation. Missing enforcement stops only live execution.

The installed Claude parser accepts `--max-turns`, despite omitting it from
help. An offline empty-prompt probe reached input validation, while a deliberately
invalid option returned an unknown-option error. A turn cap does not bound total
tokens. The [Claude CLI reference](https://code.claude.com/docs/en/cli-usage) and
[environment reference](https://code.claude.com/docs/en/env-vars) do not establish
a whole-invocation token reservation. Codex `0.143.0` has
[post-response budget accounting](https://github.com/openai/codex/blob/rust-v0.143.0/codex-rs/core/src/rollout_budget.rs),
which also cannot authorize a bounded call in advance. Packet 20a names that
concrete missing capability and its owner as `needs-info`. No model calls ran.

A proof-only alternative with explicit call/time caps and measured token
accounting awaits the owner's approval. It is not active policy. Independent
work remains authorized while that decision or a supported bound is pending.
The continuation requires separate Codex prerequisite evidence before setting
20b ready; a Claude proof cannot establish Codex budget enforcement.

## Initial correction verification

The author ran the planning renderer and guard, the line-ending guard, and
`git diff --check`. All passed. The initial generated frontier contained 20a;
the follow-up removes it until its concrete budget prerequisite is resolved.
Packet 20c provides the ready frontier for independent deterministic preparation.

The independent recheck accepted both later findings with no contradiction.
It verified 20c ownership and its offline container boundary, 20a's dependency,
and the actual export checks. All four archive and manifest paths matched
Littleagent's ignore rule. Planning, line-ending, diff, and writing checks passed.

The independent reader rechecked all reported execution gaps and accepted the
final packet. Their planning, line-ending, and diff checks passed. They confirmed
the expected-red harness, reproducible faults, one durable usage ledger,
role-specific views, persistent evidence, and ownership transfer at 20a closure.
These checks validate routing and packet structure. Execution and cross-runtime
acceptance remain open.
