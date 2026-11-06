"""Real filesystem proof for durable records with live-only identity custody."""
from __future__ import annotations

import json
import os
from pathlib import Path
import pickle
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from test_support import UNPRIVILEGED_POSIX_REASON, unprivileged_posix  # noqa: E402

from vivary_core.physical_observe import CaptureLimits, ObservationFailure
from vivary_core.root_identity_lifecycle import (
    IdentityStateError, LiveRootIdentity, RootIdentityLifecycle, linux_mount_epoch,
)
from test_physical_observe import tree_state


CHILD = """
import json, sys
from pathlib import Path
from vivary_core.root_identity_lifecycle import RootIdentityLifecycle, IdentityStateError
try:
    with RootIdentityLifecycle(device_id='device-proof', scope=Path(sys.argv[1]),
            locations={'root': Path(sys.argv[2])}, state_path=Path(sys.argv[3])) as owner:
        result = owner.inspect(sys.argv[4], location_ref='root')
        enrolled = owner.enroll('root')
        print(json.dumps({'inspect': result.code, 'enroll': enrolled.code,
                          'reason': result.reason}))
except IdentityStateError as error:
    print(json.dumps({'error': error.reason}))
"""


@unittest.skipUnless(sys.platform == "linux", "Linux descriptor-custody lifecycle proof only")
class IdentityLifecycleTests(unittest.TestCase):
    def setUp(self):
        proof_root = os.environ.get("VIVARY_ROOT_IDENTITY_PROOF_ROOT")
        if proof_root is not None and not Path(proof_root).is_absolute():
            self.fail("VIVARY_ROOT_IDENTITY_PROOF_ROOT must be absolute when set")
        self.temporary = tempfile.TemporaryDirectory(prefix="case-", dir=proof_root)
        self.base = Path(self.temporary.name)
        self.scope = self.base / "projects"
        self.scope.mkdir()
        self.root = self.scope / "root"
        self.root.mkdir()
        (self.root / "note.txt").write_text("owned fixture bytes\n", encoding="utf8")
        self.state_dir = self.base / "state"
        self.state_dir.mkdir()
        self.state = self.state_dir / "root-identities.json"
        self.owners = []

    def tearDown(self):
        for owner in self.owners:
            owner.close()
        self.state_dir.chmod(0o700)
        self.temporary.cleanup()

    def owner(self, **changes):
        args = dict(device_id="device-proof", scope=self.scope,
                    locations={"root": self.root}, state_path=self.state)
        args.update(changes)
        owner = RootIdentityLifecycle(**args)
        self.owners.append(owner)
        return owner

    def child(self, root_id):
        result = subprocess.run([sys.executable, "-B", "-c", CHILD,
            str(self.scope), str(self.root), str(self.state), root_id],
            env={"PATH": os.defpath, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
            capture_output=True, text=True, check=True, timeout=15)
        return json.loads(result.stdout)

    def during_next_file_sync(self, callback):
        original = os.fsync
        called = False

        def sync(fd):
            nonlocal called
            original(fd)
            if not called and stat.S_ISREG(os.fstat(fd).st_mode):
                called = True
                callback()

        return patch("vivary_core.root_identity_lifecycle.os.fsync", side_effect=sync)

    def test_enroll_persists_record_but_never_physical_or_verification_authority(self):
        before = tree_state(self.scope)
        owner = self.owner()
        live = owner.enroll("root")
        self.assertIsInstance(live, LiveRootIdentity)
        self.assertEqual(live.verification, "verified-current-custody")
        self.assertFalse(live.mutation_authorized)
        with self.assertRaises(TypeError):
            pickle.dumps(live)
        saved = json.loads(self.state.read_text())
        self.assertEqual(saved["schema"], "vivary.application-root-records/v2")
        self.assertEqual(saved["verification"], "unavailable-without-live-custody")
        self.assertEqual(saved["records"], [{
            "root_id": live.root_id,
            "location_refs": ["root"],
            "vcs": {"kind": "none", "repository_id": None, "checkout_id": None},
        }])
        self.assertEqual(set(saved), {"schema", "device_id", "revision", "verification", "records"})
        self.assertEqual(tree_state(self.scope), before)
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").root_id, live.root_id)

    def test_rename_and_content_change_preserve_live_application_identity(self):
        owner = self.owner()
        live = owner.enroll("root")
        moved = self.scope / "renamed"
        self.root.rename(moved)
        owner.update_locations({"root": moved})
        after_move = tree_state(self.scope)
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").root_id, live.root_id)
        self.assertEqual(tree_state(self.scope), after_move)
        (moved / "note.txt").write_text("external content edit\n", encoding="utf8")
        after_edit = tree_state(self.scope)
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").root_id, live.root_id)
        self.assertEqual(tree_state(self.scope), after_edit)

    def test_path_alias_enrollment_reuses_one_record(self):
        alias = self.scope / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        owner = self.owner(locations={"root": self.root, "alias": alias})
        first = owner.enroll("root")
        second = owner.enroll("alias")
        self.assertEqual(first.root_id, second.root_id)
        records = json.loads(self.state.read_text())["records"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["location_refs"], ["alias", "root"])
        self.assertEqual(owner.enroll("alias").root_id, first.root_id)

    def test_delete_recreate_refuses_without_replacing_the_record(self):
        owner = self.owner()
        live = owner.enroll("root")
        saved = self.state.read_bytes()
        shutil.rmtree(self.root)
        self.root.mkdir()
        (self.root / "note.txt").write_text("owned fixture bytes\n", encoding="utf8")
        before = tree_state(self.scope)
        result = owner.inspect(live.root_id, location_ref="root")
        self.assertIsInstance(result, ObservationFailure)
        self.assertEqual(result.code, "identity-unverified")
        self.assertEqual(owner.enroll("root").code, "identity-unverified")
        self.assertEqual(self.state.read_bytes(), saved)
        self.assertEqual(tree_state(self.scope), before)

    def test_new_process_cannot_reopen_custody_or_implicitly_reattach(self):
        owner = self.owner()
        live = owner.enroll("root")
        saved = self.state.read_bytes()
        owner.close()
        result = self.child(live.root_id)
        self.assertEqual(result, {"inspect": "identity-unverified", "enroll": "identity-unverified",
                                  "reason": "identity-reconciliation-required"})
        self.assertEqual(self.state.read_bytes(), saved)

    def test_copied_root_and_imported_record_do_not_reestablish_identity(self):
        owner = self.owner()
        live = owner.enroll("root")
        copied = self.scope / "copy"
        shutil.copytree(self.root, copied)
        imported = self.state_dir / "imported.json"
        shutil.copy2(self.state, imported)
        restored = self.owner(state_path=imported, locations={"root": copied})
        self.assertEqual(restored.inspect(live.root_id, location_ref="root").code, "identity-unverified")
        self.assertEqual(restored.enroll("root").reason, "identity-reconciliation-required")
        self.assertEqual(json.loads(imported.read_text())["records"][0]["root_id"], live.root_id)

    def test_restored_stale_state_permanently_invalidates_current_owner(self):
        other = self.scope / "other"
        other.mkdir()
        owner = self.owner(locations={"root": self.root, "other": other})
        live = owner.enroll("root")
        old = self.state.read_bytes()
        owner.enroll("other")
        newest = self.state.read_bytes()
        replacement = self.state_dir / "restored.json"
        replacement.write_bytes(old)
        replacement.replace(self.state)
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-state-changed")
        self.state.write_bytes(newest)
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-state-changed")
        self.assertEqual(self.state.read_bytes(), newest)

    def test_same_bytes_replaced_file_does_not_restore_custody(self):
        owner = self.owner()
        live = owner.enroll("root")
        replacement = self.state_dir / "same.json"
        replacement.write_bytes(self.state.read_bytes())
        replacement.replace(self.state)
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-state-changed")

    def test_mount_epoch_uncertainty_is_permanent_without_remounting(self):
        actual = linux_mount_epoch()
        self.assertIsInstance(actual, str)
        epoch = [actual]
        owner = self.owner(epoch_reader=lambda: epoch[0])
        live = owner.enroll("root")
        saved = self.state.read_bytes()
        epoch[0] = actual + "-simulated-new-mount-epoch"
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-epoch-changed")
        epoch[0] = actual
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-epoch-changed")
        self.assertEqual(self.state.read_bytes(), saved)

    def test_unavailable_epoch_cannot_enroll_or_recover(self):
        epoch = [linux_mount_epoch()]
        owner = self.owner(epoch_reader=lambda: epoch[0])
        live = owner.enroll("root")
        epoch[0] = None
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-epoch-unavailable")
        self.assertEqual(owner.enroll("root").code, "identity-unverified")

    def test_cross_process_writer_lock_prevents_second_live_owner(self):
        owner = self.owner()
        live = owner.enroll("root")
        self.assertEqual(self.child(live.root_id), {"error": "identity-owner-already-active"})
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").root_id, live.root_id)

    def test_malformed_duplicate_oversized_or_foreign_import_is_refused(self):
        owner = self.owner()
        owner.enroll("root")
        owner.close()
        valid = self.state.read_text()
        record = json.loads(valid)
        variants = ["{bad", valid.replace('"revision": 1', '"revision": 1, "revision": 1'),
                    valid.replace('"device-proof"', '"foreign-device"'),
                    " " * 65537, json.dumps({**record, "extra": True}),
                    json.dumps({**record, "records": record["records"] * 17}),
                    "[" * 2000 + "]" * 2000]
        for raw in variants:
            with self.subTest(length=len(raw)):
                self.state.write_text(raw)
                with self.assertRaises(IdentityStateError):
                    self.owner()
                self.assertEqual(self.state.read_text(), raw)
        self.state.write_text(valid)
        # Every failed importer released its writer lock and held file handles.
        reopened = self.owner()
        self.assertEqual(reopened.enroll("root").reason, "identity-reconciliation-required")

    def test_state_and_lock_symlinks_are_not_followed(self):
        target = self.state_dir / "target.json"
        target.write_text("preserve")
        self.state.symlink_to(target)
        with self.assertRaises(IdentityStateError):
            self.owner()
        self.assertEqual(target.read_text(), "preserve")
        self.state.unlink()
        lock = self.state.with_name(self.state.name + ".lock")
        if lock.exists():
            lock.unlink()
        lock.symlink_to(target)
        with self.assertRaises(IdentityStateError):
            self.owner()
        self.assertEqual(target.read_text(), "preserve")

    def test_private_state_must_remain_outside_project_scope(self):
        before = tree_state(self.scope)
        with self.assertRaises(IdentityStateError):
            self.owner(state_path=self.root / "identity.json")
        self.assertEqual(tree_state(self.scope), before)

    @unittest.skipUnless(unprivileged_posix(), UNPRIVILEGED_POSIX_REASON)
    def test_real_record_write_failure_does_not_issue_verified_identity(self):
        owner = self.owner()
        before = tree_state(self.scope)
        self.state_dir.chmod(0o500)
        try:
            self.assertEqual(owner.enroll("root").reason, "identity-record-write-failed")
            self.assertFalse(self.state.exists())
        finally:
            self.state_dir.chmod(0o700)
        self.assertEqual(tree_state(self.scope), before)

    def test_fifo_import_is_refused_without_waiting_for_a_writer(self):
        os.mkfifo(self.state)
        result = self.child("root_" + "0" * 32)
        self.assertEqual(result, {"error": "identity-record-invalid"})

    def test_root_replaced_during_metadata_commit_never_returns_verified(self):
        owner = self.owner()
        save = owner._save

        def external_replacement(records):
            result = save(records)
            shutil.rmtree(self.root)
            self.root.mkdir()
            (self.root / "note.txt").write_text("replacement after commit\n", encoding="utf8")
            return result

        with patch.object(owner, "_save", side_effect=external_replacement):
            result = owner.enroll("root")
        self.assertEqual(result.reason, "root-incarnation-changed")
        saved = self.state.read_bytes()
        self.assertEqual(len(json.loads(saved)["records"]), 1)
        self.assertEqual(owner.enroll("root").code, "identity-unverified")
        self.assertEqual(self.state.read_bytes(), saved)

    def test_writer_lock_replacement_invalidates_owner(self):
        owner = self.owner()
        live = owner.enroll("root")
        lock = self.state.with_name(self.state.name + ".lock")
        lock.unlink()
        lock.write_text("")
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-state-changed")

    def test_private_directory_replacement_invalidates_owner(self):
        owner = self.owner()
        live = owner.enroll("root")
        old = self.base / "old-state"
        self.state_dir.rename(old)
        self.state_dir.mkdir()
        shutil.copy2(old / self.state.name, self.state)
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-state-changed")

    def test_alias_history_limit_refuses_without_corrupting_saved_record(self):
        owner = self.owner(limits=CaptureLimits(max_roots=1))
        owner.enroll("root")
        saved = self.state.read_bytes()
        owner.update_locations({"alias": self.root})
        self.assertEqual(owner.enroll("alias").reason, "identity-record-limit")
        self.assertEqual(self.state.read_bytes(), saved)

    def test_in_place_state_tampering_preserves_records_and_refuses_verification(self):
        owner = self.owner()
        live = owner.enroll("root")
        raw = self.state.read_bytes()
        self.state.write_bytes(raw + b" ")
        self.assertEqual(owner.inspect(live.root_id, location_ref="root").reason, "identity-state-changed")
        self.assertEqual(self.state.read_bytes(), raw + b" ")

    @unittest.skipUnless(unprivileged_posix(), UNPRIVILEGED_POSIX_REASON)
    def test_chmod_after_temp_write_returns_refusal_and_names_orphan(self):
        owner = self.owner()
        before = tree_state(self.scope)
        try:
            with self.during_next_file_sync(lambda: self.state_dir.chmod(0o500)):
                result = owner.enroll("root")
            self.assertEqual(result.reason, "identity-record-write-failed")
            self.assertFalse(self.state.exists())
            self.assertEqual(len(owner.pending_cleanup), 1)
            orphan = self.state_dir / owner.pending_cleanup[0]
            self.assertEqual(orphan.parent, self.state_dir)
            self.assertTrue(orphan.is_file())
            self.assertEqual(json.loads(orphan.read_text())["verification"],
                             "unavailable-without-live-custody")
        finally:
            self.state_dir.chmod(0o700)
        self.assertEqual(tree_state(self.scope), before)

    def test_state_change_during_temp_sync_is_not_overwritten(self):
        other = self.scope / "other"
        other.mkdir()
        owner = self.owner(locations={"root": self.root, "other": other})
        owner.enroll("root")
        changed = self.state.read_bytes() + b" "
        with self.during_next_file_sync(lambda: self.state.write_bytes(changed)):
            result = owner.enroll("other")
        self.assertEqual(result.reason, "identity-state-changed")
        self.assertEqual(self.state.read_bytes(), changed)
        self.assertEqual(owner.pending_cleanup, ())

    def test_lock_change_during_temp_sync_prevents_commit(self):
        owner = self.owner()
        lock = self.state.with_name(self.state.name + ".lock")

        def replace_lock():
            lock.unlink()
            lock.write_text("")

        with self.during_next_file_sync(replace_lock):
            result = owner.enroll("root")
        self.assertEqual(result.reason, "identity-state-changed")
        self.assertFalse(self.state.exists())
        self.assertEqual(owner.pending_cleanup, ())


if __name__ == "__main__":
    unittest.main()
