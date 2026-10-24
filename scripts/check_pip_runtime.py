"""Network-free admission of the pip installed for this isolated interpreter."""

import importlib
import importlib.metadata
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys


MINIMUM = (26, 2, 2)
CA_POLICY = runpy.run_path(str(Path(__file__).with_name("certifi_bundle.py")))


def refuse(message):
    raise RuntimeError("pip runtime admission: " + message)


def stable_version(value):
    if not isinstance(value, str) or len(value) > 100 or not re.fullmatch(
        r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?", value
    ):
        refuse("a stable major.minor or major.minor.patch pip version is required")
    parts = tuple(map(int, value.split(".")))
    version = parts + (0,) * (3 - len(parts))
    if version < MINIMUM:
        refuse("pip 26.2.2 or later is required before network access")
    return version


def assert_certificate_overrides():
    # Requests consults these even when pip ignores its PIP_* environment.
    # An inherited CURL_CA_BUNDLE is only effective without REQUESTS_CA_BUNDLE.
    overrides = (os.environ.get("PIP_CERT"),
                 os.environ.get("REQUESTS_CA_BUNDLE") or os.environ.get("CURL_CA_BUNDLE"))
    for value in overrides:
        if value is None:
            continue
        path = Path(value)
        try:
            info = path.lstat()
            if (not path.is_absolute() or stat.S_ISLNK(info.st_mode)
                    or getattr(info, "st_file_attributes", 0) & 0x400
                    or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_size > 1024 * 1024):
                refuse("certificate override must be a plain absolute CA file")
            with path.open("rb") as stream:
                digest = hashlib.sha256(stream.read(1024 * 1024 + 1)).hexdigest()
        except OSError:
            refuse("certificate override is unavailable")
        if digest != CA_POLICY["CERTIFI_CA_SHA256"]:
            refuse("certificate override must contain only the qualified certifi bundle")


RISKY_PIP_OPTIONS = ("trusted-host", "index-url", "extra-index-url", "find-links", "client-cert", "cert")


def assert_pip_configuration(configuration_module):
    # Later pip commands run without --isolated, so they read PIP_* variables and pip config
    # files. Load them the way pip does and refuse anything that can change which hosts and
    # indexes pip trusts or which certificate it verifies against. PIP_CERT from the
    # environment is admitted separately, by assert_certificate_overrides.
    # items() yields one (source, values) pair per config file and one for ":env:", and
    # each values dict is keyed by "section.option".
    configuration = configuration_module.Configuration(isolated=False)
    configuration.load()
    for source, values in configuration.items():
        for key in values:
            section, _, option = key.partition(".")
            if option in RISKY_PIP_OPTIONS and not (section == ":env:" and option == "cert"):
                refuse("pip configuration cannot change trusted hosts, indexes or certificates: "
                       + key + " from " + source)


def assert_pip_runtime():
    # Later pip commands must use the same executable, cwd and -I invocation.
    # This check alone cannot admit a differently resolved later interpreter.
    if not sys.flags.isolated:
        refuse("invoke this guard and subsequent pip commands with Python -I")
    executable = Path(sys.executable).resolve(strict=True)
    if not executable.is_file():
        refuse("the executing Python is not a regular file")
    pip = importlib.import_module("pip")
    distribution = importlib.metadata.distribution("pip")
    actual = getattr(pip, "__version__", None)
    if stable_version(actual) != stable_version(distribution.version):
        refuse("loaded pip and installed distribution versions disagree")
    module = Path(pip.__file__).resolve(strict=True)
    expected = Path(distribution.locate_file("pip/__init__.py")).resolve(strict=True)
    main_spec = importlib.util.find_spec("pip.__main__")
    if main_spec is None or main_spec.origin is None:
        refuse("the pip module entrypoint is unavailable")
    main = Path(main_spec.origin).resolve(strict=True)
    expected_main = Path(distribution.locate_file("pip/__main__.py")).resolve(strict=True)
    if module != expected or main != expected_main or not module.is_file() or not main.is_file():
        refuse("loaded pip and its executable module do not match the distribution")
    certifi = importlib.import_module("pip._vendor.certifi")
    certifi_module = Path(certifi.__file__).resolve(strict=True)
    expected_certifi = Path(distribution.locate_file("pip/_vendor/certifi/__init__.py")).resolve(strict=True)
    ca = Path(certifi.where()).resolve(strict=True)
    expected_ca = Path(distribution.locate_file("pip/_vendor/certifi/cacert.pem")).resolve(strict=True)
    if (certifi_module != expected_certifi or ca != expected_ca
            or certifi.__version__ != CA_POLICY["CERTIFI_VERSION"]
            or hashlib.sha256(ca.read_bytes()).hexdigest() != CA_POLICY["CERTIFI_CA_SHA256"]):
        refuse("pip must load the qualified certifi 2026.10.23 bundle from its own distribution")
    assert_certificate_overrides()
    assert_pip_configuration(importlib.import_module("pip._internal.configuration"))
    return {"python": str(executable), "pip": actual, "module": str(module), "main": str(main),
            "certifi": certifi.__version__, "ca": str(ca)}


def main():
    try:
        if len(sys.argv) != 1:
            refuse("this guard accepts no caller-supplied runtime facts or install arguments")
        print(json.dumps(assert_pip_runtime(), sort_keys=True))
        return 0
    except (RuntimeError, ImportError, OSError, ValueError, TypeError, AttributeError) as error:
        message = str(error) if isinstance(error, RuntimeError) else "pip runtime admission: required runtime evidence is unavailable"
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
