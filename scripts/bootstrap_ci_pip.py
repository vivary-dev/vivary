"""Seed this CI interpreter from the exact verified pip wheel, without old pip."""

import hashlib
import os
from pathlib import Path
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


def verify_wheel(path):
    plain(path)
    with path.open("rb") as stream:
        data = stream.read(SIZE + 1)
    if len(data) != SIZE or hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError("pip wheel size or SHA256 differs from the reviewed artifact")


def obtain_wheel(cache):
    wheel = cache / WHEEL
    if not wheel.exists():
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                            urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        deadline = time.monotonic() + 30
        with opener.open(urllib.request.Request(URL, headers={"User-Agent": "Vivary-CI-pip-bootstrap"}), timeout=10) as response:
            if response.status != 200 or response.geturl() != URL:
                raise ValueError("unexpected pip wheel response")
            length = response.headers.get("Content-Length")
            if length is not None and length != str(SIZE):
                raise ValueError("unexpected pip wheel response size")
            with wheel.open("xb") as output:
                total = 0
                while True:
                    if time.monotonic() > deadline:
                        raise TimeoutError("pip wheel download exceeded its deadline")
                    chunk = response.read1(min(65536, SIZE + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > SIZE:
                        raise ValueError("pip wheel exceeded its byte bound")
                    output.write(chunk)
    verify_wheel(wheel)
    return wheel


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
        wheel = obtain_wheel(cache)
        environment = child_environment(cache)
        # run_module binds the wheel's __main__.py as argv[0], as with -m pip.
        # Direct wheel/pip execution trips pip's Windows self-modification guard.
        subprocess.run([sys.executable, "-I", "-B", "-c", WHEEL_ENTRY, str(wheel), "install", "--isolated",
                        "--no-index", "--no-deps", "--only-binary=:all:", "--no-cache-dir",
                        "--disable-pip-version-check", "--no-input", "--force-reinstall", str(wheel)],
                       env=environment, cwd=cache, stdin=subprocess.DEVNULL, check=True, timeout=60)
        verify_wheel(wheel)
        print("CI pip 26.2.2 provisioned from the reviewed wheel; actual runtime admission follows")
        return 0
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("CI pip provisioning failed: " + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
