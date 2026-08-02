"""Pure dependency decisions for governed control.

Dependency evaluation owns graph-cycle detection so adapters cannot compose a
policy result around an inconsistent task graph.
"""

from __future__ import annotations
import unicodedata

from vivary_core.control_reason_codes import DEPENDENCY_DECISION, DEPENDENCY_REASON

__all__ = [
    "DEPENDENCY_DECISION",
    "DEPENDENCY_REASON",
    "evaluate_dependencies",
]


_MAX_TASKS = 10_000
_MAX_DEPENDENCY_EDGES = 100_000
_MAX_TASK_ID_UTF8_BYTES = 256
_MAX_STATUS_UTF8_BYTES = 64


def _is_bounded_text(value, max_utf8_bytes):
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or unicodedata.normalize("NFC", value) != value
    ):
        return False
    try:
        return len(value.encode("utf-8")) <= max_utf8_bytes
    except UnicodeEncodeError:
        return False


def _task_graph_reason(tasks):
    if type(tasks) is not list:
        return DEPENDENCY_REASON["UNKNOWN_TASK"]
    if len(tasks) > _MAX_TASKS:
        return DEPENDENCY_REASON["WORK_UNBOUNDED"]

    task_ids = set()
    dependency_edges = 0
    for task in tasks:
        if (
            type(task) is not dict
            or not _is_bounded_text(
                task.get("id"),
                _MAX_TASK_ID_UTF8_BYTES,
            )
            or not _is_bounded_text(
                task.get("status"),
                _MAX_STATUS_UTF8_BYTES,
            )
            or (
                task.get("depends_on") is not None
                and type(task["depends_on"]) is not list
            )
        ):
            return DEPENDENCY_REASON["UNKNOWN_TASK"]
        dependencies = task.get("depends_on") or []
        if len(dependencies) > _MAX_DEPENDENCY_EDGES - dependency_edges:
            return DEPENDENCY_REASON["WORK_UNBOUNDED"]
        if not all(
            _is_bounded_text(
                dependency_id,
                _MAX_TASK_ID_UTF8_BYTES,
            )
            for dependency_id in dependencies
        ):
            return DEPENDENCY_REASON["UNKNOWN_TASK"]
        dependency_edges += len(dependencies)
        if task["id"] in task_ids:
            return DEPENDENCY_REASON["UNKNOWN_TASK"]
        task_ids.add(task["id"])
    return None


def _has_valid_task_entries(tasks):
    return _task_graph_reason(tasks) is None


def _detect_dependency_cycle(tasks, by_id):
    """Return the first DFS-ordered cycle, or an empty list when acyclic."""
    white, gray, black = 0, 1, 2
    color = {task["id"]: white for task in tasks}

    for start_task in tasks:
        start_id = start_task["id"]
        if color[start_id] != white:
            continue

        path = []
        path_positions = {}
        frames = [{"id": start_id, "index": 0}]
        color[start_id] = gray
        path_positions[start_id] = 0
        path.append(start_id)

        while frames:
            frame = frames[-1]
            dependencies = by_id[frame["id"]].get("depends_on") or []
            if frame["index"] >= len(dependencies):
                completed_id = frame["id"]
                path.pop()
                path_positions.pop(completed_id)
                color[completed_id] = black
                frames.pop()
                continue

            dependency_id = dependencies[frame["index"]]
            frame["index"] += 1
            if dependency_id not in by_id:
                continue

            dependency_color = color[dependency_id]
            if dependency_color == gray:
                return path[path_positions[dependency_id] :] + [dependency_id]
            if dependency_color == white:
                color[dependency_id] = gray
                path_positions[dependency_id] = len(path)
                path.append(dependency_id)
                frames.append({"id": dependency_id, "index": 0})

    return []


def _dependency_result(decision, reason_codes, unmet=None, cycle=None):
    return {
        "decision": decision,
        "reason_codes": reason_codes,
        "unmet": [] if unmet is None else unmet,
        "cycle": [] if cycle is None else cycle,
    }


def evaluate_dependencies(tasks, task_id):
    """Return a deterministic dependency decision for one task.

    Result shape is always ``{decision, reason_codes, unmet, cycle}``.  A
    cycle anywhere in a valid caller graph is typed evidence of a blocked
    graph rather than an adapter-level policy decision.
    """
    graph_reason = _task_graph_reason(tasks)
    if graph_reason is not None:
        return _dependency_result(
            DEPENDENCY_DECISION["BLOCKED"],
            [graph_reason],
        )
    if not _is_bounded_text(task_id, _MAX_TASK_ID_UTF8_BYTES):
        return _dependency_result(
            DEPENDENCY_DECISION["BLOCKED"],
            [DEPENDENCY_REASON["UNKNOWN_TASK"]],
        )

    by_id = {task["id"]: task for task in tasks}
    task = by_id.get(task_id)
    if task is None:
        return _dependency_result(
            DEPENDENCY_DECISION["BLOCKED"],
            [DEPENDENCY_REASON["UNKNOWN_TASK"]],
        )

    cycle = _detect_dependency_cycle(tasks, by_id)
    if cycle:
        return _dependency_result(
            DEPENDENCY_DECISION["BLOCKED"],
            [DEPENDENCY_REASON["DEPENDENCY_CYCLE"]],
            cycle=cycle,
        )

    unmet = [
        dependency_id
        for dependency_id in task.get("depends_on") or []
        if dependency_id not in by_id or by_id[dependency_id].get("status") != "done"
    ]
    if unmet:
        return _dependency_result(
            DEPENDENCY_DECISION["BLOCKED"],
            [DEPENDENCY_REASON["DEPENDENCY_NOT_SATISFIED"]],
            unmet=unmet,
        )
    return _dependency_result(DEPENDENCY_DECISION["READY"], [])
