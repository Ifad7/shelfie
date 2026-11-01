"""Background worker that sends pending images to Gemini, politely and resumably.

Free-tier friendly by design:
* identical files (same SHA-256) are analysed once; later copies come from the cache
* several images go in one request (configurable batch size)
* requests are paced to the configured requests-per-minute and stop at a daily cap
* 429 responses honour Gemini's retryDelay; daily-quota exhaustion pauses the run
"""
import json
import threading
import time

from . import catalog, db, gemini
from .imaging import prepare_for_api

MAX_ATTEMPTS = 3  # for genuine errors (e.g. malformed responses)
MAX_OVERLOADS = 7  # Gemini "high demand" / 5xx retries per batch before pausing (~6 min of back-off)
OVERLOADS_BEFORE_FALLBACK = 2  # after this many, try the fallback model


class Processor:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread = None
        self._unpaused = threading.Event()
        self._unpaused.set()
        self._cancel = threading.Event()
        self._last_request = 0.0
        self.state = "idle"  # idle | running | paused | waiting | stopping
        self.message = ""
        self.wait_until = None
        self.scope = {}
        self.run = self._new_run()
        self.alert = None  # {"kind", "title", "detail", "reset_at"} shown as a banner in the UI
        self.exhausted = {}  # model -> quota day on which Gemini said its daily limit was used up

    @staticmethod
    def _new_run():
        return {"processed": 0, "identified": 0, "uncertain": 0, "not_book": 0, "failed": 0,
                "cached": 0, "requests": 0, "started_at": None}

    @property
    def running(self):
        return bool(self._thread and self._thread.is_alive())

    def snapshot(self):
        return {"state": self.state, "message": self.message, "run": dict(self.run), "scope": self.scope,
                "alert": self.alert,
                "wait_seconds": max(0, round(self.wait_until - time.time())) if self.wait_until else 0}

    # ------------------------------------------------------------ controls

    def start(self, folder_id=None, image_ids=None):
        with self._lock:
            if self.running:
                if self.state == "paused":
                    self.resume()
                    return
                raise RuntimeError("Processing is already running")
            if not db.get_settings().get("api_key"):
                raise ValueError("Add your Gemini API key in Settings first")
            self._cancel.clear()
            self._unpaused.set()
            self.scope = {"folder_id": folder_id, "image_ids": list(image_ids or [])}
            self.run = self._new_run()
            self.run["started_at"] = db.now()
            self.alert = None
            self.state, self.message = "running", "Starting…"
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()

    def pause(self, message="Paused", alert=None):
        if self.running:
            self._unpaused.clear()
            self.state, self.message, self.alert = "paused", message, alert

    def _pause_alert(self, kind, title, detail, with_reset=False):
        alert = {"kind": kind, "title": title, "detail": detail,
                 "reset_at": db.quota_reset_at() if with_reset else None}
        self.pause(f"{title}. {detail}", alert)

    def resume(self):
        if self.running:
            self.state, self.message, self.alert = "running", "Resuming…", None
            self._unpaused.set()

    def cancel(self):
        if self.running:
            self.state, self.message = "stopping", "Stopping after the current request…"
            self._cancel.set()
            self._unpaused.set()

    def _wait(self, seconds, why):
        """Interruptible sleep. Returns False if cancelled."""
        if seconds <= 0:
            return not self._cancel.is_set()
        prev = self.state
        self.state, self.message, self.wait_until = "waiting", why, time.time() + seconds
        cancelled = self._cancel.wait(seconds)
        self.wait_until = None
        if not cancelled and self.state == "waiting":
            self.state = prev if prev != "waiting" else "running"
        return not cancelled

    # ------------------------------------------------------------ main loop

    def _pending(self, limit=200):
        sql = "SELECT id, path, sha256 FROM images WHERE status='pending' AND missing=0"
        params = []
        if self.scope.get("folder_id"):
            sql += " AND folder_id=?"
            params.append(self.scope["folder_id"])
        if self.scope.get("image_ids"):
            ids = self.scope["image_ids"]
            sql += f" AND id IN ({','.join('?' * len(ids))})"
            params.extend(ids)
        return db.connect().execute(sql + " ORDER BY id LIMIT ?", (*params, limit)).fetchall()

    def _loop(self):
        try:
            while not self._cancel.is_set():
                self._unpaused.wait()
                if self._cancel.is_set():
                    break
                if self.state == "paused":
                    self.state = "running"
                settings = db.get_settings()
                rows = self._pending()
                if not rows:
                    break

                batch, shas = [], set()
                for row in rows:
                    if self._from_cache(row, settings):
                        continue
                    if row["sha256"] in shas:
                        continue  # identical file already in this batch; it will hit the cache next round
                    shas.add(row["sha256"])
                    batch.append(row)
                    if len(batch) >= max(1, int(settings["batch_size"])):
                        break
                if batch:
                    self._process(batch, settings)
        except Exception as e:  # keep the server alive and tell the user
            self.message = f"Processing stopped by an unexpected error: {e}"
        finally:
            cancelled = self._cancel.is_set()
            r = self.run
            summary = (f"{r['processed']} processed — {r['identified']} identified, {r['uncertain']} uncertain, "
                       f"{r['failed']} failed, {r['not_book']} not a book; {r['cached']} from cache, "
                       f"{r['requests']} API requests")
            if not self.message.startswith("Processing stopped"):
                self.message = ("Cancelled. " if cancelled else "Finished. ") + summary
            if cancelled:
                self.alert = None
            self.state = "idle"
            self.wait_until = None
            db.connect().execute("UPDATE images SET status='pending' WHERE status='processing'")

    def _count(self, status):
        self.run["processed"] += 1
        self.run[status] = self.run.get(status, 0) + 1

    def _from_cache(self, row, settings):
        hit = db.connect().execute("SELECT result FROM analysis_cache WHERE sha256=?", (row["sha256"],)).fetchone()
        if not hit:
            return False
        with db.tx() as conn:
            status = catalog.apply_entry(conn, row["id"], json.loads(hit["result"]),
                                         float(settings["confidence_threshold"]))
        self.run["cached"] += 1
        self._count(status)
        return True

    def _set_status(self, ids, status, error=None, bump_attempts=False):
        conn = db.connect()
        for i in ids:
            conn.execute(
                "UPDATE images SET status=?, error=COALESCE(?, error), attempts=attempts+? WHERE id=?",
                (status, error, 1 if bump_attempts else 0, i))

    def _fail(self, row, error):
        self._set_status([row["id"]], "failed", error, bump_attempts=True)
        db.connect().execute("UPDATE images SET analyzed_at=? WHERE id=?", (db.now(), row["id"]))
        self._count("failed")

    def _respect_limits(self, settings):
        """Pace requests and enforce the daily cap. Returns False if the batch should not be sent now."""
        used = db.usage_today()["requests"]
        if used >= int(settings["daily_limit"]):
            self._pause_alert(
                "app_limit", f"Your daily request limit is used up ({used}/{settings['daily_limit']} requests)",
                "This is the safety limit set in Shelfie's Settings, not Google's. Your remaining images stay queued. "
                "Raise the limit in Settings and click Resume, or resume after the reset.", with_reset=True)
            return False
        gap = 60.0 / max(1, float(settings["rpm"]))
        wait = self._last_request + gap - time.time()
        if wait > 0:
            return self._wait(wait, f"Pacing requests ({settings['rpm']}/min)…")
        return True

    def _process(self, batch, settings):
        prepared = []
        for row in batch:
            try:
                prepared.append((row, prepare_for_api(row["path"], settings["max_image_px"],
                                                      settings["jpeg_quality"])))
            except Exception as e:
                self._fail(row, f"Could not read image: {e}")
        if not prepared:
            return
        rows = [r for r, _ in prepared]
        ids = [r["id"] for r in rows]
        self._set_status(ids, "processing")

        attempt = overloads = 0
        while True:
            if self._cancel.is_set() or not self._respect_limits(settings) or not self._unpaused.is_set():
                self._set_status(ids, "pending")
                return
            # Main model first, then the fallback; skip any whose daily quota Gemini says is used up today.
            fallback = (settings.get("fallback_model") or "").strip()
            candidates = [settings["model"]] + ([fallback] if fallback and fallback != settings["model"] else [])
            available = [m for m in candidates if self.exhausted.get(m) != db.today()]
            if not available:
                self._set_status(ids, "pending")
                self._pause_alert(
                    "gemini_limit", "Gemini's free daily limit has been reached",
                    f"Google won't accept more requests today for {' or '.join(candidates)}. "
                    "Your remaining images stay queued. Click Resume after the reset, "
                    "or pick another model in Settings.", with_reset=True)
                return
            model = available[1] if overloads >= OVERLOADS_BEFORE_FALLBACK and len(available) > 1 else available[0]
            self.state = "running"
            self.message = f"Analysing {len(rows)} image(s) with {model}…"
            self._last_request = time.time()
            try:
                result, usage = gemini.analyze_images(settings["api_key"], model, [p for _, p in prepared])
            except gemini.RateLimited as e:
                db.record_usage(rate_limited=1)
                if not self._wait(e.retry_after + 1, f"Gemini's per-minute limit reached. Waiting "
                                                     f"{round(e.retry_after)}s, then continuing automatically"):
                    self._set_status(ids, "pending")
                    return
                continue
            except gemini.ModelRetired as e:
                if e.replacement and e.replacement != settings["model"]:
                    old = settings["model"]
                    db.save_settings({"model": e.replacement})
                    settings["model"] = e.replacement
                    self.message = f"{old} is retired; switched to {e.replacement} as Google recommends"
                    continue
                self._set_status(ids, "pending")
                self._pause_alert("config", "The selected model isn't available", f"Choose another model in Settings. ({e})")
                return
            except gemini.QuotaExhausted:
                self.exhausted[model] = db.today()
                self.message = f"{model} has reached its daily limit. Trying the next model…"
                continue  # the next pass picks the fallback, or pauses with the limit banner
            except gemini.ConfigError as e:
                self._set_status(ids, "pending")
                self._pause_alert("config", "Gemini rejected the request", f"Check your API key and model in Settings. ({e})")
                return
            except gemini.BadRequest as e:
                db.record_usage(requests=1)
                self.run["requests"] += 1
                if len(prepared) > 1:  # find the culprit by sending them one at a time
                    self._set_status(ids, "pending")
                    for row, _ in prepared:
                        self._process([row], settings)
                    return
                self._fail(rows[0], f"Gemini rejected the image: {e}")
                return
            except gemini.GeminiError as e:
                if e.overloaded:
                    # Google is busy: not the images' fault, so never mark them failed and don't count
                    # the attempt against the daily budget. Back off, then try the lighter fallback model.
                    overloads += 1
                    if overloads >= MAX_OVERLOADS:
                        self._set_status(ids, "pending")
                        self._pause_alert("overloaded", "Gemini is overloaded right now",
                                          "This is a temporary problem on Google's side. Your images are still "
                                          "queued. Click Resume in a few minutes.")
                        return
                    delay = min(120, 10 * 2 ** (overloads - 1))
                    nxt = available[1] if overloads >= OVERLOADS_BEFORE_FALLBACK and len(available) > 1 else available[0]
                    if not self._wait(delay, f"Gemini is busy (Google's side) — retrying with {nxt} "
                                             f"({overloads}/{MAX_OVERLOADS - 1})…"):
                        self._set_status(ids, "pending")
                        return
                    continue
                db.record_usage(requests=1)
                self.run["requests"] += 1
                attempt += 1
                if not e.retryable or attempt >= MAX_ATTEMPTS:
                    for row in rows:
                        self._fail(row, str(e))
                    return
                if not self._wait(5 * 2 ** attempt, f"{e} — retrying ({attempt}/{MAX_ATTEMPTS - 1})…"):
                    self._set_status(ids, "pending")
                    return
                continue

            db.record_usage(requests=1, images=len(rows), **usage)
            self.run["requests"] += 1
            self._apply(rows, result, settings, model)
            return

    def _apply(self, rows, result, settings, model):
        entries = [e for e in result.get("images", []) if isinstance(e, dict)]
        by_index = {e.get("image_index"): e for e in entries}
        if len(rows) == 1 and len(entries) == 1:
            by_index = {0: entries[0]}
        threshold = float(settings["confidence_threshold"])
        for idx, row in enumerate(rows):
            entry = by_index.get(idx)
            if entry is None:
                self._fail(row, "Gemini returned no result for this image — retry it")
                continue
            entry = {k: v for k, v in entry.items() if k != "image_index"}
            with db.tx() as conn:
                conn.execute(
                    "INSERT INTO analysis_cache(sha256, model, result, created_at) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(sha256) DO UPDATE SET model=excluded.model, result=excluded.result, "
                    "created_at=excluded.created_at",
                    (row["sha256"], model, json.dumps(entry, ensure_ascii=False), db.now()))
                status = catalog.apply_entry(conn, row["id"], entry, threshold)
                conn.execute("UPDATE images SET attempts=attempts+1 WHERE id=?", (row["id"],))
            self._count(status)
