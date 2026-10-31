"""Pre-JavaScript runner admission, also embedded verbatim in every workflow check_ci_workflow.py admits."""

import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import platform
import re
import stat
import struct
import subprocess
import sys
import threading


# https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
# Checked by the controller on 2026-10-21. CVE-2026-111497 is a Brotli
# out-of-bounds write / RCE on all three lines. This is known-advisory coverage,
# not a zero-vulnerability claim or permission to select another project runtime.
FLOORS = {22: (23, 4), 24: (22, 1), 26: (12, 1)}
MAX_ANCESTORS = 64
PROBE_TIMEOUT = 10
KNOWN_SELECTION_FLAGS = {
    "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24",
    "ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION",
    "ACTIONS_RUNNER_FORCED_INTERNAL_NODE_VERSION",
}


def refuse(message):
    raise RuntimeError("Runner action Node: " + message)


def node_version(value, selected_major=None):
    if not isinstance(value, str) or not re.fullmatch(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value):
        refuse("malformed or prerelease version")
    major, minor, patch = map(int, value.removeprefix("v").split("."))
    if major not in FLOORS or (minor, patch) < FLOORS[major]:
        refuse("EOL, unknown or advisory-affected Node release")
    if selected_major is not None and major != selected_major:
        refuse("the action interpreter must actually be Node 24")
    return f"{major}.{minor}.{patch}"


def check_selection_overrides(environment):
    # Examined runner dispatch leaves explicit node24 on node24 for the known
    # migration flags. Internal-function selection does not select action Node.
    for name, value in environment.items():
        if value and "NODE" in name and name.startswith(("ACTIONS_", "FORCE_JAVASCRIPT_")) and name not in KNOWN_SELECTION_FLAGS:
            refuse("unproved selection override " + name)  # Report names, never values.


def check_host(system, machine, environment, container=False):
    if system not in ("linux", "win32") or machine.lower() not in ("x86_64", "amd64") or struct.calcsize("P") != 8:
        refuse("only native Linux/Windows x64 hosts are supported")
    if environment.get("RUNNER_ARCH", "X64") != "X64" or environment.get("RUNNER_OS", {"linux": "Linux", "win32": "Windows"}[system]) != {"linux": "Linux", "win32": "Windows"}[system]:
        refuse("runner OS/architecture disagrees with the native host")
    if container:
        refuse("container execution is unsupported")
    check_selection_overrides(environment)


def container_host(system):
    if any(os.environ.get(name) for name in ("CONTAINER_SANDBOX_MOUNT_POINT", "DOTNET_RUNNING_IN_CONTAINER", "DOTNET_RUNNING_IN_CONTAINERS")):
        return True
    if system == "linux":
        if any(Path(name).exists() for name in ("/.dockerenv", "/run/.containerenv", "/run/systemd/container")):
            return True
        return bool(re.search(r"docker|kubepods|containerd|lxc", Path("/proc/1/cgroup").read_text()))
    return False


def parse_linux_stat(text):
    pid, separator, rest = text.partition(" (")
    name, closing, tail = rest.rpartition(") ")
    fields = tail.split()
    if not separator or not closing or not pid.isdecimal() or len(fields) < 20 or fields[0] in ("Z", "X"):
        refuse("unreadable Linux process identity")
    try:
        return {"pid": int(pid), "ppid": int(fields[1]), "created": int(fields[19])}
    except ValueError:
        refuse("malformed Linux process identity")


def linux_process(pid):
    folder = Path("/proc") / str(pid)
    before = parse_linux_stat((folder / "stat").read_text())
    executable = os.readlink(folder / "exe")
    after = parse_linux_stat((folder / "stat").read_text())
    if before != after or before["pid"] != pid or executable.endswith(" (deleted)") or not Path(executable).is_absolute():
        refuse("Linux process disappeared, changed or reused its PID")
    return {**before, "exe": str(Path(executable).resolve(strict=True))}


