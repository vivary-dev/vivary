"""Public-seam tests for thin-v0.3 brownfield adoption."""

import contextlib
import errno
import hashlib
import io
import json
import os
import queue
import subprocess
import threading
import shutil
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
PKG = ROOT / "packages" / "create-vivary"
TROPO = ROOT / "packages" / "tropo"

sys.path.insert(0, str(PKG))
sys.path.insert(0, str(TROPO))

import create_vivary  # noqa: E402
import tropo  # noqa: E402


def temp_dir() -> Path:
    path = ROOT / "sandboxes" / f"test-adopt-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def remove_git_fixture(root: Path) -> None:
    """Remove only this test's disposable Git repo, including read-only Windows objects."""
    def writable_retry(operation, name, _error):
        os.chmod(name, 0o700)
        operation(name)
    shutil.rmtree(root, onerror=writable_retry)


def snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
    }


def run_cli(argv: list[str]) -> tuple[int, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        rc = create_vivary.main(argv)
    return rc, output.getvalue()


class ThinAdoptPlanTests(unittest.TestCase):
    def privacy_request(self, target, preset="coding"):
        plan = create_vivary.plan_adopt(target, preset=preset)
        privacy = plan["privacy_preparation"]
        request = {"schema": "vivary.adopt-privacy-request.v1",
            "root_hash": privacy["root_hash"], "before_hash": privacy["before_hash"],
            "after_hash": privacy["after_hash"]}
        return plan, dict(plan_hash=plan["plan_hash"], request_id="privacy-review",
            privacy_request=request, preset=preset)

    def test_privacy_preparation_replays_ignore_file_line_endings_without_rewrite(self):
        for original in (b"", b"\xef\xbb\xbf", b"# No newline",
                         b"# Line ending\n", b"# Windows line ending\r\n"):
            with self.subTest(original=original):
                target = temp_dir()
                try:
                    (target / ".gitignore").write_bytes(original)
                    plan, kwargs = self.privacy_request(target)
                    planned = next(file for file in plan["content_plan"]["files"]
                        if file["path"] == ".gitignore")
                    self.assertFalse(create_vivary.prepare_adopt_privacy(target, **kwargs)["replayed"])
                    expected = planned["content"].encode("utf-8")
                    self.assertEqual((target / ".gitignore").read_bytes(), expected)
                    mtime = (target / ".gitignore").stat().st_mtime_ns
                    self.assertTrue(create_vivary.prepare_adopt_privacy(target, **kwargs)["replayed"])
                    self.assertEqual((target / ".gitignore").read_bytes(), expected)
                    self.assertEqual((target / ".gitignore").stat().st_mtime_ns, mtime)
                finally:
                    shutil.rmtree(target)

    def test_privacy_preparation_preserves_existing_ignore_and_requires_fresh_setup_review(self):
        target = temp_dir()
        try:
            original_ignore = b"# Owner rules\r\nnode_modules/\r\n"
            (target / ".gitignore").write_bytes(original_ignore)
            (target / "AGENTS.md").write_bytes(b"# Owner instructions\n")
            (target / "notes.txt").write_bytes(b"Keep this content\n")
            before = snapshot(target)
            plan, kwargs = self.privacy_request(target)
            self.assertTrue(plan["privacy_preparation"]["ready"])
            self.assertEqual(snapshot(target), before)
            approved = plan["content_plan"]["files"]
            ignore = next(file for file in approved if file["path"] == ".gitignore")
            result = create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertFalse(result["replayed"])
            self.assertEqual((target / ".gitignore").read_bytes(), ignore["content"].encode("utf-8"))
            self.assertEqual((target / "AGENTS.md").read_bytes(), b"# Owner instructions\n")
            self.assertEqual((target / "notes.txt").read_bytes(), b"Keep this content\n")
            self.assertEqual(set(snapshot(target)), set(before))
            fresh = create_vivary.plan_adopt(target, preset="coding")
            self.assertTrue(fresh["request_replay"]["ready"])
            self.assertNotEqual(fresh["plan_hash"], plan["plan_hash"])
            with self.assertRaisesRegex(create_vivary.AdoptAttemptRefusal, "plan hash mismatch"):
                create_vivary.adopt_workspace(target, preset="coding", yes=True,
                    plan_hash=plan["plan_hash"], request_id="stale-setup")
            self.assertEqual((target / ".gitignore").read_bytes(), ignore["content"].encode("utf-8"))
        finally:
            shutil.rmtree(target)

    def test_privacy_preparation_rejects_changed_review_and_retries_postwrite_lost_reply(self):
        target = temp_dir()
        try:
            (target / "AGENTS.md").write_bytes(b"# Owner instructions\n")
            plan, kwargs = self.privacy_request(target)
            (target / "AGENTS.md").write_bytes(b"# Owner changed instructions\n")
            before = snapshot(target)
            with self.assertRaisesRegex(create_vivary.AdoptAttemptRefusal, "changed"):
                create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertEqual(snapshot(target), before)
            plan, kwargs = self.privacy_request(target)
            original = create_vivary._atomic_write_bytes_no_follow
            def lost_reply(*args, **named):
                original(*args, **named)
                raise OSError("simulated lost acknowledgement after atomic replacement")
            with mock.patch.object(create_vivary, "_atomic_write_bytes_no_follow", side_effect=lost_reply):
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
            after = snapshot(target)
            self.assertEqual(set(after), {"AGENTS.md", ".gitignore"})
            self.assertTrue(create_vivary.prepare_adopt_privacy(target, **kwargs)["replayed"])
            self.assertEqual(snapshot(target), after)
            self.assertTrue(create_vivary.plan_adopt(target, preset="coding")["request_replay"]["ready"])
        finally:
            shutil.rmtree(target)

    def test_privacy_preparation_refuses_tracked_runtime_in_child_or_parent_repo(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                root = temp_dir()
                try:
                    repo = root / "parent" if nested else root
                    repo.mkdir(exist_ok=True)
                    target = repo / "child" if nested else repo
                    target.mkdir(exist_ok=True)
                    write(target / ".vivary/runtime/private.json", "private backup")
                    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
                    subprocess.run(["git", "-C", str(repo), "add", "-f",
                        str((target / ".vivary/runtime/private.json").relative_to(repo))], check=True)
                    plan = create_vivary.plan_adopt(target, preset="coding")
                    self.assertFalse(plan["request_replay"]["ready"])
                    self.assertIn("tracks", plan["request_replay"]["reason"])
                    self.assertFalse(plan["privacy_preparation"]["ready"])
                    before = snapshot(target)
                    (target / ".vivary/runtime/private.json").unlink()
                    (target / ".vivary/runtime").rmdir()
                    sparse = create_vivary.plan_adopt(target, preset="coding")
                    self.assertFalse(sparse["privacy_preparation"]["ready"])
                    self.assertIn("tracks", sparse["privacy_preparation"]["reason"])
                    write(target / ".vivary/runtime/private.json", "private backup")
                    _, kwargs = self.privacy_request(target)
                    with self.assertRaises(create_vivary.AdoptAttemptRefusal):
                        create_vivary.prepare_adopt_privacy(target, **kwargs)
                    self.assertEqual(snapshot(target), before)
                finally:
                    remove_git_fixture(root)

    def test_privacy_preparation_checks_parent_index_when_target_is_nested_repo(self):
        root = temp_dir()
        try:
            parent = root / "parent"
            target = parent / "child"
            target.mkdir(parents=True)
            tracked = target / ".vivary/runtime/private.json"
            write(tracked, "private backup")
            subprocess.run(["git", "-C", str(parent), "init", "-q"], check=True)
            subprocess.run(["git", "-C", str(parent), "add", "-f",
                "child/.vivary/runtime/private.json"], check=True)
            tracked.unlink()
            tracked.parent.rmdir()
            subprocess.run(["git", "-C", str(target), "init", "-q"], check=True)

            plan, kwargs = self.privacy_request(target)
            self.assertFalse(plan["privacy_preparation"]["ready"])
            self.assertIn("tracks", plan["privacy_preparation"]["reason"])
            with self.assertRaisesRegex(
                create_vivary.AdoptAttemptRefusal, "Git already tracks"
            ):
                create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertFalse((target / ".gitignore").exists())
            self.assertFalse((target / ".vivary/runtime").exists())
        finally:
            remove_git_fixture(root)

    def test_privacy_preparation_refuses_mixed_case_tracked_runtime(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                root = temp_dir()
                try:
                    repo = root / "parent" if nested else root
                    repo.mkdir(exist_ok=True)
                    target = repo / "child" if nested else repo
                    target.mkdir(exist_ok=True)
                    tracked = (repo / "Child" if nested else target) / ".Vivary/runtime/private.json"
                    write(tracked, "private backup")
                    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
                    subprocess.run(["git", "-C", str(repo), "config", "core.ignoreCase", "true"], check=True)
                    subprocess.run(["git", "-C", str(repo), "add", "-f",
                        str(tracked.relative_to(repo))], check=True)
                    tracked.unlink()
                    tracked.parent.rmdir()

                    with mock.patch.dict(os.environ, {"GIT_LITERAL_PATHSPECS": "1"}):
                        plan = create_vivary.plan_adopt(target, preset="coding")
                    self.assertFalse(plan["privacy_preparation"]["ready"])
                    self.assertIn("tracks", plan["privacy_preparation"]["reason"])
                    self.assertFalse((target / ".gitignore").exists())
                    self.assertFalse((target / ".vivary/runtime").exists())
                finally:
                    remove_git_fixture(root)

    def test_privacy_preview_refuses_dangling_ignore_link(self):
        target = temp_dir()
        try:
            ignore = target / ".gitignore"
            missing = target / "missing-ignore-target"
            try:
                ignore.symlink_to(missing)
            except OSError as error:
                if os.name == "nt" and error.winerror in (50, 1314):
                    self.skipTest("symlink creation is unavailable")
                raise
            plan = create_vivary.plan_adopt(target, preset="coding")
            self.assertFalse(plan["privacy_preparation"]["ready"])
            self.assertTrue(any(
                item["path"] == ignore and ".gitignore is not a regular file" in item["reason"]
                for item in plan["conflicts"]
            ))
            self.assertFalse(any(
                item["path"] == ".gitignore" and item["operation"] == "create"
                for item in plan["content_plan"]["files"]
            ))
            self.assertTrue(ignore.is_symlink())
            self.assertFalse(missing.exists())
        finally:
            shutil.rmtree(target)

    def test_privacy_preparation_refuses_other_root_and_legacy_pending_journal(self):
        first = temp_dir()
        second = temp_dir()
        try:
            plan, kwargs = self.privacy_request(first)
            before = snapshot(second)
            with self.assertRaises(create_vivary.AdoptAttemptRefusal):
                create_vivary.prepare_adopt_privacy(second, **kwargs)
            self.assertEqual(snapshot(second), before)
            journal = first / ".vivary/runtime/adopt-journal.json"
            journal.parent.mkdir(parents=True)
            journal.write_bytes(b"prior transaction")
            blocked = create_vivary.plan_adopt(first, preset="coding")
            self.assertFalse(blocked["privacy_preparation"]["ready"])
            self.assertFalse(blocked["request_replay"]["ready"])
            before = snapshot(first)
            with self.assertRaises(create_vivary.AdoptAttemptRefusal):
                create_vivary.prepare_adopt_privacy(first, **kwargs)
            self.assertEqual(snapshot(first), before)
        finally:
            shutil.rmtree(first)
            shutil.rmtree(second)

    def test_privacy_preparation_refuses_linked_ignore_and_runtime(self):
        root = temp_dir()
        try:
            target = root / "project"
            target.mkdir()
            outside = root / "outside"
            outside.write_bytes(b"# Outside\n")
            (target / ".gitignore").symlink_to(outside)
            plan = create_vivary.plan_adopt(target, preset="coding")
            self.assertTrue(plan["conflicts"])
            self.assertFalse(plan["privacy_preparation"]["ready"])
            (target / ".gitignore").unlink()
            plan, kwargs = self.privacy_request(target)
            (target / ".vivary").mkdir()
            (target / ".vivary/runtime").symlink_to(root, target_is_directory=True)
            with self.assertRaises(create_vivary.AdoptAttemptRefusal):
                create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertFalse((target / ".gitignore").exists())
            self.assertEqual(outside.read_bytes(), b"# Outside\n")
        finally:
            shutil.rmtree(root)

    def test_unprotected_folder_prepares_only_reviewed_privacy_then_replays(self):
        target = temp_dir()
        try:
            (target / "notes.txt").write_bytes(b"Existing work\n")
            report = create_vivary._adopt_report_to_json(
                create_vivary.plan_adopt(target, preset="coding"), mode="dry-run")
            privacy = report["privacy_preparation"]
            self.assertTrue(privacy["required"])
            self.assertTrue(privacy["ready"])
            request = {"schema": "vivary.adopt-privacy-request.v1",
                "root_hash": privacy["root_hash"], "before_hash": privacy["before_hash"],
                "after_hash": privacy["after_hash"]}
            kwargs = dict(preset="coding", plan_hash=report["plan_hash"],
                request_id="privacy-test", privacy_request=request)
            applied = create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertFalse(applied["replayed"])
            self.assertEqual(set(snapshot(target)), {"notes.txt", ".gitignore"})
            self.assertEqual((target / "notes.txt").read_bytes(), b"Existing work\n")
            self.assertTrue(create_vivary.plan_adopt(target, preset="coding")["request_replay"]["ready"])
            replay = create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertTrue(replay["replayed"])
            self.assertEqual(set(snapshot(target)), {"notes.txt", ".gitignore"})
        finally:
            shutil.rmtree(target)

    def test_unprotected_folder_recovery_keeps_prepared_privacy_and_restores_other_files(self):
        for original_ignore in (None, b"# Owner ignore\nnode_modules/\n"):
            with self.subTest(original_ignore=original_ignore):
                target = temp_dir()
                try:
                    if original_ignore is not None:
                        (target / ".gitignore").write_bytes(original_ignore)
                    (target / "AGENTS.md").write_bytes(b"# Original guidance\n")
                    (target / "notes.txt").write_bytes(b"Private notes\n")
                    _plan, kwargs = self.privacy_request(target)
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
                    protected = {p.relative_to(target).as_posix(): p.read_bytes()
                        for p in target.rglob("*") if p.is_file()}
                    setup = create_vivary.plan_adopt(target, preset="coding")
                    self.assertTrue(setup["request_replay"]["ready"])
                    with self.assertRaises(KeyboardInterrupt):
                        create_vivary.adopt_workspace(target, preset="coding", yes=True,
                            plan_hash=setup["plan_hash"], request_id="full-setup",
                            _crash_after=2)
                    review = create_vivary.adopt_workspace(target,
                        recover_hash=setup["plan_hash"], request_id="full-setup")
                    self.assertFalse(review["recovered"])
                    restored = create_vivary.adopt_workspace(target, yes=True,
                        recover_hash=setup["plan_hash"], plan_hash=review["recovery_plan_hash"],
                        request_id="full-setup")
                    self.assertTrue(restored["recovered"])
                    user_files = {p.relative_to(target).as_posix(): p.read_bytes()
                        for p in target.rglob("*") if p.is_file()
                        and not p.relative_to(target).as_posix().startswith(".vivary/runtime/")}
                    self.assertEqual(user_files, protected)
                    receipt = target / ".vivary/runtime/adopt-receipts/full-setup.json"
                    self.assertTrue(receipt.is_file())
                    self.assertTrue(create_vivary._probe_is_ignored(target,
                        receipt.relative_to(target).as_posix()))
                    replay = create_vivary.adopt_workspace(target, yes=True,
                        recover_hash=setup["plan_hash"], plan_hash=review["recovery_plan_hash"],
                        request_id="full-setup")
                    self.assertTrue(replay["recovered"])
                    self.assertTrue(create_vivary.plan_adopt(target, preset="coding")["request_replay"]["ready"])
                finally:
                    shutil.rmtree(target)

    def test_privacy_preparation_subprocess_retry_preserves_exact_bytes_and_timestamp(self):
        target = temp_dir()
        try:
            (target / "notes.txt").write_bytes(b"Unrelated notes\n")
            plan, kwargs = self.privacy_request(target)
            args = [sys.executable, str(PKG / "create_vivary.py"), "adopt",
                str(target), "--preset", "coding", "--json", "--yes",
                "--prepare-privacy", "--plan", plan["plan_hash"],
                "--request-id", kwargs["request_id"], "--privacy-request", "-"]
            document = json.dumps(kwargs["privacy_request"])
            first = subprocess.run(args, input=document, text=True, capture_output=True, check=True)
            self.assertFalse(json.loads(first.stdout)["replayed"])
            after = {p.relative_to(target).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in target.rglob("*") if p.is_file()}
            second = subprocess.run(args, input=document, text=True, capture_output=True, check=True)
            self.assertTrue(json.loads(second.stdout)["replayed"])
            self.assertEqual(after, {p.relative_to(target).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in target.rglob("*") if p.is_file()})
            self.assertEqual(set(after), {"notes.txt", ".gitignore"})
        finally:
            shutil.rmtree(target)

    def test_privacy_preparation_prewrite_failure_can_retry_same_review(self):
        target = temp_dir()
        try:
            plan, kwargs = self.privacy_request(target)
            before = snapshot(target)
            with mock.patch.object(create_vivary, "_atomic_write_bytes_no_follow",
                side_effect=OSError("simulated failure before replacement")):
                with self.assertRaises(create_vivary.AdoptAttemptRefusal) as caught:
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertEqual(caught.exception.attempt["attempt_status"], "refused_before_mutation")
            self.assertEqual(snapshot(target), before)
            self.assertFalse(create_vivary.prepare_adopt_privacy(target, **kwargs)["replayed"])
            self.assertTrue(create_vivary.plan_adopt(target, preset="coding")["request_replay"]["ready"])
        finally:
            shutil.rmtree(target)

    def test_privacy_preparation_refuses_edit_before_held_append(self):
        target = temp_dir()
        try:
            ignore = target / ".gitignore"
            ignore.write_bytes(b"# Initial\n")
            _plan, kwargs = self.privacy_request(target)
            original = create_vivary._append_reviewed_bytes_no_follow
            def change_before_open(*args, **named):
                ignore.write_bytes(b"# External edit\n")
                return original(*args, **named)
            with mock.patch.object(create_vivary, "_append_reviewed_bytes_no_follow",
                side_effect=change_before_open):
                with self.assertRaisesRegex(create_vivary.AdoptAttemptRefusal, "changed before writes") as caught:
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertEqual(caught.exception.attempt["attempt_status"], "refused_before_mutation")
            self.assertEqual(ignore.read_bytes(), b"# External edit\n")
            self.assertFalse((target / ".vivary").exists())
        finally:
            shutil.rmtree(target)

    def test_privacy_preparation_refuses_hardlinked_ignore_without_touching_other_name(self):
        root = temp_dir()
        try:
            target = root / "project"
            target.mkdir()
            outside = root / "outside-ignore"
            outside.write_bytes(b"# Keep other name\n")
            (target / ".gitignore").hardlink_to(outside)
            plan, kwargs = self.privacy_request(target)
            self.assertFalse(plan["privacy_preparation"]["ready"])
            self.assertIn("hard-link", plan["privacy_preparation"]["reason"])
            with self.assertRaises(create_vivary.AdoptAttemptRefusal):
                create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertEqual(outside.read_bytes(), b"# Keep other name\n")
            self.assertEqual((target / ".gitignore").read_bytes(), b"# Keep other name\n")
        finally:
            shutil.rmtree(root)

    def test_privacy_append_refuses_runtime_created_after_preview(self):
        target = temp_dir()
        try:
            ignore = target / ".gitignore"
            ignore.write_bytes(b"# Reviewed\n")
            _plan, kwargs = self.privacy_request(target)
            original = create_vivary._append_reviewed_bytes_no_follow
            def runtime_appears(*args, **named):
                (target / ".vivary/runtime").mkdir(parents=True)
                return original(*args, **named)
            with mock.patch.object(create_vivary, "_append_reviewed_bytes_no_follow",
                side_effect=runtime_appears):
                with self.assertRaisesRegex(
                    create_vivary.AdoptAttemptRefusal, "runtime content needs review"
                ):
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertEqual(ignore.read_bytes(), b"# Reviewed\n")
        finally:
            shutil.rmtree(target)

    def test_privacy_create_refuses_runtime_created_after_preview(self):
        target = temp_dir()
        try:
            _plan, kwargs = self.privacy_request(target)
            original = create_vivary._atomic_write_bytes_no_follow
            def runtime_appears(*args, **named):
                (target / ".vivary/runtime").mkdir(parents=True)
                return original(*args, **named)
            with mock.patch.object(create_vivary, "_atomic_write_bytes_no_follow",
                side_effect=runtime_appears):
                with self.assertRaisesRegex(
                    create_vivary.AdoptAttemptRefusal, "runtime content needs review"
                ):
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertFalse((target / ".gitignore").exists())
        finally:
            shutil.rmtree(target)

    @unittest.skipIf(os.name == "nt", "FIFO is a POSIX special file")
    def test_privacy_append_refuses_fifo_replacing_reviewed_file(self):
        target = temp_dir()
        try:
            ignore = target / ".gitignore"
            ignore.write_bytes(b"# Reviewed\n")
            _plan, kwargs = self.privacy_request(target)
            ignore.unlink()
            os.mkfifo(ignore)
            with self.assertRaises(create_vivary.AdoptAttemptRefusal):
                create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertFalse((target / ".vivary").exists())
        finally:
            shutil.rmtree(target)

    @unittest.skipIf(os.name == "nt", "POSIX editor can write through an open append descriptor")
    def test_privacy_append_preserves_noncooperating_edit_after_final_check(self):
        target = temp_dir()
        try:
            ignore = target / ".gitignore"
            ignore.write_bytes(b"# Reviewed\n")
            _plan, kwargs = self.privacy_request(target)
            original_write = os.write
            edited = False
            def editor_then_append(fd, data):
                nonlocal edited
                if not edited:
                    edited = True
                    with ignore.open("ab") as stream:
                        stream.write(b"# Editor wrote this\n")
                return original_write(fd, data)
            with mock.patch.object(create_vivary.os, "write", side_effect=editor_then_append):
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertTrue(edited)
            self.assertTrue(ignore.read_bytes().startswith(
                b"# Reviewed\n# Editor wrote this\n"))
        finally:
            shutil.rmtree(target)

    @unittest.skipIf(os.name == "nt", "POSIX rename can replace a held append path")
    def test_privacy_append_does_not_replace_new_editor_file(self):
        target = temp_dir()
        try:
            ignore = target / ".gitignore"
            moved = target / "editor-preserved-ignore"
            ignore.write_bytes(b"# Reviewed\n")
            _plan, kwargs = self.privacy_request(target)
            original_write = os.write
            renamed = False
            def rename_then_append(fd, data):
                nonlocal renamed
                if not renamed:
                    renamed = True
                    os.replace(ignore, moved)
                    ignore.write_bytes(b"# New editor file\n")
                return original_write(fd, data)
            with mock.patch.object(create_vivary.os, "write", side_effect=rename_then_append):
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertTrue(renamed)
            self.assertEqual(ignore.read_bytes(), b"# New editor file\n")
            self.assertTrue(moved.read_bytes().startswith(b"# Reviewed\n"))
        finally:
            shutil.rmtree(target)

    def test_privacy_append_partial_write_stays_pending_without_erasing_original(self):
        target = temp_dir()
        try:
            ignore = target / ".gitignore"
            ignore.write_bytes(b"# Reviewed\n")
            _plan, kwargs = self.privacy_request(target)
            original_write = os.write
            def short_write(fd, data):
                return original_write(fd, data[:max(1, len(data) // 2)])
            with mock.patch.object(create_vivary.os, "write", side_effect=short_write):
                with self.assertRaises(create_vivary.ScaffoldError) as caught:
                    create_vivary.prepare_adopt_privacy(target, **kwargs)
            self.assertNotIsInstance(caught.exception, create_vivary.AdoptAttemptRefusal)
            self.assertTrue(ignore.read_bytes().startswith(b"# Reviewed\n"))
            self.assertGreater(len(ignore.read_bytes()), len(b"# Reviewed\n"))
        finally:
            shutil.rmtree(target)

    @unittest.skipUnless(os.name == "nt", "Windows sharing rules protect an open append handle")
    def test_privacy_append_denies_other_windows_writer_while_held(self):
        target = temp_dir()
        try:
            ignore = target / ".gitignore"
            ignore.write_bytes(b"# Reviewed\n")
            _plan, kwargs = self.privacy_request(target)
            original_write = os.write
            def other_writer_is_blocked(fd, data):
                with self.assertRaises(OSError):
                    with ignore.open("ab") as stream:
                        stream.write(b"# Other writer\n")
                return original_write(fd, data)
            with mock.patch.object(create_vivary.os, "write", side_effect=other_writer_is_blocked):
                self.assertFalse(create_vivary.prepare_adopt_privacy(target, **kwargs)["replayed"])
            self.assertNotIn(b"# Other writer", ignore.read_bytes())
        finally:
            shutil.rmtree(target)

    def test_git_index_probe_does_not_run_configured_fsmonitor_hook(self):
        root = temp_dir()
        try:
            target = root / "project"
            target.mkdir()
            write(target / ".vivary/runtime/tracked.json", "private")
            subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
            subprocess.run(["git", "-C", str(root), "add", "-f",
                "project/.vivary/runtime/tracked.json"], check=True)
            marker = root / "hook-called"
            hook = root / "fsmonitor-hook.sh"
            hook.write_text("#!/bin/sh\necho called >> hook-called\nprintf '/\\0'\n",
                encoding="utf-8", newline="\n")
            hook.chmod(0o700)
            def fixture_git(*args):
                result = subprocess.run(["git", "-C", str(root), *args],
                    text=True, capture_output=True)
                self.assertEqual(result.returncode, 0,
                    f"git {' '.join(args)} failed: stdout={result.stdout!r} stderr={result.stderr!r}")
                return result
            fixture_git("config", "core.fsmonitor", "./fsmonitor-hook.sh")
            fixture_git("config", "core.fsmonitorHookVersion", "1")
            output = [fixture_git("update-index", "--fsmonitor")]
            for _attempt in range(3):
                output.append(fixture_git("status", "--porcelain"))
                if marker.exists():
                    break
            self.assertTrue(marker.exists(), "configured Git fsmonitor hook did not execute: "
                + repr([(result.stdout, result.stderr) for result in output]))
            marker.unlink()
            plan = create_vivary.plan_adopt(target, preset="coding")
            self.assertFalse(plan["request_replay"]["ready"])
            self.assertIn("tracks", plan["request_replay"]["reason"])
            self.assertFalse(marker.exists(), "preview executed repository fsmonitor hook")
        finally:
            remove_git_fixture(root)

    def test_request_readiness_is_read_only_and_requires_existing_directory_privacy(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "host guidance\n")
            for rules, ready in [
                ("", False),
                (".vivary/runtime/adopt-journal.json\n.vivary/runtime/adopt-receipts/*.json\n", False),
                (".vivary/runtime/\n", True),
                (".vivary/runtime/\n!.vivary/runtime/\n", False),
            ]:
                with self.subTest(rules=rules):
                    write(target / ".gitignore", rules)
                    before = snapshot(target)
                    directories = sorted(str(p.relative_to(target)) for p in target.rglob("*") if p.is_dir())
                    rc, output = run_cli(["adopt", str(target), "--preset", "coding", "--json"])
                    self.assertEqual(rc, 0, output)
                    readiness = json.loads(output)["request_replay"]
                    self.assertEqual(readiness["ready"], ready)
                    self.assertEqual(readiness["reason"] is None, ready)
                    self.assertEqual(snapshot(target), before)
                    self.assertEqual(sorted(str(p.relative_to(target)) for p in target.rglob("*") if p.is_dir()), directories)
        finally:
            shutil.rmtree(target)

    def test_request_readiness_refuses_pending_journal_and_no_changes(self):
        target = temp_dir()
        try:
            write(target / ".gitignore", ".vivary/runtime/\n")
            plan = create_vivary.adopt_workspace(target, preset="coding")
            self.assertEqual(plan["request_replay"], {"ready": True, "reason": None})
            applied = create_vivary.adopt_workspace(target, preset="coding", yes=True,
                plan_hash=plan["plan_hash"], request_id="readiness-test")
            self.assertNotIn("request_replay", create_vivary._adopt_report_to_json(applied, mode="applied"))
            no_changes = create_vivary.adopt_workspace(target, preset="coding")
            self.assertEqual(no_changes["request_replay"], {
                "ready": False, "reason": "No setup changes need to be applied."})
            write(target / ".vivary/runtime/adopt-journal.json", "pending")
            before = snapshot(target)
            pending = create_vivary.adopt_workspace(target, preset="coding")
            self.assertEqual(pending["request_replay"], {
                "ready": False, "reason": "An unfinished adoption needs recovery or its original request retry."})
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_content_preview_matches_applied_bytes_and_retained_binary(self):
        target = temp_dir()
        try:
            originals = {"AGENTS.md": b"\xef\xbb\xbf# Host\r\n", ".gitignore": b"host-cache/"}
            for name, content in originals.items():
                (target / name).write_bytes(content)
            retained = b"\xff\x00host state"
            (target / "STATE.md").write_bytes(retained)
            before = snapshot(target)
            rc, output = run_cli(["adopt", str(target), "--preset", "coding", "--adapter", "agents", "--json"])
            self.assertEqual(rc, 0, output)
            self.assertEqual(snapshot(target), before)
            report = json.loads(output)
            content_plan = report["content_plan"]
            self.assertEqual(content_plan["schema"], "vivary.adopt-content-plan.v1")
            files = content_plan["files"]
            self.assertEqual([row["path"] for row in files], sorted(row["path"] for row in files))
            by_path = {row["path"]: row for row in files}
            self.assertEqual(set(by_path), {"AGENTS.md", ".gitignore", ".vivary/context.md", ".vivary/workspace.toml", ".agents/skills/vivary/SKILL.md"})
            for name, original in originals.items():
                row = by_path[name]
                block = create_vivary._thin_agents_block() if name == "AGENTS.md" else create_vivary._thin_gitignore_block(active_context=None)
                separator = b"\n" if original.endswith(b"\n") else b"\n\n"
                self.assertEqual(row["content"].encode("utf-8"), original + separator + block.encode("utf-8"))
                self.assertEqual(row["operation"], "patch")
                self.assertEqual(row["before_hash"], "sha256:" + hashlib.sha256(original).hexdigest())
            self.assertEqual(content_plan["kept"], [{"path": "STATE.md", "content_hash": "sha256:" + hashlib.sha256(retained).hexdigest()}])
            plan = create_vivary.plan_adopt(target, preset="coding", adapters=("agents",))
            self.assertEqual(report["plan_hash"], plan["plan_hash"])
            self.assertEqual(plan["plan_hash"], create_vivary._thin_approval_hash(plan["approval_payload"]))
            applied = create_vivary.adopt_workspace(target, preset="coding", adapters=("agents",), yes=True, plan_hash=report["plan_hash"])
            for row in files:
                expected = row["content"].encode("utf-8")
                self.assertEqual((target / row["path"]).read_bytes(), expected)
                self.assertEqual(row["bytes"], len(expected))
                self.assertEqual(row["content_hash"], "sha256:" + hashlib.sha256(expected).hexdigest())
                if row["operation"] == "create":
                    self.assertNotIn("before_hash", row)
            self.assertEqual((target / "STATE.md").read_bytes(), retained)
            for mode in ("applied", "recovered", "recovery-dry-run"):
                self.assertNotIn("content_plan", create_vivary._adopt_report_to_json(applied, mode=mode))
        finally:
            shutil.rmtree(target)

    def test_content_preview_serializes_snapshot_without_rereading(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "host guidance")
            plan = create_vivary.plan_adopt(target, preset="coding")
            first = create_vivary._adopt_report_to_json(plan, mode="dry-run")
            self.assertIn("content_plan", first)
            write(target / "AGENTS.md", "changed after planning")
            write(target / ".gitignore", ".vivary/runtime/\n")
            with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("report reread")), mock.patch.object(Path, "read_text", side_effect=AssertionError("report reread")):
                second = create_vivary._adopt_report_to_json(plan, mode="dry-run")
            self.assertEqual(first, second)
            self.assertFalse(second["request_replay"]["ready"])
            self.assertIn("host guidance", next(row["content"] for row in second["content_plan"]["files"] if row["path"] == "AGENTS.md"))
        finally:
            shutil.rmtree(target)

    def test_content_preview_keeps_invalid_utf8_as_a_conflict(self):
        target = temp_dir()
        try:
            (target / "AGENTS.md").write_bytes(b"\xff")
            before = snapshot(target)
            rc, output = run_cli(["adopt", str(target), "--preset", "coding", "--json"])
            self.assertEqual(rc, 1)
            report = json.loads(output)
            self.assertEqual(report["conflicts"], [{"path": "AGENTS.md", "reason": "AGENTS.md is not UTF-8"}])
            self.assertEqual(report["request_replay"], {
                "ready": False, "reason": "Resolve the setup conflicts and preview again."})
            self.assertNotIn("AGENTS.md", [row["path"] for row in report["content_plan"]["files"]])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_default_dry_run_has_the_exact_thin_footprint_for_host_file_matrix(self):
        cases = {
            "all-host-files": {
                "host_files": ("AGENTS.md", ".gitignore", "STATE.md"),
                "creates": (".vivary/context.md", ".vivary/workspace.toml"),
                "patches": (".gitignore", "AGENTS.md"),
            },
            "state-missing": {
                "host_files": ("AGENTS.md", ".gitignore"),
                "creates": (".vivary/context.md", ".vivary/workspace.toml", "STATE.md"),
                "patches": (".gitignore", "AGENTS.md"),
            },
            "agents-missing": {
                "host_files": (".gitignore",),
                "creates": (
                    ".vivary/context.md",
                    ".vivary/workspace.toml",
                    "AGENTS.md",
                    "STATE.md",
                ),
                "patches": (".gitignore",),
            },
            "startup-and-privacy-missing": {
                "host_files": (),
                "creates": (
                    ".gitignore",
                    ".vivary/context.md",
                    ".vivary/workspace.toml",
                    "AGENTS.md",
                    "STATE.md",
                ),
                "patches": (),
            },
        }
        prohibited_roots = {
            ".agents",
            ".claude",
            "changes",
            "decisions",
            "gates",
            "heartbeat-reports",
            "memory",
            "modules",
            "templates",
            "verification",
        }
        prohibited_files = {
            "MEMORY.md",
            "SOUL.md",
            "STRATO.md",
            "USER.md",
            "bug-risk-playbook.md",
            "tropo.toml",
        }

        for name, case in cases.items():
            with self.subTest(name=name):
                target = temp_dir()
                try:
                    for host_file in case["host_files"]:
                        write(target / host_file, f"existing {host_file}\n")
                    before = snapshot(target)

                    rc, out = run_cli(
                        [
                            "adopt",
                            str(target),
                            "--preset",
                            "coding",
                            "--repo-root",
                            str(ROOT),
                            "--json",
                        ]
                    )

                    self.assertEqual(rc, 0)
                    self.assertEqual(snapshot(target), before, "dry-run must be read-only")
                    payload = json.loads(out)
                    self.assertEqual(payload["contract"], "thin-v0.3")
                    self.assertEqual(tuple(payload["creates"]), case["creates"])
                    self.assertEqual(
                        tuple(patch["path"] for patch in payload["patches"]),
                        case["patches"],
                    )
                    self.assertRegex(payload["plan_hash"], r"^sha256:[0-9a-f]{64}$")

                    planned_paths = set(payload["creates"]) | {
                        patch["path"] for patch in payload["patches"]
                    }
                    self.assertTrue(prohibited_files.isdisjoint(planned_paths))
                    self.assertTrue(
                        prohibited_roots.isdisjoint(
                            {path.split("/", 1)[0] for path in planned_paths}
                        )
                    )
                finally:
                    shutil.rmtree(target)

    def test_optional_adapters_are_closed_bounded_projections_not_default_payload(self):
        target = temp_dir()
        try:
            before = snapshot(target)

            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--preset",
                    "coding",
                    "--adapter",
                    "agents",
                    "--adapter",
                    "claude",
                    "--repo-root",
                    str(ROOT),
                    "--json",
                ]
            )

            self.assertEqual(rc, 0)
            self.assertEqual(snapshot(target), before)
            payload = json.loads(out)
            self.assertEqual(
                [item["path"] for item in payload["optional_projections"]],
                [".agents/skills/vivary/SKILL.md", ".claude/skills/vivary/SKILL.md"],
            )
            self.assertNotIn(".agents/skills/vivary/SKILL.md", payload["creates"])
            self.assertNotIn(".claude/skills/vivary/SKILL.md", payload["creates"])
            for projection in payload["optional_projections"]:
                self.assertLessEqual(projection["bytes"], 1200)
                self.assertRegex(projection["source_hash"], r"^sha256:[0-9a-f]{64}$")
                self.assertRegex(projection["content_hash"], r"^sha256:[0-9a-f]{64}$")
        finally:
            shutil.rmtree(target)

    def test_nested_gitignore_negation_is_a_read_only_privacy_conflict(self):
        target = temp_dir()
        try:
            write(target / ".gitignore", "node_modules/\n")
            write(
                target / ".vivary" / ".gitignore",
                "!private/\n!private/secret.md\n",
            )
            before = snapshot(target)

            rc, out = run_cli(
                ["adopt", str(target), "--preset", "coding", "--json"]
            )

            self.assertEqual(rc, 1)
            self.assertEqual(snapshot(target), before)
            payload = json.loads(out)
            self.assertEqual(payload["privacy"]["status"], "conflict")
            self.assertIn(
                ".vivary/.gitignore",
                [conflict["path"] for conflict in payload["conflicts"]],
            )
            self.assertTrue(
                any(
                    "private/runtime" in conflict["reason"]
                    for conflict in payload["conflicts"]
                )
            )
        finally:
            shutil.rmtree(target)

    def test_plan_hash_is_bound_to_the_exact_workspace_root(self):
        parent_a = temp_dir()
        parent_b = temp_dir()
        target_a = parent_a / "project"
        target_b = parent_b / "project"
        try:
            for target in (target_a, target_b):
                target.mkdir()
                write(target / "AGENTS.md", "# Existing agent rules\n")
                write(target / ".gitignore", "node_modules/\n")
                write(target / "STATE.md", "# Existing state\n")

            plan_a = create_vivary.plan_adopt(target_a, preset="coding")
            plan_b = create_vivary.plan_adopt(target_b, preset="coding")

            self.assertNotEqual(plan_a["plan_hash"], plan_b["plan_hash"])
        finally:
            shutil.rmtree(parent_a)
            shutil.rmtree(parent_b)


class PatternReconfigurationTests(unittest.TestCase):
    def test_bom_legacy_roles_migrate_by_review_without_losing_original_bytes(self):
        target = temp_dir()
        choice = {"id": "capture", "name": "Capture", "path": "inbox/README.md"}
        try:
            create_vivary.scaffold_thin_workspace(target, repo_root=ROOT)
            config = target / ".vivary/workspace.toml"
            text = config.read_text(encoding="utf-8")
            begin = text.index("[workspace.vivary]")
            end = text.index("[base]", begin)
            legacy = ('patterns = ["thin-context"]\n'
                      '[workspace.roles]\nmemory = ["notes/log.md"]\n\n')
            config.write_bytes(bytes((239, 187, 191)) +
                               (text[:begin] + legacy + text[end:]).encode("utf-8"))
            original = snapshot(target)
            self.assertEqual(create_vivary.workspace_pattern_state(target)["choices"], [])
            review = create_vivary.plan_workspace_change(
                target, pattern_choices=(choice,), repo_root=ROOT)
            self.assertEqual(review["conflicts"], [])
            self.assertEqual(review["validation_findings"], [])
            self.assertEqual(snapshot(target), original)
            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target, intent="reconfigure", pattern_choices=(choice,), yes=True,
                    plan_hash=review["plan_hash"], repo_root=ROOT, _crash_after=1)
            recovery = create_vivary.adopt_workspace(
                target, recover_hash=review["plan_hash"], repo_root=ROOT)
            result = create_vivary.adopt_workspace(
                target, recover_hash=review["plan_hash"],
                plan_hash=recovery["recovery_plan_hash"], yes=True, repo_root=ROOT)
            self.assertTrue(result["recovered"])
            self.assertEqual(snapshot(target), original)
            fresh = create_vivary.plan_workspace_change(
                target, pattern_choices=(choice,), repo_root=ROOT)
            applied = create_vivary.apply_workspace_change(
                target, pattern_choices=(choice,), yes=True,
                plan_hash=fresh["plan_hash"], repo_root=ROOT)
            self.assertTrue(applied["applied"])
            data = config.read_bytes()
            self.assertTrue(data.startswith(bytes((239, 187, 191))))
            self.assertIn(legacy.encode("utf-8"), data)
            self.assertEqual(create_vivary.workspace_pattern_state(target)["choices"], [choice])
            doctor = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(doctor["ok"], doctor["errors"])
            self.assertEqual(doctor["workspace_roles"]["roles"]["memory"], ["notes/log.md"])
        finally:
            shutil.rmtree(target)

    def test_legacy_empty_pattern_roles_keep_their_meaning(self):
        target = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(target, repo_root=ROOT)
            config = target / ".vivary/workspace.toml"
            text = config.read_text(encoding="utf-8")
            begin = text.index("[workspace.vivary]")
            end = text.index("[base]", begin)
            legacy = ('patterns = []\n'
                      '[workspace.roles]\nlaw = ["handbook.md"]\n\n')
            config.write_text(text[:begin] + legacy + text[end:], encoding="utf-8")
            self.assertEqual(create_vivary.workspace_pattern_state(target)["choices"], [])
            choice = {"id": "capture", "name": "Capture", "path": "inbox/README.md"}
            review = create_vivary.plan_workspace_change(
                target, pattern_choices=(choice,), repo_root=ROOT)
            self.assertFalse(review["conflicts"], review["conflicts"])
            applied = create_vivary.apply_workspace_change(
                target, pattern_choices=(choice,), yes=True,
                plan_hash=review["plan_hash"], repo_root=ROOT)
            self.assertTrue(applied["applied"])
            doctor = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertTrue(doctor["ok"], doctor["errors"])
            self.assertEqual(doctor["workspace_roles"]["roles"]["law"], ["handbook.md"])
            self.assertIn(legacy, config.read_text(encoding="utf-8"))
        finally:
            shutil.rmtree(target)

    def test_frozen_v1_default_output_hashes(self):
        expected = {
            ("capture", "Capture", "inbox/README.md"):
                "sha256:510838fa9d17932e6eea8c7f5e1fecb07c16c87f51d9309106a4319635b18c4f",
            ("source-reference", "Sources", "sources/index.md"):
                "sha256:b574a2d940ec385c46d2b7bdf43a819521d3f89f122417591daf7f67655837f7",
            ("navigation", "Navigation", "START-HERE.md"):
                "sha256:6c3dd7fbbd8c2bef5d43fdb71af8e819e21c96edbbe758948fa07673c0499a9f",
            ("project-brief", "Project brief", "brief.md"):
                "sha256:60eb1dd8321a0e4b96a16e93e269f5de00727f9f484c746e0d0f0fea1b4a2783",
        }
        for (identifier, name, path), digest in expected.items():
            choice = {"id": identifier, "name": name, "path": path}
            self.assertEqual(create_vivary._sha256_prefixed(
                create_vivary._pattern_file(choice, "v1").encode("utf-8")), digest)

    def test_retained_v1_choice_keeps_hash_when_new_choice_uses_v2(self):
        import tomllib
        target = temp_dir()
        capture = {"id": "capture", "name": "Capture", "path": "inbox/README.md"}
        source = {"id": "source-reference", "name": "Sources", "path": "sources/index.md"}
        navigation = {"id": "navigation", "name": "Navigation", "path": "START-HERE.md"}
        try:
            create_vivary.scaffold_thin_workspace(
                target, pattern_choices=(capture, source), repo_root=ROOT)
            original = (target / capture["path"]).read_bytes()
            old_hash = create_vivary._sha256_prefixed(original)
            self.assertNotIn("body", create_vivary.BUILTIN_PATTERNS["capture"])
            self.assertEqual(
                create_vivary._pattern_file(capture, "v1").encode("utf-8"),
                original)
            upgraded = dict(create_vivary.PATTERN_RENDERERS["v1"])
            upgraded["navigation"] += "\nNew renderer instruction.\n"
            upgraded["capture"] += "\nNew capture instruction.\n"
            with mock.patch.dict(create_vivary.PATTERN_RENDERERS, {"v2": upgraded}), \
                 mock.patch.object(create_vivary, "CURRENT_PATTERN_RENDERER", "v2"):
                review = create_vivary.plan_workspace_change(
                    target, pattern_choices=(capture, navigation), repo_root=ROOT)
                self.assertFalse(review["conflicts"], review["conflicts"])
                result = create_vivary.apply_workspace_change(
                    target, pattern_choices=(capture, navigation), yes=True,
                    plan_hash=review["plan_hash"], repo_root=ROOT)
                self.assertTrue(result["applied"])
                config = tomllib.loads((target / ".vivary/workspace.toml").read_text())
                hashes = {row["id"]: row["generated_hash"]
                          for row in config["workspace"]["vivary"]["pattern_outputs"]}
                self.assertEqual(hashes["capture"], old_hash)
                self.assertEqual(
                    hashes["navigation"],
                    create_vivary._sha256_prefixed(
                        create_vivary._pattern_file(navigation).encode("utf-8")))
                self.assertEqual((target / capture["path"]).read_bytes(), original)
                repeat = create_vivary.plan_workspace_change(
                    target, pattern_choices=(capture, navigation), repo_root=ROOT)
                self.assertFalse(repeat["conflicts"], repeat["conflicts"])
        finally:
            shutil.rmtree(target)

    def test_v1_interrupted_journal_recovers_after_renderer_upgrade(self):
        target = temp_dir()
        capture = {"id": "capture", "name": "Capture", "path": "inbox/README.md"}
        navigation = {"id": "navigation", "name": "Navigation", "path": "START-HERE.md"}
        try:
            create_vivary.scaffold_thin_workspace(
                target, pattern_choices=(capture,), repo_root=ROOT)
            original = snapshot(target)
            review = create_vivary.plan_workspace_change(
                target, pattern_choices=(capture, navigation), repo_root=ROOT)
            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target, pattern_choices=(capture, navigation), intent="reconfigure",
                    yes=True, plan_hash=review["plan_hash"], repo_root=ROOT,
                    _crash_after=1)
            upgraded = dict(create_vivary.PATTERN_RENDERERS["v1"])
            upgraded["navigation"] += "\nNew renderer instruction.\n"
            with mock.patch.dict(create_vivary.PATTERN_RENDERERS, {"v2": upgraded}), \
                 mock.patch.object(create_vivary, "CURRENT_PATTERN_RENDERER", "v2"):
                recovery = create_vivary.adopt_workspace(
                    target, recover_hash=review["plan_hash"], repo_root=ROOT)
                done = create_vivary.adopt_workspace(
                    target, recover_hash=review["plan_hash"],
                    plan_hash=recovery["recovery_plan_hash"], yes=True, repo_root=ROOT)
                self.assertTrue(done["recovered"])
            self.assertEqual(snapshot(target), original)
        finally:
            shutil.rmtree(target)

    def test_retire_edited_capture_and_add_navigation_without_touching_state(self):
        target = temp_dir()
        first = (
            {"id": "capture", "name": "Capture", "path": "inbox/README.md"},
            {"id": "source-reference", "name": "Sources", "path": "sources/index.md"},
        )
        changed = (
            first[1],
            {"id": "navigation", "name": "Navigation", "path": "START-HERE.md"},
        )
        try:
            create_vivary.scaffold_thin_workspace(
                target, preset="second-brain", pattern_choices=first, repo_root=ROOT)
            write(target / "inbox/README.md", "# My edited capture\n")
            write(target / "STATE.md", "# My authored state\n")
            config = target / ".vivary/workspace.toml"
            config.write_text(config.read_text(encoding="utf-8").replace(
                '[workspace.vivary]\n', '[workspace.vivary]\nunknown_owner_key = "keep"\n'),
                encoding="utf-8")
            context = target / ".vivary/context.md"
            context.write_text(context.read_text(encoding="utf-8").replace("# ", "# Owner preface\n\n# ", 1),
                               encoding="utf-8")
            before = snapshot(target)
            review = create_vivary.plan_workspace_change(
                target, pattern_choices=changed, repo_root=ROOT)
            self.assertEqual(snapshot(target), before)
            self.assertFalse(review["conflicts"], review["conflicts"])
            self.assertIn("inbox/README.md", review["retired_kept"])
            self.assertTrue(any(row["path"] == "START-HERE.md"
                                for row in review["content_plan"]["files"]))
            self.assertTrue(any(row["path"] == ".vivary/workspace.toml"
                                for row in review["content_plan"]["files"]))
            self.assertTrue(any(row["path"] == ".vivary/context.md"
                                for row in review["content_plan"]["files"]))
            result = create_vivary.apply_workspace_change(
                target, pattern_choices=changed, yes=True,
                plan_hash=review["plan_hash"], repo_root=ROOT)
            self.assertTrue(result["applied"])
            self.assertEqual((target / "inbox/README.md").read_text(), "# My edited capture\n")
            self.assertEqual((target / "STATE.md").read_text(), "# My authored state\n")
            self.assertIn('unknown_owner_key = "keep"', config.read_text())
            self.assertIn("# Owner preface\n\n# ", context.read_text())
            self.assertIn("START-HERE.md", context.read_text())
            self.assertNotIn("inbox/README.md", context.read_text())
        finally:
            shutil.rmtree(target)


    def test_pack_name_cannot_escape_the_project_or_installed_catalog(self):
        target = temp_dir()
        outside = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            private_pack = outside / "private.toml"
            write(private_pack, '[base]\nallow_untyped = false\n')
            config = target / ".vivary/workspace.toml"
            pack_name = os.path.relpath(private_pack, target / ".tropo/packs").removesuffix(".toml")
            config.write_text(f"packs = [{json.dumps(pack_name)}]\n" + config.read_text(),
                              encoding="utf-8")
            before = snapshot(target)
            plan = create_vivary.plan_workspace_change(
                target, pattern_choices=(), repo_root=ROOT)
            self.assertTrue(plan["conflicts"])
            self.assertTrue(any(row["code"] == "CONFIG" for row in plan["validation_findings"]))
            self.assertIn("single installed filename", str(plan["validation_findings"]))
            self.assertNotIn(str(private_pack), str(plan))
            self.assertEqual(snapshot(target), before)
            self.assertEqual(private_pack.read_text(), '[base]\nallow_untyped = false\n')
        finally:
            shutil.rmtree(target)
            shutil.rmtree(outside)

    def test_validation_refuses_links_swapped_after_secure_reads_or_discovery(self):
        for stage in ("config", "overlay", "markdown"):
            with self.subTest(stage=stage):
                target = temp_dir()
                outside = temp_dir()
                swap_path = None
                backup = None
                try:
                    create_vivary.scaffold_thin_workspace(
                        target, preset="coding", repo_root=ROOT)
                    if stage == "config":
                        swap_path = target / ".vivary/workspace.toml"
                    elif stage == "overlay":
                        swap_path = target / "inbox/tropo.toml"
                        write(swap_path, '[types.capture]\nfolder = "inbox"\n')
                    else:
                        swap_path = target / "ordinary.md"
                        write(swap_path, "# Ordinary note\n")
                    secret = outside / "private.txt"
                    write(secret, 'outside_secret = "never include this"\n')
                    backup = swap_path.with_name(swap_path.name + ".original")
                    def swap():
                        swap_path.rename(backup)
                        try:
                            swap_path.symlink_to(secret)
                        except OSError:
                            backup.rename(swap_path)
                            self.skipTest("file symlinks are unavailable")
                    tropo = create_vivary._load_tropo(ROOT)
                    if stage == "config":
                        original = create_vivary._read_adopt_regular_bytes
                        swapped = False
                        def after_first_read(root, path):
                            nonlocal swapped
                            data = original(root, path)
                            if path == swap_path and not swapped:
                                swapped = True
                                swap()
                            return data
                        patch = mock.patch.object(create_vivary, "_read_adopt_regular_bytes",
                                                  side_effect=after_first_read)
                    elif stage == "overlay":
                        original = tropo._overlay_paths
                        swapped = False
                        def after_overlay_discovery(directory, root):
                            nonlocal swapped
                            paths = original(directory, root)
                            if str(swap_path) in paths and not swapped:
                                swapped = True
                                swap()
                            return paths
                        patch = mock.patch.object(tropo, "_overlay_paths",
                                                  side_effect=after_overlay_discovery)
                    else:
                        original = tropo.iter_markdown
                        swapped = False
                        def after_document_discovery(*args):
                            nonlocal swapped
                            for full, rel in original(*args):
                                if Path(full) == swap_path and not swapped:
                                    swapped = True
                                    swap()
                                yield full, rel
                        patch = mock.patch.object(tropo, "iter_markdown",
                                                  side_effect=after_document_discovery)
                    with patch, mock.patch.object(create_vivary, "_load_tropo",
                                                  return_value=tropo):
                        plan = create_vivary.plan_workspace_change(
                            target, pattern_choices=({"id": "capture", "name": "Capture",
                                                      "path": "inbox/README.md"},),
                            repo_root=ROOT)
                    self.assertTrue(plan["conflicts"], plan["validation_findings"])
                    self.assertNotIn("never include this", str(plan))
                    self.assertEqual(secret.read_text(), 'outside_secret = "never include this"\n')
                finally:
                    if swap_path is not None and swap_path.is_symlink():
                        swap_path.unlink()
                    if backup is not None and backup.exists():
                        backup.rename(swap_path)
                    shutil.rmtree(target)
                    shutil.rmtree(outside)

    def test_pattern_reads_refuse_a_link_swapped_after_preflight(self):
        for read_state in (False, True):
            with self.subTest(read_state=read_state):
                target = temp_dir()
                outside = temp_dir()
                try:
                    create_vivary.scaffold_thin_workspace(
                        target, preset="coding", repo_root=ROOT)
                    secret = outside / "private.toml"
                    write(secret, 'secret = "outside project"\n')
                    config = target / ".vivary/workspace.toml"
                    original = config.with_suffix(".original")
                    ensure = create_vivary._ensure_safe_destinations
                    swapped = False
                    def swap_after_check(root, paths, force):
                        nonlocal swapped
                        result = ensure(root, paths, force)
                        if not swapped and config in paths:
                            config.rename(original)
                            try:
                                config.symlink_to(secret)
                            except OSError:
                                original.rename(config)
                                self.skipTest("file symlinks are unavailable")
                            swapped = True
                        return result
                    with mock.patch.object(create_vivary, "_ensure_safe_destinations",
                                           side_effect=swap_after_check):
                        with self.assertRaises(create_vivary.ScaffoldError) as refusal:
                            if read_state:
                                create_vivary.workspace_pattern_state(target)
                            else:
                                create_vivary.plan_workspace_change(
                                    target, pattern_choices=(), repo_root=ROOT)
                    self.assertNotIn("outside project", str(refusal.exception))
                    self.assertEqual(secret.read_text(), 'secret = "outside project"\n')
                finally:
                    config = target / ".vivary/workspace.toml"
                    original = config.with_suffix(".original")
                    if config.is_symlink():
                        config.unlink()
                    if original.exists():
                        original.rename(config)
                    shutil.rmtree(target)
                    shutil.rmtree(outside)

    def test_reconfiguration_rejects_ignored_options_and_file_ancestor(self):
        target = temp_dir()
        choices = ({"id": "capture", "name": "Capture", "path": "inbox/README.md"},)
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            write(target / "inbox", "An owner file, not a folder.\n")
            before = snapshot(target)
            review = create_vivary.plan_workspace_change(
                target, pattern_choices=choices, repo_root=ROOT)
            self.assertTrue(any(row["path"] == target / "inbox/README.md"
                                and "unsafe parent" in row["reason"]
                                for row in review["conflicts"]), review["conflicts"])
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "preset and adapters"):
                create_vivary.adopt_workspace(
                    target, intent="reconfigure", pattern_choices=choices,
                    preset="writing", repo_root=ROOT)
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "original pattern choices"):
                create_vivary.adopt_workspace(
                    target, recover_hash=review["plan_hash"], pattern_choices=choices,
                    repo_root=ROOT)
            with mock.patch("sys.stdin", io.StringIO(json.dumps(choices))):
                code, output = run_cli(["adopt", str(target), "--json",
                                        "--recover", review["plan_hash"],
                                        "--pattern-choices", "-"])
            self.assertNotEqual(code, 0)
            self.assertIn("omit --pattern-choices", output)
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_cli_pattern_state_preview_and_exact_apply(self):
        target = temp_dir()
        choices = [{"id": "capture", "name": "My intake", "path": "inbox/README.md"}]
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            state = create_vivary.workspace_pattern_state(target)
            self.assertEqual(state["choices"], [])
            self.assertEqual(len(state["catalog"]), 4)
            with mock.patch("sys.stdin", io.StringIO(json.dumps(choices))):
                code, output = run_cli(["adopt", str(target), "--json",
                                        "--pattern-choices", "-"])
            self.assertEqual(code, 0, output)
            preview = json.loads(output)
            self.assertEqual(preview["pattern_choices"], choices)
            self.assertEqual(preview["mode"], "dry-run")
            self.assertEqual(preview["content_plan"]["files"][0]["operation"], "create")
            with mock.patch("sys.stdin", io.StringIO(json.dumps(choices))):
                code, output = run_cli(["adopt", str(target), "--json",
                                        "--pattern-choices", "-", "--yes",
                                        "--plan", preview["plan_hash"],
                                        "--request-id", "pattern-cli"])
            self.assertEqual(code, 0, output)
            self.assertEqual(json.loads(output)["mode"], "applied")
            self.assertEqual(create_vivary.workspace_pattern_state(target)["choices"], choices)
        finally:
            shutil.rmtree(target)

    def test_crlf_managed_regions_keep_surrounding_authored_bytes(self):
        target = temp_dir()
        first = ({"id": "capture", "name": "Capture", "path": "inbox/README.md"},)
        changed = ({"id": "navigation", "name": "Navigation", "path": "START-HERE.md"},)
        try:
            create_vivary.scaffold_thin_workspace(
                target, preset="coding", pattern_choices=first, repo_root=ROOT)
            config = target / ".vivary/workspace.toml"
            context = target / ".vivary/context.md"
            config_bytes = config.read_bytes().replace(b"\n", b"\r\n")
            config_bytes = config_bytes.replace(
                b"[workspace.vivary]\r\n",
                b"[workspace.vivary]\r\nowner_note = \"Keep this text\"\r\n", 1)
            config.write_bytes(config_bytes)
            context_bytes = context.read_bytes().replace(b"\n", b"\r\n")
            context_bytes = context_bytes.replace(
                b"---\r\n# ", b"---\r\nOwner preface.\r\n\r\n# ", 1)
            context.write_bytes(context_bytes)
            before = snapshot(target)
            unchanged = create_vivary.plan_workspace_change(
                target, pattern_choices=first, repo_root=ROOT)
            self.assertFalse(unchanged["conflicts"], unchanged["conflicts"])
            self.assertEqual(unchanged["writes"], [])
            self.assertEqual(unchanged["adapter_replacements"], [])
            self.assertEqual(snapshot(target), before)
            review = create_vivary.plan_workspace_change(
                target, pattern_choices=changed, repo_root=ROOT)
            self.assertFalse(review["conflicts"], review["conflicts"])
            result = create_vivary.apply_workspace_change(
                target, pattern_choices=changed, yes=True,
                plan_hash=review["plan_hash"], repo_root=ROOT)
            self.assertTrue(result["applied"])
            for path in (config, context):
                data = path.read_bytes()
                self.assertNotIn(b"\n", data.replace(b"\r\n", b""))
            self.assertIn(b'owner_note = "Keep this text"\r\n', config.read_bytes())
            self.assertIn(b"Owner preface.\r\n\r\n# ", context.read_bytes())
            self.assertTrue((target / "inbox/README.md").is_file())
            self.assertTrue((target / "START-HERE.md").is_file())
        finally:
            shutil.rmtree(target)

    def test_unchanged_edited_choice_is_kept_without_conflict(self):
        target = temp_dir()
        choices = ({"id": "capture", "name": "Capture", "path": "inbox/README.md"},)
        try:
            create_vivary.scaffold_thin_workspace(
                target, preset="coding", pattern_choices=choices, repo_root=ROOT)
            write(target / "inbox/README.md", "# Authored capture\n")
            before = snapshot(target)
            plan = create_vivary.plan_workspace_change(
                target, pattern_choices=choices, repo_root=ROOT)
            self.assertEqual(plan["conflicts"], [])
            self.assertEqual(plan["writes"], [])
            self.assertEqual(plan["adapter_replacements"], [])
            self.assertIn(target / "inbox/README.md", plan["kept"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_invalid_typed_destination_is_reported_before_apply(self):
        target = temp_dir()
        choices = ({"id": "capture", "name": "Capture", "path": "inbox/README.md"},)
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            write(target / "tropo.toml",
                  '[types.capture]\nfolder = "inbox"\nrequired = { status = "string" }\n')
            before = snapshot(target)
            plan = create_vivary.plan_workspace_change(
                target, pattern_choices=choices, repo_root=ROOT)
            self.assertTrue(any(row["path"] == "inbox/README.md" and row["code"] == "E101"
                                for row in plan["validation_findings"]), plan["validation_findings"])
            self.assertTrue(plan["conflicts"])
            self.assertEqual(snapshot(target), before)
            with self.assertRaises(create_vivary.ScaffoldError):
                create_vivary.apply_workspace_change(
                    target, pattern_choices=choices, yes=True,
                    plan_hash=plan["plan_hash"], repo_root=ROOT)
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_reserved_and_case_colliding_pattern_paths_are_rejected(self):
        target = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            for path in ("AGENTS.md", "agents.md", ".vivary/context.md", ".git/config.md",
                         "STATE.md", "bad?.md", "bad<name>.md", "bad\x00.md", "InBox/README.md"):
                if path == "InBox/README.md":
                    write(target / "inbox/README.md", "# Occupied\n")
                choices = ({"id": "capture", "name": "Capture", "path": path},)
                if path == "InBox/README.md":
                    review = create_vivary.plan_workspace_change(
                        target, pattern_choices=choices, repo_root=ROOT)
                    self.assertTrue(review["conflicts"])
                else:
                    with self.assertRaises(create_vivary.ScaffoldError):
                        create_vivary.plan_workspace_change(
                            target, pattern_choices=choices, repo_root=ROOT)
            for bad in ({"id": [], "name": "Capture", "path": "inbox/README.md"},
                        {"id": "capture", "name": "Bad\rName", "path": "inbox/README.md"}):
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary.plan_workspace_change(
                        target, pattern_choices=(bad,), repo_root=ROOT)
        finally:
            shutil.rmtree(target)

    def test_pattern_request_replays_only_exact_approved_choice(self):
        target = temp_dir()
        choices = ({"id": "capture", "name": "Capture", "path": "inbox/README.md"},)
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            plan = create_vivary.plan_workspace_change(
                target, pattern_choices=choices, repo_root=ROOT)
            first = create_vivary.apply_workspace_change(
                target, pattern_choices=choices, yes=True,
                plan_hash=plan["plan_hash"], request_id="pattern-one", repo_root=ROOT)
            self.assertTrue(first["applied"])
            after = snapshot(target)
            replay = create_vivary.apply_workspace_change(
                target, pattern_choices=choices, yes=True,
                plan_hash=plan["plan_hash"], request_id="pattern-one", repo_root=ROOT)
            self.assertTrue(replay["replayed"])
            self.assertEqual(snapshot(target), after)
            with self.assertRaises(create_vivary.ScaffoldError):
                create_vivary.apply_workspace_change(
                    target, pattern_choices=({"id": "capture", "name": "Other",
                                             "path": "inbox/README.md"},), yes=True,
                    plan_hash=plan["plan_hash"], request_id="pattern-one", repo_root=ROOT)
            self.assertEqual(snapshot(target), after)
        finally:
            shutil.rmtree(target)

    def test_request_aware_pattern_crash_recovers_and_forged_path_refuses(self):
        target = temp_dir()
        choices = ({"id": "capture", "name": "Capture", "path": "inbox/README.md"},)
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            original = snapshot(target)
            plan = create_vivary.plan_workspace_change(
                target, pattern_choices=choices, repo_root=ROOT)
            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target, pattern_choices=choices, intent="reconfigure", yes=True,
                    plan_hash=plan["plan_hash"], request_id="pattern-crash",
                    repo_root=ROOT, _crash_after=1)
            journal_path = target / ".vivary/runtime/adopt-journal.json"
            saved = journal_path.read_bytes()
            forged = json.loads(saved)
            create = forged["approval"]["creates"][0]
            old_path = create["path"]
            create["path"] = "unreviewed.md"
            for action in forged["actions"]:
                if action["path"] == old_path:
                    action["path"] = "unreviewed.md"
            forged_hash = create_vivary._thin_approval_hash(forged["approval"])
            forged["plan_hash"] = forged_hash
            journal_path.write_text(json.dumps(forged), encoding="utf-8")
            with self.assertRaises(create_vivary.ScaffoldError):
                create_vivary.adopt_workspace(
                    target, recover_hash=forged_hash, repo_root=ROOT)
            journal_path.write_bytes(saved)
            recovery = create_vivary.adopt_workspace(
                target, recover_hash=plan["plan_hash"],
                request_id="pattern-crash", repo_root=ROOT)
            result = create_vivary.adopt_workspace(
                target, recover_hash=plan["plan_hash"],
                plan_hash=recovery["recovery_plan_hash"], request_id="pattern-crash",
                yes=True, repo_root=ROOT)
            self.assertTrue(result["recovered"])
            self.assertEqual({path: digest for path, digest in snapshot(target).items()
                              if not path.startswith(".vivary/runtime/")}, original)
        finally:
            shutil.rmtree(target)

    def test_interrupted_pattern_change_recovers_original_bytes(self):
        target = temp_dir()
        choices = ({"id": "capture", "name": "Capture", "path": "inbox/README.md"},)
        changed = ({"id": "navigation", "name": "Navigation", "path": "START-HERE.md"},)
        try:
            create_vivary.scaffold_thin_workspace(
                target, preset="coding", pattern_choices=choices, repo_root=ROOT)
            original = snapshot(target)
            review = create_vivary.plan_workspace_change(
                target, pattern_choices=changed, repo_root=ROOT)
            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target, pattern_choices=changed, intent="reconfigure", yes=True,
                    plan_hash=review["plan_hash"], repo_root=ROOT, _crash_after=1)
            recovery = create_vivary.adopt_workspace(
                target, recover_hash=review["plan_hash"], repo_root=ROOT)
            result = create_vivary.adopt_workspace(
                target, recover_hash=review["plan_hash"], yes=True,
                plan_hash=recovery["recovery_plan_hash"], repo_root=ROOT)
            self.assertTrue(result["recovered"])
            self.assertEqual(snapshot(target), original)
        finally:
            shutil.rmtree(target)


