import importlib.util
import re
from pathlib import Path


WORKFLOW = Path(".github/workflows/ci.yml")
REVIEW_WORKFLOW = Path(".github/workflows/review-gate.yml")
ARTIFACT_CHECKER = Path("scripts/check_release_artifacts.py")


def release_build_commands() -> tuple[str, ...]:
    """One admitted uv build per Python distribution the release checker verifies."""
    spec = importlib.util.spec_from_file_location("release_artifacts", ARTIFACT_CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return tuple(
        f'"$uv" build --out-dir "$artifacts" packages/{package}'
        for package, _ in module.PYTHON_CANDIDATES
    )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"{WORKFLOW}: {message}")


# The required review gate workflow must match this text exactly, so no extra step, job,
# trigger or condition can weaken it unnoticed. Change both together, with owner review.
CANONICAL_REVIEW_WORKFLOW = r'''name: review gate

# The required review gate runs only for pull requests, so pushes to long-lived
# branches never publish its check. It runs the gate script from the pull request's
# base commit, so edits to that script take effect only after review and merge.
# Only while the base has no gate script does it fetch and run the script from the
# commit pinned below. For PR #193, which introduced the gate, that is its own reviewed
# commit; after that merge it is in dev's history, and main uses it until main has the script.
# A pull request can still edit this workflow file, so .github changes need owner review.
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]

concurrency:
  group: review-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: read
  issues: read

jobs:
  review-gate:
    name: required review gate
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - &runner_action_node_bootstrap
        name: runner action Node admission
        id: runner_action_node
        shell: python -I -B {0}
        run: |
          """Pre-JavaScript runner admission, also embedded verbatim in both workflows."""

          import ctypes
          import hashlib
          import json
          import os
          from pathlib import Path, PurePosixPath, PureWindowsPath
          import platform
          import re
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
              chain = []
              seen = set()
              paths = PureWindowsPath if system == "win32" else PurePosixPath
              while pid:
                  if pid in seen or len(chain) >= MAX_ANCESTORS:
                      refuse("cyclic or overlong process ancestry")
                  seen.add(pid)
                  item = read_process(pid)
                  if item["pid"] != pid or item["created"] <= 0 or item["ppid"] < 0 or not paths(item["exe"]).is_absolute():
                      refuse("missing process identity")
                  chain.append(item)
                  pid = item["ppid"]
              expected = "runner.worker.exe" if system == "win32" else "Runner.Worker"
              workers = [item for item in chain[1:] if (paths(item["exe"]).name.lower() if system == "win32" else paths(item["exe"]).name) == expected]
              if len(workers) != 1:
                  refuse("exactly one Runner.Worker ancestor is required")
              for item in chain:
                  if read_process(item["pid"]) != item:
                      refuse("ancestry changed or reused a process identity")
              return workers[0], chain


          def runner_paths(worker, system):
              paths = PureWindowsPath if system == "win32" else PurePosixPath
              executable = paths(worker["exe"])
              directory = executable.parent.name.lower() if system == "win32" else executable.parent.name
              if not executable.is_absolute() or directory != "bin" or ".." in executable.parts:
                  refuse("Worker is not in the runner root's bin directory")
              root = executable.parent.parent
              node = root / "externals" / "node24" / "bin" / ("node.exe" if system == "win32" else "node")
              return str(root), str(node)


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
              interpreter = Path(selected)
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


          def main():
              try:
                  print(json.dumps(check_runner_action_node(), sort_keys=True))
                  return 0
              except (RuntimeError, OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError) as error:
                  # No environment values or command arguments are recorded.
                  print(str(error) if isinstance(error, RuntimeError) else "Runner action Node: required metadata or interpreter evidence is unavailable", file=sys.stderr)
                  return 1


          if __name__ == "__main__":
              sys.exit(main())
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: base
          persist-credentials: false
      - name: find the base commit's gate script
        id: base
        run: |
          if [ -f base/scripts/check_review_gate.py ]; then
            echo "missing=false" >> "$GITHUB_OUTPUT"
          else
            echo "missing=true" >> "$GITHUB_OUTPUT"
          fi
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        if: ${{ steps.base.outputs.missing == 'true' && steps.runner_action_node.outcome == 'success' }}
        with:
          ref: 80370e094248c84c55da663d977efc7601d17e84
          path: bootstrap
          persist-credentials: false
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97
        with:
          python-version: "3.11"
      - name: wait for completed reviews and resolved threads
        env:
          GH_TOKEN: ${{ github.token }}
          REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          gate=base/scripts/check_review_gate.py
          if [ ! -f "$gate" ]; then
            echo "required review gate: base has no gate script; using the pinned bootstrap script"
            gate=bootstrap/scripts/check_review_gate.py
          fi
          python "$gate" --wait-seconds 2400 --interval 30
'''


