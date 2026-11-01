"""Shelfie — AI book identification & personal library. Run: python app.py"""
import csv
import io
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from flask import Flask, Response, abort, jsonify, request, send_file

from library import catalog, db, feeds, gemini
from library.imaging import HEIF, IMAGE_EXTS, thumbnail_path
from library.processor import Processor
from library.scanner import Scanner

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.json.ensure_ascii = False
processor = Processor()
scanner = Scanner()
feed_refresher = feeds.Refresher()

IMAGE_STATUSES = ("pending", "processing", "identified", "uncertain", "not_book", "failed")


def body():
    return request.get_json(silent=True) or {}


def int_list(values):
    out = []
    for v in values or []:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            pass
    return out


@app.errorhandler(ValueError)
@app.errorhandler(RuntimeError)
def bad_request(e):
    return jsonify(error=str(e)), 400


@app.errorhandler(LookupError)
def not_found(e):
    return jsonify(error=str(e)), 404


@app.get("/")
def index():
    return send_file(Path(app.static_folder) / "index.html")


# ---------------------------------------------------------------- settings

@app.get("/api/settings")
def get_settings():
    s = db.get_settings()
    key = s.pop("api_key", "")
    s["has_key"] = bool(key)
    s["api_key_hint"] = f"…{key[-4:]}" if key else ""
    s["heif_supported"] = HEIF
    s["extensions"] = sorted(IMAGE_EXTS)
    return jsonify(s)


@app.put("/api/settings")
def put_settings():
    data = body()
    values = {}
    if data.get("api_key"):
        values["api_key"] = data["api_key"].strip()
    if data.get("clear_api_key"):
        values["api_key"] = ""
    if data.get("model"):
        values["model"] = str(data["model"]).strip().removeprefix("models/")
    if "fallback_model" in data:
        values["fallback_model"] = str(data["fallback_model"] or "").strip().removeprefix("models/")
    limits = {"rpm": (1, 1000), "daily_limit": (1, 100000), "batch_size": (1, 8),
              "max_image_px": (512, 3072), "jpeg_quality": (50, 95)}
    for k, (lo, hi) in limits.items():
        if k in data:
            values[k] = max(lo, min(hi, int(data[k])))
    if "confidence_threshold" in data:
        values["confidence_threshold"] = max(0.0, min(1.0, float(data["confidence_threshold"])))
    db.save_settings(values)
    return get_settings()


@app.post("/api/settings/test")
def test_key():
    key = body().get("api_key") or db.get_settings().get("api_key")
    if not key:
        raise ValueError("No API key set")
    try:
        models = gemini.list_models(key)
    except gemini.GeminiError as e:
        return jsonify(ok=False, error=str(e)), 400
    return jsonify(ok=True, models=models)


# ---------------------------------------------------------------- folders & scanning

@app.post("/api/pick-folder")
def pick_folder():
    code = ("import tkinter as tk\nfrom tkinter import filedialog\n"
            "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
            "print(filedialog.askdirectory(title='Select a folder of book images') or '')")
    try:
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=900)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError(f"Folder picker unavailable ({e}); type the path instead") from None
    if out.returncode != 0:
        raise RuntimeError("Folder picker unavailable on this system; type the path instead")
    return jsonify(path=os.path.normpath(out.stdout.strip()) if out.stdout.strip() else "")


@app.get("/api/folders")
def list_folders():
    rows = db.connect().execute(
        "SELECT f.*, COUNT(i.id) AS images, "
        "SUM(i.status='pending') AS pending, SUM(i.status='identified') AS identified, "
        "SUM(i.status='uncertain') AS uncertain, SUM(i.status='failed') AS failed, "
        "SUM(i.status='not_book') AS not_book, SUM(i.missing) AS missing "
        "FROM folders f LEFT JOIN images i ON i.folder_id=f.id GROUP BY f.id ORDER BY f.added_at DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/folders")
def add_folder():
    data = body()
    path = os.path.normpath(os.path.expanduser(str(data.get("path", "")).strip().strip('"')))
    if not path or not os.path.isdir(path):
        raise ValueError(f"Folder not found: {path}")
    path = str(Path(path).resolve())
    recursive = 1 if data.get("recursive", True) else 0
    conn = db.connect()
    conn.execute("INSERT INTO folders(path, recursive, added_at) VALUES(?, ?, ?) "
                 "ON CONFLICT(path) DO UPDATE SET recursive=excluded.recursive", (path, recursive, db.now()))
    folder_id = conn.execute("SELECT id FROM folders WHERE path=?", (path,)).fetchone()["id"]
    scanner.start(folder_id)
    return jsonify(id=folder_id, path=path)


