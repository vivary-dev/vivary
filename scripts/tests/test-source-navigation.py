"""Focused contract tests for the bounded source-navigation graph."""

from __future__ import annotations

import hashlib
import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SOURCE_MAP = REPOSITORY_ROOT / "docs" / "product" / "multi-project" / "source-map"
CHECKER_PATH = REPOSITORY_ROOT / "scripts" / "check-source-navigation.py"


def _load_checker():
    spec = importlib.util.spec_from_file_location("check_source_navigation", CHECKER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load checker: {CHECKER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


checker = _load_checker()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SourceNavigationTests(unittest.TestCase):
    def make_fixture(self) -> tuple[tempfile.TemporaryDirectory[str], Path, Path]:
        temporary = tempfile.TemporaryDirectory(prefix="vivary-source-navigation-")
        repository = Path(temporary.name) / "repository"
        source_map = repository / "docs" / "product" / "multi-project" / "source-map"
        source_map.parent.mkdir(parents=True)
        shutil.copytree(SOURCE_MAP, source_map)

        docs = checker.analyze_source_map(source_map)
        for doc in docs:
            if doc.type != "source_reference":
                continue
            target = repository.joinpath(*doc.fields["locator"].split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"fixture for {doc.derived['id']}\n", encoding="utf-8")
        return temporary, repository, source_map

    def assert_navigation_error(self, repository: Path, source_map: Path, text: str) -> None:
        with self.assertRaisesRegex(checker.NavigationError, text):
            checker.validate_source_navigation(repository, source_map)

    def test_repository_source_map_passes(self) -> None:
        result = checker.validate_source_navigation(REPOSITORY_ROOT, SOURCE_MAP)

        self.assertEqual(result["record_count"], 16)
        self.assertEqual(len(result["nodes"]), 16)
        self.assertEqual(result["broken_edge_count"], 0)

    def test_broken_typed_reference_fails(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        module = source_map / "modules" / "root-observation" / "index.md"
        module.write_text(
            module.read_text(encoding="utf-8").replace(
                "root-observation-contract", "missing-observation-contract"
            ),
            encoding="utf-8",
        )

        self.assert_navigation_error(repository, source_map, "broken reference")

    def test_duplicate_typed_edge_fails_before_set_comparison_can_hide_it(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        module = source_map / "modules" / "root-observation" / "index.md"
        module.write_text(
            module.read_text(encoding="utf-8").replace(
                "contract_refs: [root-observation-contract]",
                "contract_refs: [root-observation-contract, root-observation-contract]",
            ),
            encoding="utf-8",
        )

        self.assert_navigation_error(repository, source_map, "duplicate typed edge")

    def test_duplicate_derived_id_fails_before_node_count_can_hide_it(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        original = source_map / "sources" / "registry-contract.md"
        shutil.copyfile(original, source_map / "sources" / "registry-contract.markdown")

        self.assert_navigation_error(repository, source_map, "duplicate document id 'registry-contract'")

    def test_missing_locator_field_fails(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        record = source_map / "sources" / "native-owners.md"
        lines = [
            line for line in record.read_text(encoding="utf-8").splitlines()
            if not line.startswith("locator:")
        ]
        record.write_text("\n".join(lines) + "\n", encoding="utf-8")

        self.assert_navigation_error(repository, source_map, "missing required field 'locator'")

    def test_missing_locator_target_fails(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        result = checker.validate_source_navigation(repository, source_map)
        target = repository.joinpath(*result["locators"]["native-owners"].split("/"))
        target.unlink()

        self.assert_navigation_error(repository, source_map, "locator target is not an existing file")

    def test_noncanonical_or_escaping_locators_fail(self) -> None:
        bad_locators = (
            "/absolute.md",
            "C:/absolute.md",
            "//server/share/file.md",
            "docs/../outside.md",
            "docs\\outside.md",
            "",
        )
        for locator in bad_locators:
            with self.subTest(locator=locator):
                temporary, repository, source_map = self.make_fixture()
                try:
                    record = source_map / "sources" / "native-owners.md"
                    old = checker.validate_source_navigation(repository, source_map)["locators"]["native-owners"]
                    record.write_text(
                        record.read_text(encoding="utf-8").replace(
                            f"locator: {old}", f"locator: {locator}"
                        ),
                        encoding="utf-8",
                    )
                    self.assert_navigation_error(repository, source_map, "locator")
                finally:
                    temporary.cleanup()

    def test_aliases_of_an_existing_target_are_not_canonical_locators(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        record = source_map / "sources" / "native-owners.md"
        old = checker.validate_source_navigation(repository, source_map)["locators"]["native-owners"]
        aliases = (f"./{old}", old.replace("/", "//", 1))

        for locator in aliases:
            with self.subTest(locator=locator):
                record.write_text(
                    record.read_text(encoding="utf-8").replace(
                        f"locator: {old}", f"locator: {locator}"
                    ),
                    encoding="utf-8",
                )
                try:
                    self.assert_navigation_error(repository, source_map, "locator")
                finally:
                    record.write_text(
                        record.read_text(encoding="utf-8").replace(
                            f"locator: {locator}", f"locator: {old}"
                        ),
                        encoding="utf-8",
                    )

    def test_extra_source_map_entries_fail_exact_inventory(self) -> None:
        additions = (
            ("notes.txt", False),
            ("modules/root-observation/tropo.toml", False),
            ("unexpected-empty-directory", True),
        )
        for relative, is_directory in additions:
            with self.subTest(relative=relative):
                temporary, repository, source_map = self.make_fixture()
                try:
                    extra = source_map.joinpath(*relative.split("/"))
                    if is_directory:
                        extra.mkdir(parents=True)
                    else:
                        extra.parent.mkdir(parents=True, exist_ok=True)
                        extra.write_text("unexpected\n", encoding="utf-8")
                    self.assert_navigation_error(repository, source_map, "tree inventory mismatch")
                finally:
                    temporary.cleanup()

    def test_locator_directory_fails(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        record = source_map / "sources" / "native-owners.md"
        old = checker.validate_source_navigation(repository, source_map)["locators"]["native-owners"]
        directory_locator = "docs/directory-target"
        (repository / "docs" / "directory-target").mkdir(parents=True)
        record.write_text(
            record.read_text(encoding="utf-8").replace(
                f"locator: {old}", f"locator: {directory_locator}"
            ),
            encoding="utf-8",
        )

        self.assert_navigation_error(repository, source_map, "locator target is not an existing file")

    def test_locator_cannot_target_its_own_or_another_source_map_record(self) -> None:
        internal_locators = (
            "docs/product/multi-project/source-map/sources/native-owners.md",
            "docs/product/multi-project/source-map/sources/registry-contract.md",
        )
        for locator in internal_locators:
            with self.subTest(locator=locator):
                temporary, repository, source_map = self.make_fixture()
                try:
                    record = source_map / "sources" / "native-owners.md"
                    old = checker.validate_source_navigation(repository, source_map)["locators"]["native-owners"]
                    record.write_text(
                        record.read_text(encoding="utf-8").replace(
                            f"locator: {old}", f"locator: {locator}"
                        ),
                        encoding="utf-8",
                    )
                    self.assert_navigation_error(repository, source_map, "inside source-map root")
                finally:
                    temporary.cleanup()

    def test_locator_symlink_alias_cannot_resolve_into_source_map(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        link = repository / "docs" / "source-map-record-alias.md"
        try:
            link.symlink_to(source_map / "sources" / "registry-contract.md")
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"file symlink unavailable: {exc}")
        record = source_map / "sources" / "native-owners.md"
        old = checker.validate_source_navigation(repository, source_map)["locators"]["native-owners"]
        record.write_text(
            record.read_text(encoding="utf-8").replace(
                f"locator: {old}", "locator: docs/source-map-record-alias.md"
            ),
            encoding="utf-8",
        )

        self.assert_navigation_error(repository, source_map, "inside source-map root")

    def test_source_map_root_symlink_fails_before_resolution(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        alternate = repository / "alternate" / "source-map"
        alternate.parent.mkdir(parents=True)
        source_map.replace(alternate)
        try:
            source_map.symlink_to(alternate, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"directory symlink unavailable: {exc}")

        self.assert_navigation_error(repository, source_map, "must be a real directory")

    @unittest.skipUnless(os.name == "nt", "directory junctions are Windows-specific")
    def test_source_map_root_junction_fails_before_resolution(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        alternate = repository / "alternate" / "source-map"
        alternate.parent.mkdir(parents=True)
        source_map.replace(alternate)
        created = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(source_map), str(alternate)],
            capture_output=True,
            text=True,
            check=False,
        )
        if created.returncode != 0:
            self.skipTest(f"directory junction unavailable: {created.stderr.strip()}")
        try:
            self.assert_navigation_error(repository, source_map, "must be a real directory")
        finally:
            source_map.rmdir()

    @unittest.skipUnless(os.name == "nt", "directory junctions are Windows-specific")
    def test_source_map_interior_junction_fails_inventory(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        module = source_map / "modules" / "native-runtime"
        alternate = repository / "alternate" / "native-runtime"
        alternate.parent.mkdir(parents=True)
        module.replace(alternate)
        created = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(module), str(alternate)],
            capture_output=True,
            text=True,
            check=False,
        )
        if created.returncode != 0:
            self.skipTest(f"directory junction unavailable: {created.stderr.strip()}")
        try:
            self.assert_navigation_error(repository, source_map, "tree inventory mismatch")
        finally:
            module.rmdir()

    def test_symlink_escape_fails(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        outside = Path(temporary.name) / "outside.md"
        outside.write_text("outside\n", encoding="utf-8")
        link = repository / "docs" / "escaped-link.md"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"file symlink unavailable: {exc}")
        record = source_map / "sources" / "native-owners.md"
        old = checker.validate_source_navigation(repository, source_map)["locators"]["native-owners"]
        record.write_text(
            record.read_text(encoding="utf-8").replace(
                f"locator: {old}", "locator: docs/escaped-link.md"
            ),
            encoding="utf-8",
        )

        self.assert_navigation_error(repository, source_map, "escapes repository root")

    def test_unresolvable_locator_target_fails_cleanly(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        link = repository / "docs" / "loop.md"
        try:
            link.symlink_to(link)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"file symlink unavailable: {exc}")
        record = source_map / "sources" / "native-owners.md"
        old = checker.validate_source_navigation(repository, source_map)["locators"]["native-owners"]
        record.write_text(
            record.read_text(encoding="utf-8").replace(
                f"locator: {old}", "locator: docs/loop.md"
            ),
            encoding="utf-8",
        )

        self.assert_navigation_error(repository, source_map, "could not resolve locator target")

    def test_moved_target_needs_only_locator_update(self) -> None:
        temporary, repository, source_map = self.make_fixture()
        self.addCleanup(temporary.cleanup)
        before = checker.validate_source_navigation(repository, source_map)
        record = source_map / "sources" / "checkout-observer-code.md"
        unchanged_before = {
            path.relative_to(source_map).as_posix(): _sha256(path)
            for path in source_map.rglob("*.md")
            if path != record
        }
        old_locator = before["locators"]["checkout-observer-code"]
        old_target = repository.joinpath(*old_locator.split("/"))
        new_locator = "relocated/workspace-observe.py"
        new_target = repository.joinpath(*new_locator.split("/"))
        new_target.parent.mkdir(parents=True)
        old_target.replace(new_target)
        record.write_text(
            record.read_text(encoding="utf-8").replace(
                f"locator: {old_locator}", f"locator: {new_locator}"
            ),
            encoding="utf-8",
        )

        after = checker.validate_source_navigation(repository, source_map)
        unchanged_after = {
            path.relative_to(source_map).as_posix(): _sha256(path)
            for path in source_map.rglob("*.md")
            if path != record
        }
        incoming_before = {
            (edge["from"], edge["field"], edge["to"])
            for edge in before["edges"]
            if edge["to"] == "checkout-observer-code"
        }
        incoming_after = {
            (edge["from"], edge["field"], edge["to"])
            for edge in after["edges"]
            if edge["to"] == "checkout-observer-code"
        }

        self.assertEqual(unchanged_after, unchanged_before)
        self.assertEqual(after["nodes"]["checkout-observer-code"], before["nodes"]["checkout-observer-code"])
        self.assertEqual(incoming_after, incoming_before)
        self.assertEqual(after["locators"]["checkout-observer-code"], new_locator)


if __name__ == "__main__":
    unittest.main(verbosity=2)
