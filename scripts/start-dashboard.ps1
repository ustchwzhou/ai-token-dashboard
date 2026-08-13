# Token Studio launcher (PowerShell)
#
# Double-click "Token Studio" on the desktop to:
#   1. If port 4173 is already listening, just open the URL and exit.
#   2. Otherwise, start `npm run serve` in a separate cmd window titled
#      "Token Studio Server" (close it to stop the server), poll the port
#      for up to 15 s, then open the URL with the default browser.
#
# The launcher itself shows no window.

$ErrorActionPreference = 'Stop'
$root = 'D:\WORK\000-AI\ai-token-dashboard'
$port = 4173
$url  = "http://localhost:$port"
$icon = Join-Path $root 'assets\token-studio.ico'

Set-Location -LiteralPath $root
if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) {
  [Console]::Error.WriteLine("package.json not found at $root. Please update ROOT path.")
  Read-Host 'Press Enter to exit' | Out-Null
  exit 1
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($listener) {
  Start-Process $url
  exit 0
}

# `cmd /k` keeps the server window alive after this launcher exits.
$serverCmd = 'title Token Studio Server && npm run serve'
Start-Process -FilePath cmd.exe -ArgumentList '/k', $serverCmd `
  -WorkingDirectory $root `
  -WindowStyle Normal

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    Start-Process $url
    exit 0
  }
  Start-Sleep -Seconds 1
}

[Console]::Error.WriteLine("Server start timeout: port $port did not open within 15s. Check the 'Token Studio Server' window.")
Read-Host 'Press Enter to exit' | Out-Null
exit 1