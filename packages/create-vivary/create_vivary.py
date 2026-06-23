"""create-vivary: scaffold a complete Vivary agent workspace."""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path


PRESETS = ("coding", "second-brain", "writing")

ACTIVE_CONTEXTS = ("cocoindex-code",)

SUBCOMMANDS = ("init", "doctor", "wizard")

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

    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target = Path(target).resolve()

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
        (target / "README.md", _workspace_readme(project, preset, active_context)),
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
            _modules_index_doc(project, PRESET_STARTERS[preset], active_context),
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
    if active_context == "cocoindex-code":
        writes.extend(_cocoindex_active_context_writes(target, project))
    if obsidian:
        writes.extend(_obsidian_writes(target))

    copies = _copy_plan(target, sources, active_context=active_context)
    _ensure_no_conflicts([p for p, _ in writes] + [dst for _, dst in copies], force)
    if force:
        _cleanup_stale_scaffold_state(target, active_context=active_context)

    created: list[Path] = []
    if not dry_run:
        for dst, text in writes:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(text, encoding="utf-8", newline="\n")
            created.append(dst)

        for src, dst in copies:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            created.append(dst)
    else:
        created = [dst for dst, _ in writes] + [dst for _, dst in copies]

    if storage != "file":
        created.extend(_write_vivary_dir(target, storage, provider, dry_run))

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

        gitignore = target / ".gitignore"
        if gitignore.exists():
            txt = gitignore.read_text(encoding="utf-8", errors="replace")
            for pattern in ("USER.md", "MEMORY.md", "memory/*"):
                if pattern not in txt:
                    errors.append(f"privacy ignore missing: {pattern}")
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

    return {
        "ok": not errors,
        "root": str(target),
        "errors": errors,
        "warnings": warnings,
        "graph": graph,
        "backend": backend_name,
    }


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


def _ensure_no_conflicts(paths: list[Path], force: bool) -> None:
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


def _cleanup_stale_scaffold_state(target: Path, *, active_context: str | None) -> None:
    """Remove generated artifacts that old scaffold shapes can leave behind.

    `--force` means "make this target match the selected scaffold", but it should not
    delete arbitrary user content. Keep cleanup limited to paths Vivary itself has
    generated in older or optional profiles.
    """
    for path in _legacy_module_files(target):
        _remove_path(path)

    if active_context != "cocoindex-code":
        for path in _cocoindex_active_context_stale_paths(target):
            _remove_path(path)


