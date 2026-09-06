"""Strict runtime-neutral records for the headless-loop proof."""

from __future__ import annotations

import re
import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


ROLE_REQUEST_SCHEMA = "vivary.hoh-role-request/v1"
ROLE_RESULT_SCHEMA = "vivary.hoh-role-result/v1"
EVIDENCE_SCHEMA = "vivary.hoh-evidence/v1"
TRANSITION_SCHEMA = "vivary.hoh-transition/v1"
RECEIPT_SCHEMA = "vivary.hoh-receipt/v1"
USAGE_SCHEMA = "vivary.hoh-usage/v1"
LEDGER_SCHEMA = "vivary.hoh-ledger/v1"
DEADLINE_SCHEMA = "vivary.hoh-deadline/v1"
ROLES = frozenset({"planner", "developer", "qa"})
_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
_SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


class ProtocolError(ValueError):
    """A record does not match the declared protocol."""


class BudgetError(ProtocolError):
    """A call cannot reserve or settle its token charge safely."""


class DeadlineError(ProtocolError):
    """An iteration deadline cannot admit or accept more work."""


class ClockError(DeadlineError):
    """The persisted wall clock moved backward or became uncertain."""


def _require_exact_keys(record: dict[str, Any], expected: set[str], label: str) -> None:
    missing = sorted(expected - record.keys())
    unknown = sorted(record.keys() - expected)
    if missing or unknown:
        raise ProtocolError(f"{label} keys differ: missing={missing}, unknown={unknown}")


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require_hash(value: object, field: str) -> None:
    if not isinstance(value, str) or not _HASH.fullmatch(value):
        raise ProtocolError(f"{field} must be a sha256 digest")


def validate_role_request(record: object) -> dict[str, Any]:
    """Validate and copy one runtime-neutral role request."""
    if not isinstance(record, dict):
        raise ProtocolError("role request must be an object")
    expected = {
        "schema",
        "run_id",
        "iteration",
        "role",
        "prompt_bytes",
        "prompt_sha256",
        "baseline_sha256",
        "candidate_sha256",
        "receipt_chain_head",
        "deadline_unix_ns",
        "read_roots",
        "write_root",
    }
    _require_exact_keys(record, expected, "role request")
    if record["schema"] != ROLE_REQUEST_SCHEMA:
        raise ProtocolError("unsupported role request schema")
    if not isinstance(record["run_id"], str) or not _SLUG.fullmatch(record["run_id"]):
        raise ProtocolError("run_id must be a slug")
    if not _is_int(record["iteration"]) or record["iteration"] < 1:
        raise ProtocolError("iteration must be a positive integer")
    if record["role"] not in ROLES:
        raise ProtocolError("role must be planner, developer, or qa")
    if not _is_int(record["prompt_bytes"]) or record["prompt_bytes"] < 1:
        raise ProtocolError("prompt_bytes must be a positive integer")
    for field in ("prompt_sha256", "baseline_sha256", "candidate_sha256"):
        _require_hash(record[field], field)
    head = record["receipt_chain_head"]
    if head is not None:
        _require_hash(head, "receipt_chain_head")
    if not _is_int(record["deadline_unix_ns"]) or record["deadline_unix_ns"] < 1:
        raise ProtocolError("deadline_unix_ns must be a positive integer")
    roots = record["read_roots"]
    if not isinstance(roots, list) or not roots or any(
        not isinstance(root, str) or not _SLUG.fullmatch(root) for root in roots
    ) or len(set(roots)) != len(roots):
        raise ProtocolError("read_roots must be a non-empty list of slugs")
    write_root = record["write_root"]
    if write_root is not None and (
        not isinstance(write_root, str) or not _SLUG.fullmatch(write_root)
    ):
        raise ProtocolError("write_root must be null or a slug")
    if write_root is not None and write_root not in roots:
        raise ProtocolError("write_root must also be a declared read root")
    return dict(record)


