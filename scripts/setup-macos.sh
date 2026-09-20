#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Creating Python virtual environment..."
python3 -m venv .venv

echo "Installing Python dependencies..."
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r vision/requirements.txt

echo "Installing Electron dependencies..."
npm install

echo
echo "Setup complete."
echo "Run: npm start"
