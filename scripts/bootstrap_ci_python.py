"""Provision authenticated task-local CPython and patch its retained pip seed.

The setup-python interpreter only extracts authenticated bytes and runs native
curl. The next unchanged runtime guard admits the provisioned Python/OpenSSL.
"""

import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import runpy
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile


if "CA_POLICY" not in globals():
    CA_POLICY = runpy.run_path(str(Path(__file__).with_name("certifi_bundle.py")))

ASSETS = {
    "linux": {
        "file": "cpython-3.12.15+20261021-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
        "size": 34479606, "sha256": "6d7521138fd33afddc1ccd08abb007d9a2829e38117c2576f9efdc0ec73ce772",
        "executable": "python/bin/python3.12",
        "executable_sha256": "0a97d28d3635c7dfd143de6d00b09c0cb382249c020b28ee33fb4002db1efb9c",
    },
    "win32": {
        "file": "cpython-3.12.15+20261021-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "size": 21990627, "sha256": "aac5d331fc3307343f95928fdbea4583f0d53973d08c7e1d081884fbd229a0e1",
        "executable": "python/python.exe",
        "executable_sha256": "651e2230e6f02b233b46c0f829f08df95864d8155e41802c4609fc4aab45c843",
    },
}
RELEASE = "https://github.com/astral-sh/python-build-standalone/releases/download/20261021/"
MAX_EXPANDED = 256 * 1024 * 1024


def refuse(message):
    raise ValueError("CI Python provisioning: " + message)


def plain(path, directory=False):
    info = path.lstat()
    if (stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400
            or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or (not directory and info.st_nlink != 1)):
        refuse("plain task-owned paths are required")
    return info


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(path, size, digest):
    if plain(path).st_size != size or sha256(path) != digest:
        refuse("artifact size or SHA256 mismatch")


def native_x64(executable, system):
    with executable.open("rb") as stream:
        header = stream.read(64)
        if system == "linux":
            if len(header) < 20 or header[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", header, 18)[0] != 62:
                refuse("Linux Python must be a native x64 ELF executable")
        else:
            if len(header) != 64 or header[:2] != b"MZ":
                refuse("Windows Python must be a native x64 PE executable")
            offset = struct.unpack_from("<I", header, 60)[0]
            if not 64 <= offset <= 1024 * 1024:
                refuse("invalid Python PE header")
            stream.seek(offset)
            pe = stream.read(26)
            if len(pe) != 26 or pe[:4] != b"PE\0\0" or struct.unpack_from("<H", pe, 4)[0] != 0x8664 or struct.unpack_from("<H", pe, 24)[0] != 0x20b:
                refuse("Windows Python must be a native x64 PE32+ executable")


def curl_path():
    if sys.platform == "linux":
        return "/usr/bin/curl"
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    directory = ctypes.create_unicode_buffer(32768)
    length = kernel.GetWindowsDirectoryW(directory, len(directory))
    if not 0 < length < len(directory):
        refuse("native Windows directory is unavailable")
    return str(Path(directory.value) / "System32/curl.exe")


def download(url, target, size, digest):
    if target.exists():
        verify(target, size, digest)
        return target
    with target.open("xb"):
        pass
    target.chmod(0o600)
    before = plain(target)
    keep = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
            "https_proxy", "http_proxy", "all_proxy", "no_proxy", "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"}
    environment = {name: value for name, value in os.environ.items() if name in keep}
    try:
        subprocess.run([curl_path(), "--disable", "--fail", "--silent", "--show-error", "--proto", "=https",
                        "--proto-redir", "=https", "--location", "--max-redirs", "3", "--connect-timeout", "10",
                        "--max-time", "120", "--max-filesize", str(size), "--output", str(target), url],
                       env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=125, check=True)
    except subprocess.CalledProcessError as error:
        refuse("download failed (curlReturnCode=" + str(error.returncode) + ")")
    except subprocess.TimeoutExpired:
        refuse("download exceeded its deadline")
    after = plain(target)
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        refuse("download destination changed")
    verify(target, size, digest)
    return target


