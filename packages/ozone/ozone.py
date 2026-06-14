#!/usr/bin/env python3
"""ozone - the review layer.

Where `tropo` answers "is each document valid?", `ozone` reviews the *whole graph*:
the relationship-level gaps a per-document check cannot see (a change with nothing
verifying it), and the **blast radius** of a node (everything that depends on it).
It reads tropo's typed graph in-process — never a second copy of the graph code —
so a review is graph-aware by construction.

This is the deterministic core: topology-derived findings only, zero dependencies,
no LLM. Semantic ("organize by meaning") review is graphify's job, layered on top of
tropo's clean graph — not here.

Usage:
  ozone [review] [--root DIR] [--json] [--strict]   # findings over the graph
  ozone impact <id> [--root DIR] [--json]            # what depends on <id>
  ozone packs [--json]                               # list rule packs

Exit codes: 0 clean (review is advisory by default) · 1 with --strict when warnings
exist, or on a usage/config error.
"""
import argparse
import importlib.util
import json
import os
import sys

__version__ = "0.1.0"

# Review role = the workspace folder a node lives in (folder-as-type), independent of
# the resolved type *name* (e.g. a change may resolve to type `implementation_slice`,
# but it lives under changes/). Keyed on the top-level path segment.
ROLE_FOLDERS = {
    "modules": "module",
    "changes": "change",
    "decisions": "decision",
    "verification": "verification",
    "gates": "gate",
}


class OzoneError(Exception):
    pass


