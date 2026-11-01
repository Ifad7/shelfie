"""Book-news feed: fetch RSS/Atom feeds from book sections around the world and store them locally.

No API key and no Gemini quota involved; feeds are plain public RSS.
"""
import concurrent.futures
import html
import html.entities
import re
import threading
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from . import db

REGIONS = {"western": "Western", "indian": "Indian", "bangladeshi": "Bangladeshi", "asian": "Asian & World"}
STALE_AFTER = timedelta(minutes=30)
KEEP_DAYS = 45
USER_AGENT = "Mozilla/5.0 (Shelfie personal library; RSS reader)"


def google_news(query, hl="en-US", gl="US"):
    """Google News search as RSS: fills gaps where a region's publications have no books feed."""
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": f"{query} when:30d", "hl": hl, "gl": gl, "ceid": f"{gl}:{hl.split('-')[0]}"})


# All checked to be live and book-focused (November 2026).
BUILTIN_SOURCES = [
    ("The Guardian · Books", "https://www.theguardian.com/books/rss", "western"),
    ("The New York Times · Books", "https://rss.nytimes.com/services/xml/rss/nyt/Books.xml", "western"),
    ("Literary Hub", "https://lithub.com/feed/", "western"),
    ("NPR · Books", "https://feeds.npr.org/1032/rss.xml", "western"),
    ("Book Riot", "https://bookriot.com/feed/", "western"),
    ("The Paris Review", "https://www.theparisreview.org/blog/feed/", "western"),
    ("The Hindu · Books", "https://www.thehindu.com/books/feeder/default.rss", "indian"),
    ("The Hindu · Literary Review", "https://www.thehindu.com/books/literary-review/feeder/default.rss", "indian"),
    ("Indian Express · Books & Literature", "https://indianexpress.com/section/books-and-literature/feed/", "indian"),
    ("Hindustan Times · Books", "https://www.hindustantimes.com/feeds/rss/books/rssfeed.xml", "indian"),
    ("The Daily Star · Books & Literature", "https://www.thedailystar.net/books-literature/rss.xml", "bangladeshi"),
    ("বই ও সাহিত্য · Google News", google_news("বই OR সাহিত্য OR লেখক OR বইমেলা OR কবিতা OR উপন্যাস", "bn", "BD"), "bangladeshi"),
    ("Bangladeshi writers · Google News", google_news(
        '"Bangladeshi author" OR "Bangladeshi writer" OR "Bangladeshi poet" OR "Bangla literature" OR '
        '"Bengali literature" OR "Ekushey Book Fair"', "en-BD", "BD"), "bangladeshi"),
    ("Asian Review of Books", "https://asianreviewofbooks.com/content/feed/", "asian"),
    ("Words Without Borders", "https://wordswithoutborders.org/feed/", "asian"),
    ("World Literature Today", "https://www.worldliteraturetoday.org/rss.xml", "asian"),
    ("East Asian literature · Google News", google_news(
        '("Japanese literature" OR "Korean literature" OR "Chinese literature" OR "translated novel" OR '
        '"Murakami" OR "Han Kang")'), "asian"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS feed_sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    region TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0,
    last_fetched TEXT,
    last_error TEXT,
    item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS feed_items (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT,
    summary TEXT,
    image TEXT,
    author TEXT,
    published TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    UNIQUE(source_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_feed_items_published ON feed_items(published);
"""

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "media": "http://search.yahoo.com/mrss/",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def init():
    conn = db.connect()
    conn.executescript(SCHEMA)
    for name, url, region in BUILTIN_SOURCES:
        conn.execute("INSERT INTO feed_sources(name, url, region, builtin) VALUES(?, ?, ?, 1) "
                     "ON CONFLICT(url) DO UPDATE SET name=excluded.name, region=excluded.region, builtin=1",
                     (name, url, region))


# ---------------------------------------------------------------- parsing

_TAG = re.compile(r"<[^>]+>")
_IMG = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.I)


def _text(el):
    """Element text including any (mis-escaped) child markup, as plain text."""
    if el is None:
        return ""
    return " ".join(html.unescape(_TAG.sub(" ", "".join(el.itertext()))).split())


def _clean_html(s, limit=420):
    s = " ".join(html.unescape(_TAG.sub(" ", s or "")).split())
    return (s[:limit].rsplit(" ", 1)[0] + "…") if len(s) > limit else s


def _date(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def _image(item, raw_html):
    best, best_w = None, -1
    for m in item.findall("media:content", NS) + item.findall("media:thumbnail", NS):
        url, kind = m.get("url"), (m.get("type") or m.get("medium") or "image")
        if not url or not ("image" in kind or m.tag.endswith("thumbnail")):
            continue
        w = int(m.get("width") or 0)
        if best is None or (best_w < w <= 900):
            best, best_w = url, w
    if best:
        return best
    for enc in item.findall("enclosure"):
        if (enc.get("type") or "").startswith("image") and enc.get("url"):
            return enc.get("url")
    m = _IMG.search(raw_html or "")
    return html.unescape(m.group(1)) if m else None


_XML_ENTITIES = {b"amp", b"lt", b"gt", b"quot", b"apos"}


def _fix_entities(data):
    """Make sloppy feeds parseable: escape stray '&' and turn HTML entities (&nbsp; …) into numeric ones."""
    def named(m):
        name = m.group(1)
        if name in _XML_ENTITIES:
            return m.group(0)
        cp = html.entities.name2codepoint.get(name.decode("ascii", "ignore"))
        return f"&#{cp};".encode() if cp else b"&amp;" + name + b";"
    data = re.sub(rb"&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)", b"&amp;", data)
    return re.sub(rb"&([a-zA-Z][a-zA-Z0-9]*);", named, data)


def _parse_loose(data):
    """Last resort for broken XML: pull <item> blocks out with regular expressions."""
    text = data.decode("utf-8", "replace")
    out = []
    for block in re.findall(r"<item\b.*?</item>", text, re.S | re.I):
        def tag(name):
            m = re.search(rf"<{name}\b[^>]*>(.*?)</{name}>", block, re.S | re.I)
            return re.sub(r"^<!\[CDATA\[|\]\]>$", "", m.group(1).strip()) if m else ""
        title = _clean_html(tag("title"), 400)
        if not title:
            continue
        link = _clean_html(tag("link"), 1000) or None
        raw = tag("content:encoded") or tag("description")
        date = _date(_clean_html(tag("pubDate"), 80))
        out.append({"guid": (_clean_html(tag("guid"), 500) or link or title)[:500], "title": title, "link": link,
                    "summary": _clean_html(raw), "image": (lambda m: html.unescape(m.group(1)) if m else None)(_IMG.search(raw)),
                    "author": _clean_html(tag("dc:creator"), 200) or None,
                    "published": (date or datetime.now(timezone.utc)).isoformat(timespec="seconds")})
    return out


def parse(data):
    """Parse RSS 2.0 or Atom bytes into a list of item dicts."""
    try:
        root = ET.fromstring(_fix_entities(data.lstrip()))
    except ET.ParseError:
        items = _parse_loose(data)
        if items:
            return items
        raise ValueError("This doesn't look like an RSS or Atom feed") from None
    out = []
    items = root.findall(".//item")
    atom = not items
    if atom:
        items = root.findall(".//atom:entry", NS)
    for it in items:
        if atom:
            title = _text(it.find("atom:title", NS))
            link_el = next((l for l in it.findall("atom:link", NS) if l.get("rel") in (None, "alternate")), None)
            link = link_el.get("href") if link_el is not None else None
            body_el = it.find("atom:summary", NS)
            if body_el is None:
                body_el = it.find("atom:content", NS)
            raw = "".join(body_el.itertext()) if body_el is not None else ""
            date = _date(it.findtext("atom:published", None, NS) or it.findtext("atom:updated", None, NS))
            guid = it.findtext("atom:id", None, NS) or link
            author = _text(it.find("atom:author/atom:name", NS))
        else:
            title = _text(it.find("title"))
            link = (it.findtext("link") or "").strip() or None
            raw = it.findtext("content:encoded", None, NS) or it.findtext("description") or ""
            date = _date(it.findtext("pubDate") or it.findtext("dc:date", None, NS))
            guid = (it.findtext("guid") or link or title).strip()
            author = _text(it.find("dc:creator", NS)) or _text(it.find("author"))
        if not title:
            continue
        out.append({"guid": guid[:500], "title": title[:400], "link": link, "summary": _clean_html(raw),
                    "image": _image(it, raw), "author": author[:200] or None,
                    "published": (date or datetime.now(timezone.utc)).isoformat(timespec="seconds")})
    return out


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return parse(resp.read())


def _google_news_tidy(item):
    """Google News titles end with ' - Publisher'; move that into the author slot."""
    m = re.match(r"^(.*) - ([^-]{2,60})$", item["title"])
    if m:
        item["title"], item["author"] = m.group(1).strip(), m.group(2).strip()
    if item["summary"] and item["summary"].startswith(item["title"][:30]):
        item["summary"] = ""
    return item


# ---------------------------------------------------------------- refreshing

class Refresher:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread = None
        self.last_run = None
        self.message = ""

    @property
    def running(self):
        return bool(self._thread and self._thread.is_alive())

    def is_stale(self):
        row = db.connect().execute("SELECT MAX(last_fetched) FROM feed_sources WHERE enabled=1").fetchone()[0]
        return not row or datetime.fromisoformat(row) < datetime.now() - STALE_AFTER

    def start(self, source_ids=None):
        with self._lock:
            if self.running:
                return False
            self._thread = threading.Thread(target=self._run, args=(source_ids,), daemon=True)
            self._thread.start()
            return True

    def _run(self, source_ids):
        conn = db.connect()
        sql = "SELECT id, url FROM feed_sources WHERE enabled=1"
        if source_ids:
            sql += f" AND id IN ({','.join('?' * len(source_ids))})"
        sources = conn.execute(sql, source_ids or []).fetchall()
        self.message = f"Refreshing {len(sources)} sources…"
        ok = 0

        def work(src):
            try:
                return src, fetch(src["url"]), None
            except Exception as e:  # each source fails independently
                return src, [], f"{type(e).__name__}: {str(e)[:150]}"

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            for src, items, err in ex.map(work, sources):
                now = db.now()
                if "news.google.com" in src["url"]:
                    items = [_google_news_tidy(i) for i in items]
                with db.tx() as c:
                    for i in items:
                        c.execute(
                            "INSERT INTO feed_items(source_id, guid, title, link, summary, image, author, published, fetched_at) "
                            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, guid) DO UPDATE SET "
                            "title=excluded.title, summary=excluded.summary, image=COALESCE(excluded.image, image)",
                            (src["id"], i["guid"], i["title"], i["link"], i["summary"], i["image"], i["author"],
                             i["published"], now))
                    c.execute("UPDATE feed_sources SET last_fetched=?, last_error=?, item_count=? WHERE id=?",
                              (now, err, len(items) if not err else 0, src["id"]))
                ok += not err
        cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat(timespec="seconds")
        conn.execute("DELETE FROM feed_items WHERE published < ?", (cutoff,))
        self.last_run = db.now()
        self.message = f"Updated {ok} of {len(sources)} sources"
