"""Bounded server bridge to create-vivary's exact thin workspace operations."""
import json
import os
from pathlib import Path
import sys

# A checkout owns development; the staged bridge uses its installed wheel.
ROOT = Path(__file__).resolve().parents[3]
source = ROOT / "packages" / "create-vivary"
if (source / "create_vivary.py").is_file():
    sys.path[:0] = [str(source), str(ROOT / "packages" / "core")]
else:
    ROOT = None
import create_vivary


def managed_request(payload):
    operation = payload["operation"]
    if operation == "catalog":
        return {"code": "catalog", "patterns": create_vivary.builtin_pattern_catalog()}
    target = Path(payload["target"])
    if operation == "observe":
        # Read-only, like context. The Workbench admitted this root before calling.
        return {"code": "observe", "observation": observe_project(target)}
    if operation == "context":
        # Read-only. The Workbench admitted this root before calling. An
        # invalid config comes back as data so the owner can see the reason.
        return {"code": "context", "context": create_vivary.workspace_context(
            target, repo_root=ROOT, candidates=payload.get("candidates", ()))}
    options = dict(preset=payload.get("preset", "coding"), adapters=(), active_context=None,
                   pattern_choices=payload.get("patternChoices", ()))
    if operation == "plan":
        return {"code": "preview", "plan": create_vivary.plan_thin_workspace(
            target, **options
        )}
    if operation != "apply":
        raise ValueError("unknown operation")
    result = create_vivary.apply_thin_workspace(
        target, payload.get("acceptedPlanSha256"),
        repo_root=ROOT, **options,
    )
    if result["code"] == "plan-changed":
        return {"code": "plan-changed"}
    return {"code": result["code"], "target": result["target"],
            "planSha256": result["plan_sha256"]}


def observe_project(target):
    """The project's Git version through the hardened checkout observer.

    Dirty entries outside the project folder are dropped and the rest are
    reported relative to it. No absolute path leaves the bridge. Anything the
    observer could not establish is reported as unknown, never as clean.
    """
    from vivary_core.workspace_observe import observe_checkouts

    report = observe_checkouts([str(target)], allowlist=[str(target)])
    if len(report["checkouts"]) != 1:
        return {"kind": "unknown"}
    facts = report["checkouts"][0]["facts"]
    repository = facts.get("is_git_repository", {})
    if repository.get("status") != "known":
        if repository.get("reason") == "not_a_git_repository_or_git_failed":
            return {"kind": "plain"}
        return {"kind": "unknown"}
    worktree = facts.get("worktree_root", {})
    if worktree.get("status") != "known":
        return {"kind": "unknown"}
    relative = os.path.relpath(os.path.realpath(target), os.path.realpath(worktree["value"]))
    if relative == os.pardir or relative.startswith(os.pardir + os.sep) or os.path.isabs(relative):
        return {"kind": "unknown"}
    prefix = "" if relative == os.curdir else relative.replace(os.sep, "/") + "/"
    head = facts.get("head_revision", {})
    ref = facts.get("head_ref", {})
    dirty = facts.get("dirty_entries", {})
    entries = None
    if dirty.get("status") == "known":
        entries = [{"path": entry["path"][len(prefix):] or ".", "state": entry["state"]}
                   for entry in dirty["value"] if entry["path"].startswith(prefix)]
    return {
        "kind": "git",
        "head": head["value"] if head.get("status") == "known" else None,
        "ref": ref["value"]["name"] if ref.get("status") == "known" and ref["value"].get("kind") == "branch" else None,
        "entries": entries,
    }


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read())
        if set(request) - {"operation", "target", "acceptedPlanSha256", "patternChoices", "preset", "candidates"}:
            raise ValueError("unexpected request field")
        print(json.dumps(managed_request(request), separators=(",", ":")))
    except (KeyError, TypeError, ValueError, create_vivary.ScaffoldError) as exc:
        print(json.dumps({"code": "refused", "message": str(exc)}, separators=(",", ":")))
        raise SystemExit(2)