def validate_role_result(
    record: object,
    *,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate one role result and, when supplied, bind it to its request."""
    if not isinstance(record, dict):
        raise ProtocolError("role result must be an object")
    expected = {
        "schema",
        "run_id",
        "iteration",
        "role",
        "request_sha256",
        "output_kind",
        "output_text",
        "output_sha256",
        "usage",
        "complete",
    }
    _require_exact_keys(record, expected, "role result")
    if record["schema"] != ROLE_RESULT_SCHEMA:
        raise ProtocolError("unsupported role result schema")
    if not isinstance(record["run_id"], str) or not _SLUG.fullmatch(record["run_id"]):
        raise ProtocolError("role result run_id must be a slug")
    if not _is_int(record["iteration"]) or record["iteration"] < 1:
        raise ProtocolError("role result iteration must be positive")
    if record["role"] not in ROLES:
        raise ProtocolError("role result role differs")
    expected_kind = {
        "planner": "development_document",
        "developer": "developer_report",
        "qa": "evidence_report",
    }[record["role"]]
    if record["output_kind"] != expected_kind:
        raise ProtocolError("role result output_kind differs from role")
    _require_hash(record["request_sha256"], "request_sha256")
    _require_hash(record["output_sha256"], "output_sha256")
    if not isinstance(record["output_text"], str) or not record["output_text"].strip():
        raise ProtocolError("role result output_text must be non-empty")
    if not isinstance(record["complete"], bool):
        raise ProtocolError("role result complete must be boolean")
    usage = validate_usage_record(record["usage"])
    if record["complete"] != usage["complete"]:
        raise ProtocolError("role and usage completion differ")
    if request is not None:
        bound = validate_role_request(request)
        for field in ("run_id", "iteration", "role"):
            if record[field] != bound[field]:
                raise ProtocolError(f"role result has stale or cross-run {field}")
    return {**record, "usage": usage}


def validate_evidence_record(
    record: object,
    *,
    run_id: str | None = None,
    iteration: int | None = None,
    candidate_sha256: str | None = None,
) -> dict[str, Any]:
    """Validate deterministic test evidence and optional freshness bindings."""
    if not isinstance(record, dict):
        raise ProtocolError("evidence must be an object")
    expected = {
        "schema",
        "run_id",
        "iteration",
        "candidate_sha256",
        "command",
        "returncode",
        "output_sha256",
        "observations",
        "complete",
    }
    _require_exact_keys(record, expected, "evidence")
    if record["schema"] != EVIDENCE_SCHEMA:
        raise ProtocolError("unsupported evidence schema")
    if not isinstance(record["run_id"], str) or not _SLUG.fullmatch(record["run_id"]):
        raise ProtocolError("evidence run_id must be a slug")
    if not _is_int(record["iteration"]) or record["iteration"] < 1:
        raise ProtocolError("evidence iteration must be positive")
    _require_hash(record["candidate_sha256"], "candidate_sha256")
    _require_hash(record["output_sha256"], "output_sha256")
    if (
        not isinstance(record["command"], list)
        or not record["command"]
        or any(not isinstance(item, str) or not item for item in record["command"])
    ):
        raise ProtocolError("evidence command must be a non-empty string list")
    if not _is_int(record["returncode"]):
        raise ProtocolError("evidence returncode must be an integer")
    if (
        not isinstance(record["observations"], list)
        or any(not isinstance(item, str) or not item for item in record["observations"])
        or len(set(record["observations"])) != len(record["observations"])
    ):
        raise ProtocolError("evidence observations must be unique strings")
    if not isinstance(record["complete"], bool):
        raise ProtocolError("evidence complete must be boolean")
    freshness = {
        "run_id": run_id,
        "iteration": iteration,
        "candidate_sha256": candidate_sha256,
    }
    for field, expected_value in freshness.items():
        if expected_value is not None and record[field] != expected_value:
            raise ProtocolError(f"evidence has stale or cross-run {field}")
    return dict(record)


def validate_transition_record(record: object) -> dict[str, Any]:
    """Validate one transition in the fixed planner/developer/QA order."""
    if not isinstance(record, dict):
        raise ProtocolError("transition must be an object")
    expected = {
        "schema",
        "run_id",
        "iteration",
        "from_stage",
        "to_stage",
        "candidate_before_sha256",
        "candidate_after_sha256",
        "prior_receipt_sha256",
    }
    _require_exact_keys(record, expected, "transition")
    if record["schema"] != TRANSITION_SCHEMA:
        raise ProtocolError("unsupported transition schema")
    if not isinstance(record["run_id"], str) or not _SLUG.fullmatch(record["run_id"]):
        raise ProtocolError("transition run_id must be a slug")
    if not _is_int(record["iteration"]) or record["iteration"] < 1:
        raise ProtocolError("transition iteration must be positive")
    allowed = {
        ("iteration_start", "planner"),
        ("planner", "developer"),
        ("developer", "qa"),
        ("qa", "iteration_complete"),
    }
    if (record["from_stage"], record["to_stage"]) not in allowed:
        raise ProtocolError("transition order differs")
    for field in ("candidate_before_sha256", "candidate_after_sha256"):
        _require_hash(record[field], field)
    head = record["prior_receipt_sha256"]
    if head is not None:
        _require_hash(head, "prior_receipt_sha256")
    return dict(record)


def validate_receipt_record(record: object) -> dict[str, Any]:
    """Validate the immutable envelope written for a sequencer event."""
    if not isinstance(record, dict):
        raise ProtocolError("receipt must be an object")
    expected = {"schema", "sequence", "prior_receipt_sha256", "payload"}
    _require_exact_keys(record, expected, "receipt")
    if record["schema"] != RECEIPT_SCHEMA:
        raise ProtocolError("unsupported receipt schema")
    if not _is_int(record["sequence"]) or record["sequence"] < 1:
        raise ProtocolError("receipt sequence must be positive")
    head = record["prior_receipt_sha256"]
    if head is not None:
        _require_hash(head, "prior_receipt_sha256")
    if not isinstance(record["payload"], dict):
        raise ProtocolError("receipt payload must be an object")
    required_payload = {
        "run_id",
        "iteration",
        "stage",
        "status",
        "bindings",
        "details",
    }
    _require_exact_keys(record["payload"], required_payload, "receipt payload")
    payload = record["payload"]
    if not isinstance(payload["run_id"], str) or not _SLUG.fullmatch(payload["run_id"]):
        raise ProtocolError("receipt run_id must be a slug")
    if not _is_int(payload["iteration"]) or payload["iteration"] < 1:
        raise ProtocolError("receipt iteration must be positive")
    if payload["stage"] not in {"iteration", "planner", "developer", "test", "qa", "fault"}:
        raise ProtocolError("receipt stage differs")
    if payload["status"] not in {"started", "complete", "incomplete", "failed", "regressed"}:
        raise ProtocolError("receipt status differs")
    if not isinstance(payload["bindings"], dict) or not isinstance(payload["details"], dict):
        raise ProtocolError("receipt bindings and details must be objects")
    bindings = payload["bindings"]
    required_bindings = {
        "baseline_sha256",
        "baseline_commit",
        "baseline_tree",
        "specification_sha256",
        "oracle_sha256",
        "prompt_sha256",
        "iteration",
        "candidate_sha256",
        "prior_receipt_sha256",
    }
    optional_bindings = {
        "assembled_prompt_sha256",
        "development_document_sha256",
        "developer_report_sha256",
        "qa_evidence_report_sha256",
        "developer_checkpoint",
        "frozen_candidate_sha256",
        "frozen_candidate_before_sha256",
        "frozen_candidate_after_sha256",
    }
    missing = required_bindings - bindings.keys()
    unknown = bindings.keys() - required_bindings - optional_bindings
    if missing or unknown:
        raise ProtocolError(
            f"receipt binding keys differ: missing={sorted(missing)}, unknown={sorted(unknown)}"
        )
    for field in (
        "baseline_sha256",
        "specification_sha256",
        "oracle_sha256",
        "candidate_sha256",
    ):
        _require_hash(bindings[field], field)
    for field in ("baseline_commit", "baseline_tree"):
        if not isinstance(bindings[field], str) or not re.fullmatch(
            r"[0-9a-f]{40}|[0-9a-f]{64}", bindings[field]
        ):
            raise ProtocolError(f"{field} must be a Git object id")
    for field in optional_bindings - {"developer_checkpoint"}:
        if field in bindings:
            _require_hash(bindings[field], field)
    if bindings["prior_receipt_sha256"] is not None:
        _require_hash(bindings["prior_receipt_sha256"], "prior_receipt_sha256")
    prompts = bindings["prompt_sha256"]
    if not isinstance(prompts, dict) or set(prompts) != ROLES:
        raise ProtocolError("receipt prompt hashes must name planner, developer, and qa")
    for role, digest in prompts.items():
        _require_hash(digest, f"prompt_sha256.{role}")
    if bindings["iteration"] != payload["iteration"]:
        raise ProtocolError("receipt binding iteration differs from payload")
    checkpoint = bindings.get("developer_checkpoint")
    if checkpoint is not None and (
        not isinstance(checkpoint, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", checkpoint)
    ):
        raise ProtocolError("developer_checkpoint must be a Git object id")
    if bindings["prior_receipt_sha256"] != record["prior_receipt_sha256"]:
        raise ProtocolError("receipt binding prior hash differs from envelope")
    return {
        **record,
        "payload": {**payload, "bindings": dict(payload["bindings"]), "details": dict(payload["details"])},
    }


def _optional_token_count(value: object, field: str) -> None:
    if value is not None and (not _is_int(value) or value < 0):
        raise ProtocolError(f"{field} must be null or a non-negative integer")


def validate_usage_record(record: object) -> dict[str, Any]:
    """Validate normalized usage without adding cache fields a second time."""
    if not isinstance(record, dict):
        raise ProtocolError("usage record must be an object")
    value = record
    expected = {
        "schema",
        "vendor_usage_raw",
        "aggregate_input_tokens",
        "aggregate_output_tokens",
        "cache_read_input_tokens",
        "cache_write_input_tokens",
        "budget_counted_tokens",
        "claude_agentic_turns",
        "codex_top_level_turns",
        "complete",
    }
    _require_exact_keys(value, expected, "usage record")
    if value["schema"] != USAGE_SCHEMA:
        raise ProtocolError("unsupported usage schema")
    if not isinstance(value["vendor_usage_raw"], dict):
        raise ProtocolError("vendor_usage_raw must be an object")
    for field in (
        "aggregate_input_tokens",
        "aggregate_output_tokens",
        "cache_read_input_tokens",
        "cache_write_input_tokens",
        "budget_counted_tokens",
        "claude_agentic_turns",
        "codex_top_level_turns",
    ):
        _optional_token_count(value[field], field)
    if not isinstance(value["complete"], bool):
        raise ProtocolError("complete must be true or false")
    aggregate_input = value["aggregate_input_tokens"]
    aggregate_output = value["aggregate_output_tokens"]
    counted = value["budget_counted_tokens"]
    if value["complete"] and None in (aggregate_input, aggregate_output, counted):
        raise ProtocolError("complete usage requires input, output, and budget counts")
    if aggregate_input is not None and aggregate_output is not None:
        if counted != aggregate_input + aggregate_output:
            raise ProtocolError("budget_counted_tokens must equal aggregate input plus output")
    elif counted is not None:
        raise ProtocolError("a budget count requires both aggregate counts")
    return dict(value)


@contextmanager
def _exclusive_file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as lock:
        if os.name == "nt":
            import msvcrt

            if lock.tell() == 0:
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _atomic_json_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class UsageLedger:
    """An atomic packet ledger that retains uncertain reservations."""

    def __init__(self, path: str | os.PathLike[str], packet_budget: int):
        if not _is_int(packet_budget) or packet_budget < 1:
            raise BudgetError("packet_budget must be a positive integer")
        self.path = Path(path)
        self.lock_path = self.path.with_name(self.path.name + ".lock")
        self.packet_budget = packet_budget

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {
                "schema": LEDGER_SCHEMA,
                "packet_budget": self.packet_budget,
                "reservations": {},
            }
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise BudgetError(f"usage ledger is unreadable: {error}") from error
        if (
            not isinstance(state, dict)
            or set(state) != {"schema", "packet_budget", "reservations"}
            or state.get("schema") != LEDGER_SCHEMA
            or state.get("packet_budget") != self.packet_budget
            or not isinstance(state.get("reservations"), dict)
        ):
            raise BudgetError("usage ledger identity or shape differs")
        for call_id, reservation in state["reservations"].items():
            self._validate_reservation(call_id, reservation)
        return state

    @staticmethod
    def _validate_reservation(call_id: object, reservation: object) -> None:
        if not isinstance(call_id, str) or not _SLUG.fullmatch(call_id):
            raise BudgetError("persisted call_id must be a slug")
        if not isinstance(reservation, dict) or set(reservation) != {
            "maximum",
            "charged",
            "status",
            "usage",
        }:
            raise BudgetError(f"persisted reservation shape differs: {call_id}")
        maximum = reservation["maximum"]
        charged = reservation["charged"]
        status = reservation["status"]
        if not _is_int(maximum) or maximum < 1:
            raise BudgetError(f"persisted maximum is invalid: {call_id}")
        if not _is_int(charged) or charged < 0:
            raise BudgetError(f"persisted charge is invalid: {call_id}")
        if status not in {"reserved", "incomplete", "settled", "overrun"}:
            raise BudgetError(f"persisted reservation status is invalid: {call_id}")
        if status == "reserved":
            if reservation["usage"] is not None or charged != maximum:
                raise BudgetError(f"reserved call does not retain its maximum: {call_id}")
            return
        try:
            usage = validate_usage_record(reservation["usage"])
        except ProtocolError as error:
            raise BudgetError(f"persisted usage is invalid: {call_id}: {error}") from error
        if status == "incomplete":
            if usage["complete"] or charged != maximum:
                raise BudgetError(f"incomplete call released its reservation: {call_id}")
            return
        counted = usage["budget_counted_tokens"]
        if not usage["complete"] or charged != counted:
            raise BudgetError(f"settled call differs from its usage: {call_id}")
        if status == "settled" and charged > maximum:
            raise BudgetError(f"settled call exceeded its maximum: {call_id}")
        if status == "overrun" and charged <= maximum:
            raise BudgetError(f"overrun call did not exceed its maximum: {call_id}")

    def _snapshot(self, state: dict[str, Any]) -> dict[str, Any]:
        charged = sum(item["charged"] for item in state["reservations"].values())
        return {**state, "charged": charged, "remaining": self.packet_budget - charged}

    def snapshot(self) -> dict[str, Any]:
        with _exclusive_file_lock(self.lock_path):
            return self._snapshot(self._read())

    def reserve(self, call_id: str, maximum: int | None) -> dict[str, Any]:
        if not isinstance(call_id, str) or not _SLUG.fullmatch(call_id):
            raise BudgetError("call_id must be a slug")
        if maximum is None or not _is_int(maximum) or maximum < 1:
            raise BudgetError("a verified positive maximum is required")
        with _exclusive_file_lock(self.lock_path):
            state = self._read()
            if call_id in state["reservations"]:
                raise BudgetError(f"call already reserved: {call_id}")
            snapshot = self._snapshot(state)
            if maximum > snapshot["remaining"]:
                raise BudgetError("maximum exceeds the remaining packet balance")
            state["reservations"][call_id] = {
                "maximum": maximum,
                "charged": maximum,
                "status": "reserved",
                "usage": None,
            }
            _atomic_json_write(self.path, state)
            return self._snapshot(state)

    def settle(self, call_id: str, usage: object) -> dict[str, Any]:
        normalized = validate_usage_record(usage)
        with _exclusive_file_lock(self.lock_path):
            state = self._read()
            reservation = state["reservations"].get(call_id)
            if not isinstance(reservation, dict) or reservation.get("status") != "reserved":
                raise BudgetError(f"call has no unsettled reservation: {call_id}")
            if normalized["complete"]:
                charged = normalized["budget_counted_tokens"]
                status = "overrun" if charged > reservation["maximum"] else "settled"
            else:
                charged = reservation["maximum"]
                status = "incomplete"
            reservation.update({"charged": charged, "status": status, "usage": normalized})
            _atomic_json_write(self.path, state)
            if status == "overrun":
                raise BudgetError("observed usage exceeded the reserved maximum")
            return self._snapshot(state)


class IterationDeadline:
    """A persisted deadline bound to wall time, monotonic time, and one boot."""

    STOP_GRACE_SECONDS = 5.0

    def __init__(self, path: Path, run_id: str, iteration: int):
        self.path = path
        self.lock_path = path.with_name(path.name + ".lock")
        self.run_id = run_id
        self.iteration = iteration

    @classmethod
    def create(
        cls,
        path: str | os.PathLike[str],
        *,
        run_id: str,
        iteration: int,
        duration_seconds: float = 3600,
        now_unix_ns: int | None = None,
        now_monotonic_ns: int | None = None,
        boot_id: str | None = None,
    ) -> "IterationDeadline":
        deadline = cls(Path(path), run_id, iteration)
        deadline._validate_identity()
        if isinstance(duration_seconds, bool) or not isinstance(duration_seconds, (int, float)):
            raise DeadlineError("duration_seconds must be positive")
        if duration_seconds <= 0 or duration_seconds > 3600:
            raise DeadlineError("duration_seconds must be in the range (0, 3600]")
        now = deadline._wall_clock(now_unix_ns)
        monotonic_now = deadline._monotonic_clock(now_monotonic_ns)
        observed_boot = deadline._boot_identity(boot_id)
        with _exclusive_file_lock(deadline.lock_path):
            if deadline.path.exists() or deadline.path.is_symlink():
                raise DeadlineError("refuse existing iteration deadline")
            state = {
                "schema": DEADLINE_SCHEMA,
                "run_id": run_id,
                "iteration": iteration,
                "duration_seconds": duration_seconds,
                "started_unix_ns": now,
                "expires_unix_ns": now + int(duration_seconds * 1_000_000_000),
                "last_observed_unix_ns": now,
                "started_monotonic_ns": monotonic_now,
                "last_observed_monotonic_ns": monotonic_now,
                "boot_id": observed_boot,
                "stop_grace_seconds": cls.STOP_GRACE_SECONDS,
            }
            _atomic_json_write(deadline.path, state)
        return deadline

    @classmethod
    def resume(
        cls,
        path: str | os.PathLike[str],
        *,
        run_id: str,
        iteration: int,
        boot_id: str | None = None,
    ) -> "IterationDeadline":
        deadline = cls(Path(path), run_id, iteration)
        deadline._validate_identity()
        with _exclusive_file_lock(deadline.lock_path):
            state = deadline._read()
            observed_boot = deadline._boot_identity(boot_id)
            if state["boot_id"] != observed_boot:
                raise ClockError(
                    "iteration deadline crosses a system boot: "
                    f"persisted={state['boot_id']} observed={observed_boot}"
                )
        return deadline

    def _validate_identity(self) -> None:
        if not isinstance(self.run_id, str) or not _SLUG.fullmatch(self.run_id):
            raise DeadlineError("deadline run_id must be a slug")
        if not _is_int(self.iteration) or self.iteration < 1:
            raise DeadlineError("deadline iteration must be a positive integer")

    @staticmethod
    def _wall_clock(now_unix_ns: int | None) -> int:
        try:
            now = time.time_ns() if now_unix_ns is None else now_unix_ns
        except Exception as error:
            raise ClockError(f"wall clock unavailable: {error}") from error
        if not _is_int(now) or now < 1:
            raise ClockError("wall clock observation must be a positive integer")
        return now

    @staticmethod
    def _monotonic_clock(now_monotonic_ns: int | None) -> int:
        try:
            now = time.monotonic_ns() if now_monotonic_ns is None else now_monotonic_ns
        except Exception as error:
            raise ClockError(f"monotonic clock unavailable: {error}") from error
        if not _is_int(now) or now < 1:
            raise ClockError("monotonic clock observation must be a positive integer")
        return now

    @staticmethod
    def _boot_identity(boot_id: str | None) -> str:
        if boot_id is None:
            path = Path("/proc/sys/kernel/random/boot_id")
            try:
                boot_id = path.read_text(encoding="ascii").strip()
            except OSError as error:
                raise ClockError(f"Linux boot identity unavailable: {error}") from error
        if not isinstance(boot_id, str) or not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", boot_id
        ):
            raise ClockError("boot identity is invalid")
        return boot_id

    def _read(self) -> dict[str, Any]:
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise DeadlineError(f"iteration deadline is unreadable: {error}") from error
        expected = {
            "schema",
            "run_id",
            "iteration",
            "duration_seconds",
            "started_unix_ns",
            "expires_unix_ns",
            "last_observed_unix_ns",
            "started_monotonic_ns",
            "last_observed_monotonic_ns",
            "boot_id",
            "stop_grace_seconds",
        }
        if not isinstance(state, dict) or set(state) != expected:
            raise DeadlineError("iteration deadline shape differs")
        if (
            state["schema"] != DEADLINE_SCHEMA
            or state["run_id"] != self.run_id
            or state["iteration"] != self.iteration
            or state["stop_grace_seconds"] != self.STOP_GRACE_SECONDS
        ):
            raise DeadlineError("iteration deadline identity differs")
        duration = state["duration_seconds"]
        timestamps = [
            state["started_unix_ns"],
            state["expires_unix_ns"],
            state["last_observed_unix_ns"],
            state["started_monotonic_ns"],
            state["last_observed_monotonic_ns"],
        ]
        if (
            isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or duration <= 0
            or duration > 3600
            or any(not _is_int(value) or value < 1 for value in timestamps)
            or state["expires_unix_ns"]
            != state["started_unix_ns"] + int(duration * 1_000_000_000)
            or state["last_observed_unix_ns"] < state["started_unix_ns"]
            or state["last_observed_monotonic_ns"] < state["started_monotonic_ns"]
            or not isinstance(state["boot_id"], str)
            or not re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                state["boot_id"],
            )
        ):
            raise DeadlineError("iteration deadline state is invalid")
        return state

    @property
    def expires_unix_ns(self) -> int:
        with _exclusive_file_lock(self.lock_path):
            return self._read()["expires_unix_ns"]

    @property
    def stop_grace_seconds(self) -> float:
        return self.STOP_GRACE_SECONDS

    def snapshot(self) -> dict[str, Any]:
        with _exclusive_file_lock(self.lock_path):
            return dict(self._read())

    def remaining(
        self,
        *,
        now_unix_ns: int | None = None,
        now_monotonic_ns: int | None = None,
        boot_id: str | None = None,
    ) -> float:
        now = self._wall_clock(now_unix_ns)
        monotonic_now = self._monotonic_clock(now_monotonic_ns)
        observed_boot = self._boot_identity(boot_id)
        with _exclusive_file_lock(self.lock_path):
            state = self._read()
            if observed_boot != state["boot_id"]:
                raise ClockError(
                    "iteration deadline crosses a system boot: "
                    f"persisted={state['boot_id']} observed={observed_boot}"
                )
            if now < state["last_observed_unix_ns"]:
                raise ClockError(
                    "wall clock moved backward: "
                    f"observed={now} persisted={state['last_observed_unix_ns']}"
                )
            if monotonic_now < state["last_observed_monotonic_ns"]:
                raise ClockError(
                    "monotonic clock moved backward: "
                    f"observed={monotonic_now} persisted={state['last_observed_monotonic_ns']}"
                )
            wall_delta = now - state["last_observed_unix_ns"]
            monotonic_delta = monotonic_now - state["last_observed_monotonic_ns"]
            if wall_delta + 1_000_000_000 < monotonic_delta:
                raise ClockError(
                    "wall clock elapsed less time than the monotonic clock: "
                    f"wall_delta_ns={wall_delta} monotonic_delta_ns={monotonic_delta} "
                    "tolerance_ns=1000000000"
                )
            state["last_observed_unix_ns"] = now
            state["last_observed_monotonic_ns"] = monotonic_now
            _atomic_json_write(self.path, state)
            wall_remaining = state["expires_unix_ns"] - now
            monotonic_remaining = (
                int(state["duration_seconds"] * 1_000_000_000)
                - (monotonic_now - state["started_monotonic_ns"])
            )
            remaining = min(wall_remaining, monotonic_remaining) / 1_000_000_000
            if remaining <= 0:
                raise DeadlineError("iteration deadline expired")
            return remaining
