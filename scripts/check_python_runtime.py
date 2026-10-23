"""Admit the executing CI Python and its loaded OpenSSL before network use."""

import json
from pathlib import Path
import re
import ssl
import sys


PYTHON = (3, 12, 15, "final", 0)
OPENSSL = ["OpenSSL", "3.5.9"]


class PythonRuntimeRefusal(RuntimeError):
    pass


def refuse(message):
    raise PythonRuntimeRefusal("Python runtime admission: " + message)


def observed_runtime():
    # Emit only bounded runtime version facts, never exception text, paths,
    # environment values, or the remainder of an OpenSSL build description.
    implementation = getattr(getattr(sys, "implementation", None), "name", None)
    if type(implementation) is not str or implementation not in ("cpython", "pypy", "graalpy", "ironpython", "jython", "micropython"):
        implementation = "unknown"
    version = getattr(sys, "version_info", ())
    version = version if isinstance(version, tuple) and len(version) == 5 else (None,) * 5
    numeric = lambda value: str(value) if type(value) is int and 0 <= value <= 9999 else "unknown"
    python = ".".join(numeric(value) for value in version[:3])
    release = version[3] if type(version[3]) is str and version[3] in ("alpha", "beta", "candidate", "final") else "unknown"
    description = getattr(ssl, "OPENSSL_VERSION", None)
    tokens = description.split()[:2] if type(description) is str and len(description) <= 256 else []
    openssl = "unknown"
    if (len(tokens) == 2 and tokens[0] in ("OpenSSL", "LibreSSL", "BoringSSL")
            and re.fullmatch(r"[0-9]{1,4}(?:\.[0-9]{1,4}){1,3}(?:[a-z]|-(?:dev|alpha[0-9]{0,4}|beta[0-9]{0,4}|rc[0-9]{0,4}))?", tokens[1])):
        openssl = " ".join(tokens)
    return (f"observedImplementation={implementation}, observedPython={python}, "
            f"observedRelease={release}, observedSerial={numeric(version[4])}, observedOpenSSL={openssl}")


def assert_python_runtime():
    # Read the current process, never caller-supplied version or environment facts.
    if not sys.flags.isolated or not sys.flags.dont_write_bytecode:
        refuse("invoke this guard with Python -I -B")
    if sys.implementation.name != "cpython" or tuple(sys.version_info) != PYTHON:
        refuse("the qualified CPython 3.12.15 final runtime is required")
    # Match the separately qualified build-tool baseline, including the library
    # actually loaded by ssl rather than an executable's declared dependency.
    if ssl.OPENSSL_VERSION.split()[:2] != OPENSSL:
        refuse("the loaded OpenSSL library must be the qualified 3.5.9 release")
    executable = Path(sys.executable).resolve(strict=True)
    if not executable.is_file():
        refuse("the executing Python must resolve to a regular file")
    return {"python": str(executable), "implementation": "CPython",
            "version": "3.12.15", "openssl": ssl.OPENSSL_VERSION}


def main():
    try:
        if len(sys.argv) != 1:
            refuse("this guard accepts no caller-supplied runtime facts or arguments")
        print(json.dumps(assert_python_runtime(), sort_keys=True))
        return 0
    except (RuntimeError, OSError, ValueError, TypeError, AttributeError) as error:
        message = str(error) if type(error) is PythonRuntimeRefusal else "Python runtime admission: actual runtime evidence is unavailable"
        print(message + " (" + observed_runtime() + ")", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
