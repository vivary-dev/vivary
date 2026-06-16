import json
from pathlib import Path

from vivary_gui.services.agents.base import AgentEvent, CodexRuntime


FIXTURE = Path(__file__).parent / "fixtures" / "codex_jsonl_synthetic.jsonl"
LIVE_FIXTURE = Path(__file__).parent / "fixtures" / "codex_jsonl_live_readonly.jsonl"


def _events(path: Path = FIXTURE) -> list[AgentEvent]:
    rt = CodexRuntime()
    events: list[AgentEvent] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        events.extend(rt.parse(line))
    return events


def test_codex_build_command_uses_json_and_cwd(tmp_path):
    cmd = CodexRuntime().build_command("read only please", cwd=tmp_path)
    assert cmd[1:4] == ["exec", "--json", "--skip-git-repo-check"]
    assert "--sandbox" in cmd and "read-only" in cmd
    assert "-C" in cmd and str(tmp_path) in cmd
    assert cmd[-2:] == ["--", "read only please"]


def test_codex_build_command_can_request_workspace_write(tmp_path):
    cmd = CodexRuntime().build_command("write in workspace", cwd=tmp_path, tool_mode="workspace-write")
    assert cmd[cmd.index("--sandbox") + 1] == "workspace-write"
    assert "-C" in cmd and str(tmp_path) in cmd


def test_codex_build_command_rejects_unknown_tool_mode(tmp_path):
    try:
        CodexRuntime().build_command("nope", cwd=tmp_path, tool_mode="danger-full-access")
        raised = False
    except ValueError:
        raised = True
    assert raised


def test_codex_thread_id_is_captured_from_lifecycle_line():
    line = FIXTURE.read_text(encoding="utf-8").splitlines()[0]
    assert CodexRuntime().session_id_from(line) == "019ecodex-0000-7000-9000-fixture000001"


def test_codex_jsonl_maps_to_structured_events():
    events = _events()
    types = [e.type for e in events]
    assert "reasoning" in types
    assert "tool" in types
    assert "file_change" in types
    assert "plan" in types
    assert "text" in types
    assert "result" in types
    assert types.count("error") == 2

    tool = next(e for e in events if e.type == "tool" and e.meta["id"] == "cmd_1" and e.meta["exit_code"] == 0)
    assert tool.tool == "command"
    assert tool.meta["kind"] == "read"
    assert tool.meta["exit_code"] == 0
    assert "README.md" in tool.meta["aggregated_output"]

    search = next(e for e in events if e.type == "tool" and e.tool == "web_search")
    assert search.meta["kind"] == "network"
    assert search.meta["query"] == "Codex JSONL events"

    change = next(e for e in events if e.type == "file_change")
    assert change.meta["changes"][0]["path"] == "app/frontend/src/App.tsx"

    result = next(e for e in events if e.type == "result")
    assert result.meta["input_tokens"] == 120
    assert result.meta["cached_input_tokens"] == 80
    assert result.meta["output_tokens"] == 40
    assert result.meta["reasoning_output_tokens"] == 12


def test_codex_live_readonly_fixture_maps_windows_shell_reads():
    events = _events(LIVE_FIXTURE)
    completed_tools = [
        e for e in events
        if e.type == "tool" and e.meta["status"] == "completed" and e.meta["exit_code"] == 0
    ]
    assert len(completed_tools) == 2
    assert {e.meta["kind"] for e in completed_tools} == {"read"}
    assert any("Get-Content" in e.meta["command"] and "# Vivary" in e.meta["aggregated_output"] for e in completed_tools)
    assert any(e.type == "text" and "Root contains" in e.text for e in events)
    assert any(e.type == "result" and e.meta["input_tokens"] for e in events)
    assert not any(e.type == "file_change" for e in events)


def test_codex_non_json_stdout_is_status_not_flat_answer_text():
    evs = CodexRuntime().parse("non-json warning")
    assert evs == [AgentEvent("status", "non-json warning")]


def test_codex_unknown_json_is_ignored():
    assert CodexRuntime().parse(json.dumps({"type": "unknown"})) == []
