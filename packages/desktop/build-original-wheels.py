#!/usr/bin/env python3
"""Assemble the owned Python packages without adding a runtime installer."""

from __future__ import annotations

import argparse
import base64
import csv
import email.parser
import hashlib
import os
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import subprocess
import sys
import tarfile
import tempfile
import venv
import zipfile


WINDOWS_DISTLIB_VERSION = "0.4.2"
WINDOWS_CONSOLE_LAUNCHER_SIZE = 108_032
WINDOWS_CONSOLE_LAUNCHER_SHA256 = "81a618f21cb87db9076134e70388b6e9cb7c2106739011b6a51772d22cae06b7"
WINDOWS_DISTLIB_LICENSE_SIZE = 14_531
WINDOWS_DISTLIB_LICENSE_SHA256 = "808e10c8a6ab8deb149ff9b3fb19f447a808094606d712a9ca57fead3552599d"
BUILD_BACKEND_WHEELS = (
    ("pip", "26.2.2", "pip-26.2.2-py3-none-any.whl"),
    ("setuptools", "84.1.0", "setuptools-84.1.0-py3-none-any.whl"),
)
BUILD_BACKEND_SHA256 = {
    "pip-26.2.2-py3-none-any.whl": "fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70",
    "setuptools-84.1.0-py3-none-any.whl": "5231689c6ac8156cd155cfb98c3fd6fb252c3e7e9bd3d78b64d3c55f132624c9",
}

COMPONENTS = (
    ("vivary", "vivary", "0.2.1", "vivary-0.2.1-py3-none-any.whl"),
    ("create-vivary", "create-vivary", "0.4.4", "create_vivary-0.4.4-py3-none-any.whl"),
    ("core", "vivary-core", "0.2.7", "vivary_core-0.2.7-py3-none-any.whl"),
    ("tropo", "vivary-tropo", "0.5.5", "vivary_tropo-0.5.5-py3-none-any.whl"),
    ("strato", "vivary-strato", "0.1.3", "vivary_strato-0.1.3-py3-none-any.whl"),
    ("ozone", "vivary-ozone", "0.3.2", "vivary_ozone-0.3.2-py3-none-any.whl"),
    ("exo", "vivary-exo", "0.3.1", "vivary_exo-0.3.1-py3-none-any.whl"),
)

ENTRY_POINTS = (
    ("vivary-0.2.1-py3-none-any.whl", "vivary", "vivary_cli", "main"),
    ("create_vivary-0.4.4-py3-none-any.whl", "create-vivary", "create_vivary", "main"),
    ("vivary_tropo-0.5.5-py3-none-any.whl", "tropo", "tropo", "main"),
    ("vivary_strato-0.1.3-py3-none-any.whl", "strato", "strato", "main"),
    ("vivary_ozone-0.3.2-py3-none-any.whl", "ozone", "ozone", "main"),
    ("vivary_exo-0.3.1-py3-none-any.whl", "exo", "exo", "main"),
)


def _archive_path(name: str, *, windows_target: bool) -> tuple[str, ...]:
    if not name or "\\" in name or "\0" in name:
        raise ValueError("unsafe archive member: " + repr(name))
    archive_path = PurePosixPath(name)
    if archive_path.is_absolute() or ".." in archive_path.parts:
        raise ValueError("unsafe archive member: " + repr(name))
    parts = tuple(part for part in archive_path.parts if part not in ("", "."))
    if not parts or parts[0] != "python":
        raise ValueError("archive member is outside python/: " + repr(name))
    if windows_target and any(":" in part for part in parts):
        raise ValueError("unsafe Windows archive member: " + repr(name))
    return parts


def _link_target(member: tarfile.TarInfo, *, windows_target: bool) -> tuple[str, ...]:
    link = member.linkname
    if not link or "\\" in link or "\0" in link or PurePosixPath(link).is_absolute():
        raise ValueError("unsafe archive link target: " + repr(link))
    base = posixpath.dirname(member.name) if member.issym() else ""
    normalized = posixpath.normpath(posixpath.join(base, link))
    return _archive_path(normalized, windows_target=windows_target)


def _include_runtime_member(parts: tuple[str, ...]) -> bool:
    if "__pycache__" in parts or parts[-1].endswith(".pyc"):
        return False
    try:
        site_packages = parts.index("site-packages")
    except ValueError:
        return True
    if site_packages + 1 >= len(parts):
        return True
    package = parts[site_packages + 1]
    return package != "pip" and not (
        package.startswith("pip-") and package.endswith(".dist-info")
    )


