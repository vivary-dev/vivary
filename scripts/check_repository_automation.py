"""Fail closed when repository stewardship automation loses its bounds."""

from pathlib import Path


TRACK_STATS = Path(".github/workflows/track-stats.yml")
STEWARD = Path(".github/workflows/steward.yml")
DEPENDABOT = Path(".github/dependabot.yml")


def require(condition: bool, path: Path, message: str) -> None:
    if not condition:
        raise SystemExit(f"{path}: {message}")


def main() -> None:
    track = TRACK_STATS.read_text(encoding="utf-8")
    steward = STEWARD.read_text(encoding="utf-8")
    dependabot = DEPENDABOT.read_text(encoding="utf-8")

    require("  actions: write" in track, TRACK_STATS, "stats must be able to dispatch CI")
    require(
        "          GITHUB_TOKEN: ${{ github.token }}" in track,
        TRACK_STATS,
        "stats fetch must receive GITHUB_TOKEN",
    )
    dispatch = 'gh workflow run ci.yml --ref "$BRANCH"'
    require(
        dispatch in track,
        TRACK_STATS,
        'stats PR must use gh workflow run ci.yml --ref "$BRANCH"',
    )
    for binding in (
        '-f head_sha="$HEAD_SHA"',
        '-f base_sha="$BASE_SHA"',
        '-f pull_request_number="$PR_NUMBER"',
    ):
        require(binding in track, TRACK_STATS, f"stats CI dispatch must include {binding}")
    health_gate = '--fail-on-findings; then\n              LIFECYCLE="automated-current"'
    merge_gate = 'if [ "$LIFECYCLE" = "automated-current" ]; then'
    auto_merge = 'gh pr merge "$BRANCH" --auto --merge'
    require(health_gate in track, TRACK_STATS, "stats auto-merge must be health-gated")
    require(auto_merge in track, TRACK_STATS, "healthy stats should request auto-merge")
    require(
        track.index(health_gate) < track.index(dispatch) < track.index(merge_gate) < track.index(auto_merge),
        TRACK_STATS,
        "every classified stats PR must dispatch before the health-gated auto-merge",
    )
    require(
        track.count('--label "$LIFECYCLE"') == 1
        and 'LIFECYCLE="automated-current"' in track
        and 'LIFECYCLE="blocked"' in track,
        TRACK_STATS,
        "every stats PR must receive exactly one health-derived lifecycle label",
    )
    require(
        "gh label list --limit 1000" in track
        and "for REQUIRED_LABEL in automated-current blocked" in track,
        TRACK_STATS,
        "stats automation must fail before push when lifecycle labels are unavailable",
    )
    require(
        "concurrency:\n  group: track-stats\n  cancel-in-progress: false" in track,
        TRACK_STATS,
        "stats PR creation and replacement must be serialized by concurrency",
    )
    older_only = "select(.number < "
    health_else = track.index("            else", track.index(merge_gate))
    require(
        older_only in track
        and track.index(merge_gate) < track.index(older_only) < health_else,
        TRACK_STATS,
        "only a healthy run may supersede provably older stats PRs",
    )
    require(
        "--delete-branch" not in track,
        TRACK_STATS,
        "stats supersession must leave branch deletion at the destructive gate",
    )

    require(
        "--limit 1000" in steward,
        STEWARD,
        "steward must collect the complete open PR queue",
    )
    require(
        "--json number,title,author,labels,mergeStateStatus,statusCheckRollup" in steward,
        STEWARD,
        "steward must collect PR identity, lifecycle, merge, and check state",
    )
    require(
        "python3 tools/steward_health.py" in steward,
        STEWARD,
        "steward must delegate clean-state decisions to steward_health.py",
    )
    require("createdAt" not in steward, STEWARD, "PR age alone is not a lifecycle class")
    require("259200" not in steward, STEWARD, "generic three-day PR expiry is forbidden")

    require(
        dependabot.count('package-ecosystem:') == 3,
        DEPENDABOT,
        "Dependabot must have exactly three ecosystem queues",
    )
    require(
        dependabot.count("open-pull-requests-limit: 2") == 3
        and "open-pull-requests-limit: 5" not in dependabot,
        DEPENDABOT,
        "Dependabot version queues must have a six-PR ceiling",
    )
    for directory in (
        "/packages/create-vivary",
        "/packages/tropo",
        "/packages/ozone",
        "/packages/exo",
    ):
        require(directory in dependabot, DEPENDABOT, f"Python queue must include {directory}")
    require(
        'versioning-strategy: "increase-if-necessary"' in dependabot,
        DEPENDABOT,
        "Python minimum floors must use increase-if-necessary",
    )
    require(
        dependabot.count('- "automated-current"') == 3,
        DEPENDABOT,
        "every Dependabot ecosystem must declare the automated-current lifecycle",
    )
    require(
        dependabot.count("default-days: 7") == 3,
        DEPENDABOT,
        "every version queue must use the seven-day cooldown",
    )
    require(
        dependabot.count('applies-to: "security-updates"') == 3,
        DEPENDABOT,
        "each ecosystem must group security updates separately",
    )

    print("repository automation contract passed")


if __name__ == "__main__":
    main()
