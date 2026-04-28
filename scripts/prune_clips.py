#!/usr/bin/env python3
"""Delete clips older than --days, removing both files and DB rows.

Usage:
    python scripts/prune_clips.py --days 30 [--dry-run]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scanner import config, db  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, required=True)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    cutoff = time.time() - args.days * 86400
    conn = db.connect()
    rows = conn.execute(
        "SELECT id, path FROM clips WHERE started_at < ?",
        (cutoff,),
    ).fetchall()

    print(f"{len(rows)} clip(s) older than {args.days} days")
    for row in rows:
        full = (config.DATA_DIR / row["path"]).resolve()
        print(f"  {'(dry) ' if args.dry_run else ''}delete id={row['id']} {full}")
        if args.dry_run:
            continue
        try:
            if full.exists() and str(full).startswith(str(config.DATA_DIR.resolve())):
                full.unlink()
        except OSError as e:
            print(f"    warn: {e}")
        conn.execute("DELETE FROM clips WHERE id = ?", (row["id"],))

    if not args.dry_run:
        conn.execute("VACUUM")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
