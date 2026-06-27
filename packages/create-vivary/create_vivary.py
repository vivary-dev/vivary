"""create-vivary: scaffold a complete Vivary agent workspace."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from fnmatch import fnmatchcase
from pathlib import Path


__version__ = "0.2.7"

PRESETS = ("coding", "second-brain", "knowledge-work", "writing")

ACTIVE_CONTEXTS = ("cocoindex-code",)

MEMORY_MODES = ("none", "local", "cognee")

SUBCOMMANDS = ("init", "doctor", "wizard", "capabilities")

REQUIRED_WORKSPACE_FILES = (
    "README.md",
    "AGENTS.md",
    "SOUL.md",
    "STRATO.md",
    "STATE.md",
    "USER.md",
    "MEMORY.md",
    "bug-risk-playbook.md",
    "tropo.toml",
    ".gitignore",
    "modules/index.md",
    "modules/agent-workspace/index.md",
    "templates/AGENTS.md",
    ".claude/skills/strato/SKILL.md",
    ".claude/skills/loops/SKILL.md",
    ".agents/skills/strato/SKILL.md",
    ".agents/skills/loops/SKILL.md",
)

PRESET_STARTERS = {
    "coding": {
        "module_id": "codebase",
        "module_title": "Codebase",
        "module_area": "software project",
        "module_body": "Code, docs, tests, and release gates for a software workspace.",
        "change_id": "local-ci-baseline",
        "change_title": "Local CI Baseline",
        "change_slice": "local verification baseline",
        "change_body": "Define the local checks that stand in for remote CI while the project is early.",
        "verification_id": "local-checks",
        "verification_title": "Local Checks",
        "verification_target": "local-ci-baseline",
        "verification_command": "run the project-local tests and build",
        "verification_body": "Run the checks that prove a code slice is ready to review.",
    },
    "second-brain": {
        "module_id": "knowledge-base",
        "module_title": "Knowledge Base",
        "module_area": "personal knowledge system",
        "module_body": "Captured notes, sources, decisions, and retrieval paths for a thinking workspace.",
        "change_id": "capture-routine",
        "change_title": "Capture Routine",
        "change_slice": "knowledge capture loop",
        "change_body": "Start with one reliable path for capture, triage, retrieval, and promotion.",
        "verification_id": "retrieval-smoke",
        "verification_title": "Retrieval Smoke",
        "verification_target": "capture-routine",
        "verification_command": "retrieve one known note from the typed graph",
        "verification_body": "Prove the workspace can find a saved note and its related context.",
    },
    "knowledge-work": {
        "module_id": "workbench",
        "module_title": "Knowledge Workbench",
        "module_area": "research, decisions, artifacts, and proof",
        "module_body": "A routed workbench for sources, decisions, artifacts, verification, and publish-ready proof.",
        "change_id": "workbench-first-artifact",
        "change_title": "Workbench First Artifact",
        "change_slice": "first proof-backed knowledge artifact",
        "change_body": "Produce or locate one useful artifact, link its sources, and verify the proof path that makes it trustworthy.",
        "verification_id": "workbench-proof",
        "verification_title": "Workbench Proof",
        "verification_target": "workbench-first-artifact",
        "verification_command": "verify one artifact against its linked sources and local proof gate",
        "verification_body": "Prove the workbench can route from source material to a durable artifact with inspectable evidence.",
    },
    "writing": {
        "module_id": "manuscript-system",
        "module_title": "Manuscript System",
        "module_area": "writing project",
        "module_body": "Drafts, research, editorial passes, and publication gates for a writing workspace.",
        "change_id": "draft-review-loop",
        "change_title": "Draft Review Loop",
        "change_slice": "draft to review workflow",
        "change_body": "Set up the first repeatable loop from draft to critique to revision.",
        "verification_id": "editorial-review",
        "verification_title": "Editorial Review",
        "verification_target": "draft-review-loop",
        "verification_command": "review one draft against the workspace editorial criteria",
        "verification_body": "Prove a draft can move through review with evidence and next actions.",
    },
}


class ScaffoldError(RuntimeError):
    """Raised when a workspace cannot be scaffolded safely."""


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _resolve_scaffold_target(target: str | Path) -> Path:
    requested = Path(target)
    absolute = requested if requested.is_absolute() else Path.cwd() / requested
    current = Path(absolute.anchor) if absolute.anchor else Path()
    parts = absolute.parts[1:] if absolute.anchor else absolute.parts
    for part in parts:
        current = current / part
        if current.exists() or current.is_symlink():
            if current.is_symlink():
                raise ScaffoldError(
                    "refusing to scaffold through symlinked target path: "
                    f"{current}"
                )
        else:
            break
    return absolute.resolve(strict=False)


def scaffold_workspace(
    target: str | Path,
    *,
    preset: str = "coding",
    force: bool = False,
    obsidian: bool = False,
    active_context: str | None = None,
    repo_root: str | Path | None = None,
    storage: str = "file",
    provider: str = "lancedb",
    memory: str = "none",
    dry_run: bool = False,
) -> list[Path]:
    """Lay down a full Vivary workspace scaffold.

    The scaffold is intentionally source-controlled and static: it copies the strato
    contract, runtime skills, workspace files, and a small tropo graph seed into the
    target directory. It does not install dependencies, initialize git, or contact a
    remote service.
    """
    if preset not in PRESETS:
        raise ScaffoldError(f"unknown preset {preset!r}; expected one of {', '.join(PRESETS)}")
    if active_context is not None:
        if active_context not in ACTIVE_CONTEXTS:
            raise ScaffoldError(
                f"unknown active context {active_context!r}; expected one of "
                f"{', '.join(ACTIVE_CONTEXTS)}"
            )
        if active_context == "cocoindex-code" and preset != "coding":
            raise ScaffoldError(
                "active context 'cocoindex-code' currently requires the coding preset"
            )
    if memory not in MEMORY_MODES:
        raise ScaffoldError(f"unknown memory mode {memory!r}; expected one of {', '.join(MEMORY_MODES)}")

    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target = _resolve_scaffold_target(target)

    sources = _source_paths(root)
    for label, src in sources.items():
        if not src.exists():
            raise ScaffoldError(f"missing scaffold source for {label}: {src}")

    project = target.name or "vivary-workspace"
    today = date.today().isoformat()

    preserve_cocoindex_ignore = (
        active_context != "cocoindex-code"
        and force
        and (target / ".cocoindex_code").exists()
    )

    writes: list[tuple[Path, str]] = [
        (target / "README.md", _workspace_readme(project, preset, active_context, memory)),
        (
            target / ".gitignore",
            _workspace_gitignore(
                active_context,
                preserve_cocoindex_ignore=preserve_cocoindex_ignore,
            ),
        ),
        (target / "tropo.toml", _workspace_tropo_config()),
        (
            target / "modules" / "index.md",
            _modules_index_doc(
                project,
                PRESET_STARTERS[preset],
                active_context,
                preset=preset,
                memory=memory,
            ),
        ),
        (_module_index_path(target, "agent-workspace"), _module_doc(project)),
        (target / "changes" / "scaffold-init.md", _change_doc(project)),
        (target / "decisions" / "0001-vivary-baseline.md", _decision_doc(project, today)),
        (target / "verification" / "scaffold-smoke.md", _verification_doc(project)),
        (target / "gates" / "human-gates.md", _gate_doc(project)),
        (target / "memory" / ".gitkeep", ""),
        (target / "heartbeat-reports" / ".gitkeep", ""),
    ]
    writes.extend(_preset_writes(target, project, PRESET_STARTERS[preset]))
    if preset == "knowledge-work":
        writes.extend(_knowledge_work_writes(target, project))
    if active_context == "cocoindex-code":
        writes.extend(_cocoindex_active_context_writes(target, project))
    if memory != "none":
        writes.extend(_semantic_memory_writes(target, project, memory))
    if obsidian:
        writes.extend(_obsidian_writes(target))

    copies = _copy_plan(target, sources, active_context=active_context)
    planned_paths = [p for p, _ in writes] + [dst for _, dst in copies]
    if storage != "file":
        planned_paths.append(target / _STORAGE_DIR / _STORAGE_CONFIG_NAME)
    if memory != "none":
        planned_paths.append(target / _STORAGE_DIR / _MEMORY_CONFIG_NAME)
    _ensure_safe_destinations(target, planned_paths, force)
    cleanup_paths = _stale_scaffold_paths(target, active_context, memory) if force and not dry_run else []
    _ensure_safe_cleanup_targets(target, cleanup_paths)
    if force and not dry_run:
        _cleanup_stale_scaffold_state(target, active_context=active_context, memory=memory)

    created: list[Path] = []
    if not dry_run:
        for dst, text in writes:
            _write_text_no_follow(target, dst, text)
            created.append(dst)

        for src, dst in copies:
            _copy_file_no_follow(target, src, dst)
            created.append(dst)
    else:
        created = [dst for dst, _ in writes] + [dst for _, dst in copies]

    if storage != "file":
        created.extend(_write_vivary_dir(target, storage, provider, dry_run, force=force))
    if memory != "none":
        created.extend(_write_memory_config(target, memory, dry_run, force=force))

    return created


def doctor_workspace(target: str | Path, *, repo_root: str | Path | None = None) -> dict:
    """Validate that a directory looks like a usable Vivary agent workspace."""
    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target = Path(target).resolve()
    errors: list[str] = []
    warnings: list[str] = []

    if not target.exists():
        errors.append(f"workspace does not exist: {target}")
    elif not target.is_dir():
        errors.append(f"workspace is not a directory: {target}")

    if not errors:
        for rel in REQUIRED_WORKSPACE_FILES:
            if not (target / rel).exists():
                errors.append(f"missing required file: {rel}")

        if (target / ".gitignore").exists():
            missing = _missing_privacy_ignores(target)
            errors.extend(f"privacy ignore missing: {pattern}" for pattern in missing)
        errors.extend(_module_index_errors(target))

    graph = {"nodes": 0, "edges": 0, "broken": 0}
    findings: list[str] = []
    if not errors:
        try:
            tropo = _load_tropo(root)
            resolver = tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
            docs = tropo.analyze(str(target), [], resolver)
            findings = [f.render() for doc in docs for f in doc.findings]
            nodes, edges = tropo.build_graph(docs)
            graph = {
                "nodes": len(nodes),
                "edges": len(edges),
                "broken": sum(1 for edge in edges if edge["broken"]),
            }
            if findings:
                errors.extend(f"tropo finding: {finding}" for finding in findings)
            if graph["broken"]:
                errors.append(f"graph has {graph['broken']} broken edge(s)")
            if graph["nodes"] == 0:
                warnings.append("typed graph has no nodes")
        except Exception as exc:  # keep doctor a report, not a traceback
            errors.append(f"tropo validation failed: {exc}")

    # Check storage backend
    storage_cfg_path = target / _STORAGE_DIR / _STORAGE_CONFIG_NAME
    backend_name = "file"
    if storage_cfg_path.exists():
        try:
            import tomllib as _toml
            with open(storage_cfg_path, "rb") as _fh:
                _data = _toml.load(_fh)
            backend_name = _data.get("storage", {}).get("backend", "file")
        except Exception:
            backend_name = "unknown"

    memory_report = _memory_report(target)
    if memory_report["status"] == "misconfigured":
        errors.append(f"semantic memory misconfigured: {memory_report['detail']}")
    elif memory_report["status"] == "privacy-failed":
        errors.append("semantic memory privacy check failed")
    elif memory_report["status"] == "unavailable":
        warnings.append(f"semantic memory provider unavailable: {memory_report['provider']}")

    return {
        "ok": not errors,
        "root": str(target),
        "errors": errors,
        "warnings": warnings,
        "graph": graph,
        "backend": backend_name,
        "memory": memory_report,
    }


def _memory_report(target: Path) -> dict:
    cfg_path = target / _STORAGE_DIR / _MEMORY_CONFIG_NAME
    if not cfg_path.exists():
        return {
            "enabled": False,
            "provider": "none",
            "mode": "none",
            "status": "disabled",
            "config": None,
            "privacy": "not-indexed",
            "detail": "",
        }

    try:
        import tomllib as _toml
        with open(cfg_path, "rb") as _fh:
            data = _toml.load(_fh)
    except Exception as exc:
        return {
            "enabled": False,
            "provider": "unknown",
            "mode": "unknown",
            "status": "misconfigured",
            "config": str(cfg_path),
            "privacy": "unknown",
            "detail": str(exc),
        }

    memory = data.get("memory", {})
    enabled = bool(memory.get("enabled", False))
    provider = str(memory.get("provider", "none"))
    mode = str(memory.get("mode", "none"))

    if not enabled or provider == "none":
        status = "disabled"
        detail = ""
    elif _missing_privacy_ignores(target):
        status = "privacy-failed"
        detail = "private workspace paths are not actively ignored"
    elif provider == "vivary-local":
        status = "healthy"
        detail = "local semantic memory policy configured"
    elif provider == "cognee":
        if _is_importable("cognee"):
            status = "configured"
            detail = "Cognee import is available; indexing still requires approval"
        else:
            status = "unavailable"
            detail = "install optional Cognee support before indexing"
    else:
        status = "misconfigured"
        detail = f"unknown provider {provider!r}"

    return {
        "enabled": enabled,
        "provider": provider,
        "mode": mode,
        "status": status,
        "config": str(cfg_path),
        "privacy": "private-paths-filtered" if status != "privacy-failed" else "failed",
        "detail": detail,
    }



def _missing_privacy_ignores(target: Path) -> list[str]:
    """Return privacy ignore patterns that are not active .gitignore rules.

    Doctor should reject comments, negated patterns, and larger unrelated patterns that
    merely contain the sensitive filenames as substrings. It also accounts for later
    broad negations and nested memory/.gitignore files, since Git gives lower-level
    ignore files precedence over parent rules.
    """
    rules = _privacy_ignore_rules(target / ".gitignore", base="")
    memory_gitignore = target / "memory" / ".gitignore"
    if memory_gitignore.exists():
        rules.extend(_privacy_ignore_rules(memory_gitignore, base="memory"))

    probes = {
        "USER.md": ("USER.md",),
        "MEMORY.md": ("MEMORY.md",),
        "memory/*": ("memory/private.md", "memory/private.txt", "memory/secret.md"),
        "heartbeat-reports/*": (
            "heartbeat-reports/private.md",
            "heartbeat-reports/private.txt",
            "heartbeat-reports/summary.json",
        ),
    }

    missing = [
        required
        for required, paths in probes.items()
        if not all(_ignored_by_rules(rules, path) for path in paths)
    ]
    if "memory/*" not in missing and _has_unsafe_memory_exception(rules):
        missing.append("memory/*")
    return missing


def _privacy_ignore_rules(gitignore: Path, *, base: str) -> list[tuple[str, bool, str]]:
    rules: list[tuple[str, bool, str]] = []
    for raw_line in gitignore.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.rstrip(" ")
        if not line or line.startswith("#"):
            continue

        negated = line.startswith("!")
        pattern = line[1:] if negated else line
        if pattern:
            rules.append((base, negated, pattern.replace("\\", "/")))
    return rules


def _ignored_by_rules(rules: list[tuple[str, bool, str]], rel_path: str) -> bool:
    ignored = False
    for base, negated, pattern in rules:
        if _ignore_rule_matches(base, pattern, rel_path):
            ignored = not negated
    return ignored


def _ignore_rule_matches(base: str, pattern: str, rel_path: str) -> bool:
    rel_path = rel_path.replace("\\", "/")
    if base:
        prefix = f"{base}/"
        if not rel_path.startswith(prefix):
            return False
        scoped = rel_path[len(prefix):]
    else:
        scoped = rel_path

    pattern = pattern.rstrip("/")
    if pattern.startswith("/"):
        pattern = pattern[1:]

    if "/" not in pattern:
        return fnmatchcase(Path(scoped).name, pattern)
    return fnmatchcase(scoped, pattern)


def _has_unsafe_memory_exception(rules: list[tuple[str, bool, str]]) -> bool:
    allowed = {"memory/.gitkeep", "/memory/.gitkeep", ".gitkeep", "/.gitkeep"}
    for base, negated, pattern in rules:
        if not negated:
            continue
        normalized = pattern.lstrip("/")
        if base == "memory":
            if normalized not in {".gitkeep"}:
                return True
            continue
        if normalized in {"memory/.gitkeep"}:
            continue
        if normalized.startswith("memory/"):
            return True
        if "/" not in normalized and normalized not in allowed:
            return True

    return False


def _obsidian_writes(target: Path) -> list[tuple[Path, str]]:
    """Opt-in Obsidian vault config (`--obsidian`). Bare-minimum and never required:
    the precise typed-graph visual is `tropo view` (editor-free); this just colours
    Obsidian's graph nodes by Vivary type for fans. Obsidian's ephemeral UI state is
    gitignored. Nothing in Vivary depends on Obsidian."""
    folder_colors = [
        ("modules", 5213695), ("changes", 16752963), ("decisions", 10837226),
        ("verification", 2547329), ("gates", 16538725),
    ]
    graph = {
        "colorGroups": [
            {"query": f"path:{folder}/", "color": {"a": 1, "rgb": rgb}}
            for folder, rgb in folder_colors
        ],
        "showTags": False,
        "showAttachments": False,
    }
    return [
        (target / ".obsidian" / "app.json", "{}\n"),
        (target / ".obsidian" / "graph.json", json.dumps(graph, indent=2) + "\n"),
        (target / ".obsidian" / ".gitignore", "workspace.json\nworkspace-mobile.json\n"),
    ]


def _source_paths(root: Path) -> dict[str, Path]:
    """Where the scaffold assets live. In the repo, the canonical sources; once
    pip-installed, the bundled copy under `create_vivary_assets/` (kept in sync by
    tools/sync_assets.py)."""
    repo = {
        "strato": root / "packages" / "strato" / "STRATO.md",
        "strato_templates": root / "packages" / "strato" / "templates",
        "strato_skill": root / "packages" / "strato" / ".claude" / "skills" / "strato",
        "active_context_skill": (
            root / "packages" / "strato" / ".claude" / "skills" / "active-context"
        ),
        "claude_loops_skill": root / ".claude" / "skills" / "loops",
        "agents_loops_skill": root / ".agents" / "skills" / "loops",
    }
    if repo["strato"].exists():
        return repo
    assets = Path(__file__).resolve().parent / "create_vivary_assets"
    return {
        "strato": assets / "STRATO.md",
        "strato_templates": assets / "templates",
        "strato_skill": assets / "strato-skill",
        "active_context_skill": assets / "active-context-skill",
        "claude_loops_skill": assets / "loops-skill",
        "agents_loops_skill": assets / "loops-skill",
    }


def _load_tropo(root: Path):
    """Load the tropo engine for doctor's graph validation. Prefers the in-repo
    sibling; once installed, falls back to the `vivary-tropo` dependency."""
    tropo_path = root / "packages" / "tropo" / "tropo.py"
    if tropo_path.exists():
        spec = importlib.util.spec_from_file_location("vivary_doctor_tropo", tropo_path)
        if spec is None or spec.loader is None:
            raise ScaffoldError(f"could not load tropo engine: {tropo_path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    try:
        import tropo as module
    except ImportError as exc:
        raise ScaffoldError(f"tropo engine not found (install vivary-tropo): {exc}")
    return module


def _copy_plan(
    target: Path,
    sources: dict[str, Path],
    *,
    active_context: str | None = None,
) -> list[tuple[Path, Path]]:
    copies: list[tuple[Path, Path]] = []

    def copy_file(src: Path, dst: Path) -> None:
        copies.append((src, dst))

    def copy_tree(src_root: Path, dst_root: Path) -> None:
        for src in src_root.rglob("*"):
            if src.is_file():
                copy_file(src, dst_root / src.relative_to(src_root))

    template_map = {
        "AGENTS.md": "AGENTS.md",
        "SOUL.md": "SOUL.md",
        "STATE.template.md": "STATE.md",
        "USER.template.md": "USER.md",
        "MEMORY.template.md": "MEMORY.md",
        "bug-risk-playbook.md": "bug-risk-playbook.md",
    }
    templates = sources["strato_templates"]
    for src_name, dst_name in template_map.items():
        copy_file(templates / src_name, target / dst_name)

    copy_file(sources["strato"], target / "STRATO.md")
    copy_tree(templates, target / "templates")
    copy_tree(sources["strato_skill"], target / ".claude" / "skills" / "strato")
    copy_tree(sources["strato_skill"], target / ".agents" / "skills" / "strato")
    copy_tree(sources["claude_loops_skill"], target / ".claude" / "skills" / "loops")
    copy_tree(sources["agents_loops_skill"], target / ".agents" / "skills" / "loops")
    if active_context == "cocoindex-code":
        copy_tree(
            sources["active_context_skill"],
            target / ".claude" / "skills" / "active-context",
        )
        copy_tree(
            sources["active_context_skill"],
            target / ".agents" / "skills" / "active-context",
        )
    return copies


def _ensure_safe_destinations(target: Path, paths: list[Path], force: bool) -> None:
    _ensure_within_target(target, paths)
    symlinks = sorted(
        {
            component
            for path in paths
            for component in _existing_components(target, path)
            if component.is_symlink()
        }
    )
    if symlinks:
        preview = "\n".join(f"  - {p}" for p in symlinks[:20])
        extra = "" if len(symlinks) <= 20 else f"\n  ... and {len(symlinks) - 20} more"
        raise ScaffoldError(
            "refusing to scaffold through symlinked destination path(s):\n"
            f"{preview}{extra}"
        )

    ancestor_conflicts = sorted(
        {
            parent
            for path in paths
            for parent in path.parents
            if parent.is_file()
        }
    )
    if ancestor_conflicts:
        preview = "\n".join(f"  - {p}" for p in ancestor_conflicts[:20])
        extra = (
            ""
            if len(ancestor_conflicts) <= 20
            else f"\n  ... and {len(ancestor_conflicts) - 20} more"
        )
        raise ScaffoldError(
            "refusing to scaffold because destination parent path(s) are files:\n"
            f"{preview}{extra}"
        )

    existing = sorted({p for p in paths if p.exists()})
    if existing and not force:
        preview = "\n".join(f"  - {p}" for p in existing[:20])
        extra = "" if len(existing) <= 20 else f"\n  ... and {len(existing) - 20} more"
        raise ScaffoldError(
            "refusing to overwrite existing scaffold file(s); rerun with --force:\n"
            f"{preview}{extra}"
        )


def _ensure_within_target(target: Path, paths: list[Path]) -> None:
    escaped = []
    for path in paths:
        try:
            path.relative_to(target)
            path.resolve(strict=False).relative_to(target)
        except ValueError:
            escaped.append(path)
    if escaped:
        preview = "\n".join(f"  - {p}" for p in escaped[:20])
        extra = "" if len(escaped) <= 20 else f"\n  ... and {len(escaped) - 20} more"
        raise ScaffoldError(
            "refusing to scaffold outside the selected target directory:\n"
            f"{preview}{extra}"
        )


def _existing_components(target: Path, path: Path) -> list[Path]:
    try:
        relative = path.relative_to(target)
    except ValueError:
        return [path] if path.exists() or path.is_symlink() else []

    components: list[Path] = []
    current = target
    if current.exists() or current.is_symlink():
        components.append(current)
    for part in relative.parts:
        current = current / part
        if current.exists() or current.is_symlink():
            components.append(current)
        else:
            break
    return components


def _write_text_no_follow(target: Path, dst: Path, text: str) -> None:
    _ensure_safe_destinations(target, [dst], force=True)
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{dst.name}.", suffix=".vivary-tmp", dir=dst.parent
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, dst)
    finally:
        if tmp.exists() or tmp.is_symlink():
            tmp.unlink()


def _copy_file_no_follow(target: Path, src: Path, dst: Path) -> None:
    _ensure_safe_destinations(target, [dst], force=True)
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{dst.name}.", suffix=".vivary-tmp", dir=dst.parent
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out, src.open("rb") as inp:
            shutil.copyfileobj(inp, out)
        shutil.copystat(src, tmp)
        os.replace(tmp, dst)
    finally:
        if tmp.exists() or tmp.is_symlink():
            tmp.unlink()


def _cleanup_stale_scaffold_state(
    target: Path,
    *,
    active_context: str | None,
    memory: str,
) -> None:
    """Remove generated artifacts that old scaffold shapes can leave behind.

    `--force` means "make this target match the selected scaffold", but it should not
    delete arbitrary user content. Keep cleanup limited to paths Vivary itself has
    generated in older or optional profiles.
    """
    for path in _stale_scaffold_paths(target, active_context, memory):
        _remove_path(target, path)


def _stale_scaffold_paths(target: Path, active_context: str | None, memory: str) -> list[Path]:
    paths = _legacy_module_files(target)
    if active_context != "cocoindex-code":
        paths = [*paths, *_cocoindex_active_context_stale_paths(target)]
    if memory == "none":
        paths = [*paths, *_semantic_memory_stale_paths(target)]
    return paths


def _legacy_module_files(target: Path) -> list[Path]:
    module_ids = {
        "agent-workspace",
        "active-context",
        "semantic-memory",
        "sources",
        *(starter["module_id"] for starter in PRESET_STARTERS.values()),
    }
    return [target / "modules" / f"{module_id}.md" for module_id in sorted(module_ids)]


def _cocoindex_active_context_stale_paths(target: Path) -> list[Path]:
    return [
        target / "docs" / "active-context.md",
        target / "modules" / "active-context",
        target / "decisions" / "0002-cocoindex-code-sidecar.md",
        target / "verification" / "active-context-smoke.md",
        target / ".claude" / "skills" / "active-context",
        target / ".agents" / "skills" / "active-context",
    ]


def _semantic_memory_stale_paths(target: Path) -> list[Path]:
    return [
        target / "docs" / "semantic-memory.md",
        target / "modules" / "semantic-memory",
        target / "changes" / "semantic-memory-capability.md",
        target / "decisions" / "0002-semantic-memory-capability.md",
        target / "verification" / "semantic-memory-smoke.md",
        target / _STORAGE_DIR / _MEMORY_CONFIG_NAME,
    ]


def _ensure_safe_cleanup_targets(root: Path, paths: list[Path]) -> None:
    unsafe = [path for path in paths if not _is_safe_cleanup_target(root, path)]
    if unsafe:
        preview = "\n".join(f"  - {p}" for p in unsafe[:20])
        extra = "" if len(unsafe) <= 20 else f"\n  ... and {len(unsafe) - 20} more"
        raise ScaffoldError(
            "refusing to clean stale scaffold path(s) through symlinked or "
            f"out-of-workspace parent path(s):\n{preview}{extra}"
        )


def _remove_path(root: Path, path: Path) -> None:
    if not _is_safe_cleanup_target(root, path):
        raise ScaffoldError(f"refusing to clean unsafe scaffold path: {path}")
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _is_safe_cleanup_target(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False

    for parent in path.parents:
        if parent == root:
            return True
        if parent.is_symlink():
            return False
    return False


def _module_index_path(target: Path, module_id: str) -> Path:
    return target / "modules" / module_id / "index.md"


def _module_index_errors(target: Path) -> list[str]:
    modules = target / "modules"
    if not modules.exists():
        return []
    errors: list[str] = []
    for child in sorted(modules.iterdir()):
        if child.is_dir() and not child.name.startswith(".") and not (child / "index.md").exists():
            rel = child.relative_to(target).as_posix()
            errors.append(f"module directory missing index.md: {rel}")
        if child.is_file() and child.suffix == ".md" and child.name != "index.md":
            paired_index = modules / child.stem / "index.md"
            if paired_index.exists():
                rel = child.relative_to(target).as_posix()
                errors.append(f"legacy module file coexists with module index: {rel}")
    return errors


def _workspace_readme(
    project: str,
    preset: str,
    active_context: str | None = None,
    memory: str = "none",
) -> str:
    starter = PRESET_STARTERS[preset]
    active_context_section = ""
    if active_context == "cocoindex-code":
        active_context_section = """