@app.post("/api/folders/<int:folder_id>/scan")
def rescan_folder(folder_id):
    scanner.start(folder_id)
    return jsonify(ok=True)


@app.delete("/api/folders/<int:folder_id>")
def delete_folder(folder_id):
    if processor.running or scanner.running:
        raise RuntimeError("Stop processing/scanning before removing a folder")
    with db.tx() as conn:
        book_ids = [r[0] for r in conn.execute(
            "SELECT DISTINCT bi.book_id FROM book_images bi JOIN images i ON i.id=bi.image_id "
            "WHERE i.folder_id=?", (folder_id,))]
        conn.execute("DELETE FROM images WHERE folder_id=?", (folder_id,))
        conn.execute("DELETE FROM folders WHERE id=?", (folder_id,))
        if body().get("remove_books"):
            catalog.cleanup_orphans(conn, book_ids)
    return jsonify(ok=True)


# ---------------------------------------------------------------- processing

@app.get("/api/status")
def status():
    conn = db.connect()
    counts = {s: 0 for s in IMAGE_STATUSES}
    for r in conn.execute("SELECT status, COUNT(*) n FROM images WHERE missing=0 GROUP BY status"):
        counts[r["status"]] = r["n"]
    counts["total"] = sum(counts.values())
    s = db.get_settings()
    usage = db.usage_today()
    books = conn.execute("SELECT SUM(in_library=1) n, SUM(in_library=0) f, SUM(status='uncertain') u "
                         "FROM books").fetchone()
    per_minute = max(1, float(s["rpm"])) * max(1, int(s["batch_size"]))
    return jsonify(
        processor=processor.snapshot(),
        scanner=scanner.state,
        counts=counts,
        books={"total": books["n"] or 0, "finds": books["f"] or 0, "uncertain": books["u"] or 0},
        usage={**usage, "daily_limit": s["daily_limit"], "rpm": s["rpm"]},
        eta_minutes=round(counts["pending"] / per_minute, 1),
        has_key=bool(s.get("api_key")),
    )


@app.post("/api/process/start")
def process_start():
    data = body()
    processor.start(folder_id=data.get("folder_id"), image_ids=int_list(data.get("image_ids")))
    return jsonify(processor.snapshot())


@app.post("/api/process/<action>")
def process_control(action):
    if action not in ("pause", "resume", "cancel"):
        abort(404)
    getattr(processor, action)()
    return jsonify(processor.snapshot())


# ---------------------------------------------------------------- images

def image_row(i):
    return db.connect().execute("SELECT * FROM images WHERE id=?", (i,)).fetchone()


@app.get("/api/images")
def list_images():
    a = request.args
    where, params = ["i.missing=0"], []
    if a.get("status"):
        statuses = a["status"].split(",")
        where.append(f"i.status IN ({','.join('?' * len(statuses))})")
        params += statuses
    if a.get("folder_id"):
        where.append("i.folder_id=?")
        params.append(int(a["folder_id"]))
    if a.get("q"):
        where.append("(i.filename LIKE ? OR EXISTS (SELECT 1 FROM book_images bi JOIN books b ON b.id=bi.book_id "
                     "WHERE bi.image_id=i.id AND b.title LIKE ?))")
        params += [f"%{a['q']}%"] * 2
    page, per = max(1, int(a.get("page", 1))), min(200, max(1, int(a.get("per_page", 60))))
    sql_where = " AND ".join(where)
    conn = db.connect()
    total = conn.execute(f"SELECT COUNT(*) FROM images i WHERE {sql_where}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT i.id, i.filename, i.path, i.status, i.confidence, i.error, i.attempts, i.analyzed_at, "
        f"(SELECT json_group_array(json_object('id', b.id, 'title', b.title, 'authors', json(b.authors), "
        f"'status', b.status, 'in_library', b.in_library)) FROM book_images bi JOIN books b ON b.id=bi.book_id WHERE bi.image_id=i.id) books "
        f"FROM images i WHERE {sql_where} ORDER BY i.id LIMIT ? OFFSET ?",
        [*params, per, (page - 1) * per]).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        d["books"] = json.loads(d["books"] or "[]")
        items.append(d)
    return jsonify(items=items, total=total, page=page, per_page=per)


