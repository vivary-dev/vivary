"""create-vivary: scaffold a complete Vivary agent workspace."""

from __future__ import annotations

import argparse
import base64
import configparser
import csv
import hashlib
import importlib
import importlib.machinery
import importlib.metadata as importlib_metadata
import importlib.util
import io
import json
import os
import platform
import re
import shutil
import site
import stat
import subprocess
import sys
import sysconfig
import tempfile
import time
from contextlib import contextmanager
from datetime import date, datetime, timezone
from email.parser import BytesParser
from email.message import Message
from pathlib import Path
from typing import Callable


if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class _WindowsDirectoryInformation(ctypes.Structure):
        _fields_ = [
            ("file_attributes", wintypes.DWORD),
            ("creation_time", wintypes.FILETIME),
            ("last_access_time", wintypes.FILETIME),
            ("last_write_time", wintypes.FILETIME),
            ("volume_serial_number", wintypes.DWORD),
            ("file_size_high", wintypes.DWORD),
            ("file_size_low", wintypes.DWORD),
            ("number_of_links", wintypes.DWORD),
            ("file_index_high", wintypes.DWORD),
            ("file_index_low", wintypes.DWORD),
        ]

    class _WindowsRenameInformation(ctypes.Structure):
        _fields_ = [
            ("replace_if_exists", wintypes.BOOLEAN),
            ("root_directory", wintypes.HANDLE),
            ("file_name_length", wintypes.DWORD),
            ("file_name", wintypes.WCHAR * 1),
        ]

    class _WindowsDispositionInformation(ctypes.Structure):
        _fields_ = [("delete_file", wintypes.BOOLEAN)]

    class _WindowsIoStatusBlock(ctypes.Structure):
        _fields_ = [
            ("status_or_pointer", ctypes.c_void_p),
            ("information", ctypes.c_size_t),
        ]

    _WINDOWS_KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _WINDOWS_CREATE_FILE = _WINDOWS_KERNEL32.CreateFileW
    _WINDOWS_CREATE_FILE.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    _WINDOWS_CREATE_FILE.restype = wintypes.HANDLE
    _WINDOWS_GET_FILE_INFO = _WINDOWS_KERNEL32.GetFileInformationByHandle
    _WINDOWS_GET_FILE_INFO.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_WindowsDirectoryInformation),
    ]
    _WINDOWS_GET_FILE_INFO.restype = wintypes.BOOL
    _WINDOWS_CLOSE_HANDLE = _WINDOWS_KERNEL32.CloseHandle
    _WINDOWS_CLOSE_HANDLE.argtypes = [wintypes.HANDLE]
    _WINDOWS_CLOSE_HANDLE.restype = wintypes.BOOL
    _WINDOWS_SET_FILE_INFO = _WINDOWS_KERNEL32.SetFileInformationByHandle
    _WINDOWS_SET_FILE_INFO.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    _WINDOWS_SET_FILE_INFO.restype = wintypes.BOOL
    _WINDOWS_NTDLL = ctypes.WinDLL("ntdll")
    _WINDOWS_NT_SET_FILE_INFO = _WINDOWS_NTDLL.NtSetInformationFile
    _WINDOWS_NT_SET_FILE_INFO.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_WindowsIoStatusBlock),
        wintypes.LPVOID,
        wintypes.ULONG,
        ctypes.c_int,
    ]
    _WINDOWS_NT_SET_FILE_INFO.restype = ctypes.c_long
    _WINDOWS_NT_STATUS_TO_DOS_ERROR = _WINDOWS_NTDLL.RtlNtStatusToDosError
    _WINDOWS_NT_STATUS_TO_DOS_ERROR.argtypes = [ctypes.c_long]
    _WINDOWS_NT_STATUS_TO_DOS_ERROR.restype = wintypes.ULONG
    _WINDOWS_INVALID_HANDLE = ctypes.c_void_p(-1).value
    _WINDOWS_FILE_READ_ATTRIBUTES = 0x00000080
    _WINDOWS_FILE_TRAVERSE = 0x00000020
    _WINDOWS_DELETE = 0x00010000
    _WINDOWS_GENERIC_READ = 0x80000000
    _WINDOWS_GENERIC_WRITE = 0x40000000
    _WINDOWS_FILE_SHARE_READ_WRITE = 0x00000001 | 0x00000002
    _WINDOWS_FILE_SHARE_DELETE = 0x00000004
    _WINDOWS_CREATE_NEW = 1
    _WINDOWS_OPEN_EXISTING = 3
    _WINDOWS_FILE_ATTRIBUTE_TEMPORARY = 0x00000100
    _WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x00000010
    _WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
    _WINDOWS_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _WINDOWS_FILE_RENAME_INFORMATION_CLASS = 10
    _WINDOWS_FILE_DISPOSITION_INFO_CLASS = 4


__version__ = "0.4.0"

PRESETS = ("coding", "second-brain", "knowledge-work", "writing")

ACTIVE_CONTEXTS = ("cocoindex-code",)

MEMORY_MODES = ("none", "local", "cognee")

SUBCOMMANDS = ("init", "doctor", "wizard", "capabilities", "adopt", "record")

RECEIPT_ENV = "VIVARY_RECEIPT_LOG"
RECEIPT_SCHEMA = "vivary.run_receipt.v1"
RECEIPT_VALUE_FLAGS = {
    "--adapter",
    "--receipt",
    "--preset",
    "--active-context",
    "--capsule",
    "--from",
    "--repo-root",
    "--storage",
    "--provider",
    "--recover",
    "--memory",
    "--plan",
    "--size",
    "--privacy",
}
RECEIPT_KNOWN_FLAGS = RECEIPT_VALUE_FLAGS | {
    "--auto",
    "--dry-run",
    "--force",
    "--help",
    "--json",
    "--no-wizard",
    "--obsidian",
    "--repair",
    "--trend",
    "--version",
    "--yes",
    "-h",
}
RECEIPT_RESERVED_WINDOWS_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

# The exact 15 files published in v0.1 are the strict common contract for every
# supported workspace. This literal must not be derived from repair markers or
# current scaffold output: neither may weaken a historical root or runtime-skill
# requirement.
BASELINE_WORKSPACE_FILES = (
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
    "templates/AGENTS.md",
    ".claude/skills/strato/SKILL.md",
    ".claude/skills/loops/SKILL.md",
    ".agents/skills/strato/SKILL.md",
    ".agents/skills/loops/SKILL.md",
)

# Kept for callers that name the published v0.1 requirement set. The baseline
# tuple above is the only owner so current scaffold additions cannot silently
# change legacy Doctor severity.
REQUIRED_WORKSPACE_FILES = BASELINE_WORKSPACE_FILES

# v0.2 introduced routed module indexes without changing the common v0.1
# workspace shell. Doctor recognizes both published contracts.
INDEXED_WORKSPACE_FILES = (
    "modules/index.md",
    "modules/agent-workspace/index.md",
)

THIN_WORKSPACE_FILES = (
    "AGENTS.md",
    ".gitignore",
    ".vivary/context.md",
    ".vivary/workspace.toml",
    "STATE.md",
)

# Private placeholders repair can regenerate, in report order. `USER.md` and `MEMORY.md`
# resolve to the same canonical templates `_copy_plan` scaffolds from — repair must not
# carry a second definition of them (see `_private_placeholder_text`). The `.gitkeep`
# files have no template; empty is their canonical content.
PRIVATE_PLACEHOLDER_PATHS = (
    "USER.md",
    "MEMORY.md",
    "memory/.gitkeep",
    "heartbeat-reports/.gitkeep",
)
PRIVATE_PLACEHOLDER_TEMPLATES = {
    "USER.md": "USER.template.md",
    "MEMORY.md": "MEMORY.template.md",
}
PRIVATE_PLACEHOLDER_LITERALS = {
    "memory/.gitkeep": "",
    "heartbeat-reports/.gitkeep": "",
}

PRIVACY_IGNORE_PROBES = {
    "USER.md": ("USER.md",),
    "MEMORY.md": ("MEMORY.md",),
    "memory/*": ("memory/private.md", "memory/private.txt", "memory/secret.md"),
    "heartbeat-reports/*": (
        "heartbeat-reports/private.md",
        "heartbeat-reports/private.txt",
        "heartbeat-reports/summary.json",
    ),
    ".strato/private/": (
        ".strato/private/secret.md",
        ".strato/private/session.json",
    ),
    "*.vivary-tmp": (
        ".USER.md.abc.vivary-tmp",
        "modules/codebase/.index.md.abc.vivary-tmp",
    ),
}

PRIVACY_IGNORE_REPAIR_LINES = {
    "USER.md": "USER.md",
    "MEMORY.md": "MEMORY.md",
    "memory/*": "memory/*\n!memory/.gitkeep",
    "heartbeat-reports/*": "heartbeat-reports/*\n!heartbeat-reports/.gitkeep",
    ".strato/private/": ".strato/private/",
    "*.vivary-tmp": "*.vivary-tmp",
}

PUBLISHED_BASELINE_PRIVACY_IGNORES = (
    "USER.md",
    "MEMORY.md",
    "memory/*",
    ".strato/private/",
)
PUBLISHED_MEMORY_PRIVACY_IGNORES = (
    "USER.md",
    "MEMORY.md",
    "memory/*",
    "heartbeat-reports/*",
    ".strato/private/",
)

REPAIR_WORKSPACE_MARKERS = (
    "tropo.toml",
    "AGENTS.md",
    "STRATO.md",
)
REPAIR_MODULE_CONTRACT_MARKERS = (
    "modules/index.md",
    "modules/agent-workspace/index.md",
    "modules/agent-workspace.md",
)

# Repair markers only identify targets that `doctor --repair` may safely plan
# against. They deliberately do not set Doctor's compatibility severity.
#
WORKSPACE_COMPATIBILITY_SCHEMA_VERSION = 2
LEGACY_WORKSPACE_CONTRACT = "legacy-v0.1"
INDEXED_WORKSPACE_CONTRACT = "indexed-v0.2+"
LEGACY_FULL_WORKSPACE_CONTRACT = "legacy-full"
LEGACY_RECOMMENDED_WORKSPACE_FILES = INDEXED_WORKSPACE_FILES
_WORKSPACE_PRESET_BYTE_LIMIT = 64 * 1024

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