def extract_runtime(archive_path: Path, destination: Path, platform: str) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError("runtime extraction destination must be empty")
    root = destination.resolve()
    windows_target = platform == "win32"

    with tarfile.open(archive_path, "r:*") as archive:
        members: list[tuple[tarfile.TarInfo, tuple[str, ...]]] = []
        member_names: set[tuple[str, ...]] = set()
        folded_names: set[tuple[str, ...]] = set()
        for member in archive.getmembers():
            parts = _archive_path(member.name, windows_target=windows_target)
            if not _include_runtime_member(parts):
                continue
            if parts in member_names:
                raise ValueError("duplicate archive member: " + repr(member.name))
            member_names.add(parts)
            if windows_target:
                folded = tuple(part.casefold() for part in parts)
                if folded in folded_names:
                    raise ValueError("case-colliding Windows archive member: " + repr(member.name))
                folded_names.add(folded)
            if not (member.isdir() or member.isreg() or member.issym() or member.islnk()):
                raise ValueError("unsupported archive member type: " + repr(member.name))
            members.append((member, parts))

        for member, _parts in members:
            if member.issym() or member.islnk():
                target = _link_target(member, windows_target=windows_target)
                if target not in member_names:
                    raise ValueError("archive link target is missing: " + repr(member.linkname))

        for member, parts in members:
            if member.isdir():
                root.joinpath(*parts).mkdir(parents=True, exist_ok=True)
        for member, parts in members:
            if not member.isreg():
                continue
            target = root.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("archive file has no payload: " + repr(member.name))
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(member.mode & 0o777)
        for member, parts in members:
            target = root.joinpath(*parts)
            if member.issym():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
            elif member.islnk():
                link_target = root.joinpath(*_link_target(member, windows_target=windows_target))
                target.parent.mkdir(parents=True, exist_ok=True)
                os.link(link_target, target)
        for member, parts in sorted(members, key=lambda value: len(value[1]), reverse=True):
            if member.isdir():
                root.joinpath(*parts).chmod(member.mode & 0o777)


def _wheel_identity(wheel_path: Path) -> tuple[str, str]:
    with zipfile.ZipFile(wheel_path) as archive:
        names = archive.namelist()
        metadata_files = [
            name
            for name in names
            if name.count("/") == 1 and name.endswith(".dist-info/METADATA")
        ]
        wheel_files = [
            name
            for name in names
            if name.count("/") == 1 and name.endswith(".dist-info/WHEEL")
        ]
        if len(metadata_files) != 1 or len(wheel_files) != 1:
            raise ValueError("wheel metadata is incomplete: " + wheel_path.name)
        metadata = email.parser.BytesParser().parsebytes(archive.read(metadata_files[0]))
        wheel = email.parser.BytesParser().parsebytes(archive.read(wheel_files[0]))
        if wheel.get("Root-Is-Purelib", "").lower() != "true":
            raise ValueError("component wheel is not pure Python: " + wheel_path.name)
        if "py3-none-any" not in wheel.get_all("Tag", []):
            raise ValueError("component wheel is not portable: " + wheel_path.name)
        return metadata["Name"], metadata["Version"]


def _validated_build_backend_wheels(wheel_paths: list[Path]) -> list[Path]:
    by_name = {wheel.name: wheel for wheel in wheel_paths}
    expected_names = {wheel_name for _, _, wheel_name in BUILD_BACKEND_WHEELS}
    if len(by_name) != len(wheel_paths) or set(by_name) != expected_names:
        raise ValueError(
            "build backend wheels must be exactly " + repr(sorted(expected_names))
        )
    ordered = []
    for distribution, version, wheel_name in BUILD_BACKEND_WHEELS:
        wheel = by_name[wheel_name]
        if not wheel.is_file():
            raise ValueError("build backend wheel is missing: " + str(wheel))
        identity = _wheel_identity(wheel)
        normalized_name = identity[0].replace("_", "-").lower()
        if (normalized_name, identity[1]) != (distribution, version):
            raise ValueError(
                "unexpected build backend identity for "
                + wheel_name
                + ": "
                + repr(identity)
            )
        if hashlib.sha256(wheel.read_bytes()).hexdigest() != BUILD_BACKEND_SHA256[wheel_name]:
            raise ValueError("build backend wheel hash does not match the authenticated input: " + wheel_name)
        ordered.append(wheel)
    return ordered


def _venv_python(environment: Path) -> Path:
    if os.name == "nt":
        return environment / "Scripts" / "python.exe"
    return environment / "bin" / "python"