def check_review_workflow(text: str) -> None:
    """The required review gate workflow is exactly the reviewed canonical text."""
    if text != CANONICAL_REVIEW_WORKFLOW:
        raise SystemExit(f"{REVIEW_WORKFLOW}: must match the canonical required review gate workflow "
                         "in scripts/check_ci_workflow.py (pull requests only, base-revision or pinned bootstrap script, real wait)")
    check_runner_action_bootstrap(text, ("review-gate",), auxiliary=True)


def job_block(text: str, name: str) -> str:
    """Return one top-level job without accepting commands from later jobs."""
    jobs_marker = "\njobs:\n"
    require(jobs_marker in text, "workflow must declare jobs")
    jobs = text[text.index(jobs_marker) + len(jobs_marker) :]
    headers = list(re.finditer(r"(?m)^  ([A-Za-z0-9_-]+):\s*$", jobs))
    matches = [index for index, match in enumerate(headers) if match.group(1) == name]
    require(len(matches) == 1, f"workflow must declare exactly one {name} job")

    index = matches[0]
    start = headers[index].start()
    end = headers[index + 1].start() if index + 1 < len(headers) else len(jobs)
    return jobs[start:end]


NODE_GUARD = "node packages/workbench/bin/runtime-security.mjs"
NODE_JOBS = ("test", "workbench", "workbench-maintained", "governed-platform-proof", "orientation-proof", "site")
CI_JOBS = ("changes", "test", "workbench", "workbench-maintained", "governed-platform-proof", "orientation-proof", "review", "site")
RUNNER_BOOTSTRAP = Path(__file__).resolve().with_name("check_runner_action_node.py")
BOOTSTRAP_ANCHOR = "runner_action_node_bootstrap"
BOOTSTRAP_ALIAS = "      - *" + BOOTSTRAP_ANCHOR + "\n"

# Official manifests examined by the controller, not mutable release tags.
# Runner dispatch source 197ca027b90de199464dee3bb9ff198a1db60967:
# NodeScriptActionHandler.cs:116-118 selects externals/node24/bin/node.
# JobExtension.cs:325-330 prepares pre steps before workflow steps, so no-pre
# is essential to the first-step admission argument, including post actions.
ACTION_MANIFESTS = {
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1": {"using": "node24", "main": "dist/index.js", "post": "dist/index.js"},
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97": {"using": "node24", "main": "dist/setup/index.js", "post": "dist/cache-save/index.js"},
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1": {"using": "node24", "main": "dist/setup/index.js", "post": "dist/cache-save/index.js"},
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020": {"using": "node24", "main": "dist/setup/index.js", "post": "dist/cache-save/index.js"},
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9": {"using": "node24", "main": "dist/upload/index.js"},
}


def validate_action_manifest(reference: str, runs: dict) -> None:
    require(reference in ACTION_MANIFESTS, "unproved or mutable action identity: " + reference)
    require(runs == ACTION_MANIFESTS[reference] and "pre" not in runs and runs.get("using") == "node24",
            "action main/post/no-pre metadata mismatch: " + reference)


def runner_bootstrap_step() -> str:
    source = RUNNER_BOOTSTRAP.read_text(encoding="utf-8").replace("\r\n", "\n")
    require(source.endswith("\n") and "\r" not in source, "canonical runner bootstrap must use LF and a final newline")
    return ("      - &" + BOOTSTRAP_ANCHOR + "\n"
            "        name: runner action Node admission\n"
            "        id: runner_action_node\n"
            "        shell: python -I -B {0}\n"
            "        run: |\n" + "".join("          " + line + "\n" if line else "\n" for line in source.splitlines()))