@app.get("/api/images/<int:image_id>")
def get_image(image_id):
    row = image_row(image_id)
    if not row:
        abort(404)
    d = dict(row)
    conn = db.connect()
    d["books"] = [db.get_book(r["book_id"]) for r in
                  conn.execute("SELECT book_id FROM book_images WHERE image_id=? ORDER BY book_id", (image_id,))]
    cached = conn.execute("SELECT model, result, created_at FROM analysis_cache WHERE sha256=?",
                          (row["sha256"],)).fetchone()
    d["ai_result"] = json.loads(cached["result"]) if cached else None
    d["ai_model"] = cached["model"] if cached else None
    d["duplicates"] = [dict(r) for r in conn.execute(
        "SELECT id, filename FROM images WHERE sha256=? AND id<>? AND missing=0", (row["sha256"], image_id))]
    return jsonify(d)


@app.get("/api/images/<int:image_id>/thumb")
def image_thumb(image_id):
    row = image_row(image_id)
    if not row:
        abort(404)
    size = 720 if request.args.get("size") == "large" else 360
    try:
        path = thumbnail_path(row["path"], row["sha256"] or f"id{image_id}", size)
    except Exception:
        abort(404)
    resp = send_file(path, mimetype="image/jpeg", max_age=86400)
    return resp


@app.get("/api/images/<int:image_id>/file")
def image_file(image_id):
    row = image_row(image_id)
    if not row or not os.path.isfile(row["path"]):
        abort(404)
    if Path(row["path"]).suffix.lower() in (".heic", ".heif", ".tif", ".tiff"):
        return image_thumb_large(row)
    return send_file(row["path"], max_age=3600)


def image_thumb_large(row):
    return send_file(thumbnail_path(row["path"], row["sha256"], 1600), mimetype="image/jpeg")


@app.post("/api/images/reanalyze")
def reanalyze():
    ids = int_list(body().get("ids"))
    if not ids:
        raise ValueError("No images selected")
    with db.tx() as conn:
        for i in ids:
            row = conn.execute("SELECT sha256 FROM images WHERE id=?", (i,)).fetchone()
            if not row:
                continue
            conn.execute("DELETE FROM analysis_cache WHERE sha256=?", (row["sha256"],))
            catalog.unlink_image_books(conn, i)
            conn.execute("UPDATE images SET status='pending', error=NULL, confidence=NULL WHERE id=?", (i,))
    started = False
    if not processor.running and body().get("start", True):
        processor.start(image_ids=ids)
        started = True
    return jsonify(ok=True, started=started)


@app.post("/api/images/retry-failed")
def retry_failed():
    n = db.connect().execute("UPDATE images SET status='pending', error=NULL WHERE status='failed'").rowcount
    return jsonify(requeued=n)


@app.post("/api/images/link")
def link_images():
    data = body()
    ids = int_list(data.get("ids"))
    book_id = int(data.get("book_id") or 0)
    if not ids or not db.get_book(book_id):
        raise ValueError("Choose images and an existing book")
    with db.tx() as conn:
        catalog.link_images(conn, ids, book_id)
    return jsonify(ok=True, book_id=book_id)


@app.post("/api/images/<int:image_id>/unlink")
def unlink_image(image_id):
    book_id = int(body().get("book_id") or 0)
    with db.tx() as conn:
        conn.execute("DELETE FROM book_images WHERE image_id=? AND book_id=?", (image_id, book_id))
        catalog.cleanup_orphans(conn, [book_id])
        if not conn.execute("SELECT 1 FROM book_images WHERE image_id=?", (image_id,)).fetchone():
            conn.execute("UPDATE images SET status='uncertain', error='Not linked to any book' WHERE id=?",
                         (image_id,))
    return jsonify(ok=True)


@app.post("/api/images/accept")
def accept_images():
    ids = int_list(body().get("ids"))
    with db.tx() as conn:
        for i in ids:
            if conn.execute("SELECT 1 FROM book_images WHERE image_id=?", (i,)).fetchone():
                conn.execute("UPDATE images SET status='identified', error=NULL WHERE id=?", (i,))
                conn.execute("UPDATE books SET status='verified', updated_at=? WHERE id IN "
                             "(SELECT book_id FROM book_images WHERE image_id=?)", (db.now(), i))
    return jsonify(ok=True)


@app.post("/api/images/not-book")
def mark_not_book():
    ids = int_list(body().get("ids"))
    with db.tx() as conn:
        for i in ids:
            catalog.unlink_image_books(conn, i)
            conn.execute("UPDATE images SET status='not_book', error='Marked as not a book' WHERE id=?", (i,))
    return jsonify(ok=True)


# ---------------------------------------------------------------- books

