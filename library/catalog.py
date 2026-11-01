"""Turning AI results into books: cleaning, ISBN validation, de-duplication, linking and merging."""
import json
import re

from . import db

NULLISH = {"", "unknown", "n/a", "na", "none", "null", "not visible", "not available", "not specified",
           "uncertain", "unclear", "illegible", "-", "?", "unk"}

TEXT_FIELDS = ("title", "subtitle", "publisher", "publication_year", "isbn", "edition", "language", "genre",
               "description", "target_audience", "series", "series_volume")
LIST_FIELDS = ("authors", "categories", "topics", "keywords")
EDITABLE_FIELDS = TEXT_FIELDS + LIST_FIELDS + (
    "page_count", "reading_status", "rating", "favorite", "location", "user_notes", "tags", "cover_image_id")
READING_STATUSES = {"unread", "reading", "read", "abandoned", "wishlist"}


# ---------------------------------------------------------------- cleaning

def clean_str(v, maxlen=2000):
    if v is None:
        return None
    if not isinstance(v, str):
        v = str(v)
    v = " ".join(v.split()).strip()
    if v.casefold() in NULLISH:
        return None
    return v[:maxlen]


def clean_list(v, max_items=25):
    if not v:
        return []
    if isinstance(v, str):
        v = re.split(r"[;,\n]", v)
    out, seen = [], set()
    for x in v:
        s = clean_str(x, 200)
        if s and s.casefold() not in seen:
            seen.add(s.casefold())
            out.append(s)
    return out[:max_items]


def _isbn10_ok(s):
    if not re.fullmatch(r"\d{9}[\dX]", s):
        return False
    total = sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(s))
    return total % 11 == 0


def _isbn13_ok(s):
    if not re.fullmatch(r"\d{13}", s):
        return False
    return sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(s)) % 10 == 0


def _isbn10_to_13(s):
    core = "978" + s[:9]
    check = (10 - sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(core)) % 10) % 10
    return core + str(check)


def normalize_isbn(raw):
    """Returns (display_isbn, isbn13 or None if not a valid ISBN)."""
    raw = clean_str(raw, 40)
    if not raw:
        return None, None
    s = re.sub(r"[^0-9Xx]", "", raw).upper()
    if _isbn13_ok(s):
        return s, s
    if _isbn10_ok(s):
        return s, _isbn10_to_13(s)
    return raw, None


def clean_year(v):
    v = clean_str(v, 40)
    if not v:
        return None
    m = re.search(r"\b(1[4-9]\d\d|20\d\d)\b", v)
    return m.group(1) if m else None


def clean_int(v, lo=1, hi=20000):
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    return n if lo <= n <= hi else None


def clean_confidence(v):
    try:
        c = float(v)
    except (TypeError, ValueError):
        return 0.0
    if 1 < c <= 100:
        c /= 100
    return max(0.0, min(1.0, c))


def norm_title(title):
    t = (title or "").casefold()
    t = t.split(":")[0]
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"^(the|a|an)\s+", "", t.strip())
    return " ".join(t.split())


def norm_author(authors):
    if not authors:
        return ""
    words = re.sub(r"[^\w\s]", " ", authors[0].casefold()).split()
    return words[-1] if words else ""


def clean_ai_book(raw):
    """Sanitise one book entry from Gemini into our field set."""
    b = {f: clean_str(raw.get(f)) for f in TEXT_FIELDS}
    for f in LIST_FIELDS:
        b[f] = clean_list(raw.get(f))
    b["keywords"] = b["keywords"][:10]
    if b["description"]:
        b["description"] = b["description"][:1200]
    b["publication_year"] = clean_year(raw.get("publication_year"))
    b["page_count"] = clean_int(raw.get("page_count"))
    b["confidence"] = clean_confidence(raw.get("confidence"))
    uncertain = clean_list(raw.get("uncertain_fields"))
    b["isbn"], b["isbn13"] = normalize_isbn(raw.get("isbn"))
    if b["isbn"] and not b["isbn13"] and "isbn" not in uncertain:
        uncertain.append("isbn")  # printed something, but it fails the ISBN checksum
    b["uncertain_fields"] = uncertain
    notes = [clean_str(raw.get("notes")), clean_str(raw.get("visible_text"))]
    b["ai_notes"] = " | ".join(f"{label}: {n}" for label, n in zip(("Notes", "Read"), notes) if n) or None
    return b


