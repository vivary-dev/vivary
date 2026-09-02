import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import vivary_cli


class VivaryReleaseMetadataTests(unittest.TestCase):
    def test_runtime_version_matches_manifest_and_component_floors(self):
        import tomllib

        manifest = tomllib.loads(
            (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        )["project"]
        self.assertEqual(vivary_cli.__version__, manifest["version"])
        self.assertIn("create-vivary>=0.4.3", manifest["dependencies"])
        self.assertIn("vivary-tropo>=0.5.4", manifest["dependencies"])
        self.assertIn("vivary-strato>=0.1.3", manifest["dependencies"])
        self.assertIn("vivary-ozone>=0.3.2", manifest["dependencies"])
        self.assertIn("vivary-exo>=0.3.1", manifest["dependencies"])
        self.assertFalse(
            any(dependency.startswith("vivary-core") for dependency in manifest["dependencies"])
        )

class VivaryLogsTests(unittest.TestCase):
    def _run(self, argv):
        out = io.StringIO()
        err = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = vivary_cli.main(argv)
        return rc, out.getvalue(), err.getvalue()

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

            rc, out, err = self._run(["logs", str(receipt), "--json"])

        self.assertEqual(rc, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["summary"]["total"], 2)
        self.assertEqual(payload["summary"]["failed"], 1)
        self.assertEqual(payload["summary"]["invalid_lines"], 2)
        self.assertEqual(payload["records"][-1]["tool"], "create-vivary")
        self.assertNotIn("raw_path", payload["records"][-1])
        self.assertNotIn("stdout", payload["records"][-1])

    def test_logs_failed_tail_text(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            self._write_receipts(receipt)

            rc, out, err = self._run(["logs", str(receipt), "--failed", "--tail", "1"])

        self.assertEqual(rc, 0, err)
        self.assertIn("total=1", out)
        self.assertIn("create-vivary doctor fail", out)
        self.assertNotIn("tropo check ok", out)

    def test_logs_tail_zero_returns_no_records(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            self._write_receipts(receipt)

            rc, out, err = self._run(["logs", str(receipt), "--tail", "0", "--json"])

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

            rc, out, err = self._run(["logs", str(receipt), "--json"])

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

            rc, out, err = self._run(
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
        rc, out, err = self._run(["logs", "missing.jsonl", "--json"])

        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("receipt log not found", err)

    def test_logs_email_refuses_directory_draft_target(self):
        with tempfile.TemporaryDirectory() as td:
            receipt = Path(td) / "receipts.jsonl"
            self._write_receipts(receipt)

            rc, out, err = self._run(
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

            rc, out, err = self._run(
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


if __name__ == "__main__":
    unittest.main()
