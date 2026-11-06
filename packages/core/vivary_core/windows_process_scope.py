"""Windows process-tree containment shared by commands and desktop previews."""

from __future__ import annotations

from contextlib import suppress
import subprocess
import threading
import time
from typing import Any, Callable, Dict, List, Optional

_SUBPROCESS_CLEANUP_TIMEOUT = 2.0
_SUBPROCESS_POLL_SECONDS = 0.05


def _close_parent_pipe(pipe: Any) -> None:
    """Best-effort close for a parent-owned pipe endpoint."""
    if pipe is not None:
        with suppress(OSError, ValueError):
            pipe.close()


def _reap_direct_child(
    proc: Any,
    deadline: float,
) -> tuple[Optional[int], Optional[Exception]]:
    """Boundedly reap the direct child after its containing scope is stopped."""
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            code = proc.wait(timeout=min(_SUBPROCESS_POLL_SECONDS, remaining))
        except subprocess.TimeoutExpired:
            continue
        except OSError as error:
            return getattr(proc, "returncode", None), error
        if code is not None:
            return code, None
        code = getattr(proc, "returncode", None)
        if code is not None:
            return code, None
        time.sleep(min(_SUBPROCESS_POLL_SECONDS, remaining))
    return (
        getattr(proc, "returncode", None),
        RuntimeError("direct child reap timed out"),
    )


def _abort_uncontained_child(proc: Any) -> Optional[str]:
    """Boundedly stop a child when Windows Job assignment itself failed."""
    details: List[str] = []
    with suppress(OSError, ValueError):
        proc.kill()
    code, error = _reap_direct_child(
        proc,
        time.monotonic() + _SUBPROCESS_CLEANUP_TIMEOUT,
    )
    if error is not None:
        details.append(str(error))
    if code is None:
        details.append("direct child was not reaped")
    for pipe in (
        getattr(proc, "stdin", None),
        getattr(proc, "stdout", None),
        getattr(proc, "stderr", None),
    ):
        _close_parent_pipe(pipe)
    return "; ".join(details) or None


class WindowsProcessScope:
    """A Job Object process scope configured to kill every member on close."""

    def __init__(
        self,
        proc: Any,
        terminate_job: Callable[[], None],
        wait_job: Callable[[float], None],
        close_job: Callable[[], None],
    ) -> None:
        self.proc = proc
        self._terminate_job = terminate_job
        self._wait_job = wait_job
        self._close_job = close_job
        self._terminated = False
        self._disposed = False
        self._lock = threading.Lock()

    @classmethod
    def launch(
        cls,
        argv: List[str],
        env: Dict[str, str],
        *,
        cwd: Optional[str] = None,
        stdin: Any = None,
        stdout: Any = subprocess.PIPE,
        stderr: Any = subprocess.PIPE,
        windows_hide: bool = False,
        before_resume: Optional[Callable[[], None]] = None,
    ) -> "WindowsProcessScope":
        import ctypes
        from ctypes import wintypes

        class _BasicAccountingInformation(ctypes.Structure):
            _fields_ = [
                ("TotalUserTime", ctypes.c_longlong),
                ("TotalKernelTime", ctypes.c_longlong),
                ("ThisPeriodTotalUserTime", ctypes.c_longlong),
                ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
                ("TotalPageFaultCount", wintypes.DWORD),
                ("TotalProcesses", wintypes.DWORD),
                ("ActiveProcesses", wintypes.DWORD),
                ("TotalTerminatedProcesses", wintypes.DWORD),
            ]

        class _BasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class _ExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BasicLimitInformation),
                ("IoInfo", _IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [
            wintypes.HANDLE,
            wintypes.HANDLE,
        ]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.QueryInformationJobObject.restype = wintypes.BOOL
        ntdll = ctypes.WinDLL("ntdll")
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        ntdll.NtResumeProcess.restype = wintypes.LONG

        def last_error(action: str) -> OSError:
            error_code = ctypes.get_last_error()
            detail = ctypes.FormatError(error_code).strip() if error_code else action
            return OSError(error_code, f"{action}: {detail}")

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise OSError(f"process containment setup failed: {last_error('CreateJobObjectW')}")
        try:
            limits = _ExtendedLimitInformation()
            limits.BasicLimitInformation.LimitFlags = 0x00002000
            if not kernel32.SetInformationJobObject(
                job,
                9,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ):
                raise last_error("SetInformationJobObject")
        except BaseException as error:
            kernel32.CloseHandle(job)
            raise OSError(f"process containment setup failed: {error}") from error

        try:
            startup = None
            if windows_hide:
                startup = subprocess.STARTUPINFO()
                startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startup.wShowWindow = subprocess.SW_HIDE
            proc = subprocess.Popen(
                argv, cwd=cwd, env=env, stdin=stdin, stdout=stdout, stderr=stderr,
                startupinfo=startup,
                creationflags=(
                    getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                    | 0x00000004  # CREATE_SUSPENDED
                ),
            )
        except BaseException:
            kernel32.CloseHandle(job)
            raise

        try:
            process_handle = getattr(proc, "_handle", None)
            if process_handle is None:
                raise OSError("Popen did not expose a Windows process handle")
            if not kernel32.AssignProcessToJobObject(
                job,
                wintypes.HANDLE(int(process_handle)),
            ):
                raise last_error("AssignProcessToJobObject")
            if before_resume is not None:
                before_resume()
            status = ntdll.NtResumeProcess(wintypes.HANDLE(int(process_handle)))
            if status != 0:
                raise OSError(
                    int(status),
                    f"NtResumeProcess failed with NTSTATUS 0x{int(status) & 0xFFFFFFFF:08x}",
                )
        except BaseException as error:
            cleanup_error = _abort_uncontained_child(proc)
            kernel32.CloseHandle(job)
            suffix = f"; {cleanup_error}" if cleanup_error else ""
            raise OSError(
                f"process containment setup failed: {error}{suffix}"
            ) from error

        def terminate_job() -> None:
            if not kernel32.TerminateJobObject(job, 1):
                raise last_error("TerminateJobObject")

        def wait_job(deadline: float) -> None:
            # A job handle signals time-limit termination, not ordinary emptiness.
            # Query the kernel's active member count while retaining the job handle.
            accounting = _BasicAccountingInformation()
            while True:
                if not kernel32.QueryInformationJobObject(
                    job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None,
                ):
                    raise last_error("QueryInformationJobObject")
                if accounting.ActiveProcesses == 0:
                    return
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Windows process job cleanup timed out")
                time.sleep(min(_SUBPROCESS_POLL_SECONDS, remaining))

        def close_job() -> None:
            if not kernel32.CloseHandle(job):
                raise last_error("CloseHandle")

        return cls(proc, terminate_job, wait_job, close_job)

    def terminate(self) -> None:
        with self._lock:
            if self._disposed or self._terminated:
                return
            self._terminate_job()
            self._terminated = True

    def wait_stopped(self, deadline: float) -> None:
        self._wait_job(deadline)

    def dispose(self) -> None:
        with self._lock:
            if self._disposed:
                return
            self._disposed = True
            self._close_job()