# ---------------------------------------------------------------- matching

def find_duplicate(conn, title, authors, isbn13, exclude_id=None):
    """Find an existing book that is the same edition (ISBN) or the same work by the same author."""
    excl = exclude_id or -1
    if isbn13:
        row = conn.execute("SELECT id FROM books WHERE isbn13=? AND id<>?", (isbn13, excl)).fetchone()
        if row:
            return row["id"]
    tn, an = norm_title(title), norm_author(authors)
    if not tn:
        return None
    for row in conn.execute("SELECT id, isbn13, author_norm FROM books WHERE title_norm=? AND id<>?", (tn, excl)):
        if isbn13 and row["isbn13"] and row["isbn13"] != isbn13:
            continue  # different editions of the same work are kept apart
        if an and row["author_norm"] and an != row["author_norm"]:
            continue
        return row["id"]
    return None


def _insert_book(conn, b, status, source="ai", cover_image_id=None, in_library=0):
    ts = db.now()
    cols = {
        **{f: b.get(f) for f in TEXT_FIELDS},
        **{f: json.dumps(b.get(f) or [], ensure_ascii=False) for f in LIST_FIELDS},
        "isbn13": b.get("isbn13"),
        "page_count": b.get("page_count"),
        "confidence": b.get("confidence"),
        "uncertain_fields": json.dumps(b.get("uncertain_fields") or [], ensure_ascii=False),
        "ai_notes": b.get("ai_notes"),
        "status": status,
        "source": source,
        "cover_image_id": cover_image_id,
        "in_library": in_library,
        # A book found in a photo is a physical copy; manual books say for themselves.
        "has_hardcopy": 1 if source == "ai" else (1 if b.get("has_hardcopy", 1) else 0),
        "has_pdf": 1 if b.get("has_pdf") else 0,
        "title_norm": norm_title(b["title"]),
        "author_norm": norm_author(b.get("authors")),
        "created_at": ts,
        "updated_at": ts,
    }
    for f in ("reading_status", "rating", "favorite", "location", "user_notes", "tags"):
        if f in b:
            cols[f] = json.dumps(b[f], ensure_ascii=False) if f == "tags" else b[f]
    sql = f"INSERT INTO books({', '.join(cols)}) VALUES({', '.join('?' * len(cols))})"
    return conn.execute(sql, list(cols.values())).lastrowid


def _fill_empty(conn, book_id, b, threshold):
    """Add information from a new sighting to an existing book without overwriting anything."""
    row = conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
    updates = {}
    for f in TEXT_FIELDS:
        if not row[f] and b.get(f):
            updates[f] = b[f]
            if f == "isbn":
                updates["isbn13"] = b.get("isbn13")
    for f in LIST_FIELDS:
        if json.loads(row[f] or "[]") == [] and b.get(f):
            updates[f] = json.dumps(b[f], ensure_ascii=False)
    if row["page_count"] is None and b.get("page_count"):
        updates["page_count"] = b["page_count"]
    if row["status"] != "verified":
        conf = max(row["confidence"] or 0, b.get("confidence") or 0)
        updates["confidence"] = conf
        updates["status"] = "identified" if conf >= threshold else "uncertain"
    if updates:
        updates["updated_at"] = db.now()
        conn.execute(f"UPDATE books SET {', '.join(f'{k}=?' for k in updates)} WHERE id=?",
                     [*updates.values(), book_id])


def upsert_ai_book(conn, b, threshold, image_id):
    match = find_duplicate(conn, b["title"], b["authors"], b["isbn13"])
    if match:
        _fill_empty(conn, match, b, threshold)
        return match
    status = "identified" if b["confidence"] >= threshold else "uncertain"
    return _insert_book(conn, b, status, cover_image_id=image_id)