def windows_process(pid):
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")

    class BasicInformation(ctypes.Structure):
        _fields_ = [("reserved", ctypes.c_void_p), ("peb", ctypes.c_void_p),
                    ("reserved2", ctypes.c_void_p * 2), ("pid", ctypes.c_size_t), ("parent", ctypes.c_size_t)]

    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    ntdll.NtQueryInformationProcess.argtypes = [wintypes.HANDLE, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG)]
    ntdll.NtQueryInformationProcess.restype = wintypes.LONG
    handle = kernel.OpenProcess(0x1000 | 0x100000, False, pid)
    if not handle:
        refuse("unreadable Windows process identity")
    try:
        info = BasicInformation()
        size = wintypes.ULONG()
        if ntdll.NtQueryInformationProcess(handle, 0, ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(size)) != 0:
            refuse("Windows parent identity is unavailable")
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            refuse("Windows creation identity is unavailable")
        buffer = ctypes.create_unicode_buffer(32768)
        length = wintypes.DWORD(len(buffer))
        if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)) or info.pid != pid or kernel.WaitForSingleObject(handle, 0) != 258:
            refuse("Windows process disappeared or reused its PID")
        return {"pid": pid, "ppid": int(info.parent), "created": (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime, "exe": buffer.value}
    finally:
        kernel.CloseHandle(handle)


def discover_worker(pid, read_process, system):
    # The nearest owning Worker selects this action's interpreter. Its own
    # service ancestors are outside that execution boundary.
    chain = []
    seen = set()
    paths = PureWindowsPath if system == "win32" else PurePosixPath
    expected = "runner.worker.exe" if system == "win32" else "Runner.Worker"
    worker = None
    while pid:
        if pid in seen or len(chain) >= MAX_ANCESTORS:
            refuse("cyclic or overlong process ancestry")
        seen.add(pid)
        item = read_process(pid)
        if item["pid"] != pid or item["created"] <= 0 or item["ppid"] < 0 or not paths(item["exe"]).is_absolute():
            refuse("missing process identity")
        chain.append(item)
        if item["ppid"] in seen:
            refuse("cyclic or overlong process ancestry")
        name = paths(item["exe"]).name
        if len(chain) > 1 and (name.lower() if system == "win32" else name) == expected:
            runner_paths(item, system)
            worker = item
            break
        pid = item["ppid"]
    if worker is None:
        refuse("an owning Runner.Worker ancestor is required")
    for item in chain:
        if read_process(item["pid"]) != item:
            refuse("ancestry changed or reused a process identity")
    return worker, chain


def runner_paths(worker, system):
    paths = PureWindowsPath if system == "win32" else PurePosixPath
    executable = paths(worker["exe"])
    directory = executable.parent.name.lower() if system == "win32" else executable.parent.name
    if not executable.is_absolute() or directory != "bin" or ".." in executable.parts:
        refuse("Worker is not in the runner root's bin directory")
    root = executable.parent.parent
    node = root / "externals" / "node24" / "bin" / ("node.exe" if system == "win32" else "node")
    return str(root), str(node)


def shared_externals(root, system):
    """Return the directory the runner's externals entry names.

    Hosted Ubuntu images from 20261025 (runner 2.338.0) run the Worker from
    actions-runner/cached/<version>, whose externals entry is a symlink to one
    externals tree that every cached version shares. Admit only that one link,
    only on Linux. The target and the directory holding it must be owned by
    root or the runner account and writable by no other account. Higher
    ancestors need the same owners but may be root-owned and world-writable,
    because the hosted image ships /opt as root-owned mode 0777. A rename there
    changes the target directory's inode, which the repair re-checks before it
    replaces the interpreter. Every path below the target stays plain.
    """
    link = Path(root) / "externals"
    if not stat.S_ISLNK(link.lstat().st_mode):
        return link
    if system == "win32":
        refuse("a linked runner externals directory is admitted only on Linux")
    target = Path(os.readlink(link))
    if not target.is_absolute() or ".." in target.parts or target.name != "externals":
        refuse(f"linked runner externals must name an absolute externals directory "
               f"(absolute={int(target.is_absolute())}, named={int(target.name == 'externals')})")
    if target.resolve(strict=True) != target:
        refuse("linked runner externals must resolve in one step")
    # Report only depth, owner and mode bits, never the path, as plain() does.
    owners = (0, os.geteuid())
    folders = [*reversed(target.parents), target]
    for depth, folder in enumerate(folders):
        info = folder.lstat()
        evidence = f"(depth={depth} of {len(folders) - 1}, uid={info.st_uid}, euid={owners[1]}, mode={info.st_mode & 0xffff})"
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners:
            refuse("linked runner externals must sit in directories owned by root or the runner account " + evidence)
        shared = info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        if shared and not (depth < len(folders) - 2 and info.st_uid == 0):
            refuse("linked runner externals must sit in directories no other account can write " + evidence)
    return target


def selected_interpreter(root, selected, system):
    """The file the Worker executes for node24, through a validated externals link."""
    externals = shared_externals(root, system)
    if externals == Path(root) / "externals":
        return Path(selected)
    interpreter = externals / "node24" / "bin" / "node"
    if Path(selected).resolve(strict=True) != interpreter:
        refuse("the selected interpreter must resolve inside the linked externals directory")
    return interpreter


def binary_x64(file, system):
    with open(file, "rb") as stream:
        header = stream.read(64)
        if system == "linux":
            if len(header) < 20 or header[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", header, 18)[0] != 62:
                refuse("expected a Linux x64 ELF executable")
        else:
            if len(header) != 64 or header[:2] != b"MZ":
                refuse("expected a Windows x64 PE executable")
            offset = struct.unpack_from("<I", header, 60)[0]
            if not 64 <= offset <= 1024 * 1024:
                refuse("malformed PE header")
            stream.seek(offset)
            pe = stream.read(26)
            if len(pe) != 26 or pe[:4] != b"PE\0\0" or struct.unpack_from("<H", pe, 4)[0] != 0x8664 or struct.unpack_from("<H", pe, 24)[0] != 0x20b:
                refuse("expected a Windows x64 PE32+ executable")


def sha256(file):
    digest = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sanitized_environment(system):
    environment = {"LANG": "C", "LC_ALL": "C"}
    if system == "win32":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        buffer = ctypes.create_unicode_buffer(32768)
        length = kernel.GetWindowsDirectoryW(buffer, len(buffer))
        if not 0 < length < len(buffer):
            refuse("Windows directory is unavailable")
        environment["SystemRoot"] = buffer.value
    return environment


def probe_version(executable, environment):
    # Bound output as well as elapsed time, without running any JavaScript guard.
    process = subprocess.Popen([str(executable), "--version"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment,
                               cwd=str(executable.parent), shell=False)
    output = []
    def read_output():
        try:
            output.append(process.stdout.read(129))
        except OSError:
            output.append(b"")
    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    try:
        reader.join(PROBE_TIMEOUT)
        if reader.is_alive() or not output or len(output[0]) > 128:
            refuse("interpreter probe timed out or exceeded its output bound")
        try:
            status = process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            refuse("interpreter probe timed out")
        if status != 0:
            refuse("interpreter probe failed")
        try:
            text = output[0].decode("ascii")
        except UnicodeDecodeError:
            refuse("interpreter probe returned malformed output")
        if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:\r?\n)?", text):
            refuse("interpreter probe returned malformed output")
        return text.rstrip("\r\n")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=2)
        reader.join(2)
        # A failed probe may leave an inherited pipe open. Never block on a
        # buffered close while the bounded daemon reader still owns that pipe.
        if not reader.is_alive():
            process.stdout.close()


def check_runner_action_node():
    system = sys.platform
    check_host(system, platform.machine(), os.environ, container_host(system))
    if system == "win32":
        # Refuse x64 emulation on ARM even when the Python process reports AMD64.
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.IsWow64Process2.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.USHORT), ctypes.POINTER(wintypes.USHORT)]
        process_machine, native_machine = wintypes.USHORT(), wintypes.USHORT()
        if not kernel.IsWow64Process2(kernel.GetCurrentProcess(), ctypes.byref(process_machine), ctypes.byref(native_machine)) or native_machine.value != 0x8664 or process_machine.value not in (0, 0x8664):
            refuse("native Windows x64 identity is required")
    read_process = windows_process if system == "win32" else linux_process
    worker, chain = discover_worker(os.getpid(), read_process, system)
    root, selected = runner_paths(worker, system)
    interpreter = selected_interpreter(root, selected, system)
    if not interpreter.is_file() or os.path.normcase(str(interpreter.resolve(strict=True))) != os.path.normcase(str(interpreter)):
        refuse("missing interpreter or a path outside the discovered runner root")
    binary_x64(worker["exe"], system)
    binary_x64(interpreter, system)
    worker_hash, before = sha256(worker["exe"]), sha256(interpreter)
    version = node_version(probe_version(interpreter, sanitized_environment(system)), selected_major=24)
    if sha256(interpreter) != before or sha256(worker["exe"]) != worker_hash:
        refuse("Worker or interpreter bytes changed during the probe")
    for item in chain:
        if read_process(item["pid"]) != item:
            refuse("Worker ancestry changed or reused a process identity")
    return {"worker": worker, "workerSha256": worker_hash, "root": root,
            "interpreter": str(interpreter), "sha256": before, "version": version,
            "platform": system, "architecture": "x64"}


