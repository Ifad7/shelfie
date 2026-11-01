#!/usr/bin/env bash
# Shelfie launcher for macOS and Linux.
# Open Terminal, type "bash " (with a space), drag this file (Shelfie-Mac-Linux.sh) into the window and press Enter.
cd "$(dirname "$0")" || exit 1

echo
echo "  =================================================="
echo "     Shelfie - your personal library"
echo "  =================================================="
echo

# 1. Find Python 3.10 or newer
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PY="$candidate"; break
  fi
done
if [ -z "$PY" ]; then
  echo "  Shelfie needs Python 3.10 or newer, and it was not found."
  echo "  Download it from https://www.python.org/downloads/ , install it, then run this again."
  exit 1
fi

# 2. First-time setup, or repair a broken setup
if [ -d .venv ] && ! .venv/bin/python -c 'import sys' >/dev/null 2>&1; then rm -rf .venv; fi
if [ ! -x .venv/bin/python ]; then
  echo "  First-time setup. This takes a minute or two, and only happens once..."
  if ! "$PY" -m venv .venv; then
    echo "  Could not set up. On Ubuntu/Debian, first run:  sudo apt install python3-venv"
    exit 1
  fi
fi

# 3. Install or update what Shelfie needs, only when it changed
if ! cmp -s requirements.txt .venv/installed-requirements.txt; then
  echo "  Downloading the parts Shelfie needs. You must be connected to the internet..."
  .venv/bin/python -m pip install --disable-pip-version-check -q --upgrade pip &&
  .venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt || {
    echo "  Setup failed. Check your internet connection and try again."; exit 1; }
  cp requirements.txt .venv/installed-requirements.txt
fi

# 4. Start
echo "  Starting Shelfie. Your web browser will open in a moment."
echo "  Keep this window open while you use Shelfie. Press Ctrl+C here to stop."
exec .venv/bin/python app.py
