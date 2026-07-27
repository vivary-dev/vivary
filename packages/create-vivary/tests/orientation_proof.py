#!/usr/bin/env python3
"""Cross-platform proof for issue #200's public orientation loop.

Every fixture lives under a fresh temporary directory. The proof never accepts a
user workspace path and emits a sanitized aggregate receipt chosen by the caller.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[3]
CREATE_PACKAGE = ROOT / "packages" / "create-vivary"
CREATE_CLI = CREATE_PACKAGE / "create_vivary.py"
NPM_CLI = CREATE_PACKAGE / "npm" / "index.js"
TROPO_PACKAGE = ROOT / "packages" / "tropo"
TROPO_CLI = TROPO_PACKAGE / "tropo.py"

sys.path.insert(0, str(CREATE_PACKAGE))
sys.path.insert(0, str(TROPO_PACKAGE))

import create_vivary  # noqa: E402
import tropo  # noqa: E402

PROOF_SCHEMA = "vivary.orientation_proof.v1"
FIXTURE_KINDS = (
    "current",
    "legacy",
    "brownfield",
    "adopted",
    "divergent-checkout",
    "corrupt",
)
APPLY_KINDS = {"brownfield", "divergent-checkout"}
MAP_DEPTH = 3
MAP_MAX_ENTRIES = 200
FIND_BUDGET = 400
FIND_LIMIT = 5


class ProofFailure(RuntimeError):
    """An observable proof contract failed."""


@dataclass(frozen=True)
class CreateTransport:
    name: str
    prefix: tuple[str, ...]
    env: Mapping[str, str]


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _is_boundary(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    except OSError:
        return False
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse)


def snapshot_tree(root: Path) -> dict[str, str]:
    """Return stable content hashes without crossing Git or filesystem boundaries."""
    snapshot: dict[str, str] = {}

    def visit(directory: Path) -> None:
        for entry in sorted(os.scandir(directory), key=lambda item: item.name.casefold()):
            path = Path(entry.path)
            rel = path.relative_to(root).as_posix()
            if rel == ".git" or rel.startswith(".git/"):
                continue
            if _is_boundary(path):
                snapshot[rel] = "boundary"
            elif entry.is_dir(follow_symlinks=False):
                visit(path)
            elif entry.is_file(follow_symlinks=False):
                snapshot[rel] = hashlib.sha256(path.read_bytes()).hexdigest()

    visit(root)
    return snapshot


def snapshot_delta(before: Mapping[str, str], after: Mapping[str, str]) -> dict[str, list[str]]:
    before_paths = set(before)
    after_paths = set(after)
    return {
        "created": sorted(after_paths - before_paths),
        "changed": sorted(path for path in before_paths & after_paths if before[path] != after[path]),
        "deleted": sorted(before_paths - after_paths),
    }


def snapshot_fingerprint(snapshot: Mapping[str, str]) -> str:
    encoded = json.dumps(dict(sorted(snapshot.items())), separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _run_text(argv: Sequence[str], *, cwd: Path, env: Mapping[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run(
        list(argv),
        cwd=cwd,
        env=merged_env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )


def _sanitized_argv(argv: Sequence[str], fixture: Path) -> list[str]:
    replacements = {
        str(fixture): "<fixture>",
        str(fixture.resolve()): "<fixture>",
        str(ROOT): "<repo>",
        str(ROOT.resolve()): "<repo>",
        str(CREATE_PACKAGE): "<repo>/packages/create-vivary",
        str(CREATE_PACKAGE.resolve()): "<repo>/packages/create-vivary",
    }
    sanitized = []
    for raw in argv:
        value = str(raw)
        for source, replacement in sorted(replacements.items(), key=lambda pair: len(pair[0]), reverse=True):
            value = value.replace(source, replacement)
        sanitized.append(value.replace("\\", "/"))
    return sanitized


def _sanitize_text(text: str, fixture: Path, temp_root: Path) -> str:
    value = text
    for source, replacement in (
        (str(fixture.resolve()), "<fixture>"),
        (str(fixture), "<fixture>"),
        (str(temp_root.resolve()), "<proof-temp>"),
        (str(temp_root), "<proof-temp>"),
        (str(ROOT.resolve()), "<repo>"),
    ):
        value = value.replace(source, replacement)
        value = value.replace(source.replace("\\", "/"), replacement)
    return value


def _run_json(
    prefix: Sequence[str],
    args: Sequence[str],
    *,
    transport: str,
    fixture: Path,
    commands: list[dict],
    env: Mapping[str, str] | None = None,
) -> tuple[int, dict]:
    argv = [*prefix, *args]
    completed = _run_text(argv, cwd=ROOT, env=env)
    commands.append(
        {
            "transport": transport,
            "argv": _sanitized_argv(args, fixture),
            "exit_code": completed.returncode,
        }
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise ProofFailure(f"{transport} emitted invalid JSON: {detail[:240]}") from exc
    return completed.returncode, payload


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ProofFailure(message)


def _brownfield(root: Path) -> None:
    _write(root / "README.md", "# Existing project\n")
    _write(root / "CLAUDE.md", "# Existing agent guidance\n")
    for index in range(6):
        _write(root / "docs" / f"topic-{index}.md", f"# Workspace topic {index}\n")
    _write(root / "src" / "main.py", "print('workspace')\n")
    _write(root / "src" / "util.py", "def context():\n    return 'typed'\n")


def _current(root: Path) -> None:
    create_vivary.scaffold_workspace(root, preset="coding", repo_root=ROOT)


def _legacy(root: Path) -> None:
    _current(root)
    _write(
        root / ".gitignore",
        "USER.md\nMEMORY.md\nmemory/*\n!memory/.gitkeep\n.strato/private/\n",
    )
    modules = root / "modules"
    for module_dir in sorted(path for path in modules.iterdir() if path.is_dir()):
        (modules / f"{module_dir.name}.md").write_bytes((module_dir / "index.md").read_bytes())
        shutil.rmtree(module_dir)
    (modules / "index.md").unlink()


def _git(root: Path, *args: str, allowed: Iterable[int] = (0,)) -> subprocess.CompletedProcess[str]:
    completed = _run_text(("git", *args), cwd=root)
    if completed.returncode not in set(allowed):
        raise ProofFailure(f"git {' '.join(args)} failed: {completed.stderr.strip()}")
    return completed


def _divergent(root: Path) -> None:
    _brownfield(root)
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "proof@vivary.invalid")
    _git(root, "config", "user.name", "Vivary Proof")
    _git(root, "add", ".")
    _git(root, "commit", "-m", "baseline")
    _git(root, "checkout", "-b", "feature")
    _write(root / "src" / "main.py", "print('feature workspace')\n")
    _git(root, "add", "src/main.py")
    _git(root, "commit", "-m", "feature change")
    _git(root, "checkout", "main")
    _write(root / "src" / "main.py", "print('main workspace')\n")
    _git(root, "add", "src/main.py")
    _git(root, "commit", "-m", "main change")
    _git(root, "checkout", "feature")
    _require(_git(root, "merge-base", "--is-ancestor", "main", "feature", allowed=(0, 1)).returncode == 1, "main unexpectedly contains feature")
    _require(_git(root, "merge-base", "--is-ancestor", "feature", "main", allowed=(0, 1)).returncode == 1, "feature unexpectedly contains main")


def _git_state(root: Path) -> dict:
    branch = _git(root, "branch", "--show-current").stdout.strip()
    head = _git(root, "rev-parse", "HEAD").stdout.strip()
    refs = sorted(line.strip() for line in _git(root, "show-ref", "--heads").stdout.splitlines())
    status_lines = sorted(
        line.rstrip() for line in _git(root, "status", "--porcelain=v1", "--untracked-files=all").stdout.splitlines()
    )
    return {
        "branch": branch,
        "head": head,
        "refs_fingerprint": hashlib.sha256("\n".join(refs).encode()).hexdigest(),
        "status_fingerprint": hashlib.sha256("\n".join(status_lines).encode()).hexdigest(),
        "status_entries": len(status_lines),
    }


def _install_boundary(root: Path) -> str:
    outside = root.parent / f"outside-{root.name}"
    outside.mkdir()
    boundary_marker = f"outside-only-{root.name}"
    _write(
        outside / "modules" / boundary_marker / "index.md",
        """---
