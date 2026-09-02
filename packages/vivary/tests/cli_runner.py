"""One pinned subprocess runner for the Vivary command-line suites.

Both suites compare recorded output byte for byte, so the environment they run
under has to be identical and free of whatever the caller's shell carries.
"""

import os
import subprocess
import sys


def pinned_env(extra_paths: tuple[str, ...] = ()) -> dict[str, str]:
    env = dict(os.environ)
    env.pop("VIVARY_RECEIPT_LOG", None)
    env.pop("PYTHONWARNINGS", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["COLUMNS"] = "80"
    if extra_paths:
        env["PYTHONPATH"] = os.pathsep.join(extra_paths)
    else:
        env.pop("PYTHONPATH", None)
    return env


def run_cli(
    argv: list[str], cwd: str, extra_paths: tuple[str, ...] = ()
) -> tuple[int, str, str]:
    completed = subprocess.run(
        [sys.executable, *argv],
        cwd=cwd,
        env=pinned_env(extra_paths),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        encoding="utf-8",
        check=False,
        timeout=120,
    )
    return completed.returncode, completed.stdout, completed.stderr
