#!/usr/bin/env python3
"""Validate the bounded product source-navigation graph."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import stat
from collections import Counter
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCE_MAP = REPOSITORY_ROOT / "docs" / "product" / "multi-project" / "source-map"
TROPO_PATH = REPOSITORY_ROOT / "packages" / "tropo" / "tropo.py"

EXPECTED_NODES = {
    "source-map": (None, "index.md"),
    "root-observation": ("module", "modules/root-observation/index.md"),
    "project-registry": ("module", "modules/project-registry/index.md"),
    "native-runtime": ("module", "modules/native-runtime/index.md"),
    "project-writeback": ("module", "modules/project-writeback/index.md"),
    "program-execution": ("source_reference", "sources/program-execution.md"),
    "root-observation-contract": ("source_reference", "sources/root-observation-contract.md"),
    "registry-contract": ("source_reference", "sources/registry-contract.md"),
    "registry-transactions": ("source_reference", "sources/registry-transactions.md"),
    "native-owners": ("source_reference", "sources/native-owners.md"),
    "checkout-observer-code": ("source_reference", "sources/checkout-observer-code.md"),
    "checkout-observer-tests": ("source_reference", "sources/checkout-observer-tests.md"),
    "registry-model-code": ("source_reference", "sources/registry-model-code.md"),
    "registry-model-tests": ("source_reference", "sources/registry-model-tests.md"),
    "observation-receipt": ("source_reference", "sources/observation-receipt.md"),
    "registry-receipt": ("source_reference", "sources/registry-receipt.md"),
}

EXPECTED_EDGES = {
    ("source-map", "module_refs", "root-observation"),
    ("source-map", "module_refs", "project-registry"),
    ("source-map", "module_refs", "native-runtime"),
    ("source-map", "module_refs", "project-writeback"),
    ("root-observation", "contract_refs", "root-observation-contract"),
    ("root-observation", "source_refs", "checkout-observer-code"),
    ("root-observation", "test_refs", "checkout-observer-tests"),
    ("root-observation", "evidence_refs", "observation-receipt"),
    ("project-registry", "contract_refs", "registry-contract"),
    ("project-registry", "contract_refs", "registry-transactions"),
    ("project-registry", "source_refs", "registry-model-code"),
    ("project-registry", "test_refs", "registry-model-tests"),
    ("project-registry", "evidence_refs", "registry-receipt"),
    ("project-registry", "module_refs", "root-observation"),
    ("native-runtime", "source_refs", "program-execution"),
    ("native-runtime", "source_refs", "native-owners"),
    ("native-runtime", "module_refs", "project-registry"),
    ("project-writeback", "source_refs", "registry-contract"),
    ("project-writeback", "source_refs", "native-owners"),
    ("project-writeback", "source_refs", "registry-receipt"),
    ("project-writeback", "module_refs", "root-observation"),
    ("project-writeback", "module_refs", "project-registry"),
    ("project-writeback", "module_refs", "native-runtime"),
}

EXPECTED_TREE = {
    "tropo.toml": "file",
    "index.md": "file",
    "modules": "directory",
    "modules/root-observation": "directory",
    "modules/project-registry": "directory",
    "modules/native-runtime": "directory",
    "modules/project-writeback": "directory",
    "sources": "directory",
    **{path: "file" for _record_type, path in EXPECTED_NODES.values()},
}


class NavigationError(RuntimeError):
    """The bounded source-navigation contract is invalid."""


def _load_tropo():
    spec = importlib.util.spec_from_file_location("vivary_source_navigation_tropo", TROPO_PATH)
    if spec is None or spec.loader is None:
        raise NavigationError(f"could not load Tropo: {TROPO_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TROPO = _load_tropo()


def analyze_source_map(source_map: Path):
    """Analyze one source-map tree through the repository's installed Tropo."""
    source_map = source_map.resolve()
    resolver = TROPO.ConfigResolver(str(source_map), str(TROPO_PATH.parent))
    return TROPO.analyze(str(source_map), [], resolver)


