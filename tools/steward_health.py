"""Evaluate whether stats and the pull-request queue are genuinely clean."""

from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path
from typing import Any


LIFECYCLE_LABELS = {
    "active",
    "blocked",
    "superseded",
    "automated-current",
    "close-with-receipt",
    "needs-human-decision",
}
ACTIONABLE_LABELS = {
    "blocked",
    "superseded",
    "close-with-receipt",
    "needs-human-decision",
}
AUTOMATED_AUTHORS = {
    "app/dependabot",
    "app/github-actions",
    "dependabot[bot]",
    "github-actions[bot]",
}
FAILED_CHECK_CONCLUSIONS = {
    "ACTION_REQUIRED",
    "CANCELLED",
    "FAILURE",
    "STALE",
    "STARTUP_FAILURE",
    "TIMED_OUT",
}
FAILED_STATUS_STATES = {"ERROR", "FAILURE"}


def _stale_paths(value: Any, path: str = "snapshot") -> list[str]:
    findings: list[str] = []
    if isinstance(value, dict):
        if value.get("stale") is True:
            findings.append(path)
        for key, child in value.items():
            findings.extend(_stale_paths(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            findings.extend(_stale_paths(child, f"{path}[{index}]"))
    return findings


def snapshot_findings(
    snapshot: dict[str, Any],
    today: date,
    max_age_days: int = 2,
) -> list[str]:
    findings: list[str] = []
    try:
        snapshot_date = date.fromisoformat(str(snapshot["date"]))
    except (KeyError, TypeError, ValueError):
        findings.append("stats/latest.json has an invalid date")
    else:
        age = (today - snapshot_date).days
        if age < 0:
            findings.append(
                f"stats/latest.json date is in the future ({snapshot_date.isoformat()})"
            )
        elif age > max_age_days:
            findings.append(
                f"stats/latest.json is {age} days old ({snapshot_date.isoformat()})"
            )

    status = snapshot.get("status")
    if status != "ok":
        findings.append(f"stats/latest.json status is {status or 'missing'}")

    warnings = snapshot.get("warnings")
    if warnings != []:
        count = len(warnings) if isinstance(warnings, list) else "invalid"
        findings.append(f"stats/latest.json contains {count} warnings")

    stale = sorted(set(_stale_paths(snapshot)))
    if stale:
        findings.append(f"stats/latest.json has stale source data: {', '.join(stale)}")
    return findings


def pull_request_findings(prs: list[dict[str, Any]]) -> list[str]:
    findings: list[str] = []
    for pr in prs:
        number = pr.get("number", "?")
        title = pr.get("title", "untitled")
        labels = {
            label.get("name")
            for label in pr.get("labels", [])
            if isinstance(label, dict)
        }
        lifecycle = sorted(LIFECYCLE_LABELS & labels)
        if len(lifecycle) != 1:
            findings.append(
                f"open PR #{number} needs exactly one lifecycle label: {title}"
            )
            continue

        classification = lifecycle[0]
        author = (pr.get("author") or {}).get("login")
        if classification == "automated-current" and author not in AUTOMATED_AUTHORS:
            findings.append(
                f"open PR #{number} automated-current requires a trusted bot author"
            )
        elif classification == "automated-current":
            if pr.get("mergeStateStatus") == "DIRTY":
                findings.append(
                    f"open PR #{number} must be blocked: merge conflict: {title}"
                )
                continue
            failed_checks = []
            for check in pr.get("statusCheckRollup") or []:
                outcome = check.get("conclusion") or check.get("state")
                if outcome in FAILED_CHECK_CONCLUSIONS | FAILED_STATUS_STATES:
                    failed_checks.append(
                        check.get("name") or check.get("context") or "unknown"
                    )
            if failed_checks:
                findings.append(
                    f"open PR #{number} must be blocked: failing gate(s) "
                    f"{', '.join(sorted(failed_checks))}: {title}"
                )
        elif classification in ACTIONABLE_LABELS:
            findings.append(
                f"open PR #{number} remains {classification}: {title}"
            )
    return findings


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--prs", type=Path)
    parser.add_argument("--today", type=date.fromisoformat, default=date.today())
    parser.add_argument("--fail-on-findings", action="store_true")
    args = parser.parse_args()

    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    prs = json.loads(args.prs.read_text(encoding="utf-8")) if args.prs else []
    findings = snapshot_findings(snapshot, args.today) + pull_request_findings(prs)
    for finding in findings:
        print(f"- {finding}")
    if findings and args.fail_on_findings:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
