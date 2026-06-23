#!/usr/bin/env python3
"""exo - the coordination layer.

The outermost, thinnest stratum: engaged only when one agent becomes many. exo does
not *run* agents (that's the harness/loops) — it reasons about coordination over the
shared tropo graph and hands workers their role contracts:

  - `exo conflicts`  who would collide — active work items that touch the same node
  - `exo board`      what's in flight — work items grouped by status
  - `exo claim`      claim ownership of a work item in the graph
  - `exo roles`      the bounded worker contracts (strato's role grammar)

Graph-native and deterministic: it reads tropo's graph in-process (no fork, no second
state store) and writes only explicit coordination fields that the workspace opts into.
Most workspaces never need exo; single-agent workspaces stop at tropo + strato.

Usage:
  exo [conflicts] [--root DIR] [--json]
  exo board [--root DIR] [--json]
  exo claim <id> --agent <handle> [--root DIR] [--json]
  exo roles [--json]
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import tempfile

__version__ = "0.2.2"

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
AGENT_RE = re.compile(r"^@?[A-Za-z0-9._-]+$")


class ExoError(Exception):
    pass


def _load_tropo():
    """Load the tropo engine in-process. Prefers the in-repo sibling
    `../tropo/tropo.py`; when installed, falls back to the `vivary-tropo`
    dependency (`import tropo`)."""
    here = os.path.dirname(os.path.abspath(__file__))
    sibling = os.path.join(os.path.dirname(here), "tropo", "tropo.py")
    if os.path.isfile(sibling):
        spec = importlib.util.spec_from_file_location("exo_tropo", sibling)
        if spec is None or spec.loader is None:
            raise ExoError(f"could not load tropo engine: {sibling}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, os.path.dirname(sibling)
    try:
        import tropo as module
    except ImportError as e:
        raise ExoError(f"tropo engine not found (install vivary-tropo): {e}")
    return module, os.path.dirname(os.path.abspath(module.__file__))


def _workspace_docs(root):
    tropo, tropo_dir = _load_tropo()
    start = root or os.getcwd()
    found = tropo.find_root(start)
    if found is None:
        raise ExoError(f"no tropo.toml found walking up from {os.path.abspath(start)}")
    resolver = tropo.ConfigResolver(found, tropo_dir)
    docs = tropo.analyze(resolver.root, [], resolver)
    return tropo, resolver, docs


def workspace_state(root):
    """Resolve the graph and enrich nodes with `status`/`assignee` from frontmatter.
    Returns (tropo, info, edges) where info maps id -> {id,type,path,status,assignee}."""
    tropo, _resolver, docs = _workspace_docs(root)
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


def _normalize_agent(agent):
    if not agent or not AGENT_RE.match(agent):
        raise ExoError(
            f"invalid agent handle {agent!r}; use letters, numbers, '.', '_', '-' and optional leading @")
    return agent[1:] if agent.startswith("@") else agent


def _doc_by_id(docs, target_id):
    for doc in docs:
        if doc.derived.get("id") == target_id:
            return doc
    return None


def _ensure_assignee_declared(tropo, resolver, doc):
    config = resolver.for_dir(os.path.dirname(doc.full))
    _required, known = config.fields_for(doc.type)
    if "assignee" not in known:
        raise ExoError(
            'assignee is not declared for this workspace; add packs = ["coordination"] to tropo.toml')


def _ensure_workspace_file(root, doc):
    root_real = os.path.realpath(root)
    doc_real = os.path.realpath(doc.full)
    try:
        common = os.path.commonpath([root_real, doc_real])
    except ValueError:
        common = None
    if common != root_real or os.path.islink(doc.full):
        raise ExoError(f"{doc.rel}: refusing to claim symlinked or out-of-workspace file")


def _write_assignee(tropo, root, doc, assignee):
    with open(doc.full, encoding="utf-8") as fh:
        text = fh.read()
    yaml_text, body = tropo.extract_frontmatter(text)
    if yaml_text is None:
        if body.startswith("---"):
            raise ExoError(f"{doc.rel}: malformed frontmatter")
        previous = None
        _replace_workspace_file(root, doc, f"---\nassignee: {assignee}\n---\n{body}")
        return previous, True

    try:
        data = tropo.parse_yaml(yaml_text)
    except tropo.YamlError as e:
        raise ExoError(f"{doc.rel}: frontmatter is not valid YAML: {e}")
    if not isinstance(data, dict):
        raise ExoError(f"{doc.rel}: frontmatter must be a mapping")

    fields = tropo.strip_meta(data)
    previous = fields.get("assignee")
    if previous == assignee:
        return previous, False

    lines = yaml_text.splitlines()
    line_map = data.get("__lines__", {})
    if "assignee" in line_map:
        lines[line_map["assignee"] - 1] = f"assignee: {assignee}"
    else:
        lines.append(f"assignee: {assignee}")
    new_yaml = "\n".join(lines).rstrip()
    _replace_workspace_file(root, doc, f"---\n{new_yaml}\n---\n{body}")
    return previous, True


def _replace_workspace_file(root, doc, text):
    path = doc.full
    directory = os.path.dirname(path) or os.curdir
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{os.path.basename(path)}.",
        suffix=".exo-tmp",
        dir=directory,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        _ensure_workspace_file(root, doc)
        os.replace(tmp_name, path)
    finally:
        if os.path.lexists(tmp_name):
            os.unlink(tmp_name)


def cmd_claim(args):
    try:
        assignee = _normalize_agent(args.agent)
        tropo, resolver, docs = _workspace_docs(args.root)
        doc = _doc_by_id(docs, args.target)
        if doc is None:
            raise ExoError(f"no work item with id {args.target!r}")
        node = {"path": doc.rel.replace("\\", "/")}
        if role_of(node) != "change":
            raise ExoError(f"{args.target!r} is not a work item under changes/")
        _ensure_assignee_declared(tropo, resolver, doc)
        _ensure_workspace_file(resolver.root, doc)
        previous, changed = _write_assignee(tropo, resolver.root, doc, assignee)
    except ExoError as e:
        sys.exit(f"exo: {e}")

    result = {
        "id": args.target,
        "path": doc.rel.replace("\\", "/"),
        "assignee": assignee,
        "previous_assignee": previous,
        "changed": changed,
    }
    if args.json:
        print(json.dumps(result, indent=2))
    elif changed:
        print(f"exo: claimed {args.target} for @{assignee}")
    else:
        print(f"exo: {args.target} already claimed by @{assignee}")
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
                   choices=["conflicts", "board", "claim", "roles"])
    p.add_argument("target", nargs="?", help="claim: work item id")
    p.add_argument("--agent", default=None, help="claim: agent handle")
    p.add_argument("--root", default=None,
                   help="workspace root (default: walk up for tropo.toml)")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    args = p.parse_args(argv)
    if args.command == "claim":
        if not args.target:
            p.error("claim requires a work item id")
        if not args.agent:
            p.error("claim requires --agent <handle>")
    return {
        "conflicts": cmd_conflicts,
        "board": cmd_board,
        "claim": cmd_claim,
        "roles": cmd_roles,
    }[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