def check_runner_action_bootstrap(text: str, names: tuple[str, ...], npm=False, auxiliary=False) -> None:
    if auxiliary:
        require(not npm and names in (("review-gate",), ("daily-health-check",), ("snapshot",)),
                "auxiliary bootstrap requires an exact owned job inventory")
    jobs = text.split("\njobs:\n", 1)[-1]
    headers = re.findall(r"(?m)^  ([\w-]+):\s*$", jobs)
    require(tuple(headers) == names, "runner bootstrap must cover the exact job inventory")
    canonical = runner_bootstrap_step().rstrip("\n")
    require(len(re.findall(r"(?m)^      - &", jobs)) == 1, "exactly one complete bootstrap mapping anchor is required")
    total_uses = 0
    for index, name in enumerate(names):
        job = job_block(text, name)
        header = job.split("    steps:", 1)[0]
        require(not re.search(r"(?m)^\s+(?:container|services|continue-on-error):", header),
                name + " has unsupported container/failure configuration")
        supported = "    runs-on: ubuntu-latest\n" in header or "    runs-on: windows-latest\n" in header
        if name == "orientation-proof":
            supported = "    runs-on: ${{ matrix.os }}\n" in header and "        os: [ubuntu-latest, windows-latest]\n" in header
        require(supported, name + " requires the approved Ubuntu/Windows x64 configuration")
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        require(bool(steps), name + " has no bootstrap")
        expected = canonical if index == 0 else BOOTSTRAP_ALIAS.rstrip("\n")
        require(steps[0].rstrip("\n") == expected, name + " first step must be the canonical unconditional Python bootstrap")
        require(sum(step.count("id: runner_action_node") for step in steps[1:]) == 0,
                name + " cannot replace the bootstrap result")
        for step in steps[1:]:
            require(not step.startswith(("      - &", "      - *")) and "        <<:" not in step,
                    name + " has an unproved step alias or merge")
            require(re.match(r"^      - (?:name|uses|run|if|id|shell|env):", step) is not None,
                    name + " has an unsupported step mapping")
            uses = re.findall(r"(?m)^(?:      - |        )uses: (\S+)\s*$", step)
            if not uses:
                continue
            require(len(uses) == 1, name + " has ambiguous action identity")
            reference = uses[0]
            validate_action_manifest(reference, ACTION_MANIFESTS.get(reference, {}))
            if reference.startswith("actions/setup-node@"):
                pin = "820762786026740c76f36085b0efc47a31fe5020" if npm else "949feb2413d6458794dcd2491c4babbbce0c15c1"
                require(reference == "actions/setup-node@" + pin, name + " has the wrong setup-node identity")
            require("continue-on-error:" not in step, name + " cannot ignore an action failure")
            conditions = re.findall(r"(?m)^        if: (.+)$", step)
            if conditions:
                require(len(conditions) == 1, name + " has ambiguous action conditions")
                expression = conditions[0].removeprefix("${{").removesuffix("}}").strip()
                require("||" not in expression and "steps.runner_action_node.outcome == 'success'" in [part.strip() for part in expression.split("&&")],
                        name + " conditional action must require bootstrap success")
            total_uses += 1
    require(total_uses == len(re.findall(r"(?m)^\s*(?:-\s+)?uses:", jobs)), "unproved action outside an admitted step")
    if npm:
        publish = job_block(text, "publish").split("    steps:", 1)[0]
        require("    needs: verify\n" in publish and "    if: ${{ inputs.publish && needs.verify.result == 'success' }}" in publish,
                "npm publication requires explicit approval and successful verify dependency")
    elif not auxiliary:
        orientation = job_block(text, "orientation-proof")
        require("if: ${{ !cancelled() && steps.runner_action_node.outcome == 'success' }}" in orientation,
                "orientation upload must survive later failure only after bootstrap success")
        require("uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9" in orientation,
                "orientation receipt upload must retain its exact no-pre action")


UV_LINUX_WHEEL = (
    "https://files.pythonhosted.org/packages/3a/ad/"
    "3c2a81d66d1839063662e5b6c0002ec31f8ee987dbc5295747627ca6160a/"
    "uv-0.13.5-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
    "#sha256=fa8d26e08e34c29c0c4e820cf3181757086d547240b4f4d31ff1d8bd810ca946"
)
UV_WINDOWS_WHEEL = (
    "https://files.pythonhosted.org/packages/32/ea/"
    "771744a784b16aa21d195cb5d5d5a2878d72fa00fc26f11ea3f9646994fe/"
    "uv-0.13.5-py3-none-win_amd64.whl"
    "#sha256=1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f"
)
UV_PIP_CONFIG_FILE = "${{ runner.os == 'Windows' && 'nul' || '/dev/null' }}"
UV_INSTALLS = {
    "test": 'python -I -m pip --isolated install --force-reinstall --no-deps --only-binary=:all: "' + UV_LINUX_WHEEL + '"',
    "orientation-proof": (
        'python -I -m pip --isolated install --force-reinstall --no-deps --only-binary=:all: "${{ '
        "runner.os == 'Linux' && '" + UV_LINUX_WHEEL
        + "' || runner.os == 'Windows' && '" + UV_WINDOWS_WHEEL + "' || '' }}\""
    ),
}
UV_JOBS = ("test", "orientation-proof")
UV_RUNTIME_COMMAND = "python -I -B scripts/check_uv_runtime.py"
UV_RUNTIME_STEP = (
    "      - name: actual uv runtime admission\n"
    f"        run: {UV_RUNTIME_COMMAND}\n"
)
UV_BUILD_ADMISSION = f'uv="$({UV_RUNTIME_COMMAND})" || exit $?'
UV_ORIENTATION_PROOF = (
    "      - name: run disposable orientation proof\n"
    "        run: python packages/create-vivary/tests/orientation_proof.py --receipt orientation-proof.json\n"
)


