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
  ozone [review] [--root DIR] [--pack NAME] [--json] [--strict]
                                                        # findings over the graph
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

ROOT_SURFACE_THRESHOLDS = {
    "AGENTS.md": (160, 10000),
    "CLAUDE.md": (160, 10000),
    "STRATO.md": (160, 10000),
    "SOUL.md": (160, 10000),
    "STATE.md": (80, 4000),
    "README.md": (250, 15000),
}
MODULE_INDEX_THRESHOLD = (120, 8000)
BULK_LOAD_VERBS = ("read", "load", "scan", "open")
BULK_LOAD_TARGETS = (
    "whole repo", "entire repo", "full repo", "whole repository", "entire repository",
    "entire docs", "whole docs", "full docs", "docs tree", "docs folder",
    "whole folder", "entire folder", "all files", "everything",
)
BULK_LOAD_NEGATIONS = ("do not", "don't", "dont", "never", "avoid")


class OzoneError(Exception):
    pass


def _load_tropo():
    """Load the tropo engine in-process. Returns (module, tropo_dir).

    Prefers the in-repo sibling `../tropo/tropo.py` (so repo work uses the repo
    engine); when installed, falls back to the `vivary-tropo` dependency (`import
    tropo`)."""
    here = os.path.dirname(os.path.abspath(__file__))
    sibling = os.path.join(os.path.dirname(here), "tropo", "tropo.py")
    if os.path.isfile(sibling):
        spec = importlib.util.spec_from_file_location("ozone_tropo", sibling)
        if spec is None or spec.loader is None:
            raise OzoneError(f"could not load tropo engine: {sibling}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, os.path.dirname(sibling)
    try:
        import tropo as module
    except ImportError as e:
        raise OzoneError(f"tropo engine not found (install vivary-tropo): {e}")
    return module, os.path.dirname(os.path.abspath(module.__file__))


def build_workspace_graph(root):
    """Resolve the tropo graph for a workspace root. Returns (tropo, root, nodes, edges)."""
    tropo, tropo_dir = _load_tropo()
    start = root or os.getcwd()
    found = tropo.find_root(start)
    if found is None:
        raise OzoneError(f"no tropo.toml found walking up from {os.path.abspath(start)}")
    resolver = tropo.ConfigResolver(found, tropo_dir)
    docs = tropo.analyze(resolver.root, [], resolver)
    nodes, edges = tropo.build_graph(docs)
    return tropo, resolver.root, nodes, edges


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


def workspace_rel(root, path):
    return os.path.relpath(path, root).replace(os.sep, "/")


def estimate_tokens(text):
    return (len(text) + 3) // 4


def read_public_text(path):
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def public_routing_surfaces(root):
    surfaces = []
    for name in sorted(ROOT_SURFACE_THRESHOLDS):
        path = os.path.join(root, name)
        if os.path.isfile(path):
            text = read_public_text(path)
            if text is not None:
                surfaces.append({
                    "path": name,
                    "text": text,
                    "threshold": ROOT_SURFACE_THRESHOLDS[name],
                    "kind": "root",
                })

    modules_dir = os.path.join(root, "modules")
    index_path = os.path.join(modules_dir, "index.md")
    if os.path.isfile(index_path):
        text = read_public_text(index_path)
        if text is not None:
            surfaces.append({
                "path": "modules/index.md",
                "text": text,
                "threshold": MODULE_INDEX_THRESHOLD,
                "kind": "module-index",
            })
    if os.path.isdir(modules_dir):
        for name in sorted(os.listdir(modules_dir)):
            index_path = os.path.join(modules_dir, name, "index.md")
            if os.path.isfile(index_path):
                text = read_public_text(index_path)
                if text is not None:
                    surfaces.append({
                        "path": workspace_rel(root, index_path),
                        "text": text,
                        "threshold": MODULE_INDEX_THRESHOLD,
                        "kind": "module-index",
                    })
    return surfaces


def bulk_load_cue(line):
    text = " ".join(line.lower().replace("-", " ").split())
    if any(neg in text for neg in BULK_LOAD_NEGATIONS):
        return False
    return any(verb in text for verb in BULK_LOAD_VERBS) and any(
        target in text for target in BULK_LOAD_TARGETS)


def normalized_routing_blocks(text):
    blocks = []
    for raw in text.split("\n\n"):
        normalized = " ".join(raw.split()).strip().lower()
        if len(normalized) > 100:
            blocks.append(normalized)
    return blocks


def context_budget_pack(root, nodes, edges):
    findings = []
    modules_dir = os.path.join(root, "modules")
    if os.path.isdir(modules_dir):
        for name in sorted(os.listdir(modules_dir)):
            child = os.path.join(modules_dir, name)
            if not os.path.isdir(child):
                continue
            index_path = os.path.join(child, "index.md")
            if not os.path.isfile(index_path):
                rel_child = workspace_rel(root, child)
                findings.append({
                    "severity": "warn",
                    "rule": "module-index-missing",
                    "path": workspace_rel(root, index_path),
                    "message": f"module directory '{rel_child}' is missing index.md",
                })
        for name in sorted(os.listdir(modules_dir)):
            child = os.path.join(modules_dir, name)
            if not os.path.isfile(child) or not name.endswith(".md") or name == "index.md":
                continue
            stem = name[:-3]
            index_path = os.path.join(modules_dir, stem, "index.md")
            if os.path.isfile(index_path):
                findings.append({
                    "severity": "warn",
                    "rule": "legacy-module-file",
                    "path": workspace_rel(root, child),
                    "message": f"legacy module file duplicates '{workspace_rel(root, index_path)}'",
                })
    surfaces = public_routing_surfaces(root)
    duplicate_blocks = {}
    for surface in surfaces:
        for block in normalized_routing_blocks(surface["text"]):
            duplicate_blocks.setdefault(block, [])
            if surface["path"] not in duplicate_blocks[block]:
                duplicate_blocks[block].append(surface["path"])

    for surface in surfaces:
        line_count = len(surface["text"].splitlines())
        char_count = len(surface["text"])
        max_lines, max_chars = surface["threshold"]
        if line_count > max_lines or char_count > max_chars:
            if surface["kind"] == "module-index":
                rule = "module-index-large"
            else:
                rule = "always-on-large"
            findings.append({
                "severity": "info",
                "rule": rule,
                "path": surface["path"],
                "estimated_tokens": estimate_tokens(surface["text"]),
                "message": f"{surface['path']} is {line_count} line(s), {char_count} char(s); "
                           f"keep routing surfaces under {max_lines} line(s) or "
                           f"{max_chars} char(s)",
            })
        for line_no, line in enumerate(surface["text"].splitlines(), start=1):
            if not bulk_load_cue(line):
                continue
            findings.append({
                "severity": "info",
                "rule": "bulk-load-cue",
                "path": surface["path"],
                "message": f"{surface['path']}:{line_no} encourages bulk-loading context; "
                           "route agents through targeted indexes instead",
            })
    for block in sorted(duplicate_blocks):
        paths = duplicate_blocks[block]
        if len(paths) < 2:
            continue
        findings.append({
            "severity": "info",
            "rule": "duplicate-routing-block",
            "path": paths[0],
            "message": f"routing block is repeated across {', '.join(paths)}; "
                       "keep durable truth in one owner and link to it",
        })
    return findings


PACKS = [
    {"name": "structure",
     "description": "deterministic completeness + topology review over the Vivary graph"},
    {"name": "context-budget",
     "description": "deterministic context-bloat review over public routing surfaces"},
]


def selected_packs(name):
    if name == "all":
        return [p["name"] for p in PACKS]
    known = {p["name"] for p in PACKS}
    if name not in known:
        raise OzoneError(f"unknown review pack {name!r}")
    return [name]


def cmd_review(args):
    try:
        _tropo, root, nodes, edges = build_workspace_graph(args.root)
        packs = selected_packs(args.pack)
    except OzoneError as e:
        sys.exit(f"ozone: {e}")
    findings = []
    if "structure" in packs:
        findings.extend(structure_pack(nodes, edges))
    if "context-budget" in packs:
        findings.extend(context_budget_pack(root, nodes, edges))
    warns = [f for f in findings if f["severity"] == "warn"]
    notes = [f for f in findings if f["severity"] != "warn"]
    if args.json:
        print(json.dumps({"reviewed": len(nodes), "packs": packs, "warnings": len(warns),
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
        tropo, _root, nodes, edges = build_workspace_graph(args.root)
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
    p.add_argument("--pack", default="structure",
                   choices=["structure", "context-budget", "all"],
                   help="review: rule pack to run (default: structure)")
    args = p.parse_args(argv)
    return {"review": cmd_review, "impact": cmd_impact, "packs": cmd_packs}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