SORTS = {
    "title": "b.title COLLATE NOCASE",
    "author": "json_extract(b.authors, '$[0]') COLLATE NOCASE, b.title COLLATE NOCASE",
    "year": "b.publication_year IS NULL, b.publication_year DESC",
    "added": "b.created_at DESC, b.id DESC",
    "rating": "b.rating IS NULL, b.rating DESC",
    "confidence": "b.confidence",
    "shelf": "COALESCE((SELECT position FROM shelves WHERE id=b.shelf_id), 1e9), b.shelf_pos IS NULL, b.shelf_pos, "
             "b.created_at, b.id",
}


def _book_filters(a):
    where, params = [], []
    shelf = a.get("shelf", "library")  # library | finds (identified, not yet added) | all
    if shelf == "library":
        where.append("b.in_library=1")
    elif shelf == "finds":
        where.append("b.in_library=0")
    if a.get("q"):
        like = f"%{a['q']}%"
        where.append("(b.title LIKE ? OR b.subtitle LIKE ? OR b.authors LIKE ? OR b.isbn LIKE ? OR b.series LIKE ? "
                     "OR b.publisher LIKE ? OR b.keywords LIKE ? OR b.tags LIKE ? OR b.topics LIKE ?)")
        params += [like] * 9
    for field in ("genre", "language", "reading_status", "status"):
        if a.get(field):
            where.append(f"b.{field}=?")
            params.append(a[field])
    for field, col in (("author", "authors"), ("tag", "tags"), ("category", "categories")):
        if a.get(field):
            where.append(f"EXISTS (SELECT 1 FROM json_each(b.{col}) WHERE value=?)")
            params.append(a[field])
    if a.get("favorite"):
        where.append("b.favorite=1")
    return (" WHERE " + " AND ".join(where)) if where else "", params


@app.get("/api/books")
def list_books():
    a = request.args
    where, params = _book_filters(a)
    order = SORTS.get(a.get("sort", "title"), SORTS["title"])
    page, per = max(1, int(a.get("page", 1))), min(500, max(1, int(a.get("per_page", 60))))
    conn = db.connect()
    total = conn.execute(f"SELECT COUNT(*) FROM books b{where}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT b.*, {db.COVER_SQL}, (SELECT COUNT(*) FROM book_images WHERE book_id=b.id) AS image_count "
        f"FROM books b{where} ORDER BY {order} LIMIT ? OFFSET ?", [*params, per, (page - 1) * per]).fetchall()
    return jsonify(items=[db.book_from_row(r) for r in rows], total=total, page=page, per_page=per)


@app.get("/api/books/facets")
def facets():
    conn = db.connect()

    def column(col):
        return [dict(r) for r in conn.execute(
            f"SELECT {col} AS value, COUNT(*) AS n FROM books WHERE in_library=1 AND {col} IS NOT NULL "
            f"AND {col}<>'' GROUP BY {col} ORDER BY n DESC, value LIMIT 300")]

    def json_col(col):
        return [dict(r) for r in conn.execute(
            f"SELECT j.value AS value, COUNT(*) AS n FROM books b, json_each(b.{col}) j WHERE b.in_library=1 "
            f"GROUP BY j.value ORDER BY n DESC, j.value LIMIT 300")]

    return jsonify(genre=column("genre"), language=column("language"), reading_status=column("reading_status"),
                   status=column("status"), author=json_col("authors"), tag=json_col("tags"),
                   category=json_col("categories"))


@app.get("/api/books/<int:book_id>")
def get_book(book_id):
    book = db.get_book(book_id)
    if not book:
        abort(404)
    return jsonify(book)


@app.post("/api/books")
def create_book():
    data = body()
    shelf_id = int(data["shelf_id"]) if data.get("shelf_id") not in (None, "", 0) else None
    with db.tx() as conn:
        book_id = catalog.create_book(conn, data, int_list(data.get("image_ids")))
        db.move_books(conn, [book_id], shelf_id)
    return jsonify(db.get_book(book_id))


@app.put("/api/books/<int:book_id>")
def update_book(book_id):
    data = body()
    with db.tx() as conn:
        if "shelf_id" in data:
            new_shelf = int(data["shelf_id"]) if data["shelf_id"] not in (None, "", 0) else None
            cur = conn.execute("SELECT shelf_id FROM books WHERE id=?", (book_id,)).fetchone()
            if cur and cur["shelf_id"] != new_shelf:
                db.move_books(conn, [book_id], new_shelf)
        dup = catalog.update_book(conn, book_id, data, verify=bool(data.get("verify")))
    book = db.get_book(book_id)
    book["possible_duplicate"] = db.get_book(dup) if dup else None
    return jsonify(book)


