"""Capsule digest: a pure, fingerprint-bound serializer over an UNCHANGED
canonical Task Capsule.

Reference-guided Python port of src/capsule/digest.mjs (slice 1, ticket #84,
decision 0008). The Node module is the frozen executable oracle: every
function here is translated function-for-function, and the digest dicts are
built in EXACTLY the same key-insertion order as the Node object literals,
because the final output is ``js_stringify`` (JS ``JSON.stringify`` compact,
insertion-order semantics) over those dicts - see
vivary_core.canonical.js_stringify, which this module uses for ALL digest
output. Never json.dumps: it differs from JS in number formatting, string
escaping, and key ordering.

The measured defect this module targets (unchanged from the Node docstring):
per-claim selection scaffolding (a ``selection_reason`` string plus an
``evidence`` command) is a denormalized join repeated on every claim row.
This module normalizes that: every distinct subject path, evidence command,
and (tier, reason) pair is stored once in a small lookup table; claim rows
become short tuples that reference those tables by index. Nothing is
dropped - conflicts and unknowns pass through byte-verbatim, claim text
(quotes/commands/paths) is never rewritten, and every table entry is real
content copied straight from the capsule, never summarized or reworded.

Pure and I/O-free: no fs, no subprocess, no network, no non-determinism, no
wall-clock. Same capsule object in -> byte-identical digest text out.

Language mapping notes (decision 0008 / ticket #84's documented rules):
- JS ``undefined`` <-> an absent Python dict key; ``claim.foo?.bar`` chains
  become careful ``dict.get`` chains that collapse "absent" and "None" to
  Python ``None`` wherever JS's own ``??``/optional-chaining would too.
- The one place JS's "absent" and "explicit null" are NOT the same byte
  result is the ``tierKey`` *string* built by
  ```${claim.selection?.tier} ${claim.selection_reason}```
  - a JS template literal stringifies an absent/optional-chained-away value
    as the literal text "undefined", but an explicit null as the literal
    text "null". ``_template_value`` below reproduces that distinction. The
    *stored* tier/reason values (used for the tiers table entry itself) use
    JS ``??`` semantics instead, where absent and null both collapse to
    None - that part IS ordinary ``.get()``.
"""

from __future__ import annotations

from vivary_core.canonical import js_stringify

CAPSULE_DIGEST_SCHEMA = "vivary.capsule-digest/v0"

# Lab ticket #60 / decision 0007's wave-1 gate recovery: a second, OPT-IN
# output shape ({"profile": "table"}), added alongside (never replacing) the
# default above.
CAPSULE_DIGEST_TABLE_SCHEMA = "vivary.capsule-digest/table-v0"

# Structural invariant of the Node codebase (src/workspace/observe.mjs and
# src/workspace/content.mjs): every git-derived evidence command is exactly
# this literal prefix followed by the checkout path followed by a space and
# the rest of the command. The "table" profile factors this repeated
# prefix+path out of the evidence table.
GIT_EVIDENCE_PREFIX = "git --no-optional-locks -C "

# Omission kinds that carry no per-occurrence data beyond "this policy
# applied": the reason text is a fixed, non-templated constant across every
# capsule, so a digest only needs to record that it fired, and how many
# times.
POLICY_ONLY_OMISSION_KINDS = frozenset({"ignored_paths_excluded"})

# Data-bearing omission kinds that compile.mjs/select.mjs emit as multiple
# per-subject records: each becomes a {subject, ...} entry, subject resolved
# to a subjects-table index. The exact omitted_count is always preserved -
# only the repeated boilerplate `reason` string is dropped.
PER_SUBJECT_OMISSION_KINDS = frozenset(
    {
        "dirty_paths_truncated",
        "content_lines_truncated",
        "content_files_truncated",
    }
)


def escape_table_field(value):
    """Table-profile claim row escaping: field separator is a real tab byte,
    row separator a real newline. Only the four bytes that would otherwise
    be ambiguous (backslash, tab, newline, CR) are escaped, backslash-first
    so the escape sequences themselves can never be misread as raw control
    bytes. Total, reversible encoding: exactly one way in and out."""
    if value is None:
        return ""
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )


