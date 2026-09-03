"""The repository-only legacy asset archive stays frozen for migration classification.

Thin-v0.3 init generates its bounded capsule directly, and public wheels or source
distributions must not ship the old full-scaffold prose, templates, placeholders,
or dual skills.
"""
import json
import sys
import tomllib
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import sync_assets  # noqa: E402

ASSETS = Path(__file__).resolve().parents[1] / "create_vivary_assets"

REPOSITORY = Path(__file__).resolve().parents[3]


def _project_version(path: Path) -> str:
    return tomllib.loads(path.read_text())["project"]["version"]


def _npm_version(path: Path) -> str:
    return json.loads(path.read_text())["version"]


def _files(root: Path):
    return sorted(p.relative_to(root) for p in root.rglob("*") if p.is_file())


def test_bundled_assets_match_canonical():
    mismatches = []
    for src, dst_name in sync_assets.SOURCES.items():
        dst = ASSETS / dst_name
        assert dst.exists(), f"missing bundled asset {dst_name} (run tools/sync_assets.py)"
        if src.is_dir():
            src_files, dst_files = _files(src), _files(dst)
            if src_files != dst_files:
                mismatches.append(f"{dst_name}: file set differs (run sync_assets.py)")
                continue
            for rel in src_files:
                if (src / rel).read_bytes() != (dst / rel).read_bytes():
                    mismatches.append(f"{dst_name}/{rel}: content drift")
        else:
            if src.read_bytes() != dst.read_bytes():
                mismatches.append(f"{dst_name}: content drift")
    assert not mismatches, "bundled assets out of sync:\n  " + "\n  ".join(mismatches)


def test_assets_cover_required_workspace_files():
    # the bundled templates must include everything scaffold_workspace maps from
    for name in ("AGENTS.md", "SOUL.md", "STATE.template.md", "USER.template.md",
                 "MEMORY.template.md", "bug-risk-playbook.md", ".gitignore"):
        assert (ASSETS / "templates" / name).exists(), f"bundled template missing: {name}"


def test_package_data_excludes_the_legacy_full_scaffold():
    pyproject = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    setuptools = pyproject["tool"]["setuptools"]
    package_data = setuptools.get("package-data", {})
    assert not package_data.get("create_vivary_assets")
    assert "create_vivary_assets" not in setuptools.get("packages", [])
    assert setuptools["py-modules"] == ["create_vivary"]
    manifest = (Path(__file__).resolve().parents[1] / "MANIFEST.in").read_text(
        encoding="utf-8"
    )
    assert manifest.splitlines() == ["prune create_vivary_assets", "prune tests"]


def test_python_and_npm_create_versions_are_lockstep():
    python_manifest = REPOSITORY / "packages" / "create-vivary" / "pyproject.toml"
    npm_manifest = REPOSITORY / "packages" / "create-vivary" / "npm" / "package.json"

    assert _project_version(python_manifest) == _npm_version(npm_manifest)


def test_unrelated_vivary_packages_keep_independent_versions():
    unrelated_versions = {
        package: _project_version(REPOSITORY / "packages" / package / "pyproject.toml")
        for package in ("core", "tropo", "strato", "ozone", "exo", "memory-cognee", "mcp", "vivary")
    }

    # The coordinated train is a label, not a repository-wide package version.
    assert len(set(unrelated_versions.values())) > 1


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
            passed += 1
        except Exception as e:
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