@app.delete("/api/books/<int:book_id>")
def delete_book(book_id):
    with db.tx() as conn:
        image_ids = [r[0] for r in conn.execute("SELECT image_id FROM book_images WHERE book_id=?", (book_id,))]
        conn.execute("DELETE FROM books WHERE id=?", (book_id,))
        for i in image_ids:
            if not conn.execute("SELECT 1 FROM book_images WHERE image_id=?", (i,)).fetchone():
                conn.execute("UPDATE images SET status='not_book', error='Its book was deleted from the library' "
                             "WHERE id=?", (i,))
    return jsonify(ok=True)


@app.post("/api/books/bulk-delete")
def bulk_delete():
    for i in int_list(body().get("ids")):
        delete_book(i)
    return jsonify(ok=True)


@app.post("/api/books/add-to-library")
def add_to_library():
    """Move new finds onto the library shelf: given ids, or all finds (optionally only confident ones)."""
    data = body()
    shelf_id = int(data["shelf_id"]) if data.get("shelf_id") not in (None, "", 0) else None
    with db.tx() as conn:
        if data.get("all"):
            sql = "SELECT id FROM books WHERE in_library=0"
            if data.get("confident_only"):
                sql += " AND status<>'uncertain'"
            ids = [r[0] for r in conn.execute(sql + " ORDER BY created_at, id")]
        else:
            ids = int_list(data.get("ids"))
            if not ids:
                raise ValueError("No books selected")
            ids = [r[0] for r in conn.execute(f"SELECT id FROM books WHERE in_library=0 AND id IN "
                                              f"({','.join('?' * len(ids))})", ids)]
        for i in ids:
            conn.execute("UPDATE books SET in_library=1, updated_at=? WHERE id=?", (db.now(), i))
        db.move_books(conn, ids, shelf_id)  # new arrivals go to the end of the chosen shelf
    return jsonify(added=len(ids), ids=ids)


@app.post("/api/books/<int:book_id>/remove-from-library")
def remove_from_library(book_id):
    db.connect().execute("UPDATE books SET in_library=0, updated_at=? WHERE id=?", (db.now(), book_id))
    return jsonify(ok=True)


def _shelves():
    conn = db.connect()
    rows = conn.execute("SELECT s.id, s.name, s.position, (SELECT COUNT(*) FROM books b WHERE b.shelf_id=s.id "
                        "AND b.in_library=1) AS count FROM shelves s ORDER BY s.position, s.id").fetchall()
    unsorted = conn.execute("SELECT COUNT(*) FROM books WHERE in_library=1 AND shelf_id IS NULL").fetchone()[0]
    return [dict(r) for r in rows], unsorted


@app.get("/api/shelf")
def shelf():
    """Everything in the library, arranged by shelf, for the bookcase sidebar."""
    rows = db.connect().execute(
        f"SELECT b.id, b.title, b.authors, b.page_count, b.favorite, b.reading_status, b.shelf_id, b.publication_year, "
        f"{db.COVER_SQL} FROM books b WHERE b.in_library=1 "
        f"ORDER BY b.shelf_pos IS NULL, b.shelf_pos, b.created_at, b.id LIMIT 2000").fetchall()
    shelves, unsorted = _shelves()
    return jsonify(shelves=shelves, unsorted=unsorted,
                   books=[{**dict(r), "authors": json.loads(r["authors"] or "[]")} for r in rows])


@app.get("/api/shelves")
def list_shelves():
    shelves, unsorted = _shelves()
    return jsonify(shelves=shelves, unsorted=unsorted)


@app.post("/api/shelves")
def create_shelf():
    name = " ".join(str(body().get("name", "")).split())[:80]
    if not name:
        raise ValueError("Give the shelf a name")
    conn = db.connect()
    pos = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM shelves").fetchone()[0]
    shelf_id = conn.execute("INSERT INTO shelves(name, position, created_at) VALUES(?, ?, ?)",
                            (name, pos, db.now())).lastrowid
    return jsonify(id=shelf_id, name=name, position=pos)


@app.put("/api/shelves/<int:shelf_id>")
def rename_shelf(shelf_id):
    name = " ".join(str(body().get("name", "")).split())[:80]
    if not name:
        raise ValueError("Give the shelf a name")
    if not db.connect().execute("UPDATE shelves SET name=? WHERE id=?", (name, shelf_id)).rowcount:
        raise LookupError("Shelf not found")
    return jsonify(ok=True, name=name)


