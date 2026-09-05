# Preservation contract review

Recorded: 2026-09-05. Contract and synthetic-fixture work only.

The [manifest contract](../contracts/source-preservation.md) and
[acceptance fixtures](../fixtures/source-preservation.json) specify byte identity,
unchanged source, no overwrite, path/link/case refusal, repeat behavior, and
interruption recovery. The fixture contains synthetic text and a known SHA-256
digest, not private source or historical commits.

The source classes distinguish working files from Git history, ignored resources,
hosted assets, and runtime state. Real coordinates remain private. A source's
license and its preservation proof are separate requirements.

Verification pending: a second reader must check each expected outcome against
the contract and the documentation CI must pass. No restoration command has
been executed. [02b](../packets/02b-restore-fixture-harness.md) owns actual file
operations and adversarial tests in BrowserPod. Outcome 02 remains incomplete.