def _check_uv_inherited_controls(header: str, pad: str, owner: str) -> None:
    require(
        not re.search(rf"(?m)^{pad}(?:defaults|'defaults'|\"defaults\")[ \t]*:", header),
        owner + " uv acquisition must not inherit run defaults",
    )
    environments = list(re.finditer(
        rf"(?m)^{pad}(?:env|'env'|\"env\")[ \t]*:([^\n]*)$", header
    ))
    explicit = owner + " uv acquisition requires explicit inherited env mappings"
    require(len(environments) <= 1, explicit)
    if not environments:
        return
    environment = environments[0]
    require(re.fullmatch(r"[ \t]*(?:#.*)?", environment.group(1)) is not None, explicit)
    body = re.split(rf"(?m)^{pad}(?=[^\s#])", header[environment.end():], maxsplit=1)[0]
    require(not re.search(r"(?m)^[ \t]*(?:\{|\[|\*|&|\$\{\{)", body), explicit)
    require(not re.search(r"(?m)^[ \t]*(?:<<|'<<'|\"<<\")[ \t]*:", body), explicit)
    for key in ("PIP_DRY_RUN", "PIP_CONFIG_FILE"):
        require(
            not re.search(rf"(?mi)^[ \t]*(?:{key}|'{key}'|\"{key}\")[ \t]*:", body),
            owner + " uv acquisition must not inherit " + key,
        )


def check_uv_acquisition(text: str) -> None:
    _check_uv_inherited_controls(text.split("\njobs:\n", 1)[0], "", "workflow")
    acquisition = re.compile(
        r"\b(?:python(?:3)?\s+(?:-I\s+)?-m\s+pip|pip(?:3)?)\s+(?:--isolated\s+)?install\b[^\n]*\buv\b"
    )
    for name in UV_JOBS:
        job = job_block(text, name)
        _check_uv_inherited_controls(job.split("    steps:\n", 1)[0], "    ", f"{name} job")
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        installs = [
            index for index, step in enumerate(steps)
            if acquisition.search(re.sub(r"(?m)^\s*#.*$", "", step))
        ]
        command = UV_INSTALLS[name]
        contract = f"{name} job must acquire uv==0.13.5 with {command}"
        require(len(installs) == 1, contract + " exactly once in its own job")
        index = installs[0]
        step = steps[index]
        require(
            re.fullmatch(
                r"      - name: [^\n]+\n        env:\n          PIP_CONFIG_FILE: "
                + re.escape(UV_PIP_CONFIG_FILE) + r"\n        run: \|\n          "
                + re.escape(command) + r"\n[ \t\n]*",
                step,
            ) is not None,
            contract + " with its exact null pip config as its only command in an unconditional, blocking step",
        )
        require(
            "continue-on-error:" not in job.split("    steps:", 1)[0],
            contract + " without job-level continue-on-error",
        )
        runtime_contract = f"{name} job must admit actual uv 0.13.5 immediately after acquisition and at use"
        require(index + 1 < len(steps) and steps[index + 1] == UV_RUNTIME_STEP,
                runtime_contract)
        if name == "test":
            builds = [candidate for candidate in steps if '"$uv" build ' in candidate]
            require(len(builds) == 1 and builds[0].count(UV_BUILD_ADMISSION) == 1,
                    runtime_contract)
            build_sequence = "\n          ".join((UV_BUILD_ADMISSION, *release_build_commands()))
            require("\n          " + build_sequence + "\n" in builds[0], runtime_contract)
            require(not re.search(r"(?m)^        (?:if|continue-on-error|env|working-directory):", builds[0]),
                    runtime_contract)
            require(not re.search(r"(?m)^\s*uv build ", job), runtime_contract)
        else:
            proofs = [position for position, candidate in enumerate(steps)
                      if "packages/create-vivary/tests/orientation_proof.py --receipt" in candidate]
            require(len(proofs) == 1 and proofs[0] > 0
                    and steps[proofs[0]] == UV_ORIENTATION_PROOF
                    and steps[proofs[0] - 1] == UV_RUNTIME_STEP,
                    runtime_contract)
        consumers = (
            '"$uv" build ',
            "python packages/tropo/tests/test_tropo.py",
            "python packages/create-vivary/tests/",
        )
        require(
            all(index < position for position, candidate in enumerate(steps)
                if any(consumer in candidate for consumer in consumers)),
            contract + " before its build and proof commands",
        )


