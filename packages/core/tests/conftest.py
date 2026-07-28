"""Deterministic process environment for the core test suite."""

from __future__ import annotations

import pytest


@pytest.fixture(scope="session", autouse=True)
def isolate_user_git_config(tmp_path_factory):
    """Keep host user Git policy out of repository-observation fixtures."""
    git_home = tmp_path_factory.mktemp("git-home")
    xdg_home = git_home / "xdg"
    xdg_home.mkdir()
    (git_home / ".gitconfig").write_text("", encoding="utf-8")

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setenv("HOME", str(git_home))
        monkeypatch.setenv("USERPROFILE", str(git_home))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg_home))
        monkeypatch.setenv("GIT_TERMINAL_PROMPT", "0")
        monkeypatch.setenv("GIT_ASKPASS", "echo")
        yield