Optional active context:

- CocoIndex-code guidance lives in `docs/active-context.md`.
- The active-context skill asks before installing, initializing, indexing, or enabling
  MCP, then combines `tropo graph` truth with `ccc search` semantic candidates.
"""
    memory_section = ""
    if memory != "none":
        memory_section = f"""

Optional semantic memory:

- Semantic memory policy lives in `docs/semantic-memory.md`.
- Config lives in `.vivary/memory.toml`.
- Mode: `{memory}`.
- Installing providers, indexing source files, enabling network access, or recalling
  private material are explicit gates.
"""
    return f"""# {project}

Vivary agent workspace scaffold.

Preset: {preset}

Start here:

1. Read `AGENTS.md` for the workspace contract.
2. Read `STATE.md` for current truth.
3. Use `modules/index.md` to choose the one module index relevant to the task.
4. Fill `USER.md` and `MEMORY.md` locally; they are private and gitignored.
5. Use `tropo check --root .` to validate the typed workspace graph.

The scaffold includes tropo for typed workspace knowledge, strato for the agent OS,
runtime skills for Claude/Codex-style agents, and a starter graph under
`modules/`, `changes/`, `decisions/`, `verification/`, and `gates/`.

Module rule: each generated module is a directory with one `index.md`. The index is
the lightweight router; put deeper context behind links instead of duplicating it.

