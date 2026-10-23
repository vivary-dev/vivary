"""Admit the executing CI Python and its loaded OpenSSL before network use."""

import json
from pathlib import Path
import ssl
import sys


PYTHON = (3, 12, 15, "final", 0)
OPENSSL = ["OpenSSL", "3.5.9"]


def refuse(message):
    raise RuntimeError("Python runtime admission: " + message)


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
        message = str(error) if isinstance(error, RuntimeError) else "Python runtime admission: actual runtime evidence is unavailable"
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
