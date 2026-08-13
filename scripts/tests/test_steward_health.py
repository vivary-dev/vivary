"""Behavior tests for the repository steward's clean-state decision."""

from __future__ import annotations

import importlib.util
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "tools" / "steward_health.py"


def _load():
    spec = importlib.util.spec_from_file_location("steward_health", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _snapshot(**updates):
    value = {
        "date": "2026-08-12",
        "status": "ok",
        "warnings": [],
        "npm": {"packages": {"@vivary/create": {"stale": False}}},
        "pypi": {"packages": {"vivary-tropo": {"stale": False}}},
        "github": {"stale": False},
    }
    value.update(updates)
    return value


def _pr(number=1, author="app/dependabot", labels=None):
    return {
        "number": number,
        "title": "Update dependency",
        "author": {"login": author},
        "labels": [{"name": label} for label in (labels or [])],
        "mergeStateStatus": "CLEAN",
        "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "ci", "conclusion": "SUCCESS"}
        ],
    }


def test_fresh_healthy_snapshot_has_no_findings():
    module = _load()
    assert module.snapshot_findings(_snapshot(), date(2026, 8, 13)) == []


def test_snapshot_rejects_old_future_stale_and_warning_states():
    module = _load()
    old = module.snapshot_findings(_snapshot(date="2026-08-01"), date(2026, 8, 13))
    future = module.snapshot_findings(_snapshot(date="2026-08-14"), date(2026, 8, 13))
    stale = module.snapshot_findings(
        _snapshot(status="stale", warnings=["source failed"]),
        date(2026, 8, 13),
    )

    assert any("days old" in finding for finding in old)
    assert any("future" in finding for finding in future)
    assert any("status is stale" in finding for finding in stale)
    assert any("warnings" in finding for finding in stale)


def test_snapshot_rejects_nested_stale_source_even_without_warning():
    module = _load()
    snapshot = _snapshot()
    snapshot["pypi"]["packages"]["vivary-tropo"]["stale"] = True
    findings = module.snapshot_findings(snapshot, date(2026, 8, 13))
    assert any("stale source" in finding for finding in findings)


def test_every_pr_needs_exactly_one_known_lifecycle_label():
    module = _load()
    missing = module.pull_request_findings([_pr(labels=["dependencies"])])
    multiple = module.pull_request_findings(
        [_pr(labels=["active", "automated-current"])]
    )
    unknown = module.pull_request_findings([_pr(labels=["steward:unknown"])])

    assert any("exactly one lifecycle" in finding for finding in missing)
    assert any("exactly one lifecycle" in finding for finding in multiple)
    assert any("exactly one lifecycle" in finding for finding in unknown)


def test_automated_current_is_limited_to_known_bot_identities():
    module = _load()
    valid = module.pull_request_findings(
        [
            _pr(author="app/dependabot", labels=["automated-current"]),
            _pr(number=2, author="app/github-actions", labels=["automated-current"]),
        ]
    )
    invalid = module.pull_request_findings(
        [_pr(author="human", labels=["automated-current"])]
    )

    assert valid == []
    assert any("requires a trusted bot" in finding for finding in invalid)


def test_automated_current_with_failed_gate_must_be_blocked():
    module = _load()
    pr = _pr(labels=["automated-current"])
    pr["statusCheckRollup"][0]["conclusion"] = "FAILURE"

    findings = module.pull_request_findings([pr])

    assert any("failing gate" in finding and "blocked" in finding for finding in findings)


def test_automated_current_with_merge_conflict_must_be_blocked():
    module = _load()
    pr = _pr(labels=["automated-current"])
    pr["mergeStateStatus"] = "DIRTY"

    findings = module.pull_request_findings([pr])

    assert any("merge conflict" in finding and "blocked" in finding for finding in findings)


def test_actionable_lifecycle_classes_remain_findings():
    module = _load()
    for lifecycle in (
        "blocked",
        "superseded",
        "close-with-receipt",
        "needs-human-decision",
    ):
        findings = module.pull_request_findings([_pr(labels=[lifecycle])])
        assert any(lifecycle in finding for finding in findings)


def test_active_pr_is_clean_for_stewardship_purposes():
    module = _load()
    assert module.pull_request_findings(
        [_pr(author="maintainer", labels=["active"])]
    ) == []
