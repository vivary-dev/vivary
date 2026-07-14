"""The bundled create_vivary_assets/ must stay byte-identical to their canonical
sources. If this fails, run `python packages/create-vivary/tools/sync_assets.py`."""
import sys
import tomllib
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import sync_assets  # noqa: E402

ASSETS = Path(__file__).resolve().parents[1] / "create_vivary_assets"


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


def test_package_data_includes_template_gitignore():
    pyproject = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    package_data = pyproject["tool"]["setuptools"]["package-data"]["create_vivary_assets"]
    assert "templates/.gitignore" in package_data


def test_package_data_includes_grug_metadata():
    pyproject = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    package_data = pyproject["tool"]["setuptools"]["package-data"]["create_vivary_assets"]
    assert "grug-skill/agents/openai.yaml" in package_data


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