# ---------------------------------------------------------------- applying results

def apply_entry(conn, image_id, entry, threshold):
    """Apply one image's AI result (fresh or cached). Returns the resulting image status."""
    books = [clean_ai_book(b) for b in (entry.get("books") or []) if isinstance(b, dict)]
    issue = clean_str(entry.get("issue"), 500)
    unlink_image_books(conn, image_id)

    linked_conf, unreadable = [], 0
    for b in books:
        if not b["title"]:
            unreadable += 1
            continue
        book_id = upsert_ai_book(conn, b, threshold, image_id)
        conn.execute("INSERT OR IGNORE INTO book_images(book_id, image_id) VALUES(?, ?)", (book_id, image_id))
        linked_conf.append(b["confidence"])

    if linked_conf:
        ok = min(linked_conf) >= threshold and not unreadable
        status = "identified" if ok else "uncertain"
        if unreadable:
            issue = f"{unreadable} book(s) in this image could not be read" + (f"; {issue}" if issue else "")
    elif books or entry.get("contains_book"):
        status = "uncertain"
        issue = issue or "A book is visible but its title could not be read"
    else:
        status = "not_book"
        issue = issue or "No book detected"

    conn.execute(
        "UPDATE images SET status=?, confidence=?, error=?, analyzed_at=? WHERE id=?",
        (status, max(linked_conf) if linked_conf else None, issue, db.now(), image_id),
    )
    return status


def cleanup_orphans(conn, book_ids):
    """Remove AI-created, unverified books that no longer have any image."""
    for bid in set(book_ids):
        conn.execute(
            "DELETE FROM books WHERE id=? AND source='ai' AND status<>'verified' "
            "AND NOT EXISTS (SELECT 1 FROM book_images WHERE book_id=?)", (bid, bid))


def unlink_image_books(conn, image_id):
    ids = [r["book_id"] for r in conn.execute("SELECT book_id FROM book_images WHERE image_id=?", (image_id,))]
    conn.execute("DELETE FROM book_images WHERE image_id=?", (image_id,))
    cleanup_orphans(conn, ids)


def link_images(conn, image_ids, book_id):
    """Make these images belong to exactly this book (manual matching)."""
    for iid in image_ids:
        unlink_image_books(conn, iid)
        conn.execute("INSERT OR IGNORE INTO book_images(book_id, image_id) VALUES(?, ?)", (book_id, iid))
        conn.execute("UPDATE images SET status='identified', error=NULL WHERE id=?", (iid,))


# ---------------------------------------------------------------- user edits

def clean_user_book(data, partial=True):
    out = {}
    for f in TEXT_FIELDS:
        if f in data:
            out[f] = clean_str(data[f], 4000)
    for f in LIST_FIELDS + ("tags",):
        if f in data:
            out[f] = clean_list(data[f], 100)
    if "publication_year" in data:
        out["publication_year"] = clean_str(data["publication_year"], 20)
    if "isbn" in data:
        out["isbn"], out["isbn13"] = normalize_isbn(data["isbn"])
    if "page_count" in data:
        out["page_count"] = clean_int(data["page_count"])
    if "rating" in data:
        out["rating"] = clean_int(data["rating"], 1, 5)
    for flag in ("favorite", "has_hardcopy", "has_pdf"):
        if flag in data:
            out[flag] = 1 if data[flag] else 0
    if "reading_status" in data:
        rs = data["reading_status"]
        out["reading_status"] = rs if rs in READING_STATUSES else "unread"
    for f in ("location", "user_notes"):
        if f in data:
            out[f] = clean_str(data[f], 4000) if f == "location" else (data[f] or "").strip() or None
    if "cover_image_id" in data:
        out["cover_image_id"] = clean_int(data["cover_image_id"], 1, 10**12)
    if not partial and not out.get("title"):
        raise ValueError("Title is required")
    if partial and "title" in out and not out["title"]:
        raise ValueError("Title cannot be empty")
    return out