PIP_JOBS = ("test", "workbench", "governed-platform-proof", "orientation-proof")
PIP_RUNTIME_STEP = (
    "      - name: actual pip runtime admission\n"
    "        shell: python -I -B {0}\n"
    "        run: |\n"
    "          import runpy\n"
    '          runpy.run_path("scripts/check_pip_runtime.py", run_name="__main__")\n'
)
PIP_MCP_BLOCKS = {
    "test": (
        '          mcp_python="$mcp_venv/bin/python"\n'
        '          "$mcp_python" -I -B scripts/check_pip_runtime.py || exit $?\n'
        '          "$mcp_python" -I -m pip install "mcp==2.2.0"\n'
    ),
    "governed-platform-proof": (
        '          $mcpPython = Join-Path $mcpScripts "python.exe"\n'
        '          & $mcpPython -I -B scripts/check_pip_runtime.py\n'
        '          if ($LASTEXITCODE -ne 0) { throw "MCP pip runtime admission failed" }\n'
        '          & $mcpPython -I -m pip install "mcp==2.2.0"\n'
        '          if ($LASTEXITCODE -ne 0) { throw "MCP dependency install failed" }\n'
    ),
}


def check_pip_runtime(text: str) -> None:
    for name in PIP_JOBS:
        job = job_block(text, name)
        header = job.split("    steps:\n", 1)[0]
        require("continue-on-error:" not in header, f"{name} cannot ignore job failure")
        if name not in UV_JOBS:
            require(not re.search(r"(?m)^    (?:defaults|'defaults'|\"defaults\"):", header),
                    f"{name} pip runtime admission cannot inherit run defaults")
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        setups = [index for index, step in enumerate(steps) if "uses: actions/setup-python@" in step]
        guards = [index for index, step in enumerate(steps) if "name: actual pip runtime admission" in step]
        require(len(setups) == len(guards) == 1,
                f"{name} needs exactly one setup-python and actual pip runtime admission")
        setup, guard = setups[0], guards[0]
        require(guard == setup + 1 and steps[guard].rstrip("\n") == PIP_RUNTIME_STEP.rstrip("\n"),
                f"{name} pip runtime admission must immediately follow setup-python unconditionally")
        require(not re.search(r"\b(?:pip|pip3)\b", "".join(steps[:guard])),
                f"{name} must admit the selected pip before package operations")
        if name in PIP_MCP_BLOCKS:
            block = PIP_MCP_BLOCKS[name]
            require(job.count(block) == 1,
                    f"{name} must admit its exact MCP venv interpreter before its first network pip install")
            require(not re.search(r'(?m)^\s*(?:"\$mcp_python"|& \$mcpPython)\s+(?:-I\s+)?-m\s+pip\b',
                                  job[:job.index(block)]),
                    f"{name} MCP pip cannot run before its venv admission")
            network_install = next(line.strip() for line in block.splitlines() if " -I -m pip install " in line)
            mcp_pip = network_install.split(" install ", 1)[0] + " "
            wheelhouse = '\"$wheelhouse\"' if name == "test" else "$wheelhouse"
            offline_install = mcp_pip + "install --no-index --find-links " + wheelhouse + " vivary-mcp create-vivary"
            network_commands = [
                line.strip() for line in job.splitlines()
                if line.strip().startswith(mcp_pip)
                and line.strip() not in (offline_install, mcp_pip + "check")
            ]
            require(network_commands == [network_install],
                    f"{name} MCP pip may network only in its canonical admitted install block")
            owner = next(step for step in steps if block in step)
            require(not re.search(r"(?m)^        (?:if|continue-on-error|working-directory|env):", owner),
                    f"{name} MCP pip admission cannot be skipped, redirected or ignored")
            shell = "bash" if name == "test" else "pwsh"
            require(f"        shell: {shell}\n" in owner,
                    f"{name} MCP pip admission requires its explicit platform shell")