def _is_linked_directory(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = path.lstat().st_file_attributes
    except (AttributeError, OSError):
        return False
    reparse_point = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return bool(attributes & reparse_point)


def _validate_tree_inventory(source_map: Path) -> None:
    if _is_linked_directory(source_map) or not source_map.is_dir():
        raise NavigationError("source-map root must be a real directory")

    actual: dict[str, str] = {}
    pending = [source_map]
    try:
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    path = Path(entry.path)
                    relative = path.relative_to(source_map).as_posix()
                    if _is_linked_directory(path) or entry.is_symlink():
                        actual[relative] = "symlink"
                    elif entry.is_dir(follow_symlinks=False):
                        actual[relative] = "directory"
                        pending.append(path)
                    elif entry.is_file(follow_symlinks=False):
                        actual[relative] = "file"
                    else:
                        actual[relative] = "other"
    except OSError as exc:
        raise NavigationError(f"could not inventory source-map tree: {exc}") from exc

    if actual != EXPECTED_TREE:
        markdown_ids = [
            TROPO._derive_id(str(source_map.joinpath(*path.split("/"))))
            for path, kind in actual.items()
            if kind == "file" and path.lower().endswith((".md", ".markdown"))
        ]
        duplicate_ids = sorted(
            record_id for record_id, count in Counter(markdown_ids).items() if count > 1
        )
        if duplicate_ids:
            raise NavigationError(f"duplicate document id {duplicate_ids[0]!r}")
        missing = sorted(set(EXPECTED_TREE) - set(actual))
        extra = sorted(set(actual) - set(EXPECTED_TREE))
        mismatched = sorted(
            path for path in set(actual) & set(EXPECTED_TREE)
            if actual[path] != EXPECTED_TREE[path]
        )
        raise NavigationError(
            f"source-map tree inventory mismatch: missing={missing}, "
            f"extra={extra}, mismatched={mismatched}"
        )


def _locator_target(
    repository: Path,
    source_map: Path,
    record_id: str,
    locator: object,
) -> tuple[str, Path]:
    if not isinstance(locator, str) or not locator.strip():
        raise NavigationError(f"{record_id}: locator must be a non-empty string")
    if locator != locator.strip() or "\\" in locator:
        raise NavigationError(f"{record_id}: locator must use canonical forward-slash form")
    if locator.startswith(("/", "//")) or re.match(r"^[A-Za-z]:", locator):
        raise NavigationError(f"{record_id}: locator must be repository-relative")

    parts = locator.split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise NavigationError(f"{record_id}: locator must not contain empty, dot, or parent segments")

    repository_real = repository.resolve()
    target = repository_real.joinpath(*parts)
    try:
        target_real = target.resolve(strict=True)
    except FileNotFoundError as exc:
        raise NavigationError(
            f"{record_id}: locator target is not an existing file: {locator}"
        ) from exc
    except (OSError, RuntimeError) as exc:
        raise NavigationError(f"{record_id}: could not resolve locator target: {exc}") from exc
    try:
        target_real.relative_to(repository_real)
    except ValueError as exc:
        raise NavigationError(f"{record_id}: locator escapes repository root") from exc
    try:
        target_real.relative_to(source_map)
    except ValueError:
        pass
    else:
        raise NavigationError(f"{record_id}: locator target is inside source-map root")
    if not target_real.is_file():
        raise NavigationError(f"{record_id}: locator target is not an existing file: {locator}")
    return locator, target_real


def validate_source_navigation(repository: Path, source_map: Path) -> dict[str, object]:
    """Validate identities, typed edges, and external source locators."""
    repository = repository.resolve()
    if _is_linked_directory(source_map) or not source_map.is_dir():
        raise NavigationError("source-map root must be a real directory")
    source_map = source_map.resolve()
    try:
        source_map.relative_to(repository)
    except ValueError as exc:
        raise NavigationError("source-map root escapes repository root") from exc
    _validate_tree_inventory(source_map)
    docs = analyze_source_map(source_map)

    ids = [doc.derived.get("id") for doc in docs]
    duplicates = sorted(record_id for record_id, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise NavigationError(f"duplicate document id {duplicates[0]!r}")

    nodes, edges = TROPO.build_graph(docs)
    broken = [edge for edge in edges if edge["broken"]]
    if broken:
        raise NavigationError(f"broken reference: {broken[0]}")

    findings = [finding for doc in docs for finding in doc.findings]
    if findings:
        raise NavigationError("Tropo finding: " + findings[0].render())

    actual_nodes = {
        record_id: (node["type"], node["path"])
        for record_id, node in nodes.items()
    }
    if len(docs) != len(EXPECTED_NODES):
        raise NavigationError(
            f"selected document count is {len(docs)}; expected {len(EXPECTED_NODES)}"
        )
    if actual_nodes != EXPECTED_NODES:
        missing = sorted(set(EXPECTED_NODES) - set(actual_nodes))
        extra = sorted(set(actual_nodes) - set(EXPECTED_NODES))
        mismatched = sorted(
            record_id for record_id in set(actual_nodes) & set(EXPECTED_NODES)
            if actual_nodes[record_id] != EXPECTED_NODES[record_id]
        )
        raise NavigationError(
            f"node identity mismatch: missing={missing}, extra={extra}, mismatched={mismatched}"
        )

    edge_tuples = [(edge["from"], edge["field"], edge["to"]) for edge in edges]
    duplicate_edges = sorted(edge for edge, count in Counter(edge_tuples).items() if count > 1)
    if duplicate_edges:
        raise NavigationError(f"duplicate typed edge: {duplicate_edges[0]}")
    actual_edges = set(edge_tuples)
    if actual_edges != EXPECTED_EDGES:
        raise NavigationError(
            "typed edge mismatch: "
            f"missing={sorted(EXPECTED_EDGES - actual_edges)}, "
            f"extra={sorted(actual_edges - EXPECTED_EDGES)}"
        )

    locators: dict[str, str] = {}
    for doc in docs:
        if doc.type != "source_reference":
            continue
        record_id = doc.derived["id"]
        locator, _target = _locator_target(
            repository,
            source_map,
            record_id,
            doc.fields.get("locator"),
        )
        locators[record_id] = locator
    if set(locators) != {key for key, value in EXPECTED_NODES.items() if value[0] == "source_reference"}:
        raise NavigationError("source-reference locator set does not match the selected records")

    return {
        "record_count": len(docs),
        "nodes": nodes,
        "edges": edges,
        "broken_edge_count": len(broken),
        "locators": dict(sorted(locators.items())),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the canonical source map")
    args = parser.parse_args()
    if not args.check:
        parser.error("--check is required")
    try:
        result = validate_source_navigation(REPOSITORY_ROOT, SOURCE_MAP)
    except (NavigationError, TROPO.ConfigError) as exc:
        print(f"source navigation: FAILED: {exc}")
        return 1
    print(json.dumps({
        "status": "clean",
        "records": result["record_count"],
        "edges": len(result["edges"]),
        "locators": len(result["locators"]),
        "broken": result["broken_edge_count"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
