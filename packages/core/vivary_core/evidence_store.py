"""Append-only JSONL evidence store under <workspace_root>/.vivary/evidence/
(ticket #6/#20). Receipts and ContextIntegrityEvents live in separate files,
one JSON object per line, stable key order via the repo's canonicalization
helper so bytes are deterministic. Writes only ever append - no line is ever
rewritten, reordered, or deleted.

Reference-guided Python port of src/evidence/store.mjs (slice 1, ticket #84,
decision 0008). The Node module is the frozen executable oracle: bytes on
disk must be identical to what src/evidence/store.mjs would write for the
same input.

Event appends are delegated fully to the frozen v0 event contract
(vivary_core.event_contract) via create_event_log: this module never
re-implements its validation, scope rules, or idempotency semantics, it just
persists whatever create_event_log decides to accept. Receipts have no
equivalent contract yet, so this module applies a minimal shape check of its
own (schema + receipt_id + fingerprint present) plus the same accept /
duplicate / reject-on-reuse idempotency shape, for symmetry.

Language mapping (documented, deliberate; see python/README.md):
- Node's async is an I/O style, not a contract - this module is synchronous.
- open_evidence_store(...) returns a plain object (EvidenceStore) with
  .paths, .append_event(event), .append_receipt(receipt) - mirroring the
  Node module's returned {paths, appendEvent, appendReceipt}.
- evidence_paths(...) returns a dict (JS object -> Python dict) with keys
  "dir", "receipts", "events".
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Optional

from vivary_core.canonical import canonicalize
from vivary_core.event_contract import create_event_log
from vivary_core.receipt import RECEIPT_SCHEMA


def evidence_paths(workspace_root: str) -> Dict[str, str]:
    dir_ = os.path.join(workspace_root, ".vivary", "evidence")
    return {
        "dir": dir_,
        "receipts": os.path.join(dir_, "receipts.jsonl"),
        "events": os.path.join(dir_, "events.jsonl"),
    }


# Typed, documented failure for a JSONL file this module cannot safely
# replay - e.g. a corrupt or partial trailing line left by a process that
# died mid-append. Mirrors vivary_core.evidence_sync's EvidenceSyncError: a
# named error class with a stable `code`, never a raw json.JSONDecodeError
# bubbling out uncontrolled (#63). Fails closed deliberately: a store that
# silently skipped an unparseable line could silently under-replay
# idempotency state and let a genuine duplicate slip through as new. Recovery
# (truncating/repairing the torn line) is left to the operator - this module
# does not guess at intent by rewriting evidence bytes.
class EvidenceStoreError(Exception):
    def __init__(self, code: str, message: str, detail: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.name = "EvidenceStoreError"
        self.code = code
        self.message = message
        for key, value in (detail or {}).items():
            setattr(self, key, value)


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-JSON constant {value} is not valid JSON")


def _read_json_lines(path: str) -> List[Any]:
    try:
        # newline="" (no universal-newline translation): mirrors Node's
        # readFile(path, "utf8"), which never touches line endings, so a
        # split("\n") here sees exactly the bytes on disk decoded as text.
        with open(path, "r", encoding="utf-8", newline="") as handle:
            text = handle.read()
    except FileNotFoundError:
        return []
    lines = [line for line in text.split("\n") if len(line) > 0]
    result: List[Any] = []
    for index, line in enumerate(lines):
        try:
            # parse_constant: Python's json accepts NaN/Infinity literals that
            # Node's JSON.parse rejects - such a line must fail closed here
            # exactly as it would in the Node reference.
            result.append(json.loads(line, parse_constant=_reject_json_constant))
        except (json.JSONDecodeError, ValueError) as err:
            raise EvidenceStoreError(
                "corrupt_jsonl_line",
                f"{path}: line {index + 1} of {len(lines)} is not valid JSON ({err}); "
                "refusing to replay past a corrupt or partial (crash-mid-append) line",
                {"path": path, "line": index + 1, "totalLines": len(lines)},
            ) from err
    return result


def _append_json_line(path: str, canonical_text: str) -> None:
    # newline="": writes must be exactly "<text>\n" bytes, never translated
    # to os.linesep (Windows text-mode open() would otherwise turn \n into
    # \r\n, which Node's appendFile never does).
    with open(path, "a", encoding="utf-8", newline="") as handle:
        handle.write(f"{canonical_text}\n")


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


# No frozen receipt contract exists yet (unlike ContextIntegrityEvent v0), so
# this is a narrow, local shape check - not a re-implementation of anything.
def _validate_receipt_shape(receipt: Any) -> Dict[str, Any]:
    reason_codes: List[str] = []
    r = receipt if isinstance(receipt, dict) else {}
    if r.get("schema") != RECEIPT_SCHEMA:
        reason_codes.append("unsupported_schema")
    if not _non_empty_string(r.get("receipt_id")):
        reason_codes.append("missing_receipt_id")
    if not _non_empty_string(r.get("fingerprint")):
        reason_codes.append("missing_fingerprint")
    return {"valid": len(reason_codes) == 0, "reason_codes": reason_codes}


class EvidenceStore:
    """Plain object mirroring the Node module's {paths, appendEvent,
    appendReceipt} return value."""

    def __init__(
        self,
        paths: Dict[str, str],
        append_event: Callable[[Any], Dict[str, Any]],
        append_receipt: Callable[[Any], Dict[str, Any]],
    ) -> None:
        self.paths = paths
        self.append_event = append_event
        self.append_receipt = append_receipt


def open_evidence_store(
    *, workspace_root: str, project: str, visibility: str, policy_version: str
) -> EvidenceStore:
    """Open (creating if needed) the append-only evidence store for a
    workspace. Existing JSONL files are replayed on open to rebuild
    idempotency state, so duplicate appends stay no-ops across process
    restarts, not just within one.
    """
    paths = evidence_paths(workspace_root)
    os.makedirs(paths["dir"], exist_ok=True)

    log = create_event_log(project=project, visibility=visibility, policy_version=policy_version)
    for event in _read_json_lines(paths["events"]):
        log.append(event)

    receipts_by_id: Dict[str, str] = {}
    for receipt in _read_json_lines(paths["receipts"]):
        receipts_by_id[receipt.get("receipt_id")] = canonicalize(receipt)

    def append_event(event: Any) -> Dict[str, Any]:
        outcome = log.append(event)
        if outcome["decision"] == "accepted":
            _append_json_line(paths["events"], canonicalize(event))
        return outcome

    def append_receipt(receipt: Any) -> Dict[str, Any]:
        verdict = _validate_receipt_shape(receipt)
        if not verdict["valid"]:
            return {"decision": "rejected", "reason_codes": verdict["reason_codes"]}

        canonical_text = canonicalize(receipt)
        receipt_id = receipt.get("receipt_id") if isinstance(receipt, dict) else None
        seen = receipts_by_id.get(receipt_id)
        if seen is not None:
            if seen == canonical_text:
                return {"decision": "duplicate", "reason_codes": []}
            return {"decision": "rejected", "reason_codes": ["receipt_id_reuse"]}

        receipts_by_id[receipt_id] = canonical_text
        _append_json_line(paths["receipts"], canonical_text)
        return {"decision": "accepted", "reason_codes": []}

    return EvidenceStore(paths, append_event, append_receipt)
