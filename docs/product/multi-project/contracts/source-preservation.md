# Source-preservation manifest contract

Status: synthetic filesystem contract verified in Habitat by [02b](../receipts/02b-restoration-fixture.md). No real source preservation is proved.
Owner: outcome 02. First packet: [02a](../packets/02a-source-preservation-fixture.md).

## Manifest schema version 1

The manifest is one JSON object. Its fields are top-level fields. Reject unknown
fields so a misspelled preservation instruction cannot be ignored.

| Field | Required meaning |
| --- | --- |
| `schemaVersion` | Integer `1`; reject every other value before filesystem access |
| `sourceId` | Non-empty stable alias with no private root, remote, or credential |
| `owner` | Non-empty preservation-writer label; not publication authority |
| `files` | Non-empty array of selected regular files |
| `files[].path` | Unique relative POSIX source path |
| `files[].kind` | Exactly `file` in version 1; links require a later policy |
| `files[].sha256` | Lowercase 64-character SHA-256 of original bytes |
| `files[].size` | Non-negative integer byte length |
| `files[].class` | `tracked-clean`, `tracked-dirty`, `untracked`, or `selected-ignored` |
| `files[].destination` | Unique relative POSIX path inside one restore root |
| `history` | Object with `kind`, `evidenceRef`, and `reason`; working bytes remain separate |
| `attribution` | Object with `sourceOwner`, `licenseDisposition`, and reviewed boolean |
| `exclusions` | Array of objects with an omitted `class` and non-empty `reason` |

Nested objects also reject unknown fields. `history.kind` is `none`, `commit`,
`ref`, or `bundle`; `evidenceRef` is a non-empty string for captured evidence and
is null only when `kind` is `none`; `reason` is always non-empty. Attribution has
exactly two non-empty strings and `reviewed: true`. Each exclusion has exactly a
non-empty `class` and `reason`.

The manifest never contains file content. Fixture material belongs in the fixture
source tree. Exact roots, remote coordinates, hosted issue exports, user-authored
ignored resources, and runtime state belong in a private companion manifest. Do
not assume `git ls-files`, a Git bundle, or an ignore-aware archive captures them.
Secrets use an authorized secret-backup mechanism with a separate receipt.

## Strict parsing

Parse UTF-8 JSON and validate the complete manifest before filesystem access.
Reject invalid JSON, duplicate object keys at any depth, a non-object root,
unsupported versions, missing fields, unknown fields, wrong JSON types, unknown
enum values, negative or non-integer sizes, and malformed digests. Parser errors
use stable error codes. They do not include raw manifest text, file content,
private companion values, or secrets.

Evaluation order is parse, schema, path and alias validation, source inventory,
target and receipt validation, then writes. When a fixture expects multiple schema
issues, compare `expect.issues` as an unordered exact set. Do not let later
filesystem conditions replace an earlier parser or schema result.

Paths are non-empty POSIX paths. Reject a leading slash, a drive or UNC prefix,
backslashes, NUL, empty components, `.` or `..` components, and aliases under the
declared target case policy. Reject source duplicates, destination duplicates,
and ancestor conflicts where one selected destination must be both a file and a
directory. Host-specific Unicode aliases, reserved names, junctions, and locking
need platform evidence before that platform is supported.

## Plan, apply, verify, and resume

1. Inventory without modifying the source. Hash source bytes and record the
   complete synthetic source-tree digest before constructing the plan. Reject an
   absent file, changed bytes or size, unknown kind, or source link.
2. Bind the plan to the validated manifest, source hashes, target state, schema,
   and intended scope. Inspect every source and destination path component without
   following links outside the selected roots. A link or changed input invalidates
   the plan.
3. Restore into a disposable empty target. A completed matching receipt may be
   rechecked idempotently. Without that receipt, even identical existing output is
   a conflict. Refuse an unexpected file, directory, or file-versus-directory
   ancestor conflict. Do not overwrite, merge, normalize line endings, or change
   source bytes.
4. Write a complete receipt only after every selected output matches its original
   size and hash and the whole source tree remains unchanged. The receipt binds the
   manifest digest and verified selected outputs. Public receipts contain no raw
   bytes or private companion-manifest values.
5. On interruption, record `incomplete` and the owned outputs. Resume only when the
   manifest, source, receipt binding, owned partial outputs, and target still match
   the plan. Never infer completion from files alone.
6. Repeating a completed request verifies selected outputs and preserves unrelated
   target additions. It does not duplicate files, rewrite the receipt, erase target
   additions, or overwrite a changed destination.

