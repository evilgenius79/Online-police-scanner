"""SQLite + FTS5 index for clips."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from . import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS clips (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    started_at  REAL NOT NULL,
    duration_s  REAL NOT NULL,
    peak        REAL NOT NULL DEFAULT 0,
    rms         REAL NOT NULL DEFAULT 0,
    notes       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_clips_started ON clips(started_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts USING fts5(
    notes,
    content='clips',
    content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS clips_ai AFTER INSERT ON clips BEGIN
    INSERT INTO clips_fts(rowid, notes) VALUES (new.id, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS clips_au AFTER UPDATE OF notes ON clips BEGIN
    INSERT INTO clips_fts(clips_fts, rowid, notes) VALUES ('delete', old.id, old.notes);
    INSERT INTO clips_fts(rowid, notes) VALUES (new.id, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS clips_ad AFTER DELETE ON clips BEGIN
    INSERT INTO clips_fts(clips_fts, rowid, notes) VALUES ('delete', old.id, old.notes);
END;
"""


def connect(path: Path = config.DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection):
    conn.execute("BEGIN")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def insert_clip(
    conn: sqlite3.Connection,
    *,
    path: str,
    started_at: float,
    duration_s: float,
    peak: float,
    rms: float,
) -> int:
    cur = conn.execute(
        "INSERT INTO clips(path, started_at, duration_s, peak, rms) VALUES (?,?,?,?,?)",
        (path, started_at, duration_s, peak, rms),
    )
    return int(cur.lastrowid)


def list_clips(
    conn: sqlite3.Connection,
    *,
    limit: int = 100,
    offset: int = 0,
    date: str | None = None,
) -> list[sqlite3.Row]:
    if date:
        # date is YYYY-MM-DD; compare via strftime to avoid TZ ambiguity.
        rows = conn.execute(
            "SELECT * FROM clips WHERE date(started_at, 'unixepoch', 'localtime') = ? "
            "ORDER BY started_at DESC LIMIT ? OFFSET ?",
            (date, limit, offset),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM clips ORDER BY started_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return list(rows)


def search_clips(conn: sqlite3.Connection, q: str, *, limit: int = 100) -> list[sqlite3.Row]:
    return list(conn.execute(
        "SELECT clips.* FROM clips JOIN clips_fts ON clips.id = clips_fts.rowid "
        "WHERE clips_fts MATCH ? ORDER BY clips.started_at DESC LIMIT ?",
        (q, limit),
    ).fetchall())


def update_notes(conn: sqlite3.Connection, clip_id: int, notes: str) -> None:
    conn.execute("UPDATE clips SET notes = ? WHERE id = ?", (notes, clip_id))


def delete_clip(conn: sqlite3.Connection, clip_id: int) -> str | None:
    row = conn.execute("SELECT path FROM clips WHERE id = ?", (clip_id,)).fetchone()
    if row is None:
        return None
    conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))
    return row["path"]
