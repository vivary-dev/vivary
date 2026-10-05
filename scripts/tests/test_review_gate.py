"""Exercise the required review gate with independent-review and Codex comment shapes."""

from pathlib import Path
import io
import json
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_review_gate as gate  # noqa: E402

HEAD = "90765bc2383862ba4690e549bbf48dc8880bde2f"
NEXT = "d2c481901c30ce24a148a0c1d3edb947c7b275ae"
BASE = "b1836a9f126d88fb5162ff34984d31d13d909518"
OTHER_BASE = "396b5f77f82ddd8773935d7a2ed303d65552da0f"


def independent(status: str, sha: str = HEAD, base: str = BASE, login: str = "Jeff-Kazzee",
                at: str = "2026-10-05T18:30:00Z", findings: int = 1, posted: tuple = (501,),
                editor: object = "Jeff-Kazzee") -> dict:
    """An independent review result comment as vivary-independent-review publishes it."""
    state = {"headSha": sha, "baseSha": base, "status": status, "engine": "claude", "model": "claude-opus-5-5",
             "findings": findings, "threads": len(posted), "threadComments": list(posted)}
    return {"body": f"<!-- vivary-independent-review:v1 {json.dumps(state)} -->\n## Independent review\n",
            "updated_at": at, "user": {"login": login, "type": "User"}, "editor": editor}


ICONS = {"Completed": "✅", "Running": "🔄", "Queued": "🔄"}


def summary(status: str, sha: str, security: str | None = None) -> dict:
    """A Codex summary comment as the connector writes it (PR #191 / #192 shapes)."""
    state = "completed" if status == "Completed" and (security or "Completed") == "Completed" else "running"
    rows = [f"| 📝 **Code Review** | {ICONS.get(status, '❌')} **{status}** "
            f"<relative-time datetime=\"2026-10-05T17:08:39Z\">2026-10-05T17:08:39Z</relative-time> | `{sha[:7]}` | PR opened |"]
    if security:
        rows.append(f"| 🔒 **Security Review** | **{security}** <relative-time datetime=\"2026-10-05T17:08:40Z\">x</relative-time> | `{sha[:7]}` | PR opened |")
    body = ("<!-- codex-pull-request-review-summary -->\n"
            f'<!-- codex-security-review:v1 {{"headSha":"{sha}","mergeGateEnabled":false,"status":"{state}"}} -->\n'
            "## Codex Review Summary\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n"
            + "\n".join(rows) + "\n")
    return {"body": body, "updated_at": "2026-10-05T17:08:40Z",
            "user": {"login": "chatgpt-codex-connector[bot]", "type": "Bot"}}


def thread(resolved: bool, login: str = "Jeff-Kazzee", first: int = 501) -> dict:
    return {"isResolved": resolved, "comments": {"nodes": [{"databaseId": first, "url": f"https://example.invalid/{login}",
                                                            "author": {"login": login}}]}}


