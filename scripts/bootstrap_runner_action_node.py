"""Repair only the owning runner's known-affected action Node, then admit it.

Runner externals are an internal compatibility dependency, not a vendor API.
No old Node runs during repair. Unknown bytes get only the unchanged admission.
"""

import ctypes
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile


if "admission" not in globals():
    spec = importlib.util.spec_from_file_location("runner_node_admission", Path(__file__).with_name("check_runner_action_node.py"))
    admission = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(admission)

# New bytes match official runner 2.338.1 and Node 24.22.1; the old allowlist
# contains only Node 24.21.0 from authenticated official runner 2.338.0 archives.
ARTIFACTS = {
    "linux": {
        "url": "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz",
        "size": 32026916,
        "sha256": "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6",
        "member": "node-v24.22.1-linux-x64/bin/node", "node_size": 126879696,
        "node_sha256": "e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb",
        "old_sha256": "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c",
    },
    "win32": {
        "url": "https://nodejs.org/dist/v24.22.1/win-x64/node.exe",
        "size": 93915464, "node_size": 93915464, "member": None,
        "sha256": "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5",
        "node_sha256": "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5",
        "old_sha256": "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
    },
}


class RepairRefusal(RuntimeError):
    pass


def refuse(message):
    raise RepairRefusal("Runner Node repair: " + message)


def filesystem_failure(operation, error):
    code = error.errno if type(error.errno) is int else 0
    windows = getattr(error, "winerror", 0)
    windows = windows if type(windows) is int else 0
    reason = "filesystem-unavailable"
    if code == errno.ETXTBSY:
        reason = "selected-node-busy"
    elif windows in (32, 33):
        reason = "image-sharing-lock"
    elif code in (errno.EACCES, errno.EPERM, errno.EROFS):
        reason = "same-user-write-unavailable"
    return f"{operation}: {reason} (errno={code}, winerror={windows})"


def native_windows():
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.IsWow64Process2.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.USHORT), ctypes.POINTER(wintypes.USHORT)]
    process_machine, native_machine = wintypes.USHORT(), wintypes.USHORT()
    if not kernel.IsWow64Process2(kernel.GetCurrentProcess(), ctypes.byref(process_machine), ctypes.byref(native_machine)) or native_machine.value != 0x8664 or process_machine.value not in (0, 0x8664):
        refuse("native Windows x64 identity is required before repair")


def plain(path, directory=False, role="artifact"):
    # Report only owned role/reason names and numeric filesystem evidence. The
    # unchanged admission also requires the interpreter's canonical spelling.
    if role not in ("root", "externals", "node24", "bin", "interpreter", "worker", "artifact", "stage"):
        role = "artifact"
    try:
        info = path.lstat()
        attributes = getattr(info, "st_file_attributes", 0)
        reason = None
        if stat.S_ISLNK(info.st_mode):
            reason = "symlink"
        elif attributes & 0x400:
            reason = "reparse-point"
        elif not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
            reason = "unexpected-type"
        elif not directory and info.st_nlink != 1:
            reason = "nonexclusive-file-links"
        elif os.path.normcase(str(path.resolve(strict=True))) != os.path.normcase(str(path)):
            reason = "canonical-spelling-mismatch"
    except OSError as error:
        refuse(filesystem_failure("path-" + role, error))
    if reason:
        refuse(f"plain canonical runner paths are required (role={role}, reason={reason}, "
               f"mode={info.st_mode & 0xffff}, attributes={attributes & 0xffffffff}, links={min(info.st_nlink, 0x7fffffff)})")
    return info


def externals_link(root):
    """Identity of a linked runner externals entry, or None for a plain directory."""
    try:
        link = Path(root) / "externals"
        info = link.lstat()
        return (info.st_dev, info.st_ino, os.readlink(link)) if stat.S_ISLNK(info.st_mode) else None
    except OSError as error:
        refuse(filesystem_failure("path-externals", error))


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_nlink)


def context():
    system = sys.platform
    admission.check_host(system, admission.platform.machine(), os.environ, admission.container_host(system))
    if system == "win32":
        native_windows()
    read = admission.windows_process if system == "win32" else admission.linux_process
    worker, chain = admission.discover_worker(os.getpid(), read, system)
    root, selected = admission.runner_paths(worker, system)
    link = externals_link(root)
    # With a linked externals entry, custody covers the shared directory it names.
    try:
        interpreter = admission.selected_interpreter(root, selected, system)
    except RuntimeError as error:
        # These refusals carry fixed text and numeric evidence only, so report them.
        reason = str(error).removeprefix("Runner action Node: ")
        if reason.startswith(("linked runner externals ", "a linked runner externals ", "the selected interpreter must resolve")):
            refuse(reason)
        raise
    folders = [Path(root), interpreter.parent.parent.parent, interpreter.parent.parent, interpreter.parent]
    directories = []
    for role, path in zip(("root", "externals", "node24", "bin"), folders):
        info = plain(path, directory=True, role=role)
        directories.append((path, (info.st_dev, info.st_ino)))
    original = plain(interpreter, role="interpreter")
    if original.st_mode & (stat.S_ISUID | stat.S_ISGID):
        refuse("privileged interpreter modes are not admitted")
    plain(Path(worker["exe"]), role="worker")
    admission.binary_x64(worker["exe"], system)
    admission.binary_x64(interpreter, system)
    result = {"system": system, "worker": worker, "chain": chain, "root": root, "selected": selected,
              "link": link, "interpreter": interpreter, "directories": directories, "original": identity(original),
              "mode": stat.S_IMODE(original.st_mode), "oldSha256": admission.sha256(interpreter),
              "workerSha256": admission.sha256(worker["exe"])}
    verify_context(result, result["oldSha256"])
    return result


