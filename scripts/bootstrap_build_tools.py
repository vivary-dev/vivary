"""Provision pinned Linux build clients; never install project dependencies.

Requires the separately qualified CPython 3.12.15/OpenSSL 3.5.9 baseline.
This is not a Python installer or admission for an arbitrary fresh image.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

NODE = "24.22.1"
PNPM = "10.34.7"
NODE_SHA = "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6"
PNPM_SRI = "upirxYVTmTM3W1lx9LxtbHOhtLftxKh559EC/lQj0eAjCdZ8YKEfBJVQk6luUhrZw7E4zdZUylvlY/N4s65IvQ=="
NPM_PINS = (
    ("npm", "12.2.1", "bKCmFRVT/BB+YPEYbZwQ1XUI3N5t4xKSpU1MxOjo7z3iWzKBJ0ZXRC1xFdEN+TC7N5TdywaBzf2dMXGJq/e2PQ=="),
    ("undici", "6.29.1", "EvRlUt/QqAEvXdQeRMYUfwOQsfzpDztykrG2owGEE/rBOBoYv9uF39ZzsNDh4lTFHhTr2XOZjKkYgueD12ZmGA=="),
    ("ip-address", "10.7.4", "DWBMKyeM25D70nrIiTkgQth59/G+naKOTep6huF9j+GmeK3DMD60Zvxg5d5qQnz+38AHgou6ean2LECX+lrKDg=="),
)
# Existing isolated CA policy: remove this revoked root, add no certificates.
REVOKED_SHA = "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b"
BLOCKER = '#!/bin/sh\necho "Bundled npm/npx are not admitted; use the isolated npm launcher." >&2\nexit 78\n'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def admit_host():
    require(sys.version_info[:3] == (3, 12, 15)
            and ssl.OPENSSL_VERSION.split()[:2] == ["OpenSSL", "3.5.9"],
            "Requires separately qualified CPython 3.12.15 / OpenSSL 3.5.9; image Python is not admitted")
    require(platform.system() == "Linux" and platform.machine() == "x86_64",
            "Only Linux x86-64 is qualified")


def plain_directory(path):
    require(path.is_absolute(), "Tool root must be absolute")
    for parent in [*reversed(path.parents), path]:
        if parent.exists() or parent.is_symlink():
            require(not parent.is_symlink() and parent.is_dir(), "Tool root cannot traverse a symlink")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)


def write_exact(path, content, mode=0o600):
    if path.exists() or path.is_symlink():
        require(not path.is_symlink() and path.is_file() and path.read_bytes() == content,
                f"Refusing to replace changed file: {path.name}")
    else:
        path.write_bytes(content)
        path.chmod(mode)


def certificates(root, source):
    pems = re.findall(r"-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----", source.read_text())
    require(bool(pems), "Existing system CA bundle is empty")
    kept = [pem for pem in pems if hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest() != REVOKED_SHA]
    require(bool(kept), "Filtered CA bundle is empty")
    ca = root / "ca.pem"
    write_exact(ca, ("\n".join(kept) + "\n").encode())
    empty = root / "empty-ca"
    plain_directory(empty)
    require(not any(empty.iterdir()), "CA directory must remain empty")
    return ca


def download(root, url, filename, algorithm, expected):
    """Authenticated inert bytes; existing cache is rehashed before every use."""
    cache = root / "archives"
    plain_directory(cache)
    target = cache / filename
    require(target.name == filename and "/" not in filename, "Archive name must be plain")
    if target.exists() or target.is_symlink():
        require(not target.is_symlink() and target.is_file(), "Archive cache must be a regular file")
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


def unpack(archive, staging, prefix):
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        require(sum(item.size for item in members) < 2 * 1024**3, "Archive expands beyond limit")
        seen = set()
        for item in members:
            path = PurePosixPath(item.name)
            require(path.parts and path.parts[0] == prefix and not path.is_absolute()
                    and ".." not in path.parts and item.name not in seen,
                    "Unsafe or duplicate archive member")
            seen.add(item.name)
            require(item.isfile() or item.isdir() or item.issym(), "Unsupported archive entry type")
        bundle.extractall(staging, filter="data")
    return staging / prefix


def tree(root):
    require(not root.is_symlink() and root.is_dir(), "Installed tree must be a plain directory")
    result = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        info = path.lstat()
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


def prepare(root):
    node_archive = download(root, f"https://nodejs.org/dist/v{NODE}/node-v{NODE}-linux-x64.tar.xz",
                            f"node-v{NODE}-linux-x64.tar.xz", "sha256", bytes.fromhex(NODE_SHA))
    pnpm_archive = npm_archive(root, "pnpm", PNPM, PNPM_SRI)
    launchers = root / "bin"
    plain_directory(launchers)
    write_exact(root / "blocked-npm", BLOCKER.encode(), 0o755)
    with tempfile.TemporaryDirectory(prefix="stage-", dir=root) as temporary:
        stage = Path(temporary)
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
        (npm / "npmrc").write_text(
            f"cache={root}/npm-cache\ncafile={root}/ca.pem\nstrict-ssl=true\nupdate-notifier=false\n"
            f"userconfig={root}/user.npmrc\nglobalconfig={root}/global.npmrc\n")
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
 PATH: path.join(root, 'bin') + path.delimiter + (process.env.PATH || '/usr/bin:/bin'),
 SSL_CERT_FILE: path.join(root, 'ca.pem'), SSL_CERT_DIR: path.join(root, 'empty-ca'),
 NODE_OPTIONS: '--use-openssl-ca', npm_config_node_options: '--use-openssl-ca',
 npm_config_cafile: path.join(root, 'ca.pem'), npm_config_strict_ssl: 'true',
 npm_config_userconfig: path.join(root, 'user.npmrc'), npm_config_globalconfig: path.join(root, 'global.npmrc'),
 npm_config_cache: path.join(root, 'npm-cache'), npm_config_ignore_scripts: 'true',
});
if (kind === 'pnpm') Object.assign(process.env, {
 npm_config_manage_package_manager_versions: 'false',
 npm_config_npm_path: path.join(root, 'blocked-npm'), npm_config_enable_pre_post_scripts: 'false',
});
const entry = path.join(root, kind, kind === 'npm' ? 'bin/npm-cli.js' : 'bin/pnpm.cjs');
process.argv = [process.execPath, entry, ...process.argv.slice(3)];
require(entry);
"""
    write_exact(root / "client.cjs", client.encode())
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
    parser.add_argument("--ca-source", type=Path, default=Path("/etc/ssl/certs/ca-certificates.crt"))
    args = parser.parse_args()
    admit_host()
    plain_directory(args.root)
    certificates(args.root, args.ca_source)
    prepare(args.root)
    for name, command in (("node", ["-p", "JSON.stringify({version:process.version,execPath:process.execPath})"]),
                          ("npm", ["--version"]), ("pnpm", ["--version"])):
        subprocess.run([str(args.root / "bin" / name), *command], check=True, timeout=20, cwd=args.root)
    print("Pinned clients verified. No project install, lifecycle scripts or host settings changed.")


if __name__ == "__main__":
    main()
