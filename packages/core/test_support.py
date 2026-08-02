"""Shared test doubles for core observation suites."""

from __future__ import annotations

from typing import Any, Callable, Dict, List


def content_git_runner(grep_stdout: str) -> Callable[[str, List[str]], Dict[str, Any]]:
    """Return an honest runner for content grep, revision, and ignore calls."""

    def run_git(_path: str, args: List[str]) -> Dict[str, Any]:
        command = "git " + " ".join(args)
        if "check-ignore" in args:
            return {
                "ok": False,
                "stdout": "",
                "stderr": "",
                "code": 1,
                "command": command,
            }
        if args and args[0] == "ls-tree":
            return {
                "ok": True,
                "stdout": "",
                "stderr": "",
                "code": 0,
                "command": command,
            }
        if "rev-parse" in args:
            return {
                "ok": True,
                "stdout": "a" * 40 + "\n",
                "code": 0,
                "command": command,
            }
        if args and args[0] == "grep":
            return {
                "ok": True,
                "stdout": grep_stdout,
                "code": 0,
                "command": command,
            }
        raise AssertionError(f"unexpected git command: {command}")

    return run_git