Preset starter:

- Module: `{starter["module_id"]}`
- First slice: `{starter["change_id"]}`
- Verification: `{starter["verification_id"]}`
{active_context_section}{memory_section}"""


def _workspace_gitignore(
    active_context: str | None = None,
    *,
    preserve_cocoindex_ignore: bool = False,
) -> str:
    active_context_ignores = ""
    if active_context == "cocoindex-code" or preserve_cocoindex_ignore:
        active_context_ignores = """
# Optional active context sidecars
.cocoindex_code/
"""
    return f"""# Strato private context
USER.md
MEMORY.md
memory/*
!memory/.gitkeep
heartbeat-reports/*
!heartbeat-reports/.gitkeep
.strato/private/

# Vivary runtime data (storage.toml/memory.toml are committed; data/indexes are not)
.vivary/data/
.vivary/memory/

# Local secrets and tool state
.env
.env.*
*.local

# Dependencies and build output
node_modules/
.venv/
dist/
build/
__pycache__/
*.pyc

# Editor / OS
.DS_Store
.idea/
.vscode/
{active_context_ignores}"""


def _workspace_tropo_config() -> str:
    return """version = 1
exclude = [
  ".git",
  ".claude",
  ".agents",
  "docs",
  "templates",
  "memory",
  "heartbeat-reports",
  "README.md",
  "AGENTS.md",
  "SOUL.md",
  "STRATO.md",
  "STATE.md",
  "USER.md",
  "MEMORY.md",
  "bug-risk-playbook.md",
]

[base]
derive = ["id", "title"]
allow_untyped = true
optional = { tags = "string-list" }

[types.module]
folder = "modules"
required = { project = "string", status = "enum:active|draft|blocked|archived", module_area = "string" }
optional = { related_modules = "ref-list", related_changes = "ref-list", verification = "ref-list", gates = "ref-list", source_files = "string-list", test_files = "string-list" }

[types.implementation_slice]
folder = "changes"
required = { project = "string", status = "enum:planned|active|done|blocked|deferred", slice = "string" }
optional = { branch = "string", related_modules = "ref-list", related_changes = "ref-list", verification = "ref-list", gates = "ref-list" }

[types.decision]
folder = "decisions"
required = { project = "string", status = "enum:proposed|accepted|deferred|superseded", date = "date" }
optional = { supersedes = "ref", superseded_by = "ref", related_modules = "ref-list", related_changes = "ref-list", rationale = "string" }

[types.verification]
folder = "verification"
required = { project = "string", status = "enum:planned|passed|failed|blocked|deferred", target = "string" }
optional = { command = "string", evidence = "any", related_modules = "ref-list", related_changes = "ref-list" }

[types.gate]
folder = "gates"
required = { project = "string", status = "enum:open|approved|rejected|deferred", gate = "string" }
optional = { approver = "string", approved_at = "datetime", command_intent = "string", related_modules = "ref-list", related_changes = "ref-list" }
"""


def _module_doc(project: str) -> str:
    return f"""---
project: {project}
status: active
module_area: baseline
related_changes: [scaffold-init]
verification: [scaffold-smoke]
gates: [human-gates]
---
# Agent Workspace

## Purpose

The root agent workspace shell: state surface, human contract, private memory, runtime
skills, and typed graph folders.

## Read Next

- Root contract: `AGENTS.md`
- Current state: `STATE.md`
- Module router: `modules/index.md`

Keep this index small. Link to deeper files instead of copying their contents here.
"""


def _modules_index_doc(
    project: str,
    starter: dict[str, str],
    active_context: str | None,
    *,
    preset: str = "coding",
    memory: str = "none",
) -> str:
    module_ids = ["agent-workspace", starter["module_id"]]
    if preset == "knowledge-work":
        module_ids.append("sources")
    if active_context == "cocoindex-code":
        module_ids.append("active-context")
    if memory != "none":
        module_ids.append("semantic-memory")
    refs = ", ".join(module_ids)
    rows = "\n".join(
        f"- `{module_id}` -> `modules/{module_id}/index.md`" for module_id in module_ids
    )
    return f"""---
project: {project}
status: active
module_area: progressive disclosure router
related_modules: [{refs}]
verification: [scaffold-smoke]
gates: [human-gates]
---
# Modules

Use this file to choose what to open next. Do not load every module by default.

{rows}

## DRY Rule

Each fact gets one owner. Put the short routing summary in the module index, keep
canonical detail in the owning file, and link instead of copying.
"""


def _preset_writes(target: Path, project: str, starter: dict[str, str]) -> list[tuple[Path, str]]:
    return [
        (
            _module_index_path(target, starter["module_id"]),
            _preset_module_doc(project, starter),
        ),
        (
            target / "changes" / f'{starter["change_id"]}.md',
            _preset_change_doc(project, starter),
        ),
        (
            target / "verification" / f'{starter["verification_id"]}.md',
            _preset_verification_doc(project, starter),
        ),
    ]


def _knowledge_work_writes(target: Path, project: str) -> list[tuple[Path, str]]:
    return [
        (
            _module_index_path(target, "sources"),
            _knowledge_sources_module_doc(project),
        ),
    ]


def _semantic_memory_writes(target: Path, project: str, memory: str) -> list[tuple[Path, str]]:
    return [
        (target / "docs" / "semantic-memory.md", _semantic_memory_doc(project, memory)),
        (
            _module_index_path(target, "semantic-memory"),
            _semantic_memory_module_doc(project, memory),
        ),
        (
            target / "changes" / "semantic-memory-capability.md",
            _semantic_memory_change_doc(project, memory),
        ),
        (
            target / "decisions" / "0002-semantic-memory-capability.md",
            _semantic_memory_decision_doc(project, memory),
        ),
        (
            target / "verification" / "semantic-memory-smoke.md",
            _semantic_memory_verification_doc(project, memory),
        ),
    ]


def _cocoindex_active_context_writes(target: Path, project: str) -> list[tuple[Path, str]]:
    return [
        (target / "docs" / "active-context.md", _cocoindex_active_context_doc(project)),
        (
            _module_index_path(target, "active-context"),
            _cocoindex_active_context_module_doc(project),
        ),
        (
            target / "decisions" / "0002-cocoindex-code-sidecar.md",
            _cocoindex_active_context_decision_doc(project),
        ),
        (
            target / "verification" / "active-context-smoke.md",
            _cocoindex_active_context_verification_doc(project),
        ),
    ]


def _knowledge_sources_module_doc(project: str) -> str:
    return f"""---
project: {project}
status: active
module_area: source routing and evidence
related_modules: [workbench, agent-workspace]
related_changes: [workbench-first-artifact]
verification: [workbench-proof]
gates: [human-gates]
source_files: []
---
# Sources

## Purpose

Route agents to the source files, folders, and evidence surfaces that matter for this
workspace. Add project-specific paths to `source_files` as the workbench takes shape.

## Read Next

- Workbench: `modules/workbench/index.md`
- First artifact: `changes/workbench-first-artifact.md`
- Proof: `verification/workbench-proof.md`

Keep this as an index. Link to source material instead of copying it here.
"""


def _semantic_memory_doc(project: str, memory: str) -> str:
    provider = "Cognee" if memory == "cognee" else "local Vivary"
    adapter_section = ""
    if memory == "cognee":
        adapter_section = """
## Optional Adapter

If the human approves Cognee runtime recall later, install `vivary-memory-cognee`
and run the adapter with an explicit dry run before indexing:

```bash
vivary-cognee doctor --root . --json
vivary-cognee index --root . --dry-run --json
vivary-cognee index --root . --yes --json
vivary-cognee recall "what should I read?" --root . --json
```

The adapter indexes privacy-filtered typed `tropo` node packets and accepts only
recall hits that map back to known graph node ids.
"""
    return f"""# Semantic Memory

This workspace has optional semantic memory configured in `{_STORAGE_DIR}/{_MEMORY_CONFIG_NAME}`.

Mode: `{memory}`
Provider: {provider}

Semantic memory is candidate recall over the typed `tropo` graph. It is not the source
of truth. Source files plus `tropo check` win when provider state disagrees.

## Gates

Ask before installing providers, indexing files, embedding content, enabling network
access, or recalling from private paths. `USER.md`, `MEMORY.md`, `memory/**`, and
`heartbeat-reports/**` must stay outside every memory index.

## Retrieval Order

1. Validate graph truth with `tropo check --root .`.
2. Use `tropo graph` and `tropo query` first.
3. Use semantic recall for candidates only.
4. Read returned source files directly before acting.
5. Verify with `create-vivary doctor .` and the workspace proof gate.
{adapter_section}
"""


def _semantic_memory_module_doc(project: str, memory: str) -> str:
    adapter_line = ""
    if memory == "cognee":
        adapter_line = "Adapter CLI after explicit install: `vivary-cognee doctor/index/recall/forget`."
    return f"""---
project: {project}
status: active
module_area: optional semantic recall
related_modules: [agent-workspace]
related_changes: [semantic-memory-capability]
verification: [semantic-memory-smoke]
gates: [human-gates]
source_files: []
---
# Semantic Memory

## Purpose

Configure optional semantic recall as a sidecar over the typed graph.

## Read Next

- Policy: `docs/semantic-memory.md`
- Config: `{_STORAGE_DIR}/{_MEMORY_CONFIG_NAME}`
- Verification: `verification/semantic-memory-smoke.md`

Mode: `{memory}`. Installing providers and indexing content remain explicit gates.
{adapter_line}
"""


def _semantic_memory_decision_doc(project: str, memory: str) -> str:
    return f"""---
project: {project}
status: accepted
date: {date.today().isoformat()}
related_modules: [semantic-memory, agent-workspace]
related_changes: [semantic-memory-capability]
rationale: semantic memory is an optional recall provider over typed graph truth
---
# Semantic Memory Capability

This workspace may use `{memory}` semantic memory as an optional recall sidecar.
The typed graph remains the source of truth, and provider state is rebuildable.
"""


def _semantic_memory_change_doc(project: str, memory: str) -> str:
    return f"""---
project: {project}
status: planned
slice: optional semantic memory setup
related_modules: [semantic-memory, agent-workspace]
related_changes: [scaffold-init]
verification: [semantic-memory-smoke]
gates: [human-gates]
---
# Semantic Memory Capability

Configure `{memory}` semantic memory as an optional, privacy-gated recall sidecar.
"""


def _semantic_memory_verification_doc(project: str, memory: str) -> str:
    adapter_check = ""
    if memory == "cognee":
        adapter_check = """
If `vivary-memory-cognee` is installed, also run:

```bash
vivary-cognee doctor --root . --json
vivary-cognee index --root . --dry-run --json
```

Do not run `vivary-cognee index --yes` until the human approves provider memory
writes.
"""
    return f"""---
project: {project}
status: planned
target: semantic-memory-capability
command: create-vivary doctor . --json
related_modules: [semantic-memory, agent-workspace]
related_changes: [semantic-memory-capability]
---
# Semantic Memory Smoke

Verify that `create-vivary doctor` reports semantic memory mode `{memory}` without
indexing private files or requiring unavailable providers to break the core workspace.
{adapter_check}
"""


def _cocoindex_active_context_doc(project: str) -> str:
    return f"""# Active Context

This workspace can use CocoIndex-code as an optional active-context sidecar for
semantic code search. Vivary routes the work; CocoIndex-code finds fuzzy source-code
candidates when names are unknown and plain file search is wasting context.

Project: `{project}`

## Agent Policy

1. Ask before installing `cocoindex-code`, running `ccc init`, indexing code, enabling
   MCP, or sending source text to an external embedding provider.
2. Ask Vivary what to open first: `tropo find "<task>" --budget 1200 --json`.
3. Use graph truth for ids, types, edges, and blast radius: `tropo graph`,
   `tropo blast <id>`, and `ozone impact <id>`.
4. Use `ccc search --refresh "<query>"` for semantic candidates when exact names are
   unknown or `rg` is too noisy.
5. Read matched files directly before editing; semantic search finds candidates, not
   final truth.
6. Report the query, refresh status, file paths, line ranges, and whether the semantic
   hits confirmed or changed the graph-based understanding.

## Setup Options

Native install, local embeddings:

```bash
uv tool install --python 3.11 --upgrade "cocoindex-code[full]"
ccc init -f
ccc doctor
ccc index
ccc status
ccc search --refresh "where is authentication handled"
ccc search --path "src/db.py" "database connection pool"
```

On non-interactive Windows agent runs, use `cmd /c "echo. | ccc init -f"` so the CLI
chooses its local sentence-transformers default instead of opening an interactive
prompt.

MCP integration, after approval:

```bash
codex mcp add cocoindex-code -- ccc mcp
```

Index state belongs in `.cocoindex_code/`, which this scaffold gitignores.
"""


def _cocoindex_active_context_module_doc(project: str) -> str:
    return f"""---
project: {project}
status: active
module_area: optional semantic code search sidecar
related_modules: [agent-workspace, codebase]
verification: [active-context-smoke]
gates: [human-gates]
---
# Active Context

## Purpose

Optional CocoIndex-code sidecar for active semantic code retrieval in a Vivary-backed
codebase. It supplements tropo's explicit graph with fresh semantic code candidates
when the agent asks and the human approves the indexing/install gate.

## Read Next

- Policy: `docs/active-context.md`
- Verification: `verification/active-context-smoke.md`
- Decision: `decisions/0002-cocoindex-code-sidecar.md`
"""


def _cocoindex_active_context_decision_doc(project: str) -> str:
    return f"""---
project: {project}
status: accepted
date: {date.today().isoformat()}
related_modules: [active-context, codebase, agent-workspace]
rationale: active semantic search should be a sidecar, not part of the deterministic tropo core
---
# CocoIndex-code Sidecar

CocoIndex-code may be used as an optional active-context sidecar for coding
workspaces. The sidecar can refresh a semantic code index and answer fuzzy code
questions, but Vivary keeps the default scaffold lean: no install, no index, no daemon,
and no MCP configuration happens until the human approves it.
"""


def _cocoindex_active_context_verification_doc(project: str) -> str:
    return f"""---
project: {project}
status: planned
target: cocoindex-code active-context sidecar
command: ccc doctor && ccc search --refresh "where is the main entrypoint"
related_modules: [active-context, codebase]
---
# Active Context Smoke

After the user approves using CocoIndex-code, verify the sidecar by running
`ccc doctor`, refreshing the index with one semantic query, and reading at least one
returned file path directly before acting on it.
"""


def _preset_module_doc(project: str, starter: dict[str, str]) -> str:
    return f"""---
project: {project}
status: active
module_area: {starter["module_area"]}
related_modules: [agent-workspace]
related_changes: [{starter["change_id"]}]
verification: [{starter["verification_id"]}]
gates: [human-gates]
---
# {starter["module_title"]}

## Purpose

{starter["module_body"]}

## Read Next

- First slice: `changes/{starter["change_id"]}.md`
- Verification: `verification/{starter["verification_id"]}.md`

Keep canonical details in the linked files. This index is the routing surface.
"""


def _preset_change_doc(project: str, starter: dict[str, str]) -> str:
    return f"""---
project: {project}
status: planned
slice: {starter["change_slice"]}
related_modules: [{starter["module_id"]}, agent-workspace]
related_changes: [scaffold-init]
verification: [{starter["verification_id"]}]
gates: [human-gates]
---
# {starter["change_title"]}

{starter["change_body"]}
"""


def _preset_verification_doc(project: str, starter: dict[str, str]) -> str:
    return f"""---
project: {project}
status: planned
target: {starter["verification_target"]}
command: {starter["verification_command"]}
related_modules: [{starter["module_id"]}, agent-workspace]
related_changes: [{starter["change_id"]}]
---
# {starter["verification_title"]}

{starter["verification_body"]}
"""


def _change_doc(project: str) -> str:
    return f"""---
project: {project}
status: done
slice: full agent workspace scaffold
related_modules: [agent-workspace]
verification: [scaffold-smoke]
gates: [human-gates]
---
# Scaffold Init

The initial Vivary workspace scaffold was laid down and should be validated with
the scaffold smoke check.
"""


def _decision_doc(project: str, today: str) -> str:
    return f"""---
project: {project}
status: accepted
date: {today}
related_modules: [agent-workspace]
related_changes: [scaffold-init]
rationale: tropo plus strato is the irreducible Vivary baseline
---
# Vivary Baseline

This workspace starts with tropo for typed knowledge and strato for the visible
agent operating loop.
"""


def _verification_doc(project: str) -> str:
    return f"""---
project: {project}
status: planned
target: scaffold-init
command: tropo check --root .
related_modules: [agent-workspace]
related_changes: [scaffold-init]
---
# Scaffold Smoke

Validate that the generated workspace has a loadable `tropo.toml`, clean starter
graph documents, and no broken graph references.
"""


def _gate_doc(project: str) -> str:
    return f"""---
project: {project}
status: open
gate: human approval before durable or outward actions
related_modules: [agent-workspace]
related_changes: [scaffold-init]
---
# Human Gates

Stop for explicit approval before publishing, pushing, opening a PR, enabling
active hooks, installing dependencies, indexing private material, or running a
destructive operation.
"""


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

_STORAGE_DIR = ".vivary"
_STORAGE_CONFIG_NAME = "storage.toml"
_MEMORY_CONFIG_NAME = "memory.toml"
_STORAGE_DATA_DIR = ".vivary/data"
_MEMORY_STATE_DIR = ".vivary/memory"

_STORAGE_TOML_TEMPLATES = {
    "file": """\
[storage]
backend = "file"
""",
    "embedded": """\
[storage]
backend = "embedded"

[storage.embedded]
path = ".vivary/data"
provider = "lancedb"
""",
    "cloud-qdrant": """\
[storage]
backend = "cloud"

[storage.cloud]
provider = "qdrant"
url = "${VIVARY_CLOUD_URL}"
api_key = "${VIVARY_CLOUD_API_KEY}"
collection = "my-workspace"
""",
    "cloud-astra": """\
[storage]
backend = "cloud"

[storage.cloud]
provider = "astra"
api_key = "${VIVARY_CLOUD_API_KEY}"
endpoint = "${VIVARY_CLOUD_ENDPOINT}"
collection = "my-workspace"
""",
}

_MEMORY_TOML_TEMPLATES = {
    "local": """\
[memory]
enabled = true
mode = "semantic-provider"
provider = "vivary-local"

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**"]
fail_closed = true

[memory.local]
state_path = ".vivary/memory/local"
allow_network = false
require_explicit_index = true
""",
    "cognee": """\
[memory]
enabled = true
mode = "semantic-provider"
provider = "cognee"

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**"]
fail_closed = true

[memory.cognee]
state_path = ".vivary/memory/cognee"
allow_network = false
require_explicit_index = true
api_key_env = ""
""",
}


def _auto_pick_storage(args) -> tuple[str, str]:
    """Return (storage_tier, provider) based on --auto signals."""
    privacy = getattr(args, "privacy", None)
    size = getattr(args, "size", None)
    storage = getattr(args, "storage", None)
    provider = getattr(args, "provider", None)

    if storage and storage != "auto":
        return storage, provider or "lancedb"
    if privacy == "cloud":
        return "cloud", provider or "qdrant"
    if size == "small":
        return "file", provider or "lancedb"
    # medium, large, or not-sure → embedded (safe local default)
    return "embedded", provider or "lancedb"


def _is_importable(module: str) -> bool:
    import importlib.util
    return importlib.util.find_spec(module) is not None


def _ensure_backend_installed(provider: str, yes: bool) -> list[str]:
    """Install the embedded pip extra for provider if not already present.

    Cloud backends are config-only for now, so only the shipped embedded
    provider is eligible for self-install. Returns installed package names.
    """
    extras = {"lancedb": "embedded"}
    pkg_map = {"lancedb": "lancedb"}
    pkg = pkg_map.get(provider)
    if pkg is None or _is_importable(pkg.replace("-", "_")):
        return []
    if not yes:
        try:
            sys.stderr.write(f"  Install {pkg} for {provider} support? [Y/n] ")
            sys.stderr.flush()
            ans = sys.stdin.readline().strip().lower()
        except EOFError:
            ans = "y"
        if ans not in ("", "y", "yes"):
            return []
    extra = extras.get(pkg, "embedded")
    spec = f"vivary-tropo[{extra}]"
    print(f"  Installing {spec}…", file=sys.stderr)
    _install_runtime_extra(spec)
    return [pkg]


def _install_runtime_extra(spec: str) -> None:
    commands = [[sys.executable, "-m", "pip", "install", spec]]
    uv = shutil.which("uv")
    if uv:
        commands.append([uv, "pip", "install", "--python", sys.executable, spec])

    for cmd in commands:
        try:
            subprocess.check_call(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            return
        except (OSError, subprocess.CalledProcessError):
            continue

    raise ScaffoldError(
        f"could not install {spec}; install it manually or rerun with --storage file"
    )


def _run_wizard(args) -> dict:
    """Return storage decisions from interactive prompts or auto-pick."""
    requested_memory = getattr(args, "memory", None) or "none"
    if getattr(args, "no_wizard", False) and not getattr(args, "auto", False):
        if getattr(args, "storage", None) == "auto":
            storage, provider = _auto_pick_storage(args)
        else:
            storage = getattr(args, "storage", None) or "file"
            provider = getattr(args, "provider", None) or "lancedb"
        return {"storage": storage, "provider": provider, "memory": requested_memory}

    auto = getattr(args, "auto", False)
    interactive = not auto and sys.stdin.isatty()

    if not interactive:
        storage, provider = _auto_pick_storage(args)
        return {"storage": storage, "provider": provider, "memory": requested_memory}

    # Interactive flow — plain English, no jargon (all prompts to stderr so JSON stdout stays clean)
    print("\nWelcome to Vivary! Let's set up your workspace.\n", file=sys.stderr)

    size_map = {"1": "small", "2": "medium", "3": "large", "": "medium"}
    print("  How large do you expect this workspace to get?", file=sys.stderr)
    print("  1) Just starting out (a few files or notes)", file=sys.stderr)
    print("  2) Growing — hundreds of files (recommended)", file=sys.stderr)
    print("  3) Large — huge codebase or years of notes", file=sys.stderr)
    try:
        sys.stderr.write("  Your choice [2]: ")
        sys.stderr.flush()
        size_choice = sys.stdin.readline().strip()
    except EOFError:
        size_choice = ""
    size = size_map.get(size_choice, "medium")

    if size == "small":
        storage_decision = {"storage": "file", "provider": "lancedb"}
        return {**storage_decision, "memory": _prompt_memory_choice(requested_memory)}

    print("\n  Where should your data live?", file=sys.stderr)
    print("  1) On this computer — private, no accounts needed (recommended)", file=sys.stderr)
    print("  2) In the cloud — sync across machines, scales to any size", file=sys.stderr)
    try:
        sys.stderr.write("  Your choice [1]: ")
        sys.stderr.flush()
        loc_choice = sys.stdin.readline().strip()
    except EOFError:
        loc_choice = "1"

    if loc_choice == "2":
        print("\n  Which cloud service?", file=sys.stderr)
        print("  1) Qdrant — free tier, open source, easiest setup (recommended)", file=sys.stderr)
        print("  2) Astra DB — DataStax, enterprise scale", file=sys.stderr)
        print("  3) I'll set this up later", file=sys.stderr)
        try:
            sys.stderr.write("  Your choice [1]: ")
            sys.stderr.flush()
            cloud_choice = sys.stdin.readline().strip()
        except EOFError:
            cloud_choice = "1"
        if cloud_choice == "2":
            return {"storage": "cloud", "provider": "astra", "installed": [], "memory": _prompt_memory_choice(requested_memory)}
        if cloud_choice == "3":
            return {"storage": "file", "provider": "lancedb", "installed": [], "memory": _prompt_memory_choice(requested_memory)}
        return {"storage": "cloud", "provider": "qdrant", "installed": [], "memory": _prompt_memory_choice(requested_memory)}

    # User picked "on this computer" — install LanceDB now, wizard is the consent step.
    if getattr(args, "dry_run", False):
        print("\n  Would set up LanceDB embedded storage (dry run).", file=sys.stderr)
        installed = []
    else:
        print("\n  Setting up LanceDB embedded storage...", file=sys.stderr)
        installed = _ensure_backend_installed("lancedb", yes=True)
    return {"storage": "embedded", "provider": "lancedb", "installed": installed, "memory": _prompt_memory_choice(requested_memory)}


def _prompt_memory_choice(default: str) -> str:
    if default != "none":
        return default

    print("\n  Do you want optional semantic memory?", file=sys.stderr)
    print("  1) No semantic memory (recommended)", file=sys.stderr)
    print("  2) Local semantic memory policy — no network or provider install", file=sys.stderr)
    print("  3) Cognee semantic memory policy — install and indexing are later gates", file=sys.stderr)
    try:
        sys.stderr.write("  Your choice [1]: ")
        sys.stderr.flush()
        choice = sys.stdin.readline().strip()
    except EOFError:
        choice = ""
    return {"2": "local", "3": "cognee"}.get(choice, "none")


def _write_vivary_dir(
    target: Path, storage: str, provider: str, dry_run: bool, *, force: bool
) -> list[Path]:
    """Write .vivary/storage.toml. Returns list of paths written."""
    vivary_dir = target / _STORAGE_DIR
    cfg_path = vivary_dir / _STORAGE_CONFIG_NAME

    key = storage if storage != "cloud" else f"cloud-{provider}"
    toml_text = _STORAGE_TOML_TEMPLATES.get(key, _STORAGE_TOML_TEMPLATES["file"])

    _ensure_safe_destinations(target, [cfg_path], force)
    if dry_run:
        return [cfg_path]

    _write_text_no_follow(target, cfg_path, toml_text)
    return [cfg_path]


def _write_memory_config(target: Path, memory: str, dry_run: bool, *, force: bool) -> list[Path]:
    """Write .vivary/memory.toml. Returns list of paths written."""
    vivary_dir = target / _STORAGE_DIR
    cfg_path = vivary_dir / _MEMORY_CONFIG_NAME
    toml_text = _MEMORY_TOML_TEMPLATES[memory]

    _ensure_safe_destinations(target, [cfg_path], force)
    if dry_run:
        return [cfg_path]

    _write_text_no_follow(target, cfg_path, toml_text)
    return [cfg_path]


def capability_report(preset: str = "coding") -> dict:
    if preset not in PRESETS:
        raise ScaffoldError(f"unknown preset {preset!r}; expected one of {', '.join(PRESETS)}")

    capabilities = [
        {
            "id": "storage:file",
            "label": "File-backed typed graph",
            "default": True,
            "requires_install": [],
            "requires_approval": False,
            "network": False,
        },
        {
            "id": "storage:embedded",
            "label": "Local embedded storage",
            "default": False,
            "requires_install": ["vivary-tropo[embedded]"],
            "requires_approval": True,
            "network": False,
        },
        {
            "id": "memory:none",
            "label": "No semantic memory",
            "default": True,
            "requires_install": [],
            "requires_approval": False,
            "network": False,
        },
        {
            "id": "memory:local",
            "label": "Local semantic memory policy",
            "default": False,
            "requires_install": [],
            "requires_approval": True,
            "requires_explicit_index": True,
            "network": False,
        },
        {
            "id": "memory:cognee",
            "label": "Cognee semantic memory",
            "default": False,
            "requires_install": ["vivary-memory-cognee"],
            "requires_approval": True,
            "requires_explicit_index": True,
            "network": "configurable, default false",
            "adapter_status": "optional-package",
        },
    ]

    if preset == "coding":
        capabilities.append(
            {
                "id": "active-context:cocoindex-code",
                "label": "CocoIndex-code active context",
                "default": False,
                "requires_install": ["cocoindex-code[full]"],
                "requires_approval": True,
                "requires_explicit_index": True,
                "network": "provider-dependent, default local guidance",
            }
        )

    return {
        "ok": True,
        "preset": preset,
        "default_capabilities": ["storage:file", "memory:none"],
        "available_capabilities": capabilities,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="create-vivary",
        description="Scaffold a complete Vivary agent workspace.",
    )
    parser.add_argument("--version", action="version", version=f"create-vivary {__version__}")
    sub = parser.add_subparsers(dest="command")

    init = sub.add_parser("init", help="create a Vivary workspace scaffold")
    init.add_argument("target", help="directory to create or populate")
    init.add_argument("--preset", choices=PRESETS, default="coding")
    init.add_argument("--force", action="store_true", help="overwrite scaffold files")
    init.add_argument("--obsidian", action="store_true",
                      help="also drop an optional Obsidian vault config (graph coloured "
                           "by type); never required — see docs/OBSIDIAN.md")
    init.add_argument(
        "--active-context",
        choices=ACTIVE_CONTEXTS,
        default=None,
        help=(
            "add an optional active-context sidecar profile; currently "
            "'cocoindex-code' for coding workspaces"
        ),
    )
    init.add_argument(
        "--repo-root",
        default=None,
        help="Vivary source checkout root (mainly for local development/tests)",
    )
    init.add_argument("--json", action="store_true", help="machine-readable output")
    init.add_argument("--dry-run", action="store_true", help="simulate without writing")
    init.add_argument("--auto", action="store_true",
                      help="skip prompts; pick best config from available signals")
    init.add_argument("--yes", action="store_true", help="auto-confirm installs and prompts")
    init.add_argument("--no-wizard", action="store_true", dest="no_wizard",
                      help="skip wizard; use flag values or defaults directly")
    init.add_argument("--storage", choices=["auto", "file", "embedded", "cloud"], default=None,
                      help="storage backend (auto=LanceDB locally)")
    init.add_argument("--provider", choices=["lancedb", "sqlite-vec", "qdrant", "astra"],
                      default=None, help="storage provider (default: lancedb)")
    init.add_argument("--memory", choices=MEMORY_MODES, default="none",
                      help="optional semantic memory policy (default: none)")
    init.add_argument("--size", choices=["small", "medium", "large"], default=None,
                      help="workspace size hint for --auto decisions")
    init.add_argument("--privacy", choices=["local", "cloud"], default=None,
                      help="data locality hint for --auto decisions")

    wizard = sub.add_parser("wizard", help="reconfigure storage for an existing workspace")
    wizard.add_argument("target", help="workspace directory to reconfigure")
    wizard.add_argument("--auto", action="store_true")
    wizard.add_argument("--yes", action="store_true")
    wizard.add_argument("--no-wizard", action="store_true", dest="no_wizard")
    wizard.add_argument("--storage", choices=["auto", "file", "embedded", "cloud"], default=None)
    wizard.add_argument("--provider", choices=["lancedb", "sqlite-vec", "qdrant", "astra"], default=None)
    wizard.add_argument("--memory", choices=MEMORY_MODES, default="none")
    wizard.add_argument("--size", choices=["small", "medium", "large"], default=None)
    wizard.add_argument("--privacy", choices=["local", "cloud"], default=None)
    wizard.add_argument("--json", action="store_true")
    wizard.add_argument("--dry-run", action="store_true")
    wizard.add_argument("--repo-root", default=None)

    doctor = sub.add_parser("doctor", help="validate a Vivary workspace scaffold")
    doctor.add_argument("target", help="workspace directory to validate")
    doctor.add_argument("--json", action="store_true", help="print a JSON report")
    doctor.add_argument(
        "--repo-root",
        default=None,
        help="Vivary source checkout root (mainly for local development/tests)",
    )

    capabilities = sub.add_parser("capabilities", help="list optional preset capabilities")
    capabilities.add_argument("--preset", choices=PRESETS, default="coding")
    capabilities.add_argument("--json", action="store_true", help="print a JSON report")
    return parser


def with_default_command(argv: list[str]) -> list[str]:
    """Default a bare target to the ``init`` subcommand so ``create-vivary <name>``
    behaves like ``create-vivary init <name>``. This mirrors the npm launcher
    (`@vivary/create`) so both entry points share one UX. An explicit subcommand or
    a leading flag (e.g. ``-h``/``--help``) passes through unchanged."""
    if argv and not argv[0].startswith("-") and argv[0] not in SUBCOMMANDS:
        return ["init", *argv]
    return argv


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    argv = with_default_command(argv)
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "capabilities":
        try:
            report = capability_report(args.preset)
        except ScaffoldError as exc:
            if getattr(args, "json", False):
                print(json.dumps({"ok": False, "error": str(exc)}))
            else:
                print(f"create-vivary capabilities: {exc}", file=sys.stderr)
            return 1
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print(f"create-vivary capabilities for {report['preset']}:")
            for cap in report["available_capabilities"]:
                marker = " (default)" if cap["default"] else ""
                print(f"- {cap['id']}: {cap['label']}{marker}")
        return 0

    if args.command == "doctor":
        report = doctor_workspace(args.target, repo_root=args.repo_root)
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            _print_doctor_report(report)
        return 0 if report["ok"] else 1

    if args.command == "wizard":
        try:
            target = _resolve_scaffold_target(args.target)
        except ScaffoldError as exc:
            if getattr(args, "json", False):
                print(json.dumps({"ok": False, "error": str(exc)}))
            else:
                print(f"create-vivary wizard: {exc}", file=sys.stderr)
            return 1
        decisions = _run_wizard(args)
        _yes = getattr(args, "yes", False) or getattr(args, "auto", False)
        installed = decisions.get("installed") or (
            []
            if getattr(args, "dry_run", False) or decisions["storage"] != "embedded"
            else _ensure_backend_installed(decisions["provider"], _yes)
        )
        try:
            vivary_paths = _write_vivary_dir(
                target,
                decisions["storage"],
                decisions["provider"],
                getattr(args, "dry_run", False),
                force=True,
            )
            memory_paths = (
                []
                if decisions["memory"] == "none"
                else _write_memory_config(
                    target,
                    decisions["memory"],
                    getattr(args, "dry_run", False),
                    force=True,
                )
            )
        except ScaffoldError as exc:
            if getattr(args, "json", False):
                print(json.dumps({"ok": False, "error": str(exc)}))
            else:
                print(f"create-vivary wizard: {exc}", file=sys.stderr)
            return 1
        if getattr(args, "json", False):
            print(json.dumps({
                "ok": True,
                "root": str(target),
                "storage": decisions["storage"],
                "provider": decisions["provider"],
                "memory": decisions["memory"],
                "installed": installed,
                "config": str(target / _STORAGE_DIR / _STORAGE_CONFIG_NAME),
                "memory_config": (
                    None
                    if decisions["memory"] == "none"
                    else str(target / _STORAGE_DIR / _MEMORY_CONFIG_NAME)
                ),
                "dry_run": getattr(args, "dry_run", False),
            }, indent=2))
        else:
            verb = "would write" if getattr(args, "dry_run", False) else "wrote"
            print(f"create-vivary wizard: {verb} {len(vivary_paths) + len(memory_paths)} config file(s)")
        return 0

    if args.command != "init":
        parser.print_help()
        return 2

    # --- init ---
    dry_run = getattr(args, "dry_run", False)
    # --auto means fully unattended: no prompts anywhere, including installs
    yes = getattr(args, "yes", False) or getattr(args, "auto", False)

    try:
        # Determine storage configuration via wizard or flags
        decisions = _run_wizard(args)
        storage = decisions["storage"]
        provider = decisions["provider"]
        memory = decisions["memory"]

        # If the interactive wizard already installed (user picked embedded), don't prompt again
        _prior = decisions.get("installed", [])
        installed = _prior + (
            []
            if dry_run or storage != "embedded"
            else _ensure_backend_installed(provider, yes)
        )

        created = scaffold_workspace(
            args.target,
            preset=args.preset,
            force=args.force,
            obsidian=args.obsidian,
            active_context=args.active_context,
            repo_root=args.repo_root,
            storage=storage,
            provider=provider,
            memory=memory,
            dry_run=dry_run,
        )
    except ScaffoldError as exc:
        if getattr(args, "json", False):
            print(json.dumps({"ok": False, "error": str(exc)}))
        else:
            print(f"create-vivary: {exc}", file=sys.stderr)
        return 1

    root = Path(args.target).resolve()
    vivary_cfg = str(root / _STORAGE_DIR / _STORAGE_CONFIG_NAME) if storage != "file" else None
    memory_cfg = str(root / _STORAGE_DIR / _MEMORY_CONFIG_NAME) if memory != "none" else None

    if getattr(args, "json", False):
        memory_capability = next(
            (
                cap
                for cap in capability_report(args.preset)["available_capabilities"]
                if cap["id"] == f"memory:{memory}"
            ),
            None,
        )
        print(json.dumps({
            "ok": True,
            "root": str(root),
            "preset": args.preset,
            "storage": storage,
            "provider": provider,
            "memory": memory,
            "memory_capability": memory_capability,
            "installed": installed,
            "files": len(created),
            "config": vivary_cfg,
            "memory_config": memory_cfg,
            "dry_run": dry_run,
        }, indent=2))
    else:
        verb = "would write" if dry_run else "wrote"
        print(f"create-vivary: {verb} {len(created)} file(s) to {root}")
    return 0


def _print_doctor_report(report: dict) -> None:
    status = "ok" if report["ok"] else "failed"
    graph = report["graph"]
    print(
        f"create-vivary doctor: {status} "
        f"({graph['nodes']} node(s), {graph['edges']} edge(s), {graph['broken']} broken)"
    )
    memory = report.get("memory", {})
    if memory:
        print(
            f"memory: {memory.get('status', 'unknown')} "
            f"({memory.get('provider', 'none')})"
        )
    for warning in report["warnings"]:
        print(f"warning: {warning}")
    for error in report["errors"]:
        print(f"error: {error}")


if __name__ == "__main__":
    raise SystemExit(main())
