"""Provision pinned native x64 build clients; never install project dependencies.

Requires the separately qualified CPython 3.12.15/OpenSSL 3.5.9 baseline.
This is not a Python installer or admission for an arbitrary fresh image.
"""

import argparse
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import runpy
import shlex
import shutil
import ssl
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

NODE = "24.22.1"
PNPM = "10.34.7"
NODE_SHA = "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6"
WINDOWS_NODE_SHA = "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5"
PNPM_SRI = "upirxYVTmTM3W1lx9LxtbHOhtLftxKh559EC/lQj0eAjCdZ8YKEfBJVQk6luUhrZw7E4zdZUylvlY/N4s65IvQ=="
NPM_PINS = (
    ("npm", "12.2.1", "bKCmFRVT/BB+YPEYbZwQ1XUI3N5t4xKSpU1MxOjo7z3iWzKBJ0ZXRC1xFdEN+TC7N5TdywaBzf2dMXGJq/e2PQ=="),
    ("undici", "6.29.1", "EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA=="),
    ("ip-address", "10.7.4", "DWBMKyeM25D70nrIiTkgQth59/G+naKOTep6huF9j+GmeK3DMD60Zvxg5d5qQnz+38AHgou6ean2LECX+lrKDg=="),
)
# Existing isolated CA policy: remove this revoked root, add no certificates.
CA_POLICY = runpy.run_path(str(Path(__file__).with_name("certifi_bundle.py")))
BLOCKER = '#!/bin/sh\necho "Bundled npm/npx are not admitted; use the isolated npm launcher." >&2\nexit 78\n'
WINDOWS_BLOCKER = '@echo off\r\necho Bundled npm/npx are not admitted; use the isolated npm launcher. 1>&2\r\nexit /b 78\r\n'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def windows_host():
    return platform.system() == "Windows"


def native_windows():
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.IsWow64Process2.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.USHORT), ctypes.POINTER(wintypes.USHORT)]
    process, native = wintypes.USHORT(), wintypes.USHORT()
    require(kernel.IsWow64Process2(kernel.GetCurrentProcess(), ctypes.byref(process), ctypes.byref(native))
            and native.value == 0x8664 and process.value in (0, 0x8664),
            "Only native Windows x64 is supported")


def admit_host():
    require(sys.version_info[:3] == (3, 12, 15)
            and ssl.OPENSSL_VERSION.split()[:2] == ["OpenSSL", "3.5.9"],
            "Requires separately qualified CPython 3.12.15 / OpenSSL 3.5.9; image Python is not admitted")
    require((platform.system() == "Linux" and platform.machine() == "x86_64")
            or (windows_host() and platform.machine().lower() in ("amd64", "x86_64")),
            "Only native Linux/Windows x64 is supported")
    require(struct.calcsize("P") == 8, "A native x64 Python is required")
    if windows_host():
        native_windows()


def reparse(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def plain_directory(path):
    require(path.is_absolute(), "Tool root must be absolute")
    for parent in [*reversed(path.parents), path]:
        if parent.exists() or parent.is_symlink():
            require(not reparse(parent) and parent.is_dir(), "Tool root cannot traverse a symlink or reparse point")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)


def write_exact(path, content, mode=0o600):
    if path.exists() or path.is_symlink():
        require(not reparse(path) and path.is_file() and path.read_bytes() == content,
                f"Refusing to replace changed file: {path.name}")
    else:
        path.write_bytes(content)
        path.chmod(mode)


def certificates(root, source=None):
    ca = root / "ca.pem"
    write_exact(ca, CA_POLICY["host_ca_bytes"](source))
    empty = root / "empty-ca"
    plain_directory(empty)
    require(not any(empty.iterdir()), "CA directory must remain empty")
    return ca