class ThinAdoptApplyTests(unittest.TestCase):
    def test_apply_requires_the_exact_approved_plan_hash_before_any_write(self):
        target = temp_dir()
        try:
            write(target / "README.md", "# Existing project\n")
            before = snapshot(target)

            rc, out = run_cli(
                ["adopt", str(target), "--preset", "coding", "--yes", "--json"]
            )

            self.assertEqual(rc, 1)
            self.assertEqual(snapshot(target), before)
            payload = json.loads(out)
            self.assertIn("--plan", payload["error"])
        finally:
            shutil.rmtree(target)

    def test_preview_counts_visible_preserved_files_not_only_preset_votes(self):
        target = temp_dir()
        try:
            write(target / "STATE.md", "# Existing state\n")
            write(target / "projects" / "ordinary.md", "---\ntype: project\n---\n# Ordinary\n")
            write(target / "decisions" / "valid.md",
                  "---\nstatus: accepted\ndate: 2026-09-23\n---\n# Valid\n")
            write(target / "decisions" / "invalid.md",
                  "---\nstatus: proposed\n---\n# Invalid\n")
            write(target / "tropo.toml",
                  'version = 1\n[base]\nallow_untyped = true\n'
                  '[types.decision]\nfolder = "decisions"\n'
                  'required = {status = "string", date = "date"}\n')
            (target / "source.pdf").write_bytes(b"%PDF-1.4\nfixture\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertEqual(plan["content_inventory"],
                             {"existing_markdown": 4, "existing_non_markdown": 2})
            self.assertEqual(plan["inventory"].markdown_count, 1)
            self.assertEqual(plan["inventory"].other_count, 1)
            self.assertTrue(any(row["path"] == "decisions/invalid.md" and row["code"] == "E101"
                                for row in plan["validation_findings"]))
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_preview_counts_only_markdown_extensions_tropo_indexes(self):
        target = temp_dir()
        try:
            write(target / "notes" / "lower.md", "# Indexed\n")
            write(target / "notes" / "UPPER.MD", "# Retained\n")
            write(target / "notes" / "Mixed.Markdown", "# Retained\n")
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertEqual(plan["content_inventory"],
                             {"existing_markdown": 1, "existing_non_markdown": 2})
            self.assertFalse(plan["conflicts"], plan["conflicts"])
            create_vivary.adopt_workspace(
                target, preset="second-brain", yes=True, plan_hash=plan["plan_hash"])
            resolver = tropo.ConfigResolver(str(target), str(TROPO))
            indexed = {doc.rel.replace("\\", "/") for doc in tropo.analyze(str(target), [], resolver)}
            self.assertIn("notes/lower.md", indexed)
            self.assertNotIn("notes/UPPER.MD", indexed)
            self.assertNotIn("notes/Mixed.Markdown", indexed)
        finally:
            shutil.rmtree(target)

    def test_malformed_nested_config_reports_its_actual_path(self):
        target = temp_dir()
        try:
            write(target / "notes" / "tropo.toml", "[types.note\n")
            write(target / "notes" / "ordinary.md", "# Ordinary\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertTrue(any(row["path"] == "notes/tropo.toml" and row["code"] == "CONFIG"
                                for row in plan["validation_findings"]), plan["validation_findings"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_preview_resolves_existing_refs_to_proposed_context(self):
        target = temp_dir()
        try:
            write(target / "tropo.toml",
                  '[types.note]\nfolder = "notes"\nrequired = {link = "ref"}\n')
            write(target / "notes" / "linked.md", "---\nlink: context\n---\n# Linked\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertFalse(any(row["path"] == "notes/linked.md" and row["code"] == "W220"
                                 for row in plan["validation_findings"]), plan["validation_findings"])
            self.assertEqual(snapshot(target), before)
            self.assertFalse(plan["conflicts"], plan["conflicts"])
            create_vivary.adopt_workspace(
                target, preset="second-brain", yes=True, plan_hash=plan["plan_hash"])
            resolver = tropo.ConfigResolver(str(target), str(TROPO))
            linked = next(doc for doc in tropo.analyze(str(target), [], resolver)
                          if doc.rel.replace("\\", "/") == "notes/linked.md")
            self.assertFalse(any(finding.code == "W220" for finding in linked.findings))
        finally:
            shutil.rmtree(target)

    def test_text_preview_shows_configured_validation_conflict(self):
        target = temp_dir()
        try:
            write(target / "tropo.toml",
                  '[types.memo]\nfolder = "decisions"\n'
                  'required = {status = "string", date = "date"}\n')
            write(target / "decisions" / "invalid.md", "---\nstatus: proposed\n---\n# Invalid\n")
            before = snapshot(target)
            status, output = run_cli(["adopt", str(target), "--preset", "second-brain"])
            self.assertEqual(status, 1)
            self.assertIn("decisions/invalid.md", output)
            self.assertIn("E101", output)
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_para_folder_names_remain_untyped_and_searchable_after_adoption(self):
        target = temp_dir()
        try:
            write(target / "projects" / "ordinary.md", "---\ntype: project\nowner: me\n---\n# Ordinary project\nNeedle notes.\n")
            write(target / "areas" / "journal.md", "# Journal\nNeedle notes.\n")
            pdf = target / "resources" / "source.pdf"
            pdf.parent.mkdir(parents=True)
            pdf.write_bytes(b"%PDF-1.4\nfixture\n")
            original = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertFalse(plan["conflicts"])
            self.assertEqual(snapshot(target), original)
            applied = create_vivary.adopt_workspace(
                target, preset="second-brain", yes=True, plan_hash=plan["plan_hash"])
            self.assertTrue(applied["doctor"]["ok"], applied["doctor"]["errors"])
            for relative, digest in original.items():
                self.assertEqual(snapshot(target)[relative], digest)
            resolver = tropo.ConfigResolver(str(target), str(TROPO))
            documents = tropo.analyze(str(target), [], resolver)
            ordinary = next(doc for doc in documents if doc.rel.replace("\\", "/") == "projects/ordinary.md")
            self.assertIsNone(ordinary.type)
            self.assertFalse(ordinary.findings)
            self.assertTrue(any(doc.rel.replace("\\", "/") == "areas/journal.md"
                                for doc in documents))
            self.assertFalse(any(doc.rel.endswith("source.pdf") for doc in documents))
            for folder, record_type in {
                "modules": "module", "changes": "change", "decisions": "decision",
                "verification": "verification", "gates": "gate",
            }.items():
                self.assertEqual(tropo.type_for(
                    str(target / ".vivary" / "records" / folder / "example.md"),
                    resolver.base), f"vivary_record_{record_type}")
                self.assertIsNone(tropo.type_for(
                    str(target / folder / "ordinary.md"), resolver.base))
        finally:
            shutil.rmtree(target)

    def test_declared_type_validation_is_visible_before_apply(self):
        target = temp_dir()
        try:
            write(target / "tropo.toml",
                  'version = 1\n[base]\nallow_untyped = true\n'
                  '[types.decision]\nfolder = "decisions"\n'
                  'required = {status = "string", date = "date"}\n')
            write(target / "decisions" / "valid.md",
                  "---\nstatus: accepted\ndate: 2026-09-23\n---\n# Valid\n")
            invalid = target / "decisions" / "invalid.md"
            write(invalid, "---\nstatus: proposed\n---\n# Missing date\n")
            original = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertTrue(any(row["path"] == "decisions/invalid.md" and row["code"] == "E101"
                                for row in plan["validation_findings"]))
            self.assertTrue(any(item["path"] == invalid for item in plan["conflicts"]))
            self.assertEqual(snapshot(target), original)
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "conflicts"):
                create_vivary.adopt_workspace(
                    target, preset="second-brain", yes=True, plan_hash=plan["plan_hash"])
            self.assertEqual(snapshot(target), original)
            write(invalid, "---\nstatus: proposed\ndate: 2026-09-23\n---\n# Valid now\n")
            fresh = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertFalse(fresh["conflicts"], fresh["conflicts"])
            self.assertFalse(any(row["level"] == "error" for row in fresh["validation_findings"]))
            write(target / "decisions" / "valid.md",
                  "---\nstatus: accepted\ndate: 2026-09-23\n---\n# Changed after preview\n")
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "plan hash mismatch"):
                create_vivary.adopt_workspace(
                    target, preset="second-brain", yes=True, plan_hash=fresh["plan_hash"])
            fresh = create_vivary.plan_adopt(target, preset="second-brain")
            before = snapshot(target)
            result = create_vivary.adopt_workspace(
                target, preset="second-brain", yes=True, plan_hash=fresh["plan_hash"])
            self.assertTrue(result["doctor"]["ok"], result["doctor"]["errors"])
            for relative, digest in before.items():
                self.assertEqual(snapshot(target)[relative], digest)
        finally:
            shutil.rmtree(target)

    def test_existing_root_schema_that_cannot_compose_is_a_preview_conflict(self):
        target = temp_dir()
        try:
            write(target / "tropo.toml",
                  'version = 1\n[base]\nstrict = false\nallow_untyped = true\n'
                  '[types.project]\nfolder = "projects"\n'
                  'required = {status = "string"}\n')
            write(target / "projects" / "valid.md", "---\nstatus: accepted\n---\n# Valid\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertTrue(any(row["code"] == "CONFIG" and row["path"] == "tropo.toml"
                                for row in plan["validation_findings"]))
            self.assertTrue(any(item["path"] == target / "tropo.toml"
                                for item in plan["conflicts"]))
            self.assertEqual(snapshot(target), before)
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "conflicts"):
                create_vivary.adopt_workspace(
                    target, preset="second-brain", yes=True, plan_hash=plan["plan_hash"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_legacy_approval_journal_recovers_original_generated_config(self):
        target = temp_dir()
        try:
            plan = create_vivary.plan_adopt(target, preset="coding")
            approval = json.loads(json.dumps(plan["approval_payload"]))
            approval.pop("validation_inputs_hash")
            original_config = create_vivary._thin_workspace_toml("coding").encode("utf-8")
            for row in approval["creates"]:
                if row["path"] == ".vivary/workspace.toml":
                    row["content_hash"] = create_vivary._sha256_prefixed(original_config)
            legacy_hash = create_vivary._thin_approval_hash(approval)
            actions = create_vivary._adopt_actions(plan)
            for action in actions:
                if action["path"] == target / ".vivary" / "workspace.toml":
                    action["after"] = original_config
                if action["path"] == target / ".gitignore":
                    action["transient_after"] = create_vivary._prejournal_privacy_bytes(
                        action, None, legacy_hash)
            backups = create_vivary._adopt_backups(target, actions)
            legacy_plan = {**plan, "approval_payload": approval, "plan_hash": legacy_hash}
            journal = create_vivary._adopt_journal_payload(
                legacy_plan, actions, backups, phase="planned", completed=0)
            journal_path = target / ".vivary" / "runtime" / "adopt-journal.json"
            journal_path.parent.mkdir(parents=True)
            journal_path.write_bytes(create_vivary._encode_adopt_journal(journal))
            checked, checked_backups = create_vivary._validated_journal_state(
                target, journal, legacy_hash)
            self.assertEqual([row["path"] for row in checked],
                             [row["path"] for row in actions])
            self.assertEqual(checked_backups, backups)
            recovery = create_vivary.adopt_workspace(target, recover_hash=legacy_hash)
            self.assertFalse(recovery["recovered"])
            restored = create_vivary.adopt_workspace(
                target, recover_hash=legacy_hash, yes=True,
                plan_hash=recovery["recovery_plan_hash"])
            self.assertTrue(restored["recovered"])
            self.assertFalse(journal_path.exists())
        finally:
            shutil.rmtree(target)

    def test_root_schema_packs_need_review_before_thin_creation(self):
        target = temp_dir()
        try:
            write(target / "tropo.toml", 'version = 1\npacks = ["dev-project"]\n')
            write(target / "decisions" / "valid.md",
                  "---\nstatus: accepted\ndate: 2026-09-23\n---\n# Valid\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertTrue(any(row["code"] == "CONFIG" and "packs" in row["message"]
                                for row in plan["validation_findings"]))
            self.assertEqual(snapshot(target), before)
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "conflicts"):
                create_vivary.adopt_workspace(
                    target, preset="second-brain", yes=True, plan_hash=plan["plan_hash"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_existing_thin_pack_change_invalidates_review_without_schema_errors(self):
        target = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            config.write_text(config.read_text(encoding="utf-8").replace(
                "version = 1\n", 'version = 1\npacks = ["owner-fields"]\n', 1),
                encoding="utf-8")
            pack = target / ".tropo" / "packs" / "owner-fields.toml"
            write(pack, '[base.optional]\nowner = "string"\n')
            plan = create_vivary.plan_adopt(target, preset="coding", repo_root=ROOT)
            self.assertFalse(plan["conflicts"], plan["conflicts"])
            self.assertFalse(any(row["level"] == "error" for row in plan["validation_findings"]))
            before = snapshot(target)
            write(pack, '[base.optional]\nowner = "date"\n')
            self.assertFalse(create_vivary.plan_adopt(target, preset="coding", repo_root=ROOT)["conflicts"])
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "plan hash mismatch"):
                create_vivary.adopt_workspace(
                    target, preset="coding", repo_root=ROOT, yes=True, plan_hash=plan["plan_hash"])
            self.assertEqual(
                {name: digest for name, digest in snapshot(target).items() if name != ".tropo/packs/owner-fields.toml"},
                {name: digest for name, digest in before.items() if name != ".tropo/packs/owner-fields.toml"})
        finally:
            shutil.rmtree(target)

    def test_custom_thin_schema_checks_proposed_context_before_writing(self):
        target = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            config.write_text(config.read_text(encoding="utf-8").replace(
                'required = { status = "enum:idea|active|paused|shipped|archived" }',
                'required = { status = "enum:idea|active|paused|shipped|archived", owner = "string" }'),
                encoding="utf-8")
            (target / ".vivary" / "context.md").unlink()
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="coding", repo_root=ROOT)
            self.assertTrue(any(row["path"] == ".vivary/context.md" and row["code"] == "E101"
                                for row in plan["validation_findings"]), plan["validation_findings"])
            self.assertTrue(any(item["path"] == target / ".vivary" / "context.md"
                                for item in plan["conflicts"]))
            self.assertEqual(snapshot(target), before)
            with self.assertRaisesRegex(create_vivary.ScaffoldError, "conflicts"):
                create_vivary.adopt_workspace(
                    target, preset="coding", repo_root=ROOT, yes=True, plan_hash=plan["plan_hash"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_custom_thin_policy_checks_proposed_state_before_writing(self):
        target = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(target, preset="coding", repo_root=ROOT)
            config = target / ".vivary" / "workspace.toml"
            config.write_text(config.read_text(encoding="utf-8").replace(
                "allow_untyped = true", "allow_untyped = false"), encoding="utf-8")
            (target / "STATE.md").unlink()
            plan = create_vivary.plan_adopt(target, preset="coding", repo_root=ROOT)
            self.assertTrue(any(row["path"] == "STATE.md" and row["code"] == "W201"
                                for row in plan["validation_findings"]), plan["validation_findings"])
            self.assertTrue(any(item["path"] == target / "STATE.md" for item in plan["conflicts"]))
        finally:
            shutil.rmtree(target)

    def test_nested_schema_collision_is_previewed_before_thin_creation(self):
        target = temp_dir()
        try:
            write(target / ".vivary" / "tropo.toml",
                  '[types.other]\nfolder = ".vivary"\nrequired = {owner = "string"}\n')
            write(target / "projects" / "ordinary.md", "# Ordinary\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertTrue(any(row["code"] == "CONFIG" and row["path"] == ".vivary/tropo.toml"
                                for row in plan["validation_findings"]), plan["validation_findings"])
            self.assertTrue(plan["conflicts"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_arbitrary_nested_schema_is_checked_without_root_config(self):
        target = temp_dir()
        try:
            write(target / "projects" / "tropo.toml",
                  "[base]\nallow_untyped = false\n")
            write(target / "projects" / "ordinary.md", "# Ordinary\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertTrue(any(row["path"] == "projects/ordinary.md" and row["code"] == "W201"
                                for row in plan["validation_findings"]), plan["validation_findings"])
            self.assertTrue(any(row["path"] == target / "projects" / "ordinary.md"
                                for row in plan["conflicts"]))
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_malformed_existing_markdown_is_visible_without_schema_files(self):
        target = temp_dir()
        try:
            write(target / "notes" / "broken.md", "---\nitems: first\nitems: second\n---\n# Broken\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="second-brain")
            self.assertTrue(any(row["path"] == "notes/broken.md" and row["code"] == "E001"
                                for row in plan["validation_findings"]), plan["validation_findings"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_apply_uses_the_approved_creates_and_bounded_host_patches(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "# Existing agent rules\n")
            write(target / ".gitignore", "node_modules/\n")
            write(target / "STATE.md", "# User state\n")
            original = {
                path: (target / path).read_bytes()
                for path in ("AGENTS.md", ".gitignore", "STATE.md")
            }
            dry_rc, dry_out = run_cli(
                ["adopt", str(target), "--preset", "coding", "--json"]
            )
            self.assertEqual(dry_rc, 0)
            dry = json.loads(dry_out)

            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--preset",
                    "coding",
                    "--yes",
                    "--plan",
                    dry["plan_hash"],
                    "--json",
                ]
            )

            self.assertEqual(rc, 0, out)
            payload = json.loads(out)
            self.assertTrue(payload["doctor"]["ok"], payload["doctor"]["errors"])
            self.assertEqual((target / "STATE.md").read_bytes(), original["STATE.md"])
            self.assertIn(
                ".vivary/context.md",
                (target / "AGENTS.md").read_text(encoding="utf-8"),
            )
            for patch in dry["patches"]:
                path = target / patch["path"]
                self.assertEqual(path.read_bytes(), original[patch["path"]] + patch["inserted_text"].encode())
            self.assertTrue((target / ".vivary" / "context.md").is_file())
            self.assertTrue((target / ".vivary" / "workspace.toml").is_file())
            self.assertFalse((target / ".vivary" / "runtime" / "adopt-journal.json").exists())
            self.assertFalse((target / "tropo.toml").exists())
            self.assertFalse((target / "templates").exists())
            self.assertFalse((target / "modules").exists())
            self.assertFalse((target / ".vivary" / "records").exists())

            applied_snapshot = snapshot(target)
            second_plan = create_vivary.plan_adopt(target, preset="coding")
            self.assertFalse(second_plan["creates"])
            self.assertFalse(second_plan["patches"])
            self.assertFalse(second_plan["conflicts"])
            second = create_vivary.adopt_workspace(
                target,
                preset="coding",
                yes=True,
                plan_hash=second_plan["plan_hash"],
            )
            self.assertTrue(second["doctor"]["ok"])
            self.assertEqual(snapshot(target), applied_snapshot)
        finally:
            shutil.rmtree(target)

    def test_plan_is_clean_for_generated_active_context_workspace(self):
        target = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(
                target,
                preset="coding",
                active_context="cocoindex-code",
                repo_root=ROOT,
            )
            before = snapshot(target)

            plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                repo_root=ROOT,
            )

            self.assertFalse(plan["creates"])
            self.assertFalse(plan["patches"])
            self.assertFalse(plan["conflicts"])
            self.assertIn(target / ".gitignore", plan["kept"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_apply_restores_active_context_privacy_for_missing_or_host_gitignore(self):
        for initial in (None, "node_modules/\n"):
            with self.subTest(initial=initial):
                target = temp_dir()
                try:
                    create_vivary.scaffold_thin_workspace(
                        target,
                        preset="coding",
                        active_context="cocoindex-code",
                        repo_root=ROOT,
                    )
                    gitignore = target / ".gitignore"
                    if initial is None:
                        gitignore.unlink()
                    else:
                        gitignore.write_text(initial, encoding="utf-8")

                    plan = create_vivary.plan_adopt(
                        target,
                        preset="coding",
                        repo_root=ROOT,
                    )

                    self.assertFalse(plan["conflicts"])
                    self.assertEqual(plan["capabilities"], ["cocoindex-code"])
                    self.assertIn(
                        ".cocoindex_code/",
                        plan["privacy"]["rules"],
                    )
                    applied = create_vivary.adopt_workspace(
                        target,
                        preset="coding",
                        repo_root=ROOT,
                        yes=True,
                        plan_hash=plan["plan_hash"],
                    )
                    self.assertTrue(
                        applied["doctor"]["ok"],
                        applied["doctor"]["errors"],
                    )
                    text = gitignore.read_text(encoding="utf-8")
                    if initial is not None:
                        self.assertTrue(text.startswith(initial))
                    self.assertIn(".cocoindex_code/", text)
                finally:
                    shutil.rmtree(target)

    def test_ordinary_failure_rolls_back_exact_bytes_and_created_files(self):
        probe = temp_dir()
        try:
            write(probe / "AGENTS.md", "# Existing agent rules\r\n")
            write(probe / ".gitignore", "node_modules/\r\n")
            write(probe / "STATE.md", "# Existing state\r\n")
            boundaries = len(
                create_vivary._adopt_actions(
                    create_vivary.plan_adopt(probe, preset="coding")
                )
            )
        finally:
            shutil.rmtree(probe)

        for boundary in range(1, boundaries + 1):
            with self.subTest(boundary=boundary):
                target = temp_dir()
                try:
                    write(target / "AGENTS.md", "# Existing agent rules\r\n")
                    write(target / ".gitignore", "node_modules/\r\n")
                    write(target / "STATE.md", "# Existing state\r\n")
                    before = snapshot(target)
                    plan = create_vivary.plan_adopt(target, preset="coding")

                    with self.assertRaisesRegex(
                        create_vivary.ScaffoldError, "injected failure"
                    ):
                        create_vivary.adopt_workspace(
                            target,
                            preset="coding",
                            yes=True,
                            plan_hash=plan["plan_hash"],
                            _fault_after=boundary,
                        )

                    self.assertEqual(snapshot(target), before)
                    self.assertFalse(
                        (target / ".vivary" / "runtime" / "adopt-journal.json").exists()
                    )
                finally:
                    shutil.rmtree(target)

    def test_process_crash_requires_explicit_plan_bound_recovery(self):
        probe = temp_dir()
        try:
            write(probe / "AGENTS.md", "# Existing agent rules\n")
            write(probe / ".gitignore", "node_modules/\n")
            write(probe / "STATE.md", "# Existing state\n")
            boundaries = len(
                create_vivary._adopt_actions(
                    create_vivary.plan_adopt(probe, preset="coding")
                )
            )
        finally:
            shutil.rmtree(probe)

        for boundary in range(1, boundaries + 1):
            with self.subTest(boundary=boundary):
                target = temp_dir()
                try:
                    write(target / "AGENTS.md", "# Existing agent rules\n")
                    write(target / ".gitignore", "node_modules/\n")
                    write(target / "STATE.md", "# Existing state\n")
                    before = snapshot(target)
                    plan = create_vivary.plan_adopt(target, preset="coding")

                    with self.assertRaises(KeyboardInterrupt):
                        create_vivary.adopt_workspace(
                            target,
                            preset="coding",
                            yes=True,
                            plan_hash=plan["plan_hash"],
                            _crash_after=boundary,
                        )

                    journal = target / ".vivary" / "runtime" / "adopt-journal.json"
                    self.assertTrue(journal.is_file())
                    interrupted_doctor = create_vivary.doctor_workspace(
                        target, repo_root=ROOT
                    )
                    self.assertFalse(interrupted_doctor["ok"])
                    self.assertTrue(
                        any(
                            "adoption journal" in error
                            for error in interrupted_doctor["errors"]
                        )
                    )
                    interrupted = snapshot(target)

                    rc, out = run_cli(
                        [
                            "adopt",
                            str(target),
                            "--recover",
                            plan["plan_hash"],
                            "--json",
                        ]
                    )

                    self.assertEqual(rc, 0, out)
                    payload = json.loads(out)
                    self.assertEqual(payload["mode"], "recovery-dry-run")
                    self.assertFalse(payload["recovered"])
                    self.assertRegex(
                        payload["recovery_plan_hash"],
                        r"^sha256:[0-9a-f]{64}$",
                    )
                    self.assertEqual(snapshot(target), interrupted)

                    apply_rc, apply_out = run_cli(
                        [
                            "adopt",
                            str(target),
                            "--recover",
                            plan["plan_hash"],
                            "--yes",
                            "--plan",
                            payload["recovery_plan_hash"],
                            "--json",
                        ]
                    )

                    self.assertEqual(apply_rc, 0, apply_out)
                    self.assertEqual(snapshot(target), before)
                    applied = json.loads(apply_out)
                    self.assertEqual(applied["mode"], "recovered")
                    self.assertTrue(applied["recovered"])
                finally:
                    shutil.rmtree(target)

    def test_crash_after_privacy_before_journal_has_exact_plan_bound_recovery(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "# Existing agent rules\r\n")
            write(target / ".gitignore", "node_modules/\r\n")
            write(target / "STATE.md", "# Existing state\r\n")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(target, preset="coding")

            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target,
                    preset="coding",
                    yes=True,
                    plan_hash=plan["plan_hash"],
                    _crash_before_journal=True,
                )

            journal = target / ".vivary" / "runtime" / "adopt-journal.json"
            self.assertFalse(journal.exists())
            self.assertIn(
                "vivary-adopt-prejournal",
                (target / ".gitignore").read_text(encoding="utf-8"),
            )
            interrupted_doctor = create_vivary.doctor_workspace(target, repo_root=ROOT)
            self.assertFalse(interrupted_doctor["ok"])
            self.assertTrue(
                any("pre-journal" in error for error in interrupted_doctor["errors"])
            )
            interrupted = snapshot(target)

            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--recover",
                    plan["plan_hash"],
                    "--json",
                ]
            )

            self.assertEqual(rc, 0, out)
            payload = json.loads(out)
            self.assertEqual(payload["mode"], "recovery-dry-run")
            self.assertFalse(payload["recovered"])
            self.assertEqual(snapshot(target), interrupted)

            apply_rc, apply_out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--recover",
                    plan["plan_hash"],
                    "--yes",
                    "--plan",
                    payload["recovery_plan_hash"],
                    "--json",
                ]
            )

            self.assertEqual(apply_rc, 0, apply_out)
            self.assertEqual(snapshot(target), before)
            self.assertTrue(json.loads(apply_out)["recovered"])
        finally:
            shutil.rmtree(target)

    def test_active_context_prejournal_recovery_uses_capability_privacy_block(self):
        target = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(
                target,
                preset="coding",
                active_context="cocoindex-code",
                repo_root=ROOT,
            )
            gitignore = target / ".gitignore"
            gitignore.write_text("node_modules/\n", encoding="utf-8")
            before = snapshot(target)
            plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                repo_root=ROOT,
            )

            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target,
                    preset="coding",
                    repo_root=ROOT,
                    yes=True,
                    plan_hash=plan["plan_hash"],
                    _crash_before_journal=True,
                )

            self.assertIn(
                ".cocoindex_code/",
                gitignore.read_text(encoding="utf-8"),
            )
            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--recover",
                    plan["plan_hash"],
                    "--json",
                ]
            )
            self.assertEqual(rc, 0, out)
            recovery = json.loads(out)
            apply_rc, apply_out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--recover",
                    plan["plan_hash"],
                    "--yes",
                    "--plan",
                    recovery["recovery_plan_hash"],
                    "--json",
                ]
            )
            self.assertEqual(apply_rc, 0, apply_out)
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_active_context_journal_recovery_validates_capability_privacy_block(self):
        target = temp_dir()
        try:
            create_vivary.scaffold_thin_workspace(
                target,
                preset="coding",
                active_context="cocoindex-code",
                repo_root=ROOT,
            )
            (target / ".gitignore").write_text(
                "node_modules/\n",
                encoding="utf-8",
            )
            before = snapshot(target)
            plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                repo_root=ROOT,
            )

            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target,
                    preset="coding",
                    repo_root=ROOT,
                    yes=True,
                    plan_hash=plan["plan_hash"],
                    _crash_after=1,
                )

            journal = target / ".vivary" / "runtime" / "adopt-journal.json"
            self.assertTrue(journal.is_file())
            payload = json.loads(journal.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["approval"]["capabilities"],
                ["cocoindex-code"],
            )
            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--recover",
                    plan["plan_hash"],
                    "--json",
                ]
            )
            self.assertEqual(rc, 0, out)
            recovery = json.loads(out)
            apply_rc, apply_out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--recover",
                    plan["plan_hash"],
                    "--yes",
                    "--plan",
                    recovery["recovery_plan_hash"],
                    "--json",
                ]
            )
            self.assertEqual(apply_rc, 0, apply_out)
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_workspace_controlled_journal_cannot_delete_an_arbitrary_file(self):
        target = temp_dir()
        try:
            victim = target / "README.md"
            write(victim, "# User-owned project\n")
            transaction_hash = "sha256:" + "a" * 64
            journal = target / ".vivary" / "runtime" / "adopt-journal.json"
            forged = {
                "schema": create_vivary._ADOPT_JOURNAL_SCHEMA,
                "plan_hash": transaction_hash,
                "phase": "applying",
                "completed": 1,
                "actions": [
                    {
                        "path": "README.md",
                        "kind": "create",
                        "existed": False,
                        "before": None,
                        "before_hash": None,
                        "after_hash": create_vivary._sha256_prefixed(victim.read_bytes()),
                        "transient_after_hash": None,
                    }
                ],
            }
            write(journal, json.dumps(forged))

            rc, out = run_cli(
                [
                    "adopt",
                    str(target),
                    "--recover",
                    transaction_hash,
                    "--json",
                ]
            )

            self.assertEqual(rc, 1, out)
            self.assertEqual(victim.read_text(encoding="utf-8"), "# User-owned project\n")
        finally:
            shutil.rmtree(target)

    def test_rollback_delete_cannot_follow_a_swapped_parent(self):
        target = temp_dir()
        outside = target.with_name(target.name + "-outside")
        moved = target.with_name(target.name + "-moved-vivary")
        (outside / ".vivary").mkdir(parents=True)
        victim = outside / ".vivary" / "context.md"
        write(victim, "outside stays unchanged\n")
        generated = target / ".vivary" / "context.md"
        generated_bytes = b"generated context\n"
        generated.parent.mkdir(parents=True)
        generated.write_bytes(generated_bytes)
        action = {
            "path": generated,
            "after": generated_bytes,
            "after_hash": create_vivary._sha256_prefixed(generated_bytes),
        }
        attack = {"attempted": False, "blocked": False}
        real_replace = create_vivary.os.replace

        def swap_parent():
            attack["attempted"] = True
            try:
                real_replace(target / ".vivary", moved)
                (target / ".vivary").symlink_to(outside / ".vivary", target_is_directory=True)
            except OSError:
                attack["blocked"] = True

        if create_vivary.os.name == "nt":
            real_delete = create_vivary._windows_delete_open_file

            def attempt_windows_swap(file_handle):
                if not attack["attempted"]:
                    swap_parent()
                return real_delete(file_handle)

            patcher = mock.patch.object(
                create_vivary,
                "_windows_delete_open_file",
                side_effect=attempt_windows_swap,
            )
        else:
            real_unlink = create_vivary.os.unlink

            def attempt_posix_swap(path, *args, **kwargs):
                if not attack["attempted"] and Path(path).name == "context.md":
                    swap_parent()
                return real_unlink(path, *args, **kwargs)

            patcher = mock.patch.object(
                create_vivary.os,
                "unlink",
                side_effect=attempt_posix_swap,
            )

        try:
            with patcher:
                try:
                    create_vivary._rollback_adopt(
                        target,
                        [action],
                        {generated: None},
                        cleanup_journal=False,
                    )
                except create_vivary.ScaffoldError:
                    pass

            self.assertTrue(attack["attempted"])
            if attack["blocked"]:
                self.assertFalse(generated.exists())
            else:
                self.assertFalse((moved / "context.md").exists())
            self.assertEqual(victim.read_text(encoding="utf-8"), "outside stays unchanged\n")
        finally:
            link = target / ".vivary"
            if link.is_symlink():
                link.unlink()
            for path in (target, moved, outside):
                if path.exists():
                    shutil.rmtree(path)

    def test_empty_directory_cleanup_does_not_use_pathname_rmdir(self):
        target = temp_dir()
        try:
            (target / ".vivary" / "runtime").mkdir(parents=True)

            with mock.patch.object(Path, "rmdir") as unsafe_rmdir:
                create_vivary._remove_empty_adopt_dirs(target)

            unsafe_rmdir.assert_not_called()
            create_vivary._remove_empty_adopt_dirs(target)
            self.assertFalse((target / ".vivary").exists())
        finally:
            shutil.rmtree(target)

    def test_stale_known_generated_adapter_replacement_is_in_the_approved_plan(self):
        target = temp_dir()
        try:
            current, _, _ = create_vivary._thin_adapter_doc("agents")
            stale = current.replace(
                f"create-vivary {create_vivary.__version__}",
                "create-vivary 0.3.3",
                1,
            )
            adapter = target / ".agents" / "skills" / "vivary" / "SKILL.md"
            write(adapter, stale)

            plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                adapters=("agents",),
            )

            self.assertFalse(plan["conflicts"])
            self.assertEqual(plan["optional_projections"][0]["status"], "replace")
            self.assertEqual(
                [item["path"] for item in plan["adapter_replacements"]],
                [adapter],
            )
            create_vivary.adopt_workspace(
                target,
                preset="coding",
                adapters=("agents",),
                yes=True,
                plan_hash=plan["plan_hash"],
            )
            self.assertEqual(adapter.read_text(encoding="utf-8"), current)
            projection = create_vivary._adopt_report_to_json(plan, mode="dry-run")["content_plan"]
            row = next(row for row in projection["files"] if row["path"] == ".agents/skills/vivary/SKILL.md")
            self.assertEqual(row["operation"], "replace")
            self.assertEqual(row["content"].encode("utf-8"), adapter.read_bytes())
            self.assertEqual(row["before_hash"], "sha256:" + hashlib.sha256(stale.encode("utf-8")).hexdigest())
            self.assertEqual(row["bytes"], len(adapter.read_bytes()))
            self.assertEqual(row["content_hash"], "sha256:" + hashlib.sha256(adapter.read_bytes()).hexdigest())

            future = current.replace(
                f"create-vivary {create_vivary.__version__}",
                "create-vivary 999.0.0",
                1,
            )
            write(adapter, future)
            future_plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                adapters=("agents",),
            )
            self.assertEqual(future_plan["optional_projections"][0]["status"], "conflict")
            self.assertEqual(
                [item["path"] for item in future_plan["conflicts"]],
                [adapter],
            )
        finally:
            shutil.rmtree(target)

    def test_host_mutation_after_approval_is_revalidated_before_vivary_writes(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "# Existing agent rules\n")
            write(target / ".gitignore", "node_modules/\n")
            write(target / "STATE.md", "# Existing state\n")
            plan = create_vivary.plan_adopt(target, preset="coding")
            agents_before = (target / "AGENTS.md").read_bytes()
            gitignore_before = (target / ".gitignore").read_bytes()

            def mutate_kept_input() -> None:
                write(target / "STATE.md", "# Externally changed state\n")

            with self.assertRaisesRegex(create_vivary.ScaffoldError, "input changed"):
                create_vivary.adopt_workspace(
                    target,
                    preset="coding",
                    yes=True,
                    plan_hash=plan["plan_hash"],
                    _before_apply=mutate_kept_input,
                )

            self.assertEqual((target / "AGENTS.md").read_bytes(), agents_before)
            self.assertEqual((target / ".gitignore").read_bytes(), gitignore_before)
            self.assertEqual(
                (target / "STATE.md").read_text(encoding="utf-8"),
                "# Externally changed state\n",
            )
            self.assertFalse((target / ".vivary" / "context.md").exists())
            self.assertFalse(
                (target / ".vivary" / "runtime" / "adopt-journal.json").exists()
            )
        finally:
            shutil.rmtree(target)

    def test_existing_noncontract_capsule_is_a_read_only_conflict(self):
        target = temp_dir()
        try:
            write(target / ".vivary" / "context.md", "# user-owned context\n")
            write(target / "STATE.md", "# Existing state\n")
            before = snapshot(target)

            rc, out = run_cli(
                ["adopt", str(target), "--preset", "coding", "--json"]
            )

            self.assertEqual(rc, 1)
            self.assertEqual(snapshot(target), before)
            payload = json.loads(out)
            self.assertFalse(payload["ok"])
            self.assertEqual(
                [conflict["path"] for conflict in payload["conflicts"]],
                [".vivary/context.md"],
            )
            self.assertIn("STATE.md", payload["kept"])
        finally:
            shutil.rmtree(target)

    def test_valid_user_extended_v03_capsule_and_config_are_kept_byte_for_byte(self):
        target = temp_dir()
        try:
            initial = create_vivary.plan_adopt(
                target,
                preset="coding",
                repo_root=ROOT,
            )
            create_vivary.adopt_workspace(
                target,
                preset="coding",
                repo_root=ROOT,
                yes=True,
                plan_hash=initial["plan_hash"],
            )
            context = target / ".vivary" / "context.md"
            workspace = target / ".vivary" / "workspace.toml"
            context.write_text(
                context.read_text(encoding="utf-8")
                + "\n## Project-specific route\n\nRead `docs/architecture.md` when structure matters.\n",
                encoding="utf-8",
            )
            workspace.write_text(
                workspace.read_text(encoding="utf-8")
                + '\n[types.note]\nfolder = "notes"\noptional = { source = "string" }\n',
                encoding="utf-8",
            )
            before = snapshot(target)

            plan = create_vivary.plan_adopt(
                target,
                preset="coding",
                repo_root=ROOT,
            )

            self.assertFalse(plan["conflicts"])
            self.assertFalse(plan["creates"])
            self.assertFalse(plan["patches"])
            self.assertIn(context, plan["kept"])
            self.assertIn(workspace, plan["kept"])
            applied = create_vivary.adopt_workspace(
                target,
                preset="coding",
                repo_root=ROOT,
                yes=True,
                plan_hash=plan["plan_hash"],
            )
            self.assertTrue(applied["doctor"]["ok"])
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)