@app.delete("/api/shelves/<int:shelf_id>")
def delete_shelf(shelf_id):
    """Remove a shelf; its books go to Unsorted (they are not deleted)."""
    with db.tx() as conn:
        ids = [r[0] for r in conn.execute("SELECT id FROM books WHERE shelf_id=? ORDER BY shelf_pos", (shelf_id,))]
        conn.execute("DELETE FROM shelves WHERE id=?", (shelf_id,))
        db.move_books(conn, ids, None)
    return jsonify(ok=True, moved=len(ids))


@app.post("/api/shelves/order")
def order_shelves():
    with db.tx() as conn:
        for pos, sid in enumerate(int_list(body().get("ids"))):
            conn.execute("UPDATE shelves SET position=? WHERE id=?", (pos, sid))
    return jsonify(ok=True)


@app.post("/api/shelves/arrange")
def arrange_shelf():
    """Set the exact order of books on one shelf (after a drag and drop)."""
    data = body()
    shelf_id = int(data["shelf_id"]) if data.get("shelf_id") not in (None, "", 0) else None
    ids = int_list(data.get("book_ids"))
    with db.tx() as conn:
        if shelf_id is not None and not conn.execute("SELECT 1 FROM shelves WHERE id=?", (shelf_id,)).fetchone():
            raise LookupError("Shelf not found")
        for pos, bid in enumerate(ids):
            conn.execute("UPDATE books SET shelf_id=?, shelf_pos=? WHERE id=?", (shelf_id, pos, bid))
    return jsonify(ok=True)


@app.post("/api/books/move")
def move_books():
    data = body()
    shelf_id = int(data["shelf_id"]) if data.get("shelf_id") not in (None, "", 0) else None
    ids = int_list(data.get("ids"))
    with db.tx() as conn:
        db.move_books(conn, ids, shelf_id)
    return jsonify(ok=True, moved=len(ids))


@app.post("/api/books/merge")
def merge_books():
    data = body()
    target = int(data.get("target_id") or 0)
    sources = [i for i in int_list(data.get("source_ids")) if i != target]
    if not target or not sources:
        raise ValueError("Choose a book to keep and at least one other book")
    with db.tx() as conn:
        catalog.merge_books(conn, target, sources)
    return jsonify(db.get_book(target))


@app.get("/api/books/<int:book_id>/lookup")
def lookup_book(book_id):
    """Suggestions from Open Library (free, no key) to verify or complete a record."""
    book = db.get_book(book_id)
    if not book:
        abort(404)
    fields = "title,subtitle,author_name,first_publish_year,publish_year,publisher,isbn,number_of_pages_median,language,subject,key"
    if book.get("isbn13") or book.get("isbn"):
        query = {"q": f"isbn:{book.get('isbn13') or book['isbn']}"}
    else:
        query = {"title": book["title"]}
        if book["authors"]:
            query["author"] = book["authors"][0]
    url = "https://openlibrary.org/search.json?" + urllib.parse.urlencode({**query, "fields": fields, "limit": 5})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Shelfie personal library (local app)"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            docs = json.loads(resp.read().decode("utf-8")).get("docs", [])
    except Exception as e:
        raise RuntimeError(f"Open Library lookup failed: {e}") from None
    lang = {"eng": "English", "ben": "Bengali", "spa": "Spanish", "fre": "French", "ger": "German",
            "ita": "Italian", "por": "Portuguese", "hin": "Hindi", "ara": "Arabic", "jpn": "Japanese",
            "chi": "Chinese", "rus": "Russian", "urd": "Urdu"}
    out = []
    for d in docs:
        isbns = d.get("isbn") or []
        isbn13 = next((i for i in isbns if len(i) == 13), None)
        out.append({
            "title": d.get("title"), "subtitle": d.get("subtitle"), "authors": d.get("author_name") or [],
            "publication_year": str(d["first_publish_year"]) if d.get("first_publish_year") else None,
            "publisher": (d.get("publisher") or [None])[0],
            "isbn": book.get("isbn") if book.get("isbn13") in isbns else isbn13,
            "page_count": d.get("number_of_pages_median"),
            "language": lang.get((d.get("language") or [""])[0]),
            "categories": (d.get("subject") or [])[:8],
            "url": f"https://openlibrary.org{d['key']}" if d.get("key") else None,
        })
    return jsonify(candidates=out)


# ---------------------------------------------------------------- book feed

def _library_authors():
    """Full author names on the user's shelf, for spotting news about them."""
    names = set()
    for (a,) in db.connect().execute("SELECT j.value FROM books b, json_each(b.authors) j WHERE b.in_library=1"):
        a = " ".join(str(a).split())
        if len(a) >= 5 and " " in a:  # single surnames ("Roy", "King") match far too much
            names.add(a)
    return sorted(names, key=len, reverse=True)


