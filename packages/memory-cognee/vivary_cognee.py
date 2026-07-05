"""Optional Cognee memory adapter for Vivary typed graph nodes.

The core contract is intentionally small: Cognee is a rebuildable recall sidecar,
while Tropo graph nodes remain the source of truth.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import importlib.util
import json
import os
import re
import sys
import tomllib
import types
from dataclasses import asdict, dataclass
from fnmatch import fnmatchcase
from pathlib import Path
from contextlib import contextmanager, redirect_stdout
from typing import Any


__version__ = "0.1.1"
TROPO_SEMANTIC_ADAPTER_API = 1
REQUIRES_EXPLICIT_PROVIDER_GATES = True
MAX_RECALL_K = 250

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
WORKSPACE_MARKERS = ("tropo.toml",)


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


def _pattern_matches(pattern: str, rel_path: str, base: str = "") -> bool:
    raw_pattern = str(pattern).replace("\\", "/").strip()
    dir_only = raw_pattern.endswith("/")
    pattern = _norm(raw_pattern)
    rel_path = _norm(rel_path)
    base = _norm(base)
    if base:
        if rel_path != base and not rel_path.startswith(base + "/"):
            return False
        rel_path = rel_path[len(base):].lstrip("/")
    if not pattern:
        return False
    if pattern.endswith("/**"):
        base = pattern[:-3]
        return rel_path == base or rel_path.startswith(base + "/")
    if dir_only:
        if "/" not in pattern:
            return any(fnmatchcase(part, pattern) for part in rel_path.split("/")[:-1])
        return rel_path == pattern or rel_path.startswith(pattern + "/")
    if "/" not in pattern:
        parts = rel_path.split("/")
        return fnmatchcase(Path(rel_path).name, pattern) or any(
            fnmatchcase(part, pattern) for part in parts[:-1]
        )
    return fnmatchcase(rel_path, pattern) or rel_path.startswith(pattern + "/")


def _gitignore_rules(root: Path) -> list[tuple[bool, str, str]]:
    rules: list[tuple[bool, str, str]] = []
    paths = sorted(
        root.rglob(".gitignore"),
        key=lambda path: (len(path.relative_to(root).parts), str(path.relative_to(root)).lower()),
    )
    for path in paths:
        try:
            resolved = path.resolve(strict=False)
        except OSError:
            continue
        if not _inside_root(root, resolved):
            continue
        base = _norm(path.parent.relative_to(root))
        if base == ".":
            base = ""
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            negated = line.startswith("!")
            pattern = line[1:] if negated else line
            if pattern:
                rules.append((negated, base, pattern))
    return rules


def _ignored_by_gitignore(rel_path: str, rules: list[tuple[bool, str, str]]) -> bool:
    ignored = False
    for negated, base, pattern in rules:
        if _pattern_matches(pattern, rel_path, base):
            ignored = not negated
    return ignored


def _resolve_workspace_root(target: str | Path) -> Path:
    raw = Path(target)
    if not raw.exists():
        raise AdapterError(f"target does not exist: {target}")
    path = raw.resolve()
    start = path if path.is_dir() else path.parent
    for candidate in (start, *start.parents):
        if any((candidate / marker).exists() for marker in WORKSPACE_MARKERS):
            return candidate
    return start


def _looks_like_workspace(root: Path) -> bool:
    return any((root / marker).exists() for marker in WORKSPACE_MARKERS)


def _toml_table(value: Any, name: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise AdapterError(f"{name} must be a TOML table")
    return dict(value)


def _toml_bool(table: dict[str, Any], key: str, default: bool, table_name: str) -> bool:
    if key not in table:
        return default
    value = table[key]
    if not isinstance(value, bool):
        raise AdapterError(f"{table_name}.{key} must be true or false")
    return value


def _toml_str(table: dict[str, Any], key: str, default: str, table_name: str) -> str:
    if key not in table:
        return default
    value = table[key]
    if not isinstance(value, str):
        raise AdapterError(f"{table_name}.{key} must be a string")
    return value


def _toml_str_list(
    table: dict[str, Any], key: str, default: list[str], table_name: str
) -> list[str]:
    if key not in table:
        return list(default)
    value = table[key]
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise AdapterError(f"{table_name}.{key} must be a list of strings")
    return list(value)


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
        data = tomllib.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise AdapterError(f"invalid {MEMORY_CONFIG}: {exc}") from exc
    memory = _toml_table(data.get("memory", {}), "memory")
    enabled = _toml_bool(memory, "enabled", False, "memory")
    provider = _toml_str(memory, "provider", "none", "memory")
    mode = _toml_str(memory, "mode", "none", "memory")
    privacy = _toml_table(memory.get("privacy", {}), "memory.privacy")
    cognee = _toml_table(memory.get("cognee", {}), "memory.cognee")
    privacy.update(
        {
            "respect_gitignore": _toml_bool(
                privacy, "respect_gitignore", True, "memory.privacy"
            ),
            "respect_vivary_private": _toml_bool(
                privacy, "respect_vivary_private", True, "memory.privacy"
            ),
            "fail_closed": _toml_bool(privacy, "fail_closed", True, "memory.privacy"),
            "private_paths": _toml_str_list(
                privacy, "private_paths", [], "memory.privacy"
            ),
        }
    )
    cognee.update(
        {
            "state_path": _toml_str(
                cognee, "state_path", ".vivary/memory/cognee", "memory.cognee"
            ),
            "allow_network": _toml_bool(cognee, "allow_network", False, "memory.cognee"),
            "require_explicit_index": _toml_bool(
                cognee, "require_explicit_index", True, "memory.cognee"
            ),
            "api_key_env": _toml_str(cognee, "api_key_env", "", "memory.cognee"),
            "allow_without_api_key": _toml_bool(
                cognee, "allow_without_api_key", False, "memory.cognee"
            ),
            "allow_telemetry": _toml_bool(
                cognee, "allow_telemetry", False, "memory.cognee"
            ),
            "dataset": _toml_str(cognee, "dataset", "", "memory.cognee"),
        }
    )
    return {
        "enabled": enabled,
        "provider": provider,
        "mode": mode,
        "privacy": privacy,
        "cognee": cognee,
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
    gitignore_rules: list[tuple[bool, str, str]],
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


def _cognee_available() -> bool:
    return importlib.util.find_spec("cognee") is not None


@contextmanager
def _without_dotenv_autoload():
    dotenv = sys.modules.get("dotenv")
    if dotenv is None:
        stub = types.ModuleType("dotenv")
        stub.load_dotenv = lambda *args, **kwargs: False
        stub.dotenv_values = lambda *args, **kwargs: {}
        stub.find_dotenv = lambda *args, **kwargs: ""
        sys.modules["dotenv"] = stub
        try:
            yield
        finally:
            if sys.modules.get("dotenv") is stub:
                sys.modules.pop("dotenv", None)
        return
    original = getattr(dotenv, "load_dotenv", None)
    if original is None:
        yield
        return
    dotenv.load_dotenv = lambda *args, **kwargs: False
    try:
        yield
    finally:
        dotenv.load_dotenv = original


def _load_cognee_module():
    with redirect_stdout(sys.stderr), _without_dotenv_autoload():
        return _import_cognee()


def _clear_cognee_config_caches() -> None:
    cache_functions = {
        "cognee.base_config": ("get_base_config",),
        "cognee.infrastructure.databases.graph.config": ("get_graph_config",),
        "cognee.infrastructure.databases.vector.config": ("get_vectordb_config",),
        "cognee.infrastructure.llm.config": ("get_llm_config",),
    }
    for module_name, function_names in cache_functions.items():
        module = sys.modules.get(module_name)
        if module is None:
            continue
        for function_name in function_names:
            cache_clear = getattr(getattr(module, function_name, None), "cache_clear", None)
            if callable(cache_clear):
                cache_clear()


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


def _inside_root(root: Path, path: Path) -> bool:
    try:
        return os.path.commonpath([str(root), str(path)]) == str(root)
    except ValueError:
        return False


def _resolve_public_file(root: Path, full_path: str | Path, rel_path: str) -> Path:
    raw = Path(full_path)
    if os.path.normcase(os.path.realpath(raw)) != os.path.normcase(os.path.abspath(raw)):
        raise AdapterError(f"semantic memory refuses linked file: {rel_path}")
    resolved = raw.resolve(strict=False)
    if not _inside_root(root, resolved):
        raise AdapterError(f"semantic memory refuses out-of-root file: {rel_path}")
    try:
        if os.stat(resolved).st_nlink > 1:
            raise AdapterError(f"semantic memory refuses hard-linked file: {rel_path}")
    except OSError as exc:
        raise AdapterError(f"semantic memory cannot stat file: {rel_path}") from exc
    return resolved


def _dataset_name(root: Path, config: dict[str, Any]) -> str:
    configured = config.get("cognee", {}).get("dataset")
    base = _slug(str(configured or root.name))
    digest = hashlib.sha256(str(root.resolve()).encode("utf-8")).hexdigest()[:12]
    return f"vivary-{base}-{digest}"


def build_snapshot(root: str | Path) -> MemorySnapshot:
    """Build privacy-filtered typed node packets from the Tropo graph."""
    root_path = Path(root).resolve()
    config = _load_memory_config(root_path)
    privacy = config.get("privacy", {})
    patterns = _privacy_patterns(config)
    gitignore_rules = _gitignore_rules(root_path)
    respect_gitignore = privacy.get("respect_gitignore", True)

    try:
        tropo = _import_tropo()
        resolver = tropo.ConfigResolver(str(root_path), str(Path(tropo.__file__).parent))
        docs = tropo.analyze(str(root_path), [], resolver)
        graph_nodes, graph_edges = tropo.build_graph(docs)
    except Exception as exc:
        raise AdapterError(f"failed to build Tropo graph: {exc}") from exc

    public_ids: set[str] = set()
    by_id: dict[str, Any] = {}
    safe_full_paths: dict[str, Path] = {}
    for doc in docs:
        node_id = doc.derived.get("id")
        rel_path = _norm(doc.rel)
        if not node_id:
            continue
        safe_full = _resolve_public_file(root_path, doc.full, rel_path)
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
        safe_full_paths.setdefault(node_id, safe_full)

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
        body = _read_body(tropo, safe_full_paths[node_id])
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


def _cognee_state_root(root: Path, config: dict[str, Any]) -> Path:
    state_path = str(config.get("cognee", {}).get("state_path") or ".vivary/memory/cognee")
    root = root.resolve()
    path = (root / state_path).resolve(strict=False)
    if not _inside_root(root, path):
        raise AdapterError("memory.cognee.state_path must stay inside the workspace")
    return path


def _configure_cognee_environment(root: Path, config: dict[str, Any]) -> None:
    state_root = _cognee_state_root(root, config)
    cognee = config.get("cognee", {})
    env_paths = {
        "DATA_ROOT_DIRECTORY": state_root / "data",
        "SYSTEM_ROOT_DIRECTORY": state_root / "system",
        "CACHE_ROOT_DIRECTORY": state_root / "cache",
        "COGNEE_LOGS_DIR": state_root / "logs",
        "LOGS_ROOT_DIRECTORY": state_root / "logs",
    }
    for key, path in env_paths.items():
        os.environ[key] = str(path)
    if not bool(cognee.get("allow_telemetry", False)):
        os.environ["COGNEE_TRACING_ENABLED"] = "false"
        os.environ["TELEMETRY_DISABLED"] = "1"
    else:
        os.environ.setdefault("COGNEE_TRACING_ENABLED", "false")


def _manifest_path(root: Path, config: dict[str, Any]) -> Path:
    path = _cognee_state_root(root, config) / "manifest.json"
    return path


def _manifest_payload(snapshot: MemorySnapshot) -> dict[str, Any]:
    return {
        "provider": "cognee",
        "dataset": snapshot.dataset,
        "fingerprint": snapshot.fingerprint,
        "nodes": len(snapshot.nodes),
        "edges": len(snapshot.edges),
    }


def _manifest_matches(data: dict[str, Any], snapshot: MemorySnapshot) -> bool:
    expected = _manifest_payload(snapshot)
    return all(data.get(key) == value for key, value in expected.items())


def _preflight_manifest_path(root: Path, config: dict[str, Any]) -> Path:
    path = _manifest_path(root, config)
    if path.parent.exists():
        real_parent = os.path.realpath(path.parent)
        absolute_parent = os.path.abspath(path.parent)
        if os.path.normcase(real_parent) != os.path.normcase(absolute_parent):
            raise AdapterError("refusing linked Cognee manifest parent")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() or os.path.islink(path):
        real = os.path.realpath(path)
        absolute = os.path.abspath(path)
        if os.path.normcase(real) != os.path.normcase(absolute):
            raise AdapterError("refusing to overwrite linked Cognee manifest")
        try:
            if os.stat(path).st_nlink > 1:
                raise AdapterError("refusing to overwrite hard-linked Cognee manifest")
        except OSError as exc:
            raise AdapterError("cannot stat Cognee manifest") from exc
    return path


def _write_manifest(root: Path, config: dict[str, Any], snapshot: MemorySnapshot) -> Path:
    path = _preflight_manifest_path(root, config)
    payload = _manifest_payload(snapshot)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def _manifest_is_current(root: Path, config: dict[str, Any], snapshot: MemorySnapshot) -> bool:
    manifest = _manifest_path(root, config)
    if not manifest.exists():
        return False
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return _manifest_matches(data, snapshot)


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


async def _run_provider_call(call: Any, *args: Any, **kwargs: Any) -> Any:
    with redirect_stdout(sys.stderr):
        return await _maybe_await(call(*args, **kwargs))


def _is_missing_dataset_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "dataset" in message and "not found" in message


def _provider_failure(action: str, exc: Exception) -> AdapterError:
    return AdapterError(f"Cognee {action} failed ({exc.__class__.__name__})")


def _normalize_recall_k(k: int) -> int:
    if k < 1:
        raise AdapterError("recall --k must be at least 1")
    return min(k, MAX_RECALL_K)


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
        self.root = _resolve_workspace_root(root)
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
        _configure_cognee_environment(self.root, self.config)
        try:
            self._cognee_client = _load_cognee_module()
        except ImportError as exc:
            raise AdapterError(
                "Cognee runtime dependency is not installed; reinstall "
                "vivary-memory-cognee with dependencies or install cognee"
            ) from exc
        _configure_cognee_environment(self.root, self.config)
        _clear_cognee_config_caches()
        return self._cognee_client

    def _require_provider_runtime(self, action: str) -> None:
        cognee = self.config.get("cognee", {})
        if not cognee.get("allow_network", False):
            raise AdapterError(
                f"{action} requires memory.cognee.allow_network = true because Cognee "
                "may call embedding or LLM providers"
            )
        api_key_env = str(cognee.get("api_key_env") or "").strip()
        allow_without_api_key = bool(cognee.get("allow_without_api_key", False))
        if not api_key_env and not allow_without_api_key:
            raise AdapterError(
                f"{action} requires memory.cognee.api_key_env or "
                "memory.cognee.allow_without_api_key = true"
            )
        if api_key_env and not os.environ.get(api_key_env):
            raise AdapterError(f"{action} requires environment variable {api_key_env}")

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

        _preflight_manifest_path(self.root, self.config)
        self._require_provider_runtime("indexing provider memory")
        client = self._client()
        forget = getattr(client, "forget", None)
        if forget is None:
            raise AdapterError("installed Cognee package has no forget() API")
        try:
            await _run_provider_call(forget, dataset=snapshot.dataset, memory_only=False)
        except Exception as exc:
            if not _is_missing_dataset_error(exc):
                raise _provider_failure("forget() before re-index", exc) from exc
        for node in snapshot.nodes:
            remember = getattr(client, "remember", None)
            if remember is None:
                raise AdapterError("installed Cognee package has no remember() API")
            try:
                await _run_provider_call(remember, node.text, dataset_name=snapshot.dataset)
            except Exception as exc:
                raise _provider_failure("remember()", exc) from exc
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
        k = _normalize_recall_k(k)
        snapshot = build_snapshot(self.root)
        by_id = {node.id: node for node in snapshot.nodes}
        edges_by_source: dict[str, list[MemoryEdge]] = {}
        for edge in snapshot.edges:
            edges_by_source.setdefault(edge.source_id, []).append(edge)

        self._require_provider_runtime("recalling provider memory")
        if not _manifest_is_current(self.root, self.config, snapshot):
            raise AdapterError("Cognee index is stale; run vivary-cognee index --yes")
        client = self._client()
        recall = getattr(client, "recall", None)
        if recall is None:
            raise AdapterError("installed Cognee package has no recall() API")
        try:
            raw_items = await _run_provider_call(recall, query, datasets=[snapshot.dataset], top_k=k)
        except Exception as exc:
            raise _provider_failure("recall()", exc) from exc

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
        self._require_provider_runtime("forgetting provider memory")
        client = self._client()
        forget = getattr(client, "forget", None)
        if forget is None:
            raise AdapterError("installed Cognee package has no forget() API")
        try:
            result = await _run_provider_call(forget, dataset=self.dataset, memory_only=False)
        except Exception as exc:
            if not _is_missing_dataset_error(exc):
                raise _provider_failure("forget()", exc) from exc
            result = {"status": "missing", "dataset": self.dataset}
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
    try:
        root_path = _resolve_workspace_root(root)
    except AdapterError as exc:
        return {
            "ok": False,
            "provider": "unknown",
            "status": "misconfigured",
            "detail": str(exc),
        }
    if not _looks_like_workspace(root_path):
        return {
            "ok": False,
            "provider": "unknown",
            "status": "misconfigured",
            "detail": "target is not a Vivary workspace",
        }
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
    if not _cognee_available():
        return {
            "ok": True,
            "provider": "cognee",
            "status": "unavailable",
            "dataset": snapshot.dataset,
            "nodes": len(snapshot.nodes),
            "edges": len(snapshot.edges),
            "detail": "Cognee package is not installed",
        }
    try:
        manifest = _manifest_path(root_path, config)
    except AdapterError as exc:
        return {
            "ok": False,
            "provider": "cognee",
            "status": "misconfigured",
            "dataset": snapshot.dataset,
            "nodes": len(snapshot.nodes),
            "edges": len(snapshot.edges),
            "detail": str(exc),
        }
    stale = True
    if manifest.exists():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            stale = not _manifest_matches(data, snapshot)
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
        "detail": "Cognee package is installed",
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