class ReviewGate(unittest.TestCase):
    def check(self, comments, threads=(thread(True),), head=HEAD, base=BASE):
        return gate.evaluate(list(comments), list(threads), head, base)

    def test_missing_independent_review_is_pending(self):
        ready, pending, messages = self.check([summary("Completed", HEAD, "Completed")])
        self.assertFalse(ready)
        self.assertTrue(pending, "a Codex review alone does not satisfy the required independent review")
        self.assertIn("no independent review", messages[0])

    def test_running_independent_review_is_pending(self):
        ready, pending, _ = self.check([independent("running")])
        self.assertFalse(ready)
        self.assertTrue(pending)

    def test_failed_independent_review_blocks_without_waiting(self):
        ready, pending, messages = self.check([independent("failed")])
        self.assertFalse(ready)
        self.assertFalse(pending)
        self.assertIn("failed", messages[0])

    def test_review_of_an_earlier_head_never_passes_and_waits_for_the_final_commit(self):
        ready, pending, messages = self.check([independent("completed", sha=NEXT)])
        self.assertFalse(ready)
        self.assertTrue(pending)
        self.assertIn("not head 90765bc", messages[0])

    def test_cli_blocks_when_the_final_commit_is_never_reviewed(self):
        code, out = self._main({"head": {"sha": HEAD}, "base": {"sha": BASE}, "draft": False},
                               lambda *a: ([independent("completed", sha=NEXT)], [thread(True)]), wait="0")
        self.assertEqual(code, 1)
        self.assertIn("BLOCKED", out)

    def test_finished_failed_or_quota_limited_codex_rows_are_ignored(self):
        for status in ("Failed", "Usage limit reached", "Skipped", "Error"):
            ready, _, _ = self.check([independent("completed"), summary(status, HEAD, status)])
            self.assertTrue(ready, status)

    def test_queued_codex_review_on_the_head_waits(self):
        ready, pending, _ = self.check([independent("completed"), summary("Queued", HEAD)])
        self.assertFalse(ready)
        self.assertTrue(pending)

    def test_review_against_another_base_is_stale(self):
        ready, pending, messages = self.check([independent("completed", base=OTHER_BASE)])
        self.assertFalse(ready)
        self.assertFalse(pending)
        self.assertIn("used base 396b5f7", messages[0])

    def test_forged_result_from_another_identity_is_ignored(self):
        ready, pending, _ = self.check([independent("completed", login="random")])
        self.assertFalse(ready)
        self.assertTrue(pending)

    def test_latest_result_for_the_head_wins(self):
        old = independent("completed", at="2026-10-05T18:00:00Z")
        ready, pending, _ = self.check([old, independent("running", at="2026-10-05T18:40:00Z")])
        self.assertFalse(ready)
        self.assertTrue(pending)

    def test_running_codex_review_on_the_head_keeps_the_gate_pending(self):
        ready, pending, messages = self.check([independent("completed"), summary("Running", HEAD, "Running")])
        self.assertFalse(ready)
        self.assertTrue(pending)
        self.assertIn("Codex", messages[0])

    def test_codex_quota_notice_and_older_codex_review_are_ignored(self):
        quota = {"body": "You have reached your Codex usage limits for code reviews.", "updated_at": "x",
                 "user": {"login": "chatgpt-codex-connector[bot]", "type": "Bot"}}
        ready, _, _ = self.check([independent("completed"), quota, summary("Running", NEXT, "Running")])
        self.assertTrue(ready)

    def test_finding_without_a_thread_blocks(self):
        ready, pending, messages = self.check([independent("completed", findings=2)], [thread(True)])
        self.assertFalse(ready)
        self.assertFalse(pending)
        self.assertIn("every finding needs a thread", messages[0])

    def test_recorded_thread_that_does_not_exist_blocks(self):
        ready, pending, messages = self.check([independent("completed", findings=2, posted=(501, 777))], [thread(True)])
        self.assertFalse(ready)
        self.assertFalse(pending)
        self.assertIn("do not exist", messages[0])

    def test_recorded_thread_started_by_another_identity_blocks(self):
        ready, _, messages = self.check([independent("completed")], [thread(True, login="random")])
        self.assertFalse(ready)
        self.assertIn("do not exist", messages[0])

    def test_result_edited_by_another_identity_is_ignored(self):
        ready, pending, _ = self.check([independent("completed", editor="github-actions")])
        self.assertFalse(ready)
        self.assertTrue(pending)

    def test_result_whose_editor_is_unknown_is_ignored(self):
        comment = independent("completed")
        del comment["editor"]
        ready, pending, _ = self.check([comment])
        self.assertFalse(ready)
        self.assertTrue(pending)

    def test_review_with_no_findings_needs_no_thread(self):
        ready, _, _ = self.check([independent("completed", findings=0, posted=())], [])
        self.assertTrue(ready)

    def test_fetch_attaches_last_editor_from_graphql(self):
        responses = iter([
            [{"id": 11, "body": "x", "user": {"login": "Jeff-Kazzee"}}, {"id": 12, "body": "y", "user": {"login": "Jeff-Kazzee"}}],
            {"data": {"repository": {"pullRequest": {"comments": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": [{"databaseId": 11, "editor": None}, {"databaseId": 12, "editor": {"login": "github-actions"}}]}}}}},
            {"data": {"repository": {"pullRequest": {"reviewThreads": {"pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": []}}}}},
        ])
        with mock.patch.object(gate, "_request", side_effect=lambda *a: next(responses)):
            comments, threads = gate.fetch("o/r", 1, "x")
        self.assertIsNone(comments[0]["editor"])
        self.assertEqual(comments[1]["editor"], "github-actions")
        self.assertEqual(threads, [])

    def test_unresolved_finding_blocks_a_completed_review(self):
        ready, pending, messages = self.check([independent("completed")], [thread(True), thread(False, login="chatgpt-codex-connector[bot]", first=9)])
        self.assertFalse(ready)
        self.assertFalse(pending)
        self.assertTrue(any("unresolved review thread" in m for m in messages))

    def test_completed_review_with_resolved_threads_is_ready(self):
        ready, pending, _ = self.check([independent("completed")], [thread(True)])
        self.assertTrue(ready)
        self.assertFalse(pending)

    def _main(self, pull, fetch=None, wait="600"):
        env = {"GH_TOKEN": "x", "REPOSITORY": "o/r", "PR_NUMBER": "1", "HEAD_SHA": HEAD}
        fetch = fetch or (lambda *a: ([independent("completed")], [thread(True)]))
        pulls = pull if callable(pull) else (lambda *a: pull)
        with mock.patch.dict("os.environ", env, clear=False), \
                mock.patch.object(gate, "fetch", side_effect=fetch), \
                mock.patch.object(gate, "fetch_pull", side_effect=pulls), \
                mock.patch.object(gate.time, "sleep"), \
                mock.patch.object(sys, "argv", ["check_review_gate.py", "--wait-seconds", wait, "--interval", "1"]), \
                redirect_stdout(io.StringIO()) as out:
            return gate.main(), out.getvalue()

    def test_cli_waits_while_running_then_passes(self):
        results = iter([([independent("running")], []), ([independent("completed")], [thread(True)])])
        code, out = self._main({"head": {"sha": HEAD}, "base": {"sha": BASE}, "draft": False}, lambda *a: next(results))
        self.assertEqual(code, 0)
        self.assertIn("READY", out)

    def test_cli_fails_without_waiting_on_unresolved_threads(self):
        calls = []
        def fetch(*a):
            calls.append(a)
            return [independent("completed")], [thread(False)]
        code, out = self._main({"head": {"sha": HEAD}, "base": {"sha": BASE}, "draft": False}, fetch)
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1)
        self.assertIn("BLOCKED", out)

    def test_cli_binds_review_to_the_live_base(self):
        code, out = self._main({"head": {"sha": HEAD}, "base": {"sha": OTHER_BASE}, "draft": False})
        self.assertEqual(code, 1)
        self.assertIn("used base", out)

    def test_head_that_is_not_the_live_head_is_blocked(self):
        code, out = self._main({"head": {"sha": NEXT}, "base": {"sha": BASE}, "draft": False})
        self.assertEqual(code, 1)
        self.assertIn("not PR #1's live head", out)

    def test_draft_pull_request_is_blocked(self):
        code, out = self._main({"head": {"sha": HEAD}, "base": {"sha": BASE}, "draft": True})
        self.assertEqual(code, 1)
        self.assertIn("draft", out)

    def test_client_error_fails_without_retrying(self):
        def refuse(*a):
            raise gate.urllib.error.HTTPError("u", 403, "Forbidden", {}, None)
        code, _ = self._main(refuse)
        self.assertEqual(code, 1)

    def test_rate_limited_403_is_retried(self):
        for headers in ({"x-ratelimit-remaining": "0"}, {"retry-after": "60"}):
            calls = iter([gate.urllib.error.HTTPError("u", 403, "Forbidden", headers, None),
                          {"head": {"sha": HEAD}, "base": {"sha": BASE}, "draft": False}])
            def pull(*a):
                item = next(calls)
                if isinstance(item, Exception):
                    raise item
                return item
            code, out = self._main(pull)
            self.assertEqual(code, 0, headers)
            self.assertIn("retrying after API error: HTTP 403", out)

    def test_transient_pull_lookup_error_is_retried(self):
        calls = iter([OSError("reset"), {"head": {"sha": HEAD}, "base": {"sha": BASE}, "draft": False}])
        def pull(*a):
            item = next(calls)
            if isinstance(item, Exception):
                raise item
            return item
        code, out = self._main(pull)
        self.assertEqual(code, 0)
        self.assertIn("retrying after API error", out)

    def test_bootstrap_runs_only_when_the_base_has_no_gate_script(self):
        real = (Path(__file__).resolve().parents[2] / ".github/workflows/review-gate.yml").read_text(encoding="utf-8")
        script = real.rsplit("run: |\n", 1)[1]
        script = "\n".join(line[10:] for line in script.splitlines())
        for base_has_script, expected in ((True, "base/scripts"), (False, "bootstrap/scripts")):
            with tempfile.TemporaryDirectory() as root:
                for side in ("base", "bootstrap"):
                    folder = Path(root, side, "scripts")
                    folder.mkdir(parents=True)
                    if side == "bootstrap" or base_has_script:
                        (folder / "check_review_gate.py").write_text(f"import sys; print('{side}/scripts', sys.argv[1:])\n")
                result = subprocess.run(["bash", "-e", "-c", script.replace("python ", sys.executable + " ")],
                                        cwd=root, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(expected, result.stdout)
                self.assertIn("'--wait-seconds', '2400'", result.stdout)
                self.assertEqual("pinned bootstrap" in result.stdout, not base_has_script)

    def test_bootstrap_checkout_runs_only_when_the_base_lacks_the_script(self):
        real = (Path(__file__).resolve().parents[2] / ".github/workflows/review-gate.yml").read_text(encoding="utf-8")
        probe = real.split("      - name: find the base commit's gate script\n", 1)[1].split("run: |\n", 1)[1]
        probe = "\n".join(line[10:] for line in probe.split("      - if:", 1)[0].splitlines())
        for base_has_script, expected in ((True, "missing=false"), (False, "missing=true")):
            with tempfile.TemporaryDirectory() as root:
                Path(root, "base", "scripts").mkdir(parents=True)
                if base_has_script:
                    Path(root, "base", "scripts", "check_review_gate.py").write_text("")
                output = Path(root, "out")
                result = subprocess.run(["bash", "-e", "-c", probe], cwd=root, env={"GITHUB_OUTPUT": str(output)})
                self.assertEqual(result.returncode, 0)
                self.assertEqual(output.read_text().strip(), expected)

    def test_bootstrap_failure_fails_the_step(self):
        real = (Path(__file__).resolve().parents[2] / ".github/workflows/review-gate.yml").read_text(encoding="utf-8")
        script = "\n".join(line[10:] for line in real.rsplit("run: |\n", 1)[1].splitlines())
        with tempfile.TemporaryDirectory() as root:
            Path(root, "bootstrap", "scripts").mkdir(parents=True)
            Path(root, "bootstrap", "scripts", "check_review_gate.py").write_text("raise SystemExit(1)\n")
            result = subprocess.run(["bash", "-e", "-c", script.replace("python ", sys.executable + " ")], cwd=root)
            self.assertEqual(result.returncode, 1)

    def test_review_workflow_contract_rejects_weakening(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import check_ci_workflow as contract
        real = (Path(__file__).resolve().parents[2] / ".github/workflows/review-gate.yml").read_text(encoding="utf-8")
        contract.check_review_workflow(real)
        BOOTSTRAP = re.search(r"ref: ([0-9a-f]{40})\n", real).group(1)
        self.assertIn("      - if: steps.base.outputs.missing == 'true'\n        uses: actions/checkout@v7.0.1\n        with:\n          ref: " + BOOTSTRAP, real)
        weakened = {
            "push": real.replace("on:\n  pull_request:\n", "on:\n  push:\n  pull_request:\n"),
            "dispatch": real + "  workflow_dispatch:\n",
            "base script": real.replace("ref: ${{ github.event.pull_request.base.sha }}", "ref: ${{ github.event.pull_request.head.sha }}"),
            "no wait": real.replace("--wait-seconds 2400", "--wait-seconds 0"),
            "or true": real.replace("--interval 30\n", "--interval 30 || true\n"),
            "conditional": real.replace("      - name: wait for completed reviews", "      - if: false\n        name: wait for completed reviews"),
            "renamed": real.replace("name: required review gate", "name: review gate (optional)"),
            "no edited": real.replace(", edited]", "]"),
            "extra step": real.replace("      - uses: actions/setup-python@v7\n", "      - run: echo exit 0 > scripts/check_review_gate.py\n      - uses: actions/setup-python@v7\n"),
            "head checkout": real.replace("persist-credentials: false", "persist-credentials: true"),
            "bootstrap from head": real.replace("ref: " + BOOTSTRAP, "ref: ${{ github.event.pull_request.head.sha }}"),
            "bootstrap branch": real.replace("ref: " + BOOTSTRAP, "ref: dev"),
            "unconditional bootstrap": real.replace("      - if: steps.base.outputs.missing == 'true'\n        uses:", "      - uses:"),
            "always missing": real.replace('echo "missing=false"', 'echo "missing=true"'),
            "head script": real.replace("gate=bootstrap/scripts/check_review_gate.py", "gate=scripts/check_review_gate.py"),
            "no concurrency": real.replace("concurrency:\n", "noconcurrency:\n"),
        }
        for label, text in weakened.items():
            with self.assertRaises(SystemExit, msg=label):
                contract.check_review_workflow(text)


if __name__ == "__main__":
    unittest.main()