@contextlib.contextmanager
def held_adoption(target: Path, recover_hash: str | None = None):
    script = """
import sys
sys.path.insert(0, sys.argv[1])
import create_vivary

def wait_before_apply():
    print("ready", flush=True)
    sys.stdin.read(1)

if sys.argv[3]:
    plan = create_vivary.adopt_workspace(sys.argv[2], recover_hash=sys.argv[3])
    rollback = create_vivary._rollback_adopt
    def wait_then_rollback(*args, **kwargs):
        wait_before_apply()
        return rollback(*args, **kwargs)
    create_vivary._rollback_adopt = wait_then_rollback
    create_vivary.adopt_workspace(sys.argv[2], yes=True, recover_hash=sys.argv[3],
                                  plan_hash=plan["recovery_plan_hash"])
else:
    plan = create_vivary.adopt_workspace(sys.argv[2])
    create_vivary.adopt_workspace(sys.argv[2], yes=True, plan_hash=plan["plan_hash"],
                                  _before_apply=wait_before_apply)
"""
    child = subprocess.Popen(
        [sys.executable, "-I", "-B", "-c", script, str(PKG), str(target), recover_hash or ""],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    ready = queue.Queue()
    threading.Thread(target=lambda: ready.put(child.stdout.readline()), daemon=True).start()
    try:
        if ready.get(timeout=5) != "ready\n":
            raise AssertionError("adoption holder did not reach the apply boundary")
        yield child
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=5)


