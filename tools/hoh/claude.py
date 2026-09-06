"""Fail-closed native Claude Code adapter seam for the 20a runtime proof."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from hoh.protocol import USAGE_SCHEMA, ProtocolError
if TYPE_CHECKING:
    from hoh_loop import RoleView


SUPPORTED_VERSION = "2.1.241"
REQUIRED_FLAGS = frozenset({"--print", "--output-format", "--tools"})
REQUIRED_USAGE_FIELDS = frozenset(
    {"input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"}
)


class ClaudePreflightError(ProtocolError):
    """Installed Claude evidence cannot authorize a model invocation."""


def normalize_claude_usage(raw: object, *, command_complete: bool) -> dict[str, Any]:
    """Normalize Claude usage; base input excludes its separately named cache subsets."""
    vendor = raw if isinstance(raw, dict) else {}

    def token(name: str) -> int | None:
        value = vendor.get(name)
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

    base_input = token("input_tokens")
    output = token("output_tokens")
    cache_read = token("cache_read_input_tokens")
    cache_write = token("cache_creation_input_tokens")
    complete = command_complete and None not in (base_input, output, cache_read, cache_write)
    aggregate_input = (
        base_input + cache_read + cache_write
        if complete
        else None
    )
    turns = vendor.get("num_turns")
    if not isinstance(turns, int) or isinstance(turns, bool) or turns < 0:
        turns = None
    return {
        "schema": USAGE_SCHEMA,
        "vendor_usage_raw": vendor,
        "aggregate_input_tokens": aggregate_input,
        "aggregate_output_tokens": output if complete else None,
        "cache_read_input_tokens": cache_read,
        "cache_write_input_tokens": cache_write,
        "budget_counted_tokens": aggregate_input + output if complete else None,
        "claude_agentic_turns": turns,
        "codex_top_level_turns": None,
        "complete": complete,
    }


class ClaudeAdapter:
    """Invoke only a verified installed CLI after all 20a admission facts pass."""

    def __init__(
        self,
        *,
        executable: Path,
        capability_evidence: dict[str, Any],
        runner: Any = None,
    ):
        self.executable = executable
        self.evidence = capability_evidence
        self.runner = runner
        self._validate_preflight()

    def _validate_preflight(self) -> None:
        expected = {
            "version",
            "native_cli",
            "verified_flags",
            "isolation",
            "usage_fields",
            "whole_invocation_maximum_tokens",
        }
        if not isinstance(self.evidence, dict) or set(self.evidence) != expected:
            raise ClaudePreflightError("Claude capability evidence shape differs")
        if self.evidence["version"] != SUPPORTED_VERSION:
            raise ClaudePreflightError("Claude version is unsupported")
        if self.evidence["native_cli"] is not True:
            raise ClaudePreflightError("Claude executable is not the installed native CLI")
        flags = self.evidence["verified_flags"]
        if not isinstance(flags, list) or not REQUIRED_FLAGS.issubset(flags):
            raise ClaudePreflightError("required Claude flags are unverified")
        isolation = self.evidence["isolation"]
        if not isinstance(isolation, dict) or set(isolation) != {
            "authenticated_host",
            "scoped_role_view",
            "builtin_tools_disabled",
            "credential_free_worker",
        } or not all(value is True for value in isolation.values()):
            raise ClaudePreflightError("Claude role isolation is unverified")
        usage_fields = self.evidence["usage_fields"]
        if not isinstance(usage_fields, list) or set(usage_fields) != REQUIRED_USAGE_FIELDS:
            raise ClaudePreflightError("Claude cumulative usage fields are unverified")
        maximum = self.evidence["whole_invocation_maximum_tokens"]
        if maximum is None or not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
            raise ClaudePreflightError("Claude whole-invocation token maximum is unknown")
        if not self.executable.is_file() or self.executable.is_symlink():
            raise ClaudePreflightError("Claude executable path is not a regular installed file")
        raise ClaudePreflightError(
            "Claude Code 2.1.241 has no verified native whole-invocation input-plus-output bound"
        )

    def maximum_charge(self, _role: str) -> int:
        raise ClaudePreflightError("Claude native invocation remains blocked")

    def invoke(self, request: dict[str, Any], prompt: str, view: RoleView, deadline: Any) -> object:
        """Refuse: 20c established no safe native invocation path for this CLI."""
        raise ClaudePreflightError("Claude native invocation remains blocked")
