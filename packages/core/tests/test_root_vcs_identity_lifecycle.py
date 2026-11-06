"""Linux fixtures for durable VCS references under current lifecycle custody."""
from __future__ import annotations

from dataclasses import replace
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from test_support import UNPRIVILEGED_POSIX_REASON, unprivileged_posix  # noqa: E402

from vivary_core.physical_observe import CaptureLimits, ObservationFailure
from vivary_core.root_identity_lifecycle import (
    IdentityStateError, LiveRootIdentity, RootIdentityLifecycle,
)
from test_physical_observe import tree_state


V1 = "vivary.application-root-records/v1"
V2 = "vivary.application-root-records/v2"
UNAVAILABLE = "unavailable-without-live-custody"


@unittest.skipUnless(sys.platform == "linux", "Linux VCS custody proof only")
class RootVcsIdentityLifecycleTests(unittest.TestCase):
    def setUp(self):
        proof_root = os.environ.get("VIVARY_ROOT_IDENTITY_PROOF_ROOT")
        if proof_root is not None and not Path(proof_root).is_absolute():
            self.fail("VIVARY_ROOT_IDENTITY_PROOF_ROOT must be absolute when set")
        if not shutil.which("git"):
            self.fail("The installed Git binary is required for this proof")
        self.temporary = tempfile.TemporaryDirectory(
            prefix="vcs-case-", dir=proof_root,
        )
        self.base = Path(self.temporary.name)
        self.scope = self.base / "projects"
        self.scope.mkdir()
        self.root = self.scope / "root"
        self.root.mkdir()
        (self.root / "note.txt").write_text("equal fixture bytes\n", encoding="utf8")
        self.state_dir = self.base / "private"
        self.state_dir.mkdir()
        self.state = self.state_dir / "root-identities.json"
        self.git_home = self.base / "git-home"
        self.git_home.mkdir()
        self.git_config = self.git_home / "global-config"
        self.git_config.write_text("", encoding="utf8")
        self.git_hooks = self.git_home / "hooks"
        self.git_hooks.mkdir()
        self.git_templates = self.git_home / "templates"
        self.git_templates.mkdir()
        self.owners = []

    def tearDown(self):
        try:
            for owner in self.owners:
                owner.close()
        finally:
            self.state_dir.chmod(0o700)
            self.temporary.cleanup()

    def owner(self, locations=None, state=None, **changes):
        args = dict(
            device_id="device-vcs-proof",
            scope=self.scope,
            locations=locations or {"root": self.root},
            state_path=state or self.state,
        )
        args.update(changes)
        owner = RootIdentityLifecycle(**args)
        self.owners.append(owner)
        return owner

    def git(self, cwd, *args):
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(self.git_home),
            "XDG_CONFIG_HOME": str(self.git_home),
            "GIT_CONFIG_GLOBAL": str(self.git_config),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_TEMPLATE_DIR": str(self.git_templates),
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": "/bin/false",
            "SSH_ASKPASS": "/bin/false",
            "GIT_AUTHOR_NAME": "Vivary fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Vivary fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        }
        command = [
            "git",
            "-c", f"core.hooksPath={self.git_hooks}",
            "-c", "credential.helper=",
            "-c", "commit.gpgSign=false",
            "-c", "tag.gpgSign=false",
            "-C", str(cwd),
            *args,
        ]
        result = subprocess.run(
            command,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLessEqual(len(result.stdout.encode()), 1024 * 1024)
        self.assertLessEqual(len(result.stderr.encode()), 1024 * 1024)
        return result.stdout.strip()

    def repository(self, root=None):
        root = root or self.root
        self.git(root, "init", "-b", "main")
        self.git(root, "add", ".")
        self.git(root, "commit", "-m", "fixture")
        return root

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

    def lifecycle(self, operation):
        """Run one lifecycle call and check that project and Git files stay unchanged."""
        before = tree_state(self.scope)
        try:
            return operation()
        finally:
            self.assertEqual(tree_state(self.scope), before)

    def expected_project_git_change(self, operation):
        before = tree_state(self.scope)
        try:
            return operation()
        finally:
            self.assertNotEqual(tree_state(self.scope), before)

    def v1_state(self, *, revision=7, root_id=None, location="root"):
        return {
            "schema": V1,
            "device_id": "device-vcs-proof",
            "revision": revision,
            "verification": UNAVAILABLE,
            "records": [{
                "root_id": root_id or "root_" + "1" * 32,
                "location_refs": [location],
            }],
        }

    def test_no_vcs_enrollment_writes_exact_v2_null_shape(self):
        before = tree_state(self.scope)
        owner = self.owner()
        live = self.lifecycle(lambda: owner.enroll("root"))
        self.assertIsInstance(live, LiveRootIdentity)
        self.assertIsNone(live.repository_id)
        self.assertIsNone(live.checkout_id)
        self.assertIsNone(live.mutation_owner)
        self.assertFalse(live.mutation_authorized)
        saved = json.loads(self.state.read_text())
        self.assertEqual(set(saved), {
            "schema", "device_id", "revision", "verification", "records",
        })
        self.assertEqual(saved["schema"], V2)
        self.assertEqual(saved["verification"], UNAVAILABLE)
        self.assertEqual(saved["records"], [{
            "root_id": live.root_id,
            "location_refs": ["root"],
            "vcs": {"kind": "none", "repository_id": None, "checkout_id": None},
        }])
        self.assertEqual(tree_state(self.scope), before)

    def test_git_enrollment_persists_application_ids_and_returns_them_live(self):
        self.repository()
        before = tree_state(self.scope)
        owner = self.owner()
        live = self.lifecycle(lambda: owner.enroll("root"))
        self.assertRegex(live.root_id, r"root_[0-9a-f]{32}\Z")
        self.assertRegex(live.repository_id, r"repo_[0-9a-f]{32}\Z")
        self.assertRegex(live.checkout_id, r"checkout_[0-9a-f]{32}\Z")
        self.assertEqual(live.mutation_owner, "git")
        self.assertFalse(live.mutation_authorized)
        current = self.lifecycle(
            lambda: owner.inspect(live.root_id, location_ref="root"),
        )
        available = self.lifecycle(lambda: owner.inspect_location("root"))
        for result in (current, available):
            self.assertEqual(result.root_id, live.root_id)
            self.assertEqual(result.repository_id, live.repository_id)
            self.assertEqual(result.checkout_id, live.checkout_id)
            self.assertEqual(result.mutation_owner, "git")
            self.assertFalse(result.mutation_authorized)
        record = json.loads(self.state.read_text())["records"][0]
        self.assertEqual(record["vcs"], {
            "kind": "git",
            "repository_id": live.repository_id,
            "checkout_id": live.checkout_id,
        })
        self.assertFalse({
            "observer_lifetime", "physical_path", "physical_root_id",
            "mutation_owner", "capture_id", "resource_keys",
        }.intersection(record))
        self.assertEqual(tree_state(self.scope), before)

    def test_alias_and_nested_roots_reuse_only_their_live_domains(self):
        self.repository()
        left = self.root / "left"
        right = self.root / "right"
        left.mkdir()
        right.mkdir()
        alias = self.scope / "left-alias"
        alias.symlink_to(left, target_is_directory=True)
        owner = self.owner(locations={
            "right": right, "alias": alias, "root": self.root, "left": left,
        })
        right_live = self.lifecycle(lambda: owner.enroll("right"))
        root_live = self.lifecycle(lambda: owner.enroll("root"))
        left_live = self.lifecycle(lambda: owner.enroll("left"))
        alias_live = self.lifecycle(lambda: owner.enroll("alias"))
        self.assertEqual(alias_live.root_id, left_live.root_id)
        self.assertEqual(len({
            right_live.root_id, root_live.root_id, left_live.root_id,
        }), 3)
        for item in (root_live, left_live, right_live, alias_live):
            self.assertEqual(item.repository_id, root_live.repository_id)
            self.assertEqual(item.checkout_id, root_live.checkout_id)
        saved = json.loads(self.state.read_text())
        self.assertEqual(len(saved["records"]), 3)
        left_record = next(row for row in saved["records"]
                           if row["root_id"] == left_live.root_id)
        self.assertEqual(left_record["location_refs"], ["alias", "left"])

    def test_linked_worktree_and_equal_repository_keep_correct_boundaries(self):
        self.repository()
        linked = self.scope / "linked"
        self.git(self.root, "worktree", "add", "-b", "linked", str(linked))
        separate = self.scope / "separate"
        separate.mkdir()
        (separate / "note.txt").write_text("equal fixture bytes\n", encoding="utf8")
        self.repository(separate)
        owner = self.owner(locations={
            "root": self.root, "linked": linked, "separate": separate,
        })
        main = self.lifecycle(lambda: owner.enroll("root"))
        other_checkout = self.lifecycle(lambda: owner.enroll("linked"))
        other_repository = self.lifecycle(lambda: owner.enroll("separate"))
        self.assertEqual(main.repository_id, other_checkout.repository_id)
        self.assertNotEqual(main.checkout_id, other_checkout.checkout_id)
        self.assertNotEqual(main.repository_id, other_repository.repository_id)
        self.assertNotEqual(main.checkout_id, other_repository.checkout_id)

    def test_rename_content_dirty_and_detached_state_preserve_ids(self):
        self.repository()
        owner = self.owner()
        first = self.lifecycle(lambda: owner.enroll("root"))
        moved = self.scope / "moved"
        self.root.rename(moved)
        self.lifecycle(lambda: owner.update_locations({"root": moved}))
        renamed = self.lifecycle(
            lambda: owner.inspect(first.root_id, location_ref="root"),
        )
        (moved / "note.txt").write_text("dirty content\n", encoding="utf8")
        dirty = self.lifecycle(
            lambda: owner.inspect(first.root_id, location_ref="root"),
        )
        self.git(moved, "checkout", "--detach", "HEAD")
        detached = self.lifecycle(
            lambda: owner.inspect(first.root_id, location_ref="root"),
        )
        for result in (renamed, dirty, detached):
            self.assertEqual(result.root_id, first.root_id)
            self.assertEqual(result.repository_id, first.repository_id)
            self.assertEqual(result.checkout_id, first.checkout_id)
            self.assertEqual(result.mutation_owner, "git")
            self.assertFalse(result.mutation_authorized)

    def test_common_administration_replacement_invalidates_vcs_custody(self):
        self.repository()
        owner = self.owner()
        live = self.lifecycle(lambda: owner.enroll("root"))
        saved = self.state.read_bytes()
        old = self.scope / "old-common-administration"
        (self.root / ".git").rename(old)
        shutil.copytree(old, self.root / ".git")
        result = self.lifecycle(
            lambda: owner.inspect(live.root_id, location_ref="root"),
        )
        self.assertEqual(result.reason, "vcs-incarnation-changed")
        self.assertEqual(self.state.read_bytes(), saved)

    def test_private_administration_replacement_invalidates_linked_checkout(self):
        self.repository()
        linked = self.scope / "linked"
        self.git(self.root, "worktree", "add", "-b", "linked", str(linked))
        owner = self.owner(locations={"linked": linked})
        live = self.lifecycle(lambda: owner.enroll("linked"))
        private = Path(self.git(linked, "rev-parse", "--absolute-git-dir"))
        old = self.scope / "old-private-administration"
        private.rename(old)
        shutil.copytree(old, private)
        result = self.lifecycle(
            lambda: owner.inspect(live.root_id, location_ref="linked"),
        )
        self.assertEqual(result.reason, "vcs-incarnation-changed")

    def test_no_vcs_and_git_transitions_invalidate_instead_of_adopting(self):
        plain = self.scope / "plain"
        plain.mkdir()
        (plain / "note.txt").write_text("plain\n", encoding="utf8")
        git_root = self.repository()
        state_plain = self.state_dir / "plain.json"
        state_git = self.state_dir / "git.json"
        plain_owner = self.owner(locations={"plain": plain}, state=state_plain)
        plain_live = self.lifecycle(lambda: plain_owner.enroll("plain"))
        self.repository(plain)
        self.assertEqual(
            self.lifecycle(
                lambda: plain_owner.inspect(plain_live.root_id, location_ref="plain"),
            ).reason,
            "vcs-incarnation-changed",
        )
        git_owner = self.owner(locations={"git": git_root}, state=state_git)
        git_live = self.lifecycle(lambda: git_owner.enroll("git"))
        (git_root / ".git").rename(self.scope / "removed-git-administration")
        self.assertEqual(
            self.lifecycle(
                lambda: git_owner.inspect(git_live.root_id, location_ref="git"),
            ).reason,
            "vcs-incarnation-changed",
        )

    def test_replacement_after_metadata_commit_returns_no_verified_identity(self):
        self.repository()
        owner = self.owner()
        save = owner._save

        def replace_after_save(records):
            result = save(records)
            old = self.scope / "commit-old-administration"
            (self.root / ".git").rename(old)
            shutil.copytree(old, self.root / ".git")
            return result

        with patch.object(owner, "_save", side_effect=replace_after_save):
            result = self.expected_project_git_change(
                lambda: owner.enroll("root"),
            )
        self.assertIsInstance(result, ObservationFailure)
        self.assertEqual(result.reason, "vcs-incarnation-changed")
        self.assertEqual(len(json.loads(self.state.read_text())["records"]), 1)
        self.assertEqual(
            self.lifecycle(lambda: owner.enroll("root")).code,
            "identity-unverified",
        )

    def test_injected_uuid_and_live_graph_conflicts_commit_nothing(self):
        self.repository()
        nested = self.root / "nested"
        nested.mkdir()
        other = self.scope / "other"
        other.mkdir()
        (other / "note.txt").write_text("other\n", encoding="utf8")
        owner = self.owner(locations={
            "root": self.root, "nested": nested, "other": other,
        })
        first = self.lifecycle(lambda: owner.enroll("root"))
        before_collision = self.state.read_bytes()
        fixed = SimpleNamespace(hex=first.root_id.removeprefix("root_"))
        with patch("vivary_core.root_identity_lifecycle.uuid4", return_value=fixed):
            collision = self.lifecycle(lambda: owner.enroll("other"))
        self.assertEqual(collision.reason, "identity-allocation-conflict")
        self.assertEqual(self.state.read_bytes(), before_collision)

        overflow_state = self.state_dir / "overflow.json"
        overflow_owner = self.owner(
            locations={"root": self.root},
            state=overflow_state,
            limits=CaptureLimits(max_roots=1),
        )
        self.lifecycle(lambda: overflow_owner.enroll("root"))
        self.lifecycle(lambda: overflow_owner.update_locations({"other": other}))
        before_overflow = overflow_state.read_bytes()
        overflow = self.lifecycle(lambda: overflow_owner.enroll("other"))
        self.assertEqual(overflow.reason, "identity-record-limit")
        self.assertEqual(overflow_state.read_bytes(), before_overflow)

        conflict_state = self.state_dir / "conflict.json"
        conflict_owner = self.owner(
            locations={"root": self.root, "nested": nested},
            state=conflict_state,
        )
        parent = self.lifecycle(lambda: conflict_owner.enroll("root"))
        child = self.lifecycle(lambda: conflict_owner.enroll("nested"))
        before_conflict = conflict_state.read_bytes()
        record = conflict_owner._records[child.root_id]
        conflict_owner._records[child.root_id] = replace(
            record,
            vcs=replace(record.vcs, repository_id="repo_" + "f" * 32),
        )
        conflict = self.lifecycle(
            lambda: conflict_owner.inspect(parent.root_id, location_ref="root"),
        )
        self.assertEqual(conflict.reason, "identity-live-mapping-conflict")
        self.assertEqual(conflict_state.read_bytes(), before_conflict)

    def test_restart_copy_and_read_only_unenrolled_root_keep_ids_inert(self):
        self.repository()
        nested = self.root / "nested"
        nested.mkdir()
        alias = self.scope / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        owner = self.owner(locations={
            "root": self.root, "nested": nested, "alias": alias,
        })
        live = self.lifecycle(lambda: owner.enroll("root"))
        saved = self.state.read_bytes()
        with patch.object(
                owner, "_allocate_application_id",
                side_effect=AssertionError("read-only inspection allocated an ID")):
            alias_view = self.lifecycle(lambda: owner.inspect_location("alias"))
            nested_view = self.lifecycle(lambda: owner.inspect_location("nested"))
        self.assertEqual(alias_view.root_id, live.root_id)
        self.assertEqual(alias_view.repository_id, live.repository_id)
        self.assertIsNone(nested_view.root_id)
        self.assertIsNone(nested_view.repository_id)
        self.assertIsNone(nested_view.checkout_id)
        self.assertIsNone(nested_view.mutation_owner)
        self.assertFalse(nested_view.mutation_authorized)
        self.assertEqual(self.state.read_bytes(), saved)
        self.assertNotIn("alias", self.state.read_text())

        native_observe = owner._observer.observe

        def observe_from_foreign_lifetime():
            captures = native_observe()
            return {
                location: capture if isinstance(capture, ObservationFailure) else replace(
                    capture, observer_lifetime="foreign-observer-lifetime",
                )
                for location, capture in captures.items()
            }

        with self.subTest(
                "branch-only foreign observer lifetime injection; not physical remount proof"), patch.object(
                owner._observer, "observe", side_effect=observe_from_foreign_lifetime):
            foreign = self.lifecycle(
                lambda: owner.inspect(live.root_id, location_ref="root"),
            )
        self.assertEqual(foreign.reason, "observer-continuity-changed")
        self.assertEqual(self.state.read_bytes(), saved)
        refused_again = self.lifecycle(
            lambda: owner.inspect(live.root_id, location_ref="root"),
        )
        self.assertEqual(refused_again.reason, "observer-continuity-changed")
        self.assertEqual(self.state.read_bytes(), saved)
        unchanged_record = json.loads(self.state.read_text())["records"][0]
        self.assertEqual(
            (unchanged_record["root_id"], unchanged_record["vcs"]["repository_id"],
             unchanged_record["vcs"]["checkout_id"]),
            (live.root_id, live.repository_id, live.checkout_id),
        )
        owner.close()
        restarted = self.owner(locations={"root": self.root})
        self.assertEqual(
            self.lifecycle(
                lambda: restarted.inspect(live.root_id, location_ref="root"),
            ).reason,
            "identity-reconciliation-required",
        )
        copied = self.state_dir / "copied.json"
        copied.write_bytes(saved)
        copied_owner = self.owner(locations={"root": self.root}, state=copied)
        self.assertEqual(
            self.lifecycle(lambda: copied_owner.enroll("root")).reason,
            "identity-reconciliation-required",
        )
        self.assertEqual(json.loads(copied.read_text())["records"][0]["vcs"], {
            "kind": "git",
            "repository_id": live.repository_id,
            "checkout_id": live.checkout_id,
        })

    def test_explicit_v1_migration_is_inert_and_repeatable(self):
        legacy = self.v1_state()
        legacy["records"][0]["location_refs"] = ["zeta", "alpha"]
        self.state.write_text(json.dumps(legacy, indent=2) + "\n", encoding="utf8")
        owner = self.owner(locations={"zeta": self.root, "alpha": self.root})
        with patch.object(
                owner._observer, "observe",
                side_effect=AssertionError("migration observed a project")), patch.object(
                owner, "_allocate_application_id",
                side_effect=AssertionError("migration allocated an application ID")):
            result = self.lifecycle(
                owner.migrate_legacy_records,
            )
        self.assertEqual(result, {
            "status": "migrated", "schema": V2, "revision": 8,
        })
        migrated = json.loads(self.state.read_text())
        self.assertEqual(migrated, {
            "schema": V2,
            "device_id": legacy["device_id"],
            "revision": 8,
            "verification": UNAVAILABLE,
            "records": [{
                "root_id": legacy["records"][0]["root_id"],
                "location_refs": ["alpha", "zeta"],
                "vcs": {
                    "kind": "unresolved", "repository_id": None, "checkout_id": None,
                },
            }],
        })
        self.assertEqual(
            self.lifecycle(lambda: owner.enroll("zeta")).reason,
            "identity-reconciliation-required",
        )
        before_repeat = self.state.read_bytes()
        self.assertEqual(self.lifecycle(owner.migrate_legacy_records), {
            "status": "already-current", "schema": V2, "revision": 8,
        })
        self.assertEqual(self.state.read_bytes(), before_repeat)

        missing = self.state_dir / "missing.json"
        missing_owner = self.owner(state=missing)
        self.assertEqual(self.lifecycle(missing_owner.migrate_legacy_records), {
            "status": "nothing-to-migrate", "schema": None, "revision": 0,
        })
        self.assertFalse(missing.exists())

    def test_v1_v2_schema_validation_rejects_malformed_identity_graphs(self):
        root_id = "root_" + "1" * 32
        other_root = "root_" + "2" * 32
        repo_a = "repo_" + "a" * 32
        repo_b = "repo_" + "b" * 32
        checkout = "checkout_" + "c" * 32
        valid_v2 = {
            "schema": V2,
            "device_id": "device-vcs-proof",
            "revision": 1,
            "verification": UNAVAILABLE,
            "records": [{
                "root_id": root_id,
                "location_refs": ["root"],
                "vcs": {
                    "kind": "git", "repository_id": repo_a, "checkout_id": checkout,
                },
            }],
        }
        variants = [
            {**self.v1_state(), "schema": "unknown/v9"},
            {**self.v1_state(), "device_id": "foreign-device"},
            {**self.v1_state(), "records": [{
                **self.v1_state()["records"][0],
                "vcs": {"kind": "unresolved", "repository_id": None, "checkout_id": None},
            }]},
            {**valid_v2, "records": [{
                "root_id": root_id, "location_refs": ["root"],
            }]},
            {**valid_v2, "records": [{
                **valid_v2["records"][0],
                "vcs": {"kind": "git", "repository_id": None, "checkout_id": checkout},
            }]},
            {**valid_v2, "records": [{
                **valid_v2["records"][0],
                "vcs": {"kind": "none", "repository_id": repo_a, "checkout_id": None},
            }]},
            {**valid_v2, "records": valid_v2["records"] + [{
                "root_id": other_root,
                "location_refs": ["other"],
                "vcs": {
                    "kind": "git", "repository_id": repo_b, "checkout_id": checkout,
                },
            }]},
            {**valid_v2, "records": valid_v2["records"] * 2},
            {**valid_v2, "records": valid_v2["records"] + [{
                "root_id": other_root,
                "location_refs": ["root"],
                "vcs": {
                    "kind": "git", "repository_id": repo_a,
                    "checkout_id": "checkout_" + "d" * 32,
                },
            }]},
        ]
        raw_variants = [json.dumps(value) for value in variants]
        raw_variants.extend([
            json.dumps(valid_v2).replace('"revision": 1', '"revision": 1, "revision": 1'),
            " " * 65537,
        ])
        for index, raw in enumerate(raw_variants):
            with self.subTest(index=index):
                self.state.write_text(raw, encoding="utf8")
                with self.assertRaises(IdentityStateError):
                    self.owner()
                self.assertEqual(self.state.read_text(encoding="utf8"), raw)

    @unittest.skipUnless(unprivileged_posix(), UNPRIVILEGED_POSIX_REASON)
    def test_migration_write_failure_and_state_change_never_verify(self):
        legacy_raw = json.dumps(self.v1_state(), indent=2) + "\n"
        self.state.write_text(legacy_raw, encoding="utf8")
        owner = self.owner()
        try:
            with self.during_next_file_sync(lambda: self.state_dir.chmod(0o500)):
                failed = self.lifecycle(owner.migrate_legacy_records)
            self.assertEqual(failed.reason, "identity-record-write-failed")
            self.assertEqual(self.state.read_text(), legacy_raw)
            self.assertEqual(len(owner.pending_cleanup), 1)
        finally:
            self.state_dir.chmod(0o700)
        self.assertEqual(
            self.lifecycle(lambda: owner.enroll("root")).code,
            "identity-unverified",
        )

        changed_state = self.state_dir / "changed.json"
        changed_raw = json.dumps(self.v1_state(revision=11), indent=2) + "\n"
        changed_state.write_text(changed_raw, encoding="utf8")
        changed_owner = self.owner(state=changed_state)
        externally_changed = changed_raw + " "
        with self.during_next_file_sync(
                lambda: changed_state.write_text(externally_changed, encoding="utf8")):
            changed = self.lifecycle(changed_owner.migrate_legacy_records)
        self.assertEqual(changed.reason, "identity-state-changed")
        self.assertEqual(changed_state.read_text(encoding="utf8"), externally_changed)
        self.assertEqual(changed_owner.pending_cleanup, ())

        lock_state = self.state_dir / "lock-change.json"
        lock_raw = json.dumps(self.v1_state(revision=13), indent=2) + "\n"
        lock_state.write_text(lock_raw, encoding="utf8")
        lock_owner = self.owner(state=lock_state)
        lock_path = lock_state.with_name(lock_state.name + ".lock")

        def replace_lock():
            lock_path.unlink()
            lock_path.write_text("", encoding="utf8")

        with self.during_next_file_sync(replace_lock):
            lock_changed = self.lifecycle(lock_owner.migrate_legacy_records)
        self.assertEqual(lock_changed.reason, "identity-state-changed")
        self.assertEqual(lock_state.read_text(encoding="utf8"), lock_raw)
        self.assertEqual(lock_owner.pending_cleanup, ())


if __name__ == "__main__":
    unittest.main()
