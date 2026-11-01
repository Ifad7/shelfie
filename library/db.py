"""SQLite storage: settings, folders, images, books, analysis cache and API usage."""
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("LIBRARY_DATA_DIR", ROOT / "data"))
DB_PATH = DATA_DIR / "library.db"
THUMB_DIR = DATA_DIR / "thumbs"
PDF_DIR = DATA_DIR / "pdfs"


def pdf_path(book_id):
    return PDF_DIR / f"{int(book_id)}.pdf"


def remove_pdf_file(book_id):
    """Delete a book's PDF; on Windows a file that's open (e.g. being read) can't be deleted, so don't fail on that."""
    try:
        pdf_path(book_id).unlink(missing_ok=True)
    except OSError:
        pass


def move_pdf_file(src_id, dst_id):
    """Give book dst the PDF of book src (copying if Windows has the file locked)."""
    import shutil
    try:
        pdf_path(src_id).replace(pdf_path(dst_id))
    except OSError:
        shutil.copyfile(pdf_path(src_id), pdf_path(dst_id))
        remove_pdf_file(src_id)

BOOK_JSON_FIELDS = ("authors", "categories", "topics", "keywords", "uncertain_fields", "tags")

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    recursive INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    last_scan TEXT
);
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT,
    authors TEXT NOT NULL DEFAULT '[]',
    publisher TEXT,
    publication_year TEXT,
    isbn TEXT,
    isbn13 TEXT,
    edition TEXT,
    language TEXT,
    genre TEXT,
    categories TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    topics TEXT NOT NULL DEFAULT '[]',
    target_audience TEXT,
    keywords TEXT NOT NULL DEFAULT '[]',
    page_count INTEGER,
    series TEXT,
    series_volume TEXT,
    confidence REAL,
    uncertain_fields TEXT NOT NULL DEFAULT '[]',
    ai_notes TEXT,
    status TEXT NOT NULL DEFAULT 'identified',
    source TEXT NOT NULL DEFAULT 'ai',
    reading_status TEXT NOT NULL DEFAULT 'unread',
    rating INTEGER,
    favorite INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    user_notes TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    cover_image_id INTEGER,
    in_library INTEGER NOT NULL DEFAULT 0,
    title_norm TEXT,
    author_norm TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_books_isbn13 ON books(isbn13);
CREATE INDEX IF NOT EXISTS idx_books_title_norm ON books(title_norm);
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    size INTEGER,
    mtime REAL,
    sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    confidence REAL,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0,
    analyzed_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_sha ON images(sha256);
CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder_id);
CREATE TABLE IF NOT EXISTS book_images (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_book_images_image ON book_images(image_id);
CREATE TABLE IF NOT EXISTS shelves (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    position REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_cache (
    sha256 TEXT PRIMARY KEY,
    model TEXT,
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_usage (
    day TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    rate_limited INTEGER NOT NULL DEFAULT 0
);
"""

DEFAULT_SETTINGS = {
    "api_key": "",
    # An alias Google keeps pointed at its current Flash model, so it does not go stale.
    "model": "gemini-flash-latest",
    # Used when the main model keeps answering "high demand" (503). Empty = no fallback.
    "fallback_model": "gemini-flash-lite-latest",
    # Conservative defaults that sit under typical Gemini free-tier limits.
    "rpm": 8,
    "daily_limit": 200,
    "batch_size": 3,
    "confidence_threshold": 0.7,
    "max_image_px": 1600,
    "jpeg_quality": 85,
}

_local = threading.local()


def now():
    return datetime.now().isoformat(timespec="seconds")


try:
    from zoneinfo import ZoneInfo
    _QUOTA_TZ = ZoneInfo("America/Los_Angeles")
except Exception:  # no tz database (Windows without the tzdata package)
    _QUOTA_TZ = None


def today():
    """The quota day. Gemini's requests-per-day limits reset at midnight Pacific time."""
    if _QUOTA_TZ:
        return datetime.now(_QUOTA_TZ).date().isoformat()
    return (datetime.now(timezone.utc) - timedelta(hours=8)).date().isoformat()


def quota_reset_at():
    """When Gemini's daily quotas next reset (midnight Pacific), as a UTC ISO timestamp."""
    if _QUOTA_TZ:
        now = datetime.now(_QUOTA_TZ)
        midnight = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), tzinfo=_QUOTA_TZ)
        return midnight.astimezone(timezone.utc).isoformat()
    now = datetime.now(timezone.utc) - timedelta(hours=8)
    midnight = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc)
    return (midnight + timedelta(hours=8)).isoformat()


def connect():
    conn = getattr(_local, "conn", None)
    if conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn = conn
    return conn