class _SubjectIndexer:
    """Port of digest.mjs's subjectIndexer(): dedups subject paths in first-
    seen order, .ref(None) always returns None (never registers a null
    subject)."""

    def __init__(self):
        self._index = {}
        self.paths = []

    def ref(self, path):
        if path is None:
            return None
        if path not in self._index:
            self._index[path] = len(self.paths)
            self.paths.append(path)
        return self._index[path]


def subject_indexer():
    return _SubjectIndexer()


class _TableIndexer:
    """Port of digest.mjs's tableIndexer(): a generic first-seen-order dedup
    table keyed by an arbitrary key, storing an arbitrary value (used for
    both the evidence table, key == value, and the tiers table, key is the
    JS-template tier-string, value is the [tier, reason] pair)."""

    def __init__(self):
        self._index = {}
        self.entries = []

    def ref(self, key, value):
        if key not in self._index:
            self._index[key] = len(self.entries)
            self.entries.append(value)
        return self._index[key]


def table_indexer():
    return _TableIndexer()


def serialize_claims_over_budget(omission, subjects):
    """claims_over_budget is the single worst offender: select.mjs's
    overBudget omission carries an `omitted` list of {subject_path, fact,
    tier} entries (capped at OMITTED_LIST_CAP, one entry per cut claim) -
    itself a denormalized join. This collapses that list to subject+count
    pairs, insertion-ordered by first occurrence."""
    by_subject = {}
    for cut in omission.get("omitted") or []:
        ref = subjects.ref(cut.get("subject_path"))
        by_subject[ref] = by_subject.get(ref, 0) + 1
    entry = {
        "omitted_count": omission.get("omitted_count"),
        "by_subject": [[ref, count] for ref, count in by_subject.items()],
    }
    # The visible `omitted` list itself may be capped (select.mjs's
    # OMITTED_LIST_CAP): when that happened, by_subject only reflects the
    # visible portion and must say so.
    if omission.get("truncated"):
        entry["by_subject_partial"] = True
    return entry


def serialize_omissions(omissions, subjects):
    result = {}
    for omission in omissions or []:
        kind = omission.get("kind")
        if kind == "claims_over_budget":
            result[kind] = serialize_claims_over_budget(omission, subjects)
            continue
        if kind in POLICY_ONLY_OMISSION_KINDS:
            existing = result.get(kind) or {"count": 0}
            existing["count"] += 1
            result[kind] = existing
            continue
        if kind in PER_SUBJECT_OMISSION_KINDS:
            entries = result.get(kind) or []
            subject_ref = subjects.ref(omission.get("subject_path"))
            record = {"subject": subject_ref, "omitted_count": omission.get("omitted_count")}
            if kind == "content_lines_truncated":
                record["path"] = omission.get("path")
            if kind == "content_files_truncated":
                record["total_files_matched"] = omission.get("total_files_matched")
            entries.append(record)
            result[kind] = entries
            continue
        # No test-covered fixture exercises filtered_out/refused_root/any
        # future kind with a subject_path at present. Conservative default,
        # matching digest.mjs exactly: drop only the "kind" key, preserve
        # every remaining key IN ITS ORIGINAL ORDER, and - only when a
        # subject_path key is present (regardless of whether its value is
        # null) - APPEND a new "subject" ref key after it (subject_path
        # itself is kept, not replaced; this mirrors the Node object-spread
        # + property-assignment, which appends rather than reorders).
        entries = result.get(kind) or []
        rest = {k: v for k, v in omission.items() if k != "kind"}
        if "subject_path" in rest:
            rest["subject"] = subjects.ref(rest["subject_path"])
        entries.append(rest)
        result[kind] = entries
    return result


def factor_evidence_path(command, subjects):
    """Table-profile-only: factor a git evidence command's checkout path out
    into a subject-table reference, using the GIT_EVIDENCE_PREFIX structural
    invariant. Only ever consults subjects already known (from claim/
    omission processing) - never invents or renumbers a subject. Anything
    that doesn't match this exact shape is returned unfactored, verbatim,
    with a null subjectRef - the longest-matching known subject wins on an
    exact match or a path-plus-space-prefix match.

    Returns (subject_ref, remainder), mirroring digest.mjs's
    {subjectRef, remainder}.
    """
    if not isinstance(command, str) or not command.startswith(GIT_EVIDENCE_PREFIX):
        return None, command
    rest = command[len(GIT_EVIDENCE_PREFIX):]
    best_idx = None
    for idx, path in enumerate(subjects.paths):
        if not isinstance(path, str) or len(path) == 0:
            continue
        matches = rest == path or rest.startswith(path + " ")
        if matches and (best_idx is None or len(path) > len(subjects.paths[best_idx])):
            best_idx = idx
    if best_idx is None:
        return None, command
    path = subjects.paths[best_idx]
    remainder = "" if rest == path else rest[len(path) + 1:]
    return best_idx, remainder


