"""eBook files attached to books: which formats are supported, and checking what a file really is."""
import zipfile
from pathlib import Path

# ext: (label shown to people, mimetype served, can Shelfie open it in the browser?)
FORMATS = {
    "pdf": ("PDF", "application/pdf", True),
    "epub": ("EPUB", "application/epub+zip", True),
    "txt": ("Text", "text/plain; charset=utf-8", True),
    "mobi": ("MOBI", "application/x-mobipocket-ebook", False),
    "azw": ("Kindle AZW", "application/vnd.amazon.ebook", False),
    "azw3": ("Kindle AZW3", "application/vnd.amazon.ebook", False),
    "fb2": ("FB2", "application/x-fictionbook+xml", False),
    "djvu": ("DjVu", "image/vnd.djvu", False),
    "cbz": ("Comic CBZ", "application/vnd.comicbook+zip", False),
    "cbr": ("Comic CBR", "application/vnd.comicbook-rar", False),
    "rtf": ("RTF", "application/rtf", False),
    "docx": ("Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", False),
    "odt": ("ODT", "application/vnd.oasis.opendocument.text", False),
}
READABLE = {ext for ext, (_, _, ok) in FORMATS.items() if ok}
KINDLE = {"mobi", "azw", "azw3"}
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")


def label(ext):
    return FORMATS.get(ext, (ext.upper(), "", False))[0]


def mimetype(ext):
    return FORMATS.get(ext, ("", "application/octet-stream", False))[1]


def _zip_kind(path):
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            first = z.read("mimetype").decode("ascii", "ignore").strip() if "mimetype" in names else ""
    except (zipfile.BadZipFile, OSError, KeyError):
        return None
    if first == "application/epub+zip" or "META-INF/container.xml" in names:
        return "epub"
    if first.startswith("application/vnd.oasis.opendocument"):
        return "odt"
    if "word/document.xml" in names:
        return "docx"
    if names and all(n.endswith("/") or n.lower().endswith(IMAGE_EXTS) or n.lower().endswith((".xml", ".txt")) for n in names):
        return "cbz"
    return "zip"


def detect(path, declared_ext):
    """Work out the real format of an uploaded file from its contents.

    Returns the extension to store it under, or raises ValueError with a friendly message.
    """
    declared = (declared_ext or "").lower().lstrip(".")
    with open(path, "rb") as f:
        head = f.read(4096)
    if not head:
        raise ValueError("That file is empty.")
    found = None
    if b"%PDF-" in head[:1024]:
        found = "pdf"
    elif head.startswith(b"PK\x03\x04"):
        kind = _zip_kind(path)
        found = kind if kind != "zip" else None
    elif head.startswith(b"Rar!"):
        found = "cbr"
    elif head[60:68] in (b"BOOKMOBI", b"TEXtREAd"):
        found = declared if declared in KINDLE else "mobi"
    elif head.startswith(b"AT&TFORM"):
        found = "djvu"
    elif head.lstrip(b"\xef\xbb\xbf").startswith(b"{\\rtf"):
        found = "rtf"
    elif b"FictionBook" in head:
        found = "fb2"
    elif declared == "txt" and b"\x00" not in head:
        try:
            head.decode("utf-8")
        except UnicodeDecodeError:
            try:
                head.decode("utf-16")
            except UnicodeDecodeError:
                raise ValueError("That text file couldn't be read. Save it as UTF-8 and try again.") from None
        found = "txt"
    if not found:
        names = ", ".join(label(e) for e in FORMATS)
        raise ValueError(f"That doesn't look like an eBook file. Shelfie accepts: {names}.")
    return found


def accept_attr():
    """Value for <input type=file accept=...>."""
    return ",".join(f".{e}" for e in FORMATS) + ",application/pdf,application/epub+zip"


def safe_name(filename):
    return Path(filename or "book").name[:200]
