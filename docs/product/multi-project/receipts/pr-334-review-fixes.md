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
| Independent review: missing usage ceiling | Each runtime packet stops on its recorded 100,000-token accounting budget, with native or streamed metering and explicit measurement limits |
| Independent review: private draft prerequisite | The tracked 20a continuation section defines the complete required 20b outputs and acceptance |
| Independent review: temporary evidence loss | A verified persistent task mount and a hash-bound export preserve the baseline and evidence across container stops |
| Independent review: candidate-only write authority | Role-specific mounts and read-only oracle/prompt views must pass live permission checks before role output can count as proof |
| Primary-source check: planner access ambiguity | Choose the paper appendix's spec/evidence-only planner boundary and enforce it through role input trees and runtime permissions |
| Primary-source check: unequal usage semantics | Retain vendor usage and separate turn definitions. Record prompt bytes and hashes without relabeling aggregate input usage as prompt tokens |

The existing planning guard requires completed dependencies for a ready packet.
It also forbids using `needs-info` for unfinished dependencies. The correction
therefore keeps 20a executable and requires it to create 20b when its verified
inputs exist, before closing 20a in the same valid graph update. This introduces
no packet state, policy bypass, or false authentication blocker.

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

## Verification

The author ran the planning renderer and guard, the line-ending guard, and
`git diff --check`. All passed. The generated frontier contains 20a.

The independent reader rechecked all reported execution gaps and accepted the
final packet. Their planning, line-ending, and diff checks passed. They confirmed
the expected-red harness, reproducible faults, one durable usage ledger,
role-specific views, persistent evidence, and ownership transfer at 20a closure.
These checks validate routing and packet structure. Execution and cross-runtime
acceptance remain open.