class AdoptionJournalSizeTests(unittest.TestCase):
    def test_oversized_backup_refuses_before_even_the_privacy_write(self):
        for original in ("x" * (800 * 1024), "雪" * (280 * 1024)):
            with self.subTest(utf8_bytes=len(original.encode("utf-8"))):
                target = temp_dir()
                try:
                    write(target / "AGENTS.md", original)
                    before = snapshot(target)
                    plan = create_vivary.adopt_workspace(target, preset="coding")
                    self.assertFalse(plan["conflicts"])
                    self.assertEqual(snapshot(target), before)
                    with self.assertRaisesRegex(
                        create_vivary.ScaffoldError, "journal exceeds the recovery size limit"
                    ):
                        create_vivary.adopt_workspace(
                            target, preset="coding", yes=True,
                            plan_hash=plan["plan_hash"], _crash_before_journal=True,
                        )
                    self.assertEqual(snapshot(target), before)
                    self.assertEqual(sorted(p.name for p in target.iterdir()), ["AGENTS.md"])
                    rc, output = run_cli([
                        "adopt", str(target), "--preset", "coding", "--yes",
                        "--plan", plan["plan_hash"], "--json",
                    ])
                    self.assertNotEqual(rc, 0, output)
                    self.assertIn("journal exceeds the recovery size limit", output)
                    self.assertEqual(snapshot(target), before)
                    self.assertEqual(sorted(p.name for p in target.iterdir()), ["AGENTS.md"])
                finally:
                    shutil.rmtree(target)

    def test_near_limit_interrupted_patch_recovers_original_bytes(self):
        target = temp_dir()
        try:
            original = b"# Host rules\r\n" + b"x" * (760 * 1024)
            (target / "AGENTS.md").write_bytes(original)
            before = snapshot(target)
            plan = create_vivary.adopt_workspace(target, preset="coding")
            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target, preset="coding", yes=True,
                    plan_hash=plan["plan_hash"], _crash_after=4,
                )
            journal = target / ".vivary/runtime/adopt-journal.json"
            self.assertGreater(journal.stat().st_size, 1000 * 1024)
            self.assertLessEqual(journal.stat().st_size, 1024 * 1024)
            self.assertNotEqual((target / "AGENTS.md").read_bytes(), original)
            interrupted = snapshot(target)
            recovery = create_vivary.adopt_workspace(target, recover_hash=plan["plan_hash"])
            self.assertEqual(snapshot(target), interrupted)
            result = create_vivary.adopt_workspace(
                target, recover_hash=plan["plan_hash"], yes=True,
                plan_hash=recovery["recovery_plan_hash"],
            )
            self.assertTrue(result["recovered"])
            self.assertEqual((target / "AGENTS.md").read_bytes(), original)
            self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_preflight_reserves_the_extra_byte_for_applying_phase(self):
        target = temp_dir()
        try:
            write(target / "AGENTS.md", "# Host rules\n")
            before = snapshot(target)
            plan = create_vivary.adopt_workspace(target, preset="coding")
            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(
                    target, preset="coding", yes=True,
                    plan_hash=plan["plan_hash"], _crash_after=1,
                )
            applying_size = (target / ".vivary/runtime/adopt-journal.json").stat().st_size
            recovery = create_vivary.adopt_workspace(target, recover_hash=plan["plan_hash"])
            create_vivary.adopt_workspace(
                target, recover_hash=plan["plan_hash"], yes=True,
                plan_hash=recovery["recovery_plan_hash"],
            )
            self.assertEqual(snapshot(target), before)
            # The planned journal fits here; changing its phase adds one byte.
            with mock.patch.object(create_vivary, "_ADOPT_JOURNAL_MAX_BYTES", applying_size - 1):
                with self.assertRaisesRegex(
                    create_vivary.ScaffoldError, "journal exceeds the recovery size limit"
                ):
                    create_vivary.adopt_workspace(
                        target, preset="coding", yes=True,
                        plan_hash=plan["plan_hash"], _crash_before_journal=True,
                    )
            self.assertEqual(snapshot(target), before)
            self.assertEqual(sorted(p.name for p in target.iterdir()), ["AGENTS.md"])
        finally:
            shutil.rmtree(target)