def verify_context(current, expected_sha=None):
    system = current["system"]
    read = admission.windows_process if system == "win32" else admission.linux_process
    for item in current["chain"]:
        if read(item["pid"]) != item:
            refuse("Worker ancestry changed")
    if admission.runner_paths(current["worker"], system) != (current["root"], current["selected"]):
        refuse("runner layout changed")
    if (externals_link(current["root"]) != current["link"]
            or admission.selected_interpreter(current["root"], current["selected"], system) != current["interpreter"]):
        refuse("runner externals link changed")
    if admission.sha256(current["worker"]["exe"]) != current["workerSha256"]:
        refuse("Worker bytes changed")
    for role, (path, expected) in zip(("root", "externals", "node24", "bin"), current["directories"]):
        info = plain(path, directory=True, role=role)
        if (info.st_dev, info.st_ino) != expected:
            refuse("runner directory changed")
    info = plain(current["interpreter"], role="interpreter")
    if expected_sha == current["oldSha256"] and identity(info) != current["original"]:
        refuse("original interpreter identity changed")
    if expected_sha is not None and admission.sha256(current["interpreter"]) != expected_sha:
        refuse("selected interpreter bytes changed")
    admission.binary_x64(current["interpreter"], system)


def windows_node_processes():
    from ctypes import wintypes
    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    if handle == ctypes.c_void_p(-1).value:
        refuse("process snapshot unavailable")
    try:
        entry = Entry()
        entry.dwSize = ctypes.sizeof(entry)
        if not kernel.Process32FirstW(handle, ctypes.byref(entry)):
            refuse("process snapshot unreadable")
        while True:
            if entry.szExeFile.lower() == "node.exe":
                yield int(entry.th32ProcessID)
            if not kernel.Process32NextW(handle, ctypes.byref(entry)):
                if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                    refuse("process snapshot incomplete")
                break
    finally:
        kernel.CloseHandle(handle)


def assert_quiescent(current):
    if current["system"] == "linux":
        info = os.fstat(current["lease"])
        if (info.st_dev, info.st_ino) != current["original"][:2]:
            refuse("the original Node write lease changed")
    else:
        for pid in windows_node_processes():
            try:
                process = admission.windows_process(pid)
            except (OSError, RuntimeError):
                refuse("a potential Node process cannot be inspected")
            if os.path.normcase(process["exe"]) == os.path.normcase(str(current["interpreter"])):
                refuse("the selected Node is still running")


def acquire_write_lease(current):
    # Linux refuses O_WRONLY with ETXTBSY for an executing inode. Holding this
    # non-truncating descriptor also prevents new execs of the old inode across
    # rename, for every UID, without depending on /proc visibility.
    try:
        descriptor = os.open(current["interpreter"], os.O_WRONLY | os.O_NOFOLLOW)
    except OSError as error:
        refuse(filesystem_failure("write-lease", error))
    try:
        if identity(os.fstat(descriptor)) != current["original"]:
            refuse("the original Node changed before its write lease")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def curl_path():
    if sys.platform == "linux":
        return "/usr/bin/curl"
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    directory = ctypes.create_unicode_buffer(32768)
    length = kernel.GetWindowsDirectoryW(directory, len(directory))
    if not 0 < length < len(directory):
        refuse("native Windows directory is unavailable")
    return str(Path(directory.value) / "System32/curl.exe")


def download(artifact, path):
    # Preserve the host's existing TLS/proxy policy; discard executable injection
    # and user curl configuration without logging environment or curl diagnostics.
    keep = {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
            "https_proxy", "http_proxy", "all_proxy", "no_proxy", "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"}
    environment = {key: value for key, value in os.environ.items() if key in keep}
    before = identity(plain(path))
    try:
        subprocess.run([curl_path(), "--disable", "--fail", "--silent", "--show-error",
                        "--proto", "=https", "--proto-redir", "=https", "--location", "--max-redirs", "0",
                        "--connect-timeout", "10", "--max-time", "90", "--max-filesize", str(artifact["size"]),
                        "--output", str(path), artifact["url"]], env=environment, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=95, check=True)
    except subprocess.CalledProcessError as error:
        refuse("download failed (curlReturnCode=" + str(error.returncode) + ")")
    except subprocess.TimeoutExpired:
        refuse("download exceeded its deadline")
    after = plain(path)
    if (after.st_dev, after.st_ino) != before[:2] or after.st_size != artifact["size"] or admission.sha256(path) != artifact["sha256"]:
        refuse("download size, identity or SHA256 mismatch")