def build_claims_table(claim_rows):
    """Table-profile-only: claim rows as a tab-separated table (one header
    line, one line per claim, in capsule.claims order)."""
    lines = ["subject\tfact\tstatus\tclaim\tevidence\ttier"]
    for subject_ref, fact, status, claim_text, evidence_ref, tier_ref in claim_rows:
        lines.append(
            "\t".join(
                [
                    "" if subject_ref is None else str(subject_ref),
                    escape_table_field(fact),
                    escape_table_field(status),
                    escape_table_field(claim_text),
                    "" if evidence_ref is None else str(evidence_ref),
                    str(tier_ref),
                ]
            )
        )
    return "\n".join(lines)


def build_evidence_tables(evidence_entries, subjects):
    """Table-profile-only: a second normalization pass over the default
    profile's exact-string-deduped evidence list - every entry's checkout
    path (if it has one) becomes a subjectRef, and the remaining distinct
    command suffixes are themselves deduplicated into their own table."""
    commands = table_indexer()
    refs = []
    for command in evidence_entries:
        subject_ref, remainder = factor_evidence_path(command, subjects)
        command_ref = commands.ref(remainder, remainder)
        refs.append([subject_ref, command_ref])
    return {"evidence_commands": commands.entries, "evidence": refs}


def _template_value(present, value):
    """Reproduces JS template-literal interpolation of `${x}` for exactly the
    two values digest.mjs interpolates this way (claim.selection?.tier and
    claim.selection_reason): an absent/optional-chained-away value
    stringifies as the literal text "undefined"; an explicit null as the
    literal text "null"; anything else via its string form. Every committed
    fixture has both selection and selection_reason on every claim, so this
    branch is exercised only by direct unit coverage of this helper, not by
    the byte-parity fixtures - ported faithfully regardless."""
    if not present:
        return "undefined"
    if value is None:
        return "null"
    return str(value)


def _claim_tier_and_reason(claim):
    """claim.selection?.tier: optional-chained, so a missing/None `selection`
    short-circuits to "not present" without inspecting `tier` at all; only a
    real `selection` mapping with a `tier` key counts as present."""
    selection = claim.get("selection")
    tier_present = isinstance(selection, dict) and "tier" in selection
    tier_value = selection.get("tier") if tier_present else None
    # claim.selection_reason: plain (non-optional) property access - claim
    # itself is always a real mapping, so presence is just a key check.
    reason_present = "selection_reason" in claim
    reason_value = claim.get("selection_reason")
    return tier_present, tier_value, reason_present, reason_value