class AdoptionExclusionTests(unittest.TestCase):
    def test_second_process_apply_refuses_before_any_project_write(self):
        target = temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            before = snapshot(target)
            with held_adoption(target):
                with self.assertRaisesRegex(create_vivary.ScaffoldError, "already running"):
                    create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])
                self.assertEqual(snapshot(target), before)
        finally:
            shutil.rmtree(target)

    def test_missing_or_file_target_remains_a_structured_cli_refusal(self):
        parent = temp_dir()
        try:
            file_target = parent / "file"
            file_target.write_bytes(b"keep this file")
            for target, reason in ((parent / "missing", "does not exist"), (file_target, "not a directory")):
                with self.subTest(reason=reason):
                    rc, output = run_cli(["adopt", str(target), "--yes", "--plan", "sha256:" + "0" * 64, "--json"])
                    self.assertEqual(rc, 1, output)
                    self.assertIn(reason, json.loads(output)["error"])
            self.assertEqual(list(parent.iterdir()), [file_target])
            self.assertEqual(file_target.read_bytes(), b"keep this file")
        finally:
            shutil.rmtree(parent)

    def test_preview_and_other_target_proceed_while_apply_is_held(self):
        target, other = temp_dir(), temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            with held_adoption(target):
                self.assertEqual(create_vivary.adopt_workspace(target)["plan_hash"], plan["plan_hash"])
                self.assertEqual(list(target.iterdir()), [])
                other_plan = create_vivary.adopt_workspace(other)
                result = create_vivary.adopt_workspace(other, yes=True, plan_hash=other_plan["plan_hash"])
                self.assertTrue(result["doctor"]["ok"])
                self.assertEqual(list(target.iterdir()), [])
        finally:
            shutil.rmtree(target)
            shutil.rmtree(other)

    def test_killed_apply_holder_releases_exclusion_and_leaves_no_metadata(self):
        target = temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            with held_adoption(target):
                self.assertEqual(list(target.iterdir()), [])
            result = create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])
            self.assertTrue(result["doctor"]["ok"])
            unchanged = snapshot(target)
            no_op = create_vivary.adopt_workspace(target)
            self.assertEqual(no_op["writes"], [])
            create_vivary.adopt_workspace(target, yes=True, plan_hash=no_op["plan_hash"])
            self.assertEqual(snapshot(target), unchanged)
        finally:
            shutil.rmtree(target)

    def test_apply_and_recovery_contenders_leave_interrupted_state_unchanged(self):
        target = temp_dir()
        try:
            original = snapshot(target)
            plan = create_vivary.adopt_workspace(target)
            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"], _crash_after=1)
            interrupted = snapshot(target)
            recovery = create_vivary.adopt_workspace(target, recover_hash=plan["plan_hash"])
            with held_adoption(target, plan["plan_hash"]):
                for request in (
                    {"plan_hash": plan["plan_hash"]},
                    {"recover_hash": plan["plan_hash"], "plan_hash": recovery["recovery_plan_hash"]},
                ):
                    with self.assertRaisesRegex(create_vivary.ScaffoldError, "already running"):
                        create_vivary.adopt_workspace(target, yes=True, **request)
                    self.assertEqual(snapshot(target), interrupted)
                preview = create_vivary.adopt_workspace(target, recover_hash=plan["plan_hash"])
                self.assertEqual(preview["recovery_plan_hash"], recovery["recovery_plan_hash"])
                self.assertEqual(snapshot(target), interrupted)
            result = create_vivary.adopt_workspace(target, yes=True, recover_hash=plan["plan_hash"],
                                                   plan_hash=recovery["recovery_plan_hash"])
            self.assertTrue(result["recovered"])
            self.assertEqual(snapshot(target), original)
        finally:
            shutil.rmtree(target)

    def test_recovery_refuses_while_ordinary_apply_is_held(self):
        target = temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            with held_adoption(target):
                with self.assertRaisesRegex(create_vivary.ScaffoldError, "already running"):
                    create_vivary.adopt_workspace(target, yes=True, recover_hash=plan["plan_hash"],
                                                   plan_hash=plan["plan_hash"])
                self.assertEqual(list(target.iterdir()), [])
        finally:
            shutil.rmtree(target)

    def test_reentrant_apply_refuses_without_disturbing_the_outer_apply(self):
        target = temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            def nested_apply():
                with self.assertRaisesRegex(create_vivary.ScaffoldError, "already running"):
                    create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])
                self.assertEqual(list(target.iterdir()), [])
            result = create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"],
                                                   _before_apply=nested_apply)
            self.assertTrue(result["doctor"]["ok"])
        finally:
            shutil.rmtree(target)

    def test_cli_cannot_bypass_an_apply_holder_with_an_equivalent_target_path(self):
        target = temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            alias = str(target.parent) + os.sep + "." + os.sep + target.name
            with held_adoption(target):
                rc, output = run_cli(["adopt", alias, "--yes", "--plan", plan["plan_hash"], "--json"])
                self.assertEqual(rc, 1, output)
                self.assertIn("already running", json.loads(output)["error"])
                self.assertEqual(list(target.iterdir()), [])
        finally:
            shutil.rmtree(target)

    @unittest.skipUnless(os.name == "posix", "requires unprivileged symlink creation")
    def test_unrelated_placeholder_symlink_is_not_an_adoption_destination(self):
        target, outside = temp_dir(), temp_dir()
        try:
            source = outside / "host.txt"
            source.write_bytes(b"untouched host content")
            link = target / ".adopt-placeholder"
            link.symlink_to(source)
            plan = create_vivary.adopt_workspace(target)
            self.assertEqual(plan["conflicts"], [])
            result = create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])
            self.assertTrue(result["doctor"]["ok"])
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.readlink(), source)
            self.assertEqual(source.read_bytes(), b"untouched host content")
        finally:
            shutil.rmtree(target)
            shutil.rmtree(outside)

    @unittest.skipUnless(os.name == "posix", "requires POSIX flock")
    def test_unsupported_lock_refuses_without_effects_and_releases_local_claim(self):
        import fcntl
        target = temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            with mock.patch.object(fcntl, "flock", side_effect=OSError(errno.EOPNOTSUPP, "unsupported")):
                with self.assertRaisesRegex(create_vivary.ScaffoldError, "cannot exclude concurrent adoption"):
                    create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])
            self.assertEqual(list(target.iterdir()), [])
            self.assertTrue(create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])["applied"])
        finally:
            shutil.rmtree(target)

    @unittest.skipUnless(os.name == "nt", "requires Windows mutex")
    def test_windows_mutex_failures_refuse_without_effects_and_release_handles(self):
        target = temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            with mock.patch.object(create_vivary, "_WINDOWS_CREATE_MUTEX", return_value=None) as denied:
                with self.assertRaisesRegex(create_vivary.ScaffoldError, "cannot acquire global adoption exclusion"):
                    create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])
                self.assertTrue(denied.call_args.args[2].startswith("Global\\VivaryAdoptV1_"))
                self.assertEqual(list(target.iterdir()), [])
            for status, message in ((0xFFFFFFFF, "cannot acquire"), (0x102, "already running")):
                with self.subTest(status=status):
                    with mock.patch.object(create_vivary, "_WINDOWS_WAIT_OBJECT", return_value=status), \
                            mock.patch.object(create_vivary, "_WINDOWS_RELEASE_MUTEX") as release:
                        with self.assertRaisesRegex(create_vivary.ScaffoldError, message):
                            create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])
                        release.assert_not_called()
                    self.assertEqual(list(target.iterdir()), [])
            # A failed wait must not leak the in-process claim or acquire ownership.
            self.assertTrue(create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])["applied"])
        finally:
            shutil.rmtree(target)

    @unittest.skipUnless(os.name == "nt", "requires Windows mutex")
    def test_windows_abandoned_ownership_still_uses_existing_recovery_checks(self):
        target = temp_dir()
        try:
            plan = create_vivary.adopt_workspace(target)
            with self.assertRaises(KeyboardInterrupt):
                create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"], _crash_after=1)
            interrupted = snapshot(target)
            wait = create_vivary._WINDOWS_WAIT_OBJECT
            def abandoned(handle, timeout):
                self.assertEqual(wait(handle, timeout), 0)
                return 0x80
            with mock.patch.object(create_vivary, "_WINDOWS_WAIT_OBJECT", side_effect=abandoned):
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary.adopt_workspace(target, yes=True, plan_hash=plan["plan_hash"])
            self.assertEqual(snapshot(target), interrupted)
            recovery = create_vivary.adopt_workspace(target, recover_hash=plan["plan_hash"])
            result = create_vivary.adopt_workspace(target, yes=True, recover_hash=plan["plan_hash"],
                                                   plan_hash=recovery["recovery_plan_hash"])
            self.assertTrue(result["recovered"])
        finally:
            shutil.rmtree(target)


