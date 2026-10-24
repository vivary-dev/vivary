"""Seed this CI interpreter from the exact verified pip wheel, without old pip."""

import hashlib
import os
from pathlib import Path
import runpy
import ssl
import stat
import subprocess
import sys
import time
import urllib.request


WHEEL = "pip-26.2.2-py3-none-any.whl"
URL = "https://files.pythonhosted.org/packages/3f/06/3e4420302363fbb71be3c7f35ce042f54bfca330e3e66b3a2e3c4cca579f/" + WHEEL
SIZE = 1819850
SHA256 = "fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"
CA_POLICY = runpy.run_path(str(Path(__file__).with_name("certifi_bundle.py")))

# Match python -m pip entry semantics while importing only the verified wheel.
WHEEL_ENTRY = (
    "import runpy,sys\n"
    "if any(name == 'pip' or name.startswith('pip.') for name in sys.modules):\n"
    " raise RuntimeError('pip was loaded before the verified wheel')\n"
    "sys.path.insert(0,sys.argv.pop(1))\n"
    "runpy.run_module('pip',run_name='__main__',alter_sys=True)\n"
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        raise ValueError("pip wheel redirects are not admitted")


def plain(path, directory=False):
    info = path.lstat()
    if (stat.S_ISLNK(info.st_mode)
            or getattr(info, "st_file_attributes", 0) & 0x400
            or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or (not directory and info.st_nlink != 1)):
        raise ValueError("pip bootstrap requires plain private paths")


def verify_wheel(path, size=None, digest=None):
    size = SIZE if size is None else size
    digest = SHA256 if digest is None else digest
    plain(path)
    with path.open("rb") as stream:
        data = stream.read(size + 1)
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("pip wheel size or SHA256 differs from the reviewed artifact")


def obtain_wheel(cache):
    return obtain_artifact(cache, WHEEL, URL, SIZE, SHA256)


def download_context():
    if "SSL_CERT_FILE" not in os.environ:
        return ssl.create_default_context()
    bundle = Path(os.environ["SSL_CERT_FILE"])
    plain(bundle)
    if bundle.read_bytes() != CA_POLICY["host_ca_bytes"]():
        raise ValueError("pip download CA differs from the eligible filtered host anchors")
    # Supplying cafile prevents Windows load_default_certs from adding ROOT/CA
    # stores to the already filtered, task-local trust anchors.
    return ssl.create_default_context(cafile=str(bundle))


def obtain_artifact(cache, filename, url, size, digest):
    wheel = cache / filename
    if not wheel.exists():
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                            urllib.request.HTTPSHandler(context=download_context()))
        deadline = time.monotonic() + 30
        with opener.open(urllib.request.Request(url, headers={"User-Agent": "Vivary-CI-pip-bootstrap"}), timeout=10) as response:
            if response.status != 200 or response.geturl() != url:
                raise ValueError("unexpected pip wheel response")
            length = response.headers.get("Content-Length")
            if length is not None and length != str(size):
                raise ValueError("unexpected pip wheel response size")
            with wheel.open("xb") as output:
                total = 0
                while True:
                    if time.monotonic() > deadline:
                        raise TimeoutError("pip wheel download exceeded its deadline")
                    chunk = response.read1(min(65536, size + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > size:
                        raise ValueError("pip wheel exceeded its byte bound")
                    output.write(chunk)
    verify_wheel(wheel, size, digest)
    return wheel


def obtain_derived_pip(cache, upstream):
    certifi = obtain_artifact(cache, CA_POLICY["CERTIFI_WHEEL"], CA_POLICY["CERTIFI_URL"],
                             CA_POLICY["CERTIFI_SIZE"], CA_POLICY["CERTIFI_SHA256"])
    derived = cache / "certifi-2026.10.23"
    derived.mkdir(mode=0o700, exist_ok=True)
    plain(derived, directory=True)
    return CA_POLICY["prepare_pip"](upstream, certifi, derived / WHEEL)


def child_environment(cache):
    private = cache / "private-state"
    private.mkdir(mode=0o700, exist_ok=True)
    plain(private, directory=True)
    environment = {name: os.environ[name] for name in ("SYSTEMROOT", "WINDIR") if name in os.environ}
    environment.update(PATH=str(Path(sys.executable).parent), HOME=str(private), USERPROFILE=str(private),
                       TEMP=str(private), TMP=str(private), XDG_CONFIG_HOME=str(private),
                       XDG_CACHE_HOME=str(private), PIP_CONFIG_FILE=os.devnull)
    return environment


def main():
    try:
        if sys.argv[1:] or sys.platform not in ("linux", "win32"):
            raise ValueError("only the selected Linux/Windows CI interpreter is supported")
        temporary = Path(os.environ["RUNNER_TEMP"])
        if not temporary.is_absolute():
            raise ValueError("an absolute private runner temporary directory is required")
        plain(temporary, directory=True)
        cache = temporary / "vivary-pip-26.2.2"
        cache.mkdir(mode=0o700, exist_ok=True)
        plain(cache, directory=True)
        upstream = obtain_wheel(cache)
        wheel = obtain_derived_pip(cache, upstream)
        environment = child_environment(cache)
        # run_module binds the wheel's __main__.py as argv[0], as with -m pip.
        # Direct wheel/pip execution trips pip's Windows self-modification guard.
        subprocess.run([sys.executable, "-I", "-B", "-c", WHEEL_ENTRY, str(wheel), "install", "--isolated",
                        "--no-index", "--no-deps", "--only-binary=:all:", "--no-cache-dir",
                        "--disable-pip-version-check", "--no-input", "--force-reinstall", str(wheel)],
                       env=environment, cwd=cache, stdin=subprocess.DEVNULL, check=True, timeout=60)
        # Re-derive and compare, rather than treating locally changed bytes as an
        # upstream pip release. Runtime admission checks the installed copy next.
        obtain_derived_pip(cache, upstream)
        print("CI pip 26.2.2 provisioned with authenticated certifi 2026.10.23 overlay; actual runtime admission follows")
        return 0
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("CI pip provisioning failed: " + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