def download(root, url, filename, algorithm, expected):
    """Authenticated inert bytes; existing cache is rehashed before every use."""
    cache = root / "archives"
    plain_directory(cache)
    target = cache / filename
    require(target.name == filename and "/" not in filename and "\\" not in filename, "Archive name must be plain")
    if target.exists() or target.is_symlink():
        require(not reparse(target) and target.is_file(), "Archive cache must be a regular file")
        data = target.read_bytes()
    else:
        context = ssl.create_default_context(cafile=str(root / "ca.pem"))
        opener = urllib.request.build_opener(HTTPSOnlyRedirect(), urllib.request.HTTPSHandler(context=context))
        require(url.startswith("https://"), "Non-HTTPS artifact URL")
        with opener.open(url, timeout=90) as response:
            data = response.read(1024**3 + 1)
        require(len(data) <= 1024**3, "Artifact is too large")
    require(hashlib.new(algorithm, data).digest() == expected, f"Checksum mismatch: {filename}")
    write_exact(target, data)
    return target


class HTTPSOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        require(new_url.startswith("https://"), "Non-HTTPS artifact redirect")
        return super().redirect_request(request, fp, code, message, headers, new_url)


def member_path(name, prefix, seen):
    path = PurePosixPath(name)
    require(path.parts and path.parts[0] == prefix and not path.is_absolute()
            and ".." not in path.parts and "\\" not in name and "\0" not in name,
            "Unsafe archive member")
    key = name
    if windows_host():
        require(all(not re.search(r'[<>:"|?*\x00-\x1f]', part) and not part.endswith((".", " "))
                    and part.split(".")[0].upper() not in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}
                    for part in path.parts), "Unsafe Windows archive member")
        key = str(path).casefold()
    require(key not in seen, "Unsafe or duplicate archive member")
    seen.add(key)
    return path


def unpack(archive, staging, prefix):
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as bundle:
            members = bundle.infolist()
            require(sum(item.file_size for item in members) < 2 * 1024**3, "Archive expands beyond limit")
            seen = set()
            for item in members:
                member_path(item.filename, prefix, seen)
                require(stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR),
                        "Unsupported ZIP entry type")
            for item in members:
                target = staging.joinpath(*PurePosixPath(item.filename).parts)
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(item) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output)
        return staging / prefix
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        require(sum(item.size for item in members) < 2 * 1024**3, "Archive expands beyond limit")
        seen = set()
        for item in members:
            member_path(item.name, prefix, seen)
            require(item.isfile() or item.isdir() or item.issym(), "Unsupported archive entry type")
            require(not windows_host() or not item.issym(), "Windows build archives must not contain links")
        bundle.extractall(staging, filter="data")
    return staging / prefix


def tree(root):
    require(not reparse(root) and root.is_dir(), "Installed tree must be a plain directory")
    result = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        info = path.lstat()
        require(not (getattr(info, "st_file_attributes", 0) & 0x400), "Installed tree contains a reparse point")
        if stat.S_ISLNK(info.st_mode):
            result[relative] = ["link", os.readlink(path)]
        elif stat.S_ISREG(info.st_mode):
            result[relative] = ["file", hashlib.sha256(path.read_bytes()).hexdigest(), info.st_mode & 0o111]
        else:
            require(stat.S_ISDIR(info.st_mode), "Unexpected installed file type")
    return result


def publish_tree(staged, destination):
    expected = tree(staged)
    if destination.exists() or destination.is_symlink():
        require(tree(destination) == expected, f"Installed tree changed: {destination.name}")
    else:
        staged.rename(destination)
    return expected


def npm_archive(root, name, version, sri):
    archive = name.rsplit("/", 1)[-1] + "-" + version + ".tgz"
    return download(root, f"https://registry.npmjs.org/{name}/-/{archive}",
                    name.replace("/", "_") + "-" + version + ".tgz", "sha512", base64.b64decode(sri))


def node_executable(root):
    return root / ("node/node.exe" if windows_host() else "node/bin/node")


def launcher(root, name):
    return root / "bin" / (name + ".cmd" if windows_host() else name)


def check_windows_executable(path):
    with path.open("rb") as source:
        header = source.read(64)
        require(len(header) == 64 and header[:2] == b"MZ", "Windows tool must be a PE executable")
        offset = struct.unpack_from("<I", header, 60)[0]
        require(64 <= offset <= 1024**2, "Invalid Windows PE header")
        source.seek(offset)
        pe = source.read(26)
    require(len(pe) == 26 and pe[:4] == b"PE\0\0" and struct.unpack_from("<H", pe, 4)[0] == 0x8664
            and struct.unpack_from("<H", pe, 24)[0] == 0x20b, "Windows tool must be native x64")


