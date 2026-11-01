"""Image helpers: hashing, API-ready downscaling and cached thumbnails."""
import hashlib
import io

from PIL import Image, ImageOps

from . import db

try:  # Optional HEIC/HEIF support (iPhone photos): pip install pillow-heif
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIF = True
except ImportError:
    HEIF = False

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
if HEIF:
    IMAGE_EXTS |= {".heic", ".heif"}

Image.MAX_IMAGE_PIXELS = 200_000_000


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_rgb(path, max_px):
    im = Image.open(path)
    im.draft("RGB", (max_px, max_px))  # fast JPEG downscale on decode
    im = ImageOps.exif_transpose(im)
    im.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.getchannel("A"))
        return bg
    return im.convert("RGB")


def prepare_for_api(path, max_px=1600, quality=85):
    """Downscale and re-encode as JPEG to keep uploads (and token usage) small."""
    im = _load_rgb(path, int(max_px))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=int(quality), optimize=True)
    return buf.getvalue(), "image/jpeg"


def thumbnail_path(path, key, size=360):
    out = db.THUMB_DIR / f"{key}_{size}.jpg"
    if not out.exists():
        im = _load_rgb(path, size)
        tmp = out.with_suffix(".tmp")
        im.save(tmp, "JPEG", quality=80)
        tmp.replace(out)
    return out
