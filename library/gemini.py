"""Minimal Gemini REST client with structured JSON output and error classification."""
import base64
import json
import re
import urllib.error
import urllib.request

API_BASE = "https://generativelanguage.googleapis.com/v1beta"


class GeminiError(Exception):
    """Generic failure. `retryable` means trying the same request again later may work."""

    def __init__(self, message, retryable=False, overloaded=False):
        super().__init__(message)
        self.retryable = retryable
        # Google's side is busy or unreachable (5xx / network): nothing wrong with the request itself.
        self.overloaded = overloaded


class RateLimited(GeminiError):
    """Per-minute limit hit; wait `retry_after` seconds and retry."""

    def __init__(self, message, retry_after):
        super().__init__(message, retryable=True)
        self.retry_after = retry_after


class QuotaExhausted(GeminiError):
    """Daily quota used up; processing should pause until it resets."""


class ConfigError(GeminiError):
    """Bad API key, unknown model or similar: no point retrying until settings change."""


class ModelRetired(ConfigError):
    """The model was retired. Google's error usually names a replacement model."""

    def __init__(self, message, replacement=None):
        super().__init__(message)
        self.replacement = replacement


class BadRequest(GeminiError):
    """The request itself was rejected (e.g. an image Gemini cannot read)."""


def _string(nullable=True, **extra):
    return {"type": "STRING", "nullable": nullable, **extra}


def _string_list():
    return {"type": "ARRAY", "items": {"type": "STRING"}}


BOOK_PROPERTIES = {
    "title": _string(),
    "subtitle": _string(),
    "authors": _string_list(),
    "publisher": _string(),
    "publication_year": _string(),
    "isbn": _string(),
    "edition": _string(),
    "language": _string(),
    "genre": _string(),
    "categories": _string_list(),
    "description": _string(),
    "topics": _string_list(),
    "target_audience": _string(),
    "keywords": _string_list(),
    "page_count": {"type": "INTEGER", "nullable": True},
    "series": _string(),
    "series_volume": _string(),
    "confidence": {"type": "NUMBER"},
    "uncertain_fields": _string_list(),
    "visible_text": _string(),
    "notes": _string(),
}

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "images": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "image_index": {"type": "INTEGER"},
                    "contains_book": {"type": "BOOLEAN"},
                    "image_quality": {"type": "STRING", "enum": ["good", "fair", "poor"]},
                    "issue": _string(),
                    "books": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": BOOK_PROPERTIES,
                            "required": ["title", "authors", "confidence", "uncertain_fields"],
                            "propertyOrdering": list(BOOK_PROPERTIES),
                        },
                    },
                },
                "required": ["image_index", "contains_book", "image_quality", "books"],
                "propertyOrdering": ["image_index", "contains_book", "image_quality", "issue", "books"],
            },
        }
    },
    "required": ["images"],
}

SYSTEM_PROMPT = """You are a meticulous librarian cataloguing a personal book collection from photographs \
(covers, spines, title pages, copyright pages or shelves).

Accuracy rules - these override everything else:
1. Never invent information. Use null (or an empty list) for anything you cannot determine.
2. isbn, publisher, publication_year, edition and page_count: report ONLY if printed and legible in the image. \
Never recall an ISBN from memory. Copy ISBN digits exactly as printed.
3. title, subtitle, authors, series and series_volume: report what is printed. You may complete an author's \
name only if the work is unambiguous and well known.
4. genre, categories, description, topics, target_audience, keywords, language: you may use general knowledge \
of the work ONLY when you are confident you identified the exact work. Otherwise leave them null/empty.
5. List in uncertain_fields every field name you inferred rather than read, or are not sure about.
6. confidence (0.0-1.0) is how sure you are that title + author identify the right book. Use 0.9+ only when \
both are clearly legible; lower it for blur, glare, partial views, unusual angles or ambiguity.
7. One image may show several books (e.g. a row of spines): return one entry per distinct book. If a book is \
visible but its title cannot be read, include it with title null and a low confidence.
8. If the image does not show a book, set contains_book false and books to [] and explain briefly in issue.
9. language: the book's language as an English name (e.g. "English", "Bengali"). publication_year: 4 digits. \
description: factual, at most 60 words. keywords: at most 10. visible_text: the main text you actually read.
10. Use issue for problems with the image (blurry, cropped, glare); use notes for anything else worth knowing."""


def _parse_duration(value):
    if not value:
        return None
    m = re.match(r"^\s*([\d.]+)s\s*$", str(value))
    return float(m.group(1)) if m else None


