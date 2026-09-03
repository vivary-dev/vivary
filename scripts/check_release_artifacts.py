from __future__ import annotations

import argparse
import json
import tarfile
import tomllib
import zipfile
from pathlib import Path


# Every Python distribution the release publishes, in dependency order.
PYTHON_CANDIDATES = (
    ("core", "vivary-core"),
    ("tropo", "vivary-tropo"),
    ("strato", "vivary-strato"),
    ("ozone", "vivary-ozone"),
    ("exo", "vivary-exo"),
    ("create-vivary", "create-vivary"),
    ("memory-cognee", "vivary-memory-cognee"),
    ("mcp", "vivary-mcp"),
    ("vivary", "vivary"),
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def read_manifest(repository: Path, package: str) -> dict:
    manifest = repository / "packages" / package / "pyproject.toml"
    return tomllib.loads(manifest.read_text(encoding="utf-8"))


def project_version(repository: Path, package: str, distribution: str) -> str:
    manifest = repository / "packages" / package / "pyproject.toml"
    project = read_manifest(repository, package)["project"]
    require(project["name"] == distribution, f"{manifest}: expected project name {distribution}")
    return project["version"]


def declared_payload(repository: Path, package: str) -> tuple[list[str], list[str]]:
    """Read the modules and packages the manifest allows an artifact to carry."""
    setuptools = read_manifest(repository, package).get("tool", {}).get("setuptools", {})
    return setuptools.get("py-modules", []), setuptools.get("packages", [])


def require_wheel_inventory(
    wheel: Path, names: list[str], dist_info: str, package: str,
    py_modules: list[str], packages: list[str],
) -> None:
    """Hold a wheel to the module allowlist its manifest declares."""
    payload = sorted(name for name in names if not name.startswith(dist_info))
    require(
        bool(payload), f"{wheel}: wheel carries no module beside its metadata"
    )
    if py_modules:
        expected = sorted(f"{module}.py" for module in py_modules)
        require(
            payload == expected,
            f"{wheel}: wheel carries {payload}, not the declared {expected}",
        )
        return
    require(
        bool(packages),
        f"packages/{package}/pyproject.toml: declares no py-modules or packages",
    )
    strays = [
        name
        for name in payload
        if not any(name.startswith(f"{declared}/") for declared in packages)
    ]
    require(not strays, f"{wheel}: wheel carries {strays} outside {packages}")


def require_sdist_inventory(sdist: Path, names: list[str], root: str) -> None:
    """Keep the test suite out of the archive a user downloads and builds."""
    tests = [
        name for name in names
        if name == f"{root}tests" or name.startswith(f"{root}tests/")
    ]
    require(not tests, f"{sdist}: sdist carries the test directory {tests[:1]}")


def verify_python_artifacts(
    repository: Path,
    artifacts: Path,
    license_bytes: bytes,
) -> int:
    verified = 0
    for package, distribution in PYTHON_CANDIDATES:
        version = project_version(repository, package, distribution)
        normalized = distribution.replace("-", "_")
        wheel = artifacts / f"{normalized}-{version}-py3-none-any.whl"
        sdist = artifacts / f"{normalized}-{version}.tar.gz"
        require(wheel.is_file(), f"missing release artifact: {wheel}")
        require(sdist.is_file(), f"missing release artifact: {sdist}")

        py_modules, packages = declared_payload(repository, package)
        dist_info = f"{normalized}-{version}.dist-info/"
        wheel_license = f"{dist_info}licenses/LICENSE"
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
            require(wheel_license in names, f"{wheel}: missing {wheel_license}")
            require(
                archive.read(wheel_license) == license_bytes,
                f"{wheel}: packaged LICENSE does not match repository LICENSE",
            )
            require(
                f"{dist_info}METADATA" in names, f"{wheel}: missing {dist_info}METADATA"
            )
            require_wheel_inventory(
                wheel, names, dist_info, package, py_modules, packages
            )

        root = f"{normalized}-{version}/"
        sdist_license = f"{root}LICENSE"
        with tarfile.open(sdist, "r:gz") as archive:
            names = archive.getnames()
            member = archive.getmember(sdist_license) if sdist_license in names else None
            require(member is not None, f"{sdist}: missing {sdist_license}")
            stream = archive.extractfile(member)
            require(stream is not None, f"{sdist}: cannot read {sdist_license}")
            require(
                stream.read() == license_bytes,
                f"{sdist}: packaged LICENSE does not match repository LICENSE",
            )
            require_sdist_inventory(sdist, names, root)
        verified += 2
    return verified


def verify_npm_artifact(repository: Path, artifacts: Path, license_bytes: bytes) -> int:
    manifest = repository / "packages" / "create-vivary" / "npm" / "package.json"
    package = json.loads(manifest.read_text(encoding="utf-8"))
    require(package["name"] == "@vivary/create", f"{manifest}: expected package name @vivary/create")
    version = package["version"]
    archive_path = artifacts / f"vivary-create-{version}.tgz"
    require(archive_path.is_file(), f"missing release artifact: {archive_path}")
    with tarfile.open(archive_path, "r:gz") as archive:
        names = archive.getnames()
        require("package/LICENSE" in names, f"{archive_path}: missing package/LICENSE")
        license_stream = archive.extractfile("package/LICENSE")
        require(license_stream is not None, f"{archive_path}: cannot read package/LICENSE")
        require(
            license_stream.read() == license_bytes,
            f"{archive_path}: packaged LICENSE does not match repository LICENSE",
        )
        require("package/package.json" in names, f"{archive_path}: missing package/package.json")
        manifest_stream = archive.extractfile("package/package.json")
        require(manifest_stream is not None, f"{archive_path}: cannot read package/package.json")
        packed = json.load(manifest_stream)
        require(packed.get("name") == package["name"], f"{archive_path}: package name mismatch")
        require(packed.get("version") == version, f"{archive_path}: package version mismatch")
    return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify license inclusion in release artifacts.")
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--scope", choices=("all", "npm"), default="all")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repository = args.repository.resolve()
    artifacts = args.artifacts.resolve()
    license_path = repository / "LICENSE"
    require(license_path.is_file(), f"missing repository license: {license_path}")
    require(artifacts.is_dir(), f"missing artifact directory: {artifacts}")
    license_bytes = license_path.read_bytes()

    verified = 0
    if args.scope == "all":
        verified += verify_python_artifacts(repository, artifacts, license_bytes)
    verified += verify_npm_artifact(repository, artifacts, license_bytes)
    print(f"{verified} release artifacts passed license verification")


if __name__ == "__main__":
    main()
