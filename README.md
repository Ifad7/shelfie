# 📚 Shelfie: your personal library

**Turn photos of your books into a beautiful, organised digital library.** Shelfie reads book covers, spines and
shelves with Google's free Gemini AI, fills in each book's details, and lets you arrange them on named bookshelves,
track your reading, and follow book news from around the world (Western, Indian, Bangladeshi and Asian).

![Shelfie](docs/images/01-library.jpg)

## Before you start: prerequisites

| What | Needed? | Why |
|---|---|---|
| **Python 3.10 or newer** | ✅ Required | The free program Shelfie runs on |
| **A web browser** (Chrome, Edge, Firefox, Safari) | ✅ Required | Shelfie's screens open in your browser |
| **Internet connection** | ✅ Required | Identifying books, Book Feed, and the one-time setup |
| **A Google account** | ✅ Required | To get your free Gemini key |
| **Git** | ⬜ Optional | Only to download with `git clone` and get updates with `git pull`. Otherwise use **Code → Download ZIP** on GitHub. |
| About **200 MB** of free disk space | ✅ Required | Setup files, plus small preview images of your photos |

### Check whether you already have Python

- **Windows:** press the Windows key, type `cmd`, press Enter, then type `py --version` and press Enter.
- **Mac / Linux:** open the **Terminal** app, type `python3 --version` and press Enter.

If you see `Python 3.10` or a higher number (3.11, 3.12, 3.13…), you're ready. If you see an error, or a lower
number, install it as below.

### Install Python

**Windows: choose any one way**
- **Easiest:** just double-click **`Shelfie-Windows.bat`**. If Python is missing, it offers to install it for you.
  Press **Y**.
- **Command:** open `cmd` and run `winget install Python.Python.3.13`
- **By hand:** download from https://www.python.org/downloads/, run the installer, and ⚠️ **tick "Add python.exe
  to PATH"** on the first screen before clicking **Install Now**.

**Mac: choose one way**
- **By hand:** download the macOS installer from https://www.python.org/downloads/ and open it.
- **Homebrew** (if you use it): `brew install python`

**Linux**
- Ubuntu / Debian / Mint: `sudo apt install python3 python3-venv python3-tk`
- Fedora: `sudo dnf install python3 python3-tkinter`
- Arch: `sudo pacman -S python tk`

