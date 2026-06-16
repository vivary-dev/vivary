"""Slice 5: conversational sessions — create, send a turn, stream events to finish,
proven with the deterministic echo runtime (no real agent, no tokens)."""

import asyncio

from vivary_gui.services.agents.manager import Manager


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
