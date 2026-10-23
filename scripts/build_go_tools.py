"""Build matching esbuild, optionally TypeScript, with the pinned Go runtime."""

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import shutil
import ssl
import subprocess
import tempfile
from types import SimpleNamespace
import urllib.request
import zipfile

bootstrap = SimpleNamespace(**runpy.run_path(str(Path(__file__).with_name("bootstrap_build_tools.py"))))

GO_SHA = "ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5"
WINDOWS_GO_SHA = "7ecd2d7260e82c59bcbd7f1077a07cee2dea607295b858df67195a1e4e09629b"
GO_SIZE = 66936659
WINDOWS_GO_SIZE = 75004774
ESBUILD_SUM = "h1:A2uETn4jrQTcXaT/shwTDTYBxDjl7fV7nXmUrJxfA2w="
ESBUILD_MOD_SUM = "h1:D2vIQZqV/vIf/VRHtViaUtViZmG7o+kKmlBfVQuRi48="
SYS_SUM = "h1:0A+M6Uqn+Eje4kHMK80dtF3JCXC4ykBgQG4Fe06QRhQ="
TS_COMMIT = "2bd066d87f5bafd315be9f40889d0a60b9e58e0b"
TS_MOD_SHA = "8b2c958ea48d9e64a9f2cc960625085e6f220c6679570db78db9cf5114c368c2"
TS_SUM_SHA = "f56e1eb56cc1f61c3801f862a4afa26f4b43295436eb405228bedb0f7e707468"
TS_DECLARATION_SHA = "c4559d41cc101d62086119c3c8c6b00081a540782c65e82c0629fc255073f8ff"
TS_PACKAGE_SRI = "EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A=="
TS_ARCHIVE_SHA = "5ccb47dbb3f68cd0da58b71e6f445eee36a50bd3e9f9f330cc23a97b88500119"


def module_hash(files):
    # Go's sumdb/dirhash.Hash1 hashes sorted filename/content-digest lines.
    summary = b"".join(hashlib.sha256(content).hexdigest().encode() + b"  " + name.encode() + b"\n"
                       for name, content in sorted(files.items()))
    return "h1:" + base64.b64encode(hashlib.sha256(summary).digest()).decode()


def verify_module(data, expected, module, version, kind):
    if kind == "mod":
        actual = module_hash({"go.mod": data})
    else:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            bootstrap.require(sum(item.file_size for item in entries) < 512 * 1024**2,
                              "Module expands beyond its bound")
            prefix = module + "@" + version + "/"
            files = {}
            for item in entries:
                name = item.filename
                bootstrap.require(name.startswith(prefix) and ".." not in PurePosixPath(name).parts
                                  and not re.search(r"[\x00-\x1f\\]", name) and name not in files,
                                  "Unsafe module archive member")
                files[name] = archive.read(item)
            actual = module_hash(files)
    bootstrap.require(actual == expected, "Go module checksum mismatch")


def module_checksums(path):
    checksums = {}
    for line in path.read_text().splitlines():
        fields = line.split()
        bootstrap.require(len(fields) == 3 and re.fullmatch(r"h1:[A-Za-z0-9+/]{43}=", fields[2]),
                          "Unexpected pinned go.sum entry")
        module, version, digest = fields
        kind = "mod" if version.endswith("/go.mod") else "zip"
        version = version.removesuffix("/go.mod")
        bootstrap.require(re.fullmatch(r"[A-Za-z0-9._~+/-]+", module)
                          and all(part not in ("", ".", "..") for part in module.split("/"))
                          and re.fullmatch(r"v[0-9][A-Za-z0-9.+-]*", version), "Unexpected Go module identity")
        entry = checksums.setdefault((module, version), {})
        bootstrap.require(kind not in entry, "Duplicate pinned go.sum entry")
        entry[kind] = digest
    return checksums