def serialize_capsule_digest(capsule, options=None):
    """Serialize a compiled Task Capsule (compileTaskCapsule's output,
    untouched) into a compact digest: same claims, same conflicts, same
    unknowns, same omission counts - normalized selection scaffolding
    instead of a denormalized join repeated on every row.

    Pure: no I/O, no non-determinism, no clock. Deterministic: the same
    capsule always serializes to the same string, walking the capsule's own
    arrays in their existing order and never sorting, hashing, or shuffling.

    capsule: the exact dict compileTaskCapsule (Node) / its Python
        equivalent returned/would return.
    options: optional dict with a "profile" key, "default" (or omitted) or
        "table". "default" is #58's original, frozen, byte-stable shape.
        "table" (lab ticket #60) is a strictly denser, EQUAL-INFORMATION
        alternative: claim rows become one tab-separated table, and the
        evidence table further factors out each entry's checkout path.
    Returns compact text (not pretty-printed); JSON (js_stringify) for both
    profiles, with the "table" profile's claims field itself holding a
    tab/newline-delimited table as a single string value.
    """
    opts = options or {}
    profile = opts.get("profile")
    if profile is None:
        profile = "default"

    subjects = subject_indexer()
    evidence = table_indexer()
    tiers = table_indexer()

    # Claim rows are in exactly the same order as capsule.claims - every row
    # in the digest corresponds 1:1 to capsule.claims[i]. Shared, byte-for-
    # byte identically computed, by both profiles: only the final
    # serialization shape differs below.
    claim_rows = []
    for claim in capsule["claims"]:
        subject_ref = subjects.ref(claim.get("subject_path"))

        evidence_list = claim.get("evidence")
        first_evidence = (
            evidence_list[0] if isinstance(evidence_list, list) and len(evidence_list) > 0 else None
        )
        evidence_command = first_evidence.get("command") if isinstance(first_evidence, dict) else None
        evidence_ref = None if evidence_command is None else evidence.ref(evidence_command, evidence_command)

        tier_present, tier_value, reason_present, reason_value = _claim_tier_and_reason(claim)
        tier_key = f"{_template_value(tier_present, tier_value)} {_template_value(reason_present, reason_value)}"
        tier_ref = tiers.ref(tier_key, [tier_value, reason_value])

        claim_rows.append(
            [subject_ref, claim.get("fact"), claim.get("status"), claim.get("claim"), evidence_ref, tier_ref]
        )

    omissions = serialize_omissions(capsule.get("omissions"), subjects)

    # JS `{fingerprint: capsule.workspace?.fingerprint}`: when the chain
    # yields undefined, the property holds undefined and JSON.stringify DROPS
    # the key entirely (it does not write null). The Python analog of "would
    # be undefined" is "key absent" - so each key is included only when the
    # source key actually exists; an explicit None (JS null) is included.
    workspace = capsule.get("workspace")
    workspace_out = {}
    if isinstance(workspace, dict):
        if "fingerprint" in workspace:
            workspace_out["fingerprint"] = workspace["fingerprint"]
        if "observed_at" in workspace:
            workspace_out["observed_at"] = workspace["observed_at"]
    task_out = dict(capsule.get("task") or {})
    required_checks_in = capsule.get("required_checks")
    required_checks_out = [c.get("name") for c in (required_checks_in if required_checks_in is not None else [])]

    def put_from_capsule(digest, key, source_key):
        # JS plain property access (`capsule.capsule_id`) yields undefined for
        # a missing key, and JSON.stringify drops undefined-valued properties;
        # the byte-exact Python analog is omitting the key entirely.
        if source_key in capsule:
            digest[key] = capsule[source_key]

    if profile == "table":
        tables = build_evidence_tables(evidence.entries, subjects)
        digest = {
            "schema": CAPSULE_DIGEST_TABLE_SCHEMA,
        }
        put_from_capsule(digest, "capsule_id", "capsule_id")
        put_from_capsule(digest, "capsule_fingerprint", "fingerprint")
        digest |= {
            "workspace": workspace_out,
            "task": task_out,
            "subjects": subjects.paths,
            # Reconstruction constant travels WITH the digest: subjectRef ===
            # None means evidence_commands[commandRef] IS the full original
            # command; otherwise the original is
            # f"{evidence_prefix}{subjects[subjectRef]}" (+ " " + remainder
            # when remainder is non-empty).
            "evidence_prefix": GIT_EVIDENCE_PREFIX,
            "evidence_commands": tables["evidence_commands"],
            "evidence": tables["evidence"],
            "tiers": tiers.entries,
            "claims_table": build_claims_table(claim_rows),
        }
        put_from_capsule(digest, "conflicts", "conflicts")
        put_from_capsule(digest, "unknowns", "unknowns")
        digest["omissions"] = omissions
        digest["required_checks"] = required_checks_out
        put_from_capsule(digest, "budget", "budget")
        return js_stringify(digest)

    digest = {
        "schema": CAPSULE_DIGEST_SCHEMA,
    }
    put_from_capsule(digest, "capsule_id", "capsule_id")
    put_from_capsule(digest, "capsule_fingerprint", "fingerprint")
    digest |= {
        "workspace": workspace_out,
        "task": task_out,
        "subjects": subjects.paths,
        "evidence": evidence.entries,
        "tiers": tiers.entries,
        "claims": claim_rows,
    }
    # Conflicts and unknowns are the ambiguity a capsule exists to carry
    # forward, never to resolve or compress - byte-verbatim, unconditional.
    put_from_capsule(digest, "conflicts", "conflicts")
    put_from_capsule(digest, "unknowns", "unknowns")
    digest["omissions"] = omissions
    digest["required_checks"] = required_checks_out
    put_from_capsule(digest, "budget", "budget")
    return js_stringify(digest)
