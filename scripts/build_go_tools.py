"""Build matching esbuild, optionally TypeScript, with the pinned Go runtime."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
from types import SimpleNamespace

bootstrap = SimpleNamespace(**runpy.run_path(str(Path(__file__).with_name("bootstrap_build_tools.py"))))

GO_SHA = "ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5"
ESBUILD_SUM = "h1:A2uETn4jrQTcXaT/shwTDTYBxDjl7fV7nXmUrJxfA2w="
ESBUILD_MOD_SUM = "h1:D2vIQZqV/vIf/VRHtViaUtViZmG7o+kKmlBfVQuRi48="
SYS_SUM = "h1:0A+M6Uqn+Eje4kHMK80dtF3JCXC4ykBgQG4Fe06QRhQ="
TS_COMMIT = "2bd066d87f5bafd315be9f40889d0a60b9e58e0b"
TS_MOD_SHA = "8b2c958ea48d9e64a9f2cc960625085e6f220c6679570db78db9cf5114c368c2"
TS_SUM_SHA = "f56e1eb56cc1f61c3801f862a4afa26f4b43295436eb405228bedb0f7e707468"
TS_DECLARATION_SHA = "c4559d41cc101d62086119c3c8c6b00081a540782c65e82c0629fc255073f8ff"
TS_PACKAGE_SRI = "EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A=="


def environment(root):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("GO", "GIT_", "SSL_CERT_"))}
    env.update(GOTOOLCHAIN="local", GOWORK="off", GOENV="off", GOTELEMETRY="off",
               GOPATH=str(root / "go-path"), GOCACHE=str(root / "go-cache"),
               GOPROXY="https://proxy.golang.org", GOSUMDB="sum.golang.org",
               GOFLAGS="-mod=readonly", CGO_ENABLED="0", GOOS="linux", GOARCH="amd64",
               SSL_CERT_FILE=str(root / "ca.pem"), SSL_CERT_DIR=str(root / "empty-ca"),
               GIT_SSL_CAINFO=str(root / "ca.pem"), GIT_SSL_NO_VERIFY="false",
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               XDG_CONFIG_HOME=str(root / "config"))
    return env


def build(root, typescript=False):
    require = bootstrap.require
    archive = bootstrap.download(root, "https://go.dev/dl/go1.26.10.linux-amd64.tar.gz",
                                 "go1.26.10.linux-amd64.tar.gz", "sha256", bytes.fromhex(GO_SHA))
    with tempfile.TemporaryDirectory(prefix="go-stage-", dir=root) as temporary:
        staged = bootstrap.unpack(archive, Path(temporary), "go")
        bootstrap.publish_tree(staged, root / "go")
    go = root / "go/bin/go"
    env = environment(root)

    def command(*args, cwd=root):
        return subprocess.check_output([str(go), *args], env=env, cwd=cwd, text=True, timeout=600)

    require(command("version").strip() == "go version go1.26.10 linux/amd64", "Go identity mismatch")
    source = json.loads(command("mod", "download", "-json", "github.com/evanw/esbuild@v0.28.2"))
    require(source["Sum"] == ESBUILD_SUM and source["GoModSum"] == ESBUILD_MOD_SUM,
            "esbuild source checksum mismatch")
    dependency = json.loads(command("mod", "download", "-json", cwd=source["Dir"]))
    require(dependency["Path"] == "golang.org/x/sys" and dependency["Sum"] == SYS_SUM,
            "Unexpected esbuild dependency")
    command("mod", "verify", cwd=source["Dir"])
    env["GOPROXY"] = "off"
    with tempfile.TemporaryDirectory(prefix="compiler-stage-", dir=root) as temporary:
        stage = Path(temporary)
        binary = stage / "esbuild"
        command("build", "-buildvcs=false", "-p", "2", "-trimpath", "-o", str(binary),
                "./cmd/esbuild", cwd=source["Dir"])
        info = command("version", "-m", str(binary))
        require(": go1.26.10\n" in info, "Unexpected esbuild embedded Go runtime")
        require(subprocess.check_output([str(binary), "--version"], text=True, timeout=10).strip() == "0.28.2",
                "esbuild API version mismatch")
        destination = root / "esbuild-0.28.2-go1.26.10"
        bootstrap.write_exact(destination, binary.read_bytes(), 0o755)
        if typescript:
            env["GOPROXY"] = "https://proxy.golang.org"
            ts = stage / "typescript-source"
            subprocess.run(["git", "clone", "--depth", "1", "--branch", "typescript/v7.0.2",
                            "https://github.com/microsoft/typescript-go.git", str(ts)],
                           env=env, check=True, timeout=180)
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ts, env=env, text=True).strip()
            require(revision == TS_COMMIT, "TypeScript source revision mismatch")
            for name, expected in (("go.mod", TS_MOD_SHA), ("go.sum", TS_SUM_SHA)):
                require(hashlib.sha256((ts / name).read_bytes()).hexdigest() == expected,
                        f"TypeScript {name} checksum mismatch")
            command("mod", "download", cwd=ts)
            command("mod", "verify", cwd=ts)
            env["GOPROXY"] = "off"
            output = stage / "typescript"
            output.mkdir()
            command("build", "-buildvcs=false", "-p", "2", "-tags", "noembed", "-trimpath",
                    "-o", str(output / "tsc"), "./cmd/tsgo", cwd=ts)
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
            info_ts = command("version", "-m", str(output / "tsc"))
            require(": go1.26.10\n" in info_ts, "Unexpected TypeScript embedded Go runtime")
            require(subprocess.check_output([str(output / "tsc"), "--version"], text=True, timeout=10).strip()
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
    bootstrap.certificates(args.root, Path("/etc/ssl/certs/ca-certificates.crt"))
    bootstrap.prepare(args.root)
    build(args.root, args.typescript)


if __name__ == "__main__":
    main()
