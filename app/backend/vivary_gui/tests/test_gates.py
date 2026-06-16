"""Slice 4: gate approve/reject writes frontmatter status (human-approval gate)."""

from vivary_gui.services import gates


def test_gate_approve_persists(tmp_path):
    gdir = tmp_path / "gates"
    gdir.mkdir()
    (gdir / "human-gates.md").write_text(
        "---\nstatus: open\ngate: stop before outward actions\n---\n# Human Gates\n",
        encoding="utf-8",
    )

    assert gates.list_gates(tmp_path)[0]["status"] == "open"

    updated = gates.set_status(tmp_path, "human-gates", "approved", "tester")
    assert updated is not None
    assert updated["status"] == "approved"
    assert updated["approver"] == "tester"
    assert updated["approved_at"]  # stamped

    # persisted to disk + the original 'gate' field preserved
    again = gates.list_gates(tmp_path)[0]
    assert again["status"] == "approved"
    assert again["gate"] == "stop before outward actions"