(`python3-tk` / `tk` is only needed for the **Browse…** folder button. Without it you can paste a folder's path instead.)

### Install Git (optional)

- **Windows:** `winget install Git.Git`, or download from https://git-scm.com/download/win
- **Mac:** run `xcode-select --install` in Terminal, or `brew install git`
- **Linux:** `sudo apt install git` (Ubuntu/Debian) or `sudo dnf install git` (Fedora)

Then: `git clone <this repository's URL>`. No Git? On GitHub click **Code → Download ZIP** and unzip it.

## Get started in 3 steps

1. **Have Python ready** (see [prerequisites](#before-you-start-prerequisites)). On Windows you can skip this, because
   the launcher offers to install Python for you.
2. **Start Shelfie:**
   - **Windows:** double-click **`Shelfie-Windows.bat`**
   - **Mac / Linux:** open Terminal, type `bash ` (with a space), drag **`Shelfie-Mac-Linux.sh`** into the window, press Enter

   The first start takes a minute or two while it sets itself up. Then your browser opens on Shelfie.
3. **Add your free Gemini key:** get one at https://aistudio.google.com/apikey and paste it into Shelfie's
   **Settings** page.

Then go to **Scan & Identify**, pick a folder of book photos, and click **Start identifying**.

👉 **New to Shelfie? Read the [User Guide](USER_GUIDE.md).** It covers every feature step by step, in plain language.

## What it can do

- 📷 **Identify books from photos:** covers, spines, title pages, even whole shelves, many photos at once.
- 🔍 **Never makes things up:** unknown details stay blank, and uncertain ones are highlighted for you to check.
- ✨ **New Finds:** review what was found, then add books to your library one by one or all at once.
- 🗂️ **Named bookshelves:** create shelves, drag and drop books between them, and open a **full-screen bookcase**.
- ⭐ **Track your reading:** status, ratings, favourites, tags, notes, and covers from your own photos.
- 📰 **Book Feed:** news and reviews from The Guardian, NYT, The Hindu, The Daily Star, বই ও সাহিত্য news and more.
- 🌗 **Day and night themes**, works on phones too, and exports to CSV (Excel) or JSON.
- 💸 **Designed for Gemini's free tier:** photos are never sent twice, requests are batched and paced, and clear
  messages tell you when a daily limit is reached and when it resets.

Your library stays on your own computer, in the `data` folder. It is not part of the git repository, so your
books and API key are never uploaded.

---

## For developers

<details>
<summary>Technical details</summary>

### Running manually

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows (macOS/Linux: .venv/bin/pip)
.venv/Scripts/python app.py                         # opens http://127.0.0.1:5173
```

The launchers do exactly this, plus: Python detection, repairing a broken `.venv`, reinstalling packages only when
`requirements.txt` changes, and recognising an already-running instance (`app.py` exits with code 3).

Environment variables: `GEMINI_API_KEY` (instead of saving the key in the app), `PORT` (default 5173; the next free
port is used if it's taken), `HOST`, `LIBRARY_DATA_DIR` (default `./data`), `NO_BROWSER=1`.

Requirements: Python 3.10+, Flask, Pillow, tzdata. Optional: `pillow-heif` for HEIC photos.

### Free-tier design

| Technique | Effect |
| --- | --- |
| SHA-256 cache | A file with identical content is never sent twice (copies, re-scans, restarts). |
| Batching | 1–8 images per request (default 3). |
| Downscaling | Images are resized (default 1600 px) and re-encoded as JPEG before upload. |
| Pacing and daily cap | Requests are spaced to the RPM setting; processing pauses at the daily cap. |
| 429 handling | Honours `retryDelay`; per-day exhaustion switches to the fallback model, then pauses with a banner showing the reset time (midnight Pacific). |
| 503 / overload | Backoff, then the fallback model; images stay queued and are never marked failed. Overload errors don't count toward the daily budget. |
| Retired models | A 404 naming a replacement model switches to it automatically. Default model is the `gemini-flash-latest` alias. |

### Accuracy and de-duplication

- Structured JSON output (enforced response schema), validated and cleaned. ISBN, publisher, year, edition and page
  count must be read from the image; ISBNs are checksum-validated.
- Confidence scores plus `uncertain_fields`; anything below the threshold goes to Review.
- Books match by ISBN-13 (ISBN-10 converted), otherwise by normalised title plus author surname. Different ISBNs stay
  separate editions. Manual matching and merging are available in the UI.

### Project layout

```
app.py                   Flask server + REST API
library/db.py            SQLite schema and migrations, settings, usage tracking, shelf ordering
library/gemini.py        Gemini REST client, prompt, response schema, error classification
library/processor.py     Background worker: cache, batching, pacing, fallback model, pause/resume/cancel
library/catalog.py       Cleaning AI output, ISBN validation, de-duplication, linking, merging
library/scanner.py       Folder scanning and hashing (incremental re-scans)
library/imaging.py       Downscaling for upload, thumbnails, optional HEIC support
library/feeds.py         Book Feed: RSS/Atom fetching and parsing, built-in sources
static/                  Single-page UI (vanilla JS, no build step)
Shelfie-Windows.bat      One-click launcher (Windows)
Shelfie-Mac-Linux.sh     Launcher (macOS/Linux)
USER_GUIDE.md            End-user manual (screenshots in docs/images)
data/                    Created at runtime: library.db + thumbnails (git-ignored)
```

</details>
