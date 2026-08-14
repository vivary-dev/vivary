from __future__ import annotations

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


class ReleaseArtifactContractTests(unittest.TestCase):
    def _write_manifest(self, repository: Path, package: str, name: str, version: str) -> None:
        package_root = repository / "packages" / package
        package_root.mkdir(parents=True, exist_ok=True)
        (package_root / "pyproject.toml").write_text(
            "[project]\n"
            f'name = "{name}"\n'
            f'version = "{version}"\n',
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

        candidates = (
            ("create-vivary", "create-vivary", "0.4.2"),
            ("mcp", "vivary-mcp", "0.1.3"),
            ("vivary", "vivary", "0.1.10"),
        )
        for package, distribution, version in candidates:
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

    def test_complete_release_artifact_set_passes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            repository, artifacts = self._complete_fixture(Path(raw_root))
            result = self._run_checker(repository, artifacts)

        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("7 release artifacts passed license verification", result.stdout)

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


if __name__ == "__main__":
    unittest.main()
