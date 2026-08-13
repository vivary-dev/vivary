"""Fetch public Vivary stats and render the README usage snapshot."""

from __future__ import annotations

import csv
import html
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
STATS_DIR = ROOT / "stats"
LATEST_PATH = STATS_DIR / "latest.json"
HISTORY_PATH = STATS_DIR / "history.csv"
SVG_PATH = STATS_DIR / "usage-snapshot.svg"
SITE_SVG_PATH = ROOT / "site" / "public" / "usage-snapshot.svg"

NPM_PACKAGES = ["@vivary/create"]
PYPI_PACKAGES = ["create-vivary", "vivary-tropo", "vivary-ozone", "vivary-exo"]
HEADER = [
    "date",
    "npm_weekly",
    "pypi_weekly",
    "package_weekly",
    "github_stars",
    "github_forks",
    "github_open_issues",
    "stale_sources",
]


class FetchError(RuntimeError):
    pass


def write_text_lf(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def headers_for_url(
    url: str,
    *,
    github_token: str | None = None,
) -> dict[str, str]:
    """Return public-API headers without forwarding GitHub credentials elsewhere."""
    headers = {
        "Accept": "application/json",
        "User-Agent": "vivary-stats/2.0 (+https://github.com/vivary-dev/vivary)",
    }
    token = github_token or os.environ.get("GITHUB_TOKEN")
    if urllib.parse.urlsplit(url).hostname == "api.github.com" and token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def retry_delay(
    error: Exception,
    fallback: float,
    *,
    maximum: float = 30.0,
) -> float:
    """Honor numeric Retry-After while keeping every wait bounded."""
    retry_after = None
    if isinstance(error, urllib.error.HTTPError) and error.headers is not None:
        retry_after = error.headers.get("Retry-After")
    try:
        requested = float(retry_after) if retry_after is not None else fallback
    except (TypeError, ValueError):
        requested = fallback
    return max(0.0, min(requested, maximum))


def fetch_json(
    url: str,
    *,
    attempts: int = 3,
    opener=urllib.request.urlopen,
    sleeper=time.sleep,
    github_token: str | None = None,
) -> dict[str, Any]:
    delay = 2.0
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(
                url,
                headers=headers_for_url(url, github_token=github_token),
            )
            with opener(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_error = exc
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            if exc.code not in {429, 500, 502, 503, 504} and not (
                exc.code == 403 and retry_after is not None
            ):
                break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
        if attempt < attempts:
            sleeper(retry_delay(last_error or FetchError(url), delay))
            delay *= 2
    raise FetchError(f"{url} -> {last_error}")


def previous_snapshot() -> dict[str, Any]:
    if not LATEST_PATH.exists():
        return {}
    try:
        return json.loads(LATEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def lookup_previous(previous: dict[str, Any], *path: str) -> Any:
    cursor: Any = previous
    for part in path:
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(part)
    return cursor


def previous_int(previous: dict[str, Any], fallback_key: str, *path: str) -> int | None:
    value = lookup_previous(previous, *path)
    if value is None and fallback_key:
        value = previous.get(fallback_key)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def source_warning(warnings: list[str], name: str, error: Exception, previous_value: int | None) -> int:
    if previous_value is None:
        raise FetchError(f"{name} failed and no previous value exists: {error}") from error
    warnings.append(f"{name}: stale previous value used after fetch failure ({error})")
    return previous_value


def npm_snapshot(previous: dict[str, Any], warnings: list[str]) -> dict[str, Any]:
    packages: dict[str, Any] = {}
    total = 0
    for package in NPM_PACKAGES:
        encoded = package.replace("/", "%2F")
        source = f"npm:{package}"
        try:
            point = fetch_json(f"https://api.npmjs.org/downloads/point/last-week/{encoded}")
            versions = fetch_json(f"https://api.npmjs.org/versions/{encoded}/last-week")
            downloads = int(point["downloads"])
            stale = False
        except Exception as exc:
            downloads = source_warning(
                warnings,
                source,
                exc,
                previous_int(previous, "npm_weekly", "npm", "packages", package, "last_week"),
            )
            point = {}
            versions = {"downloads": lookup_previous(previous, "npm", "packages", package, "versions_last_week") or {}}
            stale = True
        total += downloads
        packages[package] = {
            "last_week": downloads,
            "start": point.get("start"),
            "end": point.get("end"),
            "versions_last_week": versions.get("downloads") or {},
            "stale": stale,
        }
    return {"weekly_total": total, "packages": packages}


def pypi_snapshot(previous: dict[str, Any], warnings: list[str]) -> dict[str, Any]:
    packages: dict[str, Any] = {}
    total = 0
    for index, package in enumerate(PYPI_PACKAGES):
        if index:
            time.sleep(1.0)
        source = f"pypi:{package}"
        try:
            data = fetch_json(f"https://pypistats.org/api/packages/{package}/recent")["data"]
            last_week = int(data["last_week"])
            package_data = {
                "last_day": int(data["last_day"]),
                "last_week": last_week,
                "last_month": int(data["last_month"]),
                "stale": False,
            }
        except Exception as exc:
            last_week = source_warning(
                warnings,
                source,
                exc,
                previous_int(previous, "", "pypi", "packages", package, "last_week"),
            )
            package_data = {
                "last_day": previous_int(previous, "", "pypi", "packages", package, "last_day"),
                "last_week": last_week,
                "last_month": previous_int(previous, "", "pypi", "packages", package, "last_month"),
                "stale": True,
            }
        total += last_week
        packages[package] = package_data
    return {"weekly_total": total, "packages": packages}


def github_snapshot(previous: dict[str, Any], warnings: list[str]) -> dict[str, Any]:
    try:
        repo = fetch_json("https://api.github.com/repos/vivary-dev/vivary")
        return {
            "stars": int(repo.get("stargazers_count") or 0),
            "forks": int(repo.get("forks_count") or 0),
            "watchers": int(repo.get("subscribers_count") or 0),
            "open_issues": int(repo.get("open_issues_count") or 0),
            "pushed_at": repo.get("pushed_at"),
            "stale": False,
        }
    except Exception as exc:
        stars = source_warning(warnings, "github:repo", exc, previous_int(previous, "github_stars", "github", "stars"))
        forks = previous_int(previous, "github_forks", "github", "forks")
        return {
            "stars": stars,
            "forks": forks if forks is not None else 0,
            "watchers": previous_int(previous, "", "github", "watchers"),
            "open_issues": previous_int(previous, "", "github", "open_issues"),
            "pushed_at": lookup_previous(previous, "github", "pushed_at"),
            "stale": True,
        }


def current_snapshot() -> dict[str, Any]:
    previous = previous_snapshot()
    warnings: list[str] = []
    generated_at = datetime.now(UTC).replace(microsecond=0)
    npm = npm_snapshot(previous, warnings)
    pypi = pypi_snapshot(previous, warnings)
    github = github_snapshot(previous, warnings)
    package_weekly = npm["weekly_total"] + pypi["weekly_total"]

    return {
        "date": generated_at.date().isoformat(),
        "generated_at": generated_at.isoformat().replace("+00:00", "Z"),
        "status": "stale" if warnings else "ok",
        "warnings": warnings,
        "npm": npm,
        "pypi": pypi,
        "github": github,
        "totals": {
            "npm_weekly": npm["weekly_total"],
            "pypi_weekly": pypi["weekly_total"],
            "package_weekly": package_weekly,
        },
        "npm_weekly": npm["weekly_total"],
        "pypi_weekly": pypi["weekly_total"],
        "github_stars": github["stars"],
        "github_forks": github["forks"],
    }


def read_history() -> list[dict[str, str]]:
    if not HISTORY_PATH.exists():
        return []
    with HISTORY_PATH.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def history_row(snapshot: dict[str, Any]) -> dict[str, str]:
    return {
        "date": snapshot["date"],
        "npm_weekly": str(snapshot["totals"]["npm_weekly"]),
        "pypi_weekly": str(snapshot["totals"]["pypi_weekly"]),
        "package_weekly": str(snapshot["totals"]["package_weekly"]),
        "github_stars": str(snapshot["github"]["stars"]),
        "github_forks": str(snapshot["github"]["forks"]),
        "github_open_issues": str(snapshot["github"]["open_issues"]),
        "stale_sources": ";".join(snapshot["warnings"]),
    }


def write_stats(snapshot: dict[str, Any]) -> list[dict[str, str]]:
    STATS_DIR.mkdir(exist_ok=True)
    write_text_lf(LATEST_PATH, json.dumps(snapshot, indent=2, sort_keys=True) + "\n")

    rows = [
        {key: row.get(key, "") for key in HEADER}
        for row in read_history()
        if row.get("date") != snapshot["date"]
    ]
    rows.append(history_row(snapshot))
    rows.sort(key=lambda row: row["date"])

    with HISTORY_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=HEADER, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    return rows


def bar(width: int, value: int, scale: int) -> int:
    if scale <= 0:
        return 0
    return max(2, round(width * value / scale))


def render_svg(snapshot: dict[str, Any], rows: list[dict[str, str]]) -> str:
    npm = int(snapshot["totals"]["npm_weekly"])
    pypi = int(snapshot["totals"]["pypi_weekly"])
    package_weekly = int(snapshot["totals"]["package_weekly"])
    stars = int(snapshot["github"]["stars"])
    forks = int(snapshot["github"]["forks"])
    issues = int(snapshot["github"]["open_issues"] or 0)
    scale = max(npm, pypi, 1)
    max_width = 420
    npm_width = bar(max_width, npm, scale)
    pypi_width = bar(max_width, pypi, scale)
    history_count = len(rows)
    date = html.escape(str(snapshot["date"]))
    status = html.escape(str(snapshot["status"]))

    return f"""<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 760 300">
  <title id="title">Vivary public usage snapshot</title>
  <desc id="desc">Weekly npm and PyPI downloads plus GitHub repo signals, generated from public package and GitHub APIs.</desc>
  <style>
    .bg {{ fill: #101923; }}
    .panel {{ fill: #162532; stroke: #2b4655; stroke-width: 1; }}
    .muted {{ fill: #9fb3bd; font: 14px system-ui, -apple-system, Segoe UI, sans-serif; }}
    .small {{ fill: #9fb3bd; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }}
    .label {{ fill: #eef8f3; font: 600 15px system-ui, -apple-system, Segoe UI, sans-serif; }}
    .value {{ fill: #eef8f3; font: 700 26px system-ui, -apple-system, Segoe UI, sans-serif; }}
    .bar-npm {{ fill: #43d69d; }}
    .bar-pypi {{ fill: #6eb6ff; }}
    .axis {{ stroke: #395463; stroke-width: 1; }}
  </style>
  <rect class="bg" width="760" height="300" rx="16" />
  <text x="28" y="40" class="label">Vivary public signals</text>
  <text x="28" y="64" class="muted">Latest weekly package downloads and GitHub repo interest</text>
  <text x="578" y="40" class="small">snapshot {date}</text>
  <text x="578" y="60" class="small">status {status}</text>

  <rect class="panel" x="28" y="88" width="500" height="162" rx="12" />
  <line class="axis" x1="88" y1="202" x2="488" y2="202" />
  <text x="52" y="123" class="small">npm</text>
  <rect class="bar-npm" x="88" y="104" width="{npm_width}" height="28" rx="6" />
  <text x="{min(498, 100 + npm_width)}" y="124" class="label">{npm}</text>
  <text x="52" y="171" class="small">PyPI</text>
  <rect class="bar-pypi" x="88" y="152" width="{pypi_width}" height="28" rx="6" />
  <text x="{min(498, 100 + pypi_width)}" y="172" class="label">{pypi}</text>
  <text x="88" y="226" class="small">all package downloads last week: {package_weekly}</text>

  <rect class="panel" x="552" y="88" width="180" height="48" rx="12" />
  <text x="572" y="116" class="small">GitHub stars</text>
  <text x="668" y="120" class="value">{stars}</text>

  <rect class="panel" x="552" y="148" width="180" height="48" rx="12" />
  <text x="572" y="176" class="small">Open issues</text>
  <text x="668" y="180" class="value">{issues}</text>

  <rect class="panel" x="552" y="208" width="180" height="48" rx="12" />
  <text x="572" y="236" class="small">Forks</text>
  <text x="668" y="240" class="value">{forks}</text>

  <text x="28" y="278" class="small">Tracked daily by .github/workflows/track-stats.yml through reviewed PR snapshots. History rows: {history_count}.</text>
</svg>
"""


def main() -> None:
    snapshot = current_snapshot()
    rows = write_stats(snapshot)
    svg = render_svg(snapshot, rows)
    write_text_lf(SVG_PATH, svg)
    write_text_lf(SITE_SVG_PATH, svg)
    print(
        "npm/wk:{npm_weekly} pypi/wk:{pypi_weekly} package/wk:{package_weekly} "
        "stars:{github_stars} forks:{github_forks} status:{status}".format(
            npm_weekly=snapshot["totals"]["npm_weekly"],
            pypi_weekly=snapshot["totals"]["pypi_weekly"],
            package_weekly=snapshot["totals"]["package_weekly"],
            github_stars=snapshot["github"]["stars"],
            github_forks=snapshot["github"]["forks"],
            status=snapshot["status"],
        )
    )
    for warning in snapshot["warnings"]:
        print(f"warn: {warning}")


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
