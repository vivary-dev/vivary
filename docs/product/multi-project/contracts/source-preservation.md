# Source-preservation manifest contract

Status: contract for synthetic fixtures. No real source preservation is proved.
Owner: outcome 02. First packet: [02a](../packets/02a-source-preservation-fixture.md).

## Manifest fields

| Field | Required meaning |
| --- | --- |
| `schemaVersion` | Exact supported manifest version; unknown versions fail before writes |
| `sourceId` | Stable source alias; public manifests contain no private root or remote |
| `owner` | Named preservation writer; not authority to publish the source |
| `files[].path` | Relative POSIX path, unique under the destination's case rules |
| `files[].kind` | Regular file; links require an explicit later link-preservation policy |
| `files[].sha256` | SHA-256 of original bytes, not decoded or normalized text |
| `files[].size` | Original byte length |
| `files[].class` | Tracked-clean, tracked-dirty, untracked, or selected-ignored |
| `files[].destination` | Relative destination inside the single disposable restore root |
| `history` | Commit/ref or bundle evidence; separate from working-file coverage |
| `attribution` | Source owner and reviewed applicable license/disposition |
| `exclusions` | Named classes omitted and why; omission is never successful preservation |

Exact roots, remote coordinates, hosted issue exports, user-authored ignored
resources, and runtime state belong in a private companion manifest. Do not
assume `git ls-files`, a Git bundle, or an ignore-aware archive captures them.
Secrets are not copied into public fixtures. A requirement to preserve a secret
must use an authorized secret backup mechanism with its own receipt.

## Plan, apply, and verify

1. Inventory the selected source without modifying it. Hash source bytes before
   constructing a restore plan. Reject unknown file kinds, absent files, duplicate
   destinations, absolute paths, traversal, and path/case aliases.
2. Bind the plan to source hashes, destination state, schema, and intended scope.
   Inspect each path component without following a link outside the selected root.
   A symlink or changed source requires a new verified plan.
3. Restore into a disposable empty target. Refuse an existing unexpected file.
   Do not silently overwrite, merge, normalize line endings, or change source bytes.
4. Write the receipt only after every selected output is verified against its
   original size/hash and the source is confirmed unchanged.
5. On interruption, record incomplete status and owned partial outputs. Resume
   only after source and target still match the bound plan. Never mark the whole
   manifest restored because some files exist.
6. Repeating the same completed request verifies the identical result. It must
   not duplicate files, erase target additions, or overwrite a changed destination.

The implementation must use file-system operations with explicit error handling
and a tested no-follow policy. Comparing textual path prefixes is insufficient.
Host-specific case, reserved names, junctions, and file locking require platform
evidence before claiming that platform is supported.

## Acceptance fixtures

[The fixture file](../fixtures/source-preservation.json) defines inputs and named
expected results. It is a test oracle, not an executable implementation. Cases
cover success, repeats, missing source, wrong hash, destination aliases, traversal,
links, interruption, and target changes. The harness must fail if it accepts a
rejected case or changes source bytes.

Packet 02b must implement and run the fixture harness in BrowserPod. Actual
source application follows only after path-specific rights, private selection,
history capture, and disposable restoration evidence are available. Neither
packet 02a nor synthetic 02b results close outcome 02 by themselves.