def _legacy_module_files(target: Path) -> list[Path]:
    module_ids = {
        "agent-workspace",
        "active-context",
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


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


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


def _workspace_readme(project: str, preset: str, active_context: str | None = None) -> str:
    starter = PRESET_STARTERS[preset]
    active_context_section = ""
    if active_context == "cocoindex-code":
        active_context_section = """

Optional active context:

- CocoIndex-code guidance lives in `docs/active-context.md`.
- The active-context skill asks before installing, initializing, indexing, or enabling
  MCP, then combines `tropo graph` truth with `ccc search` semantic candidates.
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
{active_context_section}"""


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
.strato/private/

# Vivary runtime data (storage.toml is committed; data/ is not)
.vivary/data/

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


def _modules_index_doc(project: str, starter: dict[str, str], active_context: str | None) -> str:
    module_ids = ["agent-workspace", starter["module_id"]]
    if active_context == "cocoindex-code":
        module_ids.append("active-context")
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


def _cocoindex_active_context_doc(project: str) -> str:
    return f"""# Active Context

This workspace can use CocoIndex-code as an optional active-context sidecar for
semantic code search. Vivary core stays plain Markdown/YAML plus the zero-dependency
graph tools; CocoIndex-code is engaged only when the agent and human agree it will
improve retrieval.

Project: `{project}`

## Agent Policy

1. Ask before installing `cocoindex-code`, running `ccc init`, indexing code, enabling
   MCP, or sending source text to an external embedding provider.
2. Lead with Vivary truth: `tropo graph`, `tropo blast <id>`, and `ozone impact <id>`.
3. Use `ccc search --refresh "<query>"` for semantic candidates when exact names are
   unknown or `rg` is too noisy.
4. Read matched files directly before editing; semantic search finds candidates, not
   final truth.
5. Report the query, refresh status, file paths, line ranges, and whether the semantic
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
_STORAGE_DATA_DIR = ".vivary/data"

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
    print(f"  Installing vivary-tropo[{extra}]…", file=sys.stderr)
    subprocess.check_call([sys.executable, "-m", "pip", "install",
                           f"vivary-tropo[{extra}]"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return [pkg]


def _run_wizard(args) -> dict:
    """Return storage decisions from interactive prompts or auto-pick."""
    auto = getattr(args, "auto", False) or getattr(args, "no_wizard", False)
    interactive = not auto and sys.stdin.isatty()

    if not interactive:
        storage, provider = _auto_pick_storage(args)
        return {"storage": storage, "provider": provider}

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
        return {"storage": "file", "provider": "lancedb"}

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
            return {"storage": "cloud", "provider": "astra", "installed": []}
        if cloud_choice == "3":
            return {"storage": "file", "provider": "lancedb", "installed": []}
        return {"storage": "cloud", "provider": "qdrant", "installed": []}

    # User picked "on this computer" — install LanceDB now, wizard is the consent step
    if getattr(args, "dry_run", False):
        print("\n  Would set up LanceDB for local search (dry run).", file=sys.stderr)
        installed = []
    else:
        print("\n  Setting up LanceDB for local search...", file=sys.stderr)
        installed = _ensure_backend_installed("lancedb", yes=True)
    return {"storage": "embedded", "provider": "lancedb", "installed": installed}


def _write_vivary_dir(target: Path, storage: str, provider: str, dry_run: bool) -> list[Path]:
    """Write .vivary/storage.toml. Returns list of paths written."""
    vivary_dir = target / _STORAGE_DIR
    cfg_path = vivary_dir / _STORAGE_CONFIG_NAME

    key = storage if storage != "cloud" else f"cloud-{provider}"
    toml_text = _STORAGE_TOML_TEMPLATES.get(key, _STORAGE_TOML_TEMPLATES["file"])

    if dry_run:
        return [cfg_path]

    vivary_dir.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(toml_text, encoding="utf-8", newline="\n")
    return [cfg_path]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="create-vivary",
        description="Scaffold a complete Vivary agent workspace.",
    )
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

    if args.command == "doctor":
        report = doctor_workspace(args.target, repo_root=args.repo_root)
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            _print_doctor_report(report)
        return 0 if report["ok"] else 1

    if args.command == "wizard":
        target = Path(args.target).resolve()
        decisions = _run_wizard(args)
        _yes = getattr(args, "yes", False) or getattr(args, "auto", False)
        installed = decisions.get("installed") or (
            []
            if getattr(args, "dry_run", False) or decisions["storage"] != "embedded"
            else _ensure_backend_installed(decisions["provider"], _yes)
        )
        vivary_paths = _write_vivary_dir(target, decisions["storage"], decisions["provider"],
                                         getattr(args, "dry_run", False))
        if getattr(args, "json", False):
            print(json.dumps({
                "ok": True,
                "root": str(target),
                "storage": decisions["storage"],
                "provider": decisions["provider"],
                "installed": installed,
                "config": str(target / _STORAGE_DIR / _STORAGE_CONFIG_NAME),
                "dry_run": getattr(args, "dry_run", False),
            }, indent=2))
        else:
            verb = "would write" if getattr(args, "dry_run", False) else "wrote"
            print(f"create-vivary wizard: {verb} {target / _STORAGE_DIR / _STORAGE_CONFIG_NAME}")
        return 0

    if args.command != "init":
        parser.print_help()
        return 2

    # --- init ---
    dry_run = getattr(args, "dry_run", False)
    # --auto means fully unattended: no prompts anywhere, including installs
    yes = getattr(args, "yes", False) or getattr(args, "auto", False)

    # Determine storage configuration via wizard or flags
    decisions = _run_wizard(args)
    storage = decisions["storage"]
    provider = decisions["provider"]

    # If the interactive wizard already installed (user picked embedded), don't prompt again
    _prior = decisions.get("installed", [])
    installed = _prior + (
        []
        if dry_run or storage != "embedded"
        else _ensure_backend_installed(provider, yes)
    )

    try:
        created = scaffold_workspace(
            args.target,
            preset=args.preset,
            force=args.force,
            obsidian=args.obsidian,
            active_context=args.active_context,
            repo_root=args.repo_root,
            storage=storage,
            provider=provider,
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

    if getattr(args, "json", False):
        print(json.dumps({
            "ok": True,
            "root": str(root),
            "preset": args.preset,
            "storage": storage,
            "provider": provider,
            "installed": installed,
            "files": len(created),
            "config": vivary_cfg,
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
    for warning in report["warnings"]:
        print(f"warning: {warning}")
    for error in report["errors"]:
        print(f"error: {error}")


if __name__ == "__main__":
    raise SystemExit(main())