project: boundary-proof
status: active
module_area: unsafe boundary sentinel
---
# External Boundary Workspace Context

Workspace context from outside the disposable fixture must never be retrieved.
""",
    )
    boundary = root / "external-boundary"
    if os.name == "nt":
        completed = _run_text(("cmd.exe", "/d", "/c", "mklink", "/J", str(boundary), str(outside)), cwd=root)
        if completed.returncode != 0:
            raise ProofFailure(f"could not create Windows junction: {completed.stderr.strip() or completed.stdout.strip()}")
    else:
        boundary.symlink_to(outside, target_is_directory=True)
    _require(_is_boundary(boundary), "unsafe boundary was not recognized")
    return boundary_marker


def build_fixture(kind: str, root: Path) -> str:
    root.mkdir()
    if kind == "current":
        _current(root)
    elif kind == "legacy":
        _legacy(root)
    elif kind == "brownfield":
        _brownfield(root)
    elif kind == "adopted":
        _brownfield(root)
        result = create_vivary.adopt_workspace(root, preset="coding", repo_root=ROOT, yes=True)
        _require(result["doctor"]["ok"], "adopted fixture construction failed Doctor")
    elif kind == "divergent-checkout":
        _divergent(root)
    elif kind == "corrupt":
        _current(root)
        (root / "AGENTS.md").unlink()
    else:
        raise ValueError(f"unknown fixture kind: {kind}")
    return _install_boundary(root)


def _default_transports() -> tuple[CreateTransport, CreateTransport]:
    node = shutil.which("node")
    uvx = shutil.which("uvx")
    if not node:
        raise ProofFailure("node is required for npm/Python parity")
    if not uvx:
        raise ProofFailure("uvx is required for real npm launcher dispatch")
    python_transport = CreateTransport("python", (sys.executable, str(CREATE_CLI)), {})
    npm_transport = CreateTransport(
        "npm",
        (node, str(NPM_CLI)),
        {"VIVARY_FROM": str(CREATE_PACKAGE.resolve())},
    )
    return python_transport, npm_transport


def local_test_transports() -> tuple[CreateTransport, CreateTransport]:
    """Exercise the full flow without requiring uvx in the ordinary unit suite."""
    prefix = (sys.executable, str(CREATE_CLI))
    return CreateTransport("python", prefix, {}), CreateTransport("npm-test-double", prefix, {})


def _version(argv: Sequence[str]) -> str:
    completed = _run_text(argv, cwd=ROOT)
    if completed.returncode != 0:
        raise ProofFailure(f"version command failed: {' '.join(argv)}")
    return (completed.stdout or completed.stderr).strip().splitlines()[0]


def _create_args(command: str, fixture: Path, *extra: str) -> list[str]:
    return [command, str(fixture), *extra, "--json", "--repo-root", str(ROOT)]


def _proof_fixture(
    kind: str,
    fixture: Path,
    temp_root: Path,
    python_transport: CreateTransport,
    npm_transport: CreateTransport,
    *,
    commands: list[dict],
    initial: Mapping[str, str],
    sentinel: str,
    progress: dict,
) -> dict:
    initial_fingerprint = snapshot_fingerprint(initial)
    git_before = _git_state(fixture) if kind == "divergent-checkout" else None

    map_before = snapshot_tree(fixture)
    map_rc, map_payload = _run_json(
        (sys.executable, str(TROPO_CLI)),
        (
            "map",
            "--root",
            str(fixture),
            "--depth",
            str(MAP_DEPTH),
            "--max-entries",
            str(MAP_MAX_ENTRIES),
            "--json",
        ),
        transport="tropo",
        fixture=fixture,
        commands=commands,
    )
    map_after = snapshot_tree(fixture)
    _require(map_rc == 0, f"{kind}: tropo map failed")
    _require(map_before == map_after, f"{kind}: tropo map mutated the fixture")
    map_boundary_pruned = sentinel not in json.dumps(map_payload)
    _require(map_boundary_pruned, f"{kind}: tropo map crossed the unsafe boundary")
    _require(
        len(map_payload["directories"]) <= MAP_MAX_ENTRIES,
        f"{kind}: tropo map exceeded its entry cap",
    )
    _require(
        all(row["depth"] <= MAP_DEPTH for row in map_payload["directories"]),
        f"{kind}: tropo map exceeded its depth bound",
    )

    adopt_args = _create_args("adopt", fixture, "--preset", "coding")
    dry_before = snapshot_tree(fixture)
    py_adopt_rc, py_adopt = _run_json(
        python_transport.prefix,
        adopt_args,
        transport=python_transport.name,
        fixture=fixture,
        commands=commands,
        env=python_transport.env,
    )
    npm_adopt_rc, npm_adopt = _run_json(
        npm_transport.prefix,
        adopt_args,
        transport=npm_transport.name,
        fixture=fixture,
        commands=commands,
        env=npm_transport.env,
    )
    dry_after = snapshot_tree(fixture)
    adopt_exit_equal = py_adopt_rc == npm_adopt_rc == 0
    adopt_payload_equal = py_adopt == npm_adopt
    dry_run_read_only = dry_before == dry_after
    _require(adopt_exit_equal, f"{kind}: adopt dry-run failed")
    _require(adopt_payload_equal, f"{kind}: npm/Python adopt JSON differs")
    _require(dry_run_read_only, f"{kind}: adopt dry-run wrote to the fixture")
    _require(py_adopt["mode"] == "dry-run", f"{kind}: adopt did not report dry-run mode")
    expected = sorted(py_adopt["would_create"])
    progress["expected_mutations"] = expected

    actual = {"created": [], "changed": [], "deleted": []}
    idempotent: bool | None = None
    if kind in APPLY_KINDS:
        apply_before = snapshot_tree(fixture)
        apply_rc, apply_payload = _run_json(
            python_transport.prefix,
            _create_args("adopt", fixture, "--preset", "coding", "--yes"),
            transport=python_transport.name,
            fixture=fixture,
            commands=commands,
            env=python_transport.env,
        )
        apply_after = snapshot_tree(fixture)
        actual = snapshot_delta(apply_before, apply_after)
        _require(apply_rc == 0 and apply_payload["ok"], f"{kind}: adopt apply failed")
        _require(actual["created"] == expected, f"{kind}: actual creates differ from dry-run")
        _require(not actual["changed"] and not actual["deleted"], f"{kind}: adopt modified existing content")
        repeat_before = snapshot_tree(fixture)
        repeat_py_rc, repeat_py = _run_json(
            python_transport.prefix,
            adopt_args,
            transport=python_transport.name,
            fixture=fixture,
            commands=commands,
            env=python_transport.env,
        )
        repeat_npm_rc, repeat_npm = _run_json(
            npm_transport.prefix,
            adopt_args,
            transport=npm_transport.name,
            fixture=fixture,
            commands=commands,
            env=npm_transport.env,
        )
        repeat_after = snapshot_tree(fixture)
        idempotent = (
            repeat_py_rc == repeat_npm_rc == 0
            and repeat_py == repeat_npm
            and repeat_py["mode"] == "dry-run"
            and not repeat_py["would_create"]
            and repeat_before == repeat_after
        )
        _require(idempotent, f"{kind}: repeated adopt was not idempotent")
    elif kind in {"current", "adopted"}:
        _require(not expected, f"{kind}: idempotent adopt unexpectedly planned writes")
        idempotent = True
    elif kind == "legacy":
        _require(
            expected
            == [
                "modules/agent-workspace/index.md",
                "modules/codebase/index.md",
                "modules/index.md",
            ],
            "legacy: adopt did not plan the exact indexed-layout additions",
        )
    elif kind == "corrupt":
        _require(expected == ["AGENTS.md"], "corrupt: adopt did not plan exactly the missing contract file")

    doctor_before = snapshot_tree(fixture)
    doctor_args = _create_args("doctor", fixture)
    py_doctor_rc, py_doctor = _run_json(
        python_transport.prefix,
        doctor_args,
        transport=python_transport.name,
        fixture=fixture,
        commands=commands,
        env=python_transport.env,
    )
    npm_doctor_rc, npm_doctor = _run_json(
        npm_transport.prefix,
        doctor_args,
        transport=npm_transport.name,
        fixture=fixture,
        commands=commands,
        env=npm_transport.env,
    )
    doctor_after = snapshot_tree(fixture)
    doctor_read_only = doctor_before == doctor_after
    _require(doctor_read_only, f"{kind}: Doctor mutated the fixture")
    doctor_exit_equal = py_doctor_rc == npm_doctor_rc
    doctor_payload_equal = py_doctor == npm_doctor
    _require(doctor_exit_equal, f"{kind}: npm/Python Doctor exits differ")
    _require(doctor_payload_equal, f"{kind}: npm/Python Doctor JSON differs")
    compatibility = py_doctor["compatibility"]
    expected_workspace_contract = "legacy-v0.1" if kind == "legacy" else "indexed-v0.2+"
    _require(compatibility["schema_version"] == 1, f"{kind}: Doctor compatibility schema changed")
    _require(
        compatibility["workspace_contract"] == expected_workspace_contract,
        f"{kind}: Doctor misclassified the workspace contract",
    )
    upgrade_guidance_present: bool | None = None
    if kind == "legacy":
        upgrade_guidance_present = compatibility["recommended_upgrade"] in py_doctor["warnings"]
        _require(upgrade_guidance_present, "legacy: Doctor omitted compatibility upgrade guidance")
    expected_doctor_ok = kind != "corrupt"
    _require(bool(py_doctor["ok"]) is expected_doctor_ok, f"{kind}: Doctor result was dishonest")
    _require((py_doctor_rc == 0) is expected_doctor_ok, f"{kind}: Doctor exit did not match result")

    find_before = snapshot_tree(fixture)
    find_rc, find_payload = _run_json(
        (sys.executable, str(TROPO_CLI)),
        (
            "find",
            "workspace context",
            "--root",
            str(fixture),
            "--k",
            str(FIND_LIMIT),
            "--budget",
            str(FIND_BUDGET),
            "--json",
        ),
        transport="tropo",
        fixture=fixture,
        commands=commands,
    )
    find_after = snapshot_tree(fixture)
    _require(find_rc == 0, f"{kind}: tropo find failed")
    _require(find_before == find_after, f"{kind}: tropo find mutated the fixture")
    _require(0 < len(find_payload["results"]) <= FIND_LIMIT, f"{kind}: find returned no bounded context")
    _require(find_payload["estimated_tokens"] <= FIND_BUDGET, f"{kind}: find exceeded budget")
    _require(all(result.get("type") for result in find_payload["results"]), f"{kind}: find returned untyped context")
    find_boundary_pruned = all(
        sentinel not in str(result["path"]).replace("\\", "/").split("/")
        for result in find_payload["results"]
    )
    _require(find_boundary_pruned, f"{kind}: tropo find crossed the unsafe boundary")
    fixture_root = fixture.resolve()
    find_contained = all(
        not Path(result["path"]).is_absolute()
        and (fixture / result["path"]).resolve().is_relative_to(fixture_root)
        and (fixture / result["path"]).is_file()
        for result in find_payload["results"]
    )
    _require(find_contained, f"{kind}: find resolved outside the fixture")

    git_after = _git_state(fixture) if kind == "divergent-checkout" else None
    if git_before is not None and git_after is not None:
        _require(git_before["branch"] == git_after["branch"], "divergent checkout branch changed")
        _require(git_before["head"] == git_after["head"], "divergent checkout HEAD changed")
        _require(git_before["refs_fingerprint"] == git_after["refs_fingerprint"], "divergent Git refs changed")

    return {
        "kind": kind,
        "root": "<fixture>",
        "fixture_fingerprint": initial_fingerprint,
        "unsafe_boundary_pruned": map_boundary_pruned and find_boundary_pruned,
        "commands": commands,
        "expected_mutations": expected,
        "actual_mutations": actual,
        "adopt": {
            "dry_run_read_only": dry_run_read_only,
            "applied": kind in APPLY_KINDS,
            "idempotent": idempotent,
        },
        "map": {
            "read_only": map_before == map_after,
            "total_files": map_payload["summary"]["total_files"],
            "total_dirs": map_payload["summary"]["total_dirs"],
            "directories": len(map_payload["directories"]),
            "deepest_directory": max(
                (row["depth"] for row in map_payload["directories"]),
                default=0,
            ),
            "depth_limit": MAP_DEPTH,
            "entry_limit": MAP_MAX_ENTRIES,
        },
        "parity": {
            "compared_transports": [python_transport.name, npm_transport.name],
            "adopt_dry_run_exit": adopt_exit_equal,
            "adopt_dry_run_json": adopt_payload_equal,
            "doctor_exit": doctor_exit_equal,
            "doctor_json": doctor_payload_equal,
        },
        "doctor": {
            "expected_ok": expected_doctor_ok,
            "actual_ok": bool(py_doctor["ok"]),
            "errors": len(py_doctor["errors"]),
            "warnings": len(py_doctor["warnings"]),
            "read_only": doctor_read_only,
            "compatibility_schema": compatibility["schema_version"],
            "workspace_contract": compatibility["workspace_contract"],
            "upgrade_guidance_present": upgrade_guidance_present,
        },
        "find": {
            "contained_in_fixture": find_contained,
            "results": len(find_payload["results"]),
            "types": sorted({result["type"] for result in find_payload["results"]}),
            "estimated_tokens": find_payload["estimated_tokens"],
            "budget": FIND_BUDGET,
            "read_only": find_before == find_after,
        },
        "git": {"before": git_before, "after": git_after} if git_before else None,
        "ok": True,
    }


def _assert_receipt_privacy(receipt: Mapping, temp_root: Path) -> None:
    serialized = json.dumps(receipt, sort_keys=True)
    temp_paths = {
        str(temp_root),
        str(temp_root.resolve()),
        str(temp_root).replace("\\", "/"),
        str(temp_root.resolve()).replace("\\", "/"),
    }
    for temp_path in temp_paths:
        json_escaped = json.dumps(temp_path)[1:-1]
        _require(
            temp_path not in serialized and json_escaped not in serialized,
            "receipt leaked the proof temp path",
        )


def validate_receipt(
    receipt: Mapping,
    *,
    temp_root: Path | None = None,
    strict_transports: bool = False,
) -> None:
    _require(receipt.get("schema") == PROOF_SCHEMA, "receipt schema is missing or wrong")
    fixtures = receipt.get("fixtures")
    _require(isinstance(fixtures, list) and fixtures, "receipt has no fixtures")
    if strict_transports:
        transport_names = [transport.get("name") for transport in receipt.get("transports", [])]
        _require(transport_names == ["python", "npm"], "strict proof did not use Python and npm transports")
        _require(receipt.get("versions", {}).get("uvx") != "test-override", "strict proof did not use real uvx")
    required = {
        "kind",
        "root",
        "fixture_fingerprint",
        "commands",
        "expected_mutations",
        "actual_mutations",
        "map",
        "adopt",
        "parity",
        "doctor",
        "find",
        "ok",
    }
    for fixture in fixtures:
        _require(required <= set(fixture), f"{fixture.get('kind', 'unknown')}: incomplete receipt")
        _require(fixture["root"] == "<fixture>", "receipt leaked a fixture root")
        _require(fixture["commands"], f"{fixture['kind']}: receipt omitted commands")
        if fixture["ok"] and strict_transports:
            command_transports = {command.get("transport") for command in fixture["commands"]}
            _require("python" in command_transports and "npm" in command_transports, f"{fixture['kind']}: strict receipt omitted a public transport")
        if not fixture["ok"]:
            _require(fixture.get("error"), f"{fixture['kind']}: failed fixture omitted its error")
        _require(set(fixture["actual_mutations"]) == {"created", "changed", "deleted"}, f"{fixture['kind']}: incomplete mutation receipt")
    if temp_root is not None:
        _assert_receipt_privacy(receipt, temp_root)

def _write_receipt(receipt_path: Path, receipt: Mapping) -> None:
    receipt_path = receipt_path.resolve()
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )



def run_proof(
    receipt_path: Path,
    *,
    fixture_kinds: Sequence[str] = FIXTURE_KINDS,
    transports: tuple[CreateTransport, CreateTransport] | None = None,
    strict_transports: bool | None = None,
) -> dict:
    unknown = sorted(set(fixture_kinds) - set(FIXTURE_KINDS))
    if unknown:
        raise ValueError(f"unknown fixtures: {', '.join(unknown)}")
    python_transport, npm_transport = transports or _default_transports()
    if strict_transports is None:
        strict_transports = transports is None
    receipt: dict = {
        "schema": PROOF_SCHEMA,
        "transports": [
            {"name": python_transport.name, "executable": "python"},
            {
                "name": npm_transport.name,
                "executable": "node" if npm_transport.name == "npm" else "python-test-double",
                "source": "local-create-vivary-package" if npm_transport.name == "npm" else "test-override",
            },
        ],
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "versions": {
            "python": platform.python_version(),
            "node": _version((shutil.which("node") or "node", "--version")) if transports is None else "test-override",
            "git": _version(("git", "--version")),
            "uvx": _version(("uvx", "--version")) if transports is None else "test-override",
            "create_vivary": create_vivary.__version__,
            "tropo": tropo.__version__,
        },
        "fixtures": [],
        "ok": True,
    }
    with tempfile.TemporaryDirectory(
        prefix="vivary-orientation-proof-",
        ignore_cleanup_errors=True,
    ) as raw_temp:
        temp_root = Path(raw_temp)
        for kind in fixture_kinds:
            fixture = temp_root / kind
            commands: list[dict] = [
                {"transport": "proof", "argv": ["build-fixture", kind], "exit_code": None}
            ]
            progress = {"expected_mutations": []}
            initial: dict[str, str] = {}
            phase = "construction"
            try:
                sentinel = build_fixture(kind, fixture)
                commands[0]["exit_code"] = 0
                initial = snapshot_tree(fixture)
                phase = "proof"
                result = _proof_fixture(
                    kind,
                    fixture,
                    temp_root,
                    python_transport,
                    npm_transport,
                    commands=commands,
                    initial=initial,
                    sentinel=sentinel,
                    progress=progress,
                )
            except Exception as exc:
                if commands[0]["exit_code"] is None:
                    commands[0]["exit_code"] = 1
                after = snapshot_tree(fixture) if fixture.exists() else {}
                result = {
                    "kind": kind,
                    "root": "<fixture>",
                    "fixture_fingerprint": snapshot_fingerprint(initial) if initial else None,
                    "commands": commands,
                    "expected_mutations": progress["expected_mutations"],
                    "actual_mutations": snapshot_delta(initial, after),
                    "adopt": {},
                    "map": {},
                    "parity": {},
                    "doctor": {},
                    "find": {},
                    "git": None,
                    "ok": False,
                    "phase": phase,
                    "error": _sanitize_text(f"{type(exc).__name__}: {exc}", fixture, temp_root),
                }
                receipt["ok"] = False
            receipt["fixtures"].append(result)
        try:
            _assert_receipt_privacy(receipt, temp_root)
        except ProofFailure as exc:
            print(f"orientation proof receipt privacy: {exc}", file=sys.stderr)
            safe_receipt = {
                "schema": PROOF_SCHEMA,
                "phase": "receipt-privacy",
                "ok": False,
                "error": "proof receipt privacy check failed; inspect the job log",
                "error_type": type(exc).__name__,
                "fixtures": [
                    {"kind": fixture["kind"], "ok": bool(fixture["ok"])}
                    for fixture in receipt["fixtures"]
                ],
            }
            _write_receipt(receipt_path, safe_receipt)
            return safe_receipt
        try:
            validate_receipt(receipt, strict_transports=strict_transports)
        except ProofFailure as exc:
            receipt["ok"] = False
            receipt["validation_error"] = str(exc)
        _write_receipt(receipt_path, receipt)
    return receipt


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prove issue #200's disposable orientation loop")
    parser.add_argument("--receipt", type=Path, required=True, help="write the sanitized aggregate JSON receipt here")
    parser.add_argument("--fixture", action="append", choices=FIXTURE_KINDS, dest="fixtures", help="run only this fixture (repeatable)")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        receipt = run_proof(args.receipt, fixture_kinds=tuple(args.fixtures or FIXTURE_KINDS))
    except Exception as exc:
        receipt = {
            "schema": PROOF_SCHEMA,
            "phase": "preflight",
            "ok": False,
            "error": "proof preflight failed; inspect the job log",
            "error_type": type(exc).__name__,
            "fixtures": [],
        }
        print(f"orientation proof preflight: {exc}", file=sys.stderr)
        _write_receipt(args.receipt, receipt)
    print(json.dumps({"ok": receipt["ok"], "receipt": str(args.receipt), "fixtures": [item["kind"] for item in receipt["fixtures"]]}))
    return 0 if receipt["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
