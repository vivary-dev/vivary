"""Offline runner-shaped fixtures for the shell-first action Node repair."""

import contextlib
import ctypes
import errno
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import stat
import struct
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/bootstrap_runner_action_node.py"


def load_helper():
    spec = importlib.util.spec_from_file_location("fixture_runner_node_repair", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def elf(payload):
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", header, 18, 62)
    return bytes(header) + payload


def archive(member, payload, *, duplicate=False, symlink=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:xz") as stream:
        item = tarfile.TarInfo(member)
        item.size = len(payload)
        item.mode = 0o755
        if symlink:
            item.type = tarfile.SYMTYPE
            item.linkname = "/outside/fixture"
            item.size = 0
        stream.addfile(item, None if symlink else io.BytesIO(payload))
        if duplicate:
            stream.addfile(item, io.BytesIO(payload))
    return output.getvalue()


def pe(machine=0x8664):
    header = bytearray(154)
    header[:2] = b"MZ"
    struct.pack_into("<I", header, 60, 128)
    header[128:132] = b"PE\0\0"
    struct.pack_into("<H", header, 132, machine)
    struct.pack_into("<H", header, 152, 0x20b)
    return bytes(header) + b"inert Windows Node fixture"


class RepairFixture(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.module = load_helper()
        self.admission = self.module.admission
        self.root = self.directory / "runner"
        self.worker = self.root / "bin/Runner.Worker"
        self.node = self.root / "externals/node24/bin/node"
        self.worker.parent.mkdir(parents=True)
        self.node.parent.mkdir(parents=True)
        self.worker.write_bytes(elf(b"fixture Worker"))
        self.old = elf(b"fixture affected Node; never executed")
        self.patched = elf(b"fixture authenticated patched Node; never executed")
        self.node.write_bytes(self.old)
        self.node.chmod(0o751)
        self.member = "node-v24.22.1-linux-x64/bin/node"
        self.payload = archive(self.member, self.patched)
        self.artifact = {
            "url": "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz",
            "size": len(self.payload), "sha256": hashlib.sha256(self.payload).hexdigest(),
            "node_size": len(self.patched), "node_sha256": hashlib.sha256(self.patched).hexdigest(),
            "old_sha256": hashlib.sha256(self.old).hexdigest(),
            "member": self.member,
        }
        self.temporary = self.directory / "temp"
        self.temporary.mkdir()
        own_pid = os.getpid()
        worker_pid = own_pid + 100000
        self.chain = {
            own_pid: {"pid": own_pid, "ppid": worker_pid, "created": 300, "exe": "/fixture/python"},
            worker_pid: {"pid": worker_pid, "ppid": 1, "created": 200, "exe": str(self.worker)},
        }
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(self.admission, "container_host", return_value=False))
        self.stack.enter_context(mock.patch.object(self.admission, "linux_process", side_effect=lambda pid: dict(self.chain[pid])))
        self.probe = self.stack.enter_context(mock.patch.object(self.admission, "probe_version", return_value="v24.22.1"))
        self.stack.enter_context(mock.patch.dict(self.module.ARTIFACTS, {"linux": self.artifact}))
        self.stack.enter_context(mock.patch.dict(os.environ, {"RUNNER_TEMP": str(self.temporary)}))
        self.assert_quiescent_real = self.module.assert_quiescent
        self.download_real = self.module.download
        self.quiescent = self.stack.enter_context(mock.patch.object(self.module, "assert_quiescent"))
        self.downloader = self.stack.enter_context(mock.patch.object(self.module, "download", side_effect=self.write_download))

    def write_download(self, artifact, destination):
        Path(destination).write_bytes(self.payload)

    def repair(self):
        return self.module.repair_runner_action_node()

    def assert_old_intact(self):
        self.assertEqual(self.node.read_bytes(), self.old)
        self.probe.assert_not_called()

    def refusal_output(self):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors), \
                mock.patch.object(self.module.sys, "argv", [str(HELPER)]):
            self.assertEqual(self.module.main(), 1)
        self.assertEqual(output.getvalue(), "")
        return errors.getvalue()

    def test_authenticated_bytes_replace_only_the_selected_node_atomically_then_pass_full_guard(self):
        old_worker = self.worker.read_bytes()
        original_replace = os.replace
        replacements = []
        def replacing(source, destination):
            source, destination = Path(source), Path(destination)
            self.assertEqual(source.parent, self.node.parent)
            self.assertEqual(destination, self.node)
            self.assertEqual(source.read_bytes(), self.patched)
            self.assertEqual(self.node.read_bytes(), self.old)
            self.probe.assert_not_called()
            replacements.append((source, destination))
            return original_replace(source, destination)
        with mock.patch.object(self.module.os, "replace", side_effect=replacing):
            self.repair()
        self.assertEqual(len(replacements), 1)
        self.assertEqual(self.node.read_bytes(), self.patched)
        self.assertEqual(stat.S_IMODE(self.node.stat().st_mode), 0o751)
        self.assertEqual(self.worker.read_bytes(), old_worker)
        self.probe.assert_called_once()
        self.assertGreaterEqual(self.quiescent.call_count, 2)
        self.assertFalse(replacements[0][0].exists())

    def test_already_authenticated_node_skips_download_and_staging_but_runs_full_guard(self):
        self.node.write_bytes(self.patched)
        with mock.patch.object(self.module, "stage_node", side_effect=AssertionError("no staging needed")):
            self.repair()
        self.downloader.assert_not_called()
        self.probe.assert_called_once()
        self.assertEqual(self.node.read_bytes(), self.patched)

    def test_owned_temporary_root_alias_is_canonicalized_before_artifact_creation(self):
        owned = self.directory / "owned-download-directory"
        owned.mkdir()
        alias = self.directory / "temporary-short-alias"
        alias.symlink_to(owned, target_is_directory=True)
        outside = self.directory / "outside-download-directory"
        outside.mkdir()
        sentinel = outside / "untouched"
        sentinel.write_bytes(b"unrelated fixture")
        observed = []
        def download(artifact, destination):
            observed.append(destination)
            self.assertEqual(destination, owned.resolve(strict=True) / "artifact")
            self.assertTrue(destination.is_relative_to(owned.resolve(strict=True)))
            self.assertEqual(destination.read_bytes(), b"")
            self.module.plain(destination)
            destination.write_bytes(self.payload)
        with mock.patch.object(self.module.tempfile, "TemporaryDirectory",
                               return_value=contextlib.nullcontext(str(alias))), \
                mock.patch.object(self.module, "download", side_effect=download):
            result = self.repair()
        self.assertEqual(result["repair"]["outcome"], "repaired")
        self.assertEqual(observed, [owned.resolve(strict=True) / "artifact"])
        self.assertEqual(list(owned.iterdir()), observed)
        self.assertEqual(list(outside.iterdir()), [sentinel])
        self.assertEqual(sentinel.read_bytes(), b"unrelated fixture")
        self.assertEqual(self.node.read_bytes(), self.patched)
        self.probe.assert_called_once()

    def test_unknown_safe_future_node_is_admitted_without_downgrade_or_download(self):
        unknown = elf(b"fixture unknown future Node; never executed")
        self.node.write_bytes(unknown)
        self.probe.return_value = "v24.22.2"
        result = self.repair()
        self.assertEqual(result["repair"]["outcome"], "admitted-unmodified")
        self.assertEqual(self.node.read_bytes(), unknown)
        self.downloader.assert_not_called()
        self.probe.assert_called_once()

    def test_unknown_affected_node_fails_unchanged_admission_without_replacement(self):
        unknown = elf(b"fixture unknown affected Node; never executed")
        self.node.write_bytes(unknown)
        self.probe.return_value = "v24.21.0"
        with self.assertRaises(RuntimeError):
            self.repair()
        self.assertEqual(self.node.read_bytes(), unknown)
        self.downloader.assert_not_called()
        self.probe.assert_called_once()

    def test_corrupt_or_partial_download_cannot_change_selected_node(self):
        for payload in (self.payload[:-1], self.payload + b"unexpected trailing bytes", b"bad archive"):
            with self.subTest(payload_size=len(payload)):
                self.downloader.side_effect = lambda artifact, destination: Path(destination).write_bytes(payload)
                with self.assertRaises((RuntimeError, ValueError, OSError)):
                    self.repair()
                self.assert_old_intact()

    def test_changed_worker_is_refused_before_replacement(self):
        def download_then_change_worker(artifact, destination):
            self.write_download(artifact, destination)
            self.worker.write_bytes(elf(b"changed fixture Worker"))
        self.downloader.side_effect = download_then_change_worker
        with self.assertRaises((RuntimeError, OSError)):
            self.repair()
        self.assert_old_intact()

    def test_changed_original_is_refused_before_replacement(self):
        changed = elf(b"different original Node")
        def download_then_change_original(artifact, destination):
            self.write_download(artifact, destination)
            self.node.write_bytes(changed)
        self.downloader.side_effect = download_then_change_original
        with self.assertRaises((RuntimeError, OSError)):
            self.repair()
        self.assertEqual(self.node.read_bytes(), changed)
        self.probe.assert_not_called()

    def test_running_old_node_refuses_replacement(self):
        self.quiescent.side_effect = RuntimeError("old fixture Node remains active")
        with self.assertRaises(RuntimeError):
            self.repair()
        self.assert_old_intact()

    def test_atomic_replace_permission_failure_preserves_original_and_stops(self):
        with mock.patch.object(self.module.os, "replace", side_effect=PermissionError("fixture read-only directory")):
            with self.assertRaises((RuntimeError, OSError)):
                self.repair()
        self.assert_old_intact()

    def test_failed_post_replacement_admission_does_not_restore_affected_bytes(self):
        self.probe.return_value = "v24.21.0"
        acquire = self.module.acquire_write_lease
        descriptors = []
        def tracked_acquire(current):
            descriptor = acquire(current)
            descriptors.append(descriptor)
            return descriptor
        with mock.patch.object(self.module, "acquire_write_lease", side_effect=tracked_acquire):
            with self.assertRaises(RuntimeError):
                self.repair()
        self.assertEqual(self.node.read_bytes(), self.patched)
        self.probe.assert_called_once()
        self.assertEqual(len(descriptors), 1)
        with self.assertRaises(OSError) as closed:
            os.fstat(descriptors[0])
        self.assertEqual(closed.exception.errno, errno.EBADF)

    def link_externals(self):
        """Hosted Ubuntu 20261025 layout: <root>/externals links to one shared tree."""
        shared = self.directory / "runner-cache/externals"
        shared.parent.mkdir()
        (self.root / "externals").rename(shared)
        (self.root / "externals").symlink_to(shared, target_is_directory=True)
        self.node = shared / "node24/bin/node"
        return shared

    def test_shared_externals_link_is_repaired_at_its_target_and_kept(self):
        shared = self.link_externals()
        self.repair()
        self.assertEqual(self.node.read_bytes(), self.patched)
        self.assertTrue((self.root / "externals").is_symlink())
        self.assertEqual(Path(os.readlink(self.root / "externals")), shared)
        self.probe.assert_called_once()
        self.assertEqual(self.probe.call_args.args[0], self.node)

    def test_unsafe_externals_links_are_refused_before_download_or_probe(self):
        cases = ("relative", "not-externals", "chained", "writable-target", "writable-ancestor",
                 "foreign-ancestor", "linked-node24")
        for case in cases:
            with self.subTest(case=case):
                self.setUp()
                shared = self.link_externals()
                link = self.root / "externals"
                if case == "relative":
                    link.unlink()
                    link.symlink_to(os.path.relpath(shared, self.root), target_is_directory=True)
                if case == "not-externals":
                    renamed = shared.with_name("tools")
                    shared.rename(renamed)
                    link.unlink()
                    link.symlink_to(renamed, target_is_directory=True)
                    self.node = renamed / "node24/bin/node"
                if case == "chained":
                    alias = self.directory / "cache-alias"
                    alias.symlink_to(shared.parent, target_is_directory=True)
                    link.unlink()
                    link.symlink_to(alias / "externals", target_is_directory=True)
                if case == "writable-target":
                    shared.chmod(0o777)
                if case == "writable-ancestor":
                    shared.parent.chmod(0o777)
                if case == "linked-node24":
                    moved = self.directory / "outside-node24"
                    (shared / "node24").rename(moved)
                    (shared / "node24").symlink_to(moved, target_is_directory=True)
                    self.node = moved / "bin/node"
                original_lstat = Path.lstat
                def lstat(path, *args, **kwargs):
                    info = original_lstat(path, *args, **kwargs)
                    if case == "foreign-ancestor" and path == shared.parent:
                        fields = list(info)
                        fields[4] = 4242
                        return os.stat_result(fields)
                    return info
                with mock.patch.object(Path, "lstat", lstat):
                    with self.assertRaises((RuntimeError, OSError)):
                        self.repair()
                self.assertEqual(self.node.read_bytes(), self.old)
                self.downloader.assert_not_called()
                self.probe.assert_not_called()

    def high_ancestor_lstat(self, owner):
        """Show self.directory, an ancestor above runner-cache, as mode 0777 with the given owner."""
        original_lstat = Path.lstat
        def lstat(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            if path == self.directory:
                fields = list(info)
                fields[0] = stat.S_IFDIR | 0o777
                fields[4] = owner
                return os.stat_result(fields)
            return info
        return mock.patch.object(Path, "lstat", lstat)

    def test_root_owned_world_writable_high_ancestor_is_admitted_like_hosted_opt(self):
        self.link_externals()
        with self.high_ancestor_lstat(0):
            self.repair()
        self.assertEqual(self.node.read_bytes(), self.patched)
        self.probe.assert_called_once()

    def test_runner_owned_world_writable_high_ancestor_is_refused(self):
        self.link_externals()
        with self.high_ancestor_lstat(os.geteuid()):
            with self.assertRaisesRegex(self.module.RepairRefusal, "no other account can write"):
                self.repair()
        self.assertEqual(self.node.read_bytes(), self.old)
        self.downloader.assert_not_called()
        self.probe.assert_not_called()

    def test_linked_externals_stay_refused_on_windows(self):
        self.link_externals()
        with self.assertRaisesRegex(RuntimeError, "admitted only on Linux"):
            self.admission.shared_externals(self.root, "win32")

    def test_externals_link_swapped_during_repair_is_refused(self):
        shared = self.link_externals()
        other = self.directory / "other-cache/externals"
        shutil.copytree(shared, other, symlinks=True)
        def swap(artifact, destination):
            link = self.root / "externals"
            link.unlink()
            link.symlink_to(other, target_is_directory=True)
            Path(destination).write_bytes(self.payload)
        self.downloader.side_effect = swap
        with self.assertRaisesRegex(self.module.RepairRefusal, "runner externals link changed|runner directory changed"):
            self.repair()
        self.assertEqual(self.node.read_bytes(), self.old)
        self.assertEqual((other / "node24/bin/node").read_bytes(), self.old)
        self.probe.assert_not_called()

    def test_symlink_target_is_refused_without_following_it(self):
        outside = self.directory / "outside-node"
        outside.write_bytes(self.old)
        self.node.unlink()
        self.node.symlink_to(outside)
        with self.assertRaises((RuntimeError, OSError)):
            self.repair()
        self.assertEqual(outside.read_bytes(), self.old)
        self.downloader.assert_not_called()
        self.probe.assert_not_called()

    def test_path_refusals_report_owned_role_reason_and_bits_without_paths(self):
        alias = self.directory / "private-fixture-name"
        alias.symlink_to(self.node)
        with self.assertRaisesRegex(self.module.RepairRefusal, "role=interpreter, reason=symlink") as refusal:
            self.module.plain(alias, role="interpreter")
        message = str(refusal.exception)
        self.assertIn("mode=", message)
        self.assertIn("attributes=", message)
        self.assertIn("links=", message)
        self.assertNotIn(str(alias), message)
        # Exercise Windows reparse diagnostics inertly; custody stays refused.
        info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=0x410, st_nlink=1)
        with mock.patch.object(Path, "lstat", return_value=info):
            with self.assertRaisesRegex(self.module.RepairRefusal, "role=root, reason=reparse-point.*attributes=1040"):
                self.module.plain(self.root, directory=True, role="root")

    def test_canonical_spelling_refusal_retains_custody_and_identifies_the_role(self):
        with mock.patch.object(Path, "resolve", return_value=self.directory / "different-canonical-name"):
            with self.assertRaisesRegex(self.module.RepairRefusal, "role=root, reason=canonical-spelling-mismatch"):
                self.module.context()
        self.downloader.assert_not_called()
        self.probe.assert_not_called()

    def test_authenticated_duplicate_or_nonregular_target_member_is_refused(self):
        for options in ({"duplicate": True}, {"symlink": True}):
            with self.subTest(member=options):
                self.payload = archive(self.member, self.patched, **options)
                self.artifact.update(size=len(self.payload), sha256=hashlib.sha256(self.payload).hexdigest())
                with self.assertRaises((RuntimeError, ValueError, OSError)):
                    self.repair()
                self.assert_old_intact()

    def test_member_bytes_must_match_both_pinned_hash_and_native_architecture(self):
        bad_arch = bytearray(self.patched)
        struct.pack_into("<H", bad_arch, 18, 183)
        for payload, digest in ((self.patched + b"tamper", self.artifact["node_sha256"]),
                                (bytes(bad_arch), hashlib.sha256(bad_arch).hexdigest())):
            with self.subTest(digest=digest):
                self.payload = archive(self.member, payload)
                self.artifact.update(size=len(self.payload), sha256=hashlib.sha256(self.payload).hexdigest(),
                                     node_size=len(payload), node_sha256=digest)
                with self.assertRaises((RuntimeError, ValueError, OSError)):
                    self.repair()
                self.assert_old_intact()

    def test_caller_arguments_cannot_override_the_target_or_artifact(self):
        with mock.patch.object(self.module.sys, "argv", [str(HELPER), "--target", str(self.node),
                                                        "--url", "https://untrusted.invalid/node"]), \
                mock.patch.object(self.module, "repair_runner_action_node") as repair:
            self.assertEqual(self.module.main(), 1)
        repair.assert_not_called()
        self.assert_old_intact()

    def test_read_only_runner_directory_refuses_staging_and_preserves_original(self):
        self.node.parent.chmod(0o555)
        try:
            with self.assertRaises((RuntimeError, OSError)):
                self.repair()
            self.assert_old_intact()
        finally:
            self.node.parent.chmod(0o755)

    def test_original_replaced_with_identical_bytes_still_fails_identity_recheck(self):
        def download_then_replace_original(artifact, destination):
            self.write_download(artifact, destination)
            self.node.rename(self.directory / "original-identity")
            self.node.write_bytes(self.old)
        self.downloader.side_effect = download_then_replace_original
        with self.assertRaises((RuntimeError, OSError)):
            self.repair()
        self.assert_old_intact()

    def test_changed_worker_process_identity_is_refused(self):
        def download_then_reuse_worker_pid(artifact, destination):
            self.write_download(artifact, destination)
            worker = next(item for item in self.chain.values() if item["exe"] == str(self.worker))
            worker["created"] += 1
        self.downloader.side_effect = download_then_reuse_worker_pid
        with self.assertRaises((RuntimeError, OSError)):
            self.repair()
        self.assert_old_intact()

    def test_stage_tampering_immediately_before_replace_is_refused_and_cleaned(self):
        def corrupt_staged_node(current):
            for staged in self.node.parent.glob(".vivary-node-stage-*"):
                staged.write_bytes(self.patched + b"changed after authentication")
        self.quiescent.side_effect = corrupt_staged_node
        with self.assertRaises((RuntimeError, OSError)):
            self.repair()
        self.assert_old_intact()
        self.assertEqual(list(self.node.parent.iterdir()), [self.node])

    def test_interrupted_staging_cleans_the_exclusive_partial_file(self):
        def partial_copy(source, output, artifact):
            output.write(b"partial fixture member")
            raise OSError("fixture write interrupted")
        with mock.patch.object(self.module, "copy_node", side_effect=partial_copy):
            with self.assertRaises(OSError):
                self.repair()
        self.assert_old_intact()
        self.assertEqual(list(self.node.parent.iterdir()), [self.node])

    def test_interrupted_downloader_cleans_its_partial_download(self):
        partials = []
        def partial_download(artifact, destination):
            path = Path(destination)
            path.write_bytes(self.payload[:10])
            partials.append(path)
            raise self.module.subprocess.CalledProcessError(28, ["fixture curl"])
        self.downloader.side_effect = partial_download
        with self.assertRaises(self.module.subprocess.CalledProcessError):
            self.repair()
        self.assert_old_intact()
        self.assertTrue(partials)
        self.assertTrue(all(not path.exists() for path in partials))

    def test_native_curl_is_fixed_https_only_bounded_and_cannot_inherit_executable_injection(self):
        downloaded = self.directory / "curl-download"
        downloaded.touch()
        calls = []
        def curl(arguments, **options):
            calls.append((arguments, options))
            self.assertEqual(arguments[0], "/usr/bin/curl")
            self.assertEqual(arguments[1], "--disable")
            self.assertEqual(arguments[arguments.index("--proto") + 1], "=https")
            self.assertEqual(arguments[arguments.index("--proto-redir") + 1], "=https")
            self.assertEqual(arguments[arguments.index("--max-filesize") + 1], str(self.artifact["size"]))
            self.assertNotIn("--insecure", arguments)
            self.assertFalse(options.get("shell", False))
            self.assertLessEqual(options["timeout"], 100)
            self.assertNotIn("LD_PRELOAD", options["env"])
            self.assertNotIn("NODE_OPTIONS", options["env"])
            self.assertNotIn("PATH", options["env"])
            Path(arguments[arguments.index("--output") + 1]).write_bytes(self.payload)
            return SimpleNamespace(returncode=0)
        with mock.patch.dict(os.environ, PATH="/untrusted/fixture", LD_PRELOAD="fixture-injection", NODE_OPTIONS="fixture-injection"), \
                mock.patch.object(self.module.subprocess, "run", side_effect=curl):
            self.download_real(self.artifact, downloaded)
        self.assertEqual(len(calls), 1)
        self.assertEqual(downloaded.read_bytes(), self.payload)

    def test_downloader_rejects_partial_bytes_even_if_curl_reports_success(self):
        downloaded = self.directory / "partial-curl-download"
        downloaded.touch()
        def curl(arguments, **options):
            downloaded.write_bytes(self.payload[:-1])
            return SimpleNamespace(returncode=0)
        with mock.patch.object(self.module.subprocess, "run", side_effect=curl):
            with self.assertRaises(RuntimeError):
                self.download_real(self.artifact, downloaded)
        self.assert_old_intact()

    def test_linux_quiescence_requires_a_held_descriptor_for_the_original_inode(self):
        current = self.module.context()
        other = self.directory / "other-inode"
        other.write_bytes(self.old)
        descriptor = os.open(other, os.O_WRONLY)
        try:
            current["lease"] = descriptor
            with self.assertRaisesRegex(RuntimeError, "write lease changed"):
                self.assert_quiescent_real(current)
        finally:
            os.close(descriptor)
        with self.assertRaises(OSError):
            self.assert_quiescent_real(current)

    def test_changed_original_refuses_write_lease_and_closes_its_descriptor(self):
        current = self.module.context()
        self.node.write_bytes(self.old + b"changed after discovery")
        opening = os.open
        descriptors = []
        def tracked_open(*arguments, **options):
            descriptor = opening(*arguments, **options)
            descriptors.append(descriptor)
            return descriptor
        with mock.patch.object(self.module.os, "open", side_effect=tracked_open):
            with self.assertRaisesRegex(RuntimeError, "changed before its write lease"):
                self.module.acquire_write_lease(current)
        self.assertEqual(len(descriptors), 1)
        with self.assertRaises(OSError) as closed:
            os.fstat(descriptors[0])
        self.assertEqual(closed.exception.errno, errno.EBADF)

    def copy_qualified_node(self, destination):
        digest = "e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb"
        selected = os.environ.get("VIVARY_TEST_NODE") or shutil.which("node")
        candidates = [Path(selected)] if selected else []
        source = None
        for candidate in candidates:
            try:
                candidate = candidate.resolve(strict=True)
                if candidate.is_file() and self.admission.sha256(candidate) == digest:
                    source = candidate
                    break
            except OSError:
                continue
        self.assertIsNotNone(source, "kernel lease fixtures require the hash-qualified Linux x64 Node 24.22.1 executable via VIVARY_TEST_NODE or PATH")
        shutil.copyfile(source, destination)
        destination.chmod(0o751)
        self.assertEqual(self.admission.sha256(destination), digest)

    def test_kernel_refuses_write_lease_while_a_qualified_safe_node_copy_is_running(self):
        self.copy_qualified_node(self.node)
        current = self.module.context()
        process = self.module.subprocess.Popen(
            [str(self.node), "-e", "setInterval(() => {}, 1000)"],
            env=self.admission.sanitized_environment("linux"),
            stdin=self.module.subprocess.DEVNULL, stdout=self.module.subprocess.DEVNULL,
            stderr=self.module.subprocess.DEVNULL,
        )
        try:
            self.assertIsNone(process.poll())
            with self.assertRaisesRegex(self.module.RepairRefusal, "write-lease: selected-node-busy") as busy:
                self.module.acquire_write_lease(current)
            self.assertIn(f"errno={errno.ETXTBSY}", str(busy.exception))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except self.module.subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        descriptor = self.module.acquire_write_lease(current)
        os.close(descriptor)

    def test_kernel_lease_blocks_old_inode_exec_but_allows_the_atomic_new_path(self):
        self.copy_qualified_node(self.node)
        current = self.module.context()
        descriptor = current["lease"] = self.module.acquire_write_lease(current)
        try:
            self.assert_quiescent_real(current)
            with self.assertRaises(OSError) as busy:
                self.module.subprocess.run([str(self.node), "--version"],
                                           env=self.admission.sanitized_environment("linux"),
                                           check=True, capture_output=True, timeout=10)
            self.assertEqual(busy.exception.errno, errno.ETXTBSY)
            replacement = self.directory / "qualified-new-inode"
            self.copy_qualified_node(replacement)
            os.replace(replacement, self.node)
            self.assert_quiescent_real(current)
            result = self.module.subprocess.run([str(self.node), "--version"],
                                                env=self.admission.sanitized_environment("linux"),
                                                check=True, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.stdout.strip(), "v24.22.1")
            self.assertEqual(os.fstat(descriptor).st_ino, current["original"][1])
            self.assertNotEqual(self.node.stat().st_ino, current["original"][1])
        finally:
            os.close(descriptor)

    def test_windows_quiescence_refuses_selected_or_unreadable_node_processes(self):
        current = {"system": "win32", "interpreter": self.node}
        for process in ({"exe": str(self.node)}, PermissionError("fixture Node process unreadable")):
            with self.subTest(process=type(process).__name__), \
                    mock.patch.object(self.module, "windows_node_processes", return_value=[345]), \
                    mock.patch.object(self.admission, "windows_process", side_effect=[process]):
                with self.assertRaisesRegex(RuntimeError, "still running|cannot be inspected"):
                    self.assert_quiescent_real(current)

    def test_windows_raw_executable_is_authenticated_and_checked_as_native_x64_before_use(self):
        downloaded = self.directory / "windows-download"
        for machine, passes in ((0x8664, True), (0xaa64, False)):
            payload = pe(machine)
            downloaded.write_bytes(payload)
            artifact = {"member": None, "size": len(payload), "node_size": len(payload),
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "node_sha256": hashlib.sha256(payload).hexdigest()}
            with self.subTest(machine=machine), mock.patch.object(self.module.sys, "platform", "win32"):
                if passes:
                    staged = self.module.stage_node(artifact, downloaded, self.node.parent, 0o751)
                    self.assertEqual(staged.read_bytes(), payload)
                    staged.unlink()
                else:
                    with self.assertRaises(RuntimeError):
                        self.module.stage_node(artifact, downloaded, self.node.parent, 0o751)
        self.assertEqual(list(self.node.parent.iterdir()), [self.node])
        self.probe.assert_not_called()

    def test_windows_snapshot_enumerates_node_names_and_refuses_incomplete_results(self):
        class Function:
            def __init__(self, call):
                self.call = call
            def __call__(self, *arguments):
                return self.call(*arguments)
        for error, passes in ((18, True), (5, False)):
            entries = iter(((30, "python.exe"), (345, "NODE.EXE"), (400, "other.exe")))
            def next_entry(handle, pointer):
                try:
                    pid, name = next(entries)
                except StopIteration:
                    return 0
                pointer._obj.th32ProcessID = pid
                pointer._obj.szExeFile = name
                return 1
            close = mock.Mock()
            kernel = SimpleNamespace(CreateToolhelp32Snapshot=Function(lambda flags, pid: 99),
                                     Process32FirstW=Function(next_entry), Process32NextW=Function(next_entry),
                                     CloseHandle=Function(close))
            with self.subTest(snapshot_error=error), \
                    mock.patch.object(ctypes, "WinDLL", return_value=kernel, create=True), \
                    mock.patch.object(ctypes, "get_last_error", return_value=error, create=True):
                if passes:
                    self.assertEqual(list(self.module.windows_node_processes()), [345])
                else:
                    with self.assertRaisesRegex(RuntimeError, "snapshot incomplete"):
                        list(self.module.windows_node_processes())
            close.assert_called_once_with(99)

    def test_curl_failures_preserve_only_return_code_or_deadline_diagnostics(self):
        secret = "PRIVATE_CURL_DIAGNOSTIC_AND_CREDENTIAL"
        cases = [
            (self.module.subprocess.CalledProcessError(code, [secret], output=secret, stderr=secret),
             f"curlReturnCode={code}") for code in (22, 60)
        ]
        cases.append((self.module.subprocess.TimeoutExpired([secret], 95, output=secret, stderr=secret),
                      "download exceeded its deadline"))
        self.downloader.side_effect = self.download_real
        for error, diagnostic in cases:
            with self.subTest(diagnostic=diagnostic), \
                    mock.patch.object(self.module.subprocess, "run", side_effect=error):
                message = self.refusal_output()
                self.assertIn(diagnostic, message)
                self.assertNotIn(secret, message)
                self.assertNotIn(str(error.cmd), message)
                self.assert_old_intact()

    def test_lease_permissions_report_numeric_errno_without_raw_exception_paths(self):
        secret = "PRIVATE_LEASE_DIAGNOSTIC_AND_CREDENTIAL"
        for code in (errno.EACCES, errno.EPERM, errno.EROFS):
            error = OSError(code, secret, "/private/" + secret)
            with self.subTest(errno=code), mock.patch.object(self.module.os, "open", side_effect=error):
                message = self.refusal_output()
                self.assertIn("write-lease: same-user-write-unavailable", message)
                self.assertIn(f"errno={code}", message)
                self.assertNotIn(secret, message)
                self.assert_old_intact()

    def test_atomic_replacement_lock_and_permission_diagnostics_are_owned_and_redacted(self):
        secret = "PRIVATE_REPLACEMENT_DIAGNOSTIC_AND_CREDENTIAL"
        sharing = PermissionError(errno.EACCES, secret, "/private/" + secret)
        sharing.winerror = 32
        readonly = OSError(errno.EROFS, secret, "/private/" + secret)
        for error, diagnostic, windows in ((sharing, "image-sharing-lock", 32),
                                          (readonly, "same-user-write-unavailable", 0)):
            with self.subTest(diagnostic=diagnostic), \
                    mock.patch.object(self.module.os, "replace", side_effect=error):
                message = self.refusal_output()
                self.assertIn("atomic-replacement: " + diagnostic, message)
                self.assertIn(f"errno={error.errno}, winerror={windows}", message)
                self.assertNotIn(secret, message)
                self.assert_old_intact()
                self.assertEqual(list(self.node.parent.iterdir()), [self.node])

    def test_unknown_affected_runtime_keeps_the_unchanged_guard_phase_and_numeric_versions(self):
        unknown = elf(b"fixture unknown affected Node; never executed")
        self.node.write_bytes(unknown)
        self.probe.return_value = "v24.21.0"
        message = self.refusal_output()
        self.assertIn("Runner action Node: admission failed (phase=interpreter-version", message)
        self.assertIn("observedNode=24.21.0, requiredNode=24.22.1", message)
        self.assertNotIn(str(self.directory), message)
        self.assertEqual(self.node.read_bytes(), unknown)
        self.downloader.assert_not_called()


class RepairMainDiagnosticTests(unittest.TestCase):
    """The workflow step runs this wrapper main(), so its failure formats are what CI shows."""

    def test_main_reports_each_failure_class_in_the_step_format(self):
        module = load_helper()
        runtime = RuntimeError("fixture")
        cases = ((module.RepairRefusal("Runner Node repair: refused (reason=fixture)"), "Runner Node repair: refused (reason=fixture)"),
                 (PermissionError(errno.EACCES, "denied"), "Runner Node repair: filesystem: "),
                 (TypeError("fixture"), "Runner Node repair: refused (exception=TypeError)"),
                 (runtime, module.admission.admission_failure(runtime)))
        for error, expected in cases:
            with self.subTest(error=type(error).__name__), mock.patch.object(module.sys, "argv", ["bootstrap"]), \
                    mock.patch.object(module, "repair_runner_action_node", side_effect=error), \
                    contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(module.main(), 1)
            self.assertEqual(out.getvalue(), "")
            self.assertTrue(err.getvalue().startswith(expected), err.getvalue())

    def test_container_detection_permission_error_reaches_the_repair_filesystem_format(self):
        module = load_helper()
        with mock.patch.object(module.sys, "argv", ["bootstrap"]), \
                mock.patch.object(module.admission, "container_host", side_effect=PermissionError(errno.EACCES, "denied")), \
                contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(module.main(), 1)
        self.assertEqual(out.getvalue(), "")
        self.assertTrue(err.getvalue().startswith("Runner Node repair: filesystem: "), err.getvalue())


if __name__ == "__main__":
    unittest.main()
