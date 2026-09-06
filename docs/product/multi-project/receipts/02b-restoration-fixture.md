# 02b Synthetic restoration verification

Date: 2026-09-05. Verification kind: runtime. Packet 02b is complete.
Parent outcome 02 remains in progress.

## Artifact and environment

The original packet-completion run used the dependency-free
[restoration script](../../../../scripts/prove_multi_project_source_preservation.mjs)
to execute real filesystem operations from the then-current generic
[33-case fixture](../fixtures/source-preservation.json).
The [tests](../../../../scripts/tests/test_prove_multi_project_source_preservation.mjs)
cover restore, repeat, interruption, resume, strict parsing, no-follow checks,
permission refusal, rollback, and deliberate faulty implementation detection.
Case IDs are labels; they do not dispatch restoration behavior.

The owner confirmed BrowserPod is unavailable. The current
[execution decision](../design.md#execution-decision-2026-09-05) uses Habitat.
This run used the existing `habitat/vivary-dev:2026-08-31` image, identity
`sha256:ffdba5d54dd6f91875fa60fc15103b6b30bb23ecaaf2d8ed65559d3cdff05bee`,
with Linux and Node v22.23.2. Live inspection confirmed:

- User `1000:1000`, read-only root filesystem, all capabilities dropped,
  and `no-new-privileges` enabled.
- `network=none`, no host mounts, and no authentication volumes.
- 384 MiB memory and memory-plus-swap limit, one CPU, and 64 processes.
- `/tmp` as a 128 MiB `nosuid,nodev` tmpfs for synthetic working files.

Files were transferred over stdin. All restoration and test execution occurred
inside the container. Host activity authored and copied reviewed files and
transformed documents. No installation, provider call, app server, coding agent,
database, real-source copy, or account change occurred.

SHA-256 of the exact tested files, matched inside Habitat and at installation:

| Artifact | Digest |
| --- | --- |
| `scripts/prove_multi_project_source_preservation.mjs` | `577ee5d369cbc3a4b3676bb7b1776ee742f08b6c4b53792bbe2349bcd78d957b` |
| `scripts/tests/test_prove_multi_project_source_preservation.mjs` | `019728306a5c581f22cedb7faf06f5c05a96c14d0d5e1bcf20eaa2db5f96e192` |

These counts and digests remain the historical evidence for the original 02b
completion. The later PR review checkpoint below records expanded candidate QA
separately.

## Commands and results

Run these from the staged repository root inside the verified environment:

```console
node --test scripts/tests/test_prove_multi_project_source_preservation.mjs
node scripts/prove_multi_project_source_preservation.mjs --fixture docs/product/multi-project/fixtures/source-preservation.json --check
```

Results: **14 tests passed, zero failed**; **33/33 fixture cases passed**.
The final canonical suite took approximately 2.1 seconds. Existing Node 22 CI
now runs both commands for regression coverage.

Restored bytes include binary data, CRLF, and an empty file. Repeating a completed
request preserves selected file timestamps, receipt bytes and timestamp, and
unrelated target additions. Controlled interruption produces an incomplete
receipt. Resume verifies the source, manifest, receipt, and owned partial files.
Changed partial output is refused without creating the remaining output.
Every fixture checks whole-source immutability. Rejected cases also compare the
target, receipt, and temporary trees against their starting state.

## Failures found and corrected

The initial CLI passed 32/33 cases. The first combined run had seven passing and
five failing tests, including two external regressions. A separate independent
probe passed seven of nine checks and reproduced two implementation defects.
The corrections were:

- Missing fields and wrong JSON types now produce the contract's exact issue
  sets. A missing owner no longer also reports a wrong type; a string size does.
- Fixture `set-json` creates an own data property for `__proto__`, allowing
  strict unknown-field validation to reject it without writing outputs.
- Receipt, temporary, and existing destination-parent permissions are checked
  before writes. An unwritable receipt directory leaves no unreceipted output.
- New directories are tracked immediately after creation. New destination files
  use exclusive handles and are tracked before the first byte is written.
  Rollback removes only this call's new files and directories and reports failure
  if cleanup cannot finish.
- The tests use Node 22's assertion behavior correctly and recognize that a
  later hash guard can also reject the deliberately faulty implementation.

Both rollback regressions passed. Linux `ENAMETOOLONG` after creating a parent
directory leaves no new output. A scoped test fault writes one destination byte,
throws `EIO`, and verifies removal of the owned partial file and directory.

Independent QA subsequently passed **10/10 checks**, including decoded duplicate
keys, prototype handling, intermediate/root links, receipt newline and binding,
changed completed output, changed unselected source, corrupt partial ownership,
permission failure, and nested-directory rollback. Two coordinator regressions
for size typing and receipt permissions also passed; they overlap the canonical
coverage and are not counted as additional product capabilities.

External CLI checks observed the following exits:

| Check | Exit |
| --- | --- |
| Rename every case ID with inputs and expectations unchanged | 0 |
| Replace the source digest with an intentionally wrong hash | 1 |
| Replace one expected result with an intentionally wrong result | 1 |
| Run a temporary implementation copy with the source hash guard disabled | 1 |
| Run the unchanged original again | 0 |

The faulty copy failed `source-changed-same-size`. The original source digest
remained unchanged. The final independent reader found no remaining concrete
violation within this packet's stated scope.

## PR 328 restoration review checkpoint

Source inspection of the restoration review comments found one runner defect,
one environment-dependent test, one stale frontier sentence, and proof gaps in
otherwise implemented behavior. The review candidate expands the fixture from
33 to 47 cases. It adds an intermediate source-link refusal, exact nested
`history`, `attribution`, and `exclusions` validation, and changed selected and
unselected source bytes for complete and incomplete receipt-backed runs. The
runner now rejects empty, non-string, and duplicate case IDs before creating a
working directory. The POSIX permission test skips privileged execution because
root can bypass the directory mode bits.

The coordinator verified the final candidate in non-root Habitat:
**16 tests passed, zero failed, zero skipped; 47/47 fixture cases passed**.
The installed files match the verified SHA-256 identities in the
[PR 328 review receipt](pr-328-code-review.md). These additional synthetic cases
do not prove restoration of any real source.

The root-only skip branch was inspected but could not be exercised under this
container's unchanged isolation profile. UID 0 cannot traverse the installed
Node location with all capabilities dropped, and the temporary filesystem is
`noexec`. The test now explicitly skips Windows and `geteuid() === 0`; the
unprivileged permission-refusal test passed. Container protections were retained.

## Limits and next work

This proves synthetic, single-process Linux restoration and controlled
interruption. It does not prove power-loss durability, concurrent path mutation,
other-platform aliases or locking, private source selection, licenses, Git
history, ignored resources, hosted records, credentials, or runtime recovery.
Handled-error rollback does not promise original directory timestamps.
No production importer or source repository is declared preserved.

The generated [ticket graph](../graph.md) owns the current frontier; this
receipt does not duplicate it.
Outcome 02 still requires actual source provenance, rights, and restoration
evidence. The product QA/replanning loop and release gates remain open.

Original 02b cleanup: the tested source hashes matched the installed artifacts. The
task-owned container was identified, stopped, and removed; its identified hidden
WSL keepalive was stopped. Existing containers and authentication volumes were
preserved.