class RepairRefusal(ScaffoldError):
    """Raised when a repair is refused for a reason worth reporting by name.

    Subclasses `ScaffoldError` so every existing `except ScaffoldError` handler keeps
    working unchanged; `reason_code` is what lets a caller say *why* it refused rather
    than guessing at a single catch-all cause.
    """

    def __init__(self, message: str, *, reason_code: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _is_symlink_or_junction(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
    except OSError:
        pass

    try:
        attrs = os.stat(path, follow_symlinks=False).st_file_attributes
    except (AttributeError, OSError):
        attrs = 0
    if attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
        return True

    is_junction = getattr(path, "is_junction", None)
    if is_junction is None:
        return False
    try:
        return bool(is_junction())
    except OSError:
        return False


def _reparse_point_is_dir(path: Path) -> bool:
    """Whether `path` is a reparse point that the OS treats as a directory.

    Windows junctions and directory symlinks must be removed with `rmdir`, not
    `unlink`. Returns `False` on POSIX — `st_file_attributes` does not exist there, and
    routing a symlink-to-directory to `os.rmdir` would raise ENOTDIR.
    """
    try:
        st = os.stat(path, follow_symlinks=False)
        attrs = st.st_file_attributes
    except (AttributeError, OSError):
        return False
    reparse = attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    directory = attrs & getattr(stat, "FILE_ATTRIBUTE_DIRECTORY", 0x10)
    return bool(reparse and directory)


def _has_multiple_hardlinks(path: Path) -> bool:
    try:
        return path.exists() and path.is_file() and os.stat(path).st_nlink > 1
    except OSError:
        return False


def _read_repair_text(path: Path) -> str:
    if _has_multiple_hardlinks(path):
        raise RepairRefusal(
            f"refusing to rewrite multi-linked file: {path}", reason_code="hardlinked"
        )
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise RepairRefusal(
            f"refusing to rewrite non-UTF-8 file: {path}", reason_code="non-utf8"
        ) from exc


def _resolve_scaffold_target(target: str | Path) -> Path:
    requested = Path(target)
    absolute = requested if requested.is_absolute() else Path.cwd() / requested
    current = Path(absolute.anchor) if absolute.anchor else Path()
    parts = absolute.parts[1:] if absolute.anchor else absolute.parts
    for part in parts:
        current = current / part
        if current.exists() or _is_symlink_or_junction(current):
            if _is_symlink_or_junction(current):
                raise ScaffoldError(
                    "refusing to scaffold through symlinked target path or junction: "
                    f"{current}"
                )
        else:
            break
    return absolute.resolve(strict=False)


def _resolve_doctor_repair_target(target: str | Path) -> Path:
    requested = Path(target)
    absolute = requested if requested.is_absolute() else Path.cwd() / requested
    current = Path(absolute.anchor) if absolute.anchor else Path()
    parts = absolute.parts[1:] if absolute.anchor else absolute.parts
    for part in parts:
        current = current / part
        if current.exists() or _is_symlink_or_junction(current):
            if _is_symlink_or_junction(current):
                raise ScaffoldError(
                    "refusing to repair through symlinked target path or junction: "
                    f"{current}"
                )
        else:
            break
    return absolute.resolve(strict=False)


def _build_scaffold_plan(
    target: Path,
    sources: dict[str, Path],
    *,
    preset: str,
    obsidian: bool,
    active_context: str | None,
    memory: str,
    preserve_cocoindex_ignore: bool = False,
) -> tuple[list[tuple[Path, str]], list[tuple[Path, Path]]]:
    """Build the (writes, copies) plan for a full scaffold at `target`.

    Pure planning: computes destinations and generated text/copy sources without
    touching disk. Shared by `scaffold_workspace` (init/wizard) and `adopt_workspace`
    (brownfield adopt), which filters this same plan down to files that don't
    already exist.
    """
    project = target.name or "vivary-workspace"
    today = date.today().isoformat()

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
    return writes, copies


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

    preserve_cocoindex_ignore = (
        active_context != "cocoindex-code"
        and force
        and (target / ".cocoindex_code").exists()
    )

    writes, copies = _build_scaffold_plan(
        target,
        sources,
        preset=preset,
        obsidian=obsidian,
        active_context=active_context,
        memory=memory,
        preserve_cocoindex_ignore=preserve_cocoindex_ignore,
    )
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


def _validate_thin_init_target(target: Path, *, force: bool) -> None:
    """Refuse brownfield or legacy targets before prompts, installs, or writes."""
    if target.exists() and not target.is_dir():
        raise ScaffoldError(f"init target is not a directory: {target}")
    if target.exists():
        try:
            has_content = next(target.iterdir(), None) is not None
        except OSError as exc:
            raise ScaffoldError(f"cannot inspect init target: {exc}") from exc
        if has_content:
            raise ScaffoldError(
                "init requires a new or empty directory; use create-vivary adopt "
                "for every existing workspace, including thin workspaces"
            )


def scaffold_thin_workspace(
    target: str | Path,
    *,
    preset: str = "coding",
    adapters: tuple[str, ...] | list[str] = (),
    active_context: str | None = None,
    force: bool = False,
    repo_root: str | Path | None = None,
    dry_run: bool = False,
) -> list[Path]:
    """Create a greenfield thin-v0.3 governed-context workspace.

    This is the public `init` path. The older `scaffold_workspace` remains only
    as a bounded legacy-fixture/read-compatibility helper while v0.1/v0.2
    workspaces are still supported by Doctor.
    """
    if preset not in PRESETS:
        raise ScaffoldError(
            f"unknown preset {preset!r}; expected one of {', '.join(PRESETS)}"
        )
    selected_adapters = tuple(adapters)
    unknown_adapters = sorted(set(selected_adapters) - set(_THIN_ADAPTER_PATHS))
    if unknown_adapters:
        raise ScaffoldError(
            "unknown adapter(s): " + ", ".join(unknown_adapters)
            + "; expected agents or claude"
        )
    if len(set(selected_adapters)) != len(selected_adapters):
        raise ScaffoldError("each --adapter value may be selected only once")
    if active_context is not None:
        if active_context not in ACTIVE_CONTEXTS:
            raise ScaffoldError(
                f"unknown active context {active_context!r}; expected one of "
                f"{', '.join(ACTIVE_CONTEXTS)}"
            )
        if preset != "coding":
            raise ScaffoldError(
                "active context 'cocoindex-code' currently requires the coding preset"
            )

    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target = _resolve_scaffold_target(target)
    _validate_thin_init_target(target, force=force)

    project = target.name or "vivary-workspace"
    writes: list[tuple[Path, str]] = [
        (target / ".gitignore", _thin_gitignore_block(active_context=active_context)),
        (target / ".vivary" / "context.md", _thin_context_doc(project, preset)),
        (
            target / ".vivary" / "workspace.toml",
            _thin_workspace_toml(
                preset,
                selected_adapters,
                active_context=active_context,
            ),
        ),
        (target / "AGENTS.md", "# AGENTS.md\n\n" + _thin_agents_block()),
        (target / "STATE.md", _thin_state_doc()),
    ]
    for adapter in sorted(selected_adapters):
        text, _source_hash, _content_hash = _thin_adapter_doc(adapter)
        writes.append((target / _THIN_ADAPTER_PATHS[adapter], text))

    paths = [path for path, _text in writes]
    _ensure_safe_destinations(target, paths, force=False)
    if dry_run:
        return paths

    actions = []
    backups: dict[Path, bytes | None] = {}
    for path, text in writes:
        before = path.read_bytes() if path.exists() else None
        backups[path] = before
        actions.append(
            {
                "kind": "replace" if before is not None else "create",
                "path": path,
                "before_hash": _sha256_prefixed(before) if before is not None else None,
                "after": text.encode("utf-8"),
            }
        )

    try:
        for action in actions:
            _write_bytes_no_follow(
                target,
                action["path"],
                action["after"],
                replace_existing=False,
            )
        doctor = doctor_workspace(target, repo_root=root)
        if not doctor["ok"]:
            raise ScaffoldError(
                "Doctor failed after init: " + "; ".join(doctor["errors"])
            )
    except Exception as exc:
        try:
            _rollback_adopt(target, actions, backups, cleanup_journal=False)
        except ScaffoldError as rollback_exc:
            raise ScaffoldError(f"{exc}; {rollback_exc}") from exc
        for path in sorted(
            {
                parent
                for path in paths
                for parent in path.parents
                if parent != target and target in parent.parents
            },
            key=lambda item: len(item.parts),
            reverse=True,
        ):
            try:
                path.rmdir()
            except OSError:
                pass
        if isinstance(exc, ScaffoldError):
            raise
        raise ScaffoldError(f"init failed and rolled back: {exc}") from exc
    return paths


def _empty_workspace_compatibility() -> dict:
    return {
        "schema_version": WORKSPACE_COMPATIBILITY_SCHEMA_VERSION,
        "workspace_contract": None,
        "legacy_layout": None,
        "baseline_missing": [],
        "contract_missing": [],
        "declared_capability_problems": [],
        "recommended_missing": [],
        "recommended_upgrade": None,
    }

def _workspace_declared_preset(target: Path) -> str:
    """Return a supported `Preset:` declaration or an explicit safe placeholder."""
    thin_config = target / ".vivary" / "workspace.toml"
    if thin_config.is_file() and not _is_symlink_or_junction(thin_config):
        try:
            import tomllib as _toml

            data = _toml.loads(thin_config.read_text(encoding="utf-8-sig"))
            workspace = data.get("workspace", {})
            if (
                isinstance(workspace, dict)
                and workspace.get("contract") == THIN_WORKSPACE_CONTRACT
                and workspace.get("preset") in PRESETS
            ):
                return workspace["preset"]
        except (OSError, UnicodeError, _toml.TOMLDecodeError):
            return "<preset>"

    readme_path = target / "README.md"
    descriptor = None
    try:
        if _is_symlink_or_junction(readme_path):
            return "<preset>"
        before = os.stat(readme_path, follow_symlinks=False)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_size > _WORKSPACE_PRESET_BYTE_LIMIT
        ):
            return "<preset>"

        flags = (
            os.O_RDONLY
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        descriptor = os.open(readme_path, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_size > _WORKSPACE_PRESET_BYTE_LIMIT
            or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
        ):
            return "<preset>"
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            payload = handle.read(_WORKSPACE_PRESET_BYTE_LIMIT + 1)
        if len(payload) > _WORKSPACE_PRESET_BYTE_LIMIT:
            return "<preset>"
        readme = payload.decode("utf-8-sig")
    except (OSError, UnicodeError, ValueError):
        return "<preset>"
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass

    match = re.search(r"(?mi)^Preset:\s*([^\r\n]+?)\s*$", readme)
    preset = match.group(1).strip() if match else ""
    return preset if preset in PRESETS else "<preset>"


def _workspace_contract(target: Path) -> tuple[str | None, list[str]]:
    """Classify a published module layout without inferring a new requirement."""
    if (target / ".vivary" / "workspace.toml").exists():
        return THIN_WORKSPACE_CONTRACT, []
    indexed_present = any((target / rel).exists() for rel in INDEXED_WORKSPACE_FILES)
    if indexed_present:
        return (
            INDEXED_WORKSPACE_CONTRACT,
            [rel for rel in INDEXED_WORKSPACE_FILES if not (target / rel).exists()],
        )
    if (target / "modules" / "agent-workspace.md").is_file():
        return LEGACY_WORKSPACE_CONTRACT, []
    # A shell that carries neither published module signature is not silently
    # upgraded into a hard error. Its common baseline remains fully strict.
    return None, []


def _missing_declared_config_fields(
    section: object,
    fields: dict[str, type],
    *,
    require_nonempty_strings: bool = False,
) -> list[str]:
    """Return fields that do not satisfy the selected config schema."""
    if not isinstance(section, dict):
        return list(fields)
    return [
        key
        for key, expected_type in fields.items()
        if not isinstance(section.get(key), expected_type)
        or (
            require_nonempty_strings
            and expected_type is str
            and not section[key]
        )
    ]


def _declared_storage_capability_problems(target: Path) -> tuple[str, list[str]]:
    """Return the declared storage backend and any missing declared configuration."""
    cfg_path = target / _STORAGE_DIR / _STORAGE_CONFIG_NAME
    if not cfg_path.exists():
        # File storage predates the optional config and remains the legacy default.
        return "file", []

    try:
        import tomllib as _toml

        data = _toml.loads(cfg_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        return "unknown", [
            f"declared capability storage configuration unreadable: "
            f"{_STORAGE_DIR}/{_STORAGE_CONFIG_NAME} ({exc})"
        ]

    storage = data.get("storage") if isinstance(data, dict) else None
    if not isinstance(storage, dict):
        return "unknown", ["declared capability storage missing required [storage] configuration"]

    backend = storage.get("backend")
    if not isinstance(backend, str) or not backend:
        return "unknown", ["declared capability storage missing required storage.backend"]
    if backend == "file":
        return backend, []

    storage_schemas = _DECLARED_CONFIG_SCHEMAS["storage"]
    if backend == "embedded":
        section = storage.get("embedded")
        fields = storage_schemas["embedded"]
    elif backend == "cloud":
        section = storage.get("cloud")
        if not isinstance(section, dict):
            return backend, [
                "declared capability storage:cloud missing required "
                "[storage.cloud] configuration"
            ]
        provider = section.get("provider")
        cloud_schemas = storage_schemas["cloud"]
        if not isinstance(provider, str):
            return backend, [
                "declared capability storage:cloud missing required "
                "storage.cloud.provider"
            ]
        if provider not in cloud_schemas:
            return backend, [
                f"declared capability storage:cloud has unknown provider: {provider!r}"
            ]
        fields = cloud_schemas[provider]
    else:
        return "unknown", [f"declared capability storage has unknown backend: {backend!r}"]

    if not isinstance(section, dict):
        return backend, [
            f"declared capability storage:{backend} missing required "
            f"[storage.{backend}] configuration"
        ]

    return backend, [
        f"declared capability storage:{backend} missing required "
        f"storage.{backend}.{key}"
        for key in _missing_declared_config_fields(
            section,
            fields,
            require_nonempty_strings=True,
        )
    ]


def _normalize_memory_private_path(path: str) -> str:
    normalized = path.replace("\\", "/").strip("/")
    if normalized.endswith("/**"):
        return normalized[:-3]
    return normalized


def _declared_memory_capability_problems(target: Path, memory_report: dict) -> list[str]:
    """Validate every field owned by the selected semantic-memory template."""
    if not memory_report["enabled"] or memory_report["status"] == "misconfigured":
        return []

    try:
        import tomllib as _toml

        data = _toml.loads(
            (target / _STORAGE_DIR / _MEMORY_CONFIG_NAME).read_text(encoding="utf-8-sig")
        )
    except Exception:
        # `_memory_report` reports a malformed declaration as an error.
        return []

    memory = data.get("memory")
    if not isinstance(memory, dict):
        return []

    schemas = _DECLARED_CONFIG_SCHEMAS["memory"]
    problems = [
        f"declared capability memory missing required memory.{key}"
        for key in _missing_declared_config_fields(memory, schemas["root"])
    ]
    if memory.get("mode") != "semantic-provider":
        problems.append(
            f"declared capability memory has unsupported memory.mode: {memory.get('mode')!r}"
        )

    privacy = memory.get("privacy")
    if not isinstance(privacy, dict):
        problems.append(
            "declared capability memory missing required [memory.privacy] configuration"
        )
    else:
        problems.extend(
            f"declared capability memory missing required memory.privacy.{key}"
            for key in _missing_declared_config_fields(privacy, schemas["privacy"])
        )
        for key in ("respect_gitignore", "respect_vivary_private", "fail_closed"):
            if isinstance(privacy.get(key), bool) and not privacy[key]:
                problems.append(
                    f"declared capability memory requires memory.privacy.{key} = true"
                )
        private_paths = privacy.get("private_paths")
        if isinstance(private_paths, list) and not all(
            isinstance(path, str) for path in private_paths
        ):
            problems.append(
                "declared capability memory requires memory.privacy.private_paths "
                "to contain only strings"
            )
        if isinstance(private_paths, list) and all(
            isinstance(path, str) for path in private_paths
        ):
            normalized_private_paths = {
                _normalize_memory_private_path(path) for path in private_paths
            }
            missing_private_paths = [
                path
                for path in _MEMORY_PUBLISHED_PRIVATE_PATHS
                if _normalize_memory_private_path(path)
                not in normalized_private_paths
            ]
            if missing_private_paths:
                problems.append(
                    "declared capability memory requires "
                    "memory.privacy.private_paths to include: "
                    + ", ".join(missing_private_paths)
                )

    provider = memory_report["provider"]
    schema = schemas["providers"].get(provider)
    if schema is None:
        # `_memory_report` owns the missing- or unknown-provider error.
        return problems
    section_name, fields, optional_fields = schema
    capability = "memory:local" if provider == "vivary-local" else "memory:cognee"

    section = memory.get(section_name)
    if not isinstance(section, dict):
        problems.append(
            f"declared capability {capability} missing required "
            f"[memory.{section_name}] configuration"
        )
        return problems
    problems.extend(
        f"declared capability {capability} missing required memory.{section_name}.{key}"
        for key in _missing_declared_config_fields(section, fields)
    )
    if any(key in section for key in optional_fields):
        problems.extend(
            f"declared capability {capability} missing required "
            f"memory.{section_name}.{key}"
            for key in _missing_declared_config_fields(section, optional_fields)
        )
    return problems


def _workspace_compatibility(target: Path, memory_report: dict) -> tuple[dict, str]:
    """Classify published workspace ownership; integrity and privacy stay strict."""
    compatibility = _empty_workspace_compatibility()
    contract, contract_missing = _workspace_contract(target)
    required_files = (
        THIN_WORKSPACE_FILES if contract == THIN_WORKSPACE_CONTRACT else BASELINE_WORKSPACE_FILES
    )
    compatibility["baseline_missing"] = [
        rel for rel in required_files if not (target / rel).exists()
    ]
    compatibility["workspace_contract"] = (
        LEGACY_FULL_WORKSPACE_CONTRACT
        if contract in (LEGACY_WORKSPACE_CONTRACT, INDEXED_WORKSPACE_CONTRACT)
        else contract
    )
    compatibility["legacy_layout"] = (
        contract
        if contract in (LEGACY_WORKSPACE_CONTRACT, INDEXED_WORKSPACE_CONTRACT)
        else None
    )
    compatibility["contract_missing"] = contract_missing
    if contract == LEGACY_WORKSPACE_CONTRACT:
        compatibility["recommended_missing"] = [
            rel
            for rel in LEGACY_RECOMMENDED_WORKSPACE_FILES
            if not (target / rel).exists()
        ]
        preset = _workspace_declared_preset(target)
        compatibility["recommended_upgrade"] = (
            "run create-vivary adopt <workspace> "
            f"--preset {preset} --json to review the thin-v0.3 contract; apply only "
            "the approved plan with --yes --plan <plan_hash>"
        )

    backend, storage_problems = _declared_storage_capability_problems(target)
    compatibility["declared_capability_problems"] = [
        *storage_problems,
        *_declared_memory_capability_problems(target, memory_report),
    ]
    return compatibility, backend


def doctor_workspace(
    target: str | Path,
    *,
    repo_root: str | Path | None = None,
    _allow_adopt_journal: bool = False,
) -> dict:
    """Validate that a directory looks like a usable Vivary agent workspace."""
    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target = Path(target).resolve()
    errors: list[str] = []
    warnings: list[str] = []
    memory_report, memory_privacy_requirements = _memory_report(target)
    compatibility = _empty_workspace_compatibility()
    backend_name = "file"
    declared_preset = _workspace_declared_preset(target) if target.is_dir() else None
    capability_summary = _build_capability_report(
        declared_preset if declared_preset in PRESETS else None
    )

    if not target.exists():
        errors.append(f"workspace does not exist: {target}")
    elif not target.is_dir():
        errors.append(f"workspace is not a directory: {target}")

    if (
        not errors
        and not _allow_adopt_journal
        and (target / ".vivary" / "runtime" / "adopt-journal.json").exists()
    ):
        errors.append(
            "unfinished adoption journal exists; run create-vivary adopt <workspace> "
            "--recover <plan-hash> before continuing"
        )

    if not errors and not _allow_adopt_journal:
        gitignore = target / ".gitignore"
        if gitignore.is_file() and not _is_symlink_or_junction(gitignore):
            try:
                gitignore_bytes = gitignore.read_bytes()
            except OSError as exc:
                errors.append(f"cannot inspect .gitignore for interrupted adoption: {exc}")
            else:
                prejournal = _prejournal_privacy_match(gitignore_bytes)
                if prejournal is not None:
                    interrupted_hash = prejournal.group(1).decode("ascii")
                    errors.append(
                        "unfinished pre-journal adoption privacy replacement exists; "
                        "run create-vivary adopt <workspace> "
                        f"--recover {interrupted_hash} before continuing"
                    )
                elif _ADOPT_PREJOURNAL_MARKER_PREFIX.encode("ascii") in gitignore_bytes:
                    errors.append("malformed pre-journal adoption marker exists in .gitignore")

    if not errors:
        compatibility, backend_name = _workspace_compatibility(target, memory_report)
        errors.extend(
            f"missing required file: {rel}"
            for rel in compatibility["baseline_missing"]
        )
        errors.extend(
            f"missing required indexed contract file: {rel}"
            for rel in compatibility["contract_missing"]
        )
        warnings.extend(
            f"recommended workspace file missing: {rel}"
            for rel in compatibility["recommended_missing"]
        )
        if compatibility["recommended_upgrade"] is not None:
            warnings.append(compatibility["recommended_upgrade"])

        if compatibility["workspace_contract"] == THIN_WORKSPACE_CONTRACT:
            if (target / ".gitignore").exists():
                errors.extend(
                    f"privacy ignore missing: {pattern}"
                    for pattern in _missing_thin_privacy_ignores(target)
                )
        elif (target / ".gitignore").exists():
            missing = _missing_privacy_ignores(target)
            if memory_report["enabled"]:
                required_missing = [
                    pattern
                    for pattern in missing
                    if pattern in memory_privacy_requirements
                ]
                warnings.extend(
                    f"recommended privacy ignore missing: {pattern}; add it to .gitignore"
                    for pattern in missing
                    if pattern not in memory_privacy_requirements
                )
            else:
                required_missing = [
                    pattern
                    for pattern in missing
                    if pattern in PUBLISHED_BASELINE_PRIVACY_IGNORES
                ]
                warnings.extend(
                    f"recommended privacy ignore missing: {pattern}; add it to .gitignore"
                    for pattern in missing
                    if pattern not in PUBLISHED_BASELINE_PRIVACY_IGNORES
                )
            errors.extend(
                f"privacy ignore missing: {pattern}" for pattern in required_missing
            )
        if compatibility["workspace_contract"] != THIN_WORKSPACE_CONTRACT:
            errors.extend(_module_index_errors(target))

    graph = {"nodes": 0, "edges": 0, "broken": 0}
    if not errors:
        try:
            _tropo, _resolver, docs, nodes, edges = _doctor_graph_context(target, root)
            findings = [f.render() for doc in docs for f in doc.findings]
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

    if target.is_dir():
        # Declaration failures must not suppress graph/trend metrics. The graph is a
        # read-only observation of the workspace, independent of optional providers.
        errors.extend(compatibility["declared_capability_problems"])
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
        "compatibility": compatibility,
        "capabilities": capability_summary,
    }


def doctor_repair_workspace(
    target: str | Path,
    *,
    repo_root: str | Path | None = None,
    yes: bool = False,
) -> dict:
    """Plan or apply deterministic doctor repairs, then return a doctor report."""
    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    try:
        target = _resolve_doctor_repair_target(target)
    except ScaffoldError as exc:
        return _doctor_repair_error_report(target, yes=yes, error=exc)

    initial = doctor_workspace(target, repo_root=root)
    if initial["compatibility"]["workspace_contract"] == LEGACY_FULL_WORKSPACE_CONTRACT:
        actions = _doctor_repair_actions(target, root)
        initial["warnings"].append(
            "legacy-full repair is unavailable; Doctor is report-only for legacy "
            "workspaces; review a thin adoption plan for any approved change"
        )
        initial["repair"] = {"mode": "report-only", "actions": actions}
        return initial

    actions = _doctor_repair_actions(target, root)
    if yes:
        for action in actions:
            if action["status"] != "safe":
                continue
            try:
                _apply_doctor_repair_action(target, root, action)
            except (OSError, ScaffoldError) as exc:
                action["status"] = "refused"
                action["applied"] = False
                action["summary"] = f"{action['summary']} Refused: {exc}"
            else:
                action["status"] = "applied"
                action["applied"] = True

    report = doctor_workspace(target, repo_root=root)
    report["repair"] = {
        "mode": "applied" if yes else "dry-run",
        "actions": actions,
    }
    refused = [a for a in actions if a["status"] == "refused"]
    if refused:
        report["errors"].extend(
            f"repair refused: {a['path']}: {a['summary']}" for a in refused
        )
        report["ok"] = False
    return report


def _doctor_repair_error_report(target: str | Path, *, yes: bool, error: Exception) -> dict:
    return {
        "ok": False,
        "root": str(target),
        "errors": [f"doctor --repair: {error}"],
        "warnings": [],
        "graph": {"nodes": 0, "edges": 0, "broken": 0},
        "backend": "unknown",
        "memory": {
            "enabled": False,
            "provider": "none",
            "mode": "none",
            "status": "disabled",
            "config": None,
            "privacy": "not-indexed",
            "detail": "doctor repair refused to inspect target",
        },
        "compatibility": _empty_workspace_compatibility(),
        "capabilities": _build_capability_report(None),
        "repair": {
            "mode": "applied" if yes else "dry-run",
            "actions": [],
        },
    }


def _doctor_graph_context(target: Path, root: Path):
    tropo = _load_tropo(root)
    resolver = tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
    docs = tropo.analyze(str(target), [], resolver)
    nodes, edges = tropo.build_graph(docs)
    return tropo, resolver, docs, nodes, edges


def _repair_action(
    kind: str,
    status: str,
    path: str,
    summary: str,
    *,
    details: dict | None = None,
) -> dict:
    action = {
        "kind": kind,
        "status": status,
        "path": path.replace("\\", "/"),
        "summary": summary,
        "applied": False,
    }
    if details:
        action["details"] = details
    return action


def _doctor_repair_actions(target: Path, root: Path) -> list[dict]:
    actions: list[dict] = []
    if not target.exists() or not target.is_dir():
        return actions
    if not _looks_like_vivary_workspace(target):
        return [
            _repair_action(
                "workspace",
                "manual",
                ".",
                (
                    "Target does not look like a Vivary workspace; run "
                    "`create-vivary init` for a new workspace or "
                    "`create-vivary adopt` for an existing project."
                ),
                details={
                    "required_markers": list(REPAIR_WORKSPACE_MARKERS),
                    "module_contract_any_of": list(REPAIR_MODULE_CONTRACT_MARKERS),
                },
            )
        ]

    actions.extend(_private_placeholder_repair_actions(target))
    actions.extend(_privacy_gitignore_repair_actions(target))

    try:
        _tropo, resolver, docs, _nodes, edges = _doctor_graph_context(target, root)
    except Exception:
        return actions

    actions.extend(_tropo_repair_actions(docs))
    actions.extend(_exo_guidance_actions(resolver, docs, edges))
    return actions


def _looks_like_vivary_workspace(target: Path) -> bool:
    thin_markers = (
        rel for rel in THIN_WORKSPACE_FILES if rel != ".gitignore"
    )
    if all((target / rel).is_file() for rel in thin_markers):
        return True
    has_module_contract = any(
        (target / rel).is_file() for rel in REPAIR_MODULE_CONTRACT_MARKERS
    )
    return has_module_contract and all(
        (target / marker).exists() for marker in REPAIR_WORKSPACE_MARKERS
    )


def _private_placeholder_text(root: Path, rel: str) -> str:
    """Canonical content for a private placeholder.

    `USER.md` and `MEMORY.md` are read from the same templates `_copy_plan` scaffolds
    from, so a repaired workspace gets exactly what a fresh one would — including the
    identity, privacy-boundary, decision and open-loop prompts — and future template
    edits reach repaired workspaces instead of drifting away from a second copy.
    """
    template = PRIVATE_PLACEHOLDER_TEMPLATES.get(rel)
    if template is None:
        return PRIVATE_PLACEHOLDER_LITERALS[rel]
    source = _source_paths(root)["strato_templates"] / template
    try:
        return source.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        # `UnicodeDecodeError` is a `ValueError`, so it escaped the old `OSError`-only
        # handler here *and* the apply loop's `except (OSError, ScaffoldError)`. Not
        # `_read_repair_text`: that adds a multi-hardlink refusal, which is meaningful
        # for a workspace file being rewritten and wrong for a read-only template.
        raise ScaffoldError(f"could not read canonical template {source}: {exc}")


def _private_placeholder_repair_actions(target: Path) -> list[dict]:
    actions: list[dict] = []
    for rel in PRIVATE_PLACEHOLDER_PATHS:
        path = target / rel
        unsafe = _unsafe_repair_component(target, path)
        if unsafe is not None:
            actions.append(
                _repair_action(
                    "placeholder",
                    "refused",
                    rel,
                    (
                        "Refusing to repair private/runtime placeholder through "
                        f"unsafe existing path component `{unsafe}`."
                    ),
                )
            )
        elif path.exists() and not path.is_file():
            actions.append(
                _repair_action(
                    "placeholder",
                    "refused",
                    rel,
                    "Refusing to replace existing non-file private/runtime placeholder.",
                )
            )
        elif not path.exists():
            actions.append(
                _repair_action(
                    "placeholder",
                    "safe",
                    rel,
                    f"Regenerate missing ignored private/runtime placeholder `{rel}`.",
                )
            )
    return actions


def _unsafe_repair_component(target: Path, path: Path) -> Path | None:
    for component in _existing_components(target, path):
        if component == target:
            continue
        if _is_symlink_or_junction(component):
            return component
        if component == path and _has_multiple_hardlinks(component):
            return component
        if component != path and component.is_file():
            return component
    return None


def _privacy_gitignore_repair_actions(target: Path) -> list[dict]:
    gitignore = target / ".gitignore"
    if _is_symlink_or_junction(gitignore):
        return [
            _repair_action(
                "gitignore",
                "refused",
                ".gitignore",
                "Refusing to inspect or edit symlinked `.gitignore`.",
            )
        ]
    if gitignore.exists() and not gitignore.is_file():
        return [
            _repair_action(
                "gitignore",
                "refused",
                ".gitignore",
                "Refusing to inspect or edit non-file `.gitignore`.",
            )
        ]
    if gitignore.exists():
        try:
            _read_repair_text(gitignore)
        except ScaffoldError as exc:
            return [
                _repair_action(
                    "gitignore",
                    "refused",
                    ".gitignore",
                    f"Refusing to inspect or edit `.gitignore`: {exc}",
                )
            ]
    missing_with_nested = (
        list(PRIVACY_IGNORE_REPAIR_LINES)
        if not gitignore.exists()
        else _missing_privacy_ignores(target)
    )
    missing_root_only = (
        missing_with_nested
        if not gitignore.exists()
        else _missing_privacy_ignores(target, include_nested=False)
    )
    nested_only = _unfixable_privacy_blockers(target, missing_with_nested)
    # An append that provably will not fix the pattern must not be offered as `safe`,
    # or repair rewrites `.gitignore` on every run without ever converging.
    missing_root_only = [
        pattern for pattern in missing_root_only if pattern not in set(nested_only)
    ]
    actions: list[dict] = []
    if missing_root_only:
        actions.append(
            _repair_action(
                "gitignore",
                "safe",
                ".gitignore",
                "Append missing privacy ignore rules without removing existing rules.",
                details={"missing": missing_root_only},
            )
        )
    if nested_only:
        actions.append(
            _repair_action(
                "gitignore",
                "manual",
                ".",
                (
                    "Lower-level `.gitignore` rules still unignore private/runtime "
                    "paths; inspect nested ignore files before rerunning repair."
                ),
                details={"missing": nested_only},
            )
        )
    return actions


def _tropo_repair_actions(docs) -> list[dict]:
    actions: list[dict] = []
    for doc in docs:
        rel = doc.rel.replace("\\", "/")
        w210_findings = [finding for finding in doc.findings if finding.code == "W210"]
        if w210_findings:
            safe, manual = _w210_removal_plan(doc, w210_findings)
        else:
            safe, manual = [], []
        if safe:
            actions.append(
                _repair_action(
                    "tropo-w210",
                    "safe",
                    rel,
                    "Remove redundant derived frontmatter fields reported as W210.",
                    details={
                        "remove": [item["key"] for item in safe],
                        "lines": [item["line"] for item in safe],
                    },
                )
            )
        if manual:
            actions.append(
                _repair_action(
                    "tropo-w210",
                    "manual",
                    rel,
                    _w210_manual_summary(manual),
                    details={"manual": manual},
                )
            )
        for finding in doc.findings:
            if finding.code != "W220":
                continue
            field, missing = _parse_w220_message(finding.message)
            summary = (
                f"Broken ref in `{field}` points to missing id `{missing}`. "
                "Manual options: create the missing typed node, rename the ref, "
                "or remove the edge."
            )
            actions.append(
                _repair_action(
                    "tropo-w220",
                    "manual",
                    finding.path,
                    summary,
                    details={
                        "field": field,
                        "missing_id": missing,
                        "line": finding.line,
                        "options": [
                            "create the missing typed node",
                            "rename the ref",
                            "remove the edge",
                        ],
                    },
                )
            )
    return actions


# A W210 field can only be removed automatically when its line is a simple top-level
# scalar. These indicators open a block scalar, whose value continues onto following
# lines, so deleting the one line would silently orphan the rest. Shared by the planner
# and `_apply_w210_fix`: if the two definitions drifted, the planner would call a field
# safe and the apply step would then refuse it.
W210_BLOCK_SCALAR_INDICATORS = {"|", ">", "|-", ">-", "|+", ">+"}

W210_COMPLEX_SUMMARY = "W210 derived metadata uses complex YAML; remove it manually."
W210_MANUAL_REASON_TEXT = {
    "complex": "the field is not a simple top-level scalar",
    "stale": "the reported line no longer matches the field",
    "hardlinked": "the file has multiple hard links",
    "non-utf8": "the file is not UTF-8",
    "unreadable": "the file could not be read",
}
W210_MANUAL_REASON_ORDER = ("complex", "stale", "hardlinked", "non-utf8", "unreadable")
W210_MANUAL_UNKNOWN_TEXT = "it could not be repaired automatically"


def _w210_manual_summary(manual: list[dict]) -> str:
    """Name the actual reason a W210 field was left for a human.

    Every failure used to report "complex YAML", so a user whose file was non-UTF-8,
    hard-linked or unreadable was told to hand-edit YAML that was not the problem.
    Human mode omits `details`, so this sentence is all they get.
    """
    codes = {entry.get("reason_code") for entry in manual}
    if codes == {"complex"}:
        return W210_COMPLEX_SUMMARY
    reasons = [
        W210_MANUAL_REASON_TEXT[code] for code in W210_MANUAL_REASON_ORDER if code in codes
    ]
    if codes - set(W210_MANUAL_REASON_ORDER):
        reasons.append(W210_MANUAL_UNKNOWN_TEXT)
    if not reasons:
        reasons = [W210_MANUAL_UNKNOWN_TEXT]
    if len(reasons) == 1:
        joined = reasons[0]
    else:
        joined = ", ".join(reasons[:-1]) + f" and {reasons[-1]}"
    return (
        "Cannot remove W210 derived metadata automatically because "
        f"{joined}; remove it manually."
    )


def _w210_removal_plan(doc, findings: list) -> tuple[list[dict], list[dict]]:
    try:
        lines = _read_repair_text(Path(doc.full)).splitlines()
    except (OSError, ScaffoldError) as exc:
        reason_code = getattr(exc, "reason_code", "unreadable")
        return [], [
            {
                "key": _parse_w210_key(f.message),
                "line": f.line,
                "reason": str(exc),
                "reason_code": reason_code,
            }
            for f in findings
        ]

    safe: list[dict] = []
    manual: list[dict] = []
    for finding in findings:
        key = _parse_w210_key(finding.message)
        index = finding.line - 1
        line = lines[index] if 0 <= index < len(lines) else ""
        holds_key = re.match(rf"^{re.escape(key)}\s*:", line)
        match = re.match(rf"^{re.escape(key)}\s*:\s*(.+?)\s*$", line)
        if match and match.group(1).strip() not in W210_BLOCK_SCALAR_INDICATORS:
            safe.append({"key": key, "line": finding.line})
        else:
            # The line still holds the reported field but is not a plain scalar
            # (block scalar, or a nested mapping whose value starts below) — that is
            # "complex". A line that does not hold the field at all means the report
            # no longer describes the file, which is a different problem to explain.
            reason_code = "complex" if holds_key else "stale"
            manual.append(
                {
                    "key": key,
                    "line": finding.line,
                    "reason": W210_MANUAL_REASON_TEXT[reason_code],
                    "reason_code": reason_code,
                }
            )
    return safe, manual


def _parse_w210_key(message: str) -> str:
    match = re.search(r"field '([^']+)' equals", message)
    return match.group(1) if match else "unknown"


def _parse_w220_message(message: str) -> tuple[str, str]:
    match = re.search(r"field '([^']+)': ref '([^']+)'", message)
    if match:
        return match.group(1), match.group(2)
    return "unknown", "unknown"


def _exo_guidance_actions(resolver, docs, edges: list[dict]) -> list[dict]:
    info: dict[str, dict] = {}
    for doc in docs:
        nid = doc.derived.get("id")
        if nid is None:
            continue
        fields = doc.fields or {}
        rel = doc.rel.replace("\\", "/")
        info[nid] = {
            "id": nid,
            "type": doc.type,
            "path": rel,
            "role": _exo_role_for_path(rel),
            "status": fields.get("status"),
            "assignee": fields.get("assignee"),
        }

    out: dict[str, set[str]] = {}
    for edge in edges:
        out.setdefault(edge["from"], set()).add(edge["to"])

    active = sorted(
        nid
        for nid, node in info.items()
        if node["role"] == "change" and node["status"] == "active"
    )
    actions: list[dict] = []
    for i, first in enumerate(active):
        for second in active[i + 1:]:
            shared = [
                target
                for target in sorted(out.get(first, set()) & out.get(second, set()))
            ]
            if not shared:
                continue
            actions.append(
                _repair_action(
                    "exo-conflict",
                    "manual",
                    info[first]["path"],
                    (
                        f"Active work items `{first}` and `{second}` both touch "
                        f"{', '.join(shared)}. Manual options: claim, defer, or split."
                    ),
                    details={
                        "a": first,
                        "b": second,
                        "a_path": info[first]["path"],
                        "b_path": info[second]["path"],
                        "shared": shared,
                        "options": ["claim", "defer", "split"],
                    },
                )
            )

    has_conflicts = any(action["kind"] == "exo-conflict" for action in actions)
    if active and has_conflicts and not _coordination_pack_declares_assignee(resolver):
        actions.append(
            _repair_action(
                "exo-coordination-pack",
                "manual",
                "tropo.toml",
                (
                    'Claiming active work needs the coordination pack; add '
                    '`packs = ["coordination"]` to `tropo.toml` if you want '
                    "exo claim/assignee fields."
                ),
                details={"suggested_toml": 'packs = ["coordination"]'},
            )
        )
    return actions


def _exo_role_for_path(rel: str) -> str | None:
    parts = rel.split("/")
    if len(parts) < 2:
        return None
    return {
        "changes": "change",
        "modules": "module",
        "decisions": "decision",
        "verification": "verification",
        "gates": "gate",
    }.get(parts[0])


def _coordination_pack_declares_assignee(resolver) -> bool:
    try:
        _required, known = resolver.for_dir(str(Path(resolver.root) / "changes")).fields_for(
            "implementation_slice"
        )
    except Exception:
        return False
    return "assignee" in known


def _apply_doctor_repair_action(target: Path, root: Path, action: dict) -> None:
    kind = action["kind"]
    if kind == "placeholder":
        _write_text_no_follow(
            target,
            target / action["path"],
            _private_placeholder_text(root, action["path"]),
        )
        return
    if kind == "gitignore":
        _append_privacy_gitignore_lines(target, action["details"]["missing"])
        return
    if kind == "tropo-w210":
        tropo = _load_tropo(root)
        _apply_w210_fix(
            target,
            tropo,
            action["path"],
            action["details"]["remove"],
            action["details"].get("lines", []),
        )
        return
    raise ScaffoldError(f"no automatic repair for {kind}")


def _append_privacy_gitignore_lines(target: Path, missing: list[str]) -> None:
    dst = target / ".gitignore"
    _ensure_safe_destinations(target, [dst], force=True)
    existing = _read_repair_text(dst) if dst.exists() else ""
    text = existing
    if text and not text.endswith("\n"):
        text += "\n"
    if text and not text.endswith("\n\n"):
        text += "\n"
    text += "# Vivary private runtime context\n"
    for pattern in missing:
        repair_lines = PRIVACY_IGNORE_REPAIR_LINES.get(pattern)
        if repair_lines:
            text += repair_lines + "\n"
    _write_text_no_follow(target, dst, text)


def _apply_w210_fix(
    target: Path,
    tropo,
    rel: str,
    keys: list[str],
    lines: list[int],
) -> None:
    dst = target / rel
    _ensure_safe_destinations(target, [dst], force=True)
    text = _read_repair_text(dst)
    match, normalized = tropo._frontmatter_match(text)
    if not match:
        return
    line_numbers = set(lines)
    key_set = set(keys)
    if not line_numbers:
        raise ScaffoldError(f"refusing W210 repair without exact line data: {rel}")
    kept = []
    for index, line in enumerate(match.group(1).split("\n")):
        doc_line = index + 2
        if doc_line in line_numbers:
            matched_key = next(
                (
                    key
                    for key in key_set
                    if re.match(rf"^{re.escape(key)}\s*:\s*(.+?)\s*$", line)
                ),
                None,
            )
            if matched_key is None:
                raise ScaffoldError(f"refusing stale W210 repair for {rel}:{doc_line}")
            value = re.match(rf"^{re.escape(matched_key)}\s*:\s*(.+?)\s*$", line)
            if value is None or value.group(1).strip() in W210_BLOCK_SCALAR_INDICATORS:
                raise ScaffoldError(f"refusing complex W210 repair for {rel}:{doc_line}")
            continue
        kept.append(line)
    new_frontmatter = "\n".join(kept).strip("\n")
    body = normalized[match.end():]
    new_text = (
        "---\n" + new_frontmatter + "\n---\n" + body
        if new_frontmatter.strip()
        else body.lstrip("\n")
    )
    _write_text_no_follow(target, dst, new_text)


# ---------------------------------------------------------------------------
# doctor --trend: drift tracking against a prior run
# ---------------------------------------------------------------------------
#
# Read-only unless the caller opts in with --trend, which acts as the write
# gate for a small, inspectable state file. Thin workspaces keep it under
# .vivary/runtime/doctor-state.json; legacy workspaces retain the prior path. The
# metrics reuse doctor's own graph summary and module-index scan rather than
# inventing a second notion of "routing surface" or "context budget".


def _module_routing_metrics(target: Path) -> tuple[int, int]:
    """Module index count and total file count under modules/, the same
    directories doctor already walks in `_module_index_errors`. This doubles
    as a cheap routing-surface proxy without re-deriving one."""
    modules = target / "modules"
    if not modules.exists():
        return 0, 0
    module_index_count = sum(1 for _ in modules.glob("*/index.md"))
    total_files = sum(1 for p in modules.rglob("*") if p.is_file())
    return module_index_count, total_files


def _doctor_metrics_snapshot(report: dict, target: Path) -> dict:
    module_index_count, total_files = _module_routing_metrics(target)
    graph = report["graph"]
    return {
        "date": datetime.now(timezone.utc).date().isoformat(),
        "graph_nodes": graph["nodes"],
        "graph_edges": graph["edges"],
        "graph_broken": graph["broken"],
        "error_count": len(report["errors"]),
        "warning_count": len(report["warnings"]),
        "module_index_count": module_index_count,
        "total_files": total_files,
    }


def _doctor_state_path(target: Path) -> Path:
    if (target / ".vivary" / "workspace.toml").is_file():
        return target / ".vivary" / "runtime" / _DOCTOR_STATE_NAME
    return target / _STORAGE_DIR / _DOCTOR_STATE_NAME


def _load_doctor_state(target: Path) -> tuple[dict | None, str | None]:
    """Read prior trend state. Returns (state, warning); a corrupt or
    unreadable file is treated as "no prior state" plus a warning, never a
    crash."""
    state_path = _doctor_state_path(target)
    if not state_path.exists():
        return None, None
    try:
        with open(state_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        return None, f"doctor-state.json unreadable ({exc}); treating as first recorded run"

    metrics = data.get("metrics") if isinstance(data, dict) else None
    required_keys = ("date", *_TREND_METRIC_KEYS)
    if (
        not isinstance(data, dict)
        or data.get("schema_version") != _DOCTOR_STATE_SCHEMA_VERSION
        or not isinstance(metrics, dict)
        or not all(key in metrics for key in required_keys)
    ):
        return None, "doctor-state.json malformed; treating as first recorded run"
    return data, None


def _write_doctor_state(target: Path, metrics: dict) -> None:
    state = {
        "schema_version": _DOCTOR_STATE_SCHEMA_VERSION,
        "metrics": metrics,
    }
    text = json.dumps(state, indent=2) + "\n"
    _write_text_no_follow(target, _doctor_state_path(target), text)


_TREND_METRIC_KEYS = (
    "graph_nodes",
    "graph_edges",
    "graph_broken",
    "error_count",
    "warning_count",
    "module_index_count",
    "total_files",
)


def _trend_deltas(prior: dict, current: dict) -> dict:
    return {key: current[key] - prior[key] for key in _TREND_METRIC_KEYS}


def _apply_doctor_trend(report: dict, target: Path) -> dict:
    """Compute the --trend addendum: read prior state, snapshot current
    metrics, write new state (the --trend flag is the only write gate), and return
    the JSON-mode trend payload plus
    any state-read warning (kept separate from report["warnings"] so a
    corrupt state file never inflates the stored warning_count)."""
    current_metrics = _doctor_metrics_snapshot(report, target)
    prior_state, state_warning = _load_doctor_state(target)

    if prior_state is None:
        trend = {"prior": None, "current": current_metrics, "deltas": None}
    else:
        prior_metrics = prior_state["metrics"]
        trend = {
            "prior": prior_metrics,
            "current": current_metrics,
            "deltas": _trend_deltas(prior_metrics, current_metrics),
        }

    _write_doctor_state(target, current_metrics)
    return {"trend": trend, "state_warning": state_warning}


def _format_doctor_trend(trend: dict, state_warning: str | None) -> list[str]:
    lines: list[str] = []
    if state_warning:
        lines.append(f"warning: {state_warning}")

    if trend["prior"] is None:
        lines.append("trend: first recorded run (no prior Doctor runtime snapshot)")
        return lines

    prior_date = trend["prior"]["date"]
    deltas = trend["deltas"]
    changed = {key: value for key, value in deltas.items() if value != 0}
    lines.append(f"trend vs {prior_date}:")
    if not changed:
        lines.append("  no change")
    else:
        for key in _TREND_METRIC_KEYS:
            if key not in changed:
                continue
            value = changed[key]
            sign = "+" if value > 0 else ""
            lines.append(f"  {key}: {sign}{value}")
    return lines


def _memory_required_privacy_ignores(memory: dict) -> tuple[str, ...]:
    """Select the published or current privacy floor for a valid memory profile."""
    privacy = memory.get("privacy")
    if not isinstance(privacy, dict):
        return tuple(PRIVACY_IGNORE_PROBES)
    private_paths = privacy.get("private_paths")
    if not isinstance(private_paths, list) or not all(
        isinstance(path, str) for path in private_paths
    ):
        return tuple(PRIVACY_IGNORE_PROBES)
    cognee = memory.get("cognee")
    current_private_paths = {
        _normalize_memory_private_path(path)
        for path in set(_MEMORY_CURRENT_PRIVATE_PATHS)
        - set(_MEMORY_PUBLISHED_PRIVATE_PATHS)
    }
    has_current_cognee_fields = isinstance(cognee, dict) and any(
        key in cognee for key in ("allow_without_api_key", "allow_telemetry")
    )
    has_current_private_path = any(
        _normalize_memory_private_path(path) in current_private_paths
        for path in private_paths
    )
    if has_current_private_path or has_current_cognee_fields:
        return tuple(PRIVACY_IGNORE_PROBES)
    return PUBLISHED_MEMORY_PRIVACY_IGNORES


def _memory_report(target: Path) -> tuple[dict, tuple[str, ...]]:
    cfg_path = target / _STORAGE_DIR / _MEMORY_CONFIG_NAME
    current_privacy_ignores = tuple(PRIVACY_IGNORE_PROBES)
    if not cfg_path.exists():
        return (
            {
                "enabled": False,
                "provider": "none",
                "mode": "none",
                "status": "disabled",
                "config": None,
                "privacy": "not-indexed",
                "detail": "",
            },
            current_privacy_ignores,
        )

    try:
        import tomllib as _toml

        data = _toml.loads(cfg_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        return (
            {
                "enabled": False,
                "provider": "unknown",
                "mode": "unknown",
                "status": "misconfigured",
                "config": str(cfg_path),
                "privacy": "unknown",
                "detail": str(exc),
            },
            current_privacy_ignores,
        )

    memory = data.get("memory", {})
    if not isinstance(memory, dict):
        return (
            {
                "enabled": False,
                "provider": "unknown",
                "mode": "unknown",
                "status": "misconfigured",
                "config": str(cfg_path),
                "privacy": "unknown",
                "detail": "memory must be a TOML table",
            },
            current_privacy_ignores,
        )
    enabled = memory.get("enabled", False)
    provider = memory.get("provider", "none")
    mode = memory.get("mode", "none")
    if not isinstance(enabled, bool):
        return (
            {
                "enabled": False,
                "provider": "unknown",
                "mode": "unknown",
                "status": "misconfigured",
                "config": str(cfg_path),
                "privacy": "unknown",
                "detail": "memory.enabled must be true or false",
            },
            current_privacy_ignores,
        )
    if not isinstance(provider, str) or not isinstance(mode, str):
        return (
            {
                "enabled": False,
                "provider": "unknown",
                "mode": "unknown",
                "status": "misconfigured",
                "config": str(cfg_path),
                "privacy": "unknown",
                "detail": "memory.provider and memory.mode must be strings",
            },
            current_privacy_ignores,
        )

    required_privacy_ignores = _memory_required_privacy_ignores(memory)
    if not enabled:
        status = "disabled"
        detail = ""
    elif provider == "none":
        status = "misconfigured"
        detail = "memory.provider is required when memory.enabled is true"
    elif any(
        pattern in required_privacy_ignores
        for pattern in _missing_privacy_ignores(target)
    ):
        status = "privacy-failed"
        detail = "private workspace paths are not actively ignored"
    elif provider == "vivary-local":
        status = "healthy"
        detail = "local semantic memory policy configured"
    elif provider == "cognee":
        if _safe_cognee_adapter_available(target):
            status = "configured"
            detail = "vivary-memory-cognee adapter is available; indexing still requires approval"
        else:
            status = "unavailable"
            detail = "install vivary-memory-cognee before indexing"
    else:
        status = "misconfigured"
        detail = f"unknown provider {provider!r}"

    return (
        {
            "enabled": enabled,
            "provider": provider,
            "mode": mode,
            "status": status,
            "config": str(cfg_path),
            "privacy": (
                "private-paths-filtered" if status != "privacy-failed" else "failed"
            ),
            "detail": detail,
        },
        required_privacy_ignores,
    )



def _missing_privacy_ignores(target: Path, *, include_nested: bool = True) -> list[str]:
    """Return privacy ignore patterns that are not active .gitignore rules.

    Doctor should reject comments, negated patterns, and larger unrelated patterns that
    merely contain the sensitive filenames as substrings. It also accounts for later
    broad negations and nested memory/.gitignore files, since Git gives lower-level
    ignore files precedence over parent rules.
    """
    return [
        required
        for required, paths in PRIVACY_IGNORE_PROBES.items()
        if not all(
            _probe_is_ignored(target, path, include_nested=include_nested)
            for path in paths
        )
    ]


_THIN_PRIVACY_PROBES = {
    ".vivary/private/": (".vivary/private/secret.md",),
    ".vivary/runtime/": (".vivary/runtime/adopt-journal.json",),
    "*.vivary-tmp": (".vivary-output.vivary-tmp",),
}


def _missing_thin_privacy_ignores(target: Path) -> list[str]:
    return [
        required
        for required, paths in _THIN_PRIVACY_PROBES.items()
        if not all(_probe_is_ignored(target, path) for path in paths)
    ]


def _unfixable_privacy_blockers(target: Path, patterns: list[str]) -> list[str]:
    """Patterns a root `.gitignore` append provably cannot fix.

    Decided by simulating the append and re-asking `_probe_is_ignored` — the same
    predicate doctor passes on — so the planner can never report success for a change
    the follow-up check will reject.

    Anything listed here is reported `manual` *and* withheld from the `safe` append
    list. Withholding is what makes repair converge: previously an unfixable pattern
    stayed missing forever, so every run appended another identical block.
    """
    blocked: list[str] = []
    for pattern in patterns:
        extra = tuple(_repair_line_rules(pattern))
        if any(
            not _probe_is_ignored(target, probe, extra_root_rules=extra)
            for probe in PRIVACY_IGNORE_PROBES[pattern]
        ):
            blocked.append(pattern)
    return blocked


def _probe_is_ignored(
    target: Path,
    rel_path: str,
    *,
    include_nested: bool = True,
    extra_root_rules: tuple[tuple[str, bool, str], ...] = (),
) -> bool:
    """Whether Git would ignore `rel_path` in this workspace.

    One predicate, shared by doctor's pass criterion, the repair planner's prediction
    of success, and adopt's follow-ups — so the planner can never claim a fix the
    check it is trying to satisfy will reject.

    Walks the root file first, then downward. Git never descends into an excluded
    directory, so once a directory component is excluded the answer is settled and a
    deeper negation cannot re-include the file.

    `extra_root_rules` simulates lines a repair would append to the root file.
    """
    rel_path = rel_path.replace("\\", "/")
    rules = _privacy_rules_at_base(target, "") + list(extra_root_rules)
    if not include_nested:
        return _ignored_by_rules(rules, rel_path)

    parts = rel_path.split("/")
    for depth in range(1, len(parts)):
        base = "/".join(parts[:depth])
        if _ignored_by_rules(rules, base):
            return True
        rules.extend(_privacy_rules_at_base(target, base))
    return _ignored_by_rules(rules, rel_path)


def _strip_unescaped_trailing_spaces(line: str) -> str:
    """Drop trailing spaces the way Git does — unless they are backslash-escaped.

    `USER.md\\ ` names the file "USER.md " (with the space). Stripping it
    unconditionally credited that line with protecting `USER.md`, which Git leaves
    committable.
    """
    end = len(line)
    while end > 0 and line[end - 1] == " ":
        preceding_backslashes = 0
        index = end - 2
        while index >= 0 and line[index] == "\\":
            preceding_backslashes += 1
            index -= 1
        if preceding_backslashes % 2:
            break  # escaped: this space belongs to the pattern
        end -= 1
    return line[:end]


def _parse_gitignore_line(raw_line: str) -> tuple[bool, str] | None:
    """One `.gitignore` line as `(negated, pattern)`, or `None` when it is not a rule.

    A backslash is Git's escape character, **not** a path separator — rewriting it to
    `/` corrupted every escaped pattern. Separator normalization belongs to the paths
    being tested, not to the rules.
    """
    line = _strip_unescaped_trailing_spaces(raw_line)
    if not line or line.startswith("#"):
        return None
    negated = line.startswith("!")
    pattern = line[1:] if negated else line
    if not pattern:
        return None
    return negated, pattern


def _repair_line_rules(pattern: str) -> list[tuple[str, bool, str]]:
    """The root-level rules a `gitignore` repair would append for `pattern`."""
    rules: list[tuple[str, bool, str]] = []
    for raw_line in PRIVACY_IGNORE_REPAIR_LINES[pattern].splitlines():
        parsed = _parse_gitignore_line(raw_line)
        if parsed is not None:
            rules.append(("", parsed[0], parsed[1]))
    return rules


def _privacy_rules_at_base(target: Path, base: str) -> list[tuple[str, bool, str]]:
    gitignore = target / base / ".gitignore" if base else target / ".gitignore"
    if _is_symlink_or_junction(gitignore) or not gitignore.exists() or not gitignore.is_file():
        return []
    return _privacy_ignore_rules(gitignore, base=base)


def _privacy_ignore_rules(gitignore: Path, *, base: str) -> list[tuple[str, bool, str]]:
    rules: list[tuple[str, bool, str]] = []
    for raw_line in gitignore.read_text(encoding="utf-8", errors="replace").splitlines():
        parsed = _parse_gitignore_line(raw_line)
        if parsed is not None:
            rules.append((base, parsed[0], parsed[1]))
    return rules


def _has_case_sensitive_bracket(pattern: str) -> bool:
    """Whether `pattern` contains a bracket expression holding an ASCII letter.

    Git case-folds the path being tested but not the literal characters inside a
    bracket set, so `[U]SER.md` stops matching `USER.md` wherever `core.ignorecase`
    is on — which is the default on Windows and macOS. A bracket holding only digits
    or punctuation is unaffected by folding and stays trustworthy.
    """
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\":
            index += 2
            continue
        if char == "[":
            close = pattern.find("]", index + 2)
            if close == -1:
                return False
            body = pattern[index + 1 : close]
            if any(c.isascii() and c.isalpha() for c in body):
                return True
            index = close + 1
            continue
        index += 1
    return False


def _ignored_by_rules(rules: list[tuple[str, bool, str]], rel_path: str) -> bool:
    ignored = False
    for base, negated, pattern in rules:
        # Fail closed on a positive rule whose protection depends on `core.ignorecase`.
        # A negation spelled this way is still honoured, so an unignore is never missed.
        if not negated and _has_case_sensitive_bracket(pattern):
            continue
        # Negations match case-insensitively so a `!user.md` style re-include is never
        # missed on a case-insensitive checkout; positive rules stay case-sensitive so
        # a differently-cased rule is never credited with protecting anything. Both
        # directions fail closed, and the check stays pure — no `git config` read — so
        # `adopt` can use it on a directory that is not a repository yet.
        if _ignore_rule_matches(base, pattern, rel_path, fold_case=negated):
            ignored = not negated
    return ignored


def _ignore_rule_matches(
    base: str, pattern: str, rel_path: str, *, fold_case: bool = False
) -> bool:
    rel_path = rel_path.replace("\\", "/")
    if base:
        prefix = f"{base}/"
        if not rel_path.startswith(prefix):
            return False
        scoped = rel_path[len(prefix):]
    else:
        scoped = rel_path

    body = pattern.rstrip("/")
    if body.startswith("/"):
        body = body[1:]
    if not body:
        return False

    regex = _wildmatch_regex(body)
    if "/" not in body:
        # A pattern with no separator matches by basename at any depth.
        regex = r"(?:.*/)?" + regex
    # A match also covers everything beneath it: `foo/` and bare `foo` name a
    # directory, and Git excludes a directory's whole subtree.
    flags = re.IGNORECASE if fold_case else 0
    return re.match(rf"(?:{regex})(?:/.*)?\Z", scoped, flags) is not None


def _wildmatch_regex(pattern: str) -> str:
    """Translate a gitignore pattern into a regex with Git's wildmatch semantics.

    `*` and `?` never cross `/`; `**/` matches zero or more leading segments; `**`
    elsewhere matches anything. `fnmatch` gets all of that wrong — its `*` crosses
    separators, and it compiles `**/USER.md` into a pattern requiring a literal slash,
    so `!**/USER.md` was invisible here while Git honoured it and left the file
    committable.
    """
    out: list[str] = []
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if char == "*":
            if pattern[i : i + 3] == "**/":
                out.append("(?:[^/]+/)*")
                i += 3
            elif pattern[i : i + 2] == "**":
                out.append(".*")
                i += 2
            else:
                out.append("[^/]*")
                i += 1
        elif char == "?":
            out.append("[^/]")
            i += 1
        elif char == "\\" and i + 1 < len(pattern):
            # Git's escape: the next character is a literal, stripped of any special
            # meaning. A trailing lone backslash falls through to `re.escape` below.
            out.append(re.escape(pattern[i + 1]))
            i += 2
        elif char == "[":
            close = pattern.find("]", i + 2)
            if close == -1:
                out.append(re.escape(char))
                i += 1
            else:
                body = pattern[i + 1 : close]
                if body[:1] in ("!", "^"):
                    body = "^" + body[1:]
                out.append(f"[{body}]")
                i = close + 1
        else:
            out.append(re.escape(char))
            i += 1
    return "".join(out)


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
            if _is_symlink_or_junction(component)
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
        return [path] if path.exists() or _is_symlink_or_junction(path) else []

    components: list[Path] = []
    current = target
    if current.exists() or _is_symlink_or_junction(current):
        components.append(current)
    for part in relative.parts:
        current = current / part
        if current.exists() or _is_symlink_or_junction(current):
            components.append(current)
        else:
            break
    return components


def _existing_regular_file_mode(path: Path) -> int | None:
    """The permission bits of an existing regular file, or `None`.

    `& 0o777` deliberately drops setuid/setgid/sticky rather than restoring them onto
    a file this tool just rewrote.
    """
    try:
        st = path.lstat()
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    return stat.S_IMODE(st.st_mode) & 0o777


def _nearest_existing_directory(path: Path) -> Path:
    current = path
    while not (current.exists() or os.path.lexists(current)):
        parent = current.parent
        if parent == current:
            break
        current = parent
    if _is_symlink_or_junction(current) or not current.is_dir():
        raise ScaffoldError(f"safe destination ancestor is not a regular directory: {current}")
    return current


def _windows_open_locked_directory(path: Path, *, delete: bool = False):
    before = os.stat(path, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode) or _is_symlink_or_junction(path):
        raise ScaffoldError(f"destination parent is not a regular directory: {path}")
    handle = _WINDOWS_CREATE_FILE(
        str(path),
        (
            _WINDOWS_FILE_READ_ATTRIBUTES
            | _WINDOWS_FILE_TRAVERSE
            | (_WINDOWS_DELETE if delete else 0)
        ),
        _WINDOWS_FILE_SHARE_READ_WRITE,
        None,
        _WINDOWS_OPEN_EXISTING,
        _WINDOWS_FILE_FLAG_BACKUP_SEMANTICS | _WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    if handle == _WINDOWS_INVALID_HANDLE:
        raise ScaffoldError(
            f"cannot lock destination parent {path}: {ctypes.WinError(ctypes.get_last_error())}"
        )
    info = _WindowsDirectoryInformation()
    if not _WINDOWS_GET_FILE_INFO(handle, ctypes.byref(info)):
        error = ctypes.WinError(ctypes.get_last_error())
        _WINDOWS_CLOSE_HANDLE(handle)
        raise ScaffoldError(f"cannot inspect locked destination parent {path}: {error}")
    inode = (info.file_index_high << 32) | info.file_index_low
    if (
        not info.file_attributes & _WINDOWS_FILE_ATTRIBUTE_DIRECTORY
        or info.file_attributes & _WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT
        or inode != before.st_ino
    ):
        _WINDOWS_CLOSE_HANDLE(handle)
        raise ScaffoldError(f"destination parent changed or is a reparse point: {path}")
    return handle, (before.st_dev, inode)


def _windows_open_locked_regular_file(path: Path):
    before = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode) or _is_symlink_or_junction(path):
        raise ScaffoldError(f"delete target is not a regular file: {path}")
    handle = _WINDOWS_CREATE_FILE(
        str(path),
        _WINDOWS_GENERIC_READ | _WINDOWS_FILE_READ_ATTRIBUTES | _WINDOWS_DELETE,
        0x00000001 | _WINDOWS_FILE_SHARE_DELETE,
        None,
        _WINDOWS_OPEN_EXISTING,
        _WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    if handle == _WINDOWS_INVALID_HANDLE:
        raise ScaffoldError(
            f"cannot lock delete target {path}: {ctypes.WinError(ctypes.get_last_error())}"
        )
    info = _WindowsDirectoryInformation()
    if not _WINDOWS_GET_FILE_INFO(handle, ctypes.byref(info)):
        error = ctypes.WinError(ctypes.get_last_error())
        _WINDOWS_CLOSE_HANDLE(handle)
        raise ScaffoldError(f"cannot inspect locked delete target {path}: {error}")
    inode = (info.file_index_high << 32) | info.file_index_low
    if (
        info.file_attributes & _WINDOWS_FILE_ATTRIBUTE_DIRECTORY
        or info.file_attributes & _WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT
        or inode != before.st_ino
    ):
        _WINDOWS_CLOSE_HANDLE(handle)
        raise ScaffoldError(f"delete target changed or is a reparse point: {path}")
    return handle, (before.st_dev, inode)


def _windows_assert_directory_identity(path: Path, identity: tuple[int, int]) -> None:
    try:
        current = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        raise ScaffoldError(f"destination parent changed during write: {path}") from exc
    if (
        not stat.S_ISDIR(current.st_mode)
        or _is_symlink_or_junction(path)
        or (current.st_dev, current.st_ino) != identity
    ):
        raise ScaffoldError(f"destination parent changed during write: {path}")


def _windows_create_temporary_file(parent: Path, destination_name: str) -> int:
    for _attempt in range(16):
        temporary = parent / f".{destination_name}.{os.urandom(8).hex()}.vivary-tmp"
        handle = _WINDOWS_CREATE_FILE(
            str(temporary),
            _WINDOWS_GENERIC_WRITE | _WINDOWS_DELETE,
            _WINDOWS_FILE_SHARE_READ_WRITE | _WINDOWS_FILE_SHARE_DELETE,
            None,
            _WINDOWS_CREATE_NEW,
            _WINDOWS_FILE_ATTRIBUTE_TEMPORARY,
            None,
        )
        if handle != _WINDOWS_INVALID_HANDLE:
            try:
                descriptor = msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
            except Exception:
                _WINDOWS_CLOSE_HANDLE(handle)
                raise
            return descriptor
        error = ctypes.get_last_error()
        if error != 80:  # ERROR_FILE_EXISTS
            raise ScaffoldError(
                f"cannot create temporary file in {parent}: {ctypes.WinError(error)}"
            )
    raise ScaffoldError(f"cannot create a unique temporary file in {parent}")


def _windows_rename_open_file(
    file_handle: int,
    parent_handle: object,
    name: str,
    *,
    replace_existing: bool,
) -> None:
    encoded_name = name.encode("utf-16-le")
    size = _WindowsRenameInformation.file_name.offset + len(encoded_name)
    buffer = ctypes.create_string_buffer(size)
    information = _WindowsRenameInformation.from_buffer(buffer)
    information.replace_if_exists = replace_existing
    information.root_directory = parent_handle
    information.file_name_length = len(encoded_name)
    ctypes.memmove(
        ctypes.addressof(buffer) + _WindowsRenameInformation.file_name.offset,
        encoded_name,
        len(encoded_name),
    )
    io_status = _WindowsIoStatusBlock()
    status = _WINDOWS_NT_SET_FILE_INFO(
        wintypes.HANDLE(file_handle),
        ctypes.byref(io_status),
        buffer,
        size,
        _WINDOWS_FILE_RENAME_INFORMATION_CLASS,
    )
    if status != 0:
        error = _WINDOWS_NT_STATUS_TO_DOS_ERROR(status)
        raise ScaffoldError(
            f"cannot commit generated file {name}: {ctypes.WinError(error)}"
        )


def _windows_delete_open_file(file_handle: int) -> None:
    information = _WindowsDispositionInformation(True)
    if not _WINDOWS_SET_FILE_INFO(
        wintypes.HANDLE(file_handle),
        _WINDOWS_FILE_DISPOSITION_INFO_CLASS,
        ctypes.byref(information),
        ctypes.sizeof(information),
    ):
        raise ScaffoldError(
            "cannot remove opened generated path: "
            f"{ctypes.WinError(ctypes.get_last_error())}"
        )


@contextmanager
def _windows_destination_parent(target: Path, dst: Path, *, create_missing: bool = True):
    anchor = Path(dst.anchor)
    if not dst.is_absolute() or not _path_within(target, dst.parent):
        raise ScaffoldError("destination parent is outside the selected workspace")
    locked: list[tuple[Path, object, tuple[int, int]]] = []
    try:
        current = anchor
        handle, identity = _windows_open_locked_directory(current)
        locked.append((current, handle, identity))
        for part in dst.parent.relative_to(anchor).parts:
            current = current / part
            if not (current.exists() or os.path.lexists(current)):
                if not create_missing:
                    raise FileNotFoundError(current)
                if not _path_within(target, current):
                    raise ScaffoldError(
                        f"safe destination ancestor does not exist: {current}"
                    )
                try:
                    current.mkdir()
                except FileExistsError:
                    pass
                except OSError as exc:
                    raise ScaffoldError(
                        f"cannot create destination parent {current}: {exc}"
                    ) from exc
            handle, identity = _windows_open_locked_directory(current)
            locked.append((current, handle, identity))
            for locked_path, _locked_handle, locked_identity in locked:
                _windows_assert_directory_identity(locked_path, locked_identity)
        yield locked[-1]
        for path, _handle, identity in locked:
            _windows_assert_directory_identity(path, identity)
    finally:
        for _path, handle, _identity in reversed(locked):
            _WINDOWS_CLOSE_HANDLE(handle)


@contextmanager
def _posix_destination_parent(target: Path, dst: Path, *, create_missing: bool = True):
    # CPython exposes src_dir_fd/dst_dir_fd on POSIX os.replace(), but does not
    # include os.replace in os.supports_dir_fd. Check the other required primitives;
    # the supported Python 3.11+ POSIX runtimes provide descriptor-relative replace.
    required = (os.open, os.mkdir, os.stat)
    if not all(func in os.supports_dir_fd for func in required):
        raise ScaffoldError("this platform cannot enforce descriptor-relative safe writes")
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    anchor = Path(dst.anchor)
    if not dst.is_absolute() or not _path_within(target, dst.parent):
        raise ScaffoldError("destination parent is outside the selected workspace")
    descriptor = os.open(anchor, directory_flags)
    current = anchor
    try:
        for part in dst.parent.relative_to(anchor).parts:
            current = current / part
            try:
                next_descriptor = os.open(part, directory_flags, dir_fd=descriptor)
            except FileNotFoundError:
                if not create_missing:
                    raise
                if not _path_within(target, current):
                    raise ScaffoldError(
                        f"safe destination ancestor does not exist: {current}"
                    )
                try:
                    os.mkdir(part, 0o755, dir_fd=descriptor)
                except FileExistsError:
                    pass
                next_descriptor = os.open(part, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        opened = os.fstat(descriptor)
        if not stat.S_ISDIR(opened.st_mode):
            raise ScaffoldError("destination parent descriptor is not a directory")
        yield descriptor
        try:
            after = os.stat(dst.parent, follow_symlinks=False)
        except OSError as exc:
            raise ScaffoldError("destination parent changed during write") from exc
        if (
            not stat.S_ISDIR(after.st_mode)
            or (after.st_dev, after.st_ino) != (opened.st_dev, opened.st_ino)
        ):
            raise ScaffoldError("destination parent changed during write")
    finally:
        os.close(descriptor)


@contextmanager
def _safe_destination_parent(target: Path, dst: Path, *, create_missing: bool = True):
    _ensure_safe_destinations(target, [dst], force=True)
    if os.name == "nt":
        with _windows_destination_parent(target, dst, create_missing=create_missing) as parent:
            yield parent
    else:
        with _posix_destination_parent(target, dst, create_missing=create_missing) as parent:
            yield parent


def _descriptor_regular_file_mode(parent_fd: int, name: str) -> int | None:
    try:
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return stat.S_IMODE(info.st_mode) & 0o777


def _atomic_write_bytes_no_follow(
    target: Path,
    dst: Path,
    data: bytes,
    *,
    source_mode: int | None = None,
    replace_existing: bool = True,
) -> None:
    with _safe_destination_parent(target, dst) as parent:
        if os.name == "nt":
            parent_path, parent_handle, parent_identity = parent
            mode = source_mode if source_mode is not None else _existing_regular_file_mode(dst)
            _windows_assert_directory_identity(parent_path, parent_identity)
            descriptor = _windows_create_temporary_file(parent_path, dst.name)
            committed = False
            try:
                file_handle = msvcrt.get_osfhandle(descriptor)
                _windows_assert_directory_identity(parent_path, parent_identity)
                with os.fdopen(descriptor, "wb", closefd=False) as handle:
                    handle.write(data)
                    if mode is not None and hasattr(os, "fchmod"):
                        try:
                            os.fchmod(handle.fileno(), mode)
                        except OSError:
                            pass
                _windows_assert_directory_identity(parent_path, parent_identity)
                _windows_rename_open_file(
                    file_handle,
                    parent_handle,
                    dst.name,
                    replace_existing=replace_existing,
                )
                _windows_assert_directory_identity(parent_path, parent_identity)
                committed = True
            finally:
                try:
                    if not committed:
                        _windows_delete_open_file(msvcrt.get_osfhandle(descriptor))
                finally:
                    os.close(descriptor)
            return

        parent_fd = parent
        mode = (
            source_mode
            if source_mode is not None
            else _descriptor_regular_file_mode(parent_fd, dst.name)
        )
        temp_name = f".{dst.name}.{os.urandom(8).hex()}.vivary-tmp"
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        descriptor = os.open(temp_name, flags, 0o600, dir_fd=parent_fd)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = -1
                handle.write(data)
                if mode is not None and hasattr(os, "fchmod"):
                    try:
                        os.fchmod(handle.fileno(), mode)
                    except OSError:
                        pass
            try:
                if replace_existing:
                    os.replace(
                        temp_name,
                        dst.name,
                        src_dir_fd=parent_fd,
                        dst_dir_fd=parent_fd,
                    )
                else:
                    os.link(
                        temp_name,
                        dst.name,
                        src_dir_fd=parent_fd,
                        dst_dir_fd=parent_fd,
                        follow_symlinks=False,
                    )
            except FileExistsError as exc:
                raise ScaffoldError(
                    f"refusing to replace a file created during init: {dst}"
                ) from exc
            except OSError as exc:
                raise ScaffoldError(f"cannot commit generated file {dst}: {exc}") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass


def _write_text_no_follow(target: Path, dst: Path, text: str) -> None:
    _atomic_write_bytes_no_follow(target, dst, text.encode("utf-8"))


def _write_bytes_no_follow(
    target: Path,
    dst: Path,
    data: bytes,
    *,
    replace_existing: bool = True,
) -> None:
    _atomic_write_bytes_no_follow(
        target,
        dst,
        data,
        replace_existing=replace_existing,
    )


def _copy_file_no_follow(target: Path, src: Path, dst: Path) -> None:
    source_mode = stat.S_IMODE(src.stat().st_mode) & 0o777
    _atomic_write_bytes_no_follow(target, dst, src.read_bytes(), source_mode=source_mode)


def _unlink_no_follow(
    target: Path,
    path: Path,
    *,
    expected_hashes: set[str] | None = None,
    missing_ok: bool = False,
) -> None:
    with _safe_destination_parent(target, path, create_missing=False) as parent:
        if os.name == "nt":
            parent_path, _parent_handle, parent_identity = parent
            _windows_assert_directory_identity(parent_path, parent_identity)
            try:
                handle, _file_identity = _windows_open_locked_regular_file(path)
            except FileNotFoundError:
                if missing_ok:
                    return
                raise
            try:
                descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            except Exception:
                _WINDOWS_CLOSE_HANDLE(handle)
                raise
            try:
                with os.fdopen(descriptor, "rb", closefd=False) as stream:
                    data = stream.read() if expected_hashes is not None else None
                if expected_hashes is not None and _sha256_prefixed(data) not in expected_hashes:
                    raise ScaffoldError("delete target changed after apply")
                _windows_assert_directory_identity(parent_path, parent_identity)
                _windows_delete_open_file(msvcrt.get_osfhandle(descriptor))
            finally:
                os.close(descriptor)
            _windows_assert_directory_identity(parent_path, parent_identity)
            return

        parent_fd = parent
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path.name, flags, dir_fd=parent_fd)
        except FileNotFoundError:
            if missing_ok:
                return
            raise
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise ScaffoldError("delete target is not a regular file")
            if expected_hashes is not None:
                with os.fdopen(descriptor, "rb", closefd=False) as stream:
                    data = stream.read()
                if _sha256_prefixed(data) not in expected_hashes:
                    raise ScaffoldError("delete target changed after apply")
            current = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                raise ScaffoldError("delete target changed before removal")
            os.unlink(path.name, dir_fd=parent_fd)
        finally:
            os.close(descriptor)


def _rmdir_no_follow(target: Path, path: Path, *, missing_ok: bool = False) -> None:
    try:
        with _safe_destination_parent(target, path, create_missing=False) as parent:
            if os.name == "nt":
                parent_path, _parent_handle, parent_identity = parent
                _windows_assert_directory_identity(parent_path, parent_identity)
                handle, _directory_identity = _windows_open_locked_directory(path, delete=True)
                try:
                    _windows_assert_directory_identity(parent_path, parent_identity)
                    _windows_delete_open_file(handle)
                finally:
                    _WINDOWS_CLOSE_HANDLE(handle)
                _windows_assert_directory_identity(parent_path, parent_identity)
                return

            parent_fd = parent
            current = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(current.st_mode):
                raise ScaffoldError("directory cleanup target is not a regular directory")
            os.rmdir(path.name, dir_fd=parent_fd)
    except FileNotFoundError:
        if not missing_ok:
            raise


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
    link = _is_symlink_or_junction(path)
    try:
        if path.is_dir() and not link:
            shutil.rmtree(path)
        elif link and _reparse_point_is_dir(path):
            # A junction or directory symlink: `rmdir` removes the link itself and
            # leaves whatever it points at alone. `unlink` is for the file case.
            os.rmdir(path)
        elif path.exists() or link:
            path.unlink()
    except OSError as exc:
        # Never let a raw OSError escape: `scaffold_workspace` is reached from `init`,
        # whose only error handler catches `ScaffoldError`. Uncaught, `--json` prints a
        # traceback and no JSON at all.
        raise ScaffoldError(f"failed to clean stale scaffold path: {path}: {exc}") from exc


def _is_safe_cleanup_target(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False

    for parent in path.parents:
        if parent == root:
            return True
        if _is_symlink_or_junction(parent):
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
*.vivary-tmp

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


_WORKSPACE_TROPO_EXCLUDES = (
    ".git",
    ".claude",
    ".agents",
    ".strato",
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
)


_TROPO_CONFIG_BODY = """
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


def _render_tropo_config(excludes: tuple[str, ...]) -> str:
    exclude_lines = "\n".join(f'  "{name}",' for name in excludes)
    return f"version = 1\nexclude = [\n{exclude_lines}\n]\n" + _TROPO_CONFIG_BODY


def _workspace_tropo_config() -> str:
    return _render_tropo_config(_WORKSPACE_TROPO_EXCLUDES)


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
access, or recalling from private paths. `USER.md`, `MEMORY.md`, `memory/**`,
`heartbeat-reports/**`, and `.strato/private/**` must stay outside every memory index.

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
writes, sets `memory.cognee.allow_network = true`, and configures the chosen provider
credentials. Local no-key providers must explicitly set
`memory.cognee.allow_without_api_key = true`.
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
_DOCTOR_STATE_NAME = "doctor-state.json"
_DOCTOR_STATE_SCHEMA_VERSION = 1

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

_MEMORY_PUBLISHED_PRIVATE_PATHS = (
    "USER.md",
    "MEMORY.md",
    "memory/**",
    "heartbeat-reports/**",
)
_MEMORY_CURRENT_PRIVATE_PATHS = (
    *_MEMORY_PUBLISHED_PRIVATE_PATHS,
    ".strato/private/**",
)
_MEMORY_CURRENT_PRIVATE_PATHS_TOML = json.dumps(_MEMORY_CURRENT_PRIVATE_PATHS)


_MEMORY_TOML_TEMPLATES = {
    "local": f"""\
[memory]
enabled = true
mode = "semantic-provider"
provider = "vivary-local"

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = {_MEMORY_CURRENT_PRIVATE_PATHS_TOML}
fail_closed = true

[memory.local]
state_path = ".vivary/memory/local"
allow_network = false
require_explicit_index = true
""",
    "cognee": f"""\
[memory]
enabled = true
mode = "semantic-provider"
provider = "cognee"

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = {_MEMORY_CURRENT_PRIVATE_PATHS_TOML}
fail_closed = true

[memory.cognee]
state_path = ".vivary/memory/cognee"
allow_network = false
require_explicit_index = true
api_key_env = ""
allow_without_api_key = false
allow_telemetry = false
""",
}

# The single owner of selected-template fields. Doctor validates presence and
# types, then fail-closes the privacy fields; generated Cognee
# `api_key_env = ""` and cloud placeholders remain valid declarations.
_DECLARED_CONFIG_SCHEMAS = {
    "storage": {
        "embedded": {
            "path": str,
            "provider": str,
        },
        "cloud": {
            "qdrant": {
                "provider": str,
                "url": str,
                "api_key": str,
                "collection": str,
            },
            "astra": {
                "provider": str,
                "endpoint": str,
                "api_key": str,
                "collection": str,
            },
        },
    },
    "memory": {
        "root": {
            "enabled": bool,
            "provider": str,
            "mode": str,
        },
        "privacy": {
            "respect_gitignore": bool,
            "respect_vivary_private": bool,
            "private_paths": list,
            "fail_closed": bool,
        },
        "providers": {
            "vivary-local": (
                "local",
                {
                    "state_path": str,
                    "allow_network": bool,
                    "require_explicit_index": bool,
                },
                {},
            ),
            "cognee": (
                "cognee",
                {
                    "state_path": str,
                    "allow_network": bool,
                    "require_explicit_index": bool,
                    "api_key_env": str,
                },
                {
                    "allow_without_api_key": bool,
                    "allow_telemetry": bool,
                },
            ),
        },
    },
}


def _auto_pick_storage(args) -> tuple[str, str]:
    """Return (storage_tier, provider) based on --auto signals."""
    privacy = getattr(args, "privacy", None)
    storage = getattr(args, "storage", None)
    provider = getattr(args, "provider", None)

    if storage and storage != "auto":
        return storage, provider or "lancedb"
    if privacy == "cloud":
        return "cloud", provider or "qdrant"
    # Size alone never grants provider-install authority. Embedded storage
    # requires the explicit --storage embedded choice.
    return "file", provider or "lancedb"


def _is_importable(module: str) -> bool:
    import importlib.util
    return importlib.util.find_spec(module) is not None


def _version_tuple(value: str) -> tuple[int, ...]:
    parts = []
    for part in str(value or "").split("."):
        digits = ""
        for char in part:
            if not char.isdigit():
                break
            digits += char
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def _path_within(root: Path, path: Path) -> bool:
    try:
        return os.path.commonpath([str(root), str(path)]) == str(root)
    except ValueError:
        return False


def _safe_cognee_adapter_available(target: Path) -> bool:
    try:
        version = importlib_metadata.version("vivary-memory-cognee")
    except importlib_metadata.PackageNotFoundError:
        return False
    if _version_tuple(version) < (0, 1, 2):
        return False
    spec = importlib.util.find_spec("vivary_cognee")
    if spec is None or spec.origin is None:
        return False
    origin = Path(os.path.realpath(spec.origin))
    unsafe_roots = [target.resolve(), Path(os.path.realpath(os.getcwd()))]
    if any(_path_within(root, origin) for root in unsafe_roots):
        return False
    try:
        module = importlib.import_module("vivary_cognee")
    except Exception:
        return False
    module_origin = getattr(module, "__file__", spec.origin)
    if module_origin:
        module_origin_path = Path(os.path.realpath(module_origin))
        if any(_path_within(root, module_origin_path) for root in unsafe_roots):
            return False
    adapter = getattr(module, "CogneeMemoryAdapter", None)
    try:
        adapter_api = int(getattr(module, "TROPO_SEMANTIC_ADAPTER_API", 0))
    except (TypeError, ValueError):
        return False
    return (
        callable(adapter)
        and adapter_api >= 1
        and getattr(module, "REQUIRES_EXPLICIT_PROVIDER_GATES", None) is True
        and _version_tuple(getattr(module, "__version__", "")) >= (0, 1, 2)
    )


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

    if (
        getattr(args, "command", None) == "init"
        and not sys.stdin.isatty()
        and not getattr(args, "auto", False)
        and all(
            getattr(args, name, None) is None
            for name in ("storage", "provider", "size", "privacy")
        )
    ):
        return {"storage": "file", "provider": "lancedb", "memory": requested_memory}

    auto = getattr(args, "auto", False)
    explicit_agent_dry_run = (
        getattr(args, "dry_run", False)
        and getattr(args, "json", False)
        and any(
            getattr(args, name, None) is not None
            for name in ("storage", "privacy", "size")
        )
    )
    interactive = not auto and not explicit_agent_dry_run and sys.stdin.isatty()

    if not interactive:
        storage, provider = _auto_pick_storage(args)
        return {"storage": storage, "provider": provider, "memory": requested_memory}

    # Interactive flow — plain English, no jargon (all prompts to stderr so JSON stdout stays clean)
    print("\nWelcome to Vivary! Let's set up your workspace.\n", file=sys.stderr)

    size_map = {"1": "small", "2": "medium", "3": "large", "": "small"}
    print("  How large do you expect this workspace to get?", file=sys.stderr)
    print("  1) Just starting out (a few files or notes)", file=sys.stderr)
    print("  2) Growing — hundreds of files (recommended)", file=sys.stderr)
    print("  3) Large — huge codebase or years of notes", file=sys.stderr)
    try:
        sys.stderr.write("  Your choice [1]: ")
        sys.stderr.flush()
        size_choice = sys.stdin.readline().strip()
    except EOFError:
        size_choice = ""
    size = size_map.get(size_choice, "small")

    if size == "small":
        storage_decision = {"storage": "file", "provider": "lancedb"}
        return {**storage_decision, "memory": _prompt_memory_choice(requested_memory)}

    print("\n  How should Vivary store searchable context?", file=sys.stderr)
    print("  1) Project files only — local, no provider install (recommended)", file=sys.stderr)
    print("  2) Embedded search — local, installs LanceDB", file=sys.stderr)
    print("  3) Cloud search — requires a separate provider", file=sys.stderr)
    try:
        sys.stderr.write("  Your choice [1]: ")
        sys.stderr.flush()
        loc_choice = sys.stdin.readline().strip()
    except EOFError:
        loc_choice = "1"

    if loc_choice in ("", "1"):
        return {
            "storage": "file",
            "provider": "lancedb",
            "installed": [],
            "memory": _prompt_memory_choice(requested_memory),
        }

    if loc_choice == "3":
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

    if loc_choice != "2":
        return {
            "storage": "file",
            "provider": "lancedb",
            "installed": [],
            "memory": _prompt_memory_choice(requested_memory),
        }

    # The explicit embedded-search choice is the provider-install consent step.
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


# ---------------------------------------------------------------------------
# Legacy full-adoption planner retained only for source compatibility fixtures.
# ---------------------------------------------------------------------------

THIN_WORKSPACE_CONTRACT = "thin-v0.3"
_THIN_AGENTS_BLOCK_START = "<!-- vivary:context:start -->"
_THIN_AGENTS_BLOCK_END = "<!-- vivary:context:end -->"
_THIN_GITIGNORE_BLOCK_START = "# >>> vivary private/runtime >>>"
_THIN_GITIGNORE_BLOCK_END = "# <<< vivary private/runtime <<<"
_THIN_PRIVATE_RULES = (
    ".vivary/private/",
    ".vivary/runtime/",
    "*.vivary-tmp",
)
_THIN_ADAPTER_PATHS = {
    "agents": ".agents/skills/vivary/SKILL.md",
    "claude": ".claude/skills/vivary/SKILL.md",
}
_THIN_ADAPTER_MAX_BYTES = 1200
_ADOPT_PREJOURNAL_MARKER_PREFIX = "# vivary-adopt-prejournal "
_THIN_RECORD_FOLDERS = {
    "modules": "module",
    "changes": "change",
    "decisions": "decision",
    "verification": "verification",
    "gates": "gate",
}
_THIN_RECORD_MAX_BYTES = 256 * 1024
_THIN_RECORD_NAME_RE = re.compile(r"[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?\.md")

_ADOPT_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
    ".astro", ".next", "target",
}

# A conservative code-file signal used only for the coding-vs-second-brain preset
# heuristic; it does not need to be exhaustive.
_ADOPT_CODE_SUFFIXES = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs", ".java",
    ".kt", ".c", ".h", ".cpp", ".cc", ".hpp", ".cs", ".rb", ".php", ".swift",
    ".m", ".mm", ".scala", ".sh", ".ps1", ".sql", ".lua", ".vue", ".svelte",
}

# Top-level directories a Vivary scaffold (init or a prior adopt) itself creates.
# Re-running `adopt analyze` on an already-adopted tree must not mistake its own
# `templates/` (six starter .md files, no index.md) or `modules/` for brownfield
# content worth a router or worth counting toward the preset heuristic.
_ADOPT_VIVARY_OWNED_DIRS = {
    "templates", "modules", "changes", "decisions", "verification", "gates",
    "memory", "heartbeat-reports",
}


class BrownfieldInventory:
    """Read-only snapshot of an existing directory tree for `adopt`.

    Never mutates disk. Walks `target` once, skipping the fixed skip-list dirs,
    any dotdir, and any directory Vivary itself would have created, and records
    just enough to plan an adopt: whether root contract files already exist, how
    markdown- vs code-heavy the tree is, and which directories look like
    undocumented "modules" worth a router.
    """

    def __init__(self, target: Path):
        self.target = target
        self.has_agents_md = (target / "AGENTS.md").exists()
        self.has_claude_md = (target / "CLAUDE.md").exists()
        self.has_gitignore = (target / ".gitignore").exists()
        self.has_readme = (target / "README.md").exists()
        self.markdown_count = 0
        self.code_count = 0
        self.other_count = 0
        self.candidate_modules: list[str] = []
        self._scan()

    def _scan(self) -> None:
        md_by_dir: dict[str, int] = {}
        index_dirs: set[str] = set()

        for dirpath, dirnames, filenames in os.walk(self.target):
            rel_dir = os.path.relpath(dirpath, self.target)
            rel_dir = "" if rel_dir == "." else rel_dir.replace("\\", "/")
            dirnames[:] = sorted(
                d for d in dirnames
                if d not in _ADOPT_SKIP_DIRS
                and not d.startswith(".")
                and not (rel_dir == "" and d in _ADOPT_VIVARY_OWNED_DIRS)
            )

            depth = 0 if not rel_dir else rel_dir.count("/") + 1
            for name in filenames:
                # Root files owned by (or reserved for) the Vivary scaffold
                # don't vote in the preset heuristic — otherwise re-running
                # adopt on an adopted tree would count its own README/SOUL/
                # STATE contract files as markdown and flip the detected
                # preset, the same reason Vivary-owned dirs are pruned above.
                if depth == 0 and name in _ADOPT_RESERVED_ROOT_FILES:
                    continue
                suffix = Path(name).suffix.lower()
                if suffix in (".md", ".markdown"):
                    self.markdown_count += 1
                    if depth >= 1 and depth <= 2:
                        md_by_dir[rel_dir] = md_by_dir.get(rel_dir, 0) + 1
                    lower = name.lower()
                    if lower in ("index.md", "readme.md"):
                        index_dirs.add(rel_dir)
                elif suffix in _ADOPT_CODE_SUFFIXES:
                    self.code_count += 1
                else:
                    self.other_count += 1

        # Candidate modules: depth 1-2 dirs with >= 5 markdown files and no
        # index.md/README.md of their own (same shape as tropo's module-router
        # heuristic, reimplemented locally so adopt has no import on the tropo
        # package).
        self.candidate_modules = sorted(
            rel_dir for rel_dir, count in md_by_dir.items()
            if count >= 5 and rel_dir not in index_dirs
        )

    def choose_preset(self, requested: str | None) -> tuple[str, str]:
        """Return (preset, reason). `requested` wins when given and valid."""
        if requested is not None:
            return requested, f"explicit --preset {requested}"
        if self.code_count == 0 and self.markdown_count == 0:
            return "coding", "empty or unrecognized tree; defaulting to coding"
        if self.markdown_count > self.code_count:
            return (
                "second-brain",
                f"markdown-majority tree ({self.markdown_count} .md vs "
                f"{self.code_count} code file(s))",
            )
        if self.markdown_count == self.code_count:
            return (
                "coding",
                f"no file-type majority ({self.code_count} code file(s) vs "
                f"{self.markdown_count} .md); defaulting to coding",
            )
        return (
            "coding",
            f"code-majority tree ({self.code_count} code file(s) vs "
            f"{self.markdown_count} .md)",
        )


def _module_id_for_candidate(rel_dir: str) -> str:
    """Derive a module id from a candidate directory's relative path.

    Nested paths flatten with `-` so `docs/guides` -> `docs-guides`, matching the
    slug shape `tropo` expects for a module id.
    """
    parts = [p for p in rel_dir.replace("\\", "/").split("/") if p]
    slug = "-".join(parts) if parts else "root"
    return slug.lower()


def _candidate_module_router_doc(project: str, rel_dir: str) -> str:
    module_id = _module_id_for_candidate(rel_dir)
    return f"""---
project: {project}
status: active
module_area: existing directory adopted from the brownfield tree
related_modules: [agent-workspace]
---
# {module_id}

## Purpose

Router for the existing `{rel_dir}/` directory, discovered during `create-vivary
adopt`. Vivary did not move, rename, or edit anything inside `{rel_dir}/` — this
index only points at it.

## Read Next

- Existing directory: `{rel_dir}/` (not managed by Vivary; read it directly)

Keep this as a thin pointer. If `{rel_dir}/` grows its own `index.md` or
`README.md` later, fold the routing here into that file instead of duplicating it.
"""


def _preexisting_module_router_doc(project: str, module_id: str) -> str:
    """Thin router for a pre-existing `modules/<id>/` directory that has no
    `index.md`. Doctor requires every module directory to carry an index — a
    filesystem check no tropo.toml exclude can satisfy — so adopt adds this one
    file and leaves everything already in the directory untouched (and excluded
    from the typed graph)."""
    return f"""---
project: {project}
status: active
module_area: pre-existing module directory adopted from the brownfield tree
related_modules: [agent-workspace]
---
# {module_id}

## Purpose

Router for the pre-existing `modules/{module_id}/` directory, found during
`create-vivary adopt`. Vivary did not move, rename, or edit anything already in
this directory; its pre-existing files are excluded from the typed graph in
`tropo.toml`.

## Read Next

- Pre-existing files: `modules/{module_id}/` (read them directly)

To bring a pre-existing file into the graph, add the module frontmatter it needs
and remove its exclude entry from `tropo.toml`.
"""


# Top-level names adopt itself writes into and must keep fully masked (adopt puts
# non-node content directly inside them, e.g. `templates/AGENTS.md`,
# `memory/.gitkeep`). Bare-name excludes are correct and safe for these because
# adopt never creates a same-named module id nested under `modules/` for them.
_ADOPT_MANAGED_TOP_LEVEL = {
    ".claude", ".agents", "templates", "memory", "heartbeat-reports",
    "modules", "changes", "decisions", "verification", "gates",
}

# Root files adopt owns or reads as-is; never re-excluded or re-planned from a
# brownfield scan (either already in the base exclude list, or handled specially
# — .gitignore is either created fresh or left untouched with followups).
_ADOPT_RESERVED_ROOT_FILES = {
    "README.md", "AGENTS.md", "SOUL.md", "STRATO.md", "STATE.md", "USER.md",
    "MEMORY.md", "bug-risk-playbook.md", "tropo.toml", ".gitignore",
}

# The tropo type folders. Pre-existing markdown inside these is typed by the
# folder-as-type rule the moment adopt drops a tropo.toml, so an untyped
# pre-existing `decisions/random.md` would fail `tropo check`/`doctor` with
# E101. Unlike `templates/` or `memory/`, these cannot be bare-name excluded —
# adopt's own graph docs live here — so pre-existing files are excluded
# per-path instead.
_ADOPT_GRAPH_TYPE_DIRS = ("changes", "decisions", "gates", "modules", "verification")


def _adopt_tropo_config(
    inventory: BrownfieldInventory, *, keep_paths: set[Path] = frozenset()
) -> tuple[str, list[str]]:
    """Same base tropo.toml exclude/type config as a fresh scaffold, adjusted so
    `tropo check`/`doctor` only validate the Vivary-managed content adopt
    creates, not brownfield content it never touched. Returns
    ``(config_text, excluded_pre_existing)`` where the second element lists the
    pre-existing graph-folder files that were excluded (for reporting).

    tropo's `is_excluded` treats any slash-free pattern as a bare directory/file
    *name* that matches at any depth (so a bare `"docs"` would also prune
    `modules/docs/index.md`, the very module router adopt just created for a
    brownfield `docs/`). Patterns that contain a `/` are start-anchored instead
    and only ever match at the root. So:

    - Non-graph directories adopt itself writes into (`templates/`, `memory/`,
      `heartbeat-reports/`, dotdirs) keep the base's bare-name exclude.
    - Every other pre-existing top-level brownfield directory (e.g. a root
      `docs/` or `src/`) is excluded by root-anchored `"<dir>/<child>"` entries
      for each of its current children instead of its bare name, so a same-named
      module router stays visible to the graph.
    - Pre-existing top-level brownfield *files* are excluded by exact name
      (root files are never nested elsewhere in the Vivary-managed tree).
    - Pre-existing *markdown* files inside the graph type folders
      (`_ADOPT_GRAPH_TYPE_DIRS`) are excluded by exact root-anchored path, so
      untyped brownfield ADRs/notes there don't fail the check while adopt's
      own newly-written docs stay graph-visible (only-adds guarantees new docs
      are new paths, never in this pre-existing enumeration). Files at paths the
      scaffold itself plans (`keep_paths`) are NOT excluded: they are kept
      as-is, and other scaffold docs reference their node ids, so excluding
      them would break edges instead of fixing anything.

    Known limitation: a file added to an excluded brownfield directory after
    adopt runs (e.g. a later `docs/new-page.md`) is not covered by the
    child-enumerated excludes and a subsequent `tropo check` would flag it.
    Adopt only has to be correct about the tree as it existed at adopt time.
    """
    excludes = list(_WORKSPACE_TROPO_EXCLUDES)

    for entry in sorted(os.scandir(inventory.target), key=lambda e: e.name):
        name = entry.name
        if name in _ADOPT_SKIP_DIRS or name.startswith("."):
            continue
        if name in _ADOPT_MANAGED_TOP_LEVEL or name in _ADOPT_RESERVED_ROOT_FILES:
            continue
        if entry.is_dir():
            if name in excludes:
                excludes.remove(name)
            children = sorted(os.listdir(entry.path))
            excludes.extend(f"{name}/{child}" for child in children)
        else:
            excludes.append(name)

    excluded_pre_existing: list[str] = []
    for dir_name in _ADOPT_GRAPH_TYPE_DIRS:
        managed = inventory.target / dir_name
        if not managed.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(managed):
            dirnames.sort()
            rel_dir = os.path.relpath(dirpath, inventory.target).replace("\\", "/")
            for fname in sorted(filenames):
                if not fname.lower().endswith((".md", ".markdown")):
                    continue
                rel = f"{rel_dir}/{fname}"
                if (inventory.target / rel) in keep_paths:
                    continue
                excluded_pre_existing.append(rel)
    excludes.extend(excluded_pre_existing)

    return _render_tropo_config(tuple(excludes)), excluded_pre_existing


def _adopt_gitignore_followups(target: Path) -> list[str]:
    """Missing privacy-ignore lines to hand the human when `.gitignore` already
    exists and adopt refuses to edit it. Maps the same probe keys `doctor` uses
    to the literal lines a human would add.

    Patterns that a root-level edit provably cannot fix get their own line instead.
    Git gives a deeper `.gitignore` precedence, so advising "add `memory/*`" when a
    nested `!secret.md` is what unignores the file recommends a fix that will not
    work — and the same defect made adopt answer a negation with another negation.
    """
    missing = _missing_privacy_ignores(target)
    unfixable = set(_unfixable_privacy_blockers(target, missing))
    followups = [
        PRIVACY_IGNORE_REPAIR_LINES[pattern]
        for pattern in missing
        if pattern in PRIVACY_IGNORE_REPAIR_LINES and pattern not in unfixable
    ]
    if unfixable:
        blocked = ", ".join(
            f"`{PRIVACY_IGNORE_PROBES[pattern][0]}`"
            for pattern in missing
            if pattern in unfixable and PRIVACY_IGNORE_PROBES.get(pattern)
        )
        followups.append(
            "A lower-level `.gitignore` unignores private/runtime paths "
            f"({blocked}); no root-level rule can override it. Inspect and remove "
            "those nested negations, then rerun `create-vivary doctor`."
        )
    return followups


def _legacy_full_plan_adopt(
    target: str | Path,
    *,
    preset: str | None = None,
    repo_root: str | Path | None = None,
) -> dict:
    """Analyze `target` and compute what `adopt` would create, read-only.

    Returns a dict with keys: `target`, `preset`, `preset_reason`, `inventory`
    (candidate module dirs + has_agents_md/has_claude_md/has_gitignore),
    `would_create` (list[Path]), `kept` (list[Path] that already exist and are
    skipped), `followups` (list[str]: manual .gitignore lines plus per-folder
    notes about pre-existing graph-folder content that was excluded),
    `gitignore_followups` / `excluded_pre_existing` (the two followup groups
    separately), `skipped_module_collisions`, and the raw `writes`/`copies`
    plan tuples for `adopt_workspace` to reuse.
    """
    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target = _resolve_scaffold_target(target)
    if not target.exists():
        raise ScaffoldError(f"adopt target does not exist: {target}")
    if not target.is_dir():
        raise ScaffoldError(f"adopt target is not a directory: {target}")

    sources = _source_paths(root)
    for label, src in sources.items():
        if not src.exists():
            raise ScaffoldError(f"missing scaffold source for {label}: {src}")

    inventory = BrownfieldInventory(target)
    chosen_preset, preset_reason = inventory.choose_preset(preset)
    if chosen_preset not in PRESETS:
        raise ScaffoldError(
            f"unknown preset {chosen_preset!r}; expected one of {', '.join(PRESETS)}"
        )

    writes, copies = _build_scaffold_plan(
        target,
        sources,
        preset=chosen_preset,
        obsidian=False,
        active_context=None,
        memory="none",
    )
    # Adopt's tropo.toml must exclude brownfield content adopt doesn't own, or a
    # correctly-adopted workspace would fail its own `doctor`/`tropo check` gate.
    # `keep_paths` are the scaffold's own planned destinations: a pre-existing
    # file sitting at one of those exact paths is kept and must stay in the
    # graph, because other scaffold docs reference its node id.
    # When tropo.toml already exists (kept — e.g. re-running adopt on an adopted
    # workspace), this run writes no config and therefore excludes nothing:
    # don't compute or report exclusions that would never land in a file.
    scaffold_planned_paths = {dst for dst, _ in writes} | {dst for _, dst in copies}
    excluded_pre_existing: list[str] = []
    if not (target / "tropo.toml").exists():
        adopt_tropo_text, excluded_pre_existing = _adopt_tropo_config(
            inventory, keep_paths=scaffold_planned_paths
        )
        writes = [
            (dst, adopt_tropo_text if dst.name == "tropo.toml" and dst.parent == target else text)
            for dst, text in writes
        ]
    project_name = target.name or "vivary-workspace"

    # A candidate router must never land on a path the scaffold itself already
    # plans to write (e.g. a brownfield top-level `codebase/` colliding with the
    # coding preset's own `modules/codebase/index.md`). Both are same-run writes,
    # so neither exists on disk yet to short-circuit via the exists() filter
    # below — silently letting the router write second would replace the typed
    # starter module doc with a thin pointer. Vivary owns the name in that case;
    # skip the router entirely rather than guess which one should win.
    # Two different candidate directories can also flatten to the same module id
    # (e.g. top-level `docs-guides/` alongside nested `docs/guides/`); track
    # emitted router paths too so the second one is skipped instead of silently
    # clobbering the first router write in the same run. A pre-existing legacy
    # `modules/<id>.md` file also blocks a router: creating the paired index
    # would trip doctor's legacy-module-file-coexists error.
    skipped_module_collisions: list[str] = []
    emitted_router_paths: set[Path] = set()
    for rel_dir in inventory.candidate_modules:
        module_id = _module_id_for_candidate(rel_dir)
        router_path = _module_index_path(target, module_id)
        if router_path in scaffold_planned_paths or router_path in emitted_router_paths:
            skipped_module_collisions.append(rel_dir)
            continue
        if (target / "modules" / f"{module_id}.md").exists():
            skipped_module_collisions.append(rel_dir)
            continue
        emitted_router_paths.add(router_path)
        writes.append(
            (
                router_path,
                _candidate_module_router_doc(project_name, rel_dir),
            )
        )

    # Pre-existing sub-directories of modules/ would fail doctor's module-index
    # check ("module directory missing index.md") — a filesystem check no
    # tropo.toml exclude can satisfy. Give each one a thin router index.md:
    # still only adding a file, never touching the directory's existing
    # contents, which the widened excludes above already keep out of the graph.
    modules_dir = target / "modules"
    if modules_dir.is_dir():
        for child in sorted(modules_dir.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            router_path = child / "index.md"
            if (
                router_path.exists()
                or router_path in scaffold_planned_paths
                or router_path in emitted_router_paths
            ):
                continue
            if (modules_dir / f"{child.name}.md").exists():
                skipped_module_collisions.append(f"modules/{child.name}")
                continue
            emitted_router_paths.add(router_path)
            writes.append(
                (router_path, _preexisting_module_router_doc(project_name, child.name))
            )

    would_create: list[Path] = []
    kept: list[Path] = []
    final_writes: list[tuple[Path, str]] = []
    final_copies: list[tuple[Path, Path]] = []
    for dst, text in writes:
        if dst.exists():
            kept.append(dst)
        else:
            would_create.append(dst)
            final_writes.append((dst, text))
    for src, dst in copies:
        if dst.exists():
            kept.append(dst)
        else:
            would_create.append(dst)
            final_copies.append((src, dst))

    would_create = sorted(set(would_create))
    kept = sorted(set(kept))
    gitignore_followups = _adopt_gitignore_followups(target) if inventory.has_gitignore else []
    excluded_dirs = sorted({rel.split("/", 1)[0] for rel in excluded_pre_existing})
    exclusion_followups = [
        f"pre-existing content under {dir_name}/ was excluded from the typed graph "
        "in tropo.toml; add frontmatter and remove its exclude entries to bring it in"
        for dir_name in excluded_dirs
    ]

    return {
        "target": target,
        "preset": chosen_preset,
        "preset_reason": preset_reason,
        "inventory": inventory,
        "would_create": would_create,
        "kept": kept,
        "followups": gitignore_followups + exclusion_followups,
        "gitignore_followups": gitignore_followups,
        "excluded_pre_existing": sorted(excluded_pre_existing),
        "skipped_module_collisions": sorted(skipped_module_collisions),
        "writes": final_writes,
        "copies": final_copies,
    }


def _thin_agents_block() -> str:
    return f"""{_THIN_AGENTS_BLOCK_START}
## Vivary context

Read `.vivary/context.md` before acting. It routes bounded project context,
verification receipts, privacy, current state, and deliberate human gates.
{_THIN_AGENTS_BLOCK_END}
"""


def _thin_gitignore_block(*, active_context: str | None = None) -> str:
    rules = list(_THIN_PRIVATE_RULES)
    if active_context == "cocoindex-code":
        rules.append(".cocoindex_code/")
    rules_text = "\n".join(rules)
    return f"""{_THIN_GITIGNORE_BLOCK_START}
{rules_text}
{_THIN_GITIGNORE_BLOCK_END}
"""


def _thin_context_doc(project: str, preset: str) -> str:
    return f"""---
status: active
preset: {preset}
---
# {project} context

Vivary is this workspace's local-first governed-context layer. It gives agents
bounded project evidence and task capsules; records provenance, verification, and
receipts; and leaves consequential authority at explicit human gates.

## Work loop

Ask -> retrieve -> act -> verify -> learn -> gate. State what is known, inferred,
or unknown. Retrieve only the evidence the task needs. Preserve conflicting truth
instead of guessing. Treat a successful tool call as activity, not proof.

## Routes

- Use `tropo find --governed` for bounded graph-backed context when installed.
- Optional MCP stays off until separately installed and explicitly enabled. A local
  client can bind this root with `vivary-mcp --workspace project .`; its four tools
  read and query only, and never authorize a write.
- Read `STATE.md` only when current status affects the task. One orchestrator or
  human owns it; workers return receipts instead of editing it concurrently.
- Add one real record lazily only when work earns it. Bind the proposal to a Task
  Capsule with `create-vivary record`, inspect its exact dry-run hash, and apply only
  the human-approved plan. Never seed or bulk-load `.vivary/records/`.
- Keep private material under `.vivary/private/` and runtime artifacts under
  `.vivary/runtime/`; neither belongs in version control.

## Gates

Get deliberate human approval for publishing, external writes, destructive work,
credentials, authority expansion, and any ambiguity the evidence cannot resolve.
"""


def _thin_workspace_toml(
    preset: str,
    adapters: tuple[str, ...] | list[str] = (),
    *,
    active_context: str | None = None,
) -> str:
    adapter_list = ", ".join(json.dumps(adapter) for adapter in sorted(adapters))
    capability_list = json.dumps(active_context) if active_context is not None else ""
    excludes = [".git", ".agents", ".vivary/private", ".vivary/runtime"]
    if active_context == "cocoindex-code":
        excludes.append(".cocoindex_code")
    exclude_list = ", ".join(json.dumps(path) for path in excludes)
    return f'''version = 1
exclude = [{exclude_list}]

[workspace]
contract = "{THIN_WORKSPACE_CONTRACT}"
preset = "{preset}"
state = "STATE.md"
private = [".vivary/private"]
runtime = [".vivary/runtime"]
adapters = [{adapter_list}]
capabilities = [{capability_list}]

[base]
derive = ["id", "title"]
allow_untyped = true
optional = {{ tags = "string-list" }}

[types.project]
folder = [".vivary", "projects"]
required = {{ status = "enum:idea|active|paused|shipped|archived" }}
optional = {{ preset = "string", repo = "url", target_ship = "date" }}

[types.module]
folder = "modules"
required = {{ project = "string", status = "enum:active|draft|blocked|archived", module_area = "string" }}
optional = {{ related_modules = "ref-list", related_changes = "ref-list", verification = "ref-list", gates = "ref-list", source_files = "string-list", test_files = "string-list" }}

[types.change]
folder = "changes"
required = {{ project = "string", status = "enum:planned|active|done|blocked|deferred", slice = "string" }}
optional = {{ branch = "string", related_modules = "ref-list", related_changes = "ref-list", verification = "ref-list", gates = "ref-list" }}

[types.decision]
folder = "decisions"
required = {{ project = "string", status = "enum:proposed|accepted|deferred|superseded", date = "date" }}
optional = {{ supersedes = "ref", superseded_by = "ref", related_modules = "ref-list", related_changes = "ref-list", rationale = "string" }}

[types.verification]
folder = "verification"
required = {{ project = "string", status = "enum:planned|passed|failed|blocked|deferred", target = "string" }}
optional = {{ command = "string", evidence = "any", related_modules = "ref-list", related_changes = "ref-list" }}

[types.gate]
folder = "gates"
required = {{ project = "string", status = "enum:open|approved|rejected|deferred", gate = "string" }}
optional = {{ approver = "string", approved_at = "datetime", command_intent = "string", related_modules = "ref-list", related_changes = "ref-list" }}
'''


def _thin_state_doc() -> str:
    return """# State

Focus:

Status:

Next:

Open decisions:

Blockers:

Checks:

Updated:
"""


def _thin_active_context_writes(target: Path) -> list[tuple[Path, str]]:
    docs = """# Active context: cocoindex-code

This optional local sidecar may derive code context after an explicit human gate.
Vivary's source files remain authoritative. Keep generated indexes outside governed
records, respect `.gitignore` and `.vivary/private/`, and return source-linked
verification receipts rather than treating retrieval as proof.
"""
    skill = """---
name: active-context
description: Use the optional local cocoindex-code sidecar without expanding authority.
---
# Active context

Read `.vivary/context.md` first. Use the sidecar only when the task benefits from
code retrieval and the human has approved any required install or indexing step.
Fail closed on privacy uncertainty. Verify every candidate against its source file
and return a receipt; never approve a gate or treat an index as source of truth.
"""
    if len(skill.encode("utf-8")) > _THIN_ADAPTER_MAX_BYTES:
        raise ScaffoldError("generated active-context projection exceeds byte budget")
    return [
        (target / "docs" / "active-context.md", docs),
        (target / ".agents" / "skills" / "active-context" / "SKILL.md", skill),
    ]


def _valid_existing_thin_contract(
    target: Path,
    *,
    preset: str,
    adapters: tuple[str, ...],
    repo_root: Path,
) -> tuple[bool, bool]:
    """Validate user-extended v0.3 config and its project capsule read-only."""
    config_path = target / ".vivary" / "workspace.toml"
    context_path = target / ".vivary" / "context.md"
    try:
        if (
            not config_path.is_file()
            or _is_symlink_or_junction(config_path)
            or config_path.stat().st_size > 1024 * 1024
        ):
            return False, False
        import tomllib as _toml

        raw = _toml.loads(config_path.read_text(encoding="utf-8-sig"))
        workspace = raw.get("workspace")
        if (
            not isinstance(workspace, dict)
            or workspace.get("contract") != THIN_WORKSPACE_CONTRACT
            or workspace.get("preset") != preset
            or sorted(workspace.get("adapters", [])) != sorted(adapters)
        ):
            return False, False
        tropo = _load_tropo(repo_root)
        resolver = tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
    except Exception:
        return False, False

    try:
        if (
            not context_path.is_file()
            or _is_symlink_or_junction(context_path)
            or context_path.stat().st_size > 1024 * 1024
        ):
            return True, False
        effective = resolver.for_dir(str(context_path.parent))
        doc = tropo.analyze_file(
            str(context_path),
            ".vivary/context.md",
            effective,
            use_git_dates=False,
        )
    except Exception:
        return True, False
    return True, doc.type == "project" and not doc.findings


def _thin_adapter_doc(adapter: str) -> tuple[str, str, str]:
    source = (
        f"{THIN_WORKSPACE_CONTRACT}:{adapter}:"
        "route=.vivary/context.md;commands=tropo-find,tropo-check,create-vivary-doctor"
    )
    source_hash = _sha256_prefixed(source.encode("utf-8"))
    body = f"""---
name: vivary
description: Route this agent runtime through the local Vivary context contract.
---
# Vivary

Read `.vivary/context.md` first. Read `STATE.md` only when current state matters.
Use `tropo find --governed` for bounded context, `tropo check` for graph integrity,
and `create-vivary doctor .` for workspace health. Return verification receipts;
do not approve gates, write private context, or expand authority.
"""
    content_hash = _sha256_prefixed(body.encode("utf-8"))
    text = (
        f"<!-- generated-by: create-vivary {__version__} -->\n"
        f"<!-- adapter: {adapter} -->\n"
        f"<!-- source-hash: {source_hash} -->\n"
        f"<!-- content-hash: {content_hash} -->\n"
        + body
    )
    if len(text.encode("utf-8")) > _THIN_ADAPTER_MAX_BYTES:
        raise ScaffoldError(f"generated {adapter} adapter exceeds byte budget")
    return text, source_hash, content_hash


def _is_known_stale_thin_adapter(data: bytes, current_text: str) -> bool:
    """Recognize only an exact generated adapter whose generator version is older.

    The complete generated suffix, including source/content hashes and body, must
    match today's allowlisted projection. Only the semver marker may differ, so
    user-authored or edited content can never qualify for replacement.
    """
    first_line, separator, suffix = data.partition(b"\n")
    if not separator:
        return False
    expected_first, _, expected_suffix = current_text.encode("utf-8").partition(b"\n")
    match = re.fullmatch(
        rb"<!-- generated-by: create-vivary ([0-9]+\.[0-9]+\.[0-9]+) -->",
        first_line,
    )
    if match is None or suffix != expected_suffix:
        return False
    current_match = re.fullmatch(
        rb"<!-- generated-by: create-vivary ([0-9]+\.[0-9]+\.[0-9]+) -->",
        expected_first,
    )
    if current_match is None:
        return False
    generated_version = tuple(int(part) for part in match.group(1).split(b"."))
    current_version = tuple(int(part) for part in current_match.group(1).split(b"."))
    return generated_version < current_version


def _sha256_prefixed(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def _append_patch_text(existing: bytes, block: str) -> str:
    if not existing:
        return block
    prefix = "\n" if existing.endswith((b"\n", b"\r")) else "\n\n"
    return prefix + block


def _thin_target_identity(target: Path) -> dict[str, str | int]:
    """Bind approval to one canonical directory, not only its relative contents."""
    try:
        resolved = target.resolve(strict=True)
        info = os.stat(resolved, follow_symlinks=False)
    except OSError as exc:
        raise ScaffoldError(f"cannot bind adoption plan to target root: {exc}") from exc
    if not stat.S_ISDIR(info.st_mode) or _is_symlink_or_junction(resolved):
        raise ScaffoldError("adoption target root must be a regular non-link directory")
    return {
        "canonical_path": os.path.normcase(str(resolved)),
        "device": int(info.st_dev),
        "inode": int(info.st_ino),
    }


def _thin_plan_payload(
    target: Path,
    *,
    preset: str,
    adapters: tuple[str, ...] | list[str],
    writes: list[tuple[Path, str]],
    patches: list[dict],
    adapter_replacements: list[dict],
    kept_identities: list[dict],
) -> dict:
    return {
        "contract": THIN_WORKSPACE_CONTRACT,
        "target": _thin_target_identity(target),
        "preset": preset,
        "adapters": sorted(adapters),
        "creates": [
            {
                "path": path.relative_to(target).as_posix(),
                "content_hash": _sha256_prefixed(text.encode("utf-8")),
            }
            for path, text in sorted(writes)
        ],
        "patches": [
            {
                "path": patch["path"].relative_to(target).as_posix(),
                "before_hash": patch["before_hash"],
                "anchor": patch["anchor"],
                "inserted_text": patch["inserted_text"],
            }
            for patch in sorted(patches, key=lambda item: item["path"])
        ],
        "adapter_replacements": [
            {
                "path": item["path"].relative_to(target).as_posix(),
                "before_hash": item["before_hash"],
                "content_hash": _sha256_prefixed(item["text"].encode("utf-8")),
            }
            for item in sorted(adapter_replacements, key=lambda row: row["path"])
        ],
        "kept": kept_identities,
    }


def _thin_approval_hash(payload: dict) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return _sha256_prefixed(encoded)


def plan_adopt(
    target: str | Path,
    *,
    preset: str | None = None,
    adapters: tuple[str, ...] | list[str] = (),
    repo_root: str | Path | None = None,
) -> dict:
    """Return the deterministic, read-only thin-v0.3 brownfield adoption plan."""
    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target = _resolve_scaffold_target(target)
    if not target.exists():
        raise ScaffoldError(f"adopt target does not exist: {target}")
    if not target.is_dir():
        raise ScaffoldError(f"adopt target is not a directory: {target}")

    inventory = BrownfieldInventory(target)
    chosen_preset, preset_reason = inventory.choose_preset(preset)
    if chosen_preset not in PRESETS:
        raise ScaffoldError(
            f"unknown preset {chosen_preset!r}; expected one of {', '.join(PRESETS)}"
        )
    selected_adapters = tuple(adapters)
    unknown_adapters = sorted(set(selected_adapters) - set(_THIN_ADAPTER_PATHS))
    if unknown_adapters:
        raise ScaffoldError(
            "unknown adapter(s): " + ", ".join(unknown_adapters)
            + "; expected agents or claude"
        )
    if len(set(selected_adapters)) != len(selected_adapters):
        raise ScaffoldError("each --adapter value may be selected only once")

    valid_existing_config, valid_existing_context = _valid_existing_thin_contract(
        target,
        preset=chosen_preset,
        adapters=selected_adapters,
        repo_root=root,
    )

    project = target.name or "vivary-workspace"
    desired = {
        target / ".vivary" / "context.md": _thin_context_doc(project, chosen_preset),
        target / ".vivary" / "workspace.toml": _thin_workspace_toml(
            chosen_preset,
            selected_adapters,
        ),
        target / "STATE.md": _thin_state_doc(),
    }
    writes: list[tuple[Path, str]] = []
    projection_writes: list[tuple[Path, str]] = []
    adapter_replacements: list[dict] = []
    optional_projections: list[dict] = []
    patches: list[dict] = []
    kept: list[Path] = []
    conflicts: list[dict] = []

    vivary_dir = target / ".vivary"
    invalid_vivary_dir = vivary_dir.exists() and (
        not vivary_dir.is_dir() or _is_symlink_or_junction(vivary_dir)
    )
    if invalid_vivary_dir:
        conflicts.append(
            {"path": vivary_dir, "reason": ".vivary must be a regular directory"}
        )

    for path, text in desired.items():
        if invalid_vivary_dir and path.parent == vivary_dir:
            continue
        if not path.exists():
            writes.append((path, text))
            continue
        if _is_symlink_or_junction(path) or not path.is_file():
            conflicts.append({"path": path, "reason": "destination is not a regular file"})
            continue
        if path.name == "STATE.md":
            kept.append(path)
            continue
        if path == target / ".vivary" / "workspace.toml" and valid_existing_config:
            kept.append(path)
        elif path == target / ".vivary" / "context.md" and valid_existing_context:
            kept.append(path)
        else:
            conflicts.append(
                {"path": path, "reason": f"existing file is not {THIN_WORKSPACE_CONTRACT}"}
            )

    for adapter in sorted(selected_adapters):
        rel = _THIN_ADAPTER_PATHS[adapter]
        path = target / Path(rel)
        text, source_hash, content_hash = _thin_adapter_doc(adapter)
        projection = {
            "adapter": adapter,
            "path": path,
            "bytes": len(text.encode("utf-8")),
            "source_hash": source_hash,
            "content_hash": content_hash,
        }
        if not path.exists():
            projection["status"] = "create"
            projection_writes.append((path, text))
            optional_projections.append(projection)
            continue
        elif _is_symlink_or_junction(path) or not path.is_file():
            projection["status"] = "conflict"
            conflicts.append({"path": path, "reason": "adapter destination is not a regular file"})
            optional_projections.append(projection)
            continue

        adapter_bytes = path.read_bytes()
        if adapter_bytes == text.encode("utf-8"):
            projection["status"] = "clean"
            kept.append(path)
        elif _is_known_stale_thin_adapter(adapter_bytes, text):
            projection["status"] = "replace"
            adapter_replacements.append(
                {
                    "path": path,
                    "before_hash": _sha256_prefixed(adapter_bytes),
                    "text": text,
                }
            )
        else:
            projection["status"] = "conflict"
            conflicts.append({"path": path, "reason": "adapter content is user-owned"})
        optional_projections.append(projection)

    agents_path = target / "AGENTS.md"
    agents_block = _thin_agents_block()
    if not agents_path.exists():
        writes.append((agents_path, "# AGENTS.md\n\n" + agents_block))
    elif _is_symlink_or_junction(agents_path) or not agents_path.is_file():
        conflicts.append({"path": agents_path, "reason": "AGENTS.md is not a regular file"})
    else:
        agents_bytes = agents_path.read_bytes()
        try:
            agents_text = agents_bytes.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            conflicts.append({"path": agents_path, "reason": "AGENTS.md is not UTF-8"})
        else:
            starts = agents_text.count(_THIN_AGENTS_BLOCK_START)
            ends = agents_text.count(_THIN_AGENTS_BLOCK_END)
            if starts == 1 and ends == 1 and agents_block.rstrip() in agents_text:
                kept.append(agents_path)
            elif starts or ends:
                conflicts.append(
                    {"path": agents_path, "reason": "duplicate or malformed Vivary block"}
                )
            else:
                patches.append(
                    {
                        "path": agents_path,
                        "before_hash": _sha256_prefixed(agents_bytes),
                        "anchor": "eof",
                        "inserted_text": _append_patch_text(agents_bytes, agents_block),
                    }
                )

    gitignore_path = target / ".gitignore"
    gitignore_block = _thin_gitignore_block()
    if not gitignore_path.exists():
        writes.append((gitignore_path, gitignore_block))
        privacy_status = "planned"
    elif _is_symlink_or_junction(gitignore_path) or not gitignore_path.is_file():
        conflicts.append({"path": gitignore_path, "reason": ".gitignore is not a regular file"})
        privacy_status = "conflict"
    else:
        gitignore_bytes = gitignore_path.read_bytes()
        try:
            gitignore_text = gitignore_bytes.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            conflicts.append({"path": gitignore_path, "reason": ".gitignore is not UTF-8"})
            privacy_status = "conflict"
        else:
            prejournal = _prejournal_privacy_match(gitignore_bytes)
            if prejournal is not None:
                conflicts.append(
                    {
                        "path": gitignore_path,
                        "reason": (
                            "unfinished pre-journal adoption privacy replacement; "
                            f"recover {prejournal.group(1).decode('ascii')}"
                        ),
                    }
                )
                privacy_status = "conflict"
            elif _ADOPT_PREJOURNAL_MARKER_PREFIX in gitignore_text:
                conflicts.append(
                    {"path": gitignore_path, "reason": "malformed pre-journal adoption marker"}
                )
                privacy_status = "conflict"
            else:
                starts = gitignore_text.count(_THIN_GITIGNORE_BLOCK_START)
                ends = gitignore_text.count(_THIN_GITIGNORE_BLOCK_END)
                if starts == 1 and ends == 1 and gitignore_block.rstrip() in gitignore_text:
                    kept.append(gitignore_path)
                    privacy_status = "satisfied"
                elif starts or ends:
                    conflicts.append(
                        {"path": gitignore_path, "reason": "duplicate or malformed Vivary block"}
                    )
                    privacy_status = "conflict"
                else:
                    patches.append(
                        {
                            "path": gitignore_path,
                            "before_hash": _sha256_prefixed(gitignore_bytes),
                            "anchor": "eof",
                            "inserted_text": _append_patch_text(gitignore_bytes, gitignore_block),
                        }
                    )
                    privacy_status = "planned"

    if privacy_status != "conflict":
        privacy_is_planned = any(path == gitignore_path for path, _ in writes) or any(
            patch["path"] == gitignore_path for patch in patches
        )
        simulated_rules = (
            tuple(
                ("", parsed[0], parsed[1])
                for line in gitignore_block.splitlines()
                if (parsed := _parse_gitignore_line(line)) is not None
            )
            if privacy_is_planned
            else ()
        )
        missing_privacy = [
            pattern
            for pattern, probes in _THIN_PRIVACY_PROBES.items()
            if not all(
                _probe_is_ignored(target, probe, extra_root_rules=simulated_rules)
                for probe in probes
            )
        ]
        if missing_privacy:
            privacy_status = "conflict"
            nested_conflicts: set[Path] = set()
            for probes in _THIN_PRIVACY_PROBES.values():
                for probe in probes:
                    parts = Path(probe).parts
                    for depth in range(1, len(parts)):
                        nested = target.joinpath(*parts[:depth]) / ".gitignore"
                        if nested.exists():
                            nested_conflicts.add(nested)
            if not nested_conflicts:
                nested_conflicts.add(gitignore_path)
            reason = (
                "nested or contradictory .gitignore rules leave Vivary "
                "private/runtime paths committable: " + ", ".join(missing_privacy)
            )
            conflicts.extend(
                {"path": path, "reason": reason} for path in sorted(nested_conflicts)
            )

    writes.sort(key=lambda item: item[0])
    projection_writes.sort(key=lambda item: item[0])
    adapter_replacements.sort(key=lambda item: item["path"])
    patches.sort(key=lambda item: item["path"])
    kept = sorted(set(kept))
    kept_identities = [
        {
            "path": path.relative_to(target).as_posix(),
            "content_hash": _sha256_prefixed(path.read_bytes()),
        }
        for path in kept
        if path.is_file() and not _is_symlink_or_junction(path)
    ]
    conflicts.sort(key=lambda item: item["path"])
    creates = [path for path, _ in writes]
    approval_payload = _thin_plan_payload(
        target,
        preset=chosen_preset,
        adapters=selected_adapters,
        writes=writes + projection_writes,
        patches=patches,
        adapter_replacements=adapter_replacements,
        kept_identities=kept_identities,
    )
    plan_hash = _thin_approval_hash(approval_payload)

    return {
        "contract": THIN_WORKSPACE_CONTRACT,
        "target": target,
        "preset": chosen_preset,
        "preset_reason": preset_reason,
        "inventory": inventory,
        "creates": creates,
        "patches": patches,
        "optional_projections": optional_projections,
        "adapter_replacements": adapter_replacements,
        "kept": kept,
        "kept_identities": kept_identities,
        "conflicts": conflicts,
        "privacy": {"status": privacy_status, "rules": list(_THIN_PRIVATE_RULES)},
        "plan_hash": plan_hash,
        "approval_payload": approval_payload,
        # Transitional aliases keep report consumers readable during the
        # following apply/Doctor slice; they contain only thin-v0.3 paths.
        "would_create": creates,
        "followups": [],
        "gitignore_followups": [],
        "excluded_pre_existing": [],
        "skipped_module_collisions": [],
        "writes": writes + projection_writes,
        "copies": [],
    }


_ADOPT_JOURNAL_REL = Path(".vivary/runtime/adopt-journal.json")
_ADOPT_JOURNAL_SCHEMA = "vivary.adopt-journal.v2"
_ADOPT_RECOVERY_PLAN_SCHEMA = "vivary.adopt-recovery-plan.v1"
_ADOPT_PREJOURNAL_RE = re.compile(
    rb"# vivary-adopt-prejournal "
    rb"plan=(sha256:[0-9a-f]{64}) "
    rb"existed=([01]) "
    rb"before=(none|sha256:[0-9a-f]{64}) "
    rb"size=([0-9]+)\n\Z"
)


def _adopt_actions(plan: dict) -> list[dict]:
    target = plan["target"]
    gitignore = target / ".gitignore"
    actions: list[dict] = []
    for path, text in plan["writes"]:
        actions.append(
            {
                "kind": "create",
                "path": path,
                "after": text.encode("utf-8"),
            }
        )
    for patch in plan["patches"]:
        before = patch["path"].read_bytes()
        actions.append(
            {
                "kind": "patch",
                "path": patch["path"],
                "before_hash": patch["before_hash"],
                "after": before + patch["inserted_text"].encode("utf-8"),
            }
        )
    for replacement in plan.get("adapter_replacements", []):
        actions.append(
            {
                "kind": "replace",
                "path": replacement["path"],
                "before_hash": replacement["before_hash"],
                "after": replacement["text"].encode("utf-8"),
            }
        )
    return sorted(
        actions,
        key=lambda action: (
            0 if action["path"] == gitignore else 1,
            action["path"].relative_to(target).as_posix(),
        ),
    )


def _adopt_backups(actions: list[dict]) -> dict[Path, bytes | None]:
    return {
        action["path"]: action["path"].read_bytes() if action["path"].exists() else None
        for action in actions
    }


def _assert_adopt_kept_inputs(target: Path, plan: dict) -> None:
    for identity in plan.get("kept_identities", []):
        path = target / Path(identity["path"])
        _ensure_within_target(target, [path])
        if _is_symlink_or_junction(path) or not path.is_file():
            raise ScaffoldError(f"approved plan input changed: {identity['path']}")
        if _sha256_prefixed(path.read_bytes()) != identity["content_hash"]:
            raise ScaffoldError(f"approved plan input changed: {identity['path']}")


def _adopt_journal_payload(
    plan: dict,
    actions: list[dict],
    backups: dict[Path, bytes | None],
    *,
    phase: str,
    completed: int,
) -> dict:
    target = plan["target"]
    return {
        "schema": _ADOPT_JOURNAL_SCHEMA,
        "plan_hash": plan["plan_hash"],
        "approval": plan["approval_payload"],
        "phase": phase,
        "completed": completed,
        "actions": [
            {
                "path": action["path"].relative_to(target).as_posix(),
                "kind": action["kind"],
                "existed": backups[action["path"]] is not None,
                "before": (
                    base64.b64encode(backups[action["path"]]).decode("ascii")
                    if backups[action["path"]] is not None
                    else None
                ),
                "before_hash": (
                    _sha256_prefixed(backups[action["path"]])
                    if backups[action["path"]] is not None
                    else None
                ),
                "after_hash": _sha256_prefixed(action["after"]),
                "transient_after_hash": (
                    _sha256_prefixed(action["transient_after"])
                    if action.get("transient_after") is not None
                    else None
                ),
            }
            for action in actions
        ],
    }


def _write_adopt_journal(target: Path, payload: dict) -> None:
    _write_text_no_follow(
        target,
        target / _ADOPT_JOURNAL_REL,
        json.dumps(payload, sort_keys=True, indent=2) + "\n",
    )


def _remove_empty_adopt_dirs(target: Path) -> None:
    for path in (target / ".vivary" / "runtime", target / ".vivary"):
        try:
            _rmdir_no_follow(target, path, missing_ok=True)
        except (OSError, ScaffoldError):
            pass


def _adopt_action_after_hashes(action: dict) -> set[str]:
    hashes = {
        action.get("after_hash") or _sha256_prefixed(action["after"]),
    }
    transient_hash = action.get("transient_after_hash")
    if transient_hash is None and action.get("transient_after") is not None:
        transient_hash = _sha256_prefixed(action["transient_after"])
    if transient_hash is not None:
        hashes.add(transient_hash)
    return hashes


def _rollback_adopt(
    target: Path,
    actions: list[dict],
    backups: dict[Path, bytes | None],
    *,
    cleanup_journal: bool = True,
) -> None:
    failures: list[str] = []
    for action in reversed(actions):
        path = action["path"]
        before = backups[path]
        try:
            if before is None:
                if not path.exists():
                    continue
                if _is_symlink_or_junction(path) or not path.is_file():
                    raise ScaffoldError("created destination changed type")
                if _sha256_prefixed(path.read_bytes()) not in _adopt_action_after_hashes(action):
                    raise ScaffoldError("created destination changed after apply")
                _unlink_no_follow(
                    target,
                    path,
                    expected_hashes=_adopt_action_after_hashes(action),
                )
            else:
                if not path.exists() or _is_symlink_or_junction(path) or not path.is_file():
                    raise ScaffoldError("modified destination is missing or unsafe")
                current = path.read_bytes()
                if current == before:
                    continue
                if _sha256_prefixed(current) not in _adopt_action_after_hashes(action):
                    raise ScaffoldError("modified destination changed after apply")
                _write_bytes_no_follow(target, path, before)
        except (OSError, ScaffoldError) as exc:
            failures.append(f"{path.relative_to(target).as_posix()}: {exc}")
    if failures:
        raise ScaffoldError("rollback failed: " + "; ".join(failures))
    if cleanup_journal:
        journal = target / _ADOPT_JOURNAL_REL
        if journal.exists() and not _is_symlink_or_junction(journal):
            _unlink_no_follow(target, journal)
        _remove_empty_adopt_dirs(target)


def _apply_adopt_action(target: Path, action: dict, *, after: bytes | None = None) -> None:
    path = action["path"]
    if action["kind"] == "create":
        if path.exists() or _is_symlink_or_junction(path):
            raise ScaffoldError(
                f"planned create appeared before apply: {path.relative_to(target).as_posix()}"
            )
    else:
        if not path.is_file() or _is_symlink_or_junction(path):
            raise ScaffoldError(
                f"planned patch became unsafe: {path.relative_to(target).as_posix()}"
            )
        if _sha256_prefixed(path.read_bytes()) != action["before_hash"]:
            raise ScaffoldError(
                f"planned patch input changed: {path.relative_to(target).as_posix()}"
            )
    _write_bytes_no_follow(target, path, action["after"] if after is None else after)


def _prejournal_privacy_bytes(
    action: dict,
    before: bytes | None,
    plan_hash: str,
) -> bytes:
    before_hash = _sha256_prefixed(before) if before is not None else "none"
    marker = (
        f"{_ADOPT_PREJOURNAL_MARKER_PREFIX}"
        f"plan={plan_hash} "
        f"existed={1 if before is not None else 0} "
        f"before={before_hash} "
        f"size={len(before or b'')}\n"
    ).encode("ascii")
    return action["after"] + marker


def _prejournal_privacy_match(data: bytes) -> re.Match[bytes] | None:
    return _ADOPT_PREJOURNAL_RE.search(data)


def _prejournal_recovery_state(
    target: Path,
    recover_hash: str,
) -> tuple[list[dict], dict[Path, bytes | None]] | None:
    gitignore = target / ".gitignore"
    if _is_symlink_or_junction(gitignore) or not gitignore.is_file():
        return None
    data = gitignore.read_bytes()
    match = _prejournal_privacy_match(data)
    if match is None:
        if _ADOPT_PREJOURNAL_MARKER_PREFIX.encode("ascii") in data:
            raise ScaffoldError("pre-journal adoption marker is malformed")
        return None

    marker_hash = match.group(1).decode("ascii")
    if marker_hash != recover_hash:
        raise ScaffoldError(
            f"recovery hash mismatch: pre-journal {marker_hash}, requested {recover_hash}"
        )
    existed = match.group(2) == b"1"
    before_hash = match.group(3).decode("ascii")
    before_size = int(match.group(4))
    clean_after = data[: match.start()]
    if before_size > len(clean_after):
        raise ScaffoldError("pre-journal adoption marker has an invalid input size")
    before = clean_after[:before_size]
    expected_before_hash = _sha256_prefixed(before) if existed else "none"
    if expected_before_hash != before_hash or (not existed and before):
        raise ScaffoldError("pre-journal adoption input hash does not match")
    expected_after = (
        before + _append_patch_text(before, _thin_gitignore_block()).encode("utf-8")
        if existed
        else _thin_gitignore_block().encode("utf-8")
    )
    if clean_after != expected_after:
        raise ScaffoldError("pre-journal adoption privacy replacement changed unexpectedly")

    return (
        [
            {
                "kind": "patch" if existed else "create",
                "path": gitignore,
                "after_hash": _sha256_prefixed(clean_after),
                "transient_after_hash": _sha256_prefixed(data),
            }
        ],
        {gitignore: before if existed else None},
    )


def _adopt_expected_generated_bytes(
    target: Path,
    preset: str,
    adapters: tuple[str, ...],
) -> dict[str, bytes]:
    project = target.name or "vivary-workspace"
    expected = {
        ".gitignore": _thin_gitignore_block().encode("utf-8"),
        ".vivary/context.md": _thin_context_doc(project, preset).encode("utf-8"),
        ".vivary/workspace.toml": _thin_workspace_toml(preset, adapters).encode("utf-8"),
        "AGENTS.md": ("# AGENTS.md\n\n" + _thin_agents_block()).encode("utf-8"),
        "STATE.md": _thin_state_doc().encode("utf-8"),
    }
    for adapter in adapters:
        text, _source_hash, _content_hash = _thin_adapter_doc(adapter)
        expected[_THIN_ADAPTER_PATHS[adapter]] = text.encode("utf-8")
    return expected


def _validated_journal_state(
    target: Path,
    payload: dict,
    recover_hash: str,
) -> tuple[list[dict], dict[Path, bytes | None]]:
    if payload.get("schema") != _ADOPT_JOURNAL_SCHEMA:
        raise ScaffoldError("adoption journal schema is not supported")
    if payload.get("plan_hash") != recover_hash:
        raise ScaffoldError(
            f"recovery hash mismatch: journal {payload.get('plan_hash')}, "
            f"requested {recover_hash}"
        )
    approval = payload.get("approval")
    approval_keys = {
        "contract",
        "target",
        "preset",
        "adapters",
        "creates",
        "patches",
        "adapter_replacements",
        "kept",
    }
    if not isinstance(approval, dict) or set(approval) != approval_keys:
        raise ScaffoldError("adoption journal approval payload is malformed")
    if approval["contract"] != THIN_WORKSPACE_CONTRACT:
        raise ScaffoldError("adoption journal approval contract is not supported")
    if approval["target"] != _thin_target_identity(target):
        raise ScaffoldError("adoption journal is bound to a different workspace root")
    if _thin_approval_hash(approval) != recover_hash:
        raise ScaffoldError("adoption journal approval hash does not match")

    preset = approval["preset"]
    raw_adapters = approval["adapters"]
    if preset not in PRESETS or not isinstance(raw_adapters, list):
        raise ScaffoldError("adoption journal approval policy is malformed")
    if (
        any(not isinstance(adapter, str) for adapter in raw_adapters)
        or raw_adapters != sorted(set(raw_adapters))
        or set(raw_adapters) - set(_THIN_ADAPTER_PATHS)
    ):
        raise ScaffoldError("adoption journal approval adapters are malformed")
    adapters = tuple(raw_adapters)
    expected_bytes = _adopt_expected_generated_bytes(target, preset, adapters)
    allowed_paths = set(expected_bytes)
    expected_actions: dict[str, dict] = {}

    creates = approval["creates"]
    patches = approval["patches"]
    replacements = approval["adapter_replacements"]
    kept = approval["kept"]
    if not all(isinstance(rows, list) for rows in (creates, patches, replacements, kept)):
        raise ScaffoldError("adoption journal approval actions are malformed")
    if sum(len(rows) for rows in (creates, patches, replacements, kept)) > 32:
        raise ScaffoldError("adoption journal approval exceeds the action limit")

    for row in creates:
        if not isinstance(row, dict) or set(row) != {"path", "content_hash"}:
            raise ScaffoldError("adoption journal approved create is malformed")
        rel = row["path"]
        if (
            rel not in allowed_paths
            or row["content_hash"] != _sha256_prefixed(expected_bytes[rel])
            or rel in expected_actions
        ):
            raise ScaffoldError("adoption journal approved create is not canonical")
        expected_actions[rel] = {
            "kind": "create",
            "before_hash": None,
            "after_hash": row["content_hash"],
        }

    patch_blocks = {
        "AGENTS.md": _thin_agents_block(),
        ".gitignore": _thin_gitignore_block(),
    }
    for row in patches:
        if not isinstance(row, dict) or set(row) != {
            "path",
            "before_hash",
            "anchor",
            "inserted_text",
        }:
            raise ScaffoldError("adoption journal approved patch is malformed")
        rel = row["path"]
        if rel not in patch_blocks or row["anchor"] != "eof" or rel in expected_actions:
            raise ScaffoldError("adoption journal approved patch is not canonical")
        expected_actions[rel] = {"kind": "patch", **row}

    adapter_paths = {_THIN_ADAPTER_PATHS[adapter] for adapter in adapters}
    for row in replacements:
        if not isinstance(row, dict) or set(row) != {
            "path",
            "before_hash",
            "content_hash",
        }:
            raise ScaffoldError("adoption journal approved replacement is malformed")
        rel = row["path"]
        if (
            rel not in adapter_paths
            or row["content_hash"] != _sha256_prefixed(expected_bytes[rel])
            or rel in expected_actions
        ):
            raise ScaffoldError("adoption journal approved replacement is not canonical")
        expected_actions[rel] = {
            "kind": "replace",
            "before_hash": row["before_hash"],
            "after_hash": row["content_hash"],
        }

    seen_kept: set[str] = set()
    for row in kept:
        if not isinstance(row, dict) or set(row) != {"path", "content_hash"}:
            raise ScaffoldError("adoption journal approved kept input is malformed")
        rel = row["path"]
        if rel not in allowed_paths or rel in expected_actions or rel in seen_kept:
            raise ScaffoldError("adoption journal approved kept input is not canonical")
        if not isinstance(row["content_hash"], str) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", row["content_hash"]
        ):
            raise ScaffoldError("adoption journal approved kept hash is malformed")
        seen_kept.add(rel)

    raw_actions = payload.get("actions")
    if not isinstance(raw_actions, list) or not raw_actions:
        raise ScaffoldError("adoption journal has no recoverable actions")
    if len(raw_actions) != len(expected_actions):
        raise ScaffoldError("adoption journal actions do not match the approved plan")
    if payload.get("phase") not in {"planned", "applying"}:
        raise ScaffoldError("adoption journal progress is malformed")
    completed = payload.get("completed")
    if not isinstance(completed, int) or not 0 <= completed <= len(raw_actions):
        raise ScaffoldError("adoption journal progress exceeds the action count")

    action_keys = {
        "path",
        "kind",
        "existed",
        "before",
        "before_hash",
        "after_hash",
        "transient_after_hash",
    }
    actions: list[dict] = []
    backups: dict[Path, bytes | None] = {}
    seen_actions: set[str] = set()
    for row in raw_actions:
        if not isinstance(row, dict) or set(row) != action_keys:
            raise ScaffoldError("adoption journal action is malformed")
        rel = row["path"]
        expected = expected_actions.get(rel)
        if expected is None or rel in seen_actions or row["kind"] != expected["kind"]:
            raise ScaffoldError("adoption journal action is outside the approved plan")
        path = target / Path(rel)
        _ensure_within_target(target, [path])
        before_text = row["before"]
        try:
            before = (
                base64.b64decode(before_text, validate=True)
                if before_text is not None
                else None
            )
        except (ValueError, TypeError) as exc:
            raise ScaffoldError("adoption journal backup is malformed") from exc
        if not isinstance(row["existed"], bool) or row["existed"] != (before is not None):
            raise ScaffoldError("adoption journal backup presence is malformed")
        before_hash = _sha256_prefixed(before) if before is not None else None
        if row["before_hash"] != before_hash or expected["before_hash"] != before_hash:
            raise ScaffoldError("adoption journal backup hash does not match approval")

        if expected["kind"] == "patch":
            inserted = _append_patch_text(before or b"", patch_blocks[rel])
            if expected["inserted_text"] != inserted:
                raise ScaffoldError("adoption journal patch text does not match approval")
            after_bytes = (before or b"") + inserted.encode("utf-8")
            expected_after_hash = _sha256_prefixed(after_bytes)
        else:
            after_bytes = expected_bytes[rel]
            expected_after_hash = expected["after_hash"]
        if row["after_hash"] != expected_after_hash:
            raise ScaffoldError("adoption journal destination hash does not match approval")

        transient_hash = row["transient_after_hash"]
        if rel == ".gitignore":
            transient = _prejournal_privacy_bytes(
                {"after": after_bytes},
                before,
                recover_hash,
            )
            if transient_hash != _sha256_prefixed(transient):
                raise ScaffoldError("adoption journal privacy transition is not canonical")
        elif transient_hash is not None:
            raise ScaffoldError("adoption journal has an unexpected transient destination")
        actions.append(
            {
                "kind": row["kind"],
                "path": path,
                "after_hash": row["after_hash"],
                "transient_after_hash": transient_hash,
            }
        )
        backups[path] = before
        seen_actions.add(rel)
    return actions, backups


def _adopt_recovery_plan(
    target: Path,
    transaction_hash: str,
    actions: list[dict],
    backups: dict[Path, bytes | None],
) -> tuple[str, list[dict]]:
    rows: list[dict] = []
    for action in actions:
        path = action["path"]
        _ensure_safe_destinations(target, [path], force=True)
        before = backups[path]
        if not path.exists():
            if before is not None:
                raise ScaffoldError(
                    f"recovery destination is missing: {path.relative_to(target).as_posix()}"
                )
            current_hash = None
            operation = "no-op"
        else:
            if _is_symlink_or_junction(path) or not path.is_file():
                raise ScaffoldError(
                    f"recovery destination is unsafe: {path.relative_to(target).as_posix()}"
                )
            current = path.read_bytes()
            current_hash = _sha256_prefixed(current)
            if before is not None and current == before:
                operation = "no-op"
            elif current_hash not in _adopt_action_after_hashes(action):
                raise ScaffoldError(
                    f"recovery destination changed: {path.relative_to(target).as_posix()}"
                )
            else:
                operation = "restore" if before is not None else "delete-created"
        rows.append(
            {
                "path": path.relative_to(target).as_posix(),
                "operation": operation,
                "current_hash": current_hash,
                "restore_hash": _sha256_prefixed(before) if before is not None else None,
            }
        )
    recovery_payload = {
        "schema": _ADOPT_RECOVERY_PLAN_SCHEMA,
        "target": _thin_target_identity(target),
        "transaction_plan_hash": transaction_hash,
        "actions": rows,
    }
    return _thin_approval_hash(recovery_payload), rows


def _recovery_result(
    target: Path,
    transaction_hash: str,
    recovery_plan_hash: str,
    recovery_actions: list[dict],
    *,
    recovered: bool,
) -> dict:
    return {
        "contract": THIN_WORKSPACE_CONTRACT,
        "target": target,
        "preset": _workspace_declared_preset(target),
        "preset_reason": "approved interrupted-transaction recovery",
        "inventory": BrownfieldInventory(target),
        "creates": [],
        "patches": [],
        "optional_projections": [],
        "adapter_replacements": [],
        "kept": [],
        "conflicts": [],
        "privacy": None,
        "plan_hash": transaction_hash,
        "recovery_plan_hash": recovery_plan_hash,
        "recovery_actions": recovery_actions,
        "would_create": [],
        "followups": [],
        "gitignore_followups": [],
        "excluded_pre_existing": [],
        "skipped_module_collisions": [],
        "writes": [],
        "copies": [],
        "applied": False,
        "recovered": recovered,
        "doctor": None,
    }


def _recover_adopt(
    target: Path,
    recover_hash: str,
    *,
    yes: bool,
    approved_recovery_hash: str | None,
    repo_root: str | Path | None,
) -> dict:
    journal_path = target / _ADOPT_JOURNAL_REL
    if not journal_path.exists():
        prejournal = _prejournal_recovery_state(target, recover_hash)
        if prejournal is None:
            raise ScaffoldError("no safe adoption journal exists to recover")
        actions, backups = prejournal
    else:
        if _is_symlink_or_junction(journal_path) or not journal_path.is_file():
            raise ScaffoldError("no safe adoption journal exists to recover")
        if journal_path.stat().st_size > 1024 * 1024:
            raise ScaffoldError("adoption journal exceeds the recovery size limit")
        try:
            payload = json.loads(journal_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ScaffoldError(f"adoption journal is unreadable: {exc}") from exc
        actions, backups = _validated_journal_state(target, payload, recover_hash)

    recovery_plan_hash, recovery_actions = _adopt_recovery_plan(
        target,
        recover_hash,
        actions,
        backups,
    )
    if not yes:
        return _recovery_result(
            target,
            recover_hash,
            recovery_plan_hash,
            recovery_actions,
            recovered=False,
        )
    if approved_recovery_hash is None:
        raise ScaffoldError(
            "recovery apply requires --plan <hash> from the recovery dry-run"
        )
    if approved_recovery_hash != recovery_plan_hash:
        raise ScaffoldError(
            "recovery plan hash mismatch: "
            f"approved {approved_recovery_hash}, current {recovery_plan_hash}"
        )
    _rollback_adopt(target, actions, backups)
    return _recovery_result(
        target,
        recover_hash,
        recovery_plan_hash,
        recovery_actions,
        recovered=True,
    )


def adopt_workspace(
    target: str | Path,
    *,
    preset: str | None = None,
    adapters: tuple[str, ...] | list[str] = (),
    repo_root: str | Path | None = None,
    yes: bool = False,
    plan_hash: str | None = None,
    recover_hash: str | None = None,
    _fault_after: int | None = None,
    _crash_after: int | None = None,
    _crash_before_journal: bool = False,
    _before_apply: Callable[[], None] | None = None,
) -> dict:
    """Adopt Vivary onto an existing tree.

    Analyze + plan always run read-only. When `yes` is False (the default), no
    file is written — the plan is returned for the caller to render as a dry run.
    When `yes` is True, only files that do not already exist are written, using
    the same symlink/out-of-root hardened write path as `init`. Existing files are
    never opened for writing, moved, renamed, or truncated.
    """
    resolved_target = _resolve_scaffold_target(target)
    if recover_hash is not None:
        return _recover_adopt(
            resolved_target,
            recover_hash,
            yes=yes,
            approved_recovery_hash=plan_hash,
            repo_root=repo_root,
        )

    plan = plan_adopt(resolved_target, preset=preset, adapters=adapters, repo_root=repo_root)
    target_path = plan["target"]

    if not yes:
        return {**plan, "applied": False, "doctor": None}
    if plan_hash is None:
        raise ScaffoldError("apply requires --plan <hash> from the approved dry-run")
    if plan_hash != plan["plan_hash"]:
        raise ScaffoldError(
            f"plan hash mismatch: approved {plan_hash}, current {plan['plan_hash']}"
        )
    if plan["conflicts"]:
        paths = ", ".join(
            conflict["path"].relative_to(target_path).as_posix()
            for conflict in plan["conflicts"]
        )
        raise ScaffoldError(f"adoption plan has conflicts: {paths}")

    journal_path = target_path / _ADOPT_JOURNAL_REL
    if journal_path.exists() or _is_symlink_or_junction(journal_path):
        raise ScaffoldError(
            "unfinished adoption journal exists; recover it before applying a new plan"
        )

    if _before_apply is not None:
        _before_apply()
    verified_plan = plan_adopt(
        resolved_target,
        preset=preset,
        adapters=adapters,
        repo_root=repo_root,
    )
    if verified_plan["plan_hash"] != plan_hash:
        raise ScaffoldError(
            "approved plan input changed before writes: "
            f"approved {plan_hash}, current {verified_plan['plan_hash']}"
        )
    if verified_plan["conflicts"]:
        raise ScaffoldError("approved plan became conflicted before writes")
    plan = verified_plan
    target_path = plan["target"]
    if journal_path.exists() or _is_symlink_or_junction(journal_path):
        raise ScaffoldError(
            "unfinished adoption journal exists; recover it before applying a new plan"
        )

    create_paths = [dst for dst, _ in plan["writes"]]
    patch_paths = [patch["path"] for patch in plan["patches"]]
    replacement_paths = [item["path"] for item in plan.get("adapter_replacements", [])]
    _ensure_safe_destinations(target_path, create_paths, force=False)
    _ensure_safe_destinations(target_path, patch_paths, force=True)
    _ensure_safe_destinations(target_path, replacement_paths, force=True)

    gitignore_path = target_path / ".gitignore"
    privacy_is_planned = gitignore_path in create_paths or gitignore_path in patch_paths
    simulated_rules = (
        tuple(
            ("", parsed[0], parsed[1])
            for line in _thin_gitignore_block().splitlines()
            if (parsed := _parse_gitignore_line(line)) is not None
        )
        if privacy_is_planned
        else ()
    )
    missing_after_plan = [
        pattern
        for pattern, probes in _THIN_PRIVACY_PROBES.items()
        if not all(
            _probe_is_ignored(target_path, probe, extra_root_rules=simulated_rules)
            for probe in probes
        )
    ]
    if missing_after_plan:
        raise ScaffoldError(
            "privacy preflight failed before writes: " + ", ".join(missing_after_plan)
        )

    _assert_adopt_kept_inputs(target_path, plan)
    actions = _adopt_actions(plan)
    backups = _adopt_backups(actions)
    completed = 0
    privacy_is_action = bool(actions and actions[0]["path"] == target_path / ".gitignore")
    if privacy_is_action:
        actions[0]["transient_after"] = _prejournal_privacy_bytes(
            actions[0],
            backups[actions[0]["path"]],
            plan["plan_hash"],
        )
    journal = _adopt_journal_payload(
        plan,
        actions,
        backups,
        phase="planned",
        completed=0,
    )

    try:
        action_offset = 0
        if privacy_is_action:
            privacy_action = actions[0]
            _apply_adopt_action(
                target_path,
                privacy_action,
                after=privacy_action["transient_after"],
            )
            if _crash_before_journal:
                raise KeyboardInterrupt("injected crash after privacy before journal")
            _write_adopt_journal(target_path, journal)
            current_privacy = privacy_action["path"].read_bytes()
            if _sha256_prefixed(current_privacy) != _sha256_prefixed(
                privacy_action["transient_after"]
            ):
                raise ScaffoldError("pre-journal privacy replacement changed unexpectedly")
            _write_bytes_no_follow(
                target_path,
                privacy_action["path"],
                privacy_action["after"],
            )
            completed = 1
            journal["phase"] = "applying"
            journal["completed"] = completed
            _write_adopt_journal(target_path, journal)
            if _crash_after is not None and completed == _crash_after:
                raise KeyboardInterrupt(f"injected crash after replacement {completed}")
            if _fault_after is not None and completed == _fault_after:
                raise ScaffoldError(f"injected failure after replacement {completed}")
            action_offset = 1
        else:
            _write_adopt_journal(target_path, journal)
        for action in actions[action_offset:]:
            _apply_adopt_action(target_path, action)
            completed += 1
            journal["phase"] = "applying"
            journal["completed"] = completed
            _write_adopt_journal(target_path, journal)
            if _crash_after is not None and completed == _crash_after:
                raise KeyboardInterrupt(f"injected crash after replacement {completed}")
            if _fault_after is not None and completed == _fault_after:
                raise ScaffoldError(f"injected failure after replacement {completed}")

        doctor = doctor_workspace(
            target_path,
            repo_root=repo_root,
            _allow_adopt_journal=True,
        )
        if not doctor["ok"]:
            raise ScaffoldError(
                "Doctor failed after apply: " + "; ".join(doctor["errors"])
            )
        _unlink_no_follow(target_path, journal_path)
        return {**plan, "applied": True, "doctor": doctor}
    except Exception as exc:
        try:
            _rollback_adopt(target_path, actions, backups)
        except ScaffoldError as rollback_exc:
            raise ScaffoldError(f"{exc}; {rollback_exc}") from exc
        if isinstance(exc, ScaffoldError):
            raise
        raise ScaffoldError(f"adoption failed and rolled back: {exc}") from exc


def _record_destination(target: Path, record: str) -> tuple[Path, str]:
    if (
        not isinstance(record, str)
        or "\\" in record
        or record.startswith("/")
        or re.match(r"^[A-Za-z]:", record)
    ):
        raise ScaffoldError(
            "record path must be <modules|changes|decisions|verification|gates>/<slug>.md"
        )
    parts = record.split("/")
    if (
        len(parts) != 2
        or parts[0] not in _THIN_RECORD_FOLDERS
        or not _THIN_RECORD_NAME_RE.fullmatch(parts[1])
    ):
        raise ScaffoldError(
            "record path must be <modules|changes|decisions|verification|gates>/<slug>.md"
        )
    relative = f".vivary/records/{record}"
    return target / Path(relative), relative


def _read_record_source(source: str | Path) -> tuple[Path, bytes, str]:
    requested = Path(source)
    path = requested if requested.is_absolute() else Path.cwd() / requested
    path = Path(os.path.abspath(path))
    if _is_symlink_or_junction(path) or not path.is_file():
        raise ScaffoldError("record source must be a regular non-symlink file")
    try:
        before = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        raise ScaffoldError("record source could not be inspected") from exc
    if not stat.S_ISREG(before.st_mode) or before.st_size > _THIN_RECORD_MAX_BYTES:
        raise ScaffoldError(
            f"record source must be a regular UTF-8 file no larger than {_THIN_RECORD_MAX_BYTES} bytes"
        )
    descriptor = None
    try:
        flags = (
            os.O_RDONLY
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_size > _THIN_RECORD_MAX_BYTES
            or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
        ):
            raise ScaffoldError("record source changed or became unsafe while opening")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            data = handle.read(_THIN_RECORD_MAX_BYTES + 1)
    except OSError as exc:
        raise ScaffoldError("record source could not be read safely") from exc
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if len(data) > _THIN_RECORD_MAX_BYTES:
        raise ScaffoldError(
            f"record source must be no larger than {_THIN_RECORD_MAX_BYTES} bytes"
        )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ScaffoldError("record source must be UTF-8") from exc
    if not text.strip() or "\x00" in text:
        raise ScaffoldError("record source must contain nonempty UTF-8 Markdown")
    return path, data, text


def _record_capsule_binding(
    target: Path,
    capsule_source: str | Path,
) -> dict[str, str]:
    """Verify one complete governed/public capsule and bind current workspace state."""

    try:
        _path, _data, text = _read_record_source(capsule_source)
    except ScaffoldError as exc:
        message = str(exc).replace("record source", "record capsule")
        raise ScaffoldError(message.replace("UTF-8 Markdown", "UTF-8 JSON")) from exc

    def closed_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = value
        return result

    try:
        capsule = json.loads(text, object_pairs_hook=closed_object)
    except (json.JSONDecodeError, RecursionError, UnicodeError, ValueError) as exc:
        raise ScaffoldError("record capsule must be one bounded JSON object") from exc

    try:
        from vivary_core import (
            normalize_path,
            observe_checkouts,
            project_workspace_graph,
            verify_public_task_capsule_integrity,
            verify_task_capsule_integrity,
        )

        workspace = normalize_path(os.path.realpath(os.path.abspath(target)))
        schema = capsule.get("schema") if type(capsule) is dict else None
        public_capsule = schema == "vivary.public-task-capsule/v0"
        full_capsule = schema == "vivary.task-capsule/v0"
        if public_capsule:
            integrity_ok = verify_public_task_capsule_integrity(
                capsule,
                checkout_path=workspace,
            )
        elif full_capsule:
            integrity_ok = (
                verify_task_capsule_integrity(capsule)
                and capsule.get("task", {}).get("scope") == [workspace]
            )
        else:
            integrity_ok = False
        if not integrity_ok:
            raise ScaffoldError("record capsule integrity verification failed")
        observation = observe_checkouts([workspace], allowlist=[workspace])
        graph = project_workspace_graph(observation)
        current_fingerprint = graph.get("workspace_fingerprint")
    except ScaffoldError:
        raise
    except Exception as exc:
        raise ScaffoldError("record capsule workspace binding could not be verified") from exc

    capsule_workspace = capsule["workspace"]["fingerprint"]
    if (
        not isinstance(current_fingerprint, str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", current_fingerprint)
        or capsule_workspace != current_fingerprint
    ):
        raise ScaffoldError(
            "record capsule is stale or belongs to a different workspace state"
        )
    return {
        "id": capsule["capsule_id"],
        "fingerprint": capsule["fingerprint"],
        "workspace_fingerprint": capsule_workspace,
    }


def _read_record_destination(path: Path) -> bytes:
    """Read one existing record without following a swapped path identity."""
    if _is_symlink_or_junction(path):
        raise ScaffoldError("record destination must be a regular non-symlink file")
    descriptor = None
    try:
        before = os.stat(path, follow_symlinks=False)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > _THIN_RECORD_MAX_BYTES
        ):
            raise ScaffoldError(
                "record destination must be one regular single-link file no larger "
                f"than {_THIN_RECORD_MAX_BYTES} bytes"
            )
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
        opened = os.fstat(descriptor)
        identity = (opened.st_dev, opened.st_ino, opened.st_size)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_size > _THIN_RECORD_MAX_BYTES
            or (before.st_dev, before.st_ino, before.st_size) != identity
        ):
            raise ScaffoldError("record destination changed or became unsafe while opening")
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            data = handle.read(_THIN_RECORD_MAX_BYTES + 1)
        after = os.fstat(descriptor)
        if (
            (after.st_dev, after.st_ino, after.st_size) != identity
            or after.st_nlink != 1
            or len(data) > _THIN_RECORD_MAX_BYTES
        ):
            raise ScaffoldError("record destination changed while reading")
        return data
    except FileNotFoundError as exc:
        raise ScaffoldError("record destination changed before it could be read") from exc
    except ScaffoldError:
        raise
    except OSError as exc:
        raise ScaffoldError("record destination could not be read safely") from exc
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _validate_record_candidate(
    target: Path,
    destination: Path,
    relative: str,
    text: str,
    *,
    repo_root: Path,
) -> None:
    tropo = _load_tropo(repo_root)
    try:
        resolver = tropo.ConfigResolver(str(target), str(Path(tropo.__file__).parent))
        effective = resolver.for_dir(str(destination.parent))
        with tempfile.TemporaryDirectory(prefix="vivary-record-validate-") as raw:
            shadow = Path(raw) / destination.parent.name / destination.name
            shadow.parent.mkdir(parents=True)
            shadow.write_text(text, encoding="utf-8", newline="\n")
            doc = tropo.analyze_file(
                str(shadow),
                relative,
                effective,
                use_git_dates=False,
            )
    except (OSError, UnicodeError, ValueError, tropo.ConfigError) as exc:
        raise ScaffoldError("record source could not be validated against workspace policy") from exc
    expected_type = _THIN_RECORD_FOLDERS[destination.parent.name]
    findings = [finding.render() for finding in doc.findings]
    if doc.type != expected_type or findings:
        detail = "; ".join(findings[:5]) or (
            f"expected type {expected_type!r}, resolved {doc.type!r}"
        )
        raise ScaffoldError(f"record source is not a valid typed record: {detail}")


def plan_record(
    target: str | Path,
    record: str,
    *,
    source: str | Path,
    capsule: str | Path,
    repo_root: str | Path | None = None,
) -> dict:
    """Build a read-only exact plan for one record earned by real work."""
    root = Path(repo_root) if repo_root is not None else default_repo_root()
    root = root.resolve()
    target_path = _resolve_scaffold_target(target)
    if not target_path.is_dir():
        raise ScaffoldError("record target must be an existing thin Vivary workspace")
    doctor = doctor_workspace(target_path, repo_root=root)
    if (
        doctor.get("compatibility", {}).get("workspace_contract")
        != THIN_WORKSPACE_CONTRACT
    ):
        raise ScaffoldError("record target must use the thin-v0.3 workspace contract")
    if not doctor["ok"]:
        raise ScaffoldError(
            "record target must be healthy before planning a write: "
            + "; ".join(doctor["errors"])
        )

    destination, relative = _record_destination(target_path, record)
    capsule_binding = _record_capsule_binding(target_path, capsule)
    source_path, after, text = _read_record_source(source)
    try:
        if source_path.samefile(destination):
            raise ScaffoldError("record source and destination must be different files")
    except FileNotFoundError:
        pass

    _ensure_safe_destinations(target_path, [destination], force=True)
    if destination.exists():
        before = _read_record_destination(destination)
        action = "update"
        if before == after:
            raise ScaffoldError("record already matches the proposed content; no write is needed")
    else:
        before = None
        action = "create"

    _validate_record_candidate(
        target_path,
        destination,
        relative,
        text,
        repo_root=root,
    )
    before_hash = _sha256_prefixed(before) if before is not None else None
    after_hash = _sha256_prefixed(after)
    plan_payload = {
        "contract": THIN_WORKSPACE_CONTRACT,
        "action": action,
        "path": relative,
        "before_hash": before_hash,
        "after_hash": after_hash,
        "capsule": capsule_binding,
    }
    encoded = json.dumps(plan_payload, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return {
        **plan_payload,
        "target": target_path,
        "source": source_path,
        "plan_hash": _sha256_prefixed(encoded),
    }


def _remove_empty_record_dirs(target: Path, destination: Path) -> None:
    records_root = target / ".vivary" / "records"
    for path in (destination.parent, records_root):
        try:
            path.rmdir()
        except OSError:
            pass


def record_workspace(
    target: str | Path,
    record: str,
    *,
    source: str | Path,
    capsule: str | Path,
    repo_root: str | Path | None = None,
    yes: bool = False,
    plan_hash: str | None = None,
    _before_apply: Callable[[], None] | None = None,
) -> dict:
    """Create or update one typed record after exact capsule-bound approval."""
    plan = plan_record(
        target,
        record,
        source=source,
        capsule=capsule,
        repo_root=repo_root,
    )
    if not yes:
        return {**plan, "applied": False, "doctor": None}
    if plan_hash is None:
        raise ScaffoldError("record apply requires --plan <hash> from the approved dry-run")
    if plan_hash != plan["plan_hash"]:
        raise ScaffoldError(
            f"record plan hash mismatch: approved {plan_hash}, current {plan['plan_hash']}"
        )

    if _before_apply is not None:
        _before_apply()
    verified = plan_record(
        target,
        record,
        source=source,
        capsule=capsule,
        repo_root=repo_root,
    )
    if verified["plan_hash"] != plan_hash:
        raise ScaffoldError(
            "approved plan input changed before writes: "
            f"approved {plan_hash}, current {verified['plan_hash']}"
        )

    target_path = verified["target"]
    destination = target_path / Path(verified["path"])
    _source_path, after, _text = _read_record_source(source)
    if _sha256_prefixed(after) != verified["after_hash"]:
        raise ScaffoldError("approved record source changed before writes")
    before = _read_record_destination(destination) if destination.exists() else None
    current_hash = _sha256_prefixed(before) if before is not None else None
    if current_hash != verified["before_hash"]:
        raise ScaffoldError("approved record destination changed before writes")

    action = {
        "kind": "replace" if before is not None else "create",
        "path": destination,
        "before_hash": current_hash,
        "after": after,
    }
    backups = {destination: before}
    try:
        _write_bytes_no_follow(target_path, destination, after)
        doctor = doctor_workspace(target_path, repo_root=repo_root)
        if not doctor["ok"]:
            raise ScaffoldError(
                "Doctor failed after record apply: " + "; ".join(doctor["errors"])
            )
    except Exception as exc:
        try:
            _rollback_adopt(
                target_path,
                [action],
                backups,
                cleanup_journal=False,
            )
            _remove_empty_record_dirs(target_path, destination)
        except ScaffoldError as rollback_exc:
            raise ScaffoldError(f"{exc}; {rollback_exc}") from exc
        if isinstance(exc, ScaffoldError):
            raise
        raise ScaffoldError(f"record apply failed and rolled back: {exc}") from exc
    return {**verified, "applied": True, "doctor": doctor}


def _record_report_to_json(result: dict) -> dict:
    payload = {
        key: value
        for key, value in result.items()
        if key not in {"target", "source", "doctor"}
    }
    doctor = result.get("doctor")
    payload["ok"] = bool(doctor.get("ok", True)) if isinstance(doctor, dict) else True
    payload["root"] = str(result["target"])
    payload["source"] = str(result["source"])
    if result.get("doctor") is not None:
        payload["doctor"] = result["doctor"]
    return payload


def _print_record_report(result: dict) -> None:
    verb = "applied" if result["applied"] else "would apply"
    print(f"create-vivary record: {verb} one {result['action']} to {result['path']}")
    print(f"capsule: {result['capsule']['id']} ({result['capsule']['fingerprint']})")
    print(f"source: {result['source']}")
    print(f"before: {result['before_hash'] or 'absent'}")
    print(f"after: {result['after_hash']}")
    print(f"plan_hash: {result['plan_hash']}")


def _adopt_report_to_json(result: dict, *, mode: str) -> dict:
    inventory: BrownfieldInventory = result["inventory"]
    ok = not result.get("conflicts")
    if mode in ("applied", "recovered") and result.get("doctor") is not None:
        ok = bool(result["doctor"].get("ok"))
    payload = {
        "ok": ok,
        "mode": mode,
        "recovered": bool(result.get("recovered")),
        "contract": result.get("contract", THIN_WORKSPACE_CONTRACT),
        "root": str(result["target"]),
        "preset": result["preset"],
        "preset_reason": result["preset_reason"],
        "creates": [p.relative_to(result["target"]).as_posix() for p in result.get("creates", [])],
        "patches": [
            {
                **patch,
                "path": patch["path"].relative_to(result["target"]).as_posix(),
            }
            for patch in result.get("patches", [])
        ],
        "optional_projections": [
            {
                **projection,
                "path": projection["path"].relative_to(result["target"]).as_posix(),
            }
            for projection in result.get("optional_projections", [])
        ],
        "would_create": [p.relative_to(result["target"]).as_posix() for p in result["would_create"]],
        "kept": [p.relative_to(result["target"]).as_posix() for p in result["kept"]],
        "conflicts": [
            {
                **conflict,
                "path": conflict["path"].relative_to(result["target"]).as_posix(),
            }
            for conflict in result.get("conflicts", [])
        ],
        "privacy": result.get("privacy"),
        "plan_hash": result.get("plan_hash"),
        "recovery_plan_hash": result.get("recovery_plan_hash"),
        "recovery_actions": result.get("recovery_actions", []),
        "followups": result["followups"],
        "candidate_modules": inventory.candidate_modules,
        "excluded_pre_existing": result["excluded_pre_existing"],
        "skipped_module_collisions": result["skipped_module_collisions"],
    }
    if mode in ("applied", "recovered") and result.get("doctor") is not None:
        payload["doctor"] = result["doctor"]
    return payload


def _print_adopt_report(result: dict, *, mode: str) -> None:
    target = result["target"]
    verb = "Adopted" if mode == "applied" else "Would adopt"
    print(f"create-vivary adopt: {verb} Vivary onto {target}")
    print(f"preset: {result['preset']} ({result['preset_reason']})")

    for dst in result["would_create"]:
        rel = dst.relative_to(target).as_posix()
        verb2 = "created" if mode == "applied" else "would create"
        print(f"  {verb2}: {rel}")
    for dst in result["kept"]:
        rel = dst.relative_to(target).as_posix()
        print(f"  exists, kept: {rel}")

    if result["gitignore_followups"]:
        print("\nManual follow-up: your .gitignore exists and was left untouched.")
        print("Add these privacy lines yourself:")
        for line in result["gitignore_followups"]:
            for sub in line.splitlines():
                print(f"  {sub}")

    if result["excluded_pre_existing"]:
        print(
            "\nManual follow-up: pre-existing content under Vivary-managed graph "
            "folders was excluded from the typed graph (tropo.toml):"
        )
        for rel in result["excluded_pre_existing"]:
            print(f"  excluded from graph: {rel}")
        print(
            "Add frontmatter and remove a file's exclude entry in tropo.toml to "
            "bring it into the graph."
        )

    if result["skipped_module_collisions"]:
        print("\nSkipped module router(s) — Vivary already uses this module name:")
        for rel_dir in result["skipped_module_collisions"]:
            print(f"  {rel_dir}/ (no router created; directory left untouched)")

    if mode == "applied":
        doctor = result["doctor"]
        status = "ok" if doctor["ok"] else "failed"
        graph = doctor["graph"]
        print(
            f"\ndoctor: {status} "
            f"({graph['nodes']} node(s), {graph['edges']} edge(s), {graph['broken']} broken)"
        )
        for error in doctor["errors"]:
            print(f"  error: {error}")
        for warning in doctor["warnings"]:
            print(f"  warning: {warning}")


_CAPABILITY_ROOT_LIMIT = 8
_CAPABILITY_SYS_PATH_ENTRY_LIMIT = 256
_CAPABILITY_ROOT_ENTRY_LIMIT = 10_000
_CAPABILITY_METADATA_BYTE_LIMIT = 256 * 1024
_CAPABILITY_RECORD_BYTE_LIMIT = 2 * 1024 * 1024
_CAPABILITY_REQUIREMENT_LIMIT = 256
_CAPABILITY_RECORD_ROW_LIMIT = 20_000
_CAPABILITY_REQUIREMENT_TEXT_LIMIT = 4 * 1024
_CAPABILITY_EXTRA_LIMIT = 64
_CAPABILITY_EXTRA_NODE_LIMIT = 8
_CAPABILITY_EXTRA_EDGE_LIMIT = 16
_CAPABILITY_EXTRA_DEPTH_LIMIT = 4
_CAPABILITY_CHILD_EXTRA_LIMIT = 4
_CAPABILITY_SPECIFIER_TEXT_LIMIT = 256
_CAPABILITY_SPECIFIER_CLAUSE_LIMIT = 4
_CAPABILITY_VERSION_TEXT_LIMIT = 128
_CAPABILITY_VERSION_COMPONENT_LIMIT = 8

_STABLE_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
_SUPPORTED_PROVIDER_VERSION_RE = re.compile(
    r"""
    ^v?
    (?:(?P<epoch>\d+)!)?
    (?P<release>\d+(?:\.\d+)*)
    (?P<pre>[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?\d*)?
    (?P<post>-(?:\d+)|[-_.]?(?:post|rev|r)[-_.]?\d*)?
    (?P<dev>[-_.]?dev[-_.]?\d*)?
    (?:\+(?P<local>[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*))?
    $
    """,
    re.IGNORECASE | re.VERBOSE,
)
_REQUIREMENT_NAME_RE = re.compile(
    r"^\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$|[\[<>=!~;@])"
)
_EXTRA_INSTALL_HINT_RE = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)"
    r"\[(?P<extra>[A-Za-z0-9][A-Za-z0-9._-]*)\]$"
)
_OPTIONAL_REQUIREMENT_FLOOR_RE = re.compile(
    r"""^\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*>=\s*"""
    r"""(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)\s*;\s*"""
    r"""extra\s*==\s*(?P<quote>['"])(?P<extra>[A-Za-z0-9][A-Za-z0-9._-]*)"""
    r"""(?P=quote)\s*$"""
)
_EXACT_EXTRA_MARKER_RE = re.compile(
    r";\s*extra\s*==\s*(?P<quote>['\"])"
    r"(?P<extra>[A-Za-z0-9][A-Za-z0-9._-]*)(?P=quote)\s*$",
    re.IGNORECASE,
)
_FORWARD_EXTRA_MARKER_COMPARISON_RE = re.compile(
    r"""extra\s*(?P<operator>==|!=)\s*(?P<quote>['"])"""
    r"""(?P<extra>[A-Za-z0-9][A-Za-z0-9._-]*)(?P=quote)""",
    re.IGNORECASE,
)
_REVERSED_EXTRA_MARKER_COMPARISON_RE = re.compile(
    r"""(?P<quote>['"])(?P<extra>[A-Za-z0-9][A-Za-z0-9._-]*)"""
    r"""(?P=quote)\s*(?P<operator>==|!=)\s*extra$""",
    re.IGNORECASE,
)
_NUMERIC_VERSION_RE = re.compile(r"^\d+(?:\.\d+)*$")
_SPECIFIER_CLAUSE_RE = re.compile(
    r"^(?P<operator>~=|==|!=|<=|>=|<|>)\s*"
    r"(?P<version>\d+(?:\.\d+)*(?:\.\*)?)$"
)
_SELECTED_EXTRA_REQUIREMENT_RE = re.compile(
    r"^\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)"
    r"(?:\[(?P<extras>[A-Za-z0-9][A-Za-z0-9._-]*"
    r"(?:\s*,\s*[A-Za-z0-9][A-Za-z0-9._-]*)*)\])?"
    r"\s*(?P<specifiers>[^;]*?)\s*;\s*"
    r"extra\s*==\s*(?P<quote>['\"])"
    r"(?P<extra>[A-Za-z0-9][A-Za-z0-9._-]*)(?P=quote)\s*$",
    re.IGNORECASE,
)
_EXTRA_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")



# This fixed inventory is the one owner for every public capability row and passive
# probe fact. Dependency floors and console targets remain package-manifest facts:
# the probe accepts only supported declared floors and records its public script name.
_CAPABILITY_DECLARATIONS = {
    "storage:file": {
        "label": "File-backed typed graph",
        "default": True,
        "requires_approval": False,
        "network": False,
        "requirements": (),
    },
    "storage:embedded": {
        "label": "Local embedded storage",
        "default": False,
        "requires_approval": True,
        "network": False,
        "requirements": (
            {
                "hint": "vivary-tropo[embedded]",
                "distribution": "lancedb",
                "module": "lancedb",
            },
        ),
    },
    "memory:none": {
        "label": "No semantic memory",
        "default": True,
        "requires_approval": False,
        "network": False,
        "requirements": (),
    },
    "memory:local": {
        "label": "Local semantic memory policy",
        "default": False,
        "requires_approval": True,
        "requires_explicit_index": True,
        "network": False,
        "requirements": (),
    },
    "memory:cognee": {
        "label": "Cognee semantic memory",
        "default": False,
        "requires_approval": True,
        "requires_explicit_index": True,
        "network": "configurable, default false",
        "adapter_status": "optional-package",
        "requirements": (
            {
                "hint": "vivary-memory-cognee",
                "distribution": "vivary-memory-cognee",
                "module": "vivary_cognee",
                "vivary": True,
            },
        ),
    },
    "active-context:cocoindex-code": {
        "label": "CocoIndex-code active context",
        "default": False,
        "requires_approval": True,
        "requires_explicit_index": True,
        "network": "provider-dependent, default local guidance",
        "presets": ("coding",),
        "requirements": (
            {
                "hint": "cocoindex-code[full]",
                "distribution": "cocoindex-code",
                "module": "cocoindex_code",
            },
        ),
    },
    "interop:mcp": {
        "label": "Read-only MCP interoperability",
        "default": False,
        "requires_approval": False,
        "network": False,
        "authority": "read-only-context",
        "governed_role": "vivary-mcp",
        "protocol_revision": "2026-07-28",
        "transport_stdio": True,
        "tool_names": (
            "vivary_find",
            "vivary_query",
            "vivary_check",
            "vivary_capsule",
        ),
        "extensions": (),
        "conformance_status": "unproven",
        "requirements": (
            {
                "hint": "vivary-mcp",
                "distribution": "vivary-mcp",
                "module": "vivary_mcp",
                "script": "vivary-mcp",
                "callable": "main",
                "vivary": True,
            },
            {
                "hint": "vivary-tropo",
                "distribution": "vivary-tropo",
                "module": "tropo",
                "script": "tropo",
                "callable": "main",
                "vivary": True,
            },
            {
                "hint": "mcp",
                "distribution": "mcp",
                "module": "mcp",
                "versioned": True,
            },
        ),
    },
    "governed-context:core": {
        "label": "Governed contracts (vivary-core)",
        "default": False,
        "requires_approval": False,
        "network": False,
        "command": None,
        "authority": "library-only",
        "requirements": (
            {
                "hint": "vivary-core",
                "distribution": "vivary-core",
                "module": "vivary_core",
                "vivary": True,
            },
        ),
    },
    "governed-context:tropo": {
        "label": "Governed context compilation (Tropo)",
        "default": False,
        "requires_approval": False,
        "network": False,
        "command": "tropo find --governed",
        "authority": "read-only-context",
        "governed_role": "vivary-tropo",
        "requirements": (
            {
                "hint": "vivary-tropo",
                "distribution": "vivary-tropo",
                "module": "tropo",
                "script": "tropo",
                "callable": "main",
                "vivary": True,
            },
            {
                "hint": "vivary-core",
                "distribution": "vivary-core",
                "module": "vivary_core",
                "vivary": True,
            },
        ),
    },
    "governed-policy:strato": {
        "label": "Governed policy decisions (Strato)",
        "default": False,
        "requires_approval": False,
        "network": False,
        "command": "strato decide --governed",
        "authority": "decision-only",
        "governed_role": "vivary-strato",
        "requirements": (
            {
                "hint": "vivary-strato",
                "distribution": "vivary-strato",
                "module": "strato",
                "script": "strato",
                "callable": "main",
                "vivary": True,
            },
            {
                "hint": "vivary-core",
                "distribution": "vivary-core",
                "module": "vivary_core",
                "vivary": True,
            },
        ),
    },
    "governed-verification:ozone": {
        "label": "Governed verification (Ozone)",
        "default": False,
        "requires_approval": False,
        "network": False,
        "command": "ozone verify --governed",
        "authority": "verification-and-proposal-only",
        "governed_role": "vivary-ozone",
        "requirements": (
            {
                "hint": "vivary-ozone",
                "distribution": "vivary-ozone",
                "module": "ozone",
                "script": "ozone",
                "callable": "main",
                "vivary": True,
            },
            {
                "hint": "vivary-tropo",
                "distribution": "vivary-tropo",
                "module": "tropo",
                "script": "tropo",
                "callable": "main",
                "vivary": True,
            },
            {
                "hint": "vivary-core",
                "distribution": "vivary-core",
                "module": "vivary_core",
                "vivary": True,
            },
        ),
    },
    "governed-control:exo": {
        "label": "Governed execution control (Exo)",
        "default": False,
        "requires_approval": False,
        "network": False,
        "command": "exo control --governed",
        "authority": "projection-only",
        "governed_role": "vivary-exo",
        "requirements": (
            {
                "hint": "vivary-exo",
                "distribution": "vivary-exo",
                "module": "exo",
                "script": "exo",
                "callable": "main",
                "vivary": True,
            },
            {
                "hint": "vivary-tropo",
                "distribution": "vivary-tropo",
                "module": "tropo",
                "script": "tropo",
                "callable": "main",
                "vivary": True,
            },
            {
                "hint": "vivary-core",
                "distribution": "vivary-core",
                "module": "vivary_core",
                "vivary": True,
            },
        ),
    },
}


class _CapabilityProbeFailure(Exception):
    pass


class _CapabilityContractIncompatible(Exception):
    pass


def _normalize_distribution_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _dist_info_identity(value: str) -> tuple[str, str] | None:
    suffix = ".dist-info"
    if not value.lower().endswith(suffix):
        return None
    stem = value[: -len(suffix)]
    name, separator, version = stem.rpartition("-")
    if not separator or not name or not version:
        return None
    return _normalize_distribution_name(name), version


def _capability_install_roots() -> tuple[Path, ...]:
    candidates: list[Path] = []
    try:
        paths = sysconfig.get_paths()
        for key in ("purelib", "platlib"):
            value = paths.get(key)
            if value:
                candidates.append(Path(value))

        system_sites = site.getsitepackages()
        if type(system_sites) not in (list, tuple):
            raise _CapabilityProbeFailure
        system_sites = tuple(system_sites[: _CAPABILITY_ROOT_LIMIT + 1])
        if len(system_sites) > _CAPABILITY_ROOT_LIMIT or not all(
            isinstance(value, str) and value for value in system_sites
        ):
            raise _CapabilityProbeFailure
        candidates.extend(Path(value) for value in system_sites)

        if site.ENABLE_USER_SITE:
            user_site = site.getusersitepackages()
            if type(user_site) is str:
                user_sites = (user_site,)
            elif type(user_site) in (list, tuple):
                user_sites = tuple(user_site[: _CAPABILITY_ROOT_LIMIT + 1])
            else:
                raise _CapabilityProbeFailure
            if (
                len(user_sites) > _CAPABILITY_ROOT_LIMIT
                or not all(isinstance(value, str) and value for value in user_sites)
            ):
                raise _CapabilityProbeFailure
            candidates.extend(Path(value) for value in user_sites)
    except _CapabilityProbeFailure:
        raise
    except Exception as exc:
        raise _CapabilityProbeFailure from exc

    canonical: dict[str, Path] = {}
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except (OSError, RuntimeError, ValueError) as exc:
            raise _CapabilityProbeFailure from exc
        canonical[os.path.normcase(str(resolved))] = resolved

    if type(sys.path) not in (list, tuple):
        raise _CapabilityProbeFailure
    active_paths = tuple(sys.path[: _CAPABILITY_SYS_PATH_ENTRY_LIMIT + 1])
    if len(active_paths) > _CAPABILITY_SYS_PATH_ENTRY_LIMIT:
        raise _CapabilityProbeFailure
    ordered: list[Path] = []
    for entry in active_paths:
        if not isinstance(entry, str) or not entry:
            continue
        try:
            key = os.path.normcase(str(Path(entry).resolve()))
        except (OSError, RuntimeError, ValueError):
            continue
        candidate = canonical.pop(key, None)
        if candidate is not None:
            if len(ordered) >= _CAPABILITY_ROOT_LIMIT:
                break
            ordered.append(candidate)
        if not canonical:
            break
    return tuple(ordered)


def _read_capability_file(path: Path, root: Path, limit: int) -> bytes:
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _CapabilityContractIncompatible from exc
    if not _path_within(root, resolved) or not resolved.is_file():
        raise _CapabilityContractIncompatible
    try:
        with resolved.open("rb") as handle:
            content = handle.read(limit + 1)
    except OSError as exc:
        raise _CapabilityProbeFailure from exc
    if len(content) > limit:
        raise _CapabilityProbeFailure
    return content


def _capability_distribution_index(
    roots: tuple[Path, ...],
) -> dict[str, list[tuple[int, Path, Path, str]]]:
    if len(roots) > _CAPABILITY_ROOT_LIMIT:
        raise _CapabilityProbeFailure
    index: dict[str, list[tuple[int, Path, Path, str]]] = {}
    entries_seen = 0
    for root_index, root in enumerate(roots):
        try:
            resolved_root = root.resolve(strict=True)
        except FileNotFoundError:
            continue
        except (OSError, RuntimeError, ValueError) as exc:
            raise _CapabilityProbeFailure from exc
        if not resolved_root.is_dir():
            raise _CapabilityProbeFailure
        try:
            with os.scandir(resolved_root) as entries:
                for entry in entries:
                    entries_seen += 1
                    if entries_seen > _CAPABILITY_ROOT_ENTRY_LIMIT:
                        raise _CapabilityProbeFailure
                    try:
                        is_dist_info_directory = entry.is_dir(follow_symlinks=False)
                        is_link = entry.is_symlink()
                        if not is_dist_info_directory and os.name == "nt":
                            attributes = entry.stat(
                                follow_symlinks=False
                            ).st_file_attributes
                            is_link = is_link or bool(
                                attributes
                                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
                            )
                    except OSError as exc:
                        raise _CapabilityProbeFailure from exc
                    if not is_dist_info_directory and not is_link:
                        continue
                    identity = _dist_info_identity(entry.name)
                    if identity is None:
                        continue
                    distribution_name, distribution_version = identity
                    index.setdefault(distribution_name, []).append(
                        (
                            root_index,
                            resolved_root,
                            Path(entry.path),
                            distribution_version,
                        )
                    )
        except _CapabilityProbeFailure:
            raise
        except (OSError, ValueError) as exc:
            raise _CapabilityProbeFailure from exc
    return index


def _selected_dist_info(
    index: dict[str, list[tuple[int, Path, Path, str]]], distribution: str
) -> tuple[int, Path, Path, str] | None:
    matches = index.get(_normalize_distribution_name(distribution), ())
    if not matches:
        return None
    first_root = min(match[0] for match in matches)
    selected = [match for match in matches if match[0] == first_root]
    if len(selected) != 1:
        raise _CapabilityContractIncompatible
    root_index, root, dist_info, distribution_version = selected[0]
    try:
        resolved = dist_info.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise _CapabilityContractIncompatible from exc
    lexical = os.path.normcase(os.path.abspath(dist_info))
    if (
        not _path_within(root, resolved)
        or lexical != os.path.normcase(str(resolved))
    ):
        raise _CapabilityContractIncompatible
    return root_index, root, resolved, distribution_version


def _module_artifact_candidates(module: str) -> tuple[Path, ...]:
    relative = Path(*module.split("."))
    return tuple(
        path
        for suffix in importlib.machinery.all_suffixes()
        for path in (
            relative.with_suffix(suffix),
            relative / f"__init__{suffix}",
        )
    )


def _has_earlier_module_artifact(
    roots: tuple[Path, ...],
    selected_root_index: int,
    module: str,
) -> bool:
    for root in roots[:selected_root_index]:
        for candidate in _module_artifact_candidates(module):
            try:
                os.lstat(root / candidate)
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise _CapabilityProbeFailure from exc
            return True
    return False


def _has_competing_module_artifact(
    root: Path,
    module: str,
    recorded_artifact: str,
) -> bool:
    for candidate in _module_artifact_candidates(module):
        try:
            os.lstat(root / candidate)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise _CapabilityProbeFailure from exc
        if candidate.as_posix() != recorded_artifact:
            return True
    return False

def _parse_capability_metadata(
    content: bytes,
) -> tuple[dict[str, str], tuple[str, ...], tuple[str, ...]]:
    try:
        message = BytesParser(_class=Message).parsebytes(content)
    except Exception as exc:
        raise _CapabilityProbeFailure from exc
    if message.defects:
        raise _CapabilityProbeFailure
    # The input byte ceiling bounds unrelated headers. Repeated fields consumed by
    # the probe have their own semantic limits below.
    fields: dict[str, str] = {}
    for field in ("Metadata-Version", "Name", "Version", "Requires-Python"):
        values = message.get_all(field) or ()
        if (
            len(values) != 1
            or not isinstance(values[0], str)
            or not values[0].strip()
        ):
            raise _CapabilityProbeFailure
        fields[field.lower().replace("-", "_")] = values[0]
    requirements = tuple(message.get_all("Requires-Dist") or ())
    if (
        len(requirements) > _CAPABILITY_REQUIREMENT_LIMIT
        or not all(
            isinstance(requirement, str)
            and len(requirement.encode("utf-8")) <= _CAPABILITY_REQUIREMENT_TEXT_LIMIT
            for requirement in requirements
        )
    ):
        raise _CapabilityProbeFailure
    provided_extras = tuple(message.get_all("Provides-Extra") or ())
    if len(provided_extras) > _CAPABILITY_EXTRA_LIMIT or not all(
        isinstance(extra, str) for extra in provided_extras
    ):
        raise _CapabilityProbeFailure
    return fields, requirements, provided_extras


def _parse_console_target(content: bytes, script: str) -> tuple[str, str]:
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.optionxform = str
    try:
        parser.read_string(content.decode("utf-8"))
        value = parser["console_scripts"][script]
    except (UnicodeDecodeError, configparser.Error, KeyError) as exc:
        raise _CapabilityContractIncompatible from exc
    target = value.split(":")
    if len(target) != 2:
        raise _CapabilityContractIncompatible
    module, callable_name = (part.strip() for part in target)
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", module) or not re.fullmatch(
        r"[A-Za-z_][A-Za-z0-9_.]*",
        callable_name,
    ):
        raise _CapabilityContractIncompatible
    return module, callable_name


def _record_rows(content: bytes):
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _CapabilityProbeFailure from exc
    if re.search(r"\r(?!\n)|[\v\f\x1c-\x1e\x85\u2028\u2029]", text):
        raise _CapabilityProbeFailure

    rows = 0
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    try:
        for row in reader:
            rows += 1
            if rows > _CAPABILITY_RECORD_ROW_LIMIT:
                raise _CapabilityProbeFailure
            if len(row) != 3:
                raise _CapabilityProbeFailure
            path, digest, size = row
            if (
                not path
                or path.startswith("/")
                or re.match(r"^[A-Za-z]:", path)
                or any(ord(character) < 32 or ord(character) == 127 for character in path)
                or digest
                and re.fullmatch(r"[A-Za-z0-9_]+=[A-Za-z0-9_-]+", digest)
                is None
                or size
                and (
                    len(size) > 20
                    or not size.isascii()
                    or not size.isdecimal()
                )
            ):
                raise _CapabilityProbeFailure
            yield path, digest, size
    except csv.Error as exc:
        raise _CapabilityProbeFailure from exc


def _recorded_module_path(
    content: bytes,
    module: str | None,
    *,
    owned_paths: tuple[str, ...] = (),
) -> str | None:
    candidates = (
        set()
        if module is None
        else {
            f"{module.replace('.', '/')}.py",
            f"{module.replace('.', '/')}/__init__.py",
        }
    )
    module_path: str | None = None
    found_owned_paths: set[str] = set()
    for path, _digest, _size in _record_rows(content):
        if path in candidates:
            if module_path is not None and module_path != path:
                raise _CapabilityContractIncompatible
            module_path = path
        if path in owned_paths:
            found_owned_paths.add(path)
    if (
        module is not None
        and module_path is None
        or found_owned_paths != set(owned_paths)
    ):
        raise _CapabilityContractIncompatible
    return module_path


def _capability_scripts_path(root: Path) -> Path:
    try:
        path_sets = [
            sysconfig.get_paths(),
            sysconfig.get_paths(
                scheme=sysconfig.get_preferred_scheme("user"),
            ),
        ]
        prefixes: list[str] = []
        for name in ("prefix", "exec_prefix", "base_prefix", "base_exec_prefix"):
            value = getattr(sys, name, None)
            if type(value) is not str or not value:
                raise _CapabilityProbeFailure
            if value not in prefixes:
                prefixes.append(value)
        path_sets.extend(
            sysconfig.get_paths(vars={"base": prefix, "platbase": prefix})
            for prefix in prefixes
        )
    except _CapabilityProbeFailure:
        raise
    except Exception as exc:
        raise _CapabilityProbeFailure from exc

    try:
        root_key = os.path.normcase(os.path.abspath(root))
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise _CapabilityProbeFailure from exc
    if os.name == "nt" and root_key.replace("/", "\\").startswith("\\\\"):
        raise _CapabilityContractIncompatible
    matches: dict[str, Path] = {}
    for paths in path_sets:
        if type(paths) is not dict:
            raise _CapabilityProbeFailure
        scripts_value = paths.get("scripts")
        if type(scripts_value) is not str or not scripts_value:
            raise _CapabilityProbeFailure
        for key in ("purelib", "platlib"):
            library_value = paths.get(key)
            if library_value is None:
                continue
            if type(library_value) is not str or not library_value:
                raise _CapabilityProbeFailure
            try:
                library_key = os.path.normcase(os.path.abspath(library_value))
            except (OSError, RuntimeError, TypeError, ValueError) as exc:
                raise _CapabilityProbeFailure from exc
            if library_key != root_key:
                continue
            if (
                os.name == "nt"
                and scripts_value.replace("/", "\\").startswith("\\\\")
            ):
                raise _CapabilityContractIncompatible
            try:
                scripts = Path(scripts_value).resolve(strict=True)
            except (OSError, RuntimeError, ValueError) as exc:
                raise _CapabilityProbeFailure from exc
            if not scripts.is_dir():
                raise _CapabilityProbeFailure
            matches[os.path.normcase(str(scripts))] = scripts
    if len(matches) != 1:
        raise _CapabilityContractIncompatible
    return next(iter(matches.values()))


def _require_recorded_launcher(
    record: bytes,
    root: Path,
    script: str,
) -> None:
    launcher_name = f"{script}.exe" if os.name == "nt" else script
    scripts = _capability_scripts_path(root)
    launcher_path = scripts / launcher_name
    try:
        launcher_stat = launcher_path.lstat()
        launcher = launcher_path.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _CapabilityContractIncompatible from exc
    if not stat.S_ISREG(launcher_stat.st_mode) or not os.access(launcher, os.X_OK):
        raise _CapabilityContractIncompatible
    try:
        expected_record_path = os.path.relpath(launcher_path, root).replace("\\", "/")
    except ValueError as exc:
        raise _CapabilityContractIncompatible from exc

    matches = 0
    for path, _digest, _size in _record_rows(record):
        if os.path.normcase(path) == os.path.normcase(expected_record_path):
            matches += 1
    if matches != 1:
        raise _CapabilityContractIncompatible


def _stable_version(value: str) -> tuple[int, int, int]:
    match = _STABLE_VERSION_RE.fullmatch(value)
    if match is None:
        raise _CapabilityContractIncompatible
    try:
        return tuple(int(part) for part in match.groups())
    except ValueError as exc:
        raise _CapabilityContractIncompatible from exc


def _provider_version_meets_floor(
    value: str,
    floor: tuple[int, int, int],
) -> bool:
    match = _SUPPORTED_PROVIDER_VERSION_RE.fullmatch(value)
    if match is None or match.group("pre") is not None or match.group("dev") is not None:
        raise _CapabilityContractIncompatible
    try:
        epoch = int(match.group("epoch") or "0")
        release = tuple(int(part) for part in match.group("release").split("."))
    except ValueError as exc:
        raise _CapabilityContractIncompatible from exc
    if epoch:
        return True
    width = max(len(release), len(floor))
    return release + (0,) * (width - len(release)) >= floor + (0,) * (
        width - len(floor)
    )


def _numeric_version(value: str) -> tuple[int, ...]:
    if (
        len(value) > _CAPABILITY_VERSION_TEXT_LIMIT
        or _NUMERIC_VERSION_RE.fullmatch(value) is None
    ):
        raise _CapabilityContractIncompatible
    parts = value.split(".")
    if len(parts) > _CAPABILITY_VERSION_COMPONENT_LIMIT:
        raise _CapabilityContractIncompatible
    try:
        return tuple(int(part) for part in parts)
    except ValueError as exc:
        raise _CapabilityContractIncompatible from exc


def _parse_version_specifier(
    value: str,
) -> tuple[tuple[str, tuple[int, ...], bool], ...]:
    if not value or len(value) > _CAPABILITY_SPECIFIER_TEXT_LIMIT:
        raise _CapabilityContractIncompatible
    parts = tuple(part.strip() for part in value.split(","))
    if (
        not parts
        or len(parts) > _CAPABILITY_SPECIFIER_CLAUSE_LIMIT
        or any(not part for part in parts)
    ):
        raise _CapabilityContractIncompatible
    clauses: list[tuple[str, tuple[int, ...], bool]] = []
    for part in parts:
        match = _SPECIFIER_CLAUSE_RE.fullmatch(part)
        if match is None:
            raise _CapabilityContractIncompatible
        operator = match.group("operator")
        version = match.group("version")
        wildcard = version.endswith(".*")
        if wildcard:
            if operator not in {"==", "!="}:
                raise _CapabilityContractIncompatible
            version = version[:-2]
        release = _numeric_version(version)
        if operator == "~=" and len(release) < 2:
            raise _CapabilityContractIncompatible
        clauses.append((operator, release, wildcard))
    return tuple(clauses)


def _compare_versions(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    width = max(len(left), len(right))
    padded_left = left + (0,) * (width - len(left))
    padded_right = right + (0,) * (width - len(right))
    return (padded_left > padded_right) - (padded_left < padded_right)


def _version_satisfies_clauses(
    value: str,
    clauses: tuple[tuple[str, tuple[int, ...], bool], ...],
) -> bool:
    release = _numeric_version(value)
    for operator, expected, wildcard in clauses:
        if wildcard:
            candidate = release + (0,) * max(0, len(expected) - len(release))
            matches = candidate[: len(expected)] == expected
            satisfied = matches if operator == "==" else not matches
        else:
            comparison = _compare_versions(release, expected)
            if operator == "~=":
                candidate = release + (0,) * max(
                    0, len(expected) - 1 - len(release)
                )
                satisfied = (
                    comparison >= 0
                    and candidate[: len(expected) - 1] == expected[:-1]
                )
            else:
                satisfied = {
                    "==": comparison == 0,
                    "!=": comparison != 0,
                    "<=": comparison <= 0,
                    ">=": comparison >= 0,
                    "<": comparison < 0,
                    ">": comparison > 0,
                }[operator]
        if not satisfied:
            return False
    return True


def _version_satisfies_specifier(value: str, specifier: str) -> bool:
    return _version_satisfies_clauses(value, _parse_version_specifier(specifier))


def _marker_selects_extra(value: str, selected_extra: str) -> bool:
    comparisons: list[bool] = []
    has_or = False
    quote: str | None = None
    escaped = False
    index = 0
    while index < len(value):
        character = value[index]
        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
            index += 1
            continue
        if character in {'"', "'"}:
            quote = character
            index += 1
            continue
        if character.isascii() and (character.isalnum() or character == "_"):
            end = index + 1
            while end < len(value):
                token_character = value[end]
                if not (
                    token_character.isascii()
                    and (token_character.isalnum() or token_character == "_")
                ):
                    break
                end += 1
            token = value[index:end].lower()
            if token == "or":
                has_or = True
            if token == "extra":
                match = _FORWARD_EXTRA_MARKER_COMPARISON_RE.match(value, index)
                if match is None:
                    match = _REVERSED_EXTRA_MARKER_COMPARISON_RE.search(
                        value[:end]
                    )
                if match is None:
                    raise _CapabilityContractIncompatible
                matches_selected = (
                    _normalize_distribution_name(match.group("extra"))
                    == selected_extra
                )
                comparisons.append(
                    matches_selected
                    if match.group("operator") == "=="
                    else not matches_selected
                )
                if len(comparisons) > _CAPABILITY_CHILD_EXTRA_LIMIT:
                    raise _CapabilityContractIncompatible
                index = max(end, match.end())
                continue
            index = end
            continue
        index += 1
    if has_or and comparisons:
        raise _CapabilityContractIncompatible
    return any(comparisons)


def _selected_extra_dependency(
    value: str,
    selected_extra: str,
) -> (
    tuple[
        str,
        tuple[tuple[str, tuple[int, ...], bool], ...],
        tuple[str, ...],
    ]
    | None
):
    if len(value.encode("utf-8")) > _CAPABILITY_REQUIREMENT_TEXT_LIMIT:
        raise _CapabilityProbeFailure
    marker_text = value.partition(";")[2]
    if not marker_text or not _marker_selects_extra(
        marker_text, selected_extra
    ):
        return None
    marker = _EXACT_EXTRA_MARKER_RE.search(value)
    if marker is None:
        raise _CapabilityContractIncompatible
    if _normalize_distribution_name(marker.group("extra")) != selected_extra:
        return None
    match = _SELECTED_EXTRA_REQUIREMENT_RE.fullmatch(value)
    if match is None:
        raise _CapabilityContractIncompatible
    extras_text = match.group("extras")
    child_extras = (
        ()
        if extras_text is None
        else tuple(
            _normalize_distribution_name(extra.strip())
            for extra in extras_text.split(",")
        )
    )
    if (
        len(child_extras) > _CAPABILITY_CHILD_EXTRA_LIMIT
        or len(set(child_extras)) != len(child_extras)
    ):
        raise _CapabilityContractIncompatible
    specifiers = match.group("specifiers").strip()
    clauses = () if not specifiers else _parse_version_specifier(specifiers)
    return (
        _normalize_distribution_name(match.group("name")),
        clauses,
        child_extras,
    )


def _required_dependency_constraints(
    requirements: tuple[str, ...],
    expected_dependencies: tuple[str, ...],
) -> dict[str, tuple[str, tuple[int, int, int]]]:
    expected = {
        _normalize_distribution_name(dependency): dependency
        for dependency in expected_dependencies
    }
    constraints: dict[str, tuple[str, tuple[int, int, int]]] = {}
    for declared in requirements:
        name_match = _REQUIREMENT_NAME_RE.match(declared)
        if name_match is None:
            continue
        dependency = expected.get(
            _normalize_distribution_name(name_match.group("name"))
        )
        if dependency is None:
            continue
        specifier_text = declared[name_match.end():].strip()
        clauses = _parse_version_specifier(specifier_text)
        exact_clauses = [
            release
            for operator, release, wildcard in clauses
            if operator == "==" and not wildcard and len(release) == 3
        ]
        floor_clauses = [
            release
            for operator, release, wildcard in clauses
            if operator == ">=" and not wildcard and len(release) == 3
        ]
        if len(exact_clauses) == 1 and not floor_clauses:
            constraint = ("==", exact_clauses[0])
        elif len(floor_clauses) == 1 and not exact_clauses:
            constraint = (">=", floor_clauses[0])
        else:
            raise _CapabilityContractIncompatible
        if dependency in constraints:
            raise _CapabilityContractIncompatible
        constraints[dependency] = constraint
    if set(constraints) != set(expected_dependencies):
        raise _CapabilityContractIncompatible
    return constraints


def _optional_dependency_floor(
    requirements: tuple[str, ...],
    dependency: str,
    extra: str,
) -> tuple[int, int, int]:
    normalized_dependency = _normalize_distribution_name(dependency)
    normalized_extra = _normalize_distribution_name(extra)
    floor: tuple[int, int, int] | None = None
    for declared in requirements:
        name_match = _REQUIREMENT_NAME_RE.match(declared)
        if (
            name_match is None
            or _normalize_distribution_name(name_match.group("name"))
            != normalized_dependency
        ):
            continue
        match = _OPTIONAL_REQUIREMENT_FLOOR_RE.fullmatch(declared)
        if match is None:
            marker_text = declared.partition(";")[2]
            if marker_text and _marker_selects_extra(
                marker_text, normalized_extra
            ):
                raise _CapabilityContractIncompatible
            continue
        if (
            _normalize_distribution_name(match.group("extra"))
            != normalized_extra
        ):
            continue
        if floor is not None:
            raise _CapabilityContractIncompatible
        try:
            floor = tuple(
                int(match.group(part)) for part in ("major", "minor", "patch")
            )
        except ValueError as exc:
            raise _CapabilityContractIncompatible from exc
    if floor is None:
        raise _CapabilityContractIncompatible
    return floor


def _capability_requirement_specs(
    capabilities: list[dict],
) -> tuple[
    dict[str, dict],
    dict[str, tuple[str, ...]],
    dict[str, tuple[str, str]],
    dict[str, tuple[str, str]],
]:
    specs: dict[str, dict] = {}
    role_dependencies: dict[str, tuple[str, ...]] = {}
    for capability in capabilities:
        declaration = _CAPABILITY_DECLARATIONS.get(capability["id"])
        if declaration is None:
            raise _CapabilityProbeFailure
        requirements = declaration["requirements"]
        role = declaration.get("governed_role")
        if role is not None and not any(
            requirement["hint"] == role for requirement in requirements
        ):
            raise _CapabilityProbeFailure
        for requirement in requirements:
            hint = requirement["hint"]
            existing = specs.setdefault(hint, requirement)
            if existing != requirement:
                raise _CapabilityProbeFailure
        if role is not None:
            dependencies = tuple(
                requirement["hint"]
                for requirement in requirements
                if requirement["hint"] != role
            )
            existing = role_dependencies.setdefault(role, dependencies)
            if existing != dependencies:
                raise _CapabilityProbeFailure

    requirements_by_distribution: dict[str, str] = {}
    for requirement, spec in specs.items():
        distribution = _normalize_distribution_name(spec["distribution"])
        existing = requirements_by_distribution.setdefault(distribution, requirement)
        if existing != requirement:
            raise _CapabilityProbeFailure

    optional_floor_sources: dict[str, tuple[str, str]] = {}
    selected_extra_sources: dict[str, tuple[str, str]] = {}
    for requirement, spec in specs.items():
        match = _EXTRA_INSTALL_HINT_RE.fullmatch(requirement)
        if match is None:
            continue
        dependency = _normalize_distribution_name(spec["distribution"])
        owner = _normalize_distribution_name(match.group("name"))
        extra = _normalize_distribution_name(match.group("extra"))
        if owner == dependency:
            selected_extra_sources[requirement] = (owner, extra)
            continue
        owner_requirement = requirements_by_distribution.get(owner)
        if owner_requirement is None:
            raise _CapabilityProbeFailure
        optional_floor_sources[requirement] = (owner_requirement, extra)
    return (
        specs,
        role_dependencies,
        optional_floor_sources,
        selected_extra_sources,
    )


def _read_distribution_contract(
    distribution: str,
    roots: tuple[Path, ...],
    index: dict[str, list[tuple[int, Path, Path, str]]],
) -> dict:
    selected = _selected_dist_info(index, distribution)
    if selected is None:
        return {"status": "missing"}
    root_index, root, dist_info, distribution_version = selected
    metadata = _read_capability_file(
        dist_info / "METADATA", root, _CAPABILITY_METADATA_BYTE_LIMIT
    )
    fields, requirements, provided_extras = _parse_capability_metadata(metadata)
    if _normalize_distribution_name(fields["name"]) != _normalize_distribution_name(
        distribution
    ):
        raise _CapabilityContractIncompatible
    if fields["version"] != distribution_version:
        raise _CapabilityContractIncompatible
    if getattr(sys.version_info, "releaselevel", None) != "final":
        raise _CapabilityContractIncompatible
    current_python = ".".join(str(part) for part in sys.version_info[:3])
    if not _version_satisfies_specifier(
        current_python,
        fields["requires_python"],
    ):
        raise _CapabilityContractIncompatible
    record = _read_capability_file(
        dist_info / "RECORD", root, _CAPABILITY_RECORD_BYTE_LIMIT
    )
    _recorded_module_path(
        record,
        None,
        owned_paths=(f"{dist_info.name}/METADATA",),
    )
    return {
        "status": "installed",
        "root_index": root_index,
        "root": root,
        "dist_info": dist_info,
        "record": record,
        "metadata_size": len(metadata),
        "requires_python": fields["requires_python"],
        "declared_version": fields["version"],
        "declared_requirements": requirements,
        "declared_extras": provided_extras,
    }


def _read_capability_distribution(
    spec: dict,
    roots: tuple[Path, ...],
    index: dict[str, list[tuple[int, Path, Path, str]]],
) -> dict:
    evidence = _read_distribution_contract(spec["distribution"], roots, index)
    if evidence["status"] == "missing":
        return evidence
    if spec.get("vivary") and evidence["requires_python"] != ">=3.11":
        raise _CapabilityContractIncompatible

    root_index = evidence["root_index"]
    root = evidence["root"]
    dist_info = evidence["dist_info"]
    module = spec["module"]
    if _has_earlier_module_artifact(roots, root_index, module):
        raise _CapabilityContractIncompatible
    owned_paths = [f"{dist_info.name}/METADATA"]
    if script := spec.get("script"):
        entrypoints = _read_capability_file(
            dist_info / "entry_points.txt",
            root,
            _CAPABILITY_METADATA_BYTE_LIMIT - evidence["metadata_size"],
        )
        if _parse_console_target(entrypoints, script) != (
            module,
            spec["callable"],
        ):
            raise _CapabilityContractIncompatible
        owned_paths.append(f"{dist_info.name}/entry_points.txt")
        _require_recorded_launcher(evidence["record"], root, script)
    artifact = _recorded_module_path(
        evidence["record"],
        module,
        owned_paths=tuple(owned_paths),
    )
    if artifact is None:
        raise _CapabilityContractIncompatible
    if _has_competing_module_artifact(root, module, artifact):
        raise _CapabilityContractIncompatible
    try:
        artifact_path = (root / Path(*artifact.split("/"))).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _CapabilityContractIncompatible from exc
    if not _path_within(root, artifact_path) or not artifact_path.is_file():
        raise _CapabilityContractIncompatible

    return {
        "status": "installed",
        "version": (
            _stable_version(evidence["declared_version"])
            if spec.get("vivary") or spec.get("versioned")
            else None
        ),
        "declared_version": evidence["declared_version"],
        "declared_requirements": evidence["declared_requirements"],
        "declared_extras": evidence["declared_extras"],
    }


def _normalized_declared_extras(extras: tuple[str, ...]) -> set[str]:
    normalized: set[str] = set()
    for extra in extras:
        if _EXTRA_NAME_RE.fullmatch(extra) is None:
            raise _CapabilityContractIncompatible
        value = _normalize_distribution_name(extra)
        if value in normalized:
            raise _CapabilityContractIncompatible
        normalized.add(value)
    return normalized


def _selected_extra_status(
    distribution: str,
    extra: str,
    initial_evidence: dict,
    roots: tuple[Path, ...],
    index: dict[str, list[tuple[int, Path, Path, str]]],
) -> str:
    initial_distribution = _normalize_distribution_name(distribution)
    initial_extra = _normalize_distribution_name(extra)
    cache = {initial_distribution: initial_evidence}
    pending = [(initial_distribution, initial_extra, 0)]
    pending_index = 0
    scheduled = {(initial_distribution, initial_extra)}
    visited: set[tuple[str, str]] = set()
    nodes = 0
    edges = 0
    missing_evidence = False
    incompatible_evidence = False

    while pending_index < len(pending):
        owner, selected_extra, depth = pending[pending_index]
        pending_index += 1
        node = (owner, selected_extra)
        if node in visited:
            continue
        nodes += 1
        if (
            nodes > _CAPABILITY_EXTRA_NODE_LIMIT
            or depth > _CAPABILITY_EXTRA_DEPTH_LIMIT
        ):
            raise _CapabilityProbeFailure
        try:
            evidence = cache.get(owner)
            if evidence is None:
                evidence = _read_distribution_contract(owner, roots, index)
                cache[owner] = evidence
        except _CapabilityContractIncompatible:
            incompatible_evidence = True
            visited.add(node)
            continue
        if evidence["status"] == "missing":
            missing_evidence = True
            visited.add(node)
            continue
        try:
            declared_extras = _normalized_declared_extras(
                evidence["declared_extras"]
            )
        except _CapabilityContractIncompatible:
            incompatible_evidence = True
            visited.add(node)
            continue
        if selected_extra not in declared_extras:
            incompatible_evidence = True
            visited.add(node)
            continue

        selected_rows: set[
            tuple[
                str,
                tuple[tuple[str, tuple[int, ...], bool], ...],
                tuple[str, ...],
            ]
        ] = set()
        dependencies: dict[
            str,
            tuple[
                tuple[tuple[str, tuple[int, ...], bool], ...],
                tuple[str, ...],
            ],
        ] = {}
        for requirement in evidence["declared_requirements"]:
            try:
                dependency = _selected_extra_dependency(requirement, selected_extra)
            except _CapabilityContractIncompatible:
                incompatible_evidence = True
                continue
            if dependency is None:
                continue
            child, clauses, child_extras = dependency
            edges += 1
            if edges > _CAPABILITY_EXTRA_EDGE_LIMIT:
                raise _CapabilityProbeFailure
            if dependency in selected_rows:
                incompatible_evidence = True
                continue
            selected_rows.add(dependency)
            existing_clauses, existing_extras = dependencies.get(
                child, ((), ())
            )
            combined_clauses = existing_clauses + tuple(
                clause for clause in clauses if clause not in existing_clauses
            )
            combined_extras = existing_extras + tuple(
                child_extra
                for child_extra in child_extras
                if child_extra not in existing_extras
            )
            if (
                len(combined_clauses) > _CAPABILITY_SPECIFIER_CLAUSE_LIMIT
                or len(combined_extras) > _CAPABILITY_CHILD_EXTRA_LIMIT
            ):
                incompatible_evidence = True
                continue
            dependencies[child] = (combined_clauses, combined_extras)

        child_nodes: list[tuple[str, str, int]] = []
        for child, (clauses, child_extras) in dependencies.items():
            try:
                child_evidence = cache.get(child)
                if child_evidence is None:
                    child_evidence = _read_distribution_contract(child, roots, index)
                    cache[child] = child_evidence
            except _CapabilityContractIncompatible:
                incompatible_evidence = True
                continue
            if child_evidence["status"] == "missing":
                missing_evidence = True
                continue
            try:
                version_satisfied = not clauses or _version_satisfies_clauses(
                    child_evidence["declared_version"],
                    clauses,
                )
            except _CapabilityContractIncompatible:
                incompatible_evidence = True
                continue
            if not version_satisfied:
                incompatible_evidence = True
                continue
            for child_extra in child_extras:
                child_node = (child, child_extra)
                if child_node in scheduled:
                    continue
                if depth >= _CAPABILITY_EXTRA_DEPTH_LIMIT:
                    raise _CapabilityProbeFailure
                scheduled.add(child_node)
                child_nodes.append((child, child_extra, depth + 1))
        pending.extend(child_nodes)
        visited.add(node)
    if incompatible_evidence:
        return "incompatible"
    return "missing" if missing_evidence else "installed"


def _capability_probe_results(capabilities: list[dict]) -> dict[str, dict]:
    try:
        (
            specs,
            role_dependencies,
            optional_floor_sources,
            selected_extra_sources,
        ) = _capability_requirement_specs(capabilities)
        requirements = tuple(specs)
        roots = _capability_install_roots()
        index = _capability_distribution_index(roots)
    except (OSError, RuntimeError, ValueError, _CapabilityProbeFailure):
        return {
            requirement: {"status": "probe-failed"}
            for requirement in (
                requirement
                for capability in capabilities
                for requirement in capability.get("requires_install", ())
            )
        }

    observed_results: dict[str, dict] = {}
    for requirement in requirements:
        try:
            observed_results[requirement] = _read_capability_distribution(
                specs[requirement],
                roots,
                index,
            )
        except _CapabilityContractIncompatible:
            observed_results[requirement] = {"status": "incompatible"}
        except (
            OSError,
            RuntimeError,
            UnicodeError,
            ValueError,
            _CapabilityProbeFailure,
        ):
            observed_results[requirement] = {"status": "probe-failed"}

    results = {
        requirement: dict(result)
        for requirement, result in observed_results.items()
    }
    for requirement, (owner, extra) in selected_extra_sources.items():
        observed_result = observed_results[requirement]
        if observed_result["status"] != "installed":
            continue
        try:
            status = _selected_extra_status(
                owner,
                extra,
                observed_result,
                roots,
                index,
            )
        except _CapabilityContractIncompatible:
            status = "incompatible"
        except (
            OSError,
            RuntimeError,
            UnicodeError,
            ValueError,
            _CapabilityProbeFailure,
        ):
            status = "probe-failed"
        if status != "installed":
            results[requirement] = {"status": status}

    for role, expected_dependencies in role_dependencies.items():
        observed_result = observed_results.get(role)
        if observed_result is None or observed_result["status"] != "installed":
            continue
        try:
            dependency_constraints = _required_dependency_constraints(
                observed_result["declared_requirements"],
                expected_dependencies,
            )
        except _CapabilityContractIncompatible:
            results[role] = {"status": "incompatible"}
            continue
        for dependency, (operator, required_version) in dependency_constraints.items():
            dependency_result = results.get(dependency)
            if dependency_result is None:
                results[role] = {"status": "incompatible"}
                break
            if dependency_result["status"] != "installed":
                continue
            installed_version = dependency_result["version"]
            if (
                operator == ">="
                and installed_version < required_version
                or operator == "=="
                and installed_version != required_version
            ):
                results[role] = {"status": "incompatible"}
                break
    for dependency, (owner, extra) in optional_floor_sources.items():
        dependency_result = results.get(dependency)
        if dependency_result is None or dependency_result["status"] not in {
            "installed",
            "missing",
        }:
            continue
        owner_result = observed_results.get(owner)
        if owner_result is None or owner_result["status"] == "missing":
            if dependency_result["status"] == "installed":
                results[dependency] = {"status": "incompatible"}
            continue
        if owner_result["status"] != "installed":
            results[dependency] = {
                "status": (
                    "probe-failed"
                    if owner_result["status"] == "probe-failed"
                    else "incompatible"
                )
            }
            continue
        try:
            floor = _optional_dependency_floor(
                owner_result["declared_requirements"],
                specs[dependency]["distribution"],
                extra,
            )
        except _CapabilityContractIncompatible:
            results[dependency] = {"status": "incompatible"}
            continue
        if dependency_result["status"] == "missing":
            continue
        try:
            version_satisfies_floor = _provider_version_meets_floor(
                dependency_result["declared_version"],
                floor,
            )
        except _CapabilityContractIncompatible:
            results[dependency] = {"status": "incompatible"}
            continue
        if not version_satisfies_floor:
            results[dependency] = {"status": "incompatible"}
    return results


def _annotate_capability(capability: dict, results: dict[str, dict]) -> None:
    requirements = capability.get("requires_install", ())
    statuses = [results[requirement]["status"] for requirement in requirements]
    if "probe-failed" in statuses:
        status = "probe-failed"
        reasons = ["capability_probe_failed"]
        missing: list[str] = []
    elif "incompatible" in statuses:
        status = "incompatible"
        reasons = ["capability_contract_incompatible"]
        missing = []
    elif "missing" in statuses:
        status = "not-installed"
        reasons = ["capability_dependency_missing"]
        missing = [
            requirement
            for requirement in requirements
            if results[requirement]["status"] == "missing"
        ]
    else:
        status = "installed"
        reasons = []
        missing = []
    capability["installed"] = status == "installed"
    capability["install_status"] = status
    capability["reason_codes"] = reasons
    capability["missing_install"] = missing

def _annotate_mcp_capability(capability: dict, results: dict[str, dict]) -> None:
    package = results.get("vivary-mcp", {"status": "probe-failed"})
    sdk = results.get("mcp", {"status": "probe-failed"})
    package_status = package.get("status")
    capability["package_present"] = (
        False
        if package_status == "missing"
        else True
        if package_status in {"installed", "incompatible"}
        else None
    )
    capability["entry_point_present"] = (
        True
        if package_status in {"installed", "incompatible"}
        else False
        if package_status == "missing"
        else None
    )
    capability["sdk_version"] = (
        sdk.get("declared_version")
        if sdk.get("status") == "installed"
        else None
    )
    capability["sdk_compatible"] = (
        sdk.get("status") == "installed"
        and sdk.get("version") == (2, 0, 0)
    )


def _capability_declarations(preset: str | None) -> list[dict]:
    capabilities: list[dict] = []
    for capability_id, declaration in _CAPABILITY_DECLARATIONS.items():
        presets = declaration.get("presets")
        if presets is not None and preset not in presets:
            continue
        capability = {
            "id": capability_id,
            **{
                field: value
                for field, value in declaration.items()
                if field
                not in {
                    "governed_role",
                    "presets",
                    "requirements",
                    "versioned",
                }
            },
            "requires_install": [
                requirement["hint"] for requirement in declaration["requirements"]
            ],
        }
        for field in ("tool_names", "extensions"):
            if field in capability:
                capability[field] = list(capability[field])
        capabilities.append(capability)
    return capabilities


def _build_capability_report(preset: str | None) -> dict:
    capabilities = _capability_declarations(preset)
    results = _capability_probe_results(capabilities)
    for capability in capabilities:
        _annotate_capability(capability, results)
        if capability["id"] == "interop:mcp":
            _annotate_mcp_capability(capability, results)
    return {
        "ok": True,
        "preset": preset,
        "default_capabilities": ["storage:file", "memory:none"],
        "available_capabilities": capabilities,
    }


def capability_report(preset: str = "coding") -> dict:
    if preset not in PRESETS:
        raise ScaffoldError(
            f"unknown preset {preset!r}; expected one of {', '.join(PRESETS)}"
        )
    return _build_capability_report(preset)


def _add_receipt_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--receipt",
        metavar="PATH",
        default=None,
        help=(
            "append a local privacy-preserving JSONL run receipt "
            f"(or set {RECEIPT_ENV})"
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="create-vivary",
        description="Create a lightweight local-first Vivary context workspace.",
    )
    parser.add_argument("--version", action="version", version=f"create-vivary {__version__}")
    _add_receipt_argument(parser)
    sub = parser.add_subparsers(dest="command")

    init = sub.add_parser("init", help="create a Vivary workspace scaffold")
    _add_receipt_argument(init)
    init.add_argument("target", help="directory to create or populate")
    init.add_argument("--preset", choices=PRESETS, default="coding")
    init.add_argument(
        "--adapter",
        action="append",
        choices=tuple(_THIN_ADAPTER_PATHS),
        default=[],
        help="add one bounded runtime projection; repeat for both supported adapters",
    )
    init.add_argument(
        "--force",
        action="store_true",
        help=(
            "compatibility flag; init still refuses nonempty targets and directs "
            "existing workspaces to governed adopt"
        ),
    )
    init.add_argument(
        "--active-context",
        choices=ACTIVE_CONTEXTS,
        default=None,
        help=(
            "declare an optional active-context capability in the five-file seed; "
            "does not install or materialize its sidecar"
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
                      help="storage backend (auto=file unless cloud locality is explicit)")
    init.add_argument("--provider", choices=["lancedb", "sqlite-vec", "qdrant", "astra"],
                      default=None, help="storage provider (default: lancedb)")
    init.add_argument("--memory", choices=MEMORY_MODES, default="none",
                      help="optional semantic memory policy (default: none)")
    init.add_argument("--size", choices=["small", "medium", "large"], default=None,
                      help="workspace size hint for --auto decisions")
    init.add_argument("--privacy", choices=["local", "cloud"], default=None,
                      help="data locality hint for --auto decisions")

    wizard = sub.add_parser("wizard", help="reconfigure storage for an existing workspace")
    _add_receipt_argument(wizard)
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
    _add_receipt_argument(doctor)
    doctor.add_argument("target", help="workspace directory to validate")
    doctor.add_argument("--json", action="store_true", help="print a JSON report")
    doctor.add_argument(
        "--repair",
        action="store_true",
        help=(
            "include conservative repair diagnostics; legacy-full workspaces remain "
            "report-only"
        ),
    )
    doctor.add_argument(
        "--yes",
        action="store_true",
        help=(
            "with --repair, apply deterministic safe repairs to supported contracts; "
            "never writes legacy-full workspaces"
        ),
    )
    doctor.add_argument(
        "--trend",
        action="store_true",
        help=(
            "compare this run against its prior local runtime snapshot and report "
            "drift (write gate: only --trend writes this file)"
        ),
    )
    doctor.add_argument(
        "--repo-root",
        default=None,
        help="Vivary source checkout root (mainly for local development/tests)",
    )

    capabilities = sub.add_parser("capabilities", help="list optional preset capabilities")
    _add_receipt_argument(capabilities)
    capabilities.add_argument("--preset", choices=PRESETS, default="coding")
    capabilities.add_argument("--json", action="store_true", help="print a JSON report")

    adopt = sub.add_parser(
        "adopt", help="plan and apply bounded governed context for an existing workspace"
    )
    _add_receipt_argument(adopt)
    adopt.add_argument("target", help="existing directory to adopt")
    adopt.add_argument(
        "--preset",
        choices=PRESETS,
        default=None,
        help="thin workspace policy; default is inferred from the tree",
    )
    adopt.add_argument("--yes", action="store_true",
                       help="write the planned files (default is dry-run: plan only)")
    adopt.add_argument(
        "--plan",
        default=None,
        help="exact plan hash from the approved dry-run; required with --yes",
    )
    adopt.add_argument(
        "--recover",
        default=None,
        metavar="PLAN_HASH",
        help=(
            "plan recovery for an interrupted transaction bound to this adoption "
            "hash; apply only with --yes --plan <recovery-hash>"
        ),
    )
    adopt.add_argument(
        "--adapter",
        action="append",
        choices=tuple(_THIN_ADAPTER_PATHS),
        default=[],
        help="add one bounded runtime projection; repeat for both supported adapters",
    )
    adopt.add_argument("--json", action="store_true", help="machine-readable output")
    adopt.add_argument(
        "--repo-root",
        default=None,
        help="Vivary source checkout root (mainly for local development/tests)",
    )

    record = sub.add_parser(
        "record",
        help="plan and apply one capsule-bound record earned by real work",
    )
    _add_receipt_argument(record)
    record.add_argument("target", help="existing thin Vivary workspace")
    record.add_argument(
        "record",
        help="bounded record path such as changes/verified-slice.md",
    )
    record.add_argument(
        "--from",
        dest="source",
        required=True,
        metavar="PATH",
        help="complete UTF-8 Markdown record to validate and propose",
    )
    record.add_argument(
        "--capsule",
        required=True,
        metavar="PATH",
        help="complete governed or public Task Capsule JSON returned by Tropo or vivary_capsule",
    )
    record.add_argument(
        "--yes",
        action="store_true",
        help="apply the approved single-record plan (default is dry-run)",
    )
    record.add_argument(
        "--plan",
        default=None,
        help="exact plan hash from the approved dry-run; required with --yes",
    )
    record.add_argument("--json", action="store_true", help="machine-readable output")
    record.add_argument(
        "--repo-root",
        default=None,
        help="Vivary source checkout root (mainly for local development/tests)",
    )
    return parser


def with_default_command(argv: list[str]) -> list[str]:
    """Default a bare target to the ``init`` subcommand so ``create-vivary <name>``
    behaves like ``create-vivary init <name>``. The npm launcher forwards raw argv
    here, so Python is the sole owner of command recognition and normalization."""
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--":
            return argv
        if token in ("-h", "--help", "--version"):
            return argv
        if token == "--receipt":
            if index + 1 >= len(argv) or argv[index + 1].startswith("-"):
                return argv
            index += 2
            continue
        if token.startswith("--receipt="):
            index += 1
            continue
        if token.startswith("-"):
            return argv
        if token not in SUBCOMMANDS:
            return [*argv[:index], "init", *argv[index:]]
        return argv
    return argv


def _extract_receipt_path(argv: list[str]) -> tuple[str | None, str | None]:
    for index, token in enumerate(argv):
        if token == "--":
            break
        if token == "--receipt":
            if index + 1 < len(argv) and not argv[index + 1].startswith("-"):
                return argv[index + 1], "flag"
            return None, None
        if token.startswith("--receipt="):
            path = token.split("=", 1)[1]
            return (path, "flag") if path else (None, None)
    env_path = os.environ.get(RECEIPT_ENV)
    if env_path:
        return env_path, "env"
    return None, None


def _receipt_flags(argv: list[str]) -> list[str]:
    flags: set[str] = set()
    skip_value = False
    for token in argv:
        if token == "--":
            break
        if skip_value:
            skip_value = False
            continue
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            if name in RECEIPT_KNOWN_FLAGS and name != "--receipt":
                flags.add(name)
            if name in RECEIPT_VALUE_FLAGS and "=" not in token:
                skip_value = True
        elif token in RECEIPT_KNOWN_FLAGS:
            flags.add(token)
    return sorted(flags)


def _receipt_command(argv: list[str]) -> str:
    if "--version" in argv:
        return "version"
    if any(token in ("-h", "--help") for token in argv):
        return "help"
    normalized = with_default_command(list(argv))
    skip_value = False
    for token in normalized:
        if token == "--":
            break
        if skip_value:
            skip_value = False
            continue
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            if name in RECEIPT_VALUE_FLAGS and "=" not in token:
                skip_value = True
            continue
        if token in SUBCOMMANDS:
            return token
    return "help"


def _exit_code_value(code) -> int:
    if code is None:
        return 0
    if isinstance(code, int):
        return code
    return 1


def _receipt_is_reserved_windows_path(path: Path) -> bool:
    if os.name != "nt":
        return False
    stem = path.name.split(".", 1)[0].rstrip(" .").upper()
    return stem in RECEIPT_RESERVED_WINDOWS_NAMES


def _receipt_has_symlink_ancestor(path: Path) -> bool:
    target = path if path.is_absolute() else Path.cwd() / path
    current = target.parent
    while True:
        if os.path.lexists(current) and (
            current.is_symlink()
            or (
                hasattr(os.path, "isjunction")
                and os.path.isjunction(current)
            )
        ):
            return True
        parent = current.parent
        if parent == current:
            return False
        current = parent


def _receipt_error_message(exc: OSError) -> str:
    message = str(exc)
    safe_messages = {
        "receipt path must not be a Windows device name",
        "receipt path must not be a symlink",
        "receipt path must be a regular file",
        "receipt path must not contain a symlink or junction directory",
    }
    if message in safe_messages:
        return message
    return "could not write receipt; check that the receipt path is a writable regular file"


def _append_run_receipt(
    *,
    tool: str,
    version: str,
    argv: list[str],
    started_at: float,
    exit_code: int,
    receipt_path: str | None,
    receipt_source: str | None,
    error_type: str | None = None,
) -> bool:
    if not receipt_path:
        return True

    target = Path(receipt_path).expanduser()
    try:
        if _receipt_is_reserved_windows_path(target):
            raise OSError("receipt path must not be a Windows device name")
        if _receipt_has_symlink_ancestor(target):
            raise OSError("receipt path must not contain a symlink or junction directory")
        if target.exists() or os.path.lexists(target):
            if target.is_symlink():
                raise OSError("receipt path must not be a symlink")
            if not target.is_file():
                raise OSError("receipt path must be a regular file")
        target.parent.mkdir(parents=True, exist_ok=True)
        if _receipt_has_symlink_ancestor(target):
            raise OSError("receipt path must not contain a symlink or junction directory")

        record = {
            "schema": RECEIPT_SCHEMA,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "tool": tool,
            "version": version,
            "command": _receipt_command(argv),
            "flags": _receipt_flags(argv),
            "arg_count": len(argv),
            "exit_code": exit_code,
            "ok": exit_code == 0,
            "duration_ms": int((time.monotonic() - started_at) * 1000),
            "python": platform.python_version(),
            "platform": platform.system(),
            "receipt_source": receipt_source,
        }
        if error_type:
            record["error_type"] = error_type
        with target.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(record, sort_keys=True, separators=(",", ":")))
            fh.write("\n")
    except OSError as exc:
        print(f"{tool}: receipt: {_receipt_error_message(exc)}", file=sys.stderr)
        return False
    return True


def _main(argv: list[str] | None = None) -> int:
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
                markers = [
                    "default" if cap["default"] else None,
                    cap["install_status"],
                ]
                marker = ", ".join(value for value in markers if value)
                print(f"- {cap['id']}: {cap['label']} ({marker})")
        return 0

    if args.command == "record":
        try:
            result = record_workspace(
                args.target,
                args.record,
                source=args.source,
                capsule=args.capsule,
                repo_root=args.repo_root,
                yes=args.yes,
                plan_hash=args.plan,
            )
        except ScaffoldError as exc:
            if getattr(args, "json", False):
                print(json.dumps({"ok": False, "error": str(exc)}))
            else:
                print(f"create-vivary record: {exc}", file=sys.stderr)
            return 1
        if args.json:
            print(json.dumps(_record_report_to_json(result), indent=2))
        else:
            _print_record_report(result)
        return 0

    if args.command == "doctor":
        if getattr(args, "repair", False):
            report = doctor_repair_workspace(
                args.target,
                repo_root=args.repo_root,
                yes=getattr(args, "yes", False),
            )
        else:
            report = doctor_workspace(args.target, repo_root=args.repo_root)
        trend_lines: list[str] = []
        if getattr(args, "trend", False):
            repair_actions = report.get("repair", {}).get("actions", [])
            repair_report_only = (
                report.get("repair", {}).get("mode") == "report-only"
            )
            repair_target_refused = getattr(args, "repair", False) and (
                any(
                    error.startswith("doctor --repair: refusing to repair")
                    for error in report["errors"]
                )
                or any(
                    action.get("kind") == "workspace" and action.get("status") == "manual"
                    for action in repair_actions
                )
            )
            if repair_report_only:
                report["trend"] = None
                report["warnings"].append(
                    "doctor --trend skipped because legacy repair is report-only"
                )
                trend_lines = ["trend: skipped because legacy repair is report-only"]
            elif repair_target_refused:
                report["trend"] = None
                report["warnings"].append(
                    "doctor --trend skipped because repair target was refused"
                )
                trend_lines = ["trend: skipped because repair target was refused"]
            elif getattr(args, "repair", False) and not getattr(args, "yes", False):
                report["trend"] = None
                report["warnings"].append(
                    "doctor --trend skipped during repair dry-run; add --yes to write trend state"
                )
                trend_lines = [
                    "trend: skipped during repair dry-run (add --yes to write state)"
                ]
            else:
                try:
                    target_path = _resolve_scaffold_target(args.target)
                except ScaffoldError as exc:
                    report["errors"].append(f"doctor --trend: {exc}")
                    report["ok"] = False
                    report["trend"] = None
                else:
                    if target_path.is_dir():
                        try:
                            trend_result = _apply_doctor_trend(report, target_path)
                        except (ScaffoldError, OSError) as exc:
                            report["errors"].append(f"doctor --trend: {exc}")
                            report["ok"] = False
                            report["trend"] = None
                        else:
                            report["trend"] = trend_result["trend"]
                            if trend_result["state_warning"]:
                                # kept out of report["warnings"] so a corrupt state file
                                # never inflates the stored warning_count
                                report["trend_warning"] = trend_result["state_warning"]
                            trend_lines = _format_doctor_trend(
                                trend_result["trend"], trend_result["state_warning"]
                            )
                    else:
                        report["trend"] = None
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            _print_doctor_report(report)
            for line in trend_lines:
                print(line)
        return 0 if report["ok"] else 1

    if args.command == "adopt":
        yes = getattr(args, "yes", False)
        try:
            result = adopt_workspace(
                args.target,
                preset=args.preset,
                adapters=tuple(args.adapter),
                repo_root=args.repo_root,
                yes=yes,
                plan_hash=args.plan,
                recover_hash=args.recover,
            )
        except ScaffoldError as exc:
            if getattr(args, "json", False):
                print(json.dumps({"ok": False, "error": str(exc)}))
            else:
                print(f"create-vivary adopt: {exc}", file=sys.stderr)
            return 1
        mode = (
            "recovered"
            if result.get("recovered")
            else "recovery-dry-run"
            if args.recover is not None
            else "applied"
            if yes
            else "dry-run"
        )
        if args.json:
            print(json.dumps(_adopt_report_to_json(result, mode=mode), indent=2))
        else:
            _print_adopt_report(result, mode=mode)
        if mode == "applied" and not result["doctor"]["ok"]:
            return 1
        return 0 if not result.get("conflicts") else 1

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
        target_path = _resolve_scaffold_target(args.target)
        _validate_thin_init_target(target_path, force=args.force)
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

        created = scaffold_thin_workspace(
            args.target,
            preset=args.preset,
            adapters=tuple(args.adapter),
            active_context=args.active_context,
            force=args.force,
            repo_root=args.repo_root,
            dry_run=dry_run,
        )
        if storage != "file":
            created.extend(
                _write_vivary_dir(
                    target_path,
                    storage,
                    provider,
                    dry_run,
                    force=args.force,
                )
            )
        if memory != "none":
            created.extend(
                _write_memory_config(
                    target_path,
                    memory,
                    dry_run,
                    force=args.force,
                )
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
            "contract": THIN_WORKSPACE_CONTRACT,
            "preset": args.preset,
            "adapters": list(args.adapter),
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


def main(argv: list[str] | None = None) -> int:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    started_at = time.monotonic()
    receipt_path, receipt_source = _extract_receipt_path(raw_argv)
    try:
        rc = _main(raw_argv)
    except SystemExit as exc:
        code = _exit_code_value(exc.code)
        receipt_ok = _append_run_receipt(
            tool="create-vivary",
            version=__version__,
            argv=raw_argv,
            started_at=started_at,
            exit_code=code,
            receipt_path=receipt_path,
            receipt_source=receipt_source,
            error_type="SystemExit" if code else None,
        )
        if not receipt_ok and code == 0:
            raise SystemExit(1) from exc
        raise
    except Exception as exc:
        _append_run_receipt(
            tool="create-vivary",
            version=__version__,
            argv=raw_argv,
            started_at=started_at,
            exit_code=1,
            receipt_path=receipt_path,
            receipt_source=receipt_source,
            error_type=type(exc).__name__,
        )
        raise
    receipt_ok = _append_run_receipt(
        tool="create-vivary",
        version=__version__,
        argv=raw_argv,
        started_at=started_at,
        exit_code=_exit_code_value(rc),
        receipt_path=receipt_path,
        receipt_source=receipt_source,
    )
    if not receipt_ok and _exit_code_value(rc) == 0:
        return 1
    return rc


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
    capabilities = report.get("capabilities", {}).get("available_capabilities", ())
    for capability in capabilities:
        if (
            capability["id"].startswith("governed-")
            or capability["id"] == "interop:mcp"
        ):
            print(
                f"capability: {capability['id']} "
                f"({capability['install_status']})"
            )
    for warning in report["warnings"]:
        print(f"warning: {warning}")
    for error in report["errors"]:
        print(f"error: {error}")
    repair = report.get("repair")
    if repair:
        print(f"repair: {repair['mode']} ({len(repair['actions'])} action(s))")
        for action in repair["actions"]:
            applied = "applied" if action["applied"] else action["status"]
            print(
                f"repair {applied}: {action['kind']} {action['path']} - "
                f"{action['summary']}"
            )


if __name__ == "__main__":
    raise SystemExit(main())