@app.get("/api/feed")
def get_feed():
    a = request.args
    if a.get("auto") and not feed_refresher.running and feed_refresher.is_stale():
        feed_refresher.start()
    where, params = ["s.enabled=1"], []
    if a.get("region") in feeds.REGIONS:
        where.append("s.region=?")
        params.append(a["region"])
    if a.get("source_id"):
        where.append("s.id=?")
        params.append(int(a["source_id"]))
    if a.get("q"):
        where.append("(i.title LIKE ? OR i.summary LIKE ? OR i.author LIKE ?)")
        params += [f"%{a['q']}%"] * 3
    authors = _library_authors()
    if a.get("mine"):
        if not authors:
            return jsonify(items=[], total=0, page=1, per_page=30, authors=0, **_feed_meta())
        where.append("(" + " OR ".join("(i.title LIKE ? OR i.summary LIKE ?)" for _ in authors) + ")")
        for name in authors:
            params += [f"%{name}%"] * 2
    page, per = max(1, int(a.get("page", 1))), min(100, max(1, int(a.get("per_page", 30))))
    sql_where = " AND ".join(where)
    conn = db.connect()
    total = conn.execute(f"SELECT COUNT(*) FROM feed_items i JOIN feed_sources s ON s.id=i.source_id WHERE {sql_where}",
                         params).fetchone()[0]
    # Mix sources: each contributes its 4 newest stories, then the next 4, and so on, so one busy feed
    # (e.g. a Google News search with 100 results) can't crowd out the rest.
    rows = conn.execute(
        f"SELECT * FROM (SELECT i.*, s.name AS source, s.region, ROW_NUMBER() OVER "
        f"(PARTITION BY i.source_id ORDER BY i.published DESC) AS rn FROM feed_items i "
        f"JOIN feed_sources s ON s.id=i.source_id WHERE {sql_where}) "
        f"ORDER BY (rn - 1) / 4, published DESC LIMIT ? OFFSET ?", [*params, per, (page - 1) * per]).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        text = f"{d['title']} {d['summary'] or ''}".casefold()
        d["mentions"] = [n for n in authors if n.casefold() in text][:3]
        items.append(d)
    return jsonify(items=items, total=total, page=page, per_page=per, authors=len(authors), **_feed_meta())


def _feed_meta():
    row = db.connect().execute("SELECT MAX(last_fetched) last, SUM(enabled) enabled, "
                               "SUM(enabled AND last_error IS NOT NULL) failing FROM feed_sources").fetchone()
    return {"refreshing": feed_refresher.running, "last_refresh": row["last"], "sources_enabled": row["enabled"] or 0,
            "sources_failing": row["failing"] or 0, "message": feed_refresher.message, "regions": feeds.REGIONS}


@app.post("/api/feed/refresh")
def refresh_feed():
    started = feed_refresher.start()
    return jsonify(started=started, **_feed_meta())


@app.get("/api/feed/sources")
def feed_sources():
    rows = db.connect().execute("SELECT * FROM feed_sources ORDER BY region, builtin DESC, name").fetchall()
    return jsonify(sources=[dict(r) for r in rows], regions=feeds.REGIONS)


@app.post("/api/feed/sources")
def add_feed_source():
    data = body()
    url = str(data.get("url", "")).strip()
    region = data.get("region") if data.get("region") in feeds.REGIONS else "western"
    if not url.startswith(("http://", "https://")):
        raise ValueError("Enter a full feed address starting with http:// or https://")
    try:
        items = feeds.fetch(url)
    except Exception as e:
        raise ValueError(f"Couldn't read that feed: {e}") from None
    if not items:
        raise ValueError("That feed has no articles")
    name = str(data.get("name") or "").strip() or urllib.parse.urlparse(url).netloc.removeprefix("www.")
    conn = db.connect()
    conn.execute("INSERT INTO feed_sources(name, url, region) VALUES(?, ?, ?) "
                 "ON CONFLICT(url) DO UPDATE SET enabled=1, name=excluded.name, region=excluded.region",
                 (name[:120], url, region))
    source_id = conn.execute("SELECT id FROM feed_sources WHERE url=?", (url,)).fetchone()["id"]
    feed_refresher.start([source_id])
    return jsonify(id=source_id, name=name, items=len(items))


@app.put("/api/feed/sources/<int:source_id>")
def update_feed_source(source_id):
    data = body()
    if "enabled" in data:
        db.connect().execute("UPDATE feed_sources SET enabled=? WHERE id=?", (1 if data["enabled"] else 0, source_id))
    return jsonify(ok=True)