def prepare(root):
    windows = windows_host()
    if windows:
        node_archive = download(root, f"https://nodejs.org/dist/v{NODE}/win-x64/node.exe",
                                f"node-v{NODE}-win-x64.exe", "sha256", bytes.fromhex(WINDOWS_NODE_SHA))
    else:
        node_archive = download(root, f"https://nodejs.org/dist/v{NODE}/node-v{NODE}-linux-x64.tar.xz",
                                f"node-v{NODE}-linux-x64.tar.xz", "sha256", bytes.fromhex(NODE_SHA))
    pnpm_archive = npm_archive(root, "pnpm", PNPM, PNPM_SRI)
    launchers = root / "bin"
    plain_directory(launchers)
    write_exact(root / ("blocked-npm.cmd" if windows else "blocked-npm"),
                (WINDOWS_BLOCKER if windows else BLOCKER).encode(), 0o755)
    with tempfile.TemporaryDirectory(prefix="stage-", dir=root) as temporary:
        stage = Path(temporary)
        if windows:
            node = stage / "node"
            node.mkdir()
            shutil.copyfile(node_archive, node / "node.exe")
            check_windows_executable(node / "node.exe")
        else:
            node = unpack(node_archive, stage / "node", f"node-v{NODE}-linux-x64")
            for name in ("npm", "npx"):
                entry = node / "bin" / name
                require(entry.is_symlink(), "Unexpected bundled npm launcher")
                entry.unlink()
                entry.symlink_to(root / "blocked-npm")
        publish_tree(node, root / "node")
        pnpm = unpack(pnpm_archive, stage / "pnpm", "package")
        metadata = json.loads((pnpm / "package.json").read_text())
        require(metadata["name"] == "pnpm" and metadata["version"] == PNPM, "pnpm identity mismatch")
        require(not {"preinstall", "install", "postinstall"} & metadata.get("scripts", {}).keys(),
                "Unexpected pnpm install scripts")
        publish_tree(pnpm, root / "pnpm")
        npm = None
        for name, version, sri in NPM_PINS:
            package = unpack(npm_archive(root, name, version, sri), stage / name, "package")
            metadata = json.loads((package / "package.json").read_text())
            require(metadata["name"] == name and metadata["version"] == version, "npm package identity mismatch")
            if name == "npm":
                npm = package
            else:
                destination = npm / "node_modules" / name
                require(not destination.is_symlink() and destination.is_dir(), "Unexpected bundled dependency")
                shutil.rmtree(destination)  # Only the freshly verified private staging tree.
                package.rename(destination)
        for name in ("user.npmrc", "global.npmrc"):
            write_exact(root / name, b"")
        config_root = root.as_posix()
        (npm / "npmrc").write_text(
            f"cache={config_root}/npm-cache\ncafile={config_root}/ca.pem\nstrict-ssl=true\nupdate-notifier=false\n"
            f"userconfig={config_root}/user.npmrc\nglobalconfig={config_root}/global.npmrc\n")
        publish_tree(npm, root / "npm")
    write_launchers(root)


