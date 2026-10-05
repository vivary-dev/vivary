"""Exercise the required review gate with real Codex summary comment shapes."""

from pathlib import Path
import io
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_review_gate as gate  # noqa: E402

HEAD = "90765bc2383862ba4690e549bbf48dc8880bde2f"
NEXT = "d2c481901c30ce24a148a0c1d3edb947c7b275ae"


def summary(status: str, sha: str, security: str | None = None) -> dict:
    """A Codex summary comment as the connector writes it (PR #191 / #192 shapes)."""
    state = "completed" if status == "Completed" and (security or "Completed") == "Completed" else "running"
    rows = [f"| 📝 **Code Review** | {'✅' if status == 'Completed' else '🔄'} **{status}** "
            f"<relative-time datetime=\"2026-10-05T17:08:39Z\">2026-10-05T17:08:39Z</relative-time> | `{sha[:7]}` | PR opened |"]
    if security:
        rows.append(f"| 🔒 **Security Review** | **{security}** | `{sha[:7]}` | PR opened |")
    body = ("<!-- codex-pull-request-review-summary -->\n"
            f'<!-- codex-security-review:v1 {{"headSha":"{sha}","mergeGateEnabled":false,"status":"{state}"}} -->\n'
            "## Codex Review Summary\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n"
            + "\n".join(rows) + "\n")
    return {"body": body, "updated_at": "2026-10-05T17:08:40Z",
            "user": {"login": "chatgpt-codex-connector[bot]", "type": "Bot"}}


def thread(resolved: bool, login: str = "chatgpt-codex-connector[bot]") -> dict:
    return {"isResolved": resolved, "comments": {"nodes": [{"url": f"https://example.invalid/{login}", "author": {"login": login}}]}}


class ReviewGate(unittest.TestCase):
    def test_running_review_is_pending_and_blocks(self):
        ready, pending, messages = gate.evaluate([summary("Running", HEAD)], [], HEAD)
        self.assertFalse(ready)
        self.assertTrue(pending)
        self.assertIn("not complete", messages[0])

    def test_missing_summary_is_pending_and_blocks(self):
        ready, pending, messages = gate.evaluate([{"body": "LGTM", "updated_at": "x"}], [], HEAD)
        self.assertFalse(ready)
        self.assertTrue(pending)
        self.assertIn("@codex review", messages[0])

    def test_review_of_an_earlier_commit_fails_without_waiting(self):
        ready, pending, messages = gate.evaluate([summary("Completed", HEAD, "Completed")], [], NEXT)
        self.assertFalse(ready)
        self.assertFalse(pending, "only a new @codex review can change a stale review; do not hold a runner")
        self.assertIn("not head d2c4819", messages[0])

    def test_forged_summary_from_another_user_is_ignored(self):
        forged = summary("Completed", NEXT, "Completed")
        forged["user"] = {"login": "random", "type": "User"}
        forged["updated_at"] = "2026-10-05T18:00:00Z"
        ready, pending, _ = gate.evaluate([summary("Running", NEXT, "Running"), forged], [], NEXT)
        self.assertFalse(ready)
        self.assertTrue(pending)
        ready, pending, messages = gate.evaluate([forged], [], NEXT)
        self.assertFalse(ready)
        self.assertIn("no Codex review summary", messages[0])

    def test_security_marker_without_security_row_blocks(self):
        comment = summary("Completed", HEAD)
        ready, _, messages = gate.evaluate([comment], [], HEAD)
        self.assertFalse(ready)
        self.assertIn("no Security Review row", messages[0])

    def test_running_security_review_blocks_even_when_code_review_completed(self):
        ready, pending, _ = gate.evaluate([summary("Completed", HEAD, "Running")], [], HEAD)
        self.assertFalse(ready)
        self.assertTrue(pending)

    def test_unresolved_finding_blocks_completed_review(self):
        ready, pending, messages = gate.evaluate(
            [summary("Completed", HEAD, "Completed")], [thread(True), thread(False)], HEAD)
        self.assertFalse(ready)
        self.assertFalse(pending, "an unresolved finding needs a disposition, not more waiting")
        self.assertTrue(any("unresolved review thread" in m for m in messages))

    def test_cli_retries_transient_api_errors(self):
        responses = iter([OSError("503"), ([summary("Completed", HEAD, "Completed")], [])])
        def fetch(*args):
            item = next(responses)
            if isinstance(item, Exception):
                raise item
            return item
        env = {"GH_TOKEN": "x", "REPOSITORY": "o/r", "PR_NUMBER": "1", "HEAD_SHA": HEAD}
        with mock.patch.dict("os.environ", env, clear=False), \
                mock.patch.object(gate, "fetch", side_effect=fetch), \
                mock.patch.object(gate.time, "sleep"), \
                mock.patch.object(sys, "argv", ["check_review_gate.py", "--wait-seconds", "600"]), \
                redirect_stdout(io.StringIO()) as out:
            self.assertEqual(gate.main(), 0)
        self.assertIn("retrying after API error", out.getvalue())

    def test_completed_review_with_resolved_threads_is_ready(self):
        ready, pending, _ = gate.evaluate([summary("Completed", HEAD, "Completed")], [thread(True)], HEAD)
        self.assertTrue(ready)
        self.assertFalse(pending)

    def test_latest_summary_wins(self):
        old = summary("Completed", NEXT, "Completed")
        old["updated_at"] = "2026-10-05T16:00:00Z"
        ready, _, _ = gate.evaluate([old, summary("Running", NEXT)], [], NEXT)
        self.assertFalse(ready)

    def test_cli_waits_while_pending_then_passes_when_review_completes(self):
        responses = iter([([summary("Running", HEAD)], []), ([summary("Completed", HEAD, "Completed")], [thread(True)])])
        env = {"GH_TOKEN": "x", "REPOSITORY": "o/r", "PR_NUMBER": "1", "HEAD_SHA": HEAD}
        with mock.patch.dict("os.environ", env, clear=False), \
                mock.patch.object(gate, "fetch", side_effect=lambda *a: next(responses)), \
                mock.patch.object(gate.time, "sleep"), \
                mock.patch.object(sys, "argv", ["check_review_gate.py", "--wait-seconds", "600", "--interval", "1"]), \
                redirect_stdout(io.StringIO()) as out:
            self.assertEqual(gate.main(), 0)
        self.assertIn("READY", out.getvalue())

    def test_cli_fails_without_waiting_on_unresolved_threads(self):
        calls = []
        def fetch(*args):
            calls.append(args)
            return [summary("Completed", HEAD, "Completed")], [thread(False)]
        env = {"GH_TOKEN": "x", "REPOSITORY": "o/r", "PR_NUMBER": "1", "HEAD_SHA": HEAD}
        with mock.patch.dict("os.environ", env, clear=False), \
                mock.patch.object(gate, "fetch", side_effect=fetch), \
                mock.patch.object(gate.time, "sleep"), \
                mock.patch.object(sys, "argv", ["check_review_gate.py", "--wait-seconds", "600"]), \
                redirect_stdout(io.StringIO()) as out:
            self.assertEqual(gate.main(), 1)
        self.assertEqual(len(calls), 1)
        self.assertIn("BLOCKED", out.getvalue())


if __name__ == "__main__":
    unittest.main()
