"""Optional Cognee memory adapter for Vivary typed graph nodes.

The core contract is intentionally small: Cognee is a rebuildable recall sidecar,
while Tropo graph nodes remain the source of truth.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import json
import os
import re
import sys
import tomllib
from dataclasses import asdict, dataclass
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any


__version__ = "0.1.0"

MEMORY_CONFIG = ".vivary/memory.toml"
DEFAULT_PRIVATE_PATTERNS = (
    "USER.md",
    "MEMORY.md",
    "memory/**",
    "heartbeat-reports/**",
    ".vivary/**",
    ".git/**",
)
NODE_ID_RE = re.compile(r"\bvivary_node_id:\s*([A-Za-z0-9._-]+)\b")


class AdapterError(RuntimeError):
    """Raised when the optional memory adapter cannot run safely."""


@dataclass(frozen=True)
class MemoryNode:
    id: str
    type: str | None
    path: str
    title: str
    text: str
    fields: dict[str, Any]


@dataclass(frozen=True)
class MemoryEdge:
    source_id: str
    field: str
    target_id: str


@dataclass(frozen=True)
class RecallHit:
    node_id: str
    type: str | None
    path: str
    score: float
    reason: str
    source: str
    edge_context: list[MemoryEdge]
    provider: str


@dataclass(frozen=True)
class MemorySnapshot:
    root: str
    dataset: str
    fingerprint: str
    nodes: list[MemoryNode]
    edges: list[MemoryEdge]
    private_patterns: list[str]


def _norm(path: str | Path) -> str:
    return str(path).replace("\\", "/").strip("/")


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.lower()).strip("-")
    return slug or "workspace"


def _pattern_matches(pattern: str, rel_path: str) -> bool:
    pattern = _norm(pattern)
    rel_path = _norm(rel_path)
    if pattern.endswith("/**"):
        base = pattern[:-3]
        return rel_path == base or rel_path.startswith(base + "/")
    if "/" not in pattern:
        return fnmatchcase(Path(rel_path).name, pattern)
    return fnmatchcase(rel_path, pattern)


def _gitignore_rules(root: Path) -> list[tuple[bool, str]]:
    path = root / ".gitignore"
    if not path.exists():
        return []
    rules: list[tuple[bool, str]] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negated = line.startswith("!")
        pattern = line[1:] if negated else line
        if pattern:
            rules.append((negated, pattern))
    return rules


def _ignored_by_gitignore(rel_path: str, rules: list[tuple[bool, str]]) -> bool:
    ignored = False
    for negated, pattern in rules:
        if _pattern_matches(pattern, rel_path):
            ignored = not negated
    return ignored


def _load_memory_config(root: Path) -> dict[str, Any]:
    path = root / MEMORY_CONFIG
    if not path.exists():
        return {
            "enabled": False,
            "provider": "none",
            "mode": "none",
            "privacy": {},
            "cognee": {},
            "config": None,
        }
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise AdapterError(f"invalid {MEMORY_CONFIG}: {exc}") from exc
    memory = data.get("memory", {})
    return {
        "enabled": bool(memory.get("enabled", False)),
        "provider": str(memory.get("provider", "none")),
        "mode": str(memory.get("mode", "none")),
        "privacy": dict(memory.get("privacy", {})),
        "cognee": dict(memory.get("cognee", {})),
        "config": str(path),
    }


def _privacy_patterns(config: dict[str, Any]) -> list[str]:
    privacy = config.get("privacy", {})
    patterns = list(DEFAULT_PRIVATE_PATTERNS)
    for pattern in privacy.get("private_paths", []) or []:
        normalized = _norm(str(pattern))
        if normalized not in patterns:
            patterns.append(normalized)
    return patterns


def _is_private_path(
    rel_path: str,
    *,
    patterns: list[str],
    gitignore_rules: list[tuple[bool, str]],
    respect_gitignore: bool,
) -> bool:
    if any(_pattern_matches(pattern, rel_path) for pattern in patterns):
        return True
    return bool(respect_gitignore and _ignored_by_gitignore(rel_path, gitignore_rules))


def _import_tropo():
    try:
        return importlib.import_module("tropo")
    except ImportError as exc:
        repo_tropo = Path(__file__).resolve().parents[1] / "tropo"
        if repo_tropo.exists():
            sys.path.insert(0, str(repo_tropo))
            try:
                return importlib.import_module("tropo")
            except ImportError:
                pass
        raise AdapterError("vivary-tropo is required to build typed memory packets") from exc


def _import_cognee():
    return importlib.import_module("cognee")


def _read_body(tropo: Any, full_path: str) -> str:
    raw = Path(full_path).read_text(encoding="utf-8", errors="replace")
    try:
        _frontmatter, body = tropo.extract_frontmatter(raw)
        return body.strip()
    except Exception:
        return raw.strip()


def _edge_lines(node_id: str, edges: list[dict[str, Any]]) -> list[str]:
    lines = []
    for edge in edges:
        if edge.get("from") == node_id and not edge.get("broken"):
            lines.append(f"- {edge['field']}: {edge['to']}")
    return lines


def _node_text(
    *,
    node_id: str,
    node_type: str | None,
    rel_path: str,
    title: str,
    fields: dict[str, Any],
    body: str,
    edges: list[dict[str, Any]],
) -> str:
    lines = [
        f"vivary_node_id: {node_id}",
        f"vivary_type: {node_type or 'untyped'}",
        f"vivary_path: {rel_path}",
        f"vivary_title: {title}",
        "",
        "frontmatter:",
        json.dumps(fields, sort_keys=True, ensure_ascii=True),
    ]
    outbound = _edge_lines(node_id, edges)
    if outbound:
        lines.extend(["", "outbound_edges:", *outbound])
    if body:
        lines.extend(["", "body:", body])
    return "\n".join(lines).strip() + "\n"


def _fingerprint(nodes: list[MemoryNode], edges: list[MemoryEdge]) -> str:
    payload = {
        "nodes": [
            {
                "id": node.id,
                "type": node.type,
                "path": node.path,
                "text_sha256": hashlib.sha256(node.text.encode("utf-8")).hexdigest(),
            }
            for node in sorted(nodes, key=lambda n: n.id)
        ],
        "edges": [asdict(edge) for edge in sorted(edges, key=lambda e: (e.source_id, e.field, e.target_id))],
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _dataset_name(root: Path, config: dict[str, Any]) -> str:
    configured = config.get("cognee", {}).get("dataset")
    if configured:
        return str(configured)
    return f"vivary-{_slug(root.name)}"


def build_snapshot(root: str | Path) -> MemorySnapshot:
    """Build privacy-filtered typed node packets from the Tropo graph."""
    root_path = Path(root).resolve()
    config = _load_memory_config(root_path)
    privacy = config.get("privacy", {})
    patterns = _privacy_patterns(config)
    gitignore_rules = _gitignore_rules(root_path)
    respect_gitignore = bool(privacy.get("respect_gitignore", True))

    tropo = _import_tropo()
    resolver = tropo.ConfigResolver(str(root_path), str(Path(tropo.__file__).parent))
    docs = tropo.analyze(str(root_path), [], resolver)
    graph_nodes, graph_edges = tropo.build_graph(docs)

    public_ids: set[str] = set()
    by_id: dict[str, Any] = {}
    for doc in docs:
        node_id = doc.derived.get("id")
        rel_path = _norm(doc.rel)
        if not node_id:
            continue
        if _is_private_path(
            rel_path,
            patterns=patterns,
            gitignore_rules=gitignore_rules,
            respect_gitignore=respect_gitignore,
        ):
            continue
        if node_id not in graph_nodes:
            continue
        public_ids.add(node_id)
        by_id.setdefault(node_id, doc)

    memory_edges = [
        MemoryEdge(source_id=edge["from"], field=edge["field"], target_id=edge["to"])
        for edge in graph_edges
        if not edge["broken"] and edge["from"] in public_ids and edge["to"] in public_ids
    ]

    nodes: list[MemoryNode] = []
    for node_id in sorted(public_ids):
        doc = by_id[node_id]
        graph_node = graph_nodes[node_id]
        rel_path = _norm(graph_node["path"])
        title = str(doc.derived.get("title") or node_id)
        fields = {
            **{k: v for k, v in doc.derived.items() if k in {"title", "created", "updated"}},
            **dict(doc.declared),
        }
        body = _read_body(tropo, doc.full)
        text = _node_text(
            node_id=node_id,
            node_type=graph_node.get("type"),
            rel_path=rel_path,
            title=title,
            fields=fields,
            body=body,
            edges=graph_edges,
        )
        nodes.append(
            MemoryNode(
                id=node_id,
                type=graph_node.get("type"),
                path=rel_path,
                title=title,
                text=text,
                fields=fields,
            )
        )

    fingerprint = _fingerprint(nodes, memory_edges)
    return MemorySnapshot(
        root=str(root_path),
        dataset=_dataset_name(root_path, config),
        fingerprint=fingerprint,
        nodes=nodes,
        edges=memory_edges,
        private_patterns=patterns,
    )


def _manifest_path(root: Path, config: dict[str, Any]) -> Path:
    state_path = str(config.get("cognee", {}).get("state_path") or ".vivary/memory/cognee")
    path = root / state_path / "manifest.json"
    resolved_parent = path.parent.resolve(strict=False)
    if os.path.commonpath([str(root), str(resolved_parent)]) != str(root):
        raise AdapterError("memory.cognee.state_path must stay inside the workspace")
    return path


def _write_manifest(root: Path, config: dict[str, Any], snapshot: MemorySnapshot) -> Path:
    path = _manifest_path(root, config)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "provider": "cognee",
        "dataset": snapshot.dataset,
        "fingerprint": snapshot.fingerprint,
        "nodes": len(snapshot.nodes),
        "edges": len(snapshot.edges),
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


def _coerce_result_text(item: Any) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        parts: list[str] = []
        for key in ("text", "content", "result", "summary", "response", "payload", "metadata"):
            if key in item:
                parts.append(_coerce_result_text(item[key]))
        if parts:
            return "\n".join(part for part in parts if part)
        return json.dumps(item, sort_keys=True, default=str)
    if hasattr(item, "model_dump"):
        try:
            return _coerce_result_text(item.model_dump())
        except Exception:
            pass
    if hasattr(item, "__dict__"):
        return _coerce_result_text(vars(item))
    return str(item)


def _coerce_score(item: Any, rank: int) -> float:
    if isinstance(item, dict):
        for key in ("score", "similarity", "distance"):
            value = item.get(key)
            if isinstance(value, (int, float)):
                if key == "distance":
                    return 1.0 / (1.0 + float(value))
                return float(value)
    return 1.0 / float(rank + 1)


def _reason_from_text(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("vivary_node_id:"):
            return line[:160]
    return "Cognee returned this Vivary node marker."


class CogneeMemoryAdapter:
    def __init__(self, root: str | Path, *, cognee_client: Any | None = None):
        self.root = Path(root).resolve()
        self.config = _load_memory_config(self.root)
        self._cognee_client = cognee_client

    @property
    def dataset(self) -> str:
        return _dataset_name(self.root, self.config)

    def _require_cognee_config(self) -> None:
        if not self.config.get("enabled"):
            raise AdapterError(f"{MEMORY_CONFIG} does not enable semantic memory")
        if self.config.get("provider") != "cognee":
            raise AdapterError(f"{MEMORY_CONFIG} provider must be 'cognee'")

    def _client(self) -> Any:
        if self._cognee_client is not None:
            return self._cognee_client
        try:
            self._cognee_client = _import_cognee()
        except ImportError as exc:
            raise AdapterError("Cognee is not installed; install vivary-memory-cognee") from exc
        return self._cognee_client

    async def index(self, *, dry_run: bool = False, approved: bool = False) -> dict[str, Any]:
        self._require_cognee_config()
        snapshot = build_snapshot(self.root)
        require_explicit = bool(
            self.config.get("cognee", {}).get("require_explicit_index", True)
        )
        if not dry_run and require_explicit and not approved:
            raise AdapterError("indexing provider memory requires --yes")
        if dry_run:
            return {
                "ok": True,
                "provider": "cognee",
                "dataset": snapshot.dataset,
                "dry_run": True,
                "indexed": 0,
                "would_index": len(snapshot.nodes),
                "edges": len(snapshot.edges),
                "fingerprint": snapshot.fingerprint,
            }

        client = self._client()
        for node in snapshot.nodes:
            remember = getattr(client, "remember", None)
            if remember is None:
                raise AdapterError("installed Cognee package has no remember() API")
            await _maybe_await(remember(node.text, dataset_name=snapshot.dataset))
        manifest = _write_manifest(self.root, self.config, snapshot)
        return {
            "ok": True,
            "provider": "cognee",
            "dataset": snapshot.dataset,
            "dry_run": False,
            "indexed": len(snapshot.nodes),
            "would_index": len(snapshot.nodes),
            "edges": len(snapshot.edges),
            "fingerprint": snapshot.fingerprint,
            "manifest": str(manifest),
        }

    async def recall(self, query: str, *, k: int = 10) -> list[RecallHit]:
        self._require_cognee_config()
        snapshot = build_snapshot(self.root)
        by_id = {node.id: node for node in snapshot.nodes}
        edges_by_source: dict[str, list[MemoryEdge]] = {}
        for edge in snapshot.edges:
            edges_by_source.setdefault(edge.source_id, []).append(edge)

        client = self._client()
        recall = getattr(client, "recall", None)
        if recall is None:
            raise AdapterError("installed Cognee package has no recall() API")
        raw_items = await _maybe_await(
            recall(query, datasets=[snapshot.dataset], top_k=k)
        )

        hits: list[RecallHit] = []
        seen: set[str] = set()
        for rank, item in enumerate(raw_items or []):
            text = _coerce_result_text(item)
            match = NODE_ID_RE.search(text)
            if not match:
                continue
            node_id = match.group(1)
            if node_id in seen or node_id not in by_id:
                continue
            node = by_id[node_id]
            hits.append(
                RecallHit(
                    node_id=node.id,
                    type=node.type,
                    path=node.path,
                    score=_coerce_score(item, rank),
                    reason=_reason_from_text(text),
                    source="provider",
                    edge_context=edges_by_source.get(node.id, []),
                    provider="cognee",
                )
            )
            seen.add(node_id)
            if len(hits) >= k:
                break
        return hits

    async def forget(self, *, approved: bool = False) -> dict[str, Any]:
        self._require_cognee_config()
        if not approved:
            raise AdapterError("forgetting provider memory requires --yes")
        client = self._client()
        forget = getattr(client, "forget", None)
        if forget is None:
            raise AdapterError("installed Cognee package has no forget() API")
        result = await _maybe_await(forget(dataset=self.dataset, memory_only=True))
        manifest = _manifest_path(self.root, self.config)
        if manifest.exists():
            manifest.unlink()
        return {
            "ok": True,
            "provider": "cognee",
            "dataset": self.dataset,
            "forgot": True,
            "result": result,
        }


def doctor(root: str | Path) -> dict[str, Any]:
    root_path = Path(root).resolve()
    try:
        config = _load_memory_config(root_path)
    except AdapterError as exc:
        return {
            "ok": False,
            "provider": "unknown",
            "status": "misconfigured",
            "detail": str(exc),
        }
    if not config.get("enabled") or config.get("provider") == "none":
        return {
            "ok": True,
            "provider": "none",
            "status": "disabled",
            "detail": "semantic memory is not enabled",
        }
    if config.get("provider") != "cognee":
        return {
            "ok": True,
            "provider": config.get("provider"),
            "status": "not-cognee",
            "detail": "this adapter only handles provider='cognee'",
        }
    try:
        snapshot = build_snapshot(root_path)
    except AdapterError as exc:
        return {
            "ok": False,
            "provider": "cognee",
            "status": "misconfigured",
            "detail": str(exc),
        }
    try:
        _import_cognee()
    except ImportError:
        return {
            "ok": True,
            "provider": "cognee",
            "status": "unavailable",
            "dataset": snapshot.dataset,
            "nodes": len(snapshot.nodes),
            "edges": len(snapshot.edges),
            "detail": "Cognee is not importable",
        }
    manifest = _manifest_path(root_path, config)
    stale = True
    if manifest.exists():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            stale = data.get("fingerprint") != snapshot.fingerprint
        except (OSError, json.JSONDecodeError):
            stale = True
    status = "stale" if stale else "healthy"
    return {
        "ok": True,
        "provider": "cognee",
        "status": status,
        "dataset": snapshot.dataset,
        "nodes": len(snapshot.nodes),
        "edges": len(snapshot.edges),
        "fingerprint": snapshot.fingerprint,
        "manifest": str(manifest),
        "detail": "Cognee import is available",
    }


def _json_default(value: Any) -> Any:
    if isinstance(value, (MemoryNode, MemoryEdge, RecallHit, MemorySnapshot)):
        return asdict(value)
    return str(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vivary-cognee",
        description="Optional Cognee adapter over Vivary typed graph nodes.",
    )
    parser.add_argument("--version", action="version", version=f"vivary-cognee {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor_cmd = sub.add_parser("doctor", help="report Cognee adapter readiness")
    doctor_cmd.add_argument("--root", default=".")
    doctor_cmd.add_argument("--json", action="store_true")

    index_cmd = sub.add_parser("index", help="index typed Vivary nodes into Cognee")
    index_cmd.add_argument("--root", default=".")
    index_cmd.add_argument("--dry-run", action="store_true")
    index_cmd.add_argument("--yes", action="store_true", help="approve provider writes")
    index_cmd.add_argument("--json", action="store_true")

    recall_cmd = sub.add_parser("recall", help="recall typed Vivary node candidates")
    recall_cmd.add_argument("query")
    recall_cmd.add_argument("--root", default=".")
    recall_cmd.add_argument("--k", type=int, default=10)
    recall_cmd.add_argument("--json", action="store_true")

    forget_cmd = sub.add_parser("forget", help="remove this workspace dataset from Cognee")
    forget_cmd.add_argument("--root", default=".")
    forget_cmd.add_argument("--yes", action="store_true", help="approve provider deletion")
    forget_cmd.add_argument("--json", action="store_true")
    return parser


def _print_or_json(payload: Any, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, default=_json_default))
        return
    if isinstance(payload, list):
        for item in payload:
            print(item)
        return
    for key, value in payload.items():
        print(f"{key}: {value}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "doctor":
            report = doctor(args.root)
            _print_or_json(report, as_json=args.json)
            return 0 if report.get("ok") else 1
        if args.command == "index":
            adapter = CogneeMemoryAdapter(args.root)
            report = asyncio.run(adapter.index(dry_run=args.dry_run, approved=args.yes))
            _print_or_json(report, as_json=args.json)
            return 0
        if args.command == "recall":
            adapter = CogneeMemoryAdapter(args.root)
            hits = asyncio.run(adapter.recall(args.query, k=args.k))
            payload = [asdict(hit) for hit in hits]
            _print_or_json(payload, as_json=args.json)
            return 0
        if args.command == "forget":
            adapter = CogneeMemoryAdapter(args.root)
            report = asyncio.run(adapter.forget(approved=args.yes))
            _print_or_json(report, as_json=args.json)
            return 0
    except AdapterError as exc:
        if getattr(args, "json", False):
            print(json.dumps({"ok": False, "error": str(exc)}))
        else:
            print(f"vivary-cognee: {exc}", file=sys.stderr)
        return 2
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