def _load_tropo():
    """Load the sibling tropo engine in-process. Returns (module, tropo_dir)."""
    here = os.path.dirname(os.path.abspath(__file__))
    tropo_dir = os.path.join(os.path.dirname(here), "tropo")
    tropo_path = os.path.join(tropo_dir, "tropo.py")
    if not os.path.isfile(tropo_path):
        raise OzoneError(f"tropo engine not found at {tropo_path}")
    spec = importlib.util.spec_from_file_location("ozone_tropo", tropo_path)
    if spec is None or spec.loader is None:
        raise OzoneError(f"could not load tropo engine: {tropo_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, tropo_dir


def build_workspace_graph(root):
    """Resolve the tropo graph for a workspace root. Returns (tropo, nodes, edges)."""
    tropo, tropo_dir = _load_tropo()
    start = root or os.getcwd()
    found = tropo.find_root(start)
    if found is None:
        raise OzoneError(f"no tropo.toml found walking up from {os.path.abspath(start)}")
    resolver = tropo.ConfigResolver(found, tropo_dir)
    docs = tropo.analyze(resolver.root, [], resolver)
    nodes, edges = tropo.build_graph(docs)
    return tropo, nodes, edges


def role_of(node):
    parts = node["path"].split("/")
    return ROLE_FOLDERS.get(parts[0]) if len(parts) > 1 else None


def structure_pack(nodes, edges):
    """The built-in deterministic review pack: completeness + topology findings over
    the Vivary graph vocabulary. Returns a list of finding dicts, sorted stably."""
    outfields, degree = {}, {}
    for e in edges:
        outfields.setdefault(e["from"], set()).add(e["field"])
        degree[e["from"]] = degree.get(e["from"], 0) + 1
        degree[e["to"]] = degree.get(e["to"], 0) + 1

    findings = []

    def add(sev, rule, nid, msg):
        n = nodes[nid]
        findings.append({"severity": sev, "rule": rule, "id": nid,
                         "type": n["type"], "path": n["path"], "message": msg})

    for nid in sorted(nodes):
        role = role_of(nodes[nid])
        fields = outfields.get(nid, set())
        if role == "change":
            if "verification" not in fields:
                add("warn", "change-unverified", nid,
                    f"change '{nid}' has no verification linked")
            if "gates" not in fields:
                add("info", "change-ungated", nid,
                    f"change '{nid}' has no gate linked")
        elif role == "module":
            if "verification" not in fields:
                add("info", "module-unverified", nid,
                    f"module '{nid}' has no verification linked")
        if degree.get(nid, 0) == 0:
            add("info", "orphan", nid,
                f"{role or 'node'} '{nid}' is disconnected (no edges in or out)")

    # Broken edges are surfaced here for the reviewer, but tropo `check` is the
    # enforcing authority (it fails on the same W220 condition) — no double-enforcement.
    for e in sorted(edges, key=lambda x: (x["from"], x["field"], x["to"])):
        if e.get("broken"):
            n = nodes.get(e["from"])
            findings.append({
                "severity": "warn", "rule": "broken-edge", "id": e["from"],
                "type": n["type"] if n else None, "path": n["path"] if n else None,
                "message": f"edge {e['from']} --{e['field']}--> {e['to']} is broken "
                           f"(target missing); tropo check enforces this"})
    return findings


def cmd_review(args):
    try:
        _tropo, nodes, edges = build_workspace_graph(args.root)
    except OzoneError as e:
        sys.exit(f"ozone: {e}")
    findings = structure_pack(nodes, edges)
    warns = [f for f in findings if f["severity"] == "warn"]
    notes = [f for f in findings if f["severity"] != "warn"]
    if args.json:
        print(json.dumps({"reviewed": len(nodes), "warnings": len(warns),
                          "notes": len(notes), "findings": findings}, indent=2))
    else:
        for f in findings:
            loc = f["path"] or f["id"]
            print(f"{loc}: {f['severity']} {f['rule']}: {f['message']}")
        print(f"\nozone: reviewed {len(nodes)} node(s), "
              f"{len(warns)} warning(s), {len(notes)} note(s)")
    if getattr(args, "strict", False) and warns:
        return 1
    return 0


def cmd_impact(args):
    if not args.id:
        sys.exit("ozone: impact requires a node id (ozone impact <id>)")
    try:
        tropo, nodes, edges = build_workspace_graph(args.root)
    except OzoneError as e:
        sys.exit(f"ozone: {e}")
    if args.id not in nodes:
        sys.exit(f"ozone: no node with id {args.id!r} (run `ozone review` or `tropo graph`)")
    impacted = tropo.blast_radius(edges, args.id)
    items = sorted(impacted.items(), key=lambda kv: (kv[1]["distance"], kv[0]))
    if args.json:
        print(json.dumps({
            "target": args.id, "impacted": len(items),
            "nodes": [{"id": nid, "distance": d["distance"], "via": d["via"],
                       "type": nodes.get(nid, {}).get("type")} for nid, d in items],
        }, indent=2))
    elif not items:
        print(f"ozone: nothing depends on '{args.id}' (no inbound edges)")
    else:
        print(f"ozone: impact of '{args.id}' — {len(items)} node(s) depend on it")
        for nid, d in items:
            t = nodes.get(nid, {}).get("type", "?")
            print(f"  {d['distance']}  {nid}  ({t}, via {d['via']})")
    return 0


PACKS = [{"name": "structure",
          "description": "deterministic completeness + topology review over the Vivary graph"}]


def cmd_packs(args):
    if args.json:
        print(json.dumps({"packs": PACKS}, indent=2))
    else:
        for p in PACKS:
            print(f"{p['name']:12} {p['description']}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="ozone",
                                description="The review layer over the tropo graph.")
    p.add_argument("--version", action="version", version=f"ozone {__version__}")
    p.add_argument("command", nargs="?", default="review",
                   choices=["review", "impact", "packs"])
    p.add_argument("id", nargs="?", help="impact: the node id to analyze")
    p.add_argument("--root", default=None,
                   help="workspace root (default: walk up for tropo.toml)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--strict", action="store_true",
                   help="review: exit non-zero when warnings exist (gate mode)")
    args = p.parse_args(argv)
    return {"review": cmd_review, "impact": cmd_impact, "packs": cmd_packs}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
