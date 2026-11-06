import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
for _path in (ROOT, *(ROOT.parent / name for name in ("tropo", "ozone", "core", "create-vivary"))):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import create_vivary
import ozone
import tropo
import vivary_cli
from vivary_core import normalize_path


def _run(argv):
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = vivary_cli.main(argv)
    return rc, out.getvalue(), err.getvalue()


class VivaryReleaseMetadataTests(unittest.TestCase):
    def test_runtime_version_matches_manifest_and_component_floors(self):
        import tomllib

        manifest = tomllib.loads(
            (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        )["project"]
        self.assertEqual(vivary_cli.__version__, manifest["version"])
        self.assertIn("create-vivary>=0.4.4", manifest["dependencies"])
        self.assertIn("vivary-tropo>=0.5.5", manifest["dependencies"])
        self.assertIn("vivary-strato>=0.1.3", manifest["dependencies"])
        self.assertIn("vivary-ozone>=0.3.2", manifest["dependencies"])
        self.assertIn("vivary-exo>=0.3.1", manifest["dependencies"])
        self.assertFalse(
            any(dependency.startswith("vivary-core") for dependency in manifest["dependencies"])
        )

class VivaryLogsTests(unittest.TestCase):
    def _write_receipts(self, path):
        records = [
            {
                "schema": "vivary.run_receipt.v1",
                "timestamp": "2026-07-05T20:00:00Z",
                "tool": "tropo",
                "version": "0.4.1",
                "command": "check",
                "flags": ["--json", "--root"],
                "arg_count": 4,
                "exit_code": 0,
                "ok": True,
                "duration_ms": 42,
                "python": "3.11.9",
                "platform": "Windows",
                "receipt_source": "flag",
            },
            {"not": "json"},
        ]
        path.write_text(
            "\n".join(json.dumps(record) for record in records)
            + "\n{bad json}\n"
            + json.dumps(
                {
                    "schema": "vivary.run_receipt.v1",
                    "timestamp": "2026-07-05T20:01:00Z",
                    "tool": "create-vivary",
                    "version": "0.3.1",
                    "command": "doctor",
                    "flags": ["--trend"],
                    "arg_count": 3,
                    "exit_code": 1,
                    "ok": False,
                    "duration_ms": 7,
                    "python": "3.11.9",
                    "platform": "Windows",
                    "receipt_source": "env",
                    "raw_path": "C:/Users/example/private/project",
                    "stdout": "secret output",
                }
            )
            + "\n",
            encoding="utf-8",
        )

    def test_logs_summary_json_tolerates_malformed_lines(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            self._write_receipts(receipt)

            rc, out, err = _run(["logs", str(receipt), "--json"])

        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["summary"]["total"], 2)
        self.assertEqual(payload["summary"]["failed"], 1)
        self.assertEqual(payload["summary"]["invalid_lines"], 2)
        self.assertEqual(payload["records"][-1]["tool"], "create-vivary")
        self.assertNotIn("raw_path", payload["records"][-1])
        self.assertNotIn("stdout", payload["records"][-1])

    def test_logs_json_reports_whole_log_totals_beside_the_selection(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            base = {"schema": "vivary.run_receipt.v1", "tool": "tropo", "command": "check"}
            receipt.write_text("".join(
                json.dumps({**base, "ok": ok, "exit_code": 0 if ok else 1}) + "\n"
                for ok in (False, False, True, False, True)), encoding="utf-8")

            rc, out, err = _run(["logs", str(receipt), "--json", "--tail", "2"])
            failed_rc, failed_out, failed_err = _run(
                ["logs", str(receipt), "--json", "--tail", "1", "--failed"])

        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual((payload["summary"]["total"], payload["summary"]["failed"]), (2, 1))
        self.assertEqual((payload["log"]["total"], payload["log"]["failed"]), (5, 3))
        self.assertEqual(len(payload["records"]), 2)
        self.assertEqual(failed_rc, 0, failed_err)
        failed = json.loads(failed_out)
        self.assertEqual((failed["summary"]["total"], failed["log"]["failed"]), (1, 3))

    def test_logs_count_a_receipt_without_a_true_ok_as_failed(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            base = {"schema": "vivary.run_receipt.v1", "tool": "tropo", "command": "check"}
            rows = [{**base, "ok": True}, dict(base), {**base, "ok": "false"}]
            receipt.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            rc, out, err = _run(["logs", str(receipt), "--json"])
            failed_rc, failed_out, failed_err = _run(["logs", str(receipt), "--json", "--failed"])
            text_rc, text_out, text_err = _run(["logs", str(receipt)])

        self.assertEqual((rc, failed_rc, text_rc), (0, 0, 0), err + failed_err + text_err)
        self.assertEqual(json.loads(out)["log"]["failed"], 2)
        self.assertEqual(len(json.loads(failed_out)["records"]), 2)
        statuses = [line.split()[-1] for line in text_out.splitlines() if " tropo check " in line]
        self.assertEqual(statuses, ["ok", "fail", "fail"])

    def test_logs_failed_tail_text(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            self._write_receipts(receipt)

            rc, out, err = _run(["logs", str(receipt), "--failed", "--tail", "1"])

        self.assertEqual(rc, 0, err)
        self.assertIn("total=1", out)
        self.assertIn("create-vivary doctor fail", out)
        self.assertNotIn("tropo check ok", out)

    def test_logs_tail_zero_returns_no_records(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            self._write_receipts(receipt)

            rc, out, err = _run(["logs", str(receipt), "--tail", "0", "--json"])

        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["summary"]["total"], 0)
        self.assertEqual(payload["records"], [])

    def test_logs_sanitizes_allowlisted_receipt_values(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            receipt.write_text(
                json.dumps(
                    {
                        "timestamp": "2026-07-05T20:02:00Z",
                        "tool": "tool C:/Users/example/private/tool",
                        "command": "check file:///C:/Users/example/private/workspace",
                        "flags": ["--root", "C:/Users/example/private/project"],
                        "ok": False,
                        "error_type": "bad \\\\server\\share\\secret",
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            rc, out, err = _run(["logs", str(receipt), "--json"])

        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        text = json.dumps(payload)
        self.assertNotIn("C:/Users/example", text)
        self.assertNotIn("file:///C:/Users/example", text)
        self.assertNotIn("\\\\server\\share", text)
        self.assertIn("(local path omitted)", text)
        self.assertIn("(network path omitted)", text)

    def test_logs_email_writes_redacted_eml_draft(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            draft = Path(td) / "vivary-support.eml"
            self._write_receipts(receipt)

            rc, out, err = _run(
                [
                    "logs",
                    "email",
                    str(receipt),
                    "--to",
                    "support@example.com",
                    "--subject",
                    "Vivary support bundle",
                    "--out",
                    str(draft),
                    "--json",
                ]
            )

            self.assertEqual(rc, 0, err)
            payload = json.loads(out)
            self.assertEqual(payload["draft"], str(draft))
            text = draft.read_text(encoding="utf-8")
            self.assertIn("To: support@example.com", text)
            self.assertIn("Subject: Vivary support bundle", text)
            self.assertIn("create-vivary doctor fail", text)
            self.assertNotIn("secret output", text)
            self.assertNotIn("C:/Users/example/private/project", text)

    def test_logs_missing_file_exits_cleanly(self):
        rc, out, err = _run(["logs", "missing.jsonl"])
        json_rc, json_out, json_err = _run(["logs", "missing.jsonl", "--json"])

        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("receipt log not found", err)
        self.assertEqual(json_rc, 0, json_err)
        payload = json.loads(json_out)
        self.assertIsNone(payload["log"])
        self.assertEqual((payload["summary"]["total"], payload["records"]), (0, []))
        with tempfile.TemporaryDirectory() as td:
            dir_rc, dir_out, dir_err = _run(["logs", td, "--json"])
        self.assertEqual((dir_rc, dir_out), (1, ""))
        self.assertIn("not a regular file", dir_err)

    def test_logs_email_refuses_directory_draft_target(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            self._write_receipts(receipt)

            rc, out, err = _run(
                [
                    "logs",
                    "email",
                    str(receipt),
                    "--to",
                    "support@example.com",
                    "--out",
                    td,
                ]
            )

        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("draft path must be a regular file", err)

    def test_logs_email_rejects_multiline_headers(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            self._write_receipts(receipt)

            rc, out, err = _run(
                [
                    "logs",
                    "email",
                    str(receipt),
                    "--to",
                    "support@example.com\nBcc: bad@example.com",
                ]
            )

        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("single-line text", err)


class VivaryPublicReadTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "project"
        (self.root / "decisions").mkdir(parents=True)
        files = {
            "tropo.toml": (
                "version = 1\n\n[base]\nallow_untyped = true\n\n"
                '[types.decision]\nfolder = "decisions"\n'
                'required = { status = "enum:proposed|accepted" }\n'
            ),
            ".gitignore": "private.md\n",
            "public.md": "# Public\n\nThe gamma relay notes.\n",
            "private.md": "# Private\n\nThe gamma relay secret.\n",
            "decisions/relay.md": "# Relay decision\n\nUse the gamma relay.\n",
        }
        for name, content in files.items():
            (self.root / name).write_text(content, encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.canonical = normalize_path(os.path.realpath(self.root))

    # Content, not mtime: the host's filesystem can move an mtime without a write.
    def _tree(self):
        return {
            path.relative_to(self.root).as_posix(): path.read_bytes() if path.is_file() else None
            for path in self.root.rglob("*")
        }

    def test_public_reads_print_the_facade_result_and_write_nothing(self):
        before = self._tree()
        find_rc, find_out, find_err = _run(
            ["find", "gamma relay", "--root", str(self.root), "--public", "--json",
             "--k", "3", "--budget", "500"]
        )
        check_rc, check_out, check_err = _run(
            ["check", "--root", str(self.root), "--public", "--json"]
        )

        self.assertEqual(self._tree(), before)
        self.assertEqual(find_rc, 0, find_err)
        self.assertEqual(
            json.loads(find_out),
            tropo.find_context(
                self.canonical, "gamma relay", k=3, budget=500, allowlist=[self.canonical]
            ),
        )
        check = json.loads(check_out)
        self.assertEqual(check, tropo.check_workspace(self.canonical, allowlist=[self.canonical]))
        self.assertEqual(check["errors"], 1)
        self.assertEqual(check_rc, 1, check_err)

    def test_public_find_leaves_out_a_git_ignored_note_that_plain_find_returns(self):
        public_rc, public_out, public_err = _run(
            ["find", "gamma relay", "--root", str(self.root), "--public"]
        )
        plain_rc, plain_out, plain_err = _run(
            ["find", "gamma relay", "--root", str(self.root), "--json"]
        )

        self.assertEqual(public_rc, 0, public_err)
        public = json.loads(public_out)
        self.assertNotIn("private.md", [hit["path"] for hit in public["results"]])
        self.assertIn(
            {"kind": "privacy_excluded", "reason": "git_ignored", "count": 1},
            public["omissions"],
        )
        self.assertEqual(plain_rc, 0, plain_err)
        self.assertIn("private.md", [hit["path"] for hit in json.loads(plain_out)["results"]])

    def test_public_reads_refuse_a_folder_without_a_privacy_policy(self):
        shutil.rmtree(self.root / ".git")
        for verb_args in (["find", "gamma relay"], ["check"], ["review"],
                          ["impact", "relay"]):
            with self.subTest(verb=verb_args[0]):
                rc, out, err = _run([*verb_args, "--root", str(self.root), "--public"])

                self.assertEqual(rc, 2, err)
                self.assertEqual(
                    json.loads(out),
                    {"schema": "vivary.read-refusal/v0", "reason": "privacy_policy_unavailable"},
                )

    def test_public_review_and_impact_print_the_facade_result_and_write_nothing(self):
        before = self._tree()
        structure = _run(["review", "--root", str(self.root), "--public", "--json"])
        editorial = _run(
            ["review", "--root", str(self.root), "--public", "--pack", "editorial"])
        impact = _run(["impact", "relay", "--root", str(self.root), "--public", "--json"])

        self.assertEqual(self._tree(), before)
        allowlist = [self.canonical]
        expected = (
            ozone.public_review(self.canonical, pack="structure", allowlist=allowlist),
            ozone.public_review(self.canonical, pack="editorial", allowlist=allowlist),
            ozone.public_impact(self.canonical, "relay", allowlist=allowlist),
        )
        for (rc, out, err), result in zip((structure, editorial, impact), expected):
            with self.subTest(schema=result["schema"], out=out[:40]):
                self.assertEqual(rc, 0, err)
                self.assertEqual(json.loads(out), result)

    def test_public_review_and_impact_leave_out_a_git_ignored_note_that_plain_ones_name(self):
        plain_review_rc, plain_review, _ = _run(["review", "--root", str(self.root), "--json"])
        plain_impact_rc, _, plain_impact_err = _run(
            ["impact", "private", "--root", str(self.root), "--json"])
        public_rc, public_out, public_err = _run(
            ["review", "--root", str(self.root), "--public"])
        refusals = [
            _run(["impact", node_id, "--root", str(self.root), "--public"])
            for node_id in ("private", "nowhere-9f2c41d7")
        ]

        self.assertEqual((plain_review_rc, plain_impact_rc), (0, 0), plain_impact_err)
        self.assertIn("private", [f["id"] for f in json.loads(plain_review)["findings"]])
        self.assertEqual(public_rc, 0, public_err)
        self.assertNotIn("private", [f["id"] for f in json.loads(public_out)["findings"]])
        self.assertNotIn("private.md", public_out)
        self.assertEqual(refusals[0], refusals[1])
        rc, out, _ = refusals[0]
        self.assertEqual(rc, 2)
        self.assertEqual(
            json.loads(out), {"schema": "vivary.read-refusal/v0", "reason": "target_unavailable"})

    def test_review_and_impact_without_tropo_print_the_install_hint(self):
        with tempfile.TemporaryDirectory() as td:
            Path(td, "ozone").mkdir()
            shutil.copy(ozone.__file__, Path(td, "ozone", "ozone.py"))
            spec = importlib.util.spec_from_file_location("ozone", Path(td, "ozone", "ozone.py"))
            lone = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(lone)
            with mock.patch.dict(sys.modules, {"ozone": lone, "tropo": None}):
                results = [
                    _run([*verb_args, "--root", str(self.root), *public])
                    for verb_args in (["review"], ["impact", "relay"])
                    for public in ((), ("--public",))
                ]

        for rc, out, err in results:
            with self.subTest(err=err):
                self.assertEqual((rc, out), (1, ""))
                self.assertTrue(
                    err.startswith("ozone: tropo engine not found (install vivary-tropo): "))

    def test_public_review_refuses_the_context_budget_pack(self):
        plain_rc, _, plain_err = _run(
            ["review", "--root", str(self.root), "--pack", "context-budget", "--json"])
        rc, out, err = _run(
            ["review", "--root", str(self.root), "--public", "--pack", "context-budget"])

        self.assertEqual(plain_rc, 0, plain_err)
        self.assertEqual(rc, 2)
        self.assertEqual(out, "")
        self.assertIn("invalid choice: 'context-budget'", err)

    def test_public_doctor_reports_the_workspace_without_a_git_ignored_note(self):
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td) / "workspace"
            rc, out, err = _run(["create", str(workspace), "--preset", "coding"])
            self.assertEqual(rc, 0, err)
            subprocess.run(["git", "init", "-q", str(workspace)], check=True)
            (workspace / "projects").mkdir(exist_ok=True)
            (workspace / "projects" / "acme-deal.md").write_text(
                "---\ntype: project\nstatus: acquiring-acme-for-12M\n---\n# Acme deal\n",
                encoding="utf-8")
            with (workspace / ".gitignore").open("a", encoding="utf-8") as ignore:
                ignore.write("projects/acme-deal.md\n")
            def authored():
                return {path: path.read_bytes() for path in workspace.rglob("*")
                        if path.is_file() and ".git" not in path.relative_to(workspace).parts}

            before = authored()
            plain_rc, plain_out, plain_err = _run(["doctor", str(workspace), "--json"])
            public_rc, public_out, public_err = _run(
                ["doctor", "--root", str(workspace), "--public", "--json"])
            after = authored()
            expected = create_vivary.doctor_workspace(os.path.realpath(workspace), public=True)

        self.assertIn("acquiring-acme-for-12M", plain_out, plain_err)
        self.assertEqual(plain_rc, 1)
        self.assertNotIn("acme", public_out)
        public = json.loads(public_out)
        self.assertEqual(public, {"schema": "vivary.doctor-result/v0", "ok": expected["ok"],
                                  "errors": expected["errors"], "warnings": expected["warnings"]})
        self.assertIsNone(expected["graph"])
        self.assertEqual(public_rc, 0 if public["ok"] else 1, public_err)
        self.assertTrue(public["ok"], public["errors"])
        self.assertEqual(after, before)

    def test_public_doctor_counts_a_git_ignored_module_folder_without_naming_it(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            private = repo / "modules" / "client-acme-offboarding"
            private.mkdir(parents=True)
            (private / "notes.md").write_text("# Offboarding\n", encoding="utf-8")
            (repo / ".gitignore").write_text("modules/client-acme-offboarding/\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(repo)], check=True)

            plain_rc, plain_out, _ = _run(["doctor", str(repo), "--json"])
            public_rc, public_out, public_err = _run(
                ["doctor", "--root", str(repo), "--public", "--json"])

        self.assertIn("client-acme-offboarding", plain_out)
        self.assertNotIn("acme", public_out)
        public = json.loads(public_out)
        self.assertIn("a module folder lacks index.md", public["errors"])
        self.assertNotIn("--", public_out)
        self.assertEqual((plain_rc, public_rc), (1, 1), public_err)

    def test_public_doctor_names_no_folder_outside_the_project(self):
        with tempfile.TemporaryDirectory() as td:
            outer = Path(td) / "acme-private-holdings"
            apart = Path(td) / "project"
            for root in (outer, apart):
                rc, _, err = _run(["create", str(root), "--preset", "coding"])
                self.assertEqual(rc, 0, err)
            # create refuses a root inside another workspace, so nest it afterward.
            project = apart.rename(outer / "project")

            plain_rc, plain_out, _ = _run(["doctor", str(project), "--json"])
            public_rc, public_out, public_err = _run(
                ["doctor", "--root", str(project), "--public", "--json"])

        self.assertIn("acme-private-holdings", plain_out)
        self.assertNotIn("acme", public_out)
        self.assertNotIn(td, public_out)
        self.assertIn("tropo configuration is invalid", json.loads(public_out)["errors"])
        self.assertEqual((plain_rc, public_rc), (1, 1), public_err)

    def test_doctor_rules_name_no_command_and_every_report_names_a_rule(self):
        import ast

        for public in (rule.value for rule in create_vivary.DoctorRule):
            for sentence in (public.one, public.several):
                self.assertNotIn("--", sentence)
                self.assertNotIn("create-vivary", sentence)
            for value in public.values:
                self.assertFalse(value.startswith(("/", "~", "-")) or ":" in value or ".." in value, value)
        tree = ast.parse(Path(create_vivary.__file__).read_text(encoding="utf-8"))

        def names_a_rule(node: ast.expr) -> bool:
            return (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                    and node.value.id == "DoctorRule" and node.attr in create_vivary.DoctorRule.__members__)

        functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
        reports = [node for node in ast.walk(functions["doctor_workspace"])
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "report"]
        self.assertGreater(len(reports), 20)
        for call in reports:
            self.assertFalse(call.keywords, ast.unparse(call)[:80])
            rule = call.args[1]
            # The one pass-through is the rule `_module_index_problems` returned, checked below.
            self.assertTrue(names_a_rule(rule) or (isinstance(rule, ast.Name) and rule.id == "rule"),
                            ast.unparse(call)[:80])
        appended = [node.args[0].elts[0] for node in ast.walk(functions["_module_index_problems"])
                    if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "append"]
        self.assertTrue(appended)
        self.assertTrue(all(names_a_rule(rule) for rule in appended))

    def test_public_doctor_names_only_listed_values(self):
        problems = [("error", create_vivary.DoctorRule.PRIVACY_IGNORE_MISSING, "detail", "*.vivary-tmp"),
                    ("error", create_vivary.DoctorRule.PRIVACY_IGNORE_MISSING, "detail", "not-a-listed-pattern/")]
        self.assertEqual(create_vivary._doctor_lines(problems, "error", True),
                         ["2 required privacy ignores are missing from .gitignore: *.vivary-tmp"])
        self.assertEqual(create_vivary._doctor_lines(problems, "error", False), ["detail", "detail"])

    def test_public_doctor_names_missing_ignores_and_files_from_vivary_lists(self):
        workspace = self.root / "named"
        rc, _, err = _run(["create", str(workspace), "--preset", "coding", "--json"])
        self.assertEqual(rc, 0, err)
        (workspace / "AGENTS.md").unlink()
        gitignore = workspace / ".gitignore"
        gitignore.write_text(gitignore.read_text(encoding="utf-8").replace("*.vivary-tmp\n", ""), encoding="utf-8")
        public = create_vivary.doctor_workspace(workspace, public=True)
        self.assertIn("a required workspace file is missing: AGENTS.md", public["errors"])
        self.assertIn("a required privacy ignore is missing from .gitignore: *.vivary-tmp", public["errors"])

    def test_public_find_refuses_a_dash_leading_query_and_out_of_bound_limits(self):
        root = str(self.root)
        cases = (
            (["--", "-gamma"], "the query must not start with '-'"),
            (["-gamma"], "vivary find: error:"),
            (["gamma", "--k", "21"], "expected an integer from 1 to 20"),
            (["gamma", "--budget", "63"], "expected an integer from 64 to 4000"),
        )
        for tail, message in cases:
            with self.subTest(tail=tail):
                rc, out, err = _run(["find", "--root", root, "--public", *tail])

                self.assertEqual(rc, 2)
                self.assertEqual(out, "")
                self.assertIn(message, err)


if __name__ == "__main__":
    unittest.main()