def write_launchers(root):
    node = shlex.quote(str(root / "node/bin/node"))
    # Npm/pnpm configuration and Node injection variables cannot select a different
    # client, disable TLS, or restore the image's npm. Proxy variables are retained.
    client = """const path = require('node:path');
const root = __dirname;
const kind = process.argv[2];
if (!['npm', 'pnpm'].includes(kind)) throw Error('Unknown pinned client');
for (const key of Object.keys(process.env)) {
  if (/^npm_config_/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_USE_SYSTEM_CA|COREPACK_|PNPM_)/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
 PATH: (process.platform === 'win32' ? path.dirname(process.execPath) + path.delimiter : '') + path.join(root, 'bin') + path.delimiter + (process.env.PATH || (process.platform === 'win32' ? '' : '/usr/bin:/bin')),
 SSL_CERT_FILE: path.join(root, 'ca.pem'), SSL_CERT_DIR: path.join(root, 'empty-ca'),
 NODE_OPTIONS: '--use-openssl-ca', npm_config_node_options: '--use-openssl-ca',
 npm_config_cafile: path.join(root, 'ca.pem'), npm_config_strict_ssl: 'true',
 npm_config_userconfig: path.join(root, 'user.npmrc'), npm_config_globalconfig: path.join(root, 'global.npmrc'),
 npm_config_cache: path.join(root, 'npm-cache'), npm_config_ignore_scripts: 'true',
});
if (kind === 'pnpm') Object.assign(process.env, {
 npm_config_manage_package_manager_versions: 'false',
 npm_config_npm_path: path.join(root, process.platform === 'win32' ? 'blocked-npm.cmd' : 'blocked-npm'), npm_config_enable_pre_post_scripts: 'false',
});
const entry = path.join(root, kind, kind === 'npm' ? 'bin/npm-cli.js' : 'bin/pnpm.cjs');
process.argv = [process.execPath, entry, ...process.argv.slice(3)];
require(entry);
"""
    write_exact(root / "client.cjs", client.encode())
    if windows_host():
        common = ('@echo off\r\nsetlocal DisableDelayedExpansion\r\n'
                  'set "NODE_OPTIONS="\r\nset "NODE_PATH="\r\nset "NODE_EXTRA_CA_CERTS="\r\n'
                  'set "NODE_TLS_REJECT_UNAUTHORIZED="\r\nset "NODE_USE_SYSTEM_CA="\r\n'
                  'set "SSL_CERT_FILE=%~dp0..\\ca.pem"\r\nset "SSL_CERT_DIR=%~dp0..\\empty-ca"\r\n'
                  'set "NODE_OPTIONS=--use-openssl-ca"\r\n')
        for name in ("node", "npm", "pnpm"):
            entry = '' if name == "node" else f' "%~dp0..\\client.cjs" {name}'
            write_exact(launcher(root, name), (common + f'"%~dp0..\\node\\node.exe" --use-openssl-ca{entry} %*\r\nexit /b %errorlevel%\r\n').encode(), 0o755)
        write_exact(launcher(root, "npx"), WINDOWS_BLOCKER.encode(), 0o755)
        return
    common = (f"export SSL_CERT_FILE={shlex.quote(str(root / 'ca.pem'))}\n"
              f"export SSL_CERT_DIR={shlex.quote(str(root / 'empty-ca'))}\n")
    clean = ("/usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u NODE_EXTRA_CA_CERTS "
             "-u NODE_TLS_REJECT_UNAUTHORIZED -u NODE_USE_SYSTEM_CA NODE_OPTIONS=--use-openssl-ca")
    write_exact(root / "bin/node", (f'#!/bin/sh\n{common}exec {clean} {node} --use-openssl-ca "$@"\n').encode(), 0o755)
    for name in ("npm", "pnpm"):
        write_exact(root / "bin" / name,
                    (f'#!/bin/sh\n{common}exec {clean} {node} --use-openssl-ca '
                     f'{shlex.quote(str(root / "client.cjs"))} {name} "$@"\n').encode(), 0o755)
    write_exact(root / "bin/npx", BLOCKER.encode(), 0o755)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--ca-source", type=Path)
    args = parser.parse_args()
    admit_host()
    plain_directory(args.root)
    certificates(args.root, args.ca_source)
    prepare(args.root)
    for name, command in (("node", ["-p", "JSON.stringify({version:process.version,execPath:process.execPath})"]),
                          ("npm", ["--version"]), ("pnpm", ["--version"])):
        if windows_host():
            env = {key: value for key, value in os.environ.items()
                   if key.upper() not in {"NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_SYSTEM_CA"}}
            env.update(SSL_CERT_FILE=str(args.root / "ca.pem"), SSL_CERT_DIR=str(args.root / "empty-ca"), NODE_OPTIONS="--use-openssl-ca")
            entry = [] if name == "node" else [str(args.root / "client.cjs"), name]
            subprocess.run([str(node_executable(args.root)), "--use-openssl-ca", *entry, *command],
                           env=env, check=True, timeout=20, cwd=args.root)
        else:
            subprocess.run([str(launcher(args.root, name)), *command], check=True, timeout=20, cwd=args.root)
    print("Pinned clients verified. No project install, lifecycle scripts or host settings changed.")


if __name__ == "__main__":
    main()
