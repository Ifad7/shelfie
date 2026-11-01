"""Background folder scanning: discover images, hash them and register them for processing."""
import os
import threading
from pathlib import Path

from . import catalog, db
from .imaging import IMAGE_EXTS, sha256_file


class Scanner:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread = None
        self.state = {"running": False, "folder": None, "found": 0, "done": 0,
                      "new": 0, "changed": 0, "missing": 0, "message": ""}

    @property
    def running(self):
        return bool(self._thread and self._thread.is_alive())

    def start(self, folder_id):
        with self._lock:
            if self.running:
                raise RuntimeError("A scan is already running")
            row = db.connect().execute("SELECT * FROM folders WHERE id=?", (folder_id,)).fetchone()
            if not row:
                raise LookupError("Folder not found")
            self.state = {"running": True, "folder": row["path"], "found": 0, "done": 0,
                          "new": 0, "changed": 0, "missing": 0, "message": "Listing files…"}
            self._thread = threading.Thread(target=self._run, args=(dict(row),), daemon=True)
            self._thread.start()

    def _run(self, folder):
        try:
            self._scan(folder)
        except Exception as e:  # surfaced to the UI
            self.state["message"] = f"Scan failed: {e}"
        finally:
            self.state["running"] = False

    def _scan(self, folder):
        root = Path(folder["path"])
        if not root.is_dir():
            raise FileNotFoundError(f"{root} is not a folder")

        files = []
        if folder["recursive"]:
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                files.extend(Path(dirpath) / f for f in filenames)
        else:
            files = [p for p in root.iterdir() if p.is_file()]
        files = sorted(p for p in files if p.suffix.lower() in IMAGE_EXTS and not p.name.startswith("."))
        self.state.update(found=len(files), message="Hashing images…")

        conn = db.connect()
        existing = {r["path"]: r for r in conn.execute(
            "SELECT id, path, size, mtime, sha256 FROM images WHERE folder_id=?", (folder["id"],))}
        seen = set()

        for p in files:
            key = str(p)
            seen.add(key)
            try:
                st = p.stat()
                old = existing.get(key)
                if old and old["size"] == st.st_size and old["mtime"] == st.st_mtime:
                    conn.execute("UPDATE images SET missing=0 WHERE id=?", (old["id"],))
                else:
                    sha = sha256_file(p)
                    if old is None:
                        conn.execute(
                            "INSERT INTO images(folder_id, path, filename, size, mtime, sha256, status, created_at) "
                            "VALUES(?, ?, ?, ?, ?, ?, 'pending', ?) "
                            "ON CONFLICT(path) DO UPDATE SET folder_id=excluded.folder_id, missing=0",
                            (folder["id"], key, p.name, st.st_size, st.st_mtime, sha, db.now()),
                        )
                        self.state["new"] += 1
                    elif sha != old["sha256"]:
                        # File content changed: re-queue it.
                        with db.tx() as c:
                            c.execute("UPDATE images SET size=?, mtime=?, sha256=?, status='pending', error=NULL, "
                                      "confidence=NULL, missing=0 WHERE id=?",
                                      (st.st_size, st.st_mtime, sha, old["id"]))
                            catalog.unlink_image_books(c, old["id"])
                        self.state["changed"] += 1
                    else:
                        conn.execute("UPDATE images SET size=?, mtime=?, missing=0 WHERE id=?",
                                     (st.st_size, st.st_mtime, old["id"]))
            except OSError as e:
                self.state["message"] = f"Skipped {p.name}: {e}"
            self.state["done"] += 1

        gone = [r["id"] for path, r in existing.items() if path not in seen]
        for image_id in gone:
            conn.execute("UPDATE images SET missing=1 WHERE id=?", (image_id,))
        self.state["missing"] = len(gone)
        conn.execute("UPDATE folders SET last_scan=? WHERE id=?", (db.now(), folder["id"]))
        s = self.state
        s["message"] = (f"Scan complete: {s['found']} images, {s['new']} new, {s['changed']} changed"
                        + (f", {s['missing']} missing" if s["missing"] else ""))