def _validate_component_wheels(wheelhouse: Path) -> None:
    expected = {wheel for *_, wheel in COMPONENTS}
    actual = {wheel.name for wheel in wheelhouse.glob("*.whl")}
    if actual != expected:
        raise ValueError(
            "wheel build produced "
            + repr(sorted(actual))
            + ", expected "
            + repr(sorted(expected))
        )
    for _, distribution, version, wheel_name in COMPONENTS:
        identity = _wheel_identity(wheelhouse / wheel_name)
        normalized_name = identity[0].replace("_", "-").lower()
        if (normalized_name, identity[1]) != (distribution.lower(), version):
            raise ValueError(
                "unexpected wheel identity for "
                + wheel_name
                + ": "
                + repr(identity)
            )


def _build_subprocess_environment() -> dict[str, str]:
    return {
        **{key: value for key, value in os.environ.items()
           if not key.startswith(("PIP_", "PYTHON"))},
        "PIP_CONFIG_FILE": os.devnull,
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PIP_NO_INDEX": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def build_wheels(
    repository: Path,
    wheelhouse: Path,
    build_backend_wheels: list[Path],
    runtime_root: Path,
    site_packages: Path,
    platform: str,
) -> None:
    wheelhouse.mkdir(parents=True, exist_ok=True)
    if any(wheelhouse.iterdir()):
        raise ValueError("wheel build destination must be empty")
    source_paths = [repository / "packages" / source for source, *_ in COMPONENTS]
    for source in source_paths:
        if not (source / "pyproject.toml").is_file():
            raise ValueError("component source is missing: " + str(source))

    backend_wheels = _validated_build_backend_wheels(build_backend_wheels)
    environment = _build_subprocess_environment()
    with tempfile.TemporaryDirectory(
        prefix="build-backend-",
        dir=wheelhouse.parent,
    ) as temporary:
        build_environment = Path(temporary)
        # Never execute an older ensurepip seed from the host. Bootstrap exclusively
        # from the authenticated pip wheel, with no site or user configuration imports.
        builder = venv.EnvBuilder(with_pip=False, symlinks=os.name != "nt")
        builder.create(build_environment)
        build_python = _venv_python(build_environment)
        for backend_wheel in backend_wheels:
            subprocess.run(
                [
                    str(build_python),
                    "-I",
                    "-B",
                    "-c",
                    "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
                    "runpy.run_module('pip',run_name='__main__',alter_sys=True)",
                    str(backend_wheels[0]),
                    "--isolated",
                    "install",
                    "--no-cache-dir",
                    "--no-deps",
                    "--no-index",
                    "--force-reinstall",
                    str(backend_wheel),
                ],
                env=environment,
                check=True,
            )
        subprocess.run(
            [
                str(build_python),
                "-I",
                "-B",
                "-c",
                (
                    "import importlib.metadata as metadata;"
                    "import pip._vendor.distlib as distlib;"
                    "assert metadata.version('pip') == '26.2.2';"
                    "assert metadata.version('setuptools') == '84.1.0';"
                    "assert distlib.__version__ == '0.4.2'"
                ),
            ],
            env=environment,
            check=True,
        )
        subprocess.run(
            [
                str(build_python),
                "-I",
                "-B",
                "-m",
                "pip",
                "--isolated",
                "wheel",
                "--no-cache-dir",
                "--no-deps",
                "--no-build-isolation",
                "--no-index",
                "--wheel-dir",
                str(wheelhouse),
                *(str(source) for source in source_paths),
            ],
            cwd=repository,
            env=environment,
            check=True,
        )
        _validate_component_wheels(wheelhouse)

        helper = Path(__file__).resolve()
        subprocess.run(
            [
                str(build_python),
                "-I",
                "-B",
                str(helper),
                "install-wheels",
                "--wheelhouse",
                str(wheelhouse),
                "--site-packages",
                str(site_packages),
            ],
            env=environment,
            check=True,
        )
        subprocess.run(
            [
                str(build_python),
                "-I",
                "-B",
                str(helper),
                "write-launchers",
                "--runtime-root",
                str(runtime_root),
                "--site-packages",
                str(site_packages),
                "--platform",
                platform,
            ],
            env=environment,
            check=True,
        )

