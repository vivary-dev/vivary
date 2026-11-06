"""Native preview startup cancellation before any approved command can execute."""

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import runpy
import subprocess
import sys
import threading
import time

import pytest

pytestmark = pytest.mark.skipif(os.name != "nt", reason="requires native suspended Windows process creation")


@pytest.mark.parametrize("omit_gate", [False, True], ids=["observed-eof-refuses", "missing-gate-control"])
def test_observed_host_eof_aborts_the_suspended_command_without_execution(tmp_path, monkeypatch, omit_gate):
    bridge = Path(__file__).resolve().parents[1] / "server" / "windows_preview_owner.py"
    owner = runpy.run_path(str(bridge), run_name="preview_owner_test")
    if omit_gate:
        original_launch = owner["WindowsProcessScope"].launch

        def launch_without_gate(*args, **options):
            options.pop("before_resume", None)
            return original_launch(*args, **options)

        monkeypatch.setattr(owner["WindowsProcessScope"], "launch", launch_without_gate)
    read_fd, write_fd = os.pipe()
    os.close(write_fd)
    marker = tmp_path / "must-not-execute"
    started = []
    resumed = []
    original_popen = subprocess.Popen
    original_loader = ctypes.WinDLL
    ntdll = original_loader("ntdll")
    original_resume = ntdll.NtResumeProcess
    original_resume.argtypes = [wintypes.HANDLE]
    original_resume.restype = wintypes.LONG

    def observe_popen(*args, **options):
        process = original_popen(*args, **options)
        started.append(process)
        return process

    def observe_resume(handle):
        resumed.append(handle.value)
        status = original_resume(handle)
        if omit_gate and status == 0:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
        return status

    class ImmediateWatcher:
        def __init__(self, *, target, **_options):
            self.target = target

        def start(self):
            # Read real EOF deterministically before launch, with no timing sleep.
            self.target()

    ntdll.NtResumeProcess = observe_resume
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, **options:
                        ntdll if name == "ntdll" else original_loader(name, **options))
    monkeypatch.setattr(subprocess, "Popen", observe_popen)
    monkeypatch.setattr(threading, "Thread", ImmediateWatcher)
    command = [sys.executable, "-c", "from pathlib import Path; import sys; Path(sys.argv[1]).touch()", str(marker)]
    refusal = None
    with os.fdopen(read_fd, "r") as host_pipe:
        monkeypatch.setattr(sys, "stdin", host_pipe)
        try:
            owner["own_preview"](str(tmp_path), command)
        except OSError as error:
            refusal = error
    assert len(started) == 1, "the check occurs at the actual suspended-launch boundary"
    assert started[0].poll() is not None, "the canceled suspended child was reaped"
    if omit_gate:
        assert refusal is None
        assert len(resumed) == 1 and marker.exists(), "removing the startup gate permits actual command execution"
    else:
        assert resumed == [], "the approved command was never resumed after observed host EOF"
        assert refusal is not None and "Preview host disconnected before command launch" in str(refusal)
        assert not marker.exists(), "the approved command performed no startup side effect"
