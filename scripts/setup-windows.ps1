$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "Creating Python virtual environment..."
py -m venv .venv

Write-Host "Installing Python dependencies..."
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r .\vision\requirements.txt

Write-Host "Installing Electron dependencies..."
npm install

Write-Host ""
Write-Host "Setup complete."
Write-Host "Run: npm start"