def install_wheels(wheelhouse: Path, site_packages: Path) -> None:
    site_packages.mkdir(parents=True, exist_ok=True)
    wheel_paths = [wheelhouse / wheel for *_, wheel in COMPONENTS]
    for wheel in wheel_paths:
        if not wheel.is_file():
            raise ValueError("component wheel is missing: " + wheel.name)
    environment = _build_subprocess_environment()
    subprocess.run(
        [
            sys.executable,
            "-I",
            "-B",
            "-m",
            "pip",
            "--isolated",
            "install",
            "--no-deps",
            "--no-index",
            "--no-compile",
            "--no-warn-script-location",
            "--target",
            str(site_packages),
            *(str(wheel) for wheel in wheel_paths),
        ],
        env=environment,
        check=True,
    )
    shutil.rmtree(site_packages / "bin", ignore_errors=True)
    for direct_url in site_packages.glob("*.dist-info/direct_url.json"):
        direct_url.unlink()


def _dist_info_path(site_packages: Path, wheel_name: str) -> Path:
    suffix = "-py3-none-any.whl"
    if not wheel_name.endswith(suffix):
        raise ValueError("unsupported component wheel name: " + wheel_name)
    return site_packages / (wheel_name.removesuffix(suffix) + ".dist-info")


def _launcher_record_row(launcher: Path, site_packages: Path) -> list[str]:
    data = launcher.read_bytes()
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
    relative = os.path.relpath(launcher, site_packages).replace(os.sep, "/")
    return [relative, "sha256=" + digest, str(len(data))]


def _remove_direct_url_records(site_packages: Path) -> None:
    for dist_info in site_packages.glob("*.dist-info"):
        record = dist_info / "RECORD"
        if not record.is_file():
            raise ValueError("component RECORD is missing: " + str(record))
        relative = dist_info.name + "/direct_url.json"
        with record.open("r", encoding="utf-8", newline="") as source:
            rows = list(csv.reader(source))
        if any(len(row) != 3 for row in rows):
            raise ValueError("component RECORD is malformed: " + str(record))
        with record.open("w", encoding="utf-8", newline="") as output:
            csv.writer(output, lineterminator="\n").writerows(
                row for row in rows if row[0] != relative
            )
        (dist_info / "direct_url.json").unlink(missing_ok=True)


def _record_launcher(site_packages: Path, wheel_name: str, script: str, launcher: Path) -> None:
    record = _dist_info_path(site_packages, wheel_name) / "RECORD"
    with record.open("r", encoding="utf-8", newline="") as source:
        rows = list(csv.reader(source))
    if any(len(row) != 3 for row in rows):
        raise ValueError("component RECORD is malformed: " + str(record))
    launcher_names = {script.casefold(), (script + ".exe").casefold()}
    direct_url = _dist_info_path(site_packages, wheel_name).name + "/direct_url.json"
    rows = [
        row for row in rows
        if PurePosixPath(row[0]).name.casefold() not in launcher_names and row[0] != direct_url
    ]
    rows.append(_launcher_record_row(launcher, site_packages))
    with record.open("w", encoding="utf-8", newline="") as output:
        csv.writer(output, lineterminator="\n").writerows(rows)


def _write_linux_launcher(scripts: Path, script: str, module: str, callable_name: str) -> Path:
    launcher = scripts / script
    python_code = (
        "import sys;from " + module + " import " + callable_name + ";"
        "sys.argv[0]=\"" + script + "\";sys.exit(" + callable_name + "())"
    )
    launcher.write_text(
        "#!/bin/sh\nset -eu\n"
        "SCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n"
        "exec \"$SCRIPT_DIR/python3\" -I -X utf8 -B -c '" + python_code + "' \"$@\"\n",
        encoding="utf-8",
    )
    launcher.chmod(0o755)
    return launcher


def _write_windows_launcher(
    scripts: Path,
    script: str,
    module: str,
    callable_name: str,
) -> Path:
    from pip._vendor import distlib
    from pip._vendor.distlib.scripts import ScriptMaker

    if distlib.__version__ != WINDOWS_DISTLIB_VERSION:
        raise ValueError("Windows launchers require pip-vendored distlib " + WINDOWS_DISTLIB_VERSION)
    stub = Path(distlib.__file__).resolve().parent / "t64.exe"
    if not stub.is_file():
        raise ValueError("The pinned distlib Windows console launcher is unavailable.")
    stub_bytes = stub.read_bytes()
    if (len(stub_bytes) != WINDOWS_CONSOLE_LAUNCHER_SIZE
            or hashlib.sha256(stub_bytes).hexdigest() != WINDOWS_CONSOLE_LAUNCHER_SHA256):
        raise ValueError("The pinned distlib Windows console launcher is unavailable.")

    class CrossTargetWindowsScriptMaker(ScriptMaker):
        def _get_launcher(self, kind: str) -> bytes:
            if kind != "t":
                raise ValueError("Only console launchers are supported.")
            return stub_bytes

    maker = CrossTargetWindowsScriptMaker(None, str(scripts), add_launchers=True)
    maker._is_nt = True
    maker.set_mode = False
    maker.variants = {""}
    maker.executable = r"<launcher_dir>\..\python.exe"
    created = maker.make(
        script + " = " + module + ":" + callable_name,
        {"interpreter_args": ["-I", "-X", "utf8", "-B"]},
    )
    launcher = scripts / (script + ".exe")
    if [Path(item) for item in created] != [launcher]:
        raise ValueError("distlib produced an unexpected Windows launcher path.")
    expected_shebang = b"#!<launcher_dir>\\..\\python.exe -I -X utf8 -B\n"
    if expected_shebang not in launcher.read_bytes():
        raise ValueError("distlib produced a non-relocatable Windows launcher.")
    return launcher


