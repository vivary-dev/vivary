"""ContextIntegrityEvent v0 - the frozen seam every module speaks through
(docs/ARCHITECTURE.md). Pure construction with deterministic identity;
occurred_at (when it happened) and recorded_at (when it was written down)
stay separate fields with separate sources.

Reference-guided Python port of src/event/contract.mjs (slice 1, ticket #84,
decision 0008). The Node module is the frozen executable oracle; this module
must match its behavior exactly.

Language-mapping notes (see python/README.md):
- JS ``undefined`` has no Python value; where a bare (no-default) Node
  destructured parameter is genuinely omitted (only ``policy`` in this
  module - every other bare field is required by every caller in the test
  suite), the resulting body key is simply left ABSENT rather than set to
  ``None``, matching how ``canonicalize``/``JSON.stringify`` drop
  undefined-valued keys in the Node reference (this is what keeps
  ``deterministic_id`` hash-stable with the omission, not just
  functionally-equivalent).
- ``causation_id``/``correlation_id`` default to JS ``null`` - Python
  ``None`` is the exact same value, so no special-casing is needed there.
- ``evidence``/``payload``/``extensions`` default to JS ``[]``/``{}``/``{}``
  on ``undefined``; Python ``None`` is treated as "omitted" for these three
  (no test exercises an explicit JS ``null`` passed for them).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from vivary_core.canonical import canonicalize, deterministic_id, fingerprint

EVENT_SCHEMA = "vivary.context-integrity-event/v0"

# Sentinel distinguishing "policy not passed at all" (JS: bare destructured
# param stays undefined) from "policy explicitly passed as None" (JS: null).
_UNSET = object()


def _default_clock() -> str:
    # JS `new Date().toISOString()`: "YYYY-MM-DDTHH:MM:SS.mmmZ" (milliseconds,
    # 3 digits, UTC, trailing Z).
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def create_context_integrity_event(
    *,
    event_type,
    occurred_at,
    producer,
    actor,
    workspace,
    subject,
    scope,
    causation_id=None,
    correlation_id=None,
    policy=_UNSET,
    evidence=None,
    payload=None,
    extensions=None,
    now=None,
):
    """envelope fields per docs/ARCHITECTURE.md; `now` is an injectable
    zero-arg clock for recorded_at."""
    clock = now if now is not None else _default_clock
    if evidence is None:
        evidence = []
    if payload is None:
        payload = {}
    if extensions is None:
        extensions = {}

    body = {
        "schema": EVENT_SCHEMA,
        "event_type": event_type,
        "occurred_at": occurred_at,
        "recorded_at": clock(),
        "producer": producer,
        "actor": actor,
        "workspace": workspace,
        "subject": subject,
        "scope": scope,
        "causation_id": causation_id,
        "correlation_id": correlation_id,
    }
    if policy is not _UNSET:
        body["policy"] = policy
    body["evidence"] = evidence
    body["payload"] = payload
    body["extensions"] = extensions

    return {"event_id": deterministic_id("evt", body), **body}


def _non_empty_string(v) -> bool:
    return isinstance(v, str) and len(v) > 0


# Strict ECMAScript Date Time String Format acceptor:
# YYYY[-MM[-DD]][THH:mm[:ss[.sss...]][Z|+-HH:mm]]
# V8's tolerant non-ISO fallbacks (e.g. "July 20, 2026") are deliberately NOT
# reproduced - documented divergence, see python/README.md.
_INSTANT_RE = re.compile(
    r"""^
    (?P<year>\d{4})
    (?:-(?P<month>\d{2})
        (?:-(?P<day>\d{2}))?
    )?
    (?:T
        (?P<hour>\d{2}):(?P<minute>\d{2})
        (?::(?P<second>\d{2})(?:\.(?P<frac>\d+))?)?
        (?P<offset>Z|[+-]\d{2}:\d{2})?
    )?
    $""",
    re.VERBOSE,
)


def _valid_instant(v) -> bool:
    if not _non_empty_string(v):
        return False
    m = _INSTANT_RE.match(v)
    if not m:
        return False
    month = m.group("month")
    day = m.group("day")
    if month is not None and not (1 <= int(month) <= 12):
        return False
    if day is not None:
        # V8 rejects calendar-invalid ISO dates ("2026-02-31" -> NaN), not
        # just day > 31 - a real-calendar check, or Python would accept
        # instants the Node reference refuses (fail-open).
        try:
            datetime(int(m.group("year")), int(month), int(day))
        except ValueError:
            return False
    hour = m.group("hour")
    if hour is not None:
        hour_i = int(hour)
        minute_i = int(m.group("minute"))
        if not (0 <= hour_i <= 24):
            return False
        if not (0 <= minute_i <= 59):
            return False
        second = m.group("second")
        second_i = int(second) if second is not None else 0
        if not (0 <= second_i <= 59):
            return False
        if hour_i == 24 and (minute_i != 0 or second_i != 0):
            return False
    return True


def _prop(obj, key):
    # JS optional chaining (`obj?.key`): returns undefined (here: None) when
    # obj is null/undefined/not an object with that key. Only dicts are ever
    # passed as nested envelope fields in this contract.
    if isinstance(obj, dict):
        return obj.get(key)
    return None


# Machine-readable verdict, never a throw: {valid, reason_codes}. Reason codes
# are part of the frozen v0 contract - conformance fixtures pin them. Codes
# are appended in EXACTLY this order to match the Node source.
def validate_context_integrity_event(event):
    reason_codes = []
    e = event if isinstance(event, dict) else {}

    if e.get("schema") != EVENT_SCHEMA:
        reason_codes.append("unsupported_schema")
    if not _non_empty_string(e.get("event_id")):
        reason_codes.append("missing_event_id")
    if not _non_empty_string(e.get("event_type")):
        reason_codes.append("missing_event_type")
    if not _valid_instant(e.get("occurred_at")):
        reason_codes.append("invalid_occurred_at")
    if not _valid_instant(e.get("recorded_at")):
        reason_codes.append("invalid_recorded_at")
    if not _non_empty_string(_prop(e.get("producer"), "module")):
        reason_codes.append("missing_producer")
    actor = e.get("actor")
    if not _non_empty_string(_prop(actor, "kind")) or not _non_empty_string(_prop(actor, "id")):
        reason_codes.append("missing_actor_identity")
    if not _non_empty_string(_prop(e.get("workspace"), "id")):
        reason_codes.append("missing_workspace")
    subject = e.get("subject")
    if not _non_empty_string(_prop(subject, "kind")) or not _non_empty_string(_prop(subject, "id")):
        reason_codes.append("missing_subject")
    scope = e.get("scope")
    if not _non_empty_string(_prop(scope, "project")) or not _non_empty_string(_prop(scope, "visibility")):
        reason_codes.append("missing_scope")

    evidence = e.get("evidence")
    if evidence is None:
        evidence = []
    if not isinstance(evidence, list) or any(
        not _non_empty_string(_prop(item, "ref")) or not _non_empty_string(_prop(item, "digest"))
        for item in evidence
    ):
        reason_codes.append("evidence_not_fingerprinted")

    return {"valid": len(reason_codes) == 0, "reason_codes": reason_codes}


# Broader visibility = higher rank. An event may only land in a sink that is
# as narrow as (or narrower than) its own scope - writing narrow data into a
# broader sink is the private-to-public leak and fails closed.
_VISIBILITY_RANK = {"private": 0, "local": 1, "public": 2}


def _json_round_trip(value):
    # Node: JSON.parse(JSON.stringify(event)) - a deep copy. This module only
    # ever stores JSON-compatible values (dicts/lists/strings/numbers/bools/
    # None), so a plain recursive copy is the exact Python analog.
    if isinstance(value, dict):
        return {k: _json_round_trip(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_round_trip(v) for v in value]
    return value


class EventLog:
    """Append-only, project-scoped event log. Acceptance order is the replay
    order; occurred_at never reorders history. Every append returns a
    machine-readable outcome and never throws on bad input.

    Python has no analog of JS's Object.freeze()/deep-freeze (mutating a
    frozen JS object throws TypeError); the Python translation of that
    invariant is: accepted() always hands back a *fresh deep copy*, so
    mutating what it returns can never leak back into the log's internal
    state, and the outer container is a tuple (no append/push surface).
    """

    def __init__(self, project, visibility, policy_version):
        self.project = project
        self.visibility = visibility
        self.policy_version = policy_version
        self._entries = []
        self._by_id = {}

    def append(self, event):
        verdict = validate_context_integrity_event(event)
        if not verdict["valid"]:
            return {"decision": "rejected", "reason_codes": verdict["reason_codes"]}

        if event["scope"]["project"] != self.project:
            return {"decision": "rejected", "reason_codes": ["cross_project_write"]}
        # JS semantics: VISIBILITY_RANK[<unknown string>] is undefined, and
        # `undefined < n` is false, so an unknown visibility (on either side)
        # never trips this rejection in the Node reference. dict indexing
        # would raise instead - and append must never throw on bad input.
        event_rank = _VISIBILITY_RANK.get(event["scope"]["visibility"])
        sink_rank = _VISIBILITY_RANK.get(self.visibility)
        if event_rank is not None and sink_rank is not None and event_rank < sink_rank:
            return {"decision": "rejected", "reason_codes": ["private_to_public_write"]}

        seen = self._by_id.get(event["event_id"])
        if seen is not None:
            identical = canonicalize(seen["event"]) == canonicalize(event)
            if identical:
                return {"decision": "duplicate", "reason_codes": []}
            return {"decision": "rejected", "reason_codes": ["event_id_reuse"]}

        entry = {
            "sequence": len(self._entries) + 1,
            "event": _json_round_trip(event),
        }
        self._entries.append(entry)
        self._by_id[event["event_id"]] = entry
        return {"decision": "accepted", "reason_codes": []}

    def accepted(self):
        return tuple(
            {"sequence": entry["sequence"], "event": _json_round_trip(entry["event"])}
            for entry in self._entries
        )


def create_event_log(*, project, visibility, policy_version):
    """@param project, visibility ("private"|"local"|"public"), policy_version"""
    return EventLog(project, visibility, policy_version)


PROJECTION_SCHEMA = "vivary.event-projection/v0"


def project_from_events(accepted_entries, *, policy_version):
    """Rebuild a projection from accepted log entries and a policy version -
    the whole state, every time. Reads only envelope fields the v0 contract
    owns; unknown namespaced extensions are ignored by construction, so the
    same accepted events always rebuild byte-identical state."""
    event_types = {}
    subjects = {}

    for entry in accepted_entries:
        sequence = entry["sequence"]
        event = entry["event"]
        event_types[event["event_type"]] = event_types.get(event["event_type"], 0) + 1
        key = f'{event["subject"]["kind"]}:{event["subject"]["id"]}'
        subject = subjects.setdefault(key, {"event_count": 0})
        subject["event_count"] += 1
        subject["last_sequence"] = sequence
        subject["last_event_id"] = event["event_id"]
        subject["last_event_type"] = event["event_type"]

    body = {
        "schema": PROJECTION_SCHEMA,
        "policy_version": policy_version,
        "event_count": len(accepted_entries),
        "event_types": event_types,
        "subjects": subjects,
    }
    return {**body, "fingerprint": fingerprint(body)}