Rejected operations leave the target tree, receipt, and temporary-output tree
bit-for-bit unchanged. Every operation leaves the complete source tree unchanged.
Implement file operations with explicit error handling and a tested no-follow
policy. Comparing textual path prefixes is insufficient.

## Fixture DSL

[The fixture file](../fixtures/source-preservation.json) is a test oracle, not an
implementation. It has these parts:

- `defaults` selects the starting manifest, source tree, target tree, receipt,
  temporary tree, and path policy. `sourceUnchanged: true` is global.
- `manifests`, `trees`, and `receipts` contain named immutable setup values.
- Each case copies its selected setup, applies generic `mutations` in order,
  injects an optional `fault`, and compares the result with `expect`.
- `rawManifestText` may replace the manifest only in malformed-parser cases.
- Fixture tree entries use `file` plus `contentBase64`, `directory`, or `link`
  plus a synthetic target. These are test setup records, never manifest fields.

Generic mutation operations are:

- `set-json`, `remove-json`, and `append-json`, addressed by JSON Pointer in the
  manifest;
- `tree-add`, `tree-remove`, and `tree-replace`, addressed by tree name and path;
- `set-policy`, addressed by policy field.

Setup overrides defaults before mutations run. Tree mutations create the test's
starting state; source immutability and `noWrites` compare the operation's final
state with that fully prepared starting state. The sole fault operation,
`interrupt-after-output`, interrupts after the stated number of manifest-ordered
file outputs and requires an incomplete receipt.

Named values are deep-copied per case. `set-json` creates or replaces one pointer,
`remove-json` removes an existing pointer, and `append-json` appends one array
value. Tree add requires an absent path, replace and remove require an existing
path, and tree names are `source`, `target`, or `temp`. Fixture `file` entries have
only path, kind, and base64 content; directories have path and kind; links have
path, kind, and a synthetic relative target. The only mutable policy field in
version 1 is `caseSensitivity`, with `sensitive` or `insensitive`.

`expect.noWrites: true` means the target tree, receipt, and temporary tree are all
identical to their setup values. Successful or interrupted cases instead name the
expected target tree, receipt status, and temporary tree. A harness that dispatches
on case ID rather than these setup, mutation, fault, and expectation fields does
not satisfy the contract.

Packet 02b implements and runs this fixture harness in the authorized Habitat environment. BrowserPod is unavailable. Actual source
application follows only after path-specific rights, private selection, history
capture, and disposable restoration evidence exist. Neither synthetic packet
closes outcome 02.

## Fixture interpretation details

Implicit parent directories in a fixture tree are materialized before execution;
tree comparisons omit implicit directories and compare explicit entries and bytes.
Receipt references are symbolic fixture setup: materialize a referenced manifest's
digest before applying mutations, so the stale-binding case retains the old digest.
For this version, that digest is SHA-256 of UTF-8 compact JSON with object keys
sorted recursively, array order preserved, and no trailing newline.

Schema wrong types return `invalid-manifest` with `invalid-type`. Unsupported
`files[].kind` returns `unsupported-kind`; other schema enum failures use
`invalid-manifest` and `invalid-enum`. Source path aliases return `source-collision`;
destination aliases return `destination-collision`. Successful unchanged partial
resume returns `restored`. Other expected codes are named by the fixtures and
follow the validation order above. These rules avoid case-name-specific behavior.

## Executed receipt format

The version-one fixture implementation writes `restore-receipt.json` in a
separate receipt root. It records `schemaVersion`, `status`, `manifestDigest`,
`sourceTreeDigest`, and ordered `outputs` containing destination `path`, `size`,
and `sha256`. An incomplete receipt also records manifest-ordered `ownedPaths`
and `observedTargetDigest`. It contains no file bytes.

The source-tree digest covers selected and unselected entries, including file
hashes, directory names, and link targets without following links. Receipt shape,
manifest binding, whole source state, and owned output bytes are rechecked before
resume or repeat. Matching completed repeats preserve the receipt and unrelated
target additions. Preflight permission failures leave output trees unchanged.

The implementation proves controlled interruption between file outputs and
rollback of this call's newly created files and directories after handled I/O
errors. It reports `rollback-failed` if cleanup cannot complete. It does not
promise unchanged filesystem timestamps after rollback, power-loss durability,
safe concurrent mutation of path components, or support for another platform.
Actual source preservation must establish those requirements for its selected
environment before this synthetic helper is used as a production importer.
