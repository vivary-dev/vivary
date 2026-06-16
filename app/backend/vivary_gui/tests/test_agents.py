"""Slice 5: conversational sessions — create, send a turn, stream events to finish,
proven with the deterministic echo runtime (no real agent, no tokens)."""

import asyncio
import os
import subprocess
import sys
from pathlib import Path

from vivary_gui.services.agents.manager import Manager, _agent_env


def test_echo_conversation_turn(tmp_path):
    async def run():
        m = Manager()
        sid = m.create(tmp_path, "ws1", "echo")

        # collect events in the background while we drive a turn
        events = []
        done = asyncio.Event()

        async def consume():
            async for ev in m.subscribe(sid):
                events.append(ev)
                if ev.type == "turn_end":
                    done.set()
                    break

        task = asyncio.create_task(consume())
        await asyncio.sleep(0)  # let the subscriber attach
        await m.send(sid, "alpha beta")
        await asyncio.wait_for(done.wait(), timeout=10)
        task.cancel()
        return m, sid, events

    m, sid, events = asyncio.run(run())
    types = [e.type for e in events]
    texts = [e.text for e in events]

    assert "user_msg" in types            # the human turn is recorded
    assert {"alpha", "beta"} <= set(texts)  # echoed tokens streamed as text
    assert types[-1] == "turn_end"        # turn completes, conversation stays open
    assert m.sessions[sid].status == "idle"  # ready for the next message
    assert m.sessions[sid].summary()["tool_mode"] == "read-only"


def test_unknown_runtime_rejected(tmp_path):
    try:
        Manager().create(tmp_path, "ws1", "nope")
        raised = False
    except KeyError:
        raised = True
    assert raised


def test_session_can_record_workspace_write_tool_mode(tmp_path):
    m = Manager()
    sid = m.create(tmp_path, "ws1", "echo", tool_mode="workspace-write")

    assert m.sessions[sid].tool_mode == "workspace-write"
    assert m.sessions[sid].summary()["tool_mode"] == "workspace-write"


def test_unknown_tool_mode_rejected_before_session_created(tmp_path):
    m = Manager()
    try:
        m.create(tmp_path, "ws1", "echo", tool_mode="danger-full-access")
        raised = False
    except ValueError:
        raised = True

    assert raised
    assert m.sessions == {}


def test_agent_env_prepends_python_toolchain_and_preserves_path(tmp_path, monkeypatch):
    old_path = os.pathsep.join([str(tmp_path / "bin-a"), str(tmp_path / "bin-b")])
    monkeypatch.setenv("PATH", old_path)
    m = Manager()
    sid = m.create(tmp_path, "ws1", "echo")

    env = _agent_env(m.sessions[sid])
    parts = env["PATH"].split(os.pathsep)

    assert parts[0] == str(Path(sys.executable).resolve().parent)
    assert parts[1:] == old_path.split(os.pathsep)


def test_agent_env_includes_sandbox_metadata(tmp_path):
    m = Manager()
    sid = m.create(tmp_path, "ws1", "echo", tool_mode="workspace-write")
    sess = m.sessions[sid]

    env = _agent_env(sess)

    assert env["VIVARY_GUI_SESSION_ID"] == sid
    assert env["VIVARY_GUI_WORKSPACE_ID"] == "ws1"
    assert env["VIVARY_GUI_SANDBOX_CWD"] == str(sess.cwd)
    assert env["VIVARY_GUI_SANDBOX_ISOLATION"] == sess.sandbox.isolation
    assert env["VIVARY_GUI_TOOL_MODE"] == "workspace-write"


def test_agent_env_python_can_import_vivary_toolchain(tmp_path):
    m = Manager()
    sid = m.create(tmp_path, "ws1", "echo")
    env = _agent_env(m.sessions[sid])
    python = Path(env["PATH"].split(os.pathsep)[0]) / ("python.exe" if os.name == "nt" else "python")

    res = subprocess.run(
        [
            str(python),
            "-c",
            "import tropo, ozone, exo, create_vivary; print('vivary-toolchain-ok')",
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=20,
    )

    assert res.returncode == 0, res.stderr
    assert "vivary-toolchain-ok" in res.stdout
