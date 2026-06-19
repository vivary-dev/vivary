"""Meso Canvas model derivation and app-owned persistence.

The workspace remains the source of truth. Meso stores only canvas-owned state:
node positions, notes, flow placeholders, and saved views under ~/.vivary-gui.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .. import config
from ..bridge import cli
from ..index.indexer import MARKDOWN, NEVER, SKIP_DIRS, _is_private
from . import gates
from .agents.manager import manager

NODE_KINDS = {"file", "doc", "graph", "gate", "run", "plan", "diff", "flow", "note"}
EDGE_KINDS = {
    "links_to",
    "imports",
    "mentions",
    "generated_from",
    "blocked_by",
    "changed_by",
    "feeds",
    "approves",
}


def _store_path(wsid: str) -> Path:
    return config.MESO_DIR / wsid / "meso.json"


def _default_store() -> dict:
    return {"version": 1, "positions": {}, "nodes": [], "views": [], "viewport": None}


def load_store(wsid: str) -> dict:
    path = _store_path(wsid)
    if not path.exists():
        return _default_store()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _default_store()
    if not isinstance(data, dict):
        return _default_store()
    store = _default_store()
    for key in store:
        if key in data:
            store[key] = data[key]
    if not isinstance(store["positions"], dict):
        store["positions"] = {}
    if not isinstance(store["nodes"], list):
        store["nodes"] = []
    return store


def save_store(wsid: str, store: dict) -> dict:
    path = _store_path(wsid)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=2, sort_keys=True), encoding="utf-8")
    return store


def save_layout(wsid: str, positions: dict[str, dict], viewport: dict | None = None) -> dict:
    store = load_store(wsid)
    clean: dict[str, dict[str, float]] = {}
    for node_id, pos in positions.items():
        if not isinstance(node_id, str) or not isinstance(pos, dict):
            continue
        x = _num(pos.get("x"))
        y = _num(pos.get("y"))
        if x is None or y is None:
            continue
        clean[node_id] = {"x": x, "y": y}
    store["positions"] = {**store.get("positions", {}), **clean}
    if isinstance(viewport, dict):
        store["viewport"] = viewport
    save_store(wsid, store)
    return {"saved": len(clean), "viewport": store.get("viewport")}


def add_node(wsid: str, node: dict) -> dict:
    kind = str(node.get("kind") or "note")
    if kind not in {"note", "flow"}:
        raise ValueError("only note and flow nodes are app-owned in this slice")
    store = load_store(wsid)
    node_id = str(node.get("id") or f"{kind}:{len(store['nodes']) + 1}")
    title = str(node.get("title") or ("New flow" if kind == "flow" else "Note"))
    owned = {
        "id": node_id,
        "kind": kind,
        "title": title,
        "summary": str(node.get("summary") or node.get("text") or ""),
        "position": _position(node.get("position"), len(store["nodes"])),
        "status": "ok",
    }
    if kind == "flow":
        owned["flowId"] = node_id.replace("flow:", "", 1)
    store["nodes"] = [n for n in store["nodes"] if not (isinstance(n, dict) and n.get("id") == node_id)]
    store["nodes"].append(owned)
    store.setdefault("positions", {})[node_id] = owned["position"]
    save_store(wsid, store)
    return owned


def build_model(wsid: str, root: str | Path) -> dict:
    root = Path(root).resolve()
    store = load_store(wsid)
    nodes: list[dict] = []
    edges: list[dict] = []

    nodes.extend(_file_nodes(root))
    graph_nodes, graph_edges = _graph_items(root)
    nodes.extend(graph_nodes)
    edges.extend(graph_edges)
    gate_nodes, gate_edges = _gate_items(root)
    nodes.extend(gate_nodes)
    edges.extend(gate_edges)
    run_nodes, run_edges = _session_items(wsid)
    nodes.extend(run_nodes)
    edges.extend(run_edges)
    nodes.extend(_owned_nodes(store))

    nodes = _dedupe_nodes(nodes)
    edge_node_ids = {n["id"] for n in nodes}
    edges = _dedupe_edges([e for e in edges if e["source"] in edge_node_ids and e["target"] in edge_node_ids])
    _apply_layout(nodes, store.get("positions", {}))
    return {
        "workspace": wsid,
        "nodes": nodes,
        "edges": edges,
        "views": store.get("views", []),
        "viewport": store.get("viewport"),
        "storage": str(_store_path(wsid)),
        "engine": {"canvas": "react-flow", "fallback": "tldraw-deferred"},
    }


def build_context(wsid: str, root: str | Path, node_ids: list[str], edge_ids: list[str] | None = None) -> dict:
    model = build_model(wsid, root)
    wanted_nodes = set(node_ids)
    wanted_edges = set(edge_ids or [])
    selected_nodes = [n for n in model["nodes"] if n["id"] in wanted_nodes]
    selected_edges = [e for e in model["edges"] if e["id"] in wanted_edges]

    paths = sorted({n["path"] for n in selected_nodes if n.get("path")})
    graph_ids = sorted({n["graphId"] for n in selected_nodes if n.get("graphId")})
    session_ids = sorted({n["sessionId"] for n in selected_nodes if n.get("sessionId")})
    private_count = sum(1 for n in selected_nodes if n.get("private"))
    labels = [f"{n['kind']}:{n['title']}" for n in selected_nodes[:8]]
    more = len(selected_nodes) - len(labels)
    summary = f"{len(selected_nodes)} node(s) selected"
    if labels:
        summary += ": " + "; ".join(labels)
    if more > 0:
        summary += f"; +{more} more"
    if private_count:
        summary += f". {private_count} private path(s) selected; include only with explicit user intent."

    return {
        "nodes": [n["id"] for n in selected_nodes],
        "edges": [e["id"] for e in selected_edges],
        "paths": paths,
        "graphIds": graph_ids,
        "sessionIds": session_ids,
        "summary": summary,
    }


def run_flow(wsid: str, flow_id: str, node_ids: list[str] | None = None) -> dict:
    return {
        "workspace": wsid,
        "flowId": flow_id,
        "status": "not_implemented",
        "events": [],
        "selected": node_ids or [],
        "message": "Meso Flow execution is reserved for M4; the route is stable for clients.",
    }


def _file_nodes(root: Path) -> list[dict]:
    out: list[dict] = []
    for p in sorted(root.rglob("*"), key=lambda item: str(item).lower()):
        if not p.is_file():
            continue
        try:
            rel = p.relative_to(root)
        except ValueError:
            continue
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        private = rel.name in NEVER or _is_private(rel)
        rel_s = str(rel).replace("\\", "/")
        kind = "doc" if p.suffix.lower() in MARKDOWN else "file"
        summary = _preview_file(p) if kind == "doc" else f"{p.suffix.lower() or 'file'} file"
        out.append({
            "id": f"{kind}:{rel_s}",
            "kind": kind,
            "title": rel.name,
            "path": rel_s,
            "summary": summary,
            "status": "warning" if private else "ok",
            "private": private,
        })
    return out


def _graph_items(root: Path) -> tuple[list[dict], list[dict]]:
    try:
        graph = cli.graph(root)
    except Exception as exc:  # noqa: BLE001
        return ([{
            "id": "graph:error",
            "kind": "graph",
            "title": "Graph unavailable",
            "summary": str(exc),
            "status": "warning",
        }], [])

    nodes_raw = graph.get("nodes", []) if isinstance(graph, dict) else []
    edges_raw = graph.get("edges", []) if isinstance(graph, dict) else []
    nodes: list[dict] = []
    edges: list[dict] = []
    for raw in nodes_raw if isinstance(nodes_raw, list) else []:
        if not isinstance(raw, dict):
            continue
        gid = str(raw.get("id") or raw.get("path") or raw.get("name") or "")
        if not gid:
            continue
        nodes.append({
            "id": f"graph:{gid}",
            "kind": "graph",
            "title": str(raw.get("title") or raw.get("name") or gid),
            "graphId": gid,
            "path": _maybe_path(raw),
            "summary": str(raw.get("type") or raw.get("kind") or "graph node"),
            "status": "ok",
        })
    for raw in edges_raw if isinstance(edges_raw, list) else []:
        if not isinstance(raw, dict):
            continue
        source = str(raw.get("source") or raw.get("from") or raw.get("a") or "")
        target = str(raw.get("target") or raw.get("to") or raw.get("b") or "")
        if not source or not target:
            continue
        kind = str(raw.get("kind") or raw.get("type") or "links_to")
        if kind not in EDGE_KINDS:
            kind = "links_to"
        edges.append({
            "id": f"graph:{source}->{target}:{kind}",
            "kind": kind,
            "source": f"graph:{source}",
            "target": f"graph:{target}",
            "label": kind,
        })
    return nodes, edges


def _gate_items(root: Path) -> tuple[list[dict], list[dict]]:
    nodes: list[dict] = []
    edges: list[dict] = []
    for gate in gates.list_gates(root):
        gid = str(gate.get("id") or "")
        if not gid:
            continue
        status = str(gate.get("status") or "open")
        node_id = f"gate:{gid}"
        nodes.append({
            "id": node_id,
            "kind": "gate",
            "title": str(gate.get("gate") or gid),
            "gateId": gid,
            "path": str(gate.get("path") or ""),
            "summary": str(gate.get("command_intent") or status),
            "status": "blocked" if status == "open" else "ok" if status == "approved" else "warning",
        })
        path = str(gate.get("path") or "")
        if path:
            file_id = f"doc:{path}" if Path(path).suffix.lower() in MARKDOWN else f"file:{path}"
            edges.append({
                "id": f"{node_id}->{file_id}:blocked_by",
                "kind": "blocked_by",
                "source": node_id,
                "target": file_id,
                "label": "gate file",
            })
    return nodes, edges


def _session_items(wsid: str) -> tuple[list[dict], list[dict]]:
    nodes: list[dict] = []
    edges: list[dict] = []
    for sess in manager.sessions.values():
        if sess.workspace_id != wsid:
            continue
        run_id = f"run:{sess.id}"
        nodes.append({
            "id": run_id,
            "kind": "run",
            "title": f"{sess.runtime} run",
            "sessionId": sess.id,
            "summary": sess.status,
            "status": "warning" if sess.status in {"running", "awaiting"} else "ok",
        })
        for index, ev in enumerate(sess.events):
            if ev.type == "plan":
                plan_id = f"plan:{sess.id}:{index}"
                nodes.append({
                    "id": plan_id,
                    "kind": "plan",
                    "title": ev.text or "Plan",
                    "sessionId": sess.id,
                    "summary": str(ev.meta.get("status") or "agent plan"),
                    "status": "ok",
                })
                edges.append(_edge(run_id, plan_id, "generated_from"))
            if ev.type == "file_change":
                diff_id = f"diff:{sess.id}:{index}"
                nodes.append({
                    "id": diff_id,
                    "kind": "diff",
                    "title": ev.text or "File changes",
                    "sessionId": sess.id,
                    "summary": str(ev.meta.get("changes") or ""),
                    "status": "changed",
                })
                edges.append(_edge(run_id, diff_id, "changed_by"))
    return nodes, edges


def _owned_nodes(store: dict) -> list[dict]:
    out = []
    for node in store.get("nodes", []):
        if not isinstance(node, dict):
            continue
        kind = str(node.get("kind") or "")
        node_id = str(node.get("id") or "")
        if kind not in {"note", "flow"} or not node_id:
            continue
        out.append({
            "id": node_id,
            "kind": kind,
            "title": str(node.get("title") or kind),
            "summary": str(node.get("summary") or ""),
            "flowId": node.get("flowId"),
            "status": str(node.get("status") or "ok"),
        })
    return out


def _apply_layout(nodes: list[dict], positions: dict) -> None:
    buckets: dict[str, int] = {}
    for index, node in enumerate(nodes):
        pos = positions.get(node["id"]) if isinstance(positions, dict) else None
        if isinstance(pos, dict) and _num(pos.get("x")) is not None and _num(pos.get("y")) is not None:
            node["position"] = {"x": _num(pos.get("x")), "y": _num(pos.get("y"))}
            continue
        kind = node["kind"]
        slot = buckets.get(kind, 0)
        buckets[kind] = slot + 1
        node["position"] = _position_for(kind, slot, index)


def _position_for(kind: str, slot: int, index: int) -> dict[str, float]:
    columns = {
        "doc": 0,
        "file": 1,
        "graph": 2,
        "gate": 3,
        "run": 4,
        "plan": 5,
        "diff": 5,
        "flow": 6,
        "note": 6,
    }
    col = columns.get(kind, index % 4)
    row = slot
    if kind == "file":
        row = math.floor(slot / 2)
        col = 1 + (slot % 2)
    return {"x": float(col * 260), "y": float(row * 150)}


def _position(value: Any, index: int) -> dict[str, float]:
    if isinstance(value, dict):
        x = _num(value.get("x"))
        y = _num(value.get("y"))
        if x is not None and y is not None:
            return {"x": x, "y": y}
    return _position_for("note", index, index)


def _dedupe_nodes(nodes: list[dict]) -> list[dict]:
    out: dict[str, dict] = {}
    for node in nodes:
        if not isinstance(node.get("id"), str) or node.get("kind") not in NODE_KINDS:
            continue
        out[node["id"]] = node
    return list(out.values())


def _dedupe_edges(edges: list[dict]) -> list[dict]:
    out: dict[str, dict] = {}
    for edge in edges:
        if not isinstance(edge.get("id"), str) or edge.get("kind") not in EDGE_KINDS:
            continue
        if not isinstance(edge.get("source"), str) or not isinstance(edge.get("target"), str):
            continue
        out[edge["id"]] = edge
    return list(out.values())


def _edge(source: str, target: str, kind: str) -> dict:
    return {"id": f"{source}->{target}:{kind}", "kind": kind, "source": source, "target": target, "label": kind}


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _maybe_path(raw: dict) -> str | None:
    for key in ("path", "file", "source_path"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value.replace("\\", "/")
    return None


def _preview_file(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "markdown document"
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:160]
    return "empty markdown document"
