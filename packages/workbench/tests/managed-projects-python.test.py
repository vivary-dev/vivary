from contextlib import redirect_stdout
import io
import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import sys

SERVER = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(SERVER))
from managed_project_workspace import managed_request, create_vivary


class ManagedProjectBridgeTests(unittest.TestCase):
    def test_preview_writes_nothing_and_hash_binds_apply(self):
        with tempfile.TemporaryDirectory(prefix="vivary-managed-project-") as temporary:
            target = Path(temporary) / "projects" / "sample"
            preview = managed_request({"operation": "plan", "target": str(target)})
            self.assertEqual(preview["code"], "preview")
            self.assertFalse(target.parent.exists())

            changed = managed_request({
                "operation": "apply",
                "target": str(target),
                "acceptedPlanSha256": "sha256:" + "0" * 64,
            })
            self.assertEqual(changed, {"code": "plan-changed"})
            self.assertFalse(target.exists())

            target.parent.mkdir()
            created = managed_request({
                "operation": "apply",
                "target": str(target),
                "acceptedPlanSha256": preview["plan"]["plan_sha256"],
            })
            self.assertEqual(created["code"], "created")
            for planned in preview["plan"]["files"]:
                self.assertEqual(
                    (target / planned["path"]).read_text(encoding="utf-8"),
                    planned["content"],
                )

            replayed = managed_request({
                "operation": "apply",
                "target": str(target),
                "acceptedPlanSha256": preview["plan"]["plan_sha256"],
            })
            self.assertEqual(replayed["code"], "already-created")

            extra = target / "unreviewed.txt"
            extra.write_text("not approved\n", encoding="utf-8")
            with self.assertRaisesRegex(Exception, "init requires a new or empty directory"):
                managed_request({
                    "operation": "apply",
                    "target": str(target),
                    "acceptedPlanSha256": preview["plan"]["plan_sha256"],
                })
            self.assertEqual(extra.read_text(encoding="utf-8"), "not approved\n")

    def test_installed_choices_extend_exact_preview_and_apply(self):
        with tempfile.TemporaryDirectory(prefix="vivary-managed-patterns-") as temporary:
            target = Path(temporary) / "projects" / "sample"
            catalog = managed_request({"operation": "catalog"})
            self.assertEqual(catalog["code"], "catalog")
            self.assertEqual(len(catalog["patterns"]), 4)
            choices = [
                {"id": "capture", "name": "My inbox", "path": "notes/inbox.md"},
                {"id": "source-reference", "name": "Sources", "path": "sources/index.md"},
            ]
            request = {"operation": "plan", "target": str(target), "patternChoices": choices,
                       "preset": "second-brain"}
            preview = managed_request(request)
            self.assertEqual(len(preview["plan"]["files"]), 7)
            self.assertEqual(preview["plan"]["preset"], "second-brain")
            self.assertFalse(target.exists())
            target.parent.mkdir()
            result = managed_request({"operation": "apply", "target": str(target),
                                      "patternChoices": choices, "preset": "second-brain",
                                      "acceptedPlanSha256": preview["plan"]["plan_sha256"]})
            self.assertEqual(result["code"], "created")
            for row in preview["plan"]["files"]:
                self.assertEqual((target / row["path"]).read_bytes(),
                                 row["content"].encode("utf-8"))
            changed = managed_request({"operation": "plan", "target": str(target.parent / "another"),
                                       "patternChoices": choices[:1]})
            self.assertNotEqual(changed["plan"]["plan_sha256"], preview["plan"]["plan_sha256"])

    def test_cli_and_managed_bridge_consume_the_same_creator_plan(self):
        with tempfile.TemporaryDirectory(prefix="vivary-shared-init-") as temporary:
            target = Path(temporary) / "projects" / "sample"
            managed = managed_request({"operation": "plan", "target": str(target)})
            output = io.StringIO()
            with redirect_stdout(output):
                rc = create_vivary._main([
                    "init", str(target), "--reviewed", "--dry-run", "--json",
                ])
            self.assertEqual(rc, 0, output.getvalue())
            cli = json.loads(output.getvalue())
            self.assertEqual(cli["plan"], managed["plan"])
            self.assertFalse(target.exists())

            target.parent.mkdir()
            output = io.StringIO()
            with redirect_stdout(output):
                rc = create_vivary._main([
                    "init", str(target), "--reviewed", "--yes", "--json",
                    "--plan", cli["plan"]["plan_sha256"],
                    "--repo-root", str(Path(__file__).resolve().parents[3]),
                ])
            self.assertEqual(rc, 0, output.getvalue())
            self.assertEqual(json.loads(output.getvalue())["code"], "created")
            replay = managed_request({
                "operation": "apply", "target": str(target),
                "acceptedPlanSha256": cli["plan"]["plan_sha256"],
            })
            self.assertEqual(replay["code"], "already-created")
            for row in cli["plan"]["files"]:
                self.assertEqual((target / row["path"]).read_bytes(),
                                 row["content"].encode("utf-8"))

    def test_context_operation(self):
        with tempfile.TemporaryDirectory(prefix="vivary-managed-context-") as temporary:
            target = Path(temporary) / "projects" / "sample"
            preview = managed_request({"operation": "plan", "target": str(target)})
            target.parent.mkdir()
            managed_request({"operation": "apply", "target": str(target),
                             "acceptedPlanSha256": preview["plan"]["plan_sha256"]})
            answer = managed_request({"operation": "context", "target": str(target)})
            self.assertEqual(answer["code"], "context")
            self.assertEqual(answer["context"]["status"], "thin")
            self.assertEqual(answer["context"]["memory"], [".vivary/knowledge"])
            self.assertEqual(answer["context"]["state"], "STATE.md")
            self.assertNotIn(temporary, json.dumps(answer))
            (target / ".gitignore").write_text(
                (target / ".gitignore").read_text(encoding="utf-8") + "draft-*\n", encoding="utf-8")
            checked = managed_request({"operation": "context", "target": str(target),
                                       "candidates": [".vivary/knowledge/draft-a.md", ".vivary/knowledge/a.md"]})
            self.assertEqual(checked["context"]["private_candidates"], [".vivary/knowledge/draft-a.md"])

            bridge = SERVER / "managed_project_workspace.py"
            result = subprocess.run(
                [sys.executable, "-I", "-X", "utf8", "-B", str(bridge)],
                input=json.dumps({"operation": "context", "target": str(target), "path": "x"}),
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["code"], "refused")

    def test_observe_operation(self):
        with tempfile.TemporaryDirectory(prefix="vivary-managed-observe-") as temporary:
            target = Path(temporary) / "project"
            target.mkdir()
            self.assertEqual(managed_request({"operation": "observe", "target": str(target)}),
                             {"code": "observe", "observation": {"kind": "plain"}})
            env = {"PATH": os.environ.get("PATH", ""), "HOME": temporary, "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                   "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}

            def git(*args):
                return subprocess.run(["git", "-C", str(target), *args], check=True, env=env,
                                      capture_output=True, text=True).stdout

            (target / "a.txt").write_text("a\n", encoding="utf-8")
            (target / "sub").mkdir()
            (target / "sub" / "c.txt").write_text("c\n", encoding="utf-8")
            git("init", "-q", "-b", "main")
            git("add", ".")
            git("-c", "commit.gpgSign=false", "commit", "-q", "-m", "fixture")
            (target / "a.txt").write_text("changed\n", encoding="utf-8")
            (target / "sub" / "b.txt").write_text("b\n", encoding="utf-8")
            before = (git("status", "--porcelain=v1"), git("log", "--format=%H"), git("stash", "list"))

            answer = managed_request({"operation": "observe", "target": str(target)})
            observation = answer["observation"]
            self.assertEqual(observation["kind"], "git")
            self.assertEqual(observation["head"], git("rev-parse", "HEAD").strip())
            self.assertEqual(observation["ref"], "main")
            self.assertEqual(observation["entries"], [{"path": "a.txt", "state": "M"},
                                                      {"path": "sub/b.txt", "state": "??"}])
            self.assertNotIn(temporary, json.dumps(answer))
            # A project folder inside a larger checkout reports only its own entries, relative to itself.
            nested = managed_request({"operation": "observe", "target": str(target / "sub")})["observation"]
            self.assertEqual(nested["entries"], [{"path": "b.txt", "state": "??"}])
            self.assertEqual((git("status", "--porcelain=v1"), git("log", "--format=%H"), git("stash", "list")), before)

    def test_hardlinked_reviewed_file_is_not_accepted_on_retry(self):
        with tempfile.TemporaryDirectory(prefix="vivary-managed-hardlink-") as temporary:
            target = Path(temporary) / "projects" / "sample"
            preview = managed_request({"operation": "plan", "target": str(target)})
            target.parent.mkdir()
            request = {"operation": "apply", "target": str(target),
                       "acceptedPlanSha256": preview["plan"]["plan_sha256"]}
            managed_request(request)
            planned = target / preview["plan"]["files"][0]["path"]
            outside = Path(temporary) / "outside.txt"
            try:
                os.link(planned, outside)
            except OSError as error:
                self.skipTest(str(error))
            before = outside.read_bytes()
            with self.assertRaisesRegex(Exception, "init requires a new or empty directory"):
                managed_request(request)
            self.assertEqual(outside.read_bytes(), before)
            self.assertEqual(planned.read_bytes(), before)

    def test_unreadable_target_is_creator_refusal_for_bridge(self):
        with tempfile.TemporaryDirectory(prefix="vivary-managed-unreadable-") as temporary:
            target = Path(temporary) / "projects" / "sample"
            target.mkdir(parents=True)
            with mock.patch.object(Path, "iterdir",
                                   side_effect=PermissionError("access denied")):
                with self.assertRaisesRegex(create_vivary.ScaffoldError,
                                            "cannot inspect init target: access denied"):
                    managed_request({
                        "operation": "apply", "target": str(target),
                        "acceptedPlanSha256": "sha256:" + "0" * 64,
                    })

    def test_conflicting_existing_target_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="vivary-managed-conflict-") as temporary:
            target = Path(temporary) / "projects" / "sample"
            preview = managed_request({"operation": "plan", "target": str(target)})
            target.mkdir(parents=True)
            conflict = target / "AGENTS.md"
            conflict.write_text("keep me\n", encoding="utf-8")
            with self.assertRaisesRegex(Exception, "init requires a new or empty directory"):
                managed_request({
                    "operation": "apply",
                    "target": str(target),
                    "acceptedPlanSha256": preview["plan"]["plan_sha256"],
                })
            self.assertEqual(conflict.read_text(encoding="utf-8"), "keep me\n")


if __name__ == "__main__":
    unittest.main()
