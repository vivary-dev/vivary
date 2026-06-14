#!/usr/bin/env python3
"""exo - the coordination layer.

The outermost, thinnest stratum: engaged only when one agent becomes many. exo does
not *run* agents (that's the harness/loops) — it reasons about coordination over the
shared tropo graph and hands workers their role contracts:

  - `exo conflicts`  who would collide — active work items that touch the same node
  - `exo board`      what's in flight — work items grouped by status
  - `exo roles`      the bounded worker contracts (strato's role grammar)

Read-only and deterministic: it reads tropo's graph in-process (no fork, no second
state store, no new schema) and uses the existing `status` field. Most workspaces
never need exo; single-agent workspaces stop at tropo + strato.

Usage:
  exo [conflicts] [--root DIR] [--json]
  exo board [--root DIR] [--json]
  exo roles [--json]
"""
import argparse
import importlib.util
import json
import os
import sys

__version__ = "0.1.0"

# Work items live under changes/ (folder-as-type); a node's coordination role is its
# top-level folder, independent of the resolved type name.
ROLE_FOLDERS = {"modules": "module", "changes": "change", "decisions": "decision",
                "verification": "verification", "gates": "gate"}

# strato's role grammar (STRATO.md) — the bounded contracts workers are spawned with.
ROLES = [
    ("Orchestrator", "intent, scope, gates, synthesis"),
    ("Scout", "paths, confidence, gaps"),
    ("Researcher", "fact / inference / recommendation, with credits"),
    ("Builder", "one slice + changed paths + checks"),
    ("Verifier", "pass / fail / skipped / risk — no silent edits"),
    ("Reviewer", "findings first"),
    ("Archivist", "notes, handoffs; PRIV kept separate"),
]


class ExoError(Exception):
    pass


def _load_tropo():
    here = os.path.dirname(os.path.abspath(__file__))
    tropo_dir = os.path.join(os.path.dirname(here), "tropo")
    tropo_path = os.path.join(tropo_dir, "tropo.py")
    if not os.path.isfile(tropo_path):
        raise ExoError(f"tropo engine not found at {tropo_path}")
    spec = importlib.util.spec_from_file_location("exo_tropo", tropo_path)
    if spec is None or spec.loader is None:
        raise ExoError(f"could not load tropo engine: {tropo_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, tropo_dir


def workspace_state(root):
    """Resolve the graph and enrich nodes with `status`/`assignee` from frontmatter.
    Returns (tropo, info, edges) where info maps id -> {id,type,path,status,assignee}."""
    tropo, tropo_dir = _load_tropo()
    start = root or os.getcwd()
    found = tropo.find_root(start)
    if found is None:
        raise ExoError(f"no tropo.toml found walking up from {os.path.abspath(start)}")
    resolver = tropo.ConfigResolver(found, tropo_dir)
    docs = tropo.analyze(resolver.root, [], resolver)
    _nodes, edges = tropo.build_graph(docs)
    info = {}
    for d in docs:
        nid = d.derived.get("id")
        if nid is None:
            continue
        fields = d.fields or {}
        info[nid] = {"id": nid, "type": d.type, "path": d.rel.replace("\\", "/"),
                     "status": fields.get("status"), "assignee": fields.get("assignee")}
    return tropo, info, edges


def role_of(node):
    parts = node["path"].split("/")
    return ROLE_FOLDERS.get(parts[0]) if len(parts) > 1 else None


def _outbound_targets(edges):
    out = {}
    for e in edges:
        out.setdefault(e["from"], set()).add(e["to"])
    return out


def find_conflicts(info, edges):
    """Pairs of *active* work items (changes with status `active`) that share an
    outbound target — i.e. two in-flight changes touching the same node. The graph's
    collision signal."""
    out = _outbound_targets(edges)
    active = sorted(nid for nid, n in info.items()
                    if role_of(n) == "change" and n["status"] == "active")
    conflicts = []
    for i in range(len(active)):
        for j in range(i + 1, len(active)):
            a, b = active[i], active[j]
            shared = sorted(out.get(a, set()) & out.get(b, set()))
            if shared:
                conflicts.append({"a": a, "b": b, "shared": shared})
    return active, conflicts


def cmd_conflicts(args):
    try:
        _tropo, info, edges = workspace_state(args.root)
    except ExoError as e:
        sys.exit(f"exo: {e}")
    active, conflicts = find_conflicts(info, edges)
    if args.json:
        print(json.dumps({"active": active, "conflicts": conflicts}, indent=2))
    elif not conflicts:
        print(f"exo: no conflicts among {len(active)} active work item(s)")
    else:
        print(f"exo: {len(conflicts)} conflict(s) among {len(active)} active work item(s):")
        for c in conflicts:
            print(f"  {c['a']} <-> {c['b']}  share: {', '.join(c['shared'])}")
    return 0


def cmd_board(args):
    try:
        _tropo, info, _edges = workspace_state(args.root)
    except ExoError as e:
        sys.exit(f"exo: {e}")
    items = sorted((n for n in info.values() if role_of(n) == "change"),
                   key=lambda n: (n["status"] or "~", n["id"]))
    if args.json:
        print(json.dumps({"items": [
            {"id": n["id"], "status": n["status"], "assignee": n["assignee"]}
            for n in items]}, indent=2))
    elif not items:
        print("exo: no work items (changes) found")
    else:
        print(f"exo: {len(items)} work item(s)")
        for n in items:
            who = f"  @{n['assignee']}" if n["assignee"] else ""
            print(f"  [{n['status'] or 'no status'}]  {n['id']}{who}")
    return 0


def cmd_roles(args):
    if args.json:
        print(json.dumps({"roles": [{"role": r, "contract": c} for r, c in ROLES]}, indent=2))
    else:
        print("exo: role contracts (workers get bounded contracts; never product owners)")
        for r, c in ROLES:
            print(f"  {r:13} {c}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="exo",
                                description="The coordination layer over the tropo graph.")
    p.add_argument("--version", action="version", version=f"exo {__version__}")
    p.add_argument("command", nargs="?", default="conflicts",
                   choices=["conflicts", "board", "roles"])
    p.add_argument("--root", default=None,
                   help="workspace root (default: walk up for tropo.toml)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    args = p.parse_args(argv)
    return {"conflicts": cmd_conflicts, "board": cmd_board, "roles": cmd_roles}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
