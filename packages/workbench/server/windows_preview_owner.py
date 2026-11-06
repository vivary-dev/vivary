"""Own one Windows preview job until the command exits or its host pipe closes."""

import os
from pathlib import Path
import subprocess
import sys
import threading
import time

# Source execution uses its checkout. Packaged execution uses the installed Core wheel.
source = Path(__file__).resolve().parents[3] / "packages" / "core"
if (source / "vivary_core" / "windows_process_scope.py").is_file():
    sys.path.insert(0, str(source))
from vivary_core.windows_process_scope import WindowsProcessScope

CLEANUP_SECONDS = 3.0


def own_preview(cwd, argv):
    if os.name != "nt" or not os.path.isabs(cwd) or not argv:
        raise ValueError("Windows preview ownership requires an absolute folder and a command")
    stopped = threading.Event()
    pipe_failed = threading.Event()

    def watch_host():
        try:
            # No messages are accepted. Only this owner's parent holds the write end.
            if os.read(sys.stdin.fileno(), 1):
                pipe_failed.set()
        except (OSError, ValueError):
            pipe_failed.set()
        finally:
            stopped.set()

    def before_resume():
        if stopped.is_set():
            raise RuntimeError("Preview host disconnected before command launch")

    threading.Thread(target=watch_host, daemon=True, name="preview-host-lifetime").start()
    scope = WindowsProcessScope.launch(
        argv, dict(os.environ), cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=sys.stdout, stderr=sys.stderr, windows_hide=True,
        before_resume=before_resume,
    )
    command_code = None
    try:
        while not stopped.is_set():
            command_code = scope.proc.poll()
            if command_code is not None:
                break
            stopped.wait(0.05)
        deadline = time.monotonic() + CLEANUP_SECONDS
        scope.terminate()
        scope.proc.wait(timeout=max(0.01, deadline - time.monotonic()))
        scope.wait_stopped(deadline)
    finally:
        scope.dispose()
    if pipe_failed.is_set():
        raise RuntimeError("Preview host lifetime pipe failed")
    if command_code not in (None, 0):
        print(f"[vivary-preview-owner] Approved command exited with status {command_code}.", file=sys.stderr)
    # The owner reports containment cleanup, not the package command's exit status.
    return 0


if __name__ == "__main__":
    try:
        if len(sys.argv) < 3:
            raise ValueError("Preview owner requires a folder and command")
        code = own_preview(sys.argv[1], sys.argv[2:])
    except Exception as error:
        print(f"[vivary-preview-owner] {error}", file=sys.stderr)
        code = 1
    raise SystemExit(code)
