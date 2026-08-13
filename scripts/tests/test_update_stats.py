"""Behavior tests for resilient, credential-scoped public stats fetching."""

from __future__ import annotations

import importlib.util
from datetime import UTC, datetime
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError

import pytest


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "tools" / "update_stats.py"


def _load():
    spec = importlib.util.spec_from_file_location("update_stats", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _http_error(code: int, retry_after: str | None = None) -> HTTPError:
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return HTTPError("https://example.invalid", code, "failed", headers, None)


class _Response:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self.payload


def test_github_token_is_sent_only_to_github_api():
    module = _load()
    github = module.headers_for_url(
        "https://api.github.com/repos/vivary-dev/vivary",
        github_token="secret-token",
    )
    npm = module.headers_for_url(
        "https://api.npmjs.org/downloads/point/last-week/%40vivary%2Fcreate",
        github_token="secret-token",
    )

    assert github["Authorization"] == "Bearer secret-token"
    assert "Authorization" not in npm


@pytest.mark.parametrize(
    ("retry_after", "fallback", "expected"),
    [("17", 2.0, 17.0), ("999", 2.0, 30.0), ("invalid", 4.0, 4.0)],
)
def test_retry_delay_honors_numeric_retry_after_with_a_cap(
    retry_after: str,
    fallback: float,
    expected: float,
):
    module = _load()
    assert module.retry_delay(_http_error(429, retry_after), fallback) == expected


def test_fetch_json_retries_with_bounded_delay_and_then_returns_payload():
    module = _load()
    responses = [_http_error(429, "999"), _Response(b'{"ok": true}')]
    sleeps: list[float] = []

    def opener(_request, timeout):
        assert timeout == 20
        result = responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    assert module.fetch_json(
        "https://api.github.com/repos/vivary-dev/vivary",
        opener=opener,
        sleeper=sleeps.append,
        github_token="token",
    ) == {"ok": True}
    assert sleeps == [30.0]


def test_fetch_json_honors_retry_after_on_github_secondary_rate_limit():
    module = _load()
    responses = [_http_error(403, "7"), _Response(b'{"ok": true}')]
    sleeps: list[float] = []

    def opener(_request, timeout):
        assert timeout == 20
        result = responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    assert module.fetch_json(
        "https://api.github.com/repos/vivary-dev/vivary",
        opener=opener,
        sleeper=sleeps.append,
        github_token="token",
    ) == {"ok": True}
    assert sleeps == [7.0]


def test_fetch_json_exhaustion_raises_without_leaking_token():
    module = _load()

    def opener(_request, timeout):
        raise _http_error(403)

    with pytest.raises(module.FetchError) as caught:
        module.fetch_json(
            "https://api.github.com/repos/vivary-dev/vivary",
            attempts=1,
            opener=opener,
            sleeper=lambda _delay: None,
            github_token="do-not-print",
        )

    assert "do-not-print" not in str(caught.value)


def test_current_snapshot_is_ok_only_when_every_source_is_fresh(monkeypatch):
    module = _load()
    monkeypatch.setattr(module, "previous_snapshot", lambda: {})
    monkeypatch.setattr(module, "datetime", _FixedDatetime)
    monkeypatch.setattr(
        module,
        "npm_snapshot",
        lambda _previous, _warnings: {"weekly_total": 3, "packages": {}},
    )
    monkeypatch.setattr(
        module,
        "pypi_snapshot",
        lambda _previous, _warnings: {"weekly_total": 5, "packages": {}},
    )
    monkeypatch.setattr(
        module,
        "github_snapshot",
        lambda _previous, _warnings: {
            "stars": 2,
            "forks": 1,
            "watchers": 1,
            "open_issues": 4,
            "pushed_at": None,
            "stale": False,
        },
    )

    snapshot = module.current_snapshot()
    assert snapshot["status"] == "ok"
    assert snapshot["warnings"] == []


def test_current_snapshot_is_stale_when_a_source_records_a_warning(monkeypatch):
    module = _load()
    monkeypatch.setattr(module, "previous_snapshot", lambda: {})
    monkeypatch.setattr(module, "datetime", _FixedDatetime)

    def npm(_previous, warnings):
        warnings.append("npm stale")
        return {"weekly_total": 3, "packages": {}}

    monkeypatch.setattr(module, "npm_snapshot", npm)
    monkeypatch.setattr(
        module,
        "pypi_snapshot",
        lambda _previous, _warnings: {"weekly_total": 5, "packages": {}},
    )
    monkeypatch.setattr(
        module,
        "github_snapshot",
        lambda _previous, _warnings: {
            "stars": 2,
            "forks": 1,
            "watchers": 1,
            "open_issues": 4,
            "pushed_at": None,
            "stale": False,
        },
    )

    snapshot = module.current_snapshot()
    assert snapshot["status"] == "stale"
    assert snapshot["warnings"] == ["npm stale"]


class _FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 8, 13, 5, 0, tzinfo=tz or UTC)
