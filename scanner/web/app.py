"""FastAPI front-end: list, search, play, annotate clips."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .. import config, db

BASE = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE / "templates"))

app = FastAPI(title="Online Police Scanner")
app.mount("/static", StaticFiles(directory=str(BASE / "static")), name="static")

_conn = db.connect()


def _row_to_dict(row) -> dict:
    d = dict(row)
    d["started_iso"] = datetime.fromtimestamp(d["started_at"]).isoformat(timespec="seconds")
    return d


@app.get("/healthz")
def healthz() -> dict:
    n = _conn.execute("SELECT COUNT(*) AS n FROM clips").fetchone()["n"]
    return {"ok": True, "clips": n}


@app.get("/", response_class=HTMLResponse)
def index(request: Request, date: str | None = Query(default=None), q: str | None = Query(default=None)):
    if q:
        rows = db.search_clips(_conn, q)
    else:
        rows = db.list_clips(_conn, date=date)
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "clips": [_row_to_dict(r) for r in rows],
            "date": date or "",
            "q": q or "",
        },
    )


@app.get("/api/clips")
def api_clips(
    date: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> JSONResponse:
    rows = db.list_clips(_conn, date=date, limit=limit, offset=offset)
    return JSONResponse([_row_to_dict(r) for r in rows])


@app.get("/api/search")
def api_search(q: str, limit: int = 100) -> JSONResponse:
    rows = db.search_clips(_conn, q, limit=limit)
    return JSONResponse([_row_to_dict(r) for r in rows])


@app.get("/audio/{clip_id}")
def audio_file(clip_id: int) -> FileResponse:
    row = _conn.execute("SELECT path FROM clips WHERE id = ?", (clip_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    full = (config.DATA_DIR / row["path"]).resolve()
    # Prevent path traversal: file must live under DATA_DIR.
    if not str(full).startswith(str(config.DATA_DIR.resolve())):
        raise HTTPException(403)
    if not full.exists():
        raise HTTPException(410, detail="file missing on disk")
    return FileResponse(str(full), media_type="audio/wav", filename=full.name)


@app.post("/api/clips/{clip_id}/notes")
def update_notes(clip_id: int, notes: str = Form(...)) -> dict:
    db.update_notes(_conn, clip_id, notes)
    return {"ok": True}


@app.post("/clips/{clip_id}/notes")
def update_notes_form(clip_id: int, notes: str = Form(...)):
    db.update_notes(_conn, clip_id, notes)
    return RedirectResponse("/", status_code=303)


@app.delete("/api/clips/{clip_id}")
def delete_clip(clip_id: int) -> dict:
    rel = db.delete_clip(_conn, clip_id)
    if rel is None:
        raise HTTPException(404)
    full = (config.DATA_DIR / rel).resolve()
    if str(full).startswith(str(config.DATA_DIR.resolve())) and full.exists():
        full.unlink()
    return {"ok": True}