def stage_node(artifact, downloaded, node_dir, mode):
    if plain(downloaded).st_size != artifact["size"] or admission.sha256(downloaded) != artifact["sha256"]:
        refuse("artifact must be authenticated before parsing")
    fd, name = tempfile.mkstemp(prefix=".vivary-node-stage-", dir=node_dir)
    staged = Path(name)
    try:
        with os.fdopen(fd, "wb") as output:
            if artifact["member"] is None:
                with downloaded.open("rb") as source:
                    copy_node(source, output, artifact)
            else:
                with tarfile.open(downloaded, "r:xz") as archive:
                    matches = [item for item in archive if item.name == artifact["member"]]
                    if len(matches) != 1 or not matches[0].isreg() or matches[0].size != artifact["node_size"]:
                        refuse("one exact regular Node archive member is required")
                    with archive.extractfile(matches[0]) as source:
                        copy_node(source, output, artifact)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(staged, mode & 0o777)
        if admission.sha256(staged) != artifact["node_sha256"]:
            refuse("staged Node SHA256 mismatch")
        admission.binary_x64(staged, sys.platform)
        plain(staged, role="stage")
        return staged
    except BaseException:
        staged.unlink(missing_ok=True)
        raise


def copy_node(source, output, artifact):
    total = 0
    while True:
        chunk = source.read(min(65536, artifact["node_size"] + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > artifact["node_size"]:
            refuse("Node member exceeded its exact byte bound")
        output.write(chunk)
    if total != artifact["node_size"]:
        refuse("Node member is incomplete")


def repair_runner_action_node():
    current = context()
    artifact = ARTIFACTS[current["system"]]
    outcome = "already-qualified"
    staged = None
    lease = None
    try:
        if current["oldSha256"] not in (artifact["node_sha256"], artifact["old_sha256"]):
            # Preserve future patched workers without blindly downgrading unknown bytes.
            outcome = "admitted-unmodified"
        elif current["oldSha256"] == artifact["old_sha256"]:
            if current["system"] == "linux":
                lease = current["lease"] = acquire_write_lease(current)
            assert_quiescent(current)
            with tempfile.TemporaryDirectory(prefix="vivary-runner-node-") as directory:
                # Windows TEMP may use a short alias. Resolve only this newly
                # owned temporary root; runner paths retain their custody checks.
                downloaded = Path(directory).resolve(strict=True) / "artifact"
                with downloaded.open("xb"):
                    pass
                downloaded.chmod(0o600)
                download(artifact, downloaded)
                staged = stage_node(artifact, downloaded, current["interpreter"].parent, current["mode"])
                staged_identity = identity(plain(staged, role="stage"))
                verify_context(current, current["oldSha256"])
                assert_quiescent(current)
                if identity(plain(staged, role="stage")) != staged_identity or admission.sha256(staged) != artifact["node_sha256"]:
                    refuse("staged interpreter changed before replacement")
                verify_context(current, current["oldSha256"])
                try:
                    os.replace(staged, current["interpreter"])
                except OSError as error:
                    refuse(filesystem_failure("atomic-replacement", error))
                staged = None
                verify_context(current, artifact["node_sha256"])
                assert_quiescent(current)
                outcome = "repaired"
        # Full, unchanged admission independently rediscovers and probes this same Node.
        result = admission.check_runner_action_node()
        result["repair"] = {"outcome": outcome, "previousSha256": current["oldSha256"],
                            "artifact": artifact["url"] if outcome == "repaired" else None,
                            "artifactSha256": artifact["sha256"] if outcome == "repaired" else None}
        return result
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
        if lease is not None:
            os.close(lease)


def main():
    try:
        if len(sys.argv) != 1:
            refuse("arguments and caller-supplied runtime facts are not admitted")
        print(json.dumps(repair_runner_action_node(), sort_keys=True))
        return 0
    except (RuntimeError, OSError, ValueError, TypeError, KeyError, AttributeError, tarfile.TarError, subprocess.SubprocessError) as error:
        if type(error) is RepairRefusal:
            message = str(error)
        elif isinstance(error, RuntimeError):
            message = admission.admission_failure(error)
        elif isinstance(error, OSError):
            message = "Runner Node repair: " + filesystem_failure("filesystem", error)
        else:
            message = "Runner Node repair: refused (exception=" + type(error).__name__ + ")"
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