def check_pip_commands(text: str) -> None:
    for name in PIP_JOBS:
        prefixes = ("python -I -m pip ",)
        if name == "test":
            prefixes += ('"$venv_python" -I -m pip ', '"$mcp_python" -I -m pip ')
        elif name == "governed-platform-proof":
            prefixes += ("& $python -I -m pip ", "& $mcpPython -I -m pip ")
        for step in re.split(r"(?m)(?=^      - )", job_block(text, name))[1:]:
            run = re.search(r"(?m)^(?:      - |        )run: ([^\n]*)$", step)
            if run is None:
                continue
            commands = run.group(1) + "\n" + step[run.end():]
            pip_commands = False
            for line in commands.splitlines():
                command = line.strip()
                if not re.search(r"(?:\s-m\s+pip\b|(?:^|[;&|]\s*)pip(?:3)?\s+(?:install|wheel|download)\b)", command):
                    continue
                pip_commands = True
                require(command.startswith(prefixes),
                        f"{name} pip commands must use the admitted interpreter and Python -I")
                require(not re.search(r"\binstall\s+(?:-\S+\s+)*pip(?:[<=>!~\[]|\s|$)", command),
                        f"{name} cannot use a network pip self-upgrade to clear runtime admission")
                if command.startswith(('"$venv_python"', "& $python ")):
                    require(" -m pip check" in command or " install --no-index " in command,
                            f"{name} unadmitted offline venv pip cannot access the network")
            if pip_commands:
                require(not re.search(r"(?m)^        (?:if|continue-on-error|working-directory):", step),
                        f"{name} pip commands cannot be skipped, redirected or ignored")
                if not any(command in step for command in UV_INSTALLS.values()):
                    require(not re.search(r"(?m)^        env:", step),
                            f"{name} pip commands cannot override their admitted interpreter environment")