def _stage_distlib_license(runtime_root: Path) -> Path:
    from pip._vendor import distlib

    if distlib.__version__ != WINDOWS_DISTLIB_VERSION:
        raise ValueError("Windows launchers require pip-vendored distlib " + WINDOWS_DISTLIB_VERSION)
    source = Path(distlib.__file__).resolve().parent / "LICENSE.txt"
    if not source.is_file():
        raise ValueError("The pinned distlib license is unavailable.")
    license_bytes = source.read_bytes()
    if (len(license_bytes) != WINDOWS_DISTLIB_LICENSE_SIZE
            or hashlib.sha256(license_bytes).hexdigest() != WINDOWS_DISTLIB_LICENSE_SHA256):
        raise ValueError("The pinned distlib license is unavailable.")
    destination = runtime_root / "licenses" / "LICENSE.distlib"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(license_bytes)
    return destination


def write_component_launchers(runtime_root: Path, site_packages: Path, platform: str) -> None:
    if platform == "win32":
        scripts = runtime_root / "python" / "Scripts"
        interpreter = runtime_root / "python" / "python.exe"
    else:
        scripts = runtime_root / "python" / "bin"
        interpreter = scripts / "python3"
    if not interpreter.exists():
        raise ValueError("bundled Python interpreter is missing: " + str(interpreter))
    scripts.mkdir(parents=True, exist_ok=True)
    _remove_direct_url_records(site_packages)
    if platform == "win32":
        _stage_distlib_license(runtime_root)

    for wheel_name, script, module, callable_name in ENTRY_POINTS:
        if platform == "win32":
            launcher = _write_windows_launcher(scripts, script, module, callable_name)
        else:
            launcher = _write_linux_launcher(scripts, script, module, callable_name)
        _record_launcher(site_packages, wheel_name, script, launcher)


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)

    extract = commands.add_parser("extract-runtime")
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--destination", type=Path, required=True)
    extract.add_argument("--platform", choices=("linux", "win32"), required=True)

    build = commands.add_parser("build-wheels")
    build.add_argument("--repository", type=Path, required=True)
    build.add_argument("--wheelhouse", type=Path, required=True)
    build.add_argument(
        "--build-backend-wheel",
        action="append",
        type=Path,
        required=True,
    )
    build.add_argument("--runtime-root", type=Path, required=True)
    build.add_argument("--site-packages", type=Path, required=True)
    build.add_argument("--platform", choices=("linux", "win32"), required=True)

    install = commands.add_parser("install-wheels")
    install.add_argument("--wheelhouse", type=Path, required=True)
    install.add_argument("--site-packages", type=Path, required=True)

    launchers = commands.add_parser("write-launchers")
    launchers.add_argument("--runtime-root", type=Path, required=True)
    launchers.add_argument("--site-packages", type=Path, required=True)
    launchers.add_argument("--platform", choices=("linux", "win32"), required=True)

    args = parser.parse_args()
    if args.command == "extract-runtime":
        extract_runtime(args.archive.resolve(), args.destination.resolve(), args.platform)
    elif args.command == "build-wheels":
        build_wheels(
            args.repository.resolve(),
            args.wheelhouse.resolve(),
            [wheel.resolve() for wheel in args.build_backend_wheel],
            args.runtime_root.resolve(),
            args.site_packages.resolve(),
            args.platform,
        )
    elif args.command == "install-wheels":
        install_wheels(args.wheelhouse.resolve(), args.site_packages.resolve())
    else:
        write_component_launchers(
            args.runtime_root.resolve(), args.site_packages.resolve(), args.platform
        )


if __name__ == "__main__":
    main()
