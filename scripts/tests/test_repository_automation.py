"""Regression tests for bounded stats and stewardship automation."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts" / "check_repository_automation.py"
REAL_FILES = {
    "track": ROOT / ".github" / "workflows" / "track-stats.yml",
    "steward": ROOT / ".github" / "workflows" / "steward.yml",
    "dependabot": ROOT / ".github" / "dependabot.yml",
}


def _load():
    spec = importlib.util.spec_from_file_location("repository_automation", GUARD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(changes=None):
    module = _load()
    changes = changes or {}
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        paths = {}
        for name, source in REAL_FILES.items():
            path = root / source.name
            text = source.read_text(encoding="utf-8")
            path.write_text(changes.get(name, text), encoding="utf-8")
            paths[name] = path
        module.TRACK_STATS = paths["track"]
        module.STEWARD = paths["steward"]
        module.DEPENDABOT = paths["dependabot"]
        try:
            module.main()
        except SystemExit as exc:
            return str(exc)
    return None


def test_real_repository_automation_contract_passes():
    assert _run() is None


def test_stats_fetch_must_receive_repository_token():
    track = REAL_FILES["track"].read_text(encoding="utf-8").replace(
        "          GITHUB_TOKEN: ${{ github.token }}\n",
        "",
        1,
    )
    message = _run({"track": track})
    assert message
    assert "GITHUB_TOKEN" in message


def test_stats_pr_requires_exact_head_ci_dispatch():
    track = REAL_FILES["track"].read_text(encoding="utf-8").replace(
        'gh workflow run ci.yml --ref "$BRANCH"',
        'echo "CI dispatch skipped"',
    )
    message = _run({"track": track})
    assert message
    assert "workflow run ci.yml" in message


def test_every_stats_pr_is_dispatched_but_only_clean_stats_enable_auto_merge():
    track = REAL_FILES["track"].read_text(encoding="utf-8").replace(
        "--fail-on-findings",
        "--ignore-findings",
        1,
    )
    message = _run({"track": track})
    assert message
    assert "health" in message.lower()


def test_stats_pr_receives_exactly_one_lifecycle_label():
    track = REAL_FILES["track"].read_text(encoding="utf-8").replace(
        '--label "$LIFECYCLE"',
        'echo "classification skipped"',
    )
    message = _run({"track": track})
    assert message
    assert "lifecycle" in message.lower()


def test_stats_stops_before_push_when_lifecycle_labels_are_unavailable():
    track = REAL_FILES["track"].read_text(encoding="utf-8").replace(
        "gh label list --limit 1000",
        "echo labels-unchecked",
    )
    message = _run({"track": track})
    assert message
    assert "label" in message.lower()


def test_stats_runs_are_serialized_and_only_older_prs_are_superseded():
    track = REAL_FILES["track"].read_text(encoding="utf-8")
    for old, new in (
        ("concurrency:\n  group: track-stats", "concurrency: {}"),
        ("select(.number < ", "select(.number != "),
    ):
        message = _run({"track": track.replace(old, new, 1)})
        assert message
        assert "concurrency" in message.lower() or "older" in message.lower()


def test_steward_delegates_snapshot_and_pr_classification():
    steward = REAL_FILES["steward"].read_text(encoding="utf-8").replace(
        "python3 tools/steward_health.py",
        "echo steward decision skipped",
    )
    message = _run({"steward": steward})
    assert message
    assert "steward_health.py" in message


def test_steward_collects_the_complete_open_pr_queue():
    steward = REAL_FILES["steward"].read_text(encoding="utf-8").replace(
        "gh pr list --state open --limit 1000",
        "gh pr list --state open",
    )
    message = _run({"steward": steward})
    assert message
    assert "complete" in message.lower()


def test_dependabot_queue_ceiling_is_six_version_prs():
    dependabot = REAL_FILES["dependabot"].read_text(encoding="utf-8").replace(
        "open-pull-requests-limit: 2",
        "open-pull-requests-limit: 5",
        1,
    )
    message = _run({"dependabot": dependabot})
    assert message
    assert "six" in message.lower()


def test_python_updates_preserve_minimum_floor_policy():
    dependabot = REAL_FILES["dependabot"].read_text(encoding="utf-8").replace(
        'versioning-strategy: "increase-if-necessary"',
        'versioning-strategy: "increase"',
    )
    message = _run({"dependabot": dependabot})
    assert message
    assert "increase-if-necessary" in message



def _ci_contract():
    checker = GUARD.with_name("check_ci_workflow.py")
    spec = importlib.util.spec_from_file_location("automation_runtime_contract", checker)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_owned_automation_admits_runner_before_first_checkout():
    bootstrap = _ci_contract().runner_bootstrap_step()
    for name in ("track", "steward"):
        text = REAL_FILES[name].read_text(encoding="utf-8")
        assert text.split("    steps:\n", 1)[1].startswith(bootstrap), name


def test_owned_automation_rejects_missing_skipped_changed_or_late_bootstrap():
    bootstrap = _ci_contract().runner_bootstrap_step()
    for name in ("track", "steward"):
        text = REAL_FILES[name].read_text(encoding="utf-8")
        for unsafe in (
            text.replace(bootstrap, "", 1),
            text.replace("        shell: python -I -B {0}\n",
                         "        if: false\n        shell: python -I -B {0}\n", 1),
            text.replace("        shell: python -I -B {0}\n",
                         "        continue-on-error: true\n        shell: python -I -B {0}\n", 1),
            text.replace("    steps:\n", "    steps:\n      - run: echo before admission\n", 1),
            text.replace("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
                         "actions/checkout@v7.0.1", 1),
        ):
            message = _run({name: unsafe})
            assert message, name + " must retain unconditional first-step runtime admission"

if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    passed = 0
    for test in tests:
        try:
            test()
            print(f"  ok  {test.__name__}")
            passed += 1
        except Exception as exc:
            print(f"FAIL  {test.__name__}: {exc}")
    print(f"\n{passed}/{len(tests)} passed")
    sys.exit(0 if passed == len(tests) else 1)
