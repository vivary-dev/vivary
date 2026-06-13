"""create-vivary: scaffold a complete Vivary agent workspace."""

from __future__ import annotations

import argparse
import shutil
import sys
from datetime import date
from pathlib import Path


PRESETS = ("coding", "second-brain", "writing")


class ScaffoldError(RuntimeError):
    """Raised when a workspace cannot be scaffolded safely."""


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def scaffold_workspace(
    target: str | Path,
    *,
    preset: str = "coding",
    force: bool = False,
    repo_root: str | Path | None = None,
) -> list[Path]:
    """Lay down a full Vivary workspace scaffold.

    The scaffold is intentionally source-controlled and static: it copies the strato
    contract, runtime skills, workspace files, and a small tropo graph seed into the
    target directory. It does not install dependencies, initialize git, or contact a
    remote service.
    """
    if preset not in PRESETS:
        raise ScaffoldError(f"unknown preset {preset!r}; expected one of {', '.join(PRESETS)}")

    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target = Path(target).resolve()

    sources = _source_paths(root)
    for label, src in sources.items():
        if not src.exists():
            raise ScaffoldError(f"missing scaffold source for {label}: {src}")

    project = target.name or "vivary-workspace"
    today = date.today().isoformat()

    writes: list[tuple[Path, str]] = [
        (target / "README.md", _workspace_readme(project, preset)),
        (target / ".gitignore", _workspace_gitignore()),
        (target / "tropo.toml", _workspace_tropo_config()),
        (target / "modules" / "agent-workspace.md", _module_doc(project)),
        (target / "changes" / "scaffold-init.md", _change_doc(project)),
        (target / "decisions" / "0001-vivary-baseline.md", _decision_doc(project, today)),
        (target / "verification" / "scaffold-smoke.md", _verification_doc(project)),
        (target / "gates" / "human-gates.md", _gate_doc(project)),
        (target / "memory" / ".gitkeep", ""),
        (target / "heartbeat-reports" / ".gitkeep", ""),
    ]

    copies = _copy_plan(target, sources)
    _ensure_no_conflicts([p for p, _ in writes] + [dst for _, dst in copies], force)

    created: list[Path] = []
    for dst, text in writes:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(text, encoding="utf-8", newline="\n")
        created.append(dst)

    for src, dst in copies:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        created.append(dst)

    return created


def _source_paths(root: Path) -> dict[str, Path]:
    return {
        "strato": root / "packages" / "strato" / "STRATO.md",
        "strato_templates": root / "packages" / "strato" / "templates",
        "strato_skill": root / "packages" / "strato" / ".claude" / "skills" / "strato",
        "claude_loops_skill": root / ".claude" / "skills" / "loops",
        "agents_loops_skill": root / ".agents" / "skills" / "loops",
    }


def _copy_plan(target: Path, sources: dict[str, Path]) -> list[tuple[Path, Path]]:
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
    return copies


def _ensure_no_conflicts(paths: list[Path], force: bool) -> None:
    existing = sorted({p for p in paths if p.exists()})
    if existing and not force:
        preview = "\n".join(f"  - {p}" for p in existing[:20])
        extra = "" if len(existing) <= 20 else f"\n  ... and {len(existing) - 20} more"
        raise ScaffoldError(
            "refusing to overwrite existing scaffold file(s); rerun with --force:\n"
            f"{preview}{extra}"
        )


def _workspace_readme(project: str, preset: str) -> str:
    return f"""# {project}

Vivary agent workspace scaffold.

Preset: {preset}

Start here:

1. Read `AGENTS.md` for the workspace contract.
2. Read `STATE.md` for current truth.
3. Fill `USER.md` and `MEMORY.md` locally; they are private and gitignored.
4. Use `tropo check --root .` to validate the typed workspace graph.

The scaffold includes tropo for typed workspace knowledge, strato for the agent OS,
runtime skills for Claude/Codex-style agents, and a starter graph under
`modules/`, `changes/`, `decisions/`, `verification/`, and `gates/`.
"""


def _workspace_gitignore() -> str:
    return """# Strato private context
USER.md
MEMORY.md
memory/*
!memory/.gitkeep
.strato/private/

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
"""


def _workspace_tropo_config() -> str:
    return """version = 1
exclude = [
  ".git",
  ".claude",
  ".agents",
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

The root agent workspace shell: state surface, human contract, private memory,
runtime skills, and typed graph folders.
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
    init.add_argument(
        "--repo-root",
        default=None,
        help="Vivary source checkout root (mainly for local development/tests)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command != "init":
        parser.print_help()
        return 2

    try:
        created = scaffold_workspace(
            args.target,
            preset=args.preset,
            force=args.force,
            repo_root=args.repo_root,
        )
    except ScaffoldError as exc:
        print(f"create-vivary: {exc}", file=sys.stderr)
        return 1

    print(f"create-vivary: wrote {len(created)} file(s) to {Path(args.target).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
