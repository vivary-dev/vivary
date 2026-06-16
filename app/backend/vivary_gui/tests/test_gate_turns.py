"""Slice 4: turn-boundary gates — the agent raises a gate and the run pauses at the turn
boundary; approving it resumes the conversation. Proven with the echo runtime's RAISE_GATE
test hook (no real agent, no tokens)."""

import asyncio

from vivary_gui.services import gates
from vivary_gui.services.agents.base import RUNTIMES
from vivary_gui.services.agents.manager import Manager, _build_resume_note, _open_gate_ids


def _write_gate(root, gid, status, gate="some gate"):
    gdir = root / "gates"
    gdir.mkdir(exist_ok=True)
    (gdir / f"{gid}.md").write_text(
        f"---\nproject: t\nstatus: {status}\ngate: {gate}\n---\n# {gid}\n", encoding="utf-8"
    )


async def _settle(sess, timeout=10):
    async def wait():
        while sess.status == "running":
            await asyncio.sleep(0.02)
    await asyncio.wait_for(wait(), timeout=timeout)


def test_open_gate_diff_excludes_preexisting(tmp_path):
    _write_gate(tmp_path, "human-gates", "open")       # category descriptor, always open
    _write_gate(tmp_path, "already", "approved")       # not open
    before = _open_gate_ids(tmp_path)
    assert before == {"human-gates"}
    _write_gate(tmp_path, "install", "open")           # newly raised
    assert _open_gate_ids(tmp_path) - before == {"install"}


def test_resume_note_wording():
    approved = _build_resume_note([{"id": "g", "gate": "install dep", "status": "approved"}])
    assert "Proceed" in approved
    rejected = _build_resume_note([{"id": "g", "gate": "push", "status": "rejected"}])
    assert "rejected" in rejected.lower() and "do not" in rejected.lower()


def test_gate_raised_pauses_session(tmp_path):
    async def run():
        m = Manager()
        _write_gate(tmp_path, "human-gates", "open")   # pre-existing category gate (ignored)
        sid = m.create(tmp_path, "ws", "echo")
        sess = m.sessions[sid]
        await m.send(sid, "please RAISE_GATE now")
        await _settle(sess)
        return sess

    sess = asyncio.run(run())
    types = [e.type for e in sess.events]
    assert "gates_open" in types
    go = next(e for e in sess.events if e.type == "gates_open")
    assert any(g["id"] == "echo-gate" for g in go.meta["gates"])
    assert sess.status == "awaiting"
    assert sess.awaiting_gates == {"echo-gate"}        # only the newly raised gate
    assert "human-gates" not in sess.awaiting_gates    # category gate excluded by the diff


def test_approve_resumes_agent(tmp_path):
    async def run():
        m = Manager()
        sid = m.create(tmp_path, "ws", "echo")
        sess = m.sessions[sid]
        rt = RUNTIMES["echo"]
        rt.multi_turn = True               # let echo resume (restored in finally)
        try:
            await m.send(sid, "RAISE_GATE")
            await _settle(sess)
            assert sess.status == "awaiting"
            sess.agent_session_id = "echo-1"   # resume needs a conversation id
            gates.set_status(sess.cwd, "echo-gate", "approved", "tester")
            n_before = len(sess.events)
            await m.resume(sid)
            await _settle(sess)
            return sess, n_before
        finally:
            rt.multi_turn = False

    sess, n_before = asyncio.run(run())
    new = sess.events[n_before:]
    user_msgs = [e for e in new if e.type == "user_msg"]
    assert user_msgs and "Approved" in user_msgs[0].text and "Proceed" in user_msgs[0].text
    assert sess.awaiting_gates == set()
    assert sess.status == "idle"
    assert new[-1].type == "turn_end"


def test_reject_resume_tells_agent_to_stop(tmp_path):
    async def run():
        m = Manager()
        sid = m.create(tmp_path, "ws", "echo")
        sess = m.sessions[sid]
        rt = RUNTIMES["echo"]
        rt.multi_turn = True
        try:
            await m.send(sid, "RAISE_GATE")
            await _settle(sess)
            sess.agent_session_id = "echo-1"
            gates.set_status(sess.cwd, "echo-gate", "rejected", "tester")
            n_before = len(sess.events)
            await m.resume(sid)
            await _settle(sess)
            return sess, n_before
        finally:
            rt.multi_turn = False

    sess, n_before = asyncio.run(run())
    note = next(e for e in sess.events[n_before:] if e.type == "user_msg").text
    assert "rejected" in note.lower() and "do not" in note.lower()


def test_resume_noop_for_single_turn_runtime(tmp_path):
    async def run():
        m = Manager()
        sid = m.create(tmp_path, "ws", "echo")   # echo is multi_turn=False by default
        sess = m.sessions[sid]
        await m.send(sid, "RAISE_GATE")
        await _settle(sess)
        assert sess.status == "awaiting"
        n_before = len(sess.events)
        await m.resume(sid)
        return sess, n_before

    sess, n_before = asyncio.run(run())
    new = sess.events[n_before:]
    assert any(e.type == "status" and "auto-resume" in e.text for e in new)
    assert not any(e.type == "user_msg" for e in new)  # no new turn started
    assert sess.awaiting_gates == set()
    assert sess.status == "idle"