def _classify(code, raw):
    try:
        err = json.loads(raw).get("error", {})
    except (ValueError, AttributeError):
        err = {}
    msg = err.get("message") or (raw[:300] if raw else f"HTTP {code}")
    details = err.get("details") or []

    if code == 429:
        if re.search(r"\blimit:\s*0\b", msg):
            return ConfigError(f"This model has no free-tier quota on your project - choose another model "
                               f"in Settings (Pro models are paid-only). ({msg})")
        retry_after = None
        per_day = False
        for d in details:
            kind = d.get("@type", "")
            if kind.endswith("RetryInfo"):
                retry_after = _parse_duration(d.get("retryDelay"))
            elif kind.endswith("QuotaFailure"):
                for v in d.get("violations", []):
                    quota = f"{v.get('quotaId', '')} {v.get('quotaMetric', '')}".lower()
                    if "perday" in quota or "per_day" in quota:
                        per_day = True
        if per_day or re.search(r"per[ _-]?day", msg, re.I):
            return QuotaExhausted(f"Daily Gemini quota exhausted: {msg}")
        return RateLimited(msg, retry_after or 30.0)
    if code in (401, 403):
        return ConfigError(f"Gemini rejected the API key ({code}): {msg}")
    if code == 404:
        m = re.search(r"use (?:models/)?(gemini[\w.\-]+)", msg)
        return ModelRetired(f"Model not available - choose another model in Settings. ({msg})",
                            m.group(1).rstrip(".") if m else None)
    if code == 400:
        if "api key" in msg.lower() or "api_key" in msg.lower():
            return ConfigError(f"Invalid API key: {msg}")
        return BadRequest(msg)
    if code >= 500:
        return GeminiError(f"Gemini server error {code}: {msg}", retryable=True, overloaded=True)
    return GeminiError(f"HTTP {code}: {msg}")


def _request(method, url, api_key, body=None, timeout=180):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise _classify(e.code, e.read().decode("utf-8", "replace")) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        raise GeminiError(f"Network error: {e}", retryable=True, overloaded=True) from None


# Models in the list that cannot read a photo and answer in text (speech, image generation, etc.).
NOT_FOR_VISION = ("tts", "image", "banana", "transcribe", "robotics", "computer-use", "customtools")


def list_models(api_key):
    """Models that can read images and answer in text. Costs no generation quota.

    Note: Google's list can still include models that are retired for new users.
    """
    data = _request("GET", f"{API_BASE}/models?pageSize=1000", api_key, timeout=30)
    out = []
    for m in data.get("models", []):
        name = m.get("name", "").removeprefix("models/")
        if ("generateContent" in m.get("supportedGenerationMethods", []) and name.startswith("gemini")
                and not any(x in name for x in NOT_FOR_VISION)):
            out.append({"name": name, "display_name": m.get("displayName", name)})
    return sorted(out, key=lambda m: m["name"])


def _extract_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    return json.loads(text)


def analyze_images(api_key, model, images):
    """Identify books in a batch of images.

    images: list of (jpeg_bytes, mime_type). Returns (parsed_json, usage_dict).
    """
    parts = [{"text": f"Catalogue the {len(images)} attached image(s). They are numbered from 0 "
                      f"(image_index). Return exactly one entry in `images` per image."}]
    for i, (data, mime) in enumerate(images):
        parts.append({"text": f"Image {i}:"})
        parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode("ascii")}})

    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
        },
    }
    data = _request("POST", f"{API_BASE}/models/{model}:generateContent", api_key, body)

    meta = data.get("usageMetadata", {})
    usage = {
        "input_tokens": meta.get("promptTokenCount", 0) or 0,
        "output_tokens": (meta.get("candidatesTokenCount", 0) or 0) + (meta.get("thoughtsTokenCount", 0) or 0),
    }

    candidates = data.get("candidates") or []
    if not candidates:
        reason = (data.get("promptFeedback") or {}).get("blockReason", "no response")
        raise BadRequest(f"Gemini returned no answer ({reason})")
    cand = candidates[0]
    text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", []) if not p.get("thought"))
    if not text:
        raise GeminiError(f"Empty response (finishReason={cand.get('finishReason')})", retryable=True)
    try:
        parsed = _extract_json(text)
    except ValueError:
        raise GeminiError("Gemini returned malformed JSON", retryable=True) from None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("images"), list):
        raise GeminiError("Gemini response did not match the expected structure", retryable=True)
    return parsed, usage