def prefetch_modules(root, checksums):
    """Windows Go never networks: Python uses the filtered CA, then h1 verifies.

    Windows Go otherwise adds CryptoAPI roots regardless of SSL_CERT_FILE.
    Every source/mod digest here comes from an authenticated parent or pinned
    go.sum. Metadata can select only the already fixed module version.
    """
    proxy = root / "go-proxy"
    bootstrap.plain_directory(proxy)
    context = ssl.create_default_context(cafile=str(root / "ca.pem"))
    opener = urllib.request.build_opener(bootstrap.HTTPSOnlyRedirect(),
                                        urllib.request.HTTPSHandler(context=context))
    def escaped(value):
        return "".join("!" + char.lower() if char.isupper() else char for char in value)
    for (module, version), pins in sorted(checksums.items()):
        destination = proxy / escaped(module) / "@v"
        bootstrap.plain_directory(destination)
        kinds = [*pins, "info"] if "zip" in pins else ["mod"]
        for kind in kinds:
            name = escaped(version) + "." + kind
            target = destination / name
            if target.exists() or target.is_symlink():
                bootstrap.require(not bootstrap.reparse(target) and target.is_file(), "Module cache must be a plain file")
                data = target.read_bytes()
            else:
                url = "https://proxy.golang.org/" + escaped(module) + "/@v/" + name
                with opener.open(url, timeout=60) as response:
                    data = response.read(128 * 1024**2 + 1)
                bootstrap.require(len(data) <= 128 * 1024**2, "Module download exceeded its bound")
            if kind == "info":
                bootstrap.require(json.loads(data)["Version"] == version, "Module metadata version mismatch")
            else:
                verify_module(data, pins[kind], module, version, kind)
            bootstrap.write_exact(target, data)
    return proxy.as_uri()


def environment(root):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("GO", "GIT_", "SSL_CERT_"))}
    env.update(GOTOOLCHAIN="local", GOWORK="off", GOENV="off", GOTELEMETRY="off",
               GOPATH=str(root / "go-path"), GOCACHE=str(root / "go-cache"),
               GOPROXY="https://proxy.golang.org", GOSUMDB="sum.golang.org",
               GOFLAGS="-mod=readonly", CGO_ENABLED="0", GOOS="windows" if bootstrap.windows_host() else "linux", GOARCH="amd64",
               SSL_CERT_FILE=str(root / "ca.pem"), SSL_CERT_DIR=str(root / "empty-ca"),
               GIT_SSL_CAINFO=str(root / "ca.pem"), GIT_SSL_NO_VERIFY="false",
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               XDG_CONFIG_HOME=str(root / "config"))
    if bootstrap.windows_host():
        env.update(GOPROXY=(root / "go-proxy").as_uri(), GOSUMDB="off", GOVCS="*:off")
    return env


