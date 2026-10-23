"""Network-free admission of the pip installed for this isolated interpreter."""

import importlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import re
import sys


MINIMUM = (26, 2, 2)


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
    return {"python": str(executable), "pip": actual, "module": str(module), "main": str(main)}


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