class AdoptionReplayTests(unittest.TestCase):
    def setUp(self):
        self.target = temp_dir()
        self.addCleanup(shutil.rmtree, self.target)
        (self.target / 'AGENTS.md').write_bytes(b'# Existing host guidance\n')
        (self.target / 'STATE.md').write_bytes(b'Private retained state\n')
        (self.target / '.gitignore').write_bytes(b'.vivary/runtime/\n')
        self.plan = create_vivary.plan_adopt(self.target, preset='coding')
        self.request_id = 'setup-attempt-1'

    def apply(self, **overrides):
        arguments = dict(preset='coding', yes=True, plan_hash=self.plan['plan_hash'], request_id=self.request_id)
        arguments.update(overrides)
        return create_vivary.adopt_workspace(self.target, **arguments)

    def snapshot(self):
        return {p.relative_to(self.target).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in self.target.rglob('*') if p.is_file()}

    def recovery(self, **overrides):
        arguments = dict(recover_hash=self.plan['plan_hash'], request_id=self.request_id)
        arguments.update(overrides)
        return create_vivary.adopt_workspace(self.target, **arguments)

    def test_nested_runtime_ignore_survives_request_recovery_and_replay(self):
        for root_ignore in (None, b'# Retain host rules\nnode_modules/\n'):
            with self.subTest(root_ignore=root_ignore):
                target = temp_dir()
                self.addCleanup(shutil.rmtree, target)
                if root_ignore is not None:
                    (target / '.gitignore').write_bytes(root_ignore)
                write(target / '.vivary/.gitignore', 'runtime/\n')
                (target / 'AGENTS.md').write_bytes(b'# Host guidance\n')
                before = snapshot(target)
                plan = create_vivary.plan_adopt(target, preset='coding')
                self.assertTrue(plan['request_replay']['ready'])
                with self.assertRaises(KeyboardInterrupt):
                    create_vivary.adopt_workspace(target, preset='coding', yes=True,
                        plan_hash=plan['plan_hash'], request_id=self.request_id, _crash_after=2)
                arguments = dict(recover_hash=plan['plan_hash'], request_id=self.request_id)
                review = create_vivary.adopt_workspace(target, **arguments)
                for _ in range(2):
                    result = create_vivary.adopt_workspace(target, **arguments,
                        yes=True, plan_hash=review['recovery_plan_hash'])
                    self.assertTrue(result['recovered'])
                    self.assertEqual(result['recovery_plan_hash'], review['recovery_plan_hash'])
                after = snapshot(target)
                del after['.vivary/runtime/adopt-receipts/' + self.request_id + '.json']
                self.assertEqual(after, before)

    def test_recovery_rechecks_nested_privacy_under_restored_root_rules(self):
        (self.target / '.gitignore').write_bytes(b'# Host rules\n')
        write(self.target / '.vivary/.gitignore', 'runtime/\n')
        self.plan = create_vivary.plan_adopt(self.target, preset='coding')
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        (self.target / '.vivary/.gitignore').write_bytes(b'!runtime/\n')
        review = self.recovery()
        before = self.snapshot()
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'privacy'):
            self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
        self.assertEqual(self.snapshot(), before)

    def test_cli_pre_mutation_refusal_identifies_only_the_current_attempt(self):
        runtime = self.target / '.vivary/runtime'
        outside = temp_dir()
        self.addCleanup(shutil.rmtree, outside)
        runtime.parent.mkdir(exist_ok=True)
        try:
            runtime.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('directory symlinks unavailable')
        before = snapshot(self.target)
        outside_before = snapshot(outside)
        rc, output = run_cli(['adopt', str(self.target), '--preset', 'coding', '--yes',
            '--plan', self.plan['plan_hash'], '--request-id', self.request_id, '--json'])
        self.assertEqual(rc, 1, output)
        failure = json.loads(output)
        self.assertFalse(failure['ok'])
        self.assertEqual(failure['attempt_status'], 'refused_before_mutation')
        self.assertEqual(failure['root'], str(self.target.resolve()))
        self.assertEqual(failure['plan_hash'], self.plan['plan_hash'])
        self.assertEqual(failure['request_id'], self.request_id)
        self.assertNotIn('request_status', failure)
        self.assertEqual(snapshot(self.target), before)
        self.assertEqual(snapshot(outside), outside_before)

    def test_refused_retry_does_not_claim_prior_attempt_made_no_writes(self):
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        before = self.snapshot()
        rc, output = run_cli(['adopt', str(self.target), '--preset', 'coding', '--yes',
            '--plan', self.plan['plan_hash'], '--request-id', self.request_id, '--json'])
        self.assertEqual(rc, 1, output)
        failure = json.loads(output)
        self.assertEqual(failure['attempt_status'], 'refused_before_mutation')
        self.assertNotIn('request_status', failure)
        self.assertEqual(self.snapshot(), before)
        self.assertIn('.vivary/runtime/adopt-journal.json', before)

    def test_post_mutation_failure_never_has_pre_mutation_status(self):
        def failed_journal(*args, **kwargs):
            raise create_vivary.ScaffoldError('journal write acknowledgement lost')
        with mock.patch.object(create_vivary, '_write_adopt_journal', side_effect=failed_journal):
            rc, output = run_cli(['adopt', str(self.target), '--preset', 'coding', '--yes',
                '--plan', self.plan['plan_hash'], '--request-id', self.request_id, '--json'])
        self.assertEqual(rc, 1, output)
        self.assertNotIn('attempt_status', json.loads(output))

    def test_request_journal_precedes_first_write_and_supports_first_action_recovery(self):
        original_apply = create_vivary._apply_adopt_action
        observed = []
        def apply_action(target, action, **kwargs):
            journal = json.loads((target / '.vivary/runtime/adopt-journal.json').read_text())
            self.assertEqual(journal['request']['id'], self.request_id)
            observed.append(action['path'].relative_to(target).as_posix())
            return original_apply(target, action, **kwargs)
        with mock.patch.object(create_vivary, '_apply_adopt_action', side_effect=apply_action):
            with self.assertRaisesRegex(KeyboardInterrupt, 'after replacement 1'):
                self.apply(_crash_after=1, _crash_before_journal=True)
        self.assertEqual(observed, ['.gitignore'])
        before = self.snapshot()
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'unfinished adoption journal'):
            self.apply()
        self.assertEqual(self.snapshot(), before)
        review = self.recovery()
        result = self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
        self.assertTrue(result['recovered'])
        self.assertEqual((self.target / '.gitignore').read_bytes(), b'.vivary/runtime/\n')

    def test_recovery_receipt_replays_lost_response_after_journal_removal(self):
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        review = self.recovery()
        expected = review['recovery_plan_hash']
        original_unlink = create_vivary._unlink_no_follow
        def unlink(target, destination, **kwargs):
            result = original_unlink(target, destination, **kwargs)
            if destination.name == 'adopt-journal.json':
                raise OSError('lost recovery acknowledgement')
            return result
        with mock.patch.object(create_vivary, '_unlink_no_follow', side_effect=unlink):
            with self.assertRaisesRegex(OSError, 'lost recovery'):
                self.recovery(yes=True, plan_hash=expected)
        before = self.snapshot()
        dry_run = self.recovery()
        self.assertFalse(dry_run['recovered'])
        self.assertEqual(dry_run['recovery_plan_hash'], expected)
        replay = self.recovery(yes=True, plan_hash=expected)
        self.assertTrue(replay['recovered'])
        self.assertEqual(replay['recovery_actions'], review['recovery_actions'])
        self.assertEqual(replay['recovery_plan_hash'], expected)
        self.assertEqual(self.snapshot(), before)
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'was recovered'):
            self.apply()
        fresh = create_vivary.plan_adopt(self.target, preset='coding')
        result = self.apply(plan_hash=fresh['plan_hash'], request_id='new-request-after-recovery')
        self.assertTrue(result['applied'])
        after = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            self.recovery(yes=True, plan_hash=expected)
        self.assertEqual(self.snapshot(), after)

    def test_recovery_receipt_replays_lost_response_before_journal_cleanup(self):
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        review = self.recovery()
        original_write = create_vivary._atomic_write_bytes_no_follow
        def publish(target, destination, data, **kwargs):
            result = original_write(target, destination, data, **kwargs)
            if destination.parent.name == 'adopt-receipts':
                raise OSError('lost receipt acknowledgement')
            return result
        with mock.patch.object(create_vivary, '_atomic_write_bytes_no_follow', side_effect=publish):
            with self.assertRaisesRegex(OSError, 'lost receipt'):
                self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
        before = self.snapshot()
        self.recovery()
        self.assertEqual(self.snapshot(), before)
        replay = self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
        self.assertTrue(replay['recovered'])
        del before['.vivary/runtime/adopt-journal.json']
        self.assertEqual(self.snapshot(), before)

    def test_recovery_receipt_rejects_changed_bytes_wrong_id_and_wrong_approval(self):
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        before = self.snapshot()
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'request ID'):
            self.recovery(request_id='another-request')
        self.assertEqual(self.snapshot(), before)
        review = self.recovery()
        self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
        before = self.snapshot()
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'hash mismatch'):
            self.recovery(yes=True, plan_hash='sha256:' + '0' * 64)
        self.assertEqual(self.snapshot(), before)
        for name in ['AGENTS.md', 'STATE.md']:
            with self.subTest(name=name):
                path = self.target / name
                original = path.read_bytes()
                path.write_bytes(b'Changed after recovery\n')
                changed = self.snapshot()
                with self.assertRaises(create_vivary.ScaffoldError):
                    self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
                self.assertEqual(self.snapshot(), changed)
                path.write_bytes(original)

    def test_recovery_receipt_is_bounded_before_rollback(self):
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        review = self.recovery()
        journal = self.target / '.vivary/runtime/adopt-journal.json'
        before = self.snapshot()
        with mock.patch.object(create_vivary, '_ADOPT_JOURNAL_MAX_BYTES', journal.stat().st_size + 1):
            with self.assertRaisesRegex(create_vivary.ScaffoldError, 'size limit'):
                self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
        self.assertEqual(self.snapshot(), before)

    def test_recovery_receipt_rejects_copied_root_and_altered_record(self):
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        review = self.recovery()
        self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
        other = temp_dir()
        self.addCleanup(shutil.rmtree, other)
        shutil.copytree(self.target, other, dirs_exist_ok=True)
        before = snapshot(other)
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'different workspace root'):
            create_vivary.adopt_workspace(other, recover_hash=self.plan['plan_hash'],
                request_id=self.request_id, yes=True, plan_hash=review['recovery_plan_hash'])
        self.assertEqual(snapshot(other), before)
        receipt = self.receipt()
        payload = json.loads(receipt.read_text())
        payload['recovery_actions'][0]['operation'] = 'delete-created'
        receipt.write_text(json.dumps(payload))
        before = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            self.recovery(yes=True, plan_hash=review['recovery_plan_hash'])
        self.assertEqual(self.snapshot(), before)

    def test_request_recovery_cli_retains_original_hash_on_replay(self):
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        arguments = ['adopt', str(self.target), '--recover', self.plan['plan_hash'],
            '--request-id', self.request_id]
        rc, output = run_cli(arguments)
        self.assertEqual(rc, 0, output)
        self.assertIn("Would adopt", output)
        arguments += ['--json']
        rc, output = run_cli(arguments)
        self.assertEqual(rc, 0, output)
        review = json.loads(output)
        self.assertEqual(review['mode'], 'recovery-dry-run')
        arguments += ['--yes', '--plan', review['recovery_plan_hash']]
        for _ in range(2):
            rc, output = run_cli(arguments)
            self.assertEqual(rc, 0, output)
            result = json.loads(output)
            self.assertEqual(result['mode'], 'recovered')
            self.assertEqual(result['recovery_plan_hash'], review['recovery_plan_hash'])

    def test_unprotected_runtime_refuses_before_any_effects(self):
        (self.target / '.gitignore').unlink()
        plan = create_vivary.plan_adopt(self.target, preset='coding')
        before = self.snapshot()
        directories = sorted(str(p.relative_to(self.target)) for p in self.target.rglob('*') if p.is_dir())
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'privacy|ignored|protect'):
            self.apply(plan_hash=plan['plan_hash'])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(sorted(str(p.relative_to(self.target)) for p in self.target.rglob('*') if p.is_dir()), directories)

    def test_narrow_final_file_ignore_does_not_protect_receipt_temporary(self):
        (self.target / '.gitignore').write_text(
            '.vivary/private/\n*.vivary-tmp\n.vivary/runtime/*\n'
            '!.vivary/runtime/adopt-receipts/\n', encoding='utf-8')
        directory = self.target / '.vivary/runtime/adopt-receipts'
        directory.mkdir(parents=True)
        (directory / '.gitignore').write_text('*.json\n!*.vivary-tmp\n', encoding='utf-8')
        plan = create_vivary.plan_adopt(self.target, preset='coding')
        before = self.snapshot()
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'privacy|ignored|protect'):
            self.apply(plan_hash=plan['plan_hash'])
        self.assertEqual(self.snapshot(), before)

    @unittest.skipUnless(os.name == 'posix' and shutil.which('git'), 'POSIX atomic journal replacement and Git')
    def test_interrupted_journal_temp_stays_private_after_pending_rollback(self):
        subprocess.run(['git', 'init', '-q', str(self.target)], check=True, capture_output=True, timeout=10)
        self.plan = create_vivary.plan_adopt(self.target, preset='coding')
        initial_ignore = (self.target / '.gitignore').read_bytes()
        self.crash_process('journal-temp')
        leftovers = list((self.target / '.vivary/runtime').glob('*.vivary-tmp'))
        self.assertEqual(len(leftovers), 1)
        recovery = create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'])
        self.assertTrue(create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'],
                          yes=True, plan_hash=recovery['recovery_plan_hash'])['recovered'])
        self.assertEqual((self.target / '.gitignore').read_bytes(), initial_ignore)
        self.assertTrue(leftovers[0].is_file())
        relative = leftovers[0].relative_to(self.target).as_posix()
        ignored = subprocess.run(['git', '-C', str(self.target), 'check-ignore', '--no-index', '--', relative],
                                 capture_output=True, text=True, timeout=10)
        self.assertEqual(ignored.returncode, 0, ignored.stderr)
        self.assertEqual(ignored.stdout.strip(), relative)

    def test_adapter_retry_reports_the_original_reviewed_actions(self):
        plan = create_vivary.plan_adopt(self.target, preset='coding', adapters=('agents',))
        first = self.apply(plan_hash=plan['plan_hash'], adapters=('agents',))
        before = self.snapshot()
        replay = self.apply(plan_hash=plan['plan_hash'], adapters=('agents',))
        first_report = create_vivary._adopt_report_to_json(first, mode='applied')
        replay_report = create_vivary._adopt_report_to_json(replay, mode='applied')
        for field in ('creates', 'patches', 'optional_projections', 'would_create', 'kept', 'plan_hash', 'preset'):
            with self.subTest(field=field):
                self.assertEqual(replay_report[field], first_report[field])
        self.assertTrue(replay_report['replayed'])
        self.assertEqual(self.snapshot(), before)

    def test_readonly_receipt_is_valid_and_remains_readonly(self):
        self.apply()
        receipt = self.receipt()
        receipt.chmod(0o400)
        try:
            before = self.snapshot()
            mode = receipt.stat().st_mode
            self.assertTrue(self.apply()['replayed'])
            self.assertEqual(receipt.stat().st_mode, mode)
            self.assertEqual(self.snapshot(), before)
        finally:
            receipt.chmod(0o600)

    def test_malformed_receipt_shapes_refuse_without_effects(self):
        self.apply()
        receipt = self.receipt()
        original = receipt.read_bytes()
        variants = [b'null', b'[]', b'{"schema":1,"schema":2}', b'{"schema":"vivary.adopt-receipt.v1","journal":[]}']
        malformed = json.loads(original)
        malformed['journal']['approval']['creates'][0]['path'] = []
        variants.append(json.dumps(malformed).encode('utf-8'))
        changed_input_hash = json.loads(original)
        changed_input_hash['journal']['approval']['validation_inputs_hash'] = 'sha256:' + '0' * 64
        variants.append(json.dumps(changed_input_hash).encode('utf-8'))
        for content in variants:
            with self.subTest(content=content[:50]):
                receipt.write_bytes(content)
                before = self.snapshot()
                with self.assertRaises(create_vivary.ScaffoldError):
                    self.apply()
                self.assertEqual(self.snapshot(), before)
        receipt.write_bytes(original)
        self.assertTrue(self.apply()['replayed'])

    def test_copied_completion_receipt_does_not_authorize_a_different_root(self):
        self.apply()
        other = temp_dir()
        self.addCleanup(shutil.rmtree, other)
        shutil.copytree(self.target, other, dirs_exist_ok=True)
        before = snapshot(other)
        with self.assertRaises(create_vivary.ScaffoldError):
            create_vivary.adopt_workspace(other, preset='coding', yes=True,
                plan_hash=self.plan['plan_hash'], request_id=self.request_id)
        self.assertEqual(snapshot(other), before)

    def test_publication_intent_commit_then_error_never_rolls_back(self):
        original = create_vivary._write_adopt_journal

        def commit_then_error(target, journal, **kwargs):
            original(target, journal, **kwargs)
            if journal['phase'] == 'publishing':
                raise OSError('lost journal acknowledgement')

        with mock.patch.object(create_vivary, '_write_adopt_journal', side_effect=commit_then_error):
            with self.assertRaises(create_vivary.ScaffoldError):
                self.apply()
        self.assert_reviewed_bytes()
        self.assertFalse(self.receipt().exists())
        before = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'])
        with self.assertRaisesRegex(create_vivary.ScaffoldError, 'committed or uncertain'):
            self.recovery()
        self.assertEqual(self.snapshot(), before)

    def test_receipt_and_pending_journal_disagreement_refuses_cleanup(self):
        self.crash_process('after-receipt')
        journal_path = self.target / '.vivary/runtime/adopt-journal.json'
        journal = json.loads(journal_path.read_text())
        journal['phase'] = 'applying'
        journal_path.write_text(json.dumps(journal), encoding='utf-8')
        before = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            self.apply()
        with self.assertRaises(create_vivary.ScaffoldError):
            create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'])
        self.assertEqual(self.snapshot(), before)

    def test_retry_after_lost_response_preserves_files_and_original_approval(self):
        first = self.apply()
        before = self.snapshot()
        second = self.apply()
        self.assertTrue(first['applied'])
        self.assertFalse(first['replayed'])
        self.assertTrue(second['applied'])
        self.assertTrue(second['replayed'])
        self.assertEqual(second['request_id'], 'setup-attempt-1')
        self.assertEqual(second['plan_hash'], self.plan['plan_hash'])
        self.assertTrue(second['doctor']['ok'])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual((self.target / 'STATE.md').read_bytes(), b'Private retained state\n')

    def test_retry_refuses_changed_output_or_kept_input_without_writes(self):
        self.apply()
        for relative in ('AGENTS.md', 'STATE.md'):
            with self.subTest(relative=relative):
                path = self.target / relative
                original = path.read_bytes()
                path.write_bytes(b'Changed by the owner\n')
                before = self.snapshot()
                with self.assertRaises(create_vivary.ScaffoldError):
                    self.apply()
                self.assertEqual(self.snapshot(), before)
                path.write_bytes(original)

    def test_retry_refuses_different_approval_or_options_without_writes(self):
        self.apply()
        for change in ({'plan_hash': 'sha256:' + '0' * 64}, {'preset': 'writing'}, {'adapters': ('agents',)}):
            with self.subTest(change=change):
                before = self.snapshot()
                with self.assertRaises(create_vivary.ScaffoldError):
                    self.apply(**change)
                self.assertEqual(self.snapshot(), before)

    def test_request_requires_ordinary_approved_apply_and_safe_id_before_effects(self):
        for change in ({'yes': False}, {'plan_hash': None}, {'recover_hash': self.plan['plan_hash']},
                       {'request_id': '../escape'}, {'request_id': ''}, {'request_id': 'x' * 129},
                       {'request_id': 'CON'}, {'request_id': True}, {'request_id': 12}):
            with self.subTest(change=change):
                before = self.snapshot()
                with self.assertRaises(create_vivary.ScaffoldError):
                    self.apply(**change)
                self.assertEqual(self.snapshot(), before)

    def test_new_request_does_not_reuse_old_approval(self):
        self.apply()
        before = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            self.apply(request_id='different-request')
        self.assertEqual(self.snapshot(), before)

    def test_cli_retries_in_separate_processes_without_disclosing_backups(self):
        command = [sys.executable, str(ROOT / 'packages/create-vivary/create_vivary.py'),
                   'adopt', str(self.target), '--preset', 'coding', '--yes', '--plan',
                   self.plan['plan_hash'], '--request-id', self.request_id, '--json']
        first = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        before = self.snapshot()
        second = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(second.returncode, 0, second.stderr + second.stdout)
        report = json.loads(second.stdout)
        self.assertTrue(report['replayed'])
        self.assertEqual(report['request_id'], self.request_id)
        self.assertEqual(report['plan_hash'], self.plan['plan_hash'])
        self.assertNotIn('Private retained state', second.stdout)
        self.assertNotIn('Existing host guidance', second.stdout)
        self.assertEqual(self.snapshot(), before)


    def crash_process(self, boundary):
        script = r'''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import create_vivary as creator
root, plan_hash, request_id, boundary = sys.argv[2:]
original_write = creator._atomic_write_bytes_no_follow
original_link = os.link
original_replace = os.replace
journal_replacements = 0

def replace(source, destination, **kwargs):
    global journal_replacements
    if destination == "adopt-journal.json":
        journal_replacements += 1
        if boundary == "journal-temp" and journal_replacements == 2:
            os._exit(71)
    return original_replace(source, destination, **kwargs)

def write(target, destination, data, **kwargs):
    receipt = destination.parent.name == 'adopt-receipts'
    if receipt and boundary == 'before-receipt':
        os._exit(71)
    result = original_write(target, destination, data, **kwargs)
    if receipt and boundary == 'after-receipt':
        os._exit(71)
    if receipt and boundary == 'error-after-receipt':
        raise OSError('lost acknowledgement after receipt publication')
    return result

def link(source, destination, **kwargs):
    result = original_link(source, destination, **kwargs)
    if destination == request_id + '.json' and boundary == 'after-link':
        os._exit(71)
    return result

creator._atomic_write_bytes_no_follow = write
os.link = link
os.replace = replace
creator.adopt_workspace(root, preset='coding', yes=True, plan_hash=plan_hash,
                        request_id=request_id)
'''
        result = subprocess.run([sys.executable, '-c', script, str(PKG), str(self.target),
                                 self.plan['plan_hash'], self.request_id, boundary],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        if boundary != 'error-after-receipt':
            self.assertEqual(result.returncode, 71, result.stderr)
        return result

    def receipt(self):
        return self.target / '.vivary/runtime/adopt-receipts' / (self.request_id + '.json')

    def assert_reviewed_bytes(self):
        for row in self.plan['content_plan']['files']:
            self.assertEqual((self.target / row['path']).read_bytes(), row['content'].encode('utf-8'))
        self.assertEqual((self.target / 'STATE.md').read_bytes(), b'Private retained state\n')

    def test_completed_crash_retry_only_removes_redundant_journal(self):
        self.crash_process('after-receipt')
        journal = self.target / '.vivary/runtime/adopt-journal.json'
        self.assertTrue(journal.is_file())
        self.assert_reviewed_bytes()
        before = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'])
        self.assertEqual(self.snapshot(), before)
        result = self.apply()
        self.assertTrue(result['replayed'])
        before.pop('.vivary/runtime/adopt-journal.json')
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(journal.exists())

    def test_exception_after_receipt_publication_never_rolls_back(self):
        self.crash_process('error-after-receipt')
        self.assertTrue(self.receipt().is_file())
        self.assert_reviewed_bytes()
        result = self.apply()
        self.assertTrue(result['replayed'])
        self.assert_reviewed_bytes()

    def test_publication_intent_without_receipt_blocks_retry_and_rollback(self):
        self.crash_process('before-receipt')
        self.assertFalse(self.receipt().exists())
        self.assert_reviewed_bytes()
        before = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            self.apply()
        with self.assertRaises(create_vivary.ScaffoldError):
            create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'])
        self.assertEqual(self.snapshot(), before)

    @unittest.skipUnless(os.name == 'posix', 'POSIX no-replace link publication')
    def test_post_link_crash_replays_without_mutating_either_receipt_name(self):
        self.crash_process('after-link')
        receipt = self.receipt()
        self.assertEqual(receipt.stat().st_nlink, 2)
        aliases = [p for p in receipt.parent.iterdir() if p.name.endswith('.vivary-tmp')]
        self.assertEqual(len(aliases), 1)
        self.assertTrue(os.path.samefile(receipt, aliases[0]))
        before = self.snapshot()
        before.pop('.vivary/runtime/adopt-journal.json')
        self.assertTrue(self.apply()['replayed'])
        self.assertEqual(self.snapshot(), before)
        aliases[0].write_bytes(b'{broken through alias')
        altered = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            self.apply()
        self.assertEqual(self.snapshot(), altered)

    def test_corrupt_completion_blocks_retry_and_recovery_without_effects(self):
        self.crash_process('after-receipt')
        original = self.receipt().read_bytes()
        for content in (b'{', b'x' * (1024 * 1024 + 1)):
            with self.subTest(length=len(content)):
                self.receipt().write_bytes(content)
                before = self.snapshot()
                with self.assertRaises(create_vivary.ScaffoldError):
                    self.apply()
                with self.assertRaises(create_vivary.ScaffoldError):
                    create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'])
                self.assertEqual(self.snapshot(), before)
        self.receipt().write_bytes(original)
        self.assertTrue(self.apply()['replayed'])

    def test_pending_request_can_be_explicitly_rolled_back(self):
        before = {k: v[0] for k, v in self.snapshot().items()}
        with self.assertRaises(KeyboardInterrupt):
            self.apply(_crash_after=2)
        interrupted = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            self.apply()
        self.assertEqual(self.snapshot(), interrupted)
        recovery = create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'])
        self.assertFalse(recovery['recovered'])
        self.assertEqual(self.snapshot(), interrupted)
        result = create_vivary.adopt_workspace(self.target, recover_hash=self.plan['plan_hash'],
                                               yes=True, plan_hash=recovery['recovery_plan_hash'])
        self.assertTrue(result['recovered'])
        self.assertEqual({k: v[0] for k, v in self.snapshot().items()}, before)
        retry_plan = create_vivary.plan_adopt(self.target, preset='coding')
        self.assertTrue(self.apply(plan_hash=retry_plan['plan_hash'])['applied'])

    def test_opt_in_noop_refuses_before_effects_and_legacy_noop_still_works(self):
        self.apply()
        noop = create_vivary.plan_adopt(self.target, preset='coding')
        before = self.snapshot()
        with self.assertRaises(create_vivary.ScaffoldError):
            self.apply(request_id='noop-request', plan_hash=noop['plan_hash'])
        self.assertEqual(self.snapshot(), before)
        legacy = create_vivary.adopt_workspace(self.target, preset='coding', yes=True,
                                               plan_hash=noop['plan_hash'])
        self.assertTrue(legacy['applied'])
        self.assertNotIn('replayed', legacy)
        self.assertEqual(self.snapshot(), before)

    @unittest.skipUnless(os.name == 'posix', 'POSIX FIFO and symlink checks')
    def test_fifo_or_symlink_receipt_refuses_promptly_without_following(self):
        self.apply()
        receipt = self.receipt()
        original = receipt.read_bytes()
        receipt.unlink()
        outside = self.target / 'outside-receipt.json'
        outside.write_bytes(original)
        receipt.symlink_to(outside)
        with self.assertRaises(create_vivary.ScaffoldError):
            self.apply()
        self.assertEqual(outside.read_bytes(), original)
        receipt.unlink()
        os.mkfifo(receipt)
        command = [sys.executable, str(PKG / 'create_vivary.py'), 'adopt', str(self.target),
                   '--preset', 'coding', '--yes', '--plan', self.plan['plan_hash'],
                   '--request-id', self.request_id, '--json']
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual(outside.read_bytes(), original)
        receipt.unlink()


if __name__ == "__main__":
    unittest.main()