def build(root, typescript=False):
    require = bootstrap.require
    windows = bootstrap.windows_host()
    target = "windows" if windows else "linux"
    suffix = ".exe" if windows else ""
    filename = "go1.26.10.windows-amd64.zip" if windows else "go1.26.10.linux-amd64.tar.gz"
    archive = bootstrap.download(root, "https://go.dev/dl/" + filename,
                                 filename, "sha256", bytes.fromhex(WINDOWS_GO_SHA if windows else GO_SHA),
                                 size=WINDOWS_GO_SIZE if windows else GO_SIZE)
    with tempfile.TemporaryDirectory(prefix="go-stage-", dir=root) as temporary:
        staged = bootstrap.unpack(archive, Path(temporary), "go")
        bootstrap.publish_tree(staged, root / "go")
    go = root / "go/bin" / ("go" + suffix)
    if windows:
        bootstrap.check_windows_executable(go)
    env = environment(root)

    def command(*args, cwd=root):
        return subprocess.check_output([str(go), *args], env=env, cwd=cwd, text=True, timeout=600)

    require(command("version").strip() == f"go version go1.26.10 {target}/amd64", "Go identity mismatch")
    if windows:
        prefetch_modules(root, {("github.com/evanw/esbuild", "v0.28.2"): {"zip": ESBUILD_SUM, "mod": ESBUILD_MOD_SUM}})
    source = json.loads(command("mod", "download", "-json", "github.com/evanw/esbuild@v0.28.2"))
    require(source["Sum"] == ESBUILD_SUM and source["GoModSum"] == ESBUILD_MOD_SUM,
            "esbuild source checksum mismatch")
    if windows:
        prefetch_modules(root, module_checksums(Path(source["Dir"]) / "go.sum"))
    dependency = json.loads(command("mod", "download", "-json", cwd=source["Dir"]))
    require(dependency["Path"] == "golang.org/x/sys" and dependency["Sum"] == SYS_SUM,
            "Unexpected esbuild dependency")
    command("mod", "verify", cwd=source["Dir"])
    env["GOPROXY"] = "off"
    with tempfile.TemporaryDirectory(prefix="compiler-stage-", dir=root) as temporary:
        stage = Path(temporary)
        binary = stage / ("esbuild" + suffix)
        command("build", "-buildvcs=false", "-p", "2", "-trimpath", "-o", str(binary),
                "./cmd/esbuild", cwd=source["Dir"])
        info = command("version", "-m", str(binary))
        require(": go1.26.10\n" in info, "Unexpected esbuild embedded Go runtime")
        require(subprocess.check_output([str(binary), "--version"], text=True, timeout=10).strip() == "0.28.2",
                "esbuild API version mismatch")
        destination = root / ("esbuild-0.28.2-go1.26.10" + suffix)
        bootstrap.write_exact(destination, binary.read_bytes(), 0o755)
        if typescript:
            env["GOPROXY"] = (root / "go-proxy").as_uri() if windows else "https://proxy.golang.org"
            ts = stage / "typescript-source"
            if windows:
                ts_archive = bootstrap.download(root, "https://codeload.github.com/microsoft/typescript-go/tar.gz/" + TS_COMMIT,
                                                "typescript-go-" + TS_COMMIT + ".tar.gz", "sha256", bytes.fromhex(TS_ARCHIVE_SHA))
                bootstrap.unpack(ts_archive, ts, "typescript-go-" + TS_COMMIT).rename(stage / "verified-typescript-source")
                ts = stage / "verified-typescript-source"
            else:
                subprocess.run(["git", "clone", "--depth", "1", "--branch", "typescript/v7.0.2",
                                "https://github.com/microsoft/typescript-go.git", str(ts)],
                               env=env, check=True, timeout=180)
                revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ts, env=env, text=True).strip()
                require(revision == TS_COMMIT, "TypeScript source revision mismatch")
            for name, expected in (("go.mod", TS_MOD_SHA), ("go.sum", TS_SUM_SHA)):
                require(hashlib.sha256((ts / name).read_bytes()).hexdigest() == expected,
                        f"TypeScript {name} checksum mismatch")
            if windows:
                prefetch_modules(root, module_checksums(ts / "go.sum"))
            command("mod", "download", cwd=ts)
            command("mod", "verify", cwd=ts)
            env["GOPROXY"] = "off"
            output = stage / "typescript"
            output.mkdir()
            command("build", "-buildvcs=false", "-p", "2", "-tags", "noembed", "-trimpath",
                    "-o", str(output / ("tsc" + suffix)), "./cmd/tsgo", cwd=ts)
            # Only inert declarations are used from this archive; its bundled
            # compiler (built with another Go version) is never executed.
            declaration_archive = bootstrap.npm_archive(root, "@typescript/typescript-linux-x64", "7.0.2", TS_PACKAGE_SRI)
            package = bootstrap.unpack(declaration_archive, stage / "declarations", "package")
            files = sorted((package / "lib").glob("lib*.d.ts"))
            manifest = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
            rendered = json.dumps(manifest, indent=2) + "\n"
            require(hashlib.sha256(rendered.encode()).hexdigest() == TS_DECLARATION_SHA,
                    "TypeScript declaration manifest mismatch")
            for path in files:
                shutil.copyfile(path, output / path.name)
            info_ts = command("version", "-m", str(output / ("tsc" + suffix)))
            require(": go1.26.10\n" in info_ts, "Unexpected TypeScript embedded Go runtime")
            require(subprocess.check_output([str(output / ("tsc" + suffix)), "--version"], text=True, timeout=10).strip()
                    == "Version 7.0.2", "TypeScript API version mismatch")
            (output / "source.json").write_text(json.dumps({"commit": TS_COMMIT,
                "declarationManifestSha256": TS_DECLARATION_SHA}, indent=2) + "\n")
            bootstrap.publish_tree(output, root / "typescript-7.0.2-go1.26.10")
    print(json.dumps({"esbuild": str(destination), "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
                      "go": "1.26.10", "typescript": typescript}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--typescript", action="store_true")
    args = parser.parse_args()
    bootstrap.admit_host()
    bootstrap.plain_directory(args.root)
    # Re-admit the clients/CA before any compiler acquisition or execution.
    bootstrap.certificates(args.root)
    bootstrap.prepare(args.root)
    build(args.root, args.typescript)


if __name__ == "__main__":
    main()