def unpack(archive, destination, asset, system):
    verify(archive, asset["size"], asset["sha256"])
    plain(destination, directory=True)
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        if len(members) > 40000 or sum(item.size for item in members) > MAX_EXPANDED:
            refuse("archive exceeds its extraction bounds")
        seen, links = set(), set()
        for item in members:
            parts = PurePosixPath(item.name).parts
            if (not parts or parts[0] != "python" or item.name.startswith("/")
                    or "\\" in item.name or ":" in item.name or ".." in parts
                    or any(part in ("", ".") for part in item.name.split("/"))
                    or not (item.isdir() or item.isreg() or item.issym())
                    or (system == "win32" and any(part.rstrip(" .") != part for part in parts))):
                refuse("unsupported archive path or member type")
            key = item.name.casefold() if system == "win32" else item.name
            if key in seen:
                refuse("duplicate archive destination")
            seen.add(key)
            if item.issym():
                target = PurePosixPath(posixpath.normpath(str(PurePosixPath(item.name).parent / item.linkname)))
                if (not item.linkname or "\\" in item.linkname or ":" in item.linkname
                        or item.linkname.startswith("/") or target.parts[0] != "python" or ".." in target.parts):
                    refuse("archive link escapes the runtime")
                links.add(item.name)
        for item in members:
            if any(str(parent) in links for parent in PurePosixPath(item.name).parents):
                refuse("archive cannot write through a link")
        # CPython 3.12.15's data filter also refuses filesystem escapes, devices,
        # and privileged metadata. Only the authenticated archive reaches it.
        package.extractall(destination, members=members, filter="data")
    root = destination.resolve(strict=True)
    for name in links:
        if not (destination / name).resolve(strict=True).is_relative_to(root):
            refuse("extracted link escapes the runtime")
    executable = destination / asset["executable"]
    if sha256(executable) != asset["executable_sha256"]:
        refuse("extracted Python differs from the qualified executable")
    native_x64(executable, system)
    return executable


def patch_seed(runtime, temporary, system):
    library = runtime / "python" / ("Lib" if system == "win32" else "lib/python3.12")
    bundled = library / "ensurepip/_bundled"
    seed = bundled / CA_POLICY["PIP_WHEEL"]
    plain(seed)
    if (re.findall(r'^_PIP_VERSION = "([^"]+)"$', (library / "ensurepip/__init__.py").read_text(), re.MULTILINE) != ["26.2.2"]
            or sorted(path.name for path in bundled.glob("*.whl")) != [CA_POLICY["PIP_WHEEL"]]
            or sha256(seed) != CA_POLICY["PIP_SHA256"]):
        refuse("retained ensurepip seed is not the authenticated pip 26.2.2 wheel")
    cache = temporary / "vivary-pip-26.2.2"
    cache.mkdir(mode=0o700, exist_ok=True)
    plain(cache, directory=True)
    upstream = cache / CA_POLICY["PIP_WHEEL"]
    if not upstream.exists():
        with upstream.open("xb") as output:
            output.write(seed.read_bytes())
    verify(upstream, 1819850, CA_POLICY["PIP_SHA256"])
    certifi = download(CA_POLICY["CERTIFI_URL"], cache / CA_POLICY["CERTIFI_WHEEL"],
                       CA_POLICY["CERTIFI_SIZE"], CA_POLICY["CERTIFI_SHA256"])
    derived = cache / "certifi-2026.10.23"
    derived.mkdir(mode=0o700, exist_ok=True)
    plain(derived, directory=True)
    wheel = CA_POLICY["prepare_pip"](upstream, certifi, derived / CA_POLICY["PIP_WHEEL"])
    replacement = bundled / ".vivary-qualified-pip-seed"
    with replacement.open("xb") as output:
        output.write(wheel.read_bytes())
        output.flush()
        os.fsync(output.fileno())
    replacement.chmod(stat.S_IMODE(seed.stat().st_mode) & 0o777)
    os.replace(replacement, seed)
    if seed.read_bytes() != wheel.read_bytes():
        refuse("retained pip seed differs from the authenticated certifi overlay")
    return sha256(seed)


