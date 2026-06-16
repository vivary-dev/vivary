"""SQLite FTS5 full-text index over a workspace's markdown.

The DB (~/.vivary-gui/index.db) is a rebuildable CACHE — plain files remain the source
of truth, so it can be deleted and rebuilt at any time. Long-term memory (`MEMORY.md`,
`memory/*.md`) IS indexed (that's the point — make it searchable) and flagged
`private=1`; the identity file `USER.md` and `.strato/private/` are never indexed.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from .. import config

# Directories never worth indexing.
SKIP_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__", "dist", "build",
    ".obsidian", ".pytest_cache", ".mypy_cache", "site-packages",
}
# Files/paths that must never be indexed (identity / secrets).
NEVER = {"USER.md"}
MARKDOWN = {".md", ".markdown"}


class FTS5Unavailable(RuntimeError):
    pass


def _connect() -> sqlite3.Connection:
    config.ensure_app_dir()
    conn = sqlite3.connect(config.INDEX_DB)
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5("
                     "workspace UNINDEXED, path UNINDEXED, title, body, private UNINDEXED)")
    except sqlite3.OperationalError as exc:
        raise FTS5Unavailable(
            f"SQLite FTS5 not available in this Python build: {exc}"
        ) from exc
    return conn


def _is_private(rel: Path) -> bool:
    parts = rel.parts
    return rel.name == "MEMORY.md" or (parts and parts[0] == "memory") or (
        len(parts) >= 2 and parts[0] == ".strato" and parts[1] == "private"
    )


def _title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#"):
            return s.lstrip("#").strip() or fallback
        if s:
            break
    return fallback


def _iter_markdown(root: Path):
    for p in root.rglob("*"):
        if p.is_dir():
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.suffix.lower() not in MARKDOWN:
            continue
        rel = p.relative_to(root)
        if rel.name in NEVER or (len(rel.parts) >= 2 and rel.parts[0] == ".strato" and rel.parts[1] == "private"):
            continue
        yield p, rel


def reindex(workspace_id: str, root: str | Path) -> dict:
    """Rebuild the index for one workspace. Returns {indexed, private, skipped}."""
    root = Path(root).resolve()
    conn = _connect()
    indexed = private = 0
    try:
        conn.execute("DELETE FROM docs WHERE workspace = ?", (workspace_id,))
        for path, rel in _iter_markdown(root):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            is_priv = _is_private(rel)
            conn.execute(
                "INSERT INTO docs (workspace, path, title, body, private) VALUES (?,?,?,?,?)",
                (workspace_id, str(rel).replace("\\", "/"), _title(text, rel.name), text, int(is_priv)),
            )
            indexed += 1
            private += int(is_priv)
        conn.commit()
    finally:
        conn.close()
    return {"indexed": indexed, "private": private}


def _match_query(q: str) -> str | None:
    # Build a safe FTS5 MATCH: each alphanumeric token is double-quoted (so words like
    # "OR"/"AND"/"NOT" are treated as terms, not operators, and punctuation can't break
    # the syntax) and prefix-matched, then OR'd together.
    tokens = re.findall(r"\w+", q, flags=re.UNICODE)
    if not tokens:
        return None
    return " OR ".join(f'"{t}"*' for t in tokens)


def search(q: str, workspace_id: str | None = None, limit: int = 25,
           include_private: bool = True) -> list[dict]:
    match = _match_query(q)
    if not match:
        return []
    conn = _connect()
    try:
        sql = [
            "SELECT workspace, path, title, private,",
            "  snippet(docs, 3, '[', ']', '…', 14) AS snip,",
            "  bm25(docs) AS score",
            "FROM docs WHERE docs MATCH ?",
        ]
        params: list = [match]
        if workspace_id:
            sql.append("AND workspace = ?")
            params.append(workspace_id)
        if not include_private:
            sql.append("AND private = 0")
        sql.append("ORDER BY score LIMIT ?")
        params.append(limit)
        try:
            rows = conn.execute(" ".join(sql), params).fetchall()
        except sqlite3.OperationalError:
            # Malformed FTS5 expression from odd input — treat as no matches.
            return []
    finally:
        conn.close()
    return [
        {
            "workspace": r[0],
            "path": r[1],
            "title": r[2],
            "private": bool(r[3]),
            "snippet": r[4],
            "score": r[5],
        }
        for r in rows
    ]
