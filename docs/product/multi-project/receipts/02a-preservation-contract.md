# Preservation contract review

Evidence-record: 02a
Recorded: 2026-09-05. Contract and synthetic-fixture work only.

The [manifest contract](../contracts/source-preservation.md) and
[acceptance fixtures](../fixtures/source-preservation.json) specify byte identity,
unchanged source, no overwrite, path/link/case refusal, repeat behavior, and
interruption recovery. The fixture contains synthetic text and a known SHA-256
digest, not private source or historical commits.

The source classes distinguish working files from Git history, ignored resources,
hosted assets, and runtime state. Real coordinates remain private. A source's
license and its preservation proof are separate requirements.

The correction pass now defines one strict top-level manifest, a separate
synthetic source-tree representation, generic setup mutations, global source
immutability, exact no-write semantics, and explicit expected target, receipt,
and temporary states. Thirty-three bounded cases cover successful and repeated restore,
source and target changes, collisions and unsafe paths, links, interruption and
resume, stale receipt binding, malformed JSON, duplicate keys, schema versioning,
and invalid fields. History, attribution, license disposition, and exclusions are
structured. Public errors and receipts may not expose raw bytes or private values.

Review status: two-reader contract review is complete. Root checked the structured
setup, mutation operations, hash constants, validation order, positive resume,
wrong-type refusal, and source aliases. JSON parsing succeeded with 33 unique
cases. The unchanged planning guard and all 17 adversarial tests passed in
[CI](https://github.com/vivary-dev/vivary/actions/runs/33990271792); final publication checks run on PR #328. Packet 02a is complete as
contract inspection. Runtime behavior remains unproved. No file
operation or restoration command has been executed. [02b](../packets/02b-restore-fixture-harness.md)
owns actual file operations and adversarial tests in BrowserPod. Outcome 02
remains incomplete.