def admission_failure(error):
    phases = {
        "container_host": "container-detection", "check_host": "host-policy",
        "check_selection_overrides": "selection-policy", "parse_linux_stat": "process-stat",
        "linux_process": "process-identity", "windows_process": "process-identity",
        "discover_worker": "process-ancestry", "runner_paths": "runner-layout",
        "shared_externals": "runner-layout", "selected_interpreter": "runner-layout",
        "binary_x64": "binary-identity", "sha256": "binary-hash",
        "sanitized_environment": "probe-environment", "probe_version": "interpreter-probe",
        "node_version": "interpreter-version",
    }
    phase = "admission"
    observed = None
    trace = error.__traceback__
    while trace is not None:
        frame = trace.tb_frame
        phase = phases.get(frame.f_code.co_name, phase)
        if isinstance(error, RuntimeError) and frame.f_code is node_version.__code__:
            value = frame.f_locals.get("value")
            selected = frame.f_locals.get("selected_major")
            if (type(value) is str and len(value) <= 32 and type(selected) is int and selected == 24
                    and re.fullmatch(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value)):
                observed = value.removeprefix("v")
        trace = trace.tb_next
    detail = f", observedNode={observed}, requiredNode=24.22.1" if observed is not None else ""
    return f"Runner action Node: admission failed (phase={phase}, exception={type(error).__name__}{detail})"


def main():
    try:
        print(json.dumps(check_runner_action_node(), sort_keys=True))
        return 0
    except (RuntimeError, OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError) as error:
        # Report only owned labels and validated numeric versions, never raw exception text.
        print(admission_failure(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