def provision_python():
    if (sys.platform not in ASSETS or sys.implementation.name != "cpython"
            or tuple(sys.version_info) != (3, 12, 15, "final", 0) or not sys.flags.isolated or not sys.flags.dont_write_bytecode):
        refuse("isolated setup CPython 3.12.15 is required for authenticated extraction")
    temporary = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    path_file = Path(os.environ["GITHUB_PATH"]).resolve(strict=True)
    environment_file = Path(os.environ["GITHUB_ENV"]).resolve(strict=True)
    if any(character in str(temporary) + str(path_file) + str(environment_file) for character in "\r\n"):
        refuse("runner command paths cannot contain line breaks")
    plain(temporary, directory=True)
    plain(path_file)
    plain(environment_file)
    if path_file == environment_file:
        refuse("runner path and environment command files must be distinct")
    prefix = Path(tempfile.mkdtemp(prefix="vivary-python-3.12.15-", dir=temporary))
    try:
        asset = ASSETS[sys.platform]
        archive = download(RELEASE + asset["file"].replace("+", "%2B"), prefix / "python.tar.gz", asset["size"], asset["sha256"])
        runtime = prefix / "runtime"
        runtime.mkdir(mode=0o700)
        executable = unpack(archive, runtime, asset, sys.platform)
        seed = patch_seed(runtime, temporary, sys.platform)
        trust = prefix / "qualified-ca.pem"
        with trust.open("xb") as output:
            output.write(CA_POLICY["host_ca_bytes"]())
        trust.chmod(0o600)
        pip_trust = prefix / "pip-certifi-ca.pem"
        certifi = temporary / "vivary-pip-26.2.2" / CA_POLICY["CERTIFI_WHEEL"]
        plain(certifi)
        with pip_trust.open("xb") as output:
            output.write(CA_POLICY["certifi_ca_bytes"](certifi.read_bytes()))
        pip_trust.chmod(0o600)
        empty_ca = prefix / "empty-ca-directory"
        empty_ca.mkdir(mode=0o700)
        paths = [executable.parent]
        if sys.platform == "win32":
            scripts = executable.parent / "Scripts"
            scripts.mkdir(exist_ok=True)
            plain(scripts, directory=True)
            paths.append(scripts)
        trust_names = ("SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO")
        with environment_file.open("a", encoding="utf-8", newline="\n") as output:
            output.write("".join(name + "=" + str(trust) + "\n" for name in trust_names)
                         + "".join(name + "=" + str(pip_trust) + "\n" for name in ("PIP_CERT", "REQUESTS_CA_BUNDLE"))
                         + "SSL_CERT_DIR=" + str(empty_ca) + "\n")
        with path_file.open("a", encoding="utf-8", newline="\n") as output:
            output.write("".join(str(path) + "\n" for path in paths))
        return {"python": str(executable), "archiveSha256": asset["sha256"], "seedSha256": seed,
                "trustSha256": sha256(trust), "pipTrustSha256": sha256(pip_trust)}
    except BaseException:
        shutil.rmtree(prefix)
        raise


def main():
    try:
        if len(sys.argv) != 1:
            refuse("arguments and caller-supplied artifact facts are not admitted")
        print(json.dumps(provision_python(), sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, AttributeError, tarfile.TarError, subprocess.SubprocessError) as error:
        message = str(error) if type(error) is ValueError and str(error).startswith("CI Python provisioning: ") else "CI Python provisioning failed (exception=" + type(error).__name__ + ")"
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