@contextmanager
def tx():
    """Run a block in a single write transaction."""
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def init():
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    conn.executescript(SCHEMA)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(books)")}
    if "in_library" not in cols:
        # Older databases had no "New finds" step: everything already in them was in the library.
        conn.execute("ALTER TABLE books ADD COLUMN in_library INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE books SET in_library=1")
    if "shelf_id" not in cols:
        # Named shelves: books with no shelf_id sit on the "Unsorted" shelf; shelf_pos orders them.
        conn.execute("ALTER TABLE books ADD COLUMN shelf_id INTEGER")
        conn.execute("ALTER TABLE books ADD COLUMN shelf_pos REAL")
        conn.execute("UPDATE books SET shelf_pos=(SELECT COUNT(*) FROM books b2 WHERE b2.created_at < books.created_at "
                      "OR (b2.created_at = books.created_at AND b2.id < books.id)) WHERE in_library=1")
    # Formats you own (hardcopy / PDF), an uploaded PDF, and how far you've read it.
    for col, ddl in (("has_hardcopy", "INTEGER NOT NULL DEFAULT 0"), ("has_pdf", "INTEGER NOT NULL DEFAULT 0"),
                     ("pdf_name", "TEXT"), ("pdf_size", "INTEGER"), ("pdf_pages", "INTEGER"), ("pdf_page", "INTEGER")):
        if col not in cols:
            conn.execute(f"ALTER TABLE books ADD COLUMN {col} {ddl}")
            if col == "has_hardcopy":  # books found from photos are physical copies
                conn.execute("UPDATE books SET has_hardcopy=1 WHERE EXISTS "
                             "(SELECT 1 FROM book_images bi WHERE bi.book_id=books.id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_books_in_library ON books(in_library)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_books_shelf ON books(shelf_id, shelf_pos)")
    # Anything left "processing" by a crash or shutdown goes back in the queue.
    conn.execute("UPDATE images SET status='pending' WHERE status='processing'")


# ---------------------------------------------------------------- settings

def get_settings():
    rows = connect().execute("SELECT key, value FROM settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except ValueError:
            out[r["key"]] = r["value"]
    if not out.get("api_key"):
        out["api_key"] = os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")
        out["api_key_from_env"] = bool(out["api_key"])
    return out


def save_settings(values):
    with tx() as conn:
        for k, v in values.items():
            if k in DEFAULT_SETTINGS:
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (k, json.dumps(v)),
                )


# ---------------------------------------------------------------- usage

def record_usage(requests=0, images=0, input_tokens=0, output_tokens=0, rate_limited=0):
    connect().execute(
        "INSERT INTO api_usage(day, requests, images, input_tokens, output_tokens, rate_limited) "
        "VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET "
        "requests=requests+excluded.requests, images=images+excluded.images, "
        "input_tokens=input_tokens+excluded.input_tokens, "
        "output_tokens=output_tokens+excluded.output_tokens, "
        "rate_limited=rate_limited+excluded.rate_limited",
        (today(), requests, images, input_tokens, output_tokens, rate_limited),
    )


def usage_today():
    row = connect().execute("SELECT * FROM api_usage WHERE day=?", (today(),)).fetchone()
    if not row:
        return {"day": today(), "requests": 0, "images": 0, "input_tokens": 0,
                "output_tokens": 0, "rate_limited": 0}
    return dict(row)


# ---------------------------------------------------------------- books

def book_from_row(row):
    if row is None:
        return None
    b = dict(row)
    for f in BOOK_JSON_FIELDS:
        try:
            b[f] = json.loads(b.get(f) or "[]")
        except ValueError:
            b[f] = []
    b["favorite"] = bool(b.get("favorite"))
    b["has_hardcopy"] = bool(b.get("has_hardcopy"))
    b["has_pdf"] = bool(b.get("has_pdf"))
    b["pdf_available"] = bool(b.get("pdf_name"))
    b.pop("title_norm", None)
    b.pop("author_norm", None)
    return b


def move_books(conn, book_ids, shelf_id):
    """Put books at the end of a shelf (shelf_id None = Unsorted), keeping their relative order."""
    if shelf_id is not None and not conn.execute("SELECT 1 FROM shelves WHERE id=?", (shelf_id,)).fetchone():
        raise LookupError("Shelf not found")
    top = conn.execute("SELECT COALESCE(MAX(shelf_pos), -1) FROM books WHERE shelf_id IS ?", (shelf_id,)).fetchone()[0]
    for n, bid in enumerate(book_ids, 1):
        conn.execute("UPDATE books SET shelf_id=?, shelf_pos=?, updated_at=? WHERE id=?", (shelf_id, top + n, now(), bid))


COVER_SQL = (
    "COALESCE((SELECT image_id FROM book_images WHERE book_id=b.id AND image_id=b.cover_image_id), "
    "(SELECT MIN(image_id) FROM book_images WHERE book_id=b.id)) AS cover_id"
)


def get_book(book_id):
    conn = connect()
    row = conn.execute(f"SELECT b.*, {COVER_SQL} FROM books b WHERE b.id=?", (book_id,)).fetchone()
    book = book_from_row(row)
    if book:
        imgs = conn.execute(
            "SELECT i.id, i.filename, i.path, i.status, i.confidence FROM images i "
            "JOIN book_images bi ON bi.image_id=i.id WHERE bi.book_id=? ORDER BY i.id",
            (book_id,),
        ).fetchall()
        book["images"] = [dict(r) for r in imgs]
    return book
