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
        rows.append(f"| 🔒 **Security Review** | **{security}** <relative-time datetime=\"2026-10-05T17:08:40Z\">x</relative-time> | `{sha[:7]}` | PR opened |")
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
                mock.patch.object(gate, "fetch_pull", return_value={"head": {"sha": HEAD}, "draft": False}), \
                mock.patch.object(gate, "fetch_timeline", return_value=[]), \
                mock.patch.object(gate.time, "sleep"), \
                mock.patch.object(sys, "argv", ["check_review_gate.py", "--wait-seconds", "600"]), \
                redirect_stdout(io.StringIO()) as out:
            self.assertEqual(gate.main(), 0)
        self.assertIn("retrying after API error", out.getvalue())

    def _main(self, pull, fetch=None):
        env = {"GH_TOKEN": "x", "REPOSITORY": "o/r", "PR_NUMBER": "1", "HEAD_SHA": HEAD}
        fetch = fetch or (lambda *a: ([summary("Completed", HEAD, "Completed")], []))
        with mock.patch.dict("os.environ", env, clear=False), \
                mock.patch.object(gate, "fetch", side_effect=fetch), \
                mock.patch.object(gate, "fetch_pull", side_effect=pull if callable(pull) else (lambda *a: pull)), \
                mock.patch.object(gate, "fetch_timeline", return_value=[]), \
                mock.patch.object(gate.time, "sleep"), \
                mock.patch.object(sys, "argv", ["check_review_gate.py", "--wait-seconds", "600"]), \
                redirect_stdout(io.StringIO()) as out:
            return gate.main(), out.getvalue()

    def test_dispatch_input_that_is_not_the_live_head_is_blocked(self):
        code, out = self._main({"head": {"sha": NEXT}, "draft": False})
        self.assertEqual(code, 1)
        self.assertIn("not PR #1's live head", out)

    def test_draft_pull_request_is_blocked_without_waiting(self):
        code, out = self._main({"head": {"sha": HEAD}, "draft": True})
        self.assertEqual(code, 1)
        self.assertIn("draft", out)

    def test_client_error_fails_without_retrying(self):
        def refuse(*a):
            raise gate.urllib.error.HTTPError("u", 403, "Forbidden", {}, None)
        with redirect_stdout(io.StringIO()):
            code, _ = self._main({"head": {"sha": HEAD}, "draft": False}, refuse)
        self.assertEqual(code, 1)

    def test_review_before_base_retarget_is_stale(self):
        done = summary("Completed", HEAD, "Completed")  # completed at 2026-10-05T17:08:39Z
        events = [{"event": "base_ref_changed", "created_at": "2026-10-05T17:30:00Z"}]
        ready, pending, messages = gate.evaluate([done], [], HEAD, gate.latest_base_change(events))
        self.assertFalse(ready)
        self.assertFalse(pending)
        self.assertIn("base branch changed", messages[0])
        ready, _, _ = gate.evaluate([done], [], HEAD, gate.latest_base_change(
            [{"event": "base_ref_changed", "created_at": "2026-10-05T17:00:00Z"}]))
        self.assertTrue(ready, "a retarget before the review completed keeps the review valid")

    def test_transient_pull_lookup_error_is_retried(self):
        calls = iter([OSError("reset"), {"head": {"sha": HEAD}, "draft": False}])
        def pull(*a):
            item = next(calls)
            if isinstance(item, Exception):
                raise item
            return item
        code, out = self._main(pull)
        self.assertEqual(code, 0)
        self.assertIn("retrying after API error", out)

    def test_review_workflow_contract_rejects_weakening(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import check_ci_workflow as contract
        real = (Path(__file__).resolve().parents[2] / ".github/workflows/review-gate.yml").read_text(encoding="utf-8")
        contract.check_review_workflow(real)
        weakened = {
            "push": real.replace("on:\n  pull_request:\n", "on:\n  push:\n  pull_request:\n"),
            "dispatch": real + "  workflow_dispatch:\n",
            "base script": real.replace("ref: ${{ github.event.pull_request.base.sha }}", "ref: ${{ github.event.pull_request.head.sha }}"),
            "no wait": real.replace("--wait-seconds 2400", "--wait-seconds 0"),
            "or true": real.replace("--interval 30\n", "--interval 30 || true\n"),
            "conditional": real.replace("      - name: wait for completed reviews", "      - if: false\n        name: wait for completed reviews"),
            "renamed": real.replace("name: required review gate", "name: review gate (optional)"),
            "no edited": real.replace(", edited]", "]"),
        }
        for label, text in weakened.items():
            with self.assertRaises(SystemExit, msg=label):
                contract.check_review_workflow(text)

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
                mock.patch.object(gate, "fetch_pull", return_value={"head": {"sha": HEAD}, "draft": False}), \
                mock.patch.object(gate, "fetch_timeline", return_value=[]), \
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
                mock.patch.object(gate, "fetch_pull", return_value={"head": {"sha": HEAD}, "draft": False}), \
                mock.patch.object(gate, "fetch_timeline", return_value=[]), \
                mock.patch.object(gate.time, "sleep"), \
                mock.patch.object(sys, "argv", ["check_review_gate.py", "--wait-seconds", "600"]), \
                redirect_stdout(io.StringIO()) as out:
            self.assertEqual(gate.main(), 1)
        self.assertEqual(len(calls), 1)
        self.assertIn("BLOCKED", out.getvalue())


if __name__ == "__main__":
    unittest.main()