@app.delete("/api/feed/sources/<int:source_id>")
def delete_feed_source(source_id):
    n = db.connect().execute("DELETE FROM feed_sources WHERE id=? AND builtin=0", (source_id,)).rowcount
    if not n:
        raise ValueError("Built-in sources can be switched off but not deleted")
    return jsonify(ok=True)


# ---------------------------------------------------------------- export & stats

EXPORT_FIELDS = ["id", "title", "subtitle", "authors", "publisher", "publication_year", "isbn", "edition", "language",
                 "genre", "categories", "description", "topics", "target_audience", "keywords", "page_count",
                 "series", "series_volume", "confidence", "status", "reading_status", "rating", "favorite",
                 "shelf", "location", "tags", "user_notes", "created_at", "updated_at"]


@app.get("/api/export")
def export():
    where, params = _book_filters(request.args)
    rows = db.connect().execute(f"SELECT b.* FROM books b{where} ORDER BY b.title COLLATE NOCASE", params).fetchall()
    books = [db.book_from_row(r) for r in rows]
    conn = db.connect()
    shelf_names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM shelves")}
    for b in books:
        b["shelf"] = shelf_names.get(b.get("shelf_id"), "Unsorted")
        b["images"] = [r[0] for r in conn.execute(
            "SELECT i.path FROM images i JOIN book_images bi ON bi.image_id=i.id WHERE bi.book_id=?", (b["id"],))]
    if request.args.get("format") == "json":
        return Response(json.dumps(books, ensure_ascii=False, indent=2), mimetype="application/json",
                        headers={"Content-Disposition": "attachment; filename=library.json"})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(EXPORT_FIELDS + ["images"])
    for b in books:
        w.writerow(["; ".join(map(str, b[f])) if isinstance(b.get(f), list) else b.get(f)
                    for f in EXPORT_FIELDS] + ["; ".join(b["images"])])
    return Response("﻿" + buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=library.csv"})


@app.get("/api/stats")
def stats():
    conn = db.connect()
    one = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    lib = "in_library=1"
    return jsonify(
        books=one(f"SELECT COUNT(*) FROM books WHERE {lib}"),
        authors=one(f"SELECT COUNT(DISTINCT j.value) FROM books b, json_each(b.authors) j WHERE b.{lib}"),
        read=one(f"SELECT COUNT(*) FROM books WHERE {lib} AND reading_status='read'"),
        reading=one(f"SELECT COUNT(*) FROM books WHERE {lib} AND reading_status='reading'"),
        favorites=one(f"SELECT COUNT(*) FROM books WHERE {lib} AND favorite=1"),
        pages=one(f"SELECT COALESCE(SUM(page_count), 0) FROM books WHERE {lib}"),
        verified=one(f"SELECT COUNT(*) FROM books WHERE {lib} AND status='verified'"),
        uncertain=one(f"SELECT COUNT(*) FROM books WHERE {lib} AND status='uncertain'"),
        finds=one("SELECT COUNT(*) FROM books WHERE in_library=0"),
        top_genres=[dict(r) for r in conn.execute(
            f"SELECT genre AS value, COUNT(*) n FROM books WHERE {lib} AND genre IS NOT NULL "
            f"GROUP BY genre ORDER BY n DESC LIMIT 6")],
    )


def _already_running(host, port):
    """True if Shelfie itself is already answering on this port (e.g. the launcher was double-clicked twice)."""
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/status", timeout=1.5) as r:
            return "processor" in json.loads(r.read())
    except Exception:
        return False


def _free_port(host, start):
    """The first free port from `start`, so another program using 5173 doesn't stop Shelfie from starting."""
    import socket
    for port in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    return start


def main():
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5173"))
    if _already_running(host, port):
        url = f"http://{host}:{port}/"
        print(f"\n  Shelfie is already running. Opening {url}\n")
        if not os.environ.get("NO_BROWSER"):
            webbrowser.open(url)
        sys.exit(3)  # tells the launcher "already open" rather than "stopped"
    db.init()
    feeds.init()
    port = _free_port(host, port)
    url = f"http://{host}:{port}/"
    print(f"\n  Shelfie is running at {url}\n  Your library is saved in: {db.DATA_DIR}\n"
          f"  Keep this window open while you use Shelfie. Close it (or press Ctrl+C) to stop.\n")
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    # Keep the console calm for non-technical users: no per-request lines or server banner.
    import logging
    import flask.cli
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    flask.cli.show_server_banner = lambda *a, **k: None
    app.run(host=host, port=port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