def update_book(conn, book_id, data, verify=False):
    fields = clean_user_book(data)
    updates = {}
    for k, v in fields.items():
        updates[k] = json.dumps(v, ensure_ascii=False) if isinstance(v, list) else v
    row = conn.execute("SELECT title, authors, isbn13 FROM books WHERE id=?", (book_id,)).fetchone()
    if row is None:
        raise LookupError("Book not found")
    title = fields.get("title", row["title"])
    authors = fields.get("authors", json.loads(row["authors"] or "[]"))
    isbn13 = fields["isbn13"] if "isbn13" in fields else row["isbn13"]
    updates["title_norm"] = norm_title(title)
    updates["author_norm"] = norm_author(authors)
    if verify:
        updates["status"] = "verified"
        updates["uncertain_fields"] = "[]"
        conn.execute("UPDATE images SET status='identified' WHERE status='uncertain' AND id IN "
                     "(SELECT image_id FROM book_images WHERE book_id=?)", (book_id,))
    updates["updated_at"] = db.now()
    conn.execute(f"UPDATE books SET {', '.join(f'{k}=?' for k in updates)} WHERE id=?",
                 [*updates.values(), book_id])
    return find_duplicate(conn, title, authors, isbn13, exclude_id=book_id)


def create_book(conn, data, image_ids=()):
    b = clean_user_book(data, partial=False)
    for f in TEXT_FIELDS:
        b.setdefault(f, None)
    for f in LIST_FIELDS:
        b.setdefault(f, [])
    b.setdefault("isbn13", None)
    b["confidence"] = 1.0
    book_id = _insert_book(conn, b, "verified", source="manual",
                           cover_image_id=image_ids[0] if image_ids else None, in_library=1)
    link_images(conn, image_ids, book_id)
    return book_id


def merge_books(conn, target_id, source_ids):
    """Fold source books into the target: move images, fill gaps, union tags/lists, delete sources."""
    target = conn.execute("SELECT * FROM books WHERE id=?", (target_id,)).fetchone()
    if not target:
        raise LookupError("Target book not found")
    merged = dict(target)
    for sid in source_ids:
        if sid == target_id:
            continue
        src = conn.execute("SELECT * FROM books WHERE id=?", (sid,)).fetchone()
        if not src:
            continue
        for f in TEXT_FIELDS + ("isbn13", "page_count", "location", "user_notes", "rating"):
            if not merged.get(f) and src[f]:
                merged[f] = src[f]
        for f in LIST_FIELDS + ("tags",):
            merged[f] = json.dumps(clean_list(json.loads(merged[f] or "[]") + json.loads(src[f] or "[]"), 100),
                                   ensure_ascii=False)
        merged["favorite"] = merged["favorite"] or src["favorite"]
        merged["has_hardcopy"] = max(merged["has_hardcopy"], src["has_hardcopy"])
        merged["has_pdf"] = max(merged["has_pdf"], src["has_pdf"])
        if not merged.get("ebook_name") and src["ebook_name"] and db.ebook_path(sid, src["ebook_ext"]).exists():
            db.move_ebook_file(sid, target_id, src["ebook_ext"])  # keep the source's eBook on the merged book
            for f in ("ebook_name", "ebook_ext", "ebook_size", "ebook_pages", "ebook_page", "ebook_pos", "ebook_pct"):
                merged[f] = src[f]
        merged["in_library"] = max(merged["in_library"], src["in_library"])
        conn.execute("INSERT OR IGNORE INTO book_images(book_id, image_id) "
                     "SELECT ?, image_id FROM book_images WHERE book_id=?", (target_id, sid))
        conn.execute("DELETE FROM books WHERE id=?", (sid,))
    merged["status"] = "verified"
    merged["updated_at"] = db.now()
    keys = [k for k in merged if k not in ("id", "created_at")]
    conn.execute(f"UPDATE books SET {', '.join(f'{k}=?' for k in keys)} WHERE id=?",
                 [merged[k] for k in keys] + [target_id])
    conn.execute("UPDATE images SET status='identified', error=NULL WHERE id IN "
                 "(SELECT image_id FROM book_images WHERE book_id=?) AND status='uncertain'", (target_id,))