def check_runtime_security(text: str) -> None:
    for name in NODE_JOBS:
        job = job_block(text, name)
        steps = re.split(r"(?m)(?=^      - )", job)[1:]
        setups = [i for i, step in enumerate(steps) if "uses: actions/setup-node@" in step]
        guards = [i for i, step in enumerate(steps) if NODE_GUARD in step]
        require(len(setups) == len(guards) == 1, f"{name} needs exactly one actual Node guard and setup")
        require(guards[0] == setups[0] + 1, f"{name} Node guard must immediately follow setup-node")
        guard = steps[guards[0]]
        require(re.search(r"(?m)^        run: " + re.escape(NODE_GUARD) + r"\s*$", guard) is not None,
                f"{name} Node guard must be an unconditional standalone command")
        require(not re.search(r"(?m)^\s+(?:if|continue-on-error|working-directory|env):", guard),
                f"{name} Node guard cannot be skipped, redirected or ignored")
        require("continue-on-error:" not in job.split("    steps:", 1)[0], f"{name} cannot ignore job failure")
        before = "".join(steps[:guards[0]])
        require(not re.search(r"(?m)^\s*(?:run:\s*)?(?:npm|pnpm|corepack)\s", before),
                f"{name} must admit Node before package operations")
        for step in steps:
            # A one-line YAML run step includes its list dash. Inspect its command,
            # as well as block commands, rather than the surrounding YAML text.
            commands = re.sub(r"(?m)^      - run:\s*", "", step)
            commands = re.sub(r"(?m)^        run:\s*", "", commands)
            require(not re.search(r"(?m)^\s*['\"]?(?:agent-native|astro) build(?:\s|$|['\"])", commands),
                    f"{name} direct builds must use the guarded package build command")
    require("node --test packages/workbench/tests/runtime-security.test.mjs" in job_block(text, "workbench"),
            "workbench must run Node security policy and entry tests")
    require("python scripts/tests/test_npm_trusted_publish_workflow.py" in job_block(text, "test"),
            "tests job must run npm runtime/publication mutation tests")


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    check_pip_runtime(text)
    changes_job = job_block(text, "changes")
    test_job = job_block(text, "test")
    workbench_job = job_block(text, "workbench")
    workbench_maintained_job = job_block(text, "workbench-maintained")
    governed_job = job_block(text, "governed-platform-proof")
    orientation_job = job_block(text, "orientation-proof")
    review_job = job_block(text, "review")
    site_job = job_block(text, "site")
    require("python scripts/tests/test_review_gate.py" in test_job,
            "tests job must exercise the required review gate")

    require("python scripts/tests/test_hldd.py" in test_job,
            "tests job must exercise the HLDD gate")
    require('python scripts/check_hldd.py --base "$BASE_SHA" --head "$HEAD_SHA"' in test_job,
            "tests job must enforce HLDD review on the explicit commit range")
    require("HEAD_SHA: ${{ inputs.head_sha || github.event.pull_request.head.sha || github.sha }}" in test_job,
            "HLDD review must use the actual PR head, not the synthetic merge")

    runner_install = "python -I -m pip install pytest packaging"
    first_pytest = "python -m pytest"
    contract_tests = "python scripts/tests/test_ci_workflow.py"
    source_navigation_check = "python -B scripts/check-source-navigation.py --check"
    source_navigation_tests = "python -B scripts/tests/test-source-navigation.py"
    automation_guard = "python scripts/check_repository_automation.py"
    automation_tests = "python scripts/tests/test_repository_automation.py"
    automation_behavior = (
        "python -m pytest scripts/tests/test_update_stats.py "
        "scripts/tests/test_steward_health.py -q"
    )
    artifact_test = "python scripts/tests/test_release_artifacts.py"
    artifact_check = (
        'python scripts/check_release_artifacts.py --repository . --artifacts "$artifacts"'
    )
    parity_tests = "python scripts/tests/test_installed_route_parity.py"
    parity_check = (
        'python scripts/check_installed_route_parity.py "$smoke/venv/bin"'
    )
    parity_characterize = (
        "python scripts/check_installed_route_parity.py --characterize"
        ' "$smoke/venv/bin"'
    )
    windows_parity_check = "python scripts/check_installed_route_parity.py $scripts"
    windows_parity_characterize = (
        "python scripts/check_installed_route_parity.py --characterize $scripts"
    )
    strato_pin = 'assert version("vivary-strato") == "0.1.3"'
    site_install = "        run: npm ci\n        working-directory: site"
    site_audit = (
        "        run: npm audit --audit-level=high\n"
        "        working-directory: site"
    )
    dispatched_base = (
        "${{ inputs.base_sha || github.event.pull_request.base.sha || "
        "github.event.before }}"
    )

    require("workflow_dispatch:" in text, "workflow must accept trusted dispatches")
    for input_name in ("head_sha", "base_sha", "pull_request_number"):
        input_pattern = rf"(?m)^      {input_name}:\s*$[\s\S]*?^        required: true\s*$"
        require(
            re.search(input_pattern, text) is not None,
            f"workflow_dispatch must require {input_name}",
        )
    require(
        "  pull-requests: read" in text,
        "workflow must grant read-only pull-request validation access",
    )
    require(
        'test "$GITHUB_SHA" = "$HEAD_SHA"' in changes_job,
        "dispatch must bind github.sha to inputs.head_sha",
    )
    for validation in (
        'LIVE_HEAD=$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid)',
        'LIVE_BASE=$(gh pr view "$PR_NUMBER" --json baseRefOid --jq .baseRefOid)',
        'test "$LIVE_HEAD" = "$HEAD_SHA"',
        'test "$LIVE_BASE" = "$BASE_SHA"',
    ):
        require(validation in changes_job, f"dispatch validation must include {validation}")
    for input_name in ("head_sha", "base_sha", "pull_request_number"):
        require(
            f"${{{{ inputs.{input_name} }}}}" in changes_job,
            f"changes job must consume inputs.{input_name}",
        )
    require(
        dispatched_base in changes_job,
        "changed-path detection must use inputs.base_sha for dispatch",
    )
    require(
        dispatched_base in test_job,
        "diff hygiene must use inputs.base_sha for dispatch",
    )
    for name, block in (
        ("test", test_job),
        ("workbench", workbench_job),
        ("workbench-maintained", workbench_maintained_job),
        ("governed-platform-proof", governed_job),
        ("orientation-proof", orientation_job),
        ("review", review_job),
        ("site", site_job),
    ):
        require(
            "    needs: changes" in block,
            f"{name} job must wait for dispatch validation",
        )
    for name, block in (
        ("test", test_job),
        ("workbench", workbench_job),
        ("workbench-maintained", workbench_maintained_job),
    ):
        require(
            "    if: ${{ always() }}" in block,
            f"required {name} job must run even when dispatch validation fails",
        )
        require(
            "if: needs.changes.result != 'success'" in block
            and "run: exit 1" in block,
            f"required {name} job must fail closed when dispatch validation fails",
        )
    maintained_checks = "pnpm --dir packages/workbench test:maintained"
    require(
        text.count(maintained_checks) == 1
        and maintained_checks in workbench_maintained_job,
        f"{maintained_checks} must run exactly once, in the workbench-maintained job",
    )
    require(
        "github.event_name == 'pull_request' || "
        "github.event_name == 'workflow_dispatch'" in review_job,
        "graph review gate must run for pull requests and trusted workflow_dispatch",
    )

    require(runner_install in test_job, "tests job must install pytest and packaging")
    require(first_pytest in test_job, "tests job must run a pytest suite")
    require(
        test_job.index(runner_install) < test_job.index(first_pytest),
        "shared test runner install must precede the first pytest suite",
    )
    require(
        test_job.count(runner_install) == 1,
        "tests job must install the shared test runner exactly once",
    )
    require(
        "python scripts/check_ci_workflow.py" in test_job,
        "tests job must run the CI workflow contract guard",
    )
    require(
        contract_tests in test_job,
        f"tests job must run {contract_tests}",
    )
    require(
        test_job.count(contract_tests) == 1,
        "tests job must run the CI workflow contract regression suite exactly once",
    )
    for command in (source_navigation_check, source_navigation_tests):
        require(command in test_job, f"tests job must run {command}")
        require(
            test_job.count(command) == 1,
            f"tests job must run {command} exactly once",
        )
        require(
            command in governed_job,
            f"governed-platform-proof job must run {command}",
        )
        require(
            governed_job.count(command) == 1,
            f"governed-platform-proof job must run {command} exactly once",
        )
    for command in (automation_guard, automation_tests, automation_behavior):
        require(command in test_job, f"tests job must run {command}")
        require(
            test_job.count(command) == 1,
            f"tests job must run {command} exactly once",
        )
    for command in (
        artifact_test,
        *release_build_commands(),
        'npm pack packages/create-vivary/npm --pack-destination "$artifacts"',
        artifact_check,
    ):
        require(command in test_job, f"tests job must run {command}")
        require(test_job.count(command) == 1, f"tests job must run {command} exactly once")
    require(
        test_job.index(artifact_test) < test_job.index(artifact_check),
        "artifact contract tests must precede the real archive check",
    )
    for command in (parity_tests, parity_check, parity_characterize):
        require(command in test_job, f"tests job must run {command}")
        require(test_job.count(command) == 1, f"tests job must run {command} exactly once")
    require(
        test_job.index(parity_check) < test_job.index(parity_characterize),
        "route parity must precede the installed command surface replay",
    )
    require(
        strato_pin in test_job,
        f"wheelhouse smoke must pin the installed strato version with {strato_pin}",
    )
    for command in (windows_parity_check, windows_parity_characterize):
        require(
            command in governed_job,
            f"governed-platform-proof job must run {command}",
        )
        require(
            governed_job.count(command) == 1,
            f"governed-platform-proof job must run {command} exactly once",
        )
    require(
        governed_job.index(windows_parity_check)
        < governed_job.index(windows_parity_characterize),
        "Windows route parity must precede the installed command surface replay",
    )
    require(
        site_install in site_job,
        "site job must run npm ci with working-directory: site",
    )
    require(
        site_job.count(site_install) == 1,
        "site job must run npm ci in site exactly once",
    )
    require(
        site_audit in site_job,
        "site job must run npm audit --audit-level=high with working-directory: site",
    )
    require(
        site_job.count(site_audit) == 1,
        "site job must run the blocking high-severity audit exactly once",
    )
    require(
        site_job.index(site_install) < site_job.index(site_audit),
        "site dependency audit must follow the locked npm install",
    )

    check_runtime_security(text)
    check_uv_acquisition(text)
    check_pip_commands(text)
    require("python -I -B scripts/tests/test_pip_runtime.py" in test_job,
            "tests job must run pip runtime admission regressions")
    check_runner_action_bootstrap(text, CI_JOBS)
    require("python -I -B scripts/tests/test_runner_action_node.py" in test_job,
            "tests job must run the runner action bootstrap regressions")
    check_review_workflow(REVIEW_WORKFLOW.read_text(encoding="utf-8"))
    print(f"{WORKFLOW}: CI workflow contract passed")


if __name__ == "__main__":
    main()
