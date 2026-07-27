"""Task dependency evaluation for Exo (ticket #8).

Reference-guided Python port of src/control/dependencies.mjs (graduation
slice 5, decision 0008). Pure graph traversal over a caller-supplied task
list (`{id, status, depends_on}`); this module never stores the graph
itself. Fails closed: an unknown task, an unknown dependency, or a
dependency that has not reached "done" all block rather than silently
reporting ready.
"""

from __future__ import annotations

from vivary_core.control_reason_codes import DEPENDENCY_DECISION, DEPENDENCY_REASON

__all__ = [
    "DEPENDENCY_DECISION",
    "DEPENDENCY_REASON",
    "evaluate_dependencies",
    "detect_dependency_cycle",
]


def _has_valid_task_entries(tasks):
    return (
        isinstance(tasks, list)
        and all(
            isinstance(task, dict)
            and isinstance(task.get("id"), str)
            and len(task["id"]) > 0
            and (
                task.get("depends_on") is None
                or (
                    isinstance(task["depends_on"], list)
                    and all(isinstance(dep_id, str) and len(dep_id) > 0 for dep_id in task["depends_on"])
                )
            )
            for task in tasks
        )
        and len({task["id"] for task in tasks}) == len(tasks)
    )


def evaluate_dependencies(*, tasks, task_id):
    """@param tasks  [{id, status, depends_on?}]
    @param task_id
    @returns {decision, reason_codes, unmet}
    """
    if not _has_valid_task_entries(tasks):
        return {
            "decision": DEPENDENCY_DECISION["BLOCKED"],
            "reason_codes": [DEPENDENCY_REASON["UNKNOWN_TASK"]],
            "unmet": [],
        }
    by_id = {t["id"]: t for t in tasks}
    task = by_id.get(task_id)
    if task is None:
        return {"decision": DEPENDENCY_DECISION["BLOCKED"], "reason_codes": [DEPENDENCY_REASON["UNKNOWN_TASK"]], "unmet": []}

    depends_on = task.get("depends_on") or []

    def _unmet(dep_id):
        dep = by_id.get(dep_id)
        return dep is None or dep.get("status") != "done"

    unmet = [dep_id for dep_id in depends_on if _unmet(dep_id)]

    if len(unmet) > 0:
        return {
            "decision": DEPENDENCY_DECISION["BLOCKED"],
            "reason_codes": [DEPENDENCY_REASON["DEPENDENCY_NOT_SATISFIED"]],
            "unmet": unmet,
        }
    return {"decision": DEPENDENCY_DECISION["READY"], "reason_codes": [], "unmet": []}


def detect_dependency_cycle(*, tasks):
    """Detect a dependency cycle across the whole task list, so a cycle can
    be refused before it silently deadlocks every task inside it. Pure DFS,
    no mutation of the input.

    Iterative (explicit-stack), not recursive: mirrors the Node reference's
    #68/#63 fix, where a deep-but-acyclic chain used to spend one JS
    call-stack frame per dependency hop and overflow at roughly
    7,000-10,000 hops instead of returning the documented
    {has_cycle, cycle} shape. `frames` carries one entry per node on the
    current root-to-node path, each resuming its own depends_on iteration
    exactly where it left off (`frame["i"]`); `path` mirrors the Node
    reference's `stack` (used only for cycle extraction). Same white/gray/
    black coloring, same depends_on traversal order, same cycle array shape
    (`path[cycle_start:] + [dep_id]`) as the Node reference - preserved
    exactly per the ticket's #68 bounded-algorithm pin.

    @param tasks  [{id, depends_on?}]
    @returns {has_cycle, cycle}
    """
    if not _has_valid_task_entries(tasks):
        raise ValueError("task dependency graph contains an invalid task entry")
    by_id = {t["id"]: t for t in tasks}
    white, gray, black = 0, 1, 2
    color = {t["id"]: white for t in tasks}

    for start_task in tasks:
        if color[start_task["id"]] != white:
            continue

        path = []
        frames = [{"id": start_task["id"], "i": 0}]
        color[start_task["id"]] = gray
        path.append(start_task["id"])

        while len(frames) > 0:
            frame = frames[-1]
            deps = (by_id.get(frame["id"]) or {}).get("depends_on") or []

            if frame["i"] >= len(deps):
                # Equivalent to the recursive version's post-loop stack.pop()
                # + color BLACK + return null: this node and every
                # descendant is fully explored with no cycle found through
                # it.
                path.pop()
                color[frame["id"]] = black
                frames.pop()
                continue

            dep_id = deps[frame["i"]]
            frame["i"] += 1
            if dep_id not in by_id:
                continue

            dep_color = color.get(dep_id)
            if dep_color == gray:
                cycle_start = path.index(dep_id)
                return {"has_cycle": True, "cycle": path[cycle_start:] + [dep_id]}
            if dep_color == white:
                # Equivalent to the recursive version's immediate
                # `visit(depId)` call: push a new frame so the next loop
                # iteration dives into it depth-first, before resuming this
                # frame's remaining deps.
                color[dep_id] = gray
                path.append(dep_id)
                frames.append({"id": dep_id, "i": 0})

    return {"has_cycle": False, "cycle": []}
