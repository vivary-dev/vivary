"""Pytest environment for deterministic Tropo governed-observation tests."""

from __future__ import annotations

import pytest

from test_tropo import _isolated_user_git_config


@pytest.fixture(scope="session", autouse=True)
def isolate_user_git_config():
    with _isolated_user_git_config():
        yield
