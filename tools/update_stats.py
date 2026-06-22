"""Fetch public Vivary stats and render the README usage snapshot."""

from __future__ import annotations

import csv
import html
import json
import os
import urllib.request
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATS_DIR = ROOT / "stats"
LATEST_PATH = STATS_DIR / "latest.json"
HISTORY_PATH = STATS_DIR / "history.csv"
SVG_PATH = STATS_DIR / "usage-snapshot.svg"
SITE_SVG_PATH = ROOT / "site" / "public" / "usage-snapshot.svg"
HEADER = ["date", "npm_weekly", "pypi_weekly", "github_stars", "github_forks"]


def write_text_lf(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def fetch_json(url: str) -> dict | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "vivary-stats/1.0"})
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read())
    except Exception as exc:  # pragma: no cover - defensive for CI/network flake
        print(f"warn: {url} -> {exc}")
        return None


def previous_snapshot() -> dict:
    if not LATEST_PATH.exists():
        return {}
    try:
        return json.loads(LATEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def fallback_int(previous: dict, key: str) -> int:
    try:
        return int(previous.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0


def current_snapshot() -> dict[str, int | str]:
    previous = previous_snapshot()
    npm = fetch_json("https://api.npmjs.org/downloads/point/last-week/%40vivary%2Fcreate")
    pypi = fetch_json("https://pypistats.org/api/packages/create-vivary/recent")
    github = fetch_json("https://api.github.com/repos/vivary-dev/vivary")

    return {
        "date": datetime.now(UTC).date().isoformat(),
        "npm_weekly": (
            int(npm.get("downloads", 0) or 0)
            if npm is not None
            else fallback_int(previous, "npm_weekly")
        ),
        "pypi_weekly": (
            int((pypi.get("data") or {}).get("last_week", 0) or 0)
            if pypi is not None
            else fallback_int(previous, "pypi_weekly")
        ),
        "github_stars": (
            int(github.get("stargazers_count", 0) or 0)
            if github is not None
            else fallback_int(previous, "github_stars")
        ),
        "github_forks": (
            int(github.get("forks_count", 0) or 0)
            if github is not None
            else fallback_int(previous, "github_forks")
        ),
    }


def read_history() -> list[dict[str, str]]:
    if not HISTORY_PATH.exists():
        return []
    with HISTORY_PATH.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def write_stats(snapshot: dict[str, int | str]) -> list[dict[str, str]]:
    STATS_DIR.mkdir(exist_ok=True)
    write_text_lf(LATEST_PATH, json.dumps(snapshot, indent=2) + "\n")

    rows = [row for row in read_history() if row.get("date") != snapshot["date"]]
    rows.append({key: str(snapshot[key]) for key in HEADER})
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


def render_svg(snapshot: dict[str, int | str], rows: list[dict[str, str]]) -> str:
    npm = int(snapshot["npm_weekly"])
    pypi = int(snapshot["pypi_weekly"])
    stars = int(snapshot["github_stars"])
    forks = int(snapshot["github_forks"])
    scale = max(npm, pypi, 1)
    max_width = 420
    npm_width = bar(max_width, npm, scale)
    pypi_width = bar(max_width, pypi, scale)
    history_count = len(rows)
    date = html.escape(str(snapshot["date"]))

    return f"""<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 760 280">
  <title id="title">Vivary public usage snapshot</title>
  <desc id="desc">Weekly npm and PyPI downloads plus GitHub stars and forks, generated from public package and GitHub APIs.</desc>
  <style>
    .bg {{ fill: #101923; }}
    .panel {{ fill: #162532; stroke: #2b4655; stroke-width: 1; }}
    .muted {{ fill: #9fb3bd; font: 14px system-ui, -apple-system, Segoe UI, sans-serif; }}
    .small {{ fill: #9fb3bd; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }}
    .label {{ fill: #eef8f3; font: 600 15px system-ui, -apple-system, Segoe UI, sans-serif; }}
    .value {{ fill: #eef8f3; font: 700 28px system-ui, -apple-system, Segoe UI, sans-serif; }}
    .bar-npm {{ fill: #43d69d; }}
    .bar-pypi {{ fill: #6eb6ff; }}
    .axis {{ stroke: #395463; stroke-width: 1; }}
  </style>
  <rect class="bg" width="760" height="280" rx="16" />
  <text x="28" y="40" class="label">Vivary public signals</text>
  <text x="28" y="64" class="muted">Latest weekly package downloads and GitHub repo signals</text>
  <text x="600" y="40" class="small">snapshot {date}</text>

  <rect class="panel" x="28" y="88" width="500" height="150" rx="12" />
  <line class="axis" x1="88" y1="197" x2="488" y2="197" />
  <text x="52" y="123" class="small">npm</text>
  <rect class="bar-npm" x="88" y="104" width="{npm_width}" height="28" rx="6" />
  <text x="{min(498, 100 + npm_width)}" y="124" class="label">{npm}</text>
  <text x="52" y="171" class="small">PyPI</text>
  <rect class="bar-pypi" x="88" y="152" width="{pypi_width}" height="28" rx="6" />
  <text x="{min(498, 100 + pypi_width)}" y="172" class="label">{pypi}</text>
  <text x="88" y="220" class="small">@vivary/create weekly</text>
  <text x="302" y="220" class="small">create-vivary weekly</text>

  <rect class="panel" x="552" y="88" width="180" height="68" rx="12" />
  <text x="572" y="116" class="small">GitHub stars</text>
  <text x="572" y="145" class="value">{stars}</text>

  <rect class="panel" x="552" y="170" width="180" height="68" rx="12" />
  <text x="572" y="198" class="small">Forks</text>
  <text x="572" y="227" class="value">{forks}</text>

  <text x="28" y="260" class="small">Tracked by .github/workflows/track-stats.yml through reviewed PR snapshots. History rows: {history_count}.</text>
</svg>
"""


def main() -> None:
    snapshot = current_snapshot()
    rows = write_stats(snapshot)
    svg = render_svg(snapshot, rows)
    write_text_lf(SVG_PATH, svg)
    write_text_lf(SITE_SVG_PATH, svg)
    print(
        "npm/wk:{npm_weekly} pypi/wk:{pypi_weekly} stars:{github_stars} forks:{github_forks}".format(
            **snapshot
        )
    )


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
