"""Native ownership checks for the shared Windows Job scope."""

import ctypes
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vivary_core.windows_process_scope import WindowsProcessScope

pytestmark = pytest.mark.skipif(os.name != "nt", reason="requires native Windows Job semantics")


def test_scope_stops_descendants_with_the_popen_handle_still_held(tmp_path):
    producer = tmp_path / "producer.py"
    producer.write_text(
        "import os, subprocess, sys\n"
        "assert sys.stdin.buffer.read() == b''\n"
        "assert os.environ['PREVIEW_SCOPE_TEST'] == 'preserved'\n"
        "assert os.getcwd() == sys.argv[1]\n"
        "os.write(1, b'raw-out\\x00\\xff\\n')\n"
        "os.write(2, b'raw-err\\x00\\xfe\\n')\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], "
        "stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr)\n"
    )
    scope = WindowsProcessScope.launch(
        [sys.executable, str(producer), str(tmp_path)],
        {**os.environ, "PREVIEW_SCOPE_TEST": "preserved"}, cwd=str(tmp_path),
        stdin=subprocess.DEVNULL, windows_hide=True,
    )
    try:
        assert scope.proc.wait(timeout=5) == 0
        assert getattr(scope.proc, "_handle", None) is not None
        # The parent ended but its pipe-holding descendant remains a live job member.
        with pytest.raises(RuntimeError, match="cleanup timed out"):
            scope.wait_stopped(time.monotonic() + 0.1)
        scope.terminate()
        scope.wait_stopped(time.monotonic() + 3)
        # Keep Popen's native process handle open throughout the accounting query.
        assert getattr(scope.proc, "_handle", None) is not None
        stdout, stderr = scope.proc.communicate(timeout=3)
        assert stdout == b"raw-out\x00\xff\n"
        assert stderr == b"raw-err\x00\xfe\n"
    finally:
        scope.dispose()


def test_failed_assignment_aborts_the_suspended_child_before_it_executes(tmp_path, monkeypatch):
    marker = tmp_path / "must-not-run"
    original_loader = ctypes.WinDLL
    kernel = original_loader("kernel32", use_last_error=True)

    def refuse_assignment(*_args):
        ctypes.set_last_error(5)
        return 0

    kernel.AssignProcessToJobObject = refuse_assignment
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, **options:
                        kernel if name == "kernel32" else original_loader(name, **options))
    original_popen = subprocess.Popen
    started = []

    def observe_popen(*args, **options):
        process = original_popen(*args, **options)
        started.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", observe_popen)
    command = [sys.executable, "-c", "from pathlib import Path; import sys; Path(sys.argv[1]).touch()", str(marker)]
    with pytest.raises(OSError, match="AssignProcessToJobObject"):
        WindowsProcessScope.launch(command, dict(os.environ), stdin=subprocess.DEVNULL, windows_hide=True)
    assert len(started) == 1
    assert started[0].poll() is not None, "the rejected suspended child was reaped"
    assert not marker.exists(), "the child never ran before containment was established"
