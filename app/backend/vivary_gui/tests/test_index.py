"""Slice 1: FTS5 index over workspace markdown — memory is searchable, USER.md is not,
private is flagged, rebuild is idempotent, files stay the source of truth."""

from vivary_gui import config
from vivary_gui.index import indexer


def _make_workspace(tmp_path):
    ws = tmp_path / "ws"
    (ws / "memory").mkdir(parents=True)
    (ws / "MEMORY.md").write_text("# Memory index\n- pointer to widget facts\n", encoding="utf-8")
    (ws / "memory" / "widget.md").write_text("# Widget\nThe widget uses a flux capacitor.\n", encoding="utf-8")
    (ws / "README.md").write_text("# Readme\nnothing special here\n", encoding="utf-8")
    (ws / "USER.md").write_text("secret identity flux\n", encoding="utf-8")
    return ws


def test_index_and_search(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setattr(config, "APP_DIR", home)
    monkeypatch.setattr(config, "INDEX_DB", home / "index.db")
    ws = _make_workspace(tmp_path)

    stats = indexer.reindex("ws1", ws)
    assert stats["indexed"] == 3  # MEMORY.md, memory/widget.md, README.md — USER.md excluded
    assert stats["private"] == 2  # MEMORY.md + memory/widget.md flagged private

    hits = indexer.search("flux", workspace_id="ws1")
    paths = {h["path"] for h in hits}
    assert "memory/widget.md" in paths
    assert "USER.md" not in paths  # identity file is never indexed
    widget = next(h for h in hits if h["path"] == "memory/widget.md")
    assert widget["private"] is True
    assert "flux" in widget["snippet"].lower()

    # excluding private hides memory hits
    public = indexer.search("flux", workspace_id="ws1", include_private=False)
    assert all(not h["private"] for h in public)

    # rebuild is idempotent (DB is a throwaway cache)
    assert indexer.reindex("ws1", ws) == stats

    # queries with FTS keywords / punctuation must not raise (regression: literal "OR")
    assert isinstance(indexer.search("capacitor OR baseline", workspace_id="ws1"), list)
    assert indexer.search('flux "AND" (weird:', workspace_id="ws1") is not None
    assert indexer.search("", workspace_id="ws1") == []
