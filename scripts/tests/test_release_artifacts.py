from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[2]
CHECKER = REPOSITORY / "scripts" / "check_release_artifacts.py"
LICENSE_BYTES = b"MIT fixture license\n"


def load_checker():
    spec = importlib.util.spec_from_file_location("release_artifacts", CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PYTHON_CANDIDATES = load_checker().PYTHON_CANDIDATES


def fixture_module(distribution: str) -> str:
    """One module name per fixture distribution, independent of the real layout."""
    return distribution.replace("-", "_")

# One fixture version per candidate, independent of the real manifests.
FIXTURE_VERSIONS = {
    "vivary-core": "0.2.0",
    "vivary-tropo": "0.5.0",
    "vivary-strato": "0.1.0",
    "vivary-ozone": "0.3.0",
    "vivary-exo": "0.3.0",
    "create-vivary": "0.4.2",
    "vivary-memory-cognee": "0.1.0",
    "vivary-mcp": "0.1.3",
    "vivary": "0.1.10",
}


class ReleaseArtifactContractTests(unittest.TestCase):
    def _write_manifest(self, repository: Path, package: str, name: str, version: str) -> None:
        package_root = repository / "packages" / package
        package_root.mkdir(parents=True, exist_ok=True)
        (package_root / "pyproject.toml").write_text(
            "[project]\n"
            f'name = "{name}"\n'
            f'version = "{version}"\n'
            "\n"
            "[tool.setuptools]\n"
            f'py-modules = ["{fixture_module(name)}"]\n',
            encoding="utf-8",
        )

    def _write_python_artifacts(
        self,
        artifacts: Path,
        distribution: str,
        version: str,
    ) -> None:
        normalized = distribution.replace("-", "_")
        wheel = artifacts / f"{normalized}-{version}-py3-none-any.whl"
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr(f"{fixture_module(distribution)}.py", "")
            archive.writestr(
                f"{normalized}-{version}.dist-info/licenses/LICENSE",
                LICENSE_BYTES,
            )
            archive.writestr(f"{normalized}-{version}.dist-info/METADATA", "")

        sdist = artifacts / f"{normalized}-{version}.tar.gz"
        with tarfile.open(sdist, "w:gz") as archive:
            info = tarfile.TarInfo(f"{normalized}-{version}/LICENSE")
            info.size = len(LICENSE_BYTES)
            archive.addfile(info, io.BytesIO(LICENSE_BYTES))

    def _write_npm_artifact(self, artifacts: Path, version: str) -> None:
        package_json = json.dumps({"name": "@vivary/create", "version": version}).encode()
        archive_path = artifacts / f"vivary-create-{version}.tgz"
        with tarfile.open(archive_path, "w:gz") as archive:
            for name, content in (
                ("package/LICENSE", LICENSE_BYTES),
                ("package/package.json", package_json),
            ):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))

    def _complete_fixture(self, root: Path) -> tuple[Path, Path]:
        repository = root / "repository"
        artifacts = root / "artifacts"
        artifacts.mkdir(parents=True)
        (repository / "LICENSE").parent.mkdir(parents=True)
        (repository / "LICENSE").write_bytes(LICENSE_BYTES)

        for package, distribution in PYTHON_CANDIDATES:
            version = FIXTURE_VERSIONS[distribution]
            self._write_manifest(repository, package, distribution, version)
            self._write_python_artifacts(artifacts, distribution, version)

        npm_root = repository / "packages" / "create-vivary" / "npm"
        npm_root.mkdir(parents=True)
        (npm_root / "package.json").write_text(
            json.dumps({"name": "@vivary/create", "version": "0.4.2"}),
            encoding="utf-8",
        )
        self._write_npm_artifact(artifacts, "0.4.2")
        return repository, artifacts

    def _run_checker(
        self,
        repository: Path,
        artifacts: Path,
        *,
        scope: str = "all",
    ) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(CHECKER),
            "--repository",
            str(repository),
            "--artifacts",
            str(artifacts),
        ]
        if scope != "all":
            command.extend(("--scope", scope))
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_every_published_python_package_is_a_candidate(self) -> None:
        published = {
            manifest.parent.name
            for manifest in (REPOSITORY / "packages").glob("*/pyproject.toml")
        }
        self.assertEqual({package for package, _ in PYTHON_CANDIDATES}, published)
        self.assertEqual(set(FIXTURE_VERSIONS), {name for _, name in PYTHON_CANDIDATES})

    def test_complete_release_artifact_set_passes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            result = self._run_checker(repository, artifacts)

        expected = 2 * len(PYTHON_CANDIDATES) + 1
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn(
            f"{expected} release artifacts passed license verification", result.stdout
        )

    def test_npm_scope_passes_without_python_archives(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            for artifact in artifacts.iterdir():
                if artifact.name != "vivary-create-0.4.2.tgz":
                    artifact.unlink()
            result = self._run_checker(repository, artifacts, scope="npm")

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("1 release artifacts passed license verification", result.stdout)

    def test_missing_license_entry_fails_with_artifact_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            wheel = artifacts / "vivary_mcp-0.1.3-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("vivary_mcp-0.1.3.dist-info/METADATA", "")
            result = self._run_checker(repository, artifacts)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(wheel), result.stderr)
        self.assertIn("missing vivary_mcp-0.1.3.dist-info/licenses/LICENSE", result.stderr)

    def test_wrong_license_bytes_fail(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            sdist = artifacts / "vivary-0.1.10.tar.gz"
            with tarfile.open(sdist, "w:gz") as archive:
                content = b"not the repository license\n"
                info = tarfile.TarInfo("vivary-0.1.10/LICENSE")
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            result = self._run_checker(repository, artifacts)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"{sdist}: packaged LICENSE does not match", result.stderr)

    def test_missing_expected_artifact_fails(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            missing = artifacts / "create_vivary-0.4.2.tar.gz"
            missing.unlink()
            result = self._run_checker(repository, artifacts)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"missing release artifact: {missing}", result.stderr)

    def test_npm_manifest_mismatch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            tgz = artifacts / "vivary-create-0.4.2.tgz"
            package_json = json.dumps({"name": "@vivary/wrong", "version": "0.4.2"}).encode()
            with tarfile.open(tgz, "w:gz") as archive:
                for name, content in (
                    ("package/LICENSE", LICENSE_BYTES),
                    ("package/package.json", package_json),
                ):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
            result = self._run_checker(repository, artifacts)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"{tgz}: package name mismatch", result.stderr)

    def test_npm_scope_rejects_a_tarball_without_license(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            tgz = artifacts / "vivary-create-0.4.2.tgz"
            package_json = json.dumps({"name": "@vivary/create", "version": "0.4.2"}).encode()
            with tarfile.open(tgz, "w:gz") as archive:
                info = tarfile.TarInfo("package/package.json")
                info.size = len(package_json)
                archive.addfile(info, io.BytesIO(package_json))
            result = self._run_checker(repository, artifacts, scope="npm")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"{tgz}: missing package/LICENSE", result.stderr)


    def test_a_wheel_that_carries_more_than_its_module_fails(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            wheel = artifacts / "vivary_tropo-0.5.0-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "a") as archive:
                archive.writestr("tests/test_tropo.py", "")
            result = self._run_checker(repository, artifacts)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"{wheel}: wheel carries", result.stderr)
        self.assertIn("tests/test_tropo.py", result.stderr)

    def test_a_wheel_without_its_declared_module_fails(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            wheel = artifacts / "vivary_exo-0.3.0-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr(
                    "vivary_exo-0.3.0.dist-info/licenses/LICENSE", LICENSE_BYTES
                )
                archive.writestr("vivary_exo-0.3.0.dist-info/METADATA", "")
            result = self._run_checker(repository, artifacts)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("carries no module beside its metadata", result.stderr)

    def test_a_wheel_missing_its_metadata_fails(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            wheel = artifacts / "vivary-0.1.10-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("vivary.py", "")
                archive.writestr("vivary-0.1.10.dist-info/licenses/LICENSE", LICENSE_BYTES)
            result = self._run_checker(repository, artifacts)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing vivary-0.1.10.dist-info/METADATA", result.stderr)

    def test_an_sdist_that_ships_tests_fails(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            sdist = artifacts / "vivary_strato-0.1.0.tar.gz"
            with tarfile.open(sdist, "w:gz") as archive:
                for name, content in (
                    ("vivary_strato-0.1.0/LICENSE", LICENSE_BYTES),
                    ("vivary_strato-0.1.0/tests/test_strato.py", b""),
                ):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
            result = self._run_checker(repository, artifacts)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"{sdist}: sdist carries the test directory", result.stderr)

    def test_a_package_wheel_is_held_to_its_declared_packages(self) -> None:
        module = load_checker()
        wheel = Path("vivary_core-0.2.7-py3-none-any.whl")
        names = [
            "vivary_core/__init__.py",
            "vivary_core-0.2.7.dist-info/METADATA",
        ]
        module.require_wheel_inventory(
            wheel, names, "vivary_core-0.2.7.dist-info/", "core", [], ["vivary_core"]
        )
        with self.assertRaises(SystemExit) as raised:
            module.require_wheel_inventory(
                wheel,
                [*names, "tests/test_core.py"],
                "vivary_core-0.2.7.dist-info/",
                "core",
                [],
                ["vivary_core"],
            )
        self.assertIn("outside ['vivary_core']", str(raised.exception))

    def test_every_real_manifest_declares_an_artifact_allowlist(self) -> None:
        module = load_checker()
        for package, _ in PYTHON_CANDIDATES:
            with self.subTest(package=package):
                py_modules, packages = module.declared_payload(REPOSITORY, package)
                self.assertTrue(py_modules or packages)


if __name__ == "__main__":
    unittest.main()
